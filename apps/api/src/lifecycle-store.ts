import {
  type PortalAskQuota,
  type PortalAskUsage,
  type PortalLifecycle,
  PortalLifecycleSchema,
} from '@research-portal/core'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownedMutation, type OwnedMutationBoundary } from './stores.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'

/** Synchronous persistence keeps quota and capacity admission atomic in each server runtime. */
export interface LifecycleState {
  get<T>(key: string, fallback: T): T
  put(key: string, value: unknown): void
  delete(key: string): void
  /** Whether a record is stored under the key, whether or not it can be read. */
  has(key: string): boolean
}

/** An unconfigured embedded application has isolated state for its own lifetime. */
function transientLifecycleState(): LifecycleState {
  const records = new Map<string, unknown>()
  return {
    get<T>(key: string, fallback: T): T {
      return structuredClone(records.has(key) ? records.get(key) : fallback) as T
    },
    put(key: string, value: unknown): void {
      records.set(key, structuredClone(value))
    },
    delete(key: string): void {
      records.delete(key)
    },
    has(key: string): boolean {
      return records.has(key)
    },
  }
}

const MINUTE = 60_000
const DAY = 86_400_000
/** Every current UTC offset is a whole number of quarter hours, so buckets never straddle a day. */
const BUCKET = 15 * MINUTE
/** Activity is recorded at this resolution so ordinary reads do not write on every request. */
const ACTIVITY_RESOLUTION = MINUTE
/**
 * The knowledge box counts resources some time after a write. Adds and deletions it may not have
 * counted yet stay on the ledger this long, which bounds how stale a reservation can be.
 */
const RESERVATION_TTL = 6 * 60 * MINUTE
/** Writes in flight at once for one portal; beyond this an add is refused as unavailable. */
const MAX_IN_FLIGHT = 1_000
/** Beyond this many sized resources the ledger stops sizing and reports bytes as unknown. */
const MAX_SIZED = 50_000

/** Every portal the route guard can address; the same rule keys its other stored records. */
const SlugSchema = KeyPortalSlugSchema
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const TokenSchema = z.string().regex(/^[a-f0-9]{32}$/)

const StoredLifecycleSchema = z.object({
  v: z.literal(1),
  lifecycle: PortalLifecycleSchema,
  lastActivityAt: z.string().datetime().nullable(),
}).strict()
type StoredLifecycle = z.infer<typeof StoredLifecycleSchema>

/**
 * When the portal's current suspension began. Kept beside the lifecycle record rather than in it,
 * so code from before this record reads the lifecycle unchanged. `updatedAt` names the lifecycle
 * write it describes: once another write replaces the lifecycle without updating this record, as
 * a rolled-back release would, the record no longer applies.
 */
const StoredSuspensionSchema = z.object({
  v: z.literal(1),
  since: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
type StoredSuspension = z.infer<typeof StoredSuspensionSchema>

const StoredAsksSchema = z.object({
  v: z.literal(1),
  buckets: z.record(z.string().regex(/^\d{1,15}$/), Count.positive()),
}).strict()
type StoredAsks = z.infer<typeof StoredAsksSchema>

const RecentSchema = z.array(z.object({ at: Count, count: Count.positive() }).strict())
  .max(RESERVATION_TTL / MINUTE + 1)
const StoredCapacitySchema = z.object({
  v: z.literal(1),
  /** Resource count the knowledge box last reported. */
  observed: Count,
  /** Admitted adds whose write has not settled yet, with their source bytes. */
  inflight: z.array(z.object({ token: TokenSchema, at: Count, bytes: Count }).strict())
    .max(MAX_IN_FLIGHT),
  /** Settled adds the reported count may not include yet, per minute. */
  added: RecentSchema,
  /** Deletions the reported count may still include, per minute. */
  removed: RecentSchema,
  /** Source bytes of each resource this portal added. */
  sized: z.record(ResourceIdSchema, Count),
  /** Resources in the knowledge box whose size the ledger does not know. */
  unsized: Count,
}).strict()
type StoredCapacity = z.infer<typeof StoredCapacitySchema>
type Recent = StoredCapacity['added']

export type AddAdmission =
  | { admitted: string | null }
  | { unavailable: true }
  | { limit: 'maxResources' | 'maxBytes'; value: number; max: number }
/** A created resource without an id is one whose size the ledger cannot record. */
export type AddOutcome = { created: false } | { created: true; id?: string }
export interface AddInput {
  observed?: number
  bytes: number | null
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  // Invalid configured timezones fail instead of resetting quotas in another timezone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function localDate(format: Intl.DateTimeFormat, instant: number): string {
  const parts = format.formatToParts(instant)
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name)!.value)
    .join('-')
}

function timestamp(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid lifecycle timestamp')
  return new Date(now).toISOString()
}

/** Find the next calendar-day boundary, including short/long days and offset changes. */
export function nextPortalDay(timeZone: string, now: number): string {
  timestamp(now)
  const format = dateFormatter(timeZone)
  const today = localDate(format, now)
  let low = now
  let high = now + 2 * DAY
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (localDate(format, middle) === today) low = middle
    else high = middle
  }
  return new Date(high).toISOString()
}

const sum = (values: Iterable<number>) => {
  let total = 0
  for (const value of values) total += value
  if (!Number.isSafeInteger(total)) throw new Error('Invalid persisted portal capacity')
  return total
}

/** The records kept per portal, each under `portal-<kind>:<slug>`. */
export const LIFECYCLE_RECORD_KINDS = ['lifecycle', 'asks', 'capacity', 'suspension'] as const
type LifecycleRecordKind = typeof LIFECYCLE_RECORD_KINDS[number]

/**
 * Hosting state for each portal: lifecycle status and limits, daily ask counts in the portal's
 * timezone, the last activity time, and a capacity ledger that admits resource and byte usage.
 */
export class PortalLifecycleStore {
  constructor(
    readonly state: LifecycleState = transientLifecycleState(),
    private readonly clock: () => number = Date.now,
  ) {}

  private key(kind: LifecycleRecordKind, slug: string): string {
    return `portal-${kind}:${SlugSchema.parse(slug)}`
  }

  private read(slug: string): StoredLifecycle {
    const raw = this.state.get<unknown>(this.key('lifecycle', slug), undefined)
    if (raw === undefined) {
      return {
        v: 1,
        lifecycle: { status: 'active', limits: null, updatedAt: null },
        lastActivityAt: null,
      }
    }
    const parsed = StoredLifecycleSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Invalid persisted portal lifecycle')
    return parsed.data
  }

  private readSuspension(slug: string): StoredSuspension | undefined {
    const raw = this.state.get<unknown>(this.key('suspension', slug), undefined)
    if (raw === undefined) return undefined
    const parsed = StoredSuspensionSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Invalid persisted portal lifecycle')
    return parsed.data
  }

  private readAsks(slug: string): StoredAsks {
    const raw = this.state.get<unknown>(this.key('asks', slug), undefined)
    if (raw === undefined) return { v: 1, buckets: {} }
    const parsed = StoredAsksSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Invalid persisted portal usage')
    return parsed.data
  }

  private readCapacity(slug: string): StoredCapacity | undefined {
    const raw = this.state.get<unknown>(this.key('capacity', slug), undefined)
    if (raw === undefined) return undefined
    const parsed = StoredCapacitySchema.safeParse(raw)
    if (!parsed.success) throw new Error('Invalid persisted portal capacity')
    return parsed.data
  }

  /** The single write path, one step per call; the local adapter joins the request's audit. */
  protected persistAll(changes: readonly (readonly [string, unknown | undefined])[]): void {
    for (const [key, record] of changes) {
      if (record === undefined) this.state.delete(key)
      else this.state.put(key, record)
    }
  }

  private persist(key: string, record: unknown | undefined): void {
    this.persistAll([[key, record]])
  }

  get(slug: string): PortalLifecycle {
    return this.read(slug).lifecycle
  }

  set(
    slug: string,
    input: Pick<PortalLifecycle, 'status' | 'limits'>,
    now = this.clock(),
  ): PortalLifecycle {
    const lifecycle = PortalLifecycleSchema.parse({ ...input, updatedAt: timestamp(now) })
    // A portal that stays suspended keeps the time its suspension began.
    const since = lifecycle.status !== 'suspended'
      ? undefined
      : this.suspendedSince(slug) ?? lifecycle.updatedAt!
    const record = this.read(slug)
    record.lifecycle = lifecycle
    this.persistAll([
      [this.key('lifecycle', slug), record],
      [
        this.key('suspension', slug),
        since === undefined ? undefined : { v: 1, since, updatedAt: lifecycle.updatedAt },
      ],
    ])
    return structuredClone(lifecycle)
  }

  /**
   * When the portal's current, unbroken suspension began, or null when it is not suspended. A
   * suspension recorded before this was tracked, or by a release that did not track it, counts
   * from the lifecycle's last change, which is never earlier than the suspension really began.
   */
  suspendedSince(slug: string): string | null {
    const { lifecycle } = this.read(slug)
    if (lifecycle.status !== 'suspended' || lifecycle.updatedAt === null) return null
    const suspension = this.readSuspension(slug)
    return suspension && suspension.updatedAt === lifecycle.updatedAt &&
        suspension.since <= suspension.updatedAt
      ? suspension.since
      : lifecycle.updatedAt
  }

  /** A removed portal leaves nothing behind for a later portal with the same slug. */
  remove(slug: string): void {
    this.persistAll(LIFECYCLE_RECORD_KINDS.map((kind) => [this.key(kind, slug), undefined]))
  }

  /** Remove every hosting record kept for the slug, readable or not, and count them. */
  erase(slug: string): number {
    const present = LIFECYCLE_RECORD_KINDS.filter((kind) => this.state.has(this.key(kind, slug)))
    if (present.length) this.persistAll(present.map((kind) => [this.key(kind, slug), undefined]))
    return present.length
  }

  usage(slug: string, timeZone = 'UTC', now = this.clock()): PortalAskUsage {
    timestamp(now)
    const { lastActivityAt } = this.read(slug)
    return { ...this.count(this.readAsks(slug), timeZone, now), lastActivityAt }
  }

  private count(record: StoredAsks, timeZone: string, now: number) {
    const format = dateFormatter(timeZone)
    const today = localDate(format, now)
    const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * DAY).toISOString().slice(0, 10)
    let asksToday = 0
    let asks30d = 0
    for (const [bucket, count] of Object.entries(record.buckets)) {
      const at = Number(bucket) * BUCKET
      if (!Number.isSafeInteger(at)) throw new Error('Invalid persisted portal usage')
      if (at > now) continue
      const date = localDate(format, at)
      if (date === today) asksToday += count
      if (date >= oldest && date <= today) asks30d += count
    }
    return { asksToday, asks30d }
  }

  /** Report whether the daily limit is spent without counting an ask. */
  askQuota(slug: string, timeZone = 'UTC', now = this.clock()): PortalAskQuota | null {
    timestamp(now)
    const limit = this.get(slug).limits?.asksPerDay
    // Counting also validates the timezone, so a misconfigured portal fails every ask.
    const { asksToday } = this.count(this.readAsks(slug), timeZone, now)
    if (limit === undefined || asksToday < limit) return null
    return { limit, resetsAt: nextPortalDay(timeZone, now) }
  }

  /**
   * Count one ask, or refuse it when the portal's daily limit is spent. Activity is recorded
   * separately (`touch`) once the ask succeeds, so a refused request leaves no trace.
   */
  consumeAsk(slug: string, timeZone = 'UTC', now = this.clock()): PortalAskQuota | null {
    timestamp(now)
    const denied = this.askQuota(slug, timeZone, now)
    if (denied) return denied
    const asks = this.readAsks(slug)
    // Keep enough for thirty local calendar days, including timezone changes and DST.
    const buckets = Object.fromEntries(
      Object.entries(asks.buckets).filter(([bucket]) => Number(bucket) * BUCKET >= now - 32 * DAY),
    )
    const bucket = String(Math.floor(now / BUCKET))
    buckets[bucket] = (buckets[bucket] ?? 0) + 1
    this.persist(this.key('asks', slug), { v: 1, buckets })
    return null
  }

  /**
   * Return one ask counted at `now` whose request was then refused before it was answered, such
   * as by the per-minute rate limit or invalid input, so a refused request costs no quota.
   */
  refundAsk(slug: string, now: number): void {
    timestamp(now)
    const asks = this.readAsks(slug)
    const bucket = String(Math.floor(now / BUCKET))
    const count = asks.buckets[bucket]
    if (count === undefined) return
    if (count > 1) asks.buckets[bucket] = count - 1
    else delete asks.buckets[bucket]
    // No asks left is the same as no record, so a lone refused ask leaves nothing behind.
    this.persist(this.key('asks', slug), Object.keys(asks.buckets).length ? asks : undefined)
  }

  /** Record portal activity, at most once per resolution interval and never backwards. */
  touch(slug: string, now = this.clock()): void {
    const iso = timestamp(now)
    const record = this.read(slug)
    const last = record.lastActivityAt ? Date.parse(record.lastActivityAt) : undefined
    if (last !== undefined && (last >= now || now - last < ACTIVITY_RESOLUTION)) return
    record.lastActivityAt = iso
    this.persist(this.key('lifecycle', slug), record)
  }

  /** Whether the ledger has started; before then an add must observe the knowledge box. */
  hasCapacityLedger(slug: string): boolean {
    return this.readCapacity(slug) !== undefined
  }

  /** Apply a fresh resource count: expire, absorb counted changes, notice outside additions. */
  private observe(record: StoredCapacity, observed: number | undefined, now: number): void {
    const live = (entry: { at: number }) => entry.at > now - RESERVATION_TTL
    record.inflight = record.inflight.filter(live)
    record.added = record.added.filter(live)
    record.removed = record.removed.filter(live)
    if (observed === undefined) return
    if (observed > record.observed) record.added = consume(record.added, observed - record.observed)
    if (observed < record.observed) {
      record.removed = consume(record.removed, record.observed - observed)
    }
    record.observed = observed
    // The box holds no more resources than the ledger knows of, plus writes in flight and
    // deletions it has not counted yet; anything beyond that was added outside this portal.
    const known = Object.keys(record.sized).length + record.unsized + record.inflight.length +
      total(record.removed)
    if (observed > known) record.unsized += observed - known
  }

  private bytesOf(record: StoredCapacity): number | null {
    return record.unsized === 0 ? sum(Object.values(record.sized)) : null
  }

  /** Source bytes this portal knows the knowledge box holds, or null when it cannot know. */
  bytesUsed(slug: string, observed: number): number | null {
    Count.parse(observed)
    const record = this.readCapacity(slug)
    if (!record) return observed === 0 ? 0 : null
    this.observe(record, observed, this.clock())
    return this.bytesOf(record)
  }

  /**
   * Admit one add against the current limits in a single synchronous step, so concurrent
   * requests cannot both take the last slot. `observed` is a fresh resource count; it is
   * required while a capacity limit is set and before the ledger has started. `bytes` is null
   * for an add whose size the portal cannot know, which a byte limit refuses as unavailable.
   */
  reserveAdd(slug: string, input: AddInput): AddAdmission {
    return this.admit(slug, input, true)
  }

  /** The same decision as `reserveAdd`, without reserving or writing anything. */
  checkAdd(slug: string, input: AddInput): AddAdmission {
    return this.admit(slug, input, false)
  }

  private admit(slug: string, input: AddInput, reserve: boolean): AddAdmission {
    const now = this.clock()
    timestamp(now)
    const bytes = input.bytes === null ? null : Count.parse(input.bytes)
    const observed = input.observed === undefined ? undefined : Count.parse(input.observed)
    const limits = this.get(slug).limits
    const limited = limits?.maxResources !== undefined || limits?.maxBytes !== undefined
    let record = this.readCapacity(slug)
    if (!record) {
      // An unlimited portal keeps working when the box cannot be observed; its ledger starts
      // at the next observation, which counts this add among the resources it cannot size.
      if (observed === undefined) return limited ? { unavailable: true } : { admitted: null }
      record = {
        v: 1,
        observed,
        inflight: [],
        added: [],
        removed: [],
        sized: {},
        unsized: observed,
      }
    } else this.observe(record, observed, now)
    const key = this.key('capacity', slug)
    // A refusal still records the observation it made, so later decisions start from it.
    const refuse = (admission: AddAdmission) => {
      if (reserve) this.persist(key, record)
      return admission
    }
    if (limited && observed === undefined) return refuse({ unavailable: true })
    const maxResources = limits?.maxResources
    if (maxResources !== undefined) {
      const value = record.observed + record.inflight.length + total(record.added) -
        total(record.removed) + 1
      if (value > maxResources) return refuse({ limit: 'maxResources', value, max: maxResources })
    }
    const maxBytes = limits?.maxBytes
    if (maxBytes !== undefined) {
      const used = this.bytesOf(record)
      if (used === null || bytes === null) return refuse({ unavailable: true })
      const value = used + sum(record.inflight.map((entry) => entry.bytes)) + bytes
      if (value > maxBytes) return refuse({ limit: 'maxBytes', value, max: maxBytes })
    }
    if (record.inflight.length >= MAX_IN_FLIGHT) return refuse({ unavailable: true })
    if (!reserve) return { admitted: null }
    const token = crypto.randomUUID().replaceAll('-', '')
    record.inflight.push({ token, at: now, bytes: bytes ?? 0 })
    this.persist(key, record)
    return { admitted: token }
  }

  /** Settle an admitted add: record the new resource's size, or release a failed write. */
  settleAdd(slug: string, token: string | null, outcome: AddOutcome): void {
    if (token === null) return
    const now = this.clock()
    const record = this.readCapacity(slug)
    if (!record) return
    this.observe(record, undefined, now)
    const entry = record.inflight.find((item) => item.token === token)
    record.inflight = record.inflight.filter((item) => item !== entry)
    if (outcome.created) {
      const id = ResourceIdSchema.safeParse(outcome.id)
      // A write that settled after its reservation expired, or returned no usable id,
      // exists with an unknown size.
      if (!entry || !id.success || Object.keys(record.sized).length >= MAX_SIZED) {
        record.unsized++
      } else record.sized[id.data] = entry.bytes
      record.added = bump(record.added, now)
    }
    this.persist(this.key('capacity', slug), record)
  }

  /** Release the size of a resource this portal deleted. */
  forgetResource(slug: string, id: string): void {
    const now = this.clock()
    const record = this.readCapacity(slug)
    if (!record) return
    this.observe(record, undefined, now)
    const parsed = ResourceIdSchema.safeParse(id)
    if (parsed.success && Object.hasOwn(record.sized, parsed.data)) {
      delete record.sized[parsed.data]
    } else if (record.unsized > 0) record.unsized--
    record.removed = bump(record.removed, now)
    this.persist(this.key('capacity', slug), record)
  }

  /** A different knowledge box starts a fresh ledger. */
  resetCapacity(slug: string): void {
    this.persist(this.key('capacity', slug), undefined)
  }
}

function total(recent: Recent): number {
  return sum(recent.map((entry) => entry.count))
}

/** Count one change in its minute, so the ledger stays bounded whatever the volume. */
function bump(recent: Recent, now: number): Recent {
  const at = Math.floor(now / MINUTE) * MINUTE
  const last = recent.at(-1)
  if (last && last.at === at) return [...recent.slice(0, -1), { at, count: last.count + 1 }]
  return [...recent, { at, count: 1 }]
}

/** Drop the oldest `amount` changes, which a newer resource count now includes. */
function consume(recent: Recent, amount: number): Recent {
  const result: Recent = []
  for (const entry of recent) {
    const taken = Math.min(entry.count, amount)
    amount -= taken
    if (entry.count > taken) result.push({ at: entry.at, count: entry.count - taken })
  }
  return result
}

/** Reads every file operation afresh so multiple local adapter instances share admission state. */
export class FileLifecycleState implements LifecycleState {
  constructor(private readonly dataDir: string) {}

  path(key: string): string {
    if (!/^portal-(?:lifecycle|asks|capacity|suspension):[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new Error('Invalid portal lifecycle storage key')
    }
    return join(this.dataDir, 'lifecycle', `${key.replace(':', '-')}.json`)
  }

  get<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path(key), 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw new Error('Invalid persisted portal lifecycle')
    }
  }

  put(key: string, value: unknown): void {
    ownedMutation([{ path: this.path(key), value }])
  }

  delete(key: string): void {
    ownedMutation([{ path: this.path(key), value: undefined }])
  }

  has(key: string): boolean {
    return existsSync(this.path(key))
  }
}

export class FileLifecycleStore extends PortalLifecycleStore {
  constructor(
    dataDir = './data',
    private readonly boundary?: OwnedMutationBoundary,
    clock: () => number = Date.now,
  ) {
    super(new FileLifecycleState(dataDir), clock)
  }

  protected override persistAll(
    changes: readonly (readonly [string, unknown | undefined])[],
  ): void {
    const state = this.state as FileLifecycleState
    ownedMutation(changes.map(([key, value]) => ({ path: state.path(key), value })), this.boundary)
  }
}
