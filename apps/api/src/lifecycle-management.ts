import {
  DOC_PAGES,
  type DocPage,
  docPageToMarkdown,
  type TenantConfig,
} from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'
import { AsyncLocalStorage } from 'node:async_hooks'
import { PortalLifecycleError } from './lifecycle-error.ts'
import {
  type AddAdmission,
  type AddOutcome,
  DEFAULT_LINK_PROVISIONAL_BYTES,
  type Measurement,
  type PortalLifecycleStore,
} from './lifecycle-store.ts'

export { DEFAULT_LINK_PROVISIONAL_BYTES }

interface ManagementOptions {
  /**
   * Let a write reach a suspended portal while it runs for a request the route guard admitted
   * for a platform administrator or owner (`withRequestAuthority`). Every other request, and
   * every write made outside a request, such as by a scheduled job, is refused.
   */
  platformRequests?: boolean
  /**
   * Bytes a crawled link holds against a byte limit until the platform has processed it and the
   * ledger has measured it (`LINK_PROVISIONAL_BYTES`). `DEFAULT_LINK_PROVISIONAL_BYTES` when unset.
   */
  linkProvisionalBytes?: number
}

/** `LINK_PROVISIONAL_BYTES`: a whole number of bytes, at least 1, otherwise the default. */
export function linkProvisionalBytes(value: string | undefined): number {
  if (value === undefined || !/^\s*\d{1,15}\s*$/.test(value)) return DEFAULT_LINK_PROVISIONAL_BYTES
  const parsed = Number(value)
  return parsed >= 1 ? parsed : DEFAULT_LINK_PROVISIONAL_BYTES
}

const requestAuthority = new AsyncLocalStorage<{ platform: boolean }>()

/**
 * Run the rest of one request with its caller's platform authority on record, so each write it
 * makes, however long after the request started, is judged against that caller.
 */
export function withRequestAuthority<T>(platform: boolean, work: () => T): T {
  return requestAuthority.run({ platform }, work)
}

function platformRequest(): boolean {
  return requestAuthority.getStore()?.platform === true
}

/** Provider methods that change a knowledge box. A read-only portal refuses every one. */
const MUTATIONS = new Set([
  'registerExtractionMethod',
  'patchResourceClassifications',
  'createLabelset',
  'updateLabelset',
  'startAgent',
  'patchResourceMeta',
  'deleteResource',
  'setResourceHidden',
  'purgeFailedResources',
  'ensureSearchConfigs',
  'ingestDocumentation',
  'deleteAgent',
  'createText',
  'createLink',
  'uploadFile',
])
const ADDS = new Set(['createText', 'createLink', 'uploadFile'])
const queues = new WeakMap<object, Map<string, Promise<void>>>()
const encoder = new TextEncoder()

/** Keep one portal's counter snapshots in order without blocking unrelated portals. */
async function serialCapacity<T>(
  lifecycle: PortalLifecycleStore,
  slug: string,
  work: () => Promise<T>,
): Promise<T> {
  let portals = queues.get(lifecycle.state)
  if (!portals) queues.set(lifecycle.state, portals = new Map())
  const previous = portals.get(slug) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => release = resolve)
  portals.set(slug, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (portals.get(slug) === tail) portals.delete(slug)
  }
}

export function assertManagementWritable(
  lifecycle: PortalLifecycleStore,
  slug: string,
  options: ManagementOptions = {},
): void {
  const status = lifecycle.get(slug).status
  if (status === 'read_only') {
    throw new PortalLifecycleError(423, { error: 'portal_read_only' })
  }
  if (status === 'suspended' && !(options.platformRequests && platformRequest())) {
    throw new PortalLifecycleError(423, { error: 'portal_suspended' })
  }
}

/**
 * The check a long generation run (enrichments, suggested questions) makes before each paid
 * model call and before each write: the portal still accepts writes, judged as
 * `assertManagementWritable` judges them, and still allows its agents. A throw stops the run.
 */
export function assertAgentRunAllowed(
  lifecycle: PortalLifecycleStore,
  slug: string,
  options: ManagementOptions = {},
): void {
  assertManagementWritable(lifecycle, slug, options)
  if (lifecycle.get(slug).limits?.agentsEnabled === false) {
    throw new PortalLifecycleError(403, { error: 'agents_disabled' })
  }
}

/** Methods of a portal-local store that change it. Each takes the portal slug first. */
const STORE_WRITES = new Set(['add', 'update', 'remove', 'put', 'importRecords'])

/**
 * Wrap a portal-local store (sources, enrichments), whose methods take the portal slug first,
 * so each write checks lifecycle state at the moment it lands, as `guardManagement` does for
 * knowledge-box writes. Scheduled jobs write through it without the platform exception; long
 * HTTP runs write through it with `platformRequests`, so they are judged by who started them.
 */
export function guardPortalWrites<T extends object>(
  store: T,
  lifecycle?: PortalLifecycleStore,
  options: ManagementOptions = {},
): T {
  if (!lifecycle) return store
  return new Proxy(store, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver)
      if (typeof method !== 'function') return method
      return (slug: string, ...args: unknown[]) => {
        if (STORE_WRITES.has(String(property))) {
          assertManagementWritable(lifecycle, slug, options)
        }
        return method.call(target, slug, ...args)
      }
    },
  })
}

function unavailable(): PortalLifecycleError {
  return new PortalLifecycleError(503, { error: 'usage_unavailable' })
}

/**
 * How long the resource count may take. Admission waits for it while holding the portal's
 * capacity lock, so a count that never answers must not hold every other add.
 */
const COUNT_TIMEOUT_MS = 15_000

/** The knowledge box's own resource count, the authority for `maxResources`. */
async function resources(management: AragProvider, config: TenantConfig): Promise<number> {
  try {
    const value = await withinTimeout(
      (signal) => management.resourceCount(config, { signal }),
      COUNT_TIMEOUT_MS,
    )
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable()
    return value
  } catch {
    // Never expose upstream diagnostics or continue on an unknown count.
    throw unavailable()
  }
}

/** Statuses after which a resource's extracted text no longer changes. */
const SETTLED_STATUSES = new Set(['PROCESSED', 'ERROR', 'BLOCKED', 'EXPIRED'])
/** Links an add or a precheck reads when links awaiting measurement stand in its way. */
const MEASURE_PER_CHECK = 10
/** Links a usage report reads at most. */
const MEASURE_PER_REPORT = 50
/** Reads one measurement makes at once, and how long a caller waits for them in all. */
const MEASURE_CONCURRENCY = 4
const MEASURE_DEADLINE_MS = 8_000
/**
 * How long one read may go on after its caller stopped waiting. A read that takes longer is
 * given up (and its request aborted), counts as a failed read, and the link can be read again.
 */
const READ_TIMEOUT_MS = 30_000

/**
 * Readings of links awaiting measurement, per portal: the latest finding for each link, not
 * recorded yet, and the links being read now. They live in memory, so reads (a usage report, a
 * precheck) can measure without writing; the next admission records them.
 */
interface Readings {
  found: Map<string, Measurement>
  reading: Set<string>
}
const readingsByState = new WeakMap<object, Map<string, Readings>>()

function readingsFor(lifecycle: PortalLifecycleStore, slug: string): Readings {
  let portals = readingsByState.get(lifecycle.state)
  if (!portals) readingsByState.set(lifecycle.state, portals = new Map())
  let readings = portals.get(slug)
  if (!readings) portals.set(slug, readings = { found: new Map(), reading: new Set() })
  return readings
}

/** The findings not recorded yet. */
function foundReadings(lifecycle: PortalLifecycleStore, slug: string): Measurement[] {
  return [...readingsFor(lifecycle, slug).found.values()]
}

/** The findings, for an admission to record. Each is recorded once. */
function takeReadings(lifecycle: PortalLifecycleStore, slug: string): Measurement[] {
  const measurements = foundReadings(lifecycle, slug)
  readingsFor(lifecycle, slug).found.clear()
  return measurements
}

/**
 * Links awaiting measurement worth reading now, the least recently tried first: not being read,
 * not already found measured, and not among `skip`.
 */
function dueReadings(
  lifecycle: PortalLifecycleStore,
  slug: string,
  limit: number,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const { found, reading } = readingsFor(lifecycle, slug)
  const measured = (id: string) => {
    const finding = found.get(id)
    return finding !== undefined && 'bytes' in finding
  }
  return lifecycle.pendingMeasurements(slug)
    .filter((id) => !reading.has(id) && !measured(id) && !skip.has(id))
    .slice(0, limit)
}

/**
 * Run a read that is given up after `ms`: its signal is aborted and the answer is a
 * `TimeoutError`, even when the read itself ignores the signal and never settles.
 */
export function withinTimeout<T>(
  read: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException('The read timed out.', 'TimeoutError')
      abort.abort(reason)
      reject(reason)
    }, ms)
  })
  return Promise.race([read(abort.signal), timedOut]).finally(() => clearTimeout(timer))
}

/**
 * Read resources admitted before their size was known (crawled links). Once the platform has
 * settled one, what it holds is its extracted text, counted as text additions are. One still
 * processing, in a status this code does not know, or whose read fails, is pending: that
 * includes a 404, which a box that has not caught up with a write can answer. A few links are
 * read at once, and the caller waits no longer than the deadline; a read still going on keeps
 * going and its finding is used later. Reading never writes: an admission records the findings.
 */
async function measure(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
  ids: readonly string[],
): Promise<void> {
  const readings = readingsFor(lifecycle, config.slug)
  const queue = ids.filter((id) => !readings.reading.has(id))
  const read = async (id: string) => {
    readings.reading.add(id)
    let measurement: Measurement
    try {
      const extraction = await withinTimeout(
        (signal) => management.resourceExtraction(config, id, { signal }),
        READ_TIMEOUT_MS,
      )
      measurement = SETTLED_STATUSES.has(extraction.status)
        ? { id, bytes: encoder.encode(extraction.text ?? '').byteLength }
        : { id, pending: true }
    } catch (error) {
      // A 404 is recorded as such: pending at first, and settled once it has lasted.
      measurement = error instanceof AragApiError && error.status === 404
        ? { id, missing: true }
        : { id, pending: true }
    }
    readings.found.set(id, measurement)
    readings.reading.delete(id)
  }
  let open = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      open = false
      resolve()
    }, MEASURE_DEADLINE_MS)
  })
  const worker = async () => {
    while (open && queue.length) await Promise.race([read(queue.shift()!), deadline])
  }
  try {
    await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, worker))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resource count from the knowledge box, and the source bytes it is known to store. A crawled
 * link counts once it is measured; its provisional bytes are a reservation against a byte limit,
 * not stored content, so they are never reported. The report reads links that are due, so
 * repeated reports settle without an add. A report is a read and records nothing: the next
 * admission records what it found.
 */
export async function capacityUsage(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
): Promise<{ resources: number; bytes: number | null }> {
  const due = dueReadings(lifecycle, config.slug, MEASURE_PER_REPORT)
  const [, observed] = await Promise.all([
    measure(management, lifecycle, config, due),
    resources(management, config),
  ])
  return {
    resources: observed,
    bytes: lifecycle.storedBytes(config.slug, observed, foundReadings(lifecycle, config.slug)),
  }
}

function refusal(admission: Exclude<AddAdmission, { admitted: string | null }>) {
  if ('unmeasured' in admission) return new PortalLifecycleError(503, { error: 'links_pending' })
  if ('stuck' in admission) return new PortalLifecycleError(413, { error: 'links_stuck' })
  if ('unavailable' in admission) return unavailable()
  return new PortalLifecycleError(413, { error: 'limit_exceeded', ...admission })
}

/** A refusal that measuring links awaiting measurement could change. */
function measurable(admission: AddAdmission): boolean {
  return ('limit' in admission && admission.limit === 'maxBytes') || 'unmeasured' in admission ||
    'stuck' in admission
}

/**
 * Admit one add of `bytes` source bytes, or of `provisional` bytes for a crawled link whose size
 * is not known yet, returning the reservation to settle once the write finishes. Every admission
 * records the findings of earlier reads. Refusals: 423 for lifecycle state, 413 for a limit, 503
 * when a limit cannot be checked because the knowledge box cannot be counted or the portal's
 * bytes are unknown, and 503 `links_pending` while crawled links waiting to be measured stand in
 * the way.
 */
async function admitAdd(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
  bytes: number | null,
  options: ManagementOptions,
  provisional?: number,
): Promise<string | null> {
  let measured = false
  while (true) {
    let recorded: string[] = []
    const admission = await serialCapacity(lifecycle, config.slug, async () => {
      assertManagementWritable(lifecycle, config.slug, options)
      const limits = lifecycle.get(config.slug).limits
      const limited = limits?.maxResources !== undefined || limits?.maxBytes !== undefined
      let observed: number | undefined
      if (limited || !lifecycle.hasCapacityLedger(config.slug)) {
        try {
          observed = await resources(management, config)
        } catch (error) {
          if (limited) throw error
        }
      }
      // The counter request yielded: recheck, then admit in one synchronous store step
      // immediately before the provider write begins.
      assertManagementWritable(lifecycle, config.slug, options)
      const measurements = takeReadings(lifecycle, config.slug)
      recorded = measurements.map((measurement) => measurement.id)
      return lifecycle.reserveAdd(config.slug, { observed, bytes, provisional, measurements })
    })
    if ('admitted' in admission) return admission.admitted
    // Crawled links awaiting measurement hold provisional bytes. When those may be what stands
    // in the way, read the ones not just recorded, outside the capacity lock so no other add
    // waits on the reads, and judge this add once more with what was found.
    if (!measured && measurable(admission)) {
      const due = dueReadings(lifecycle, config.slug, MEASURE_PER_CHECK, new Set(recorded))
      if (due.length) {
        measured = true
        await measure(management, lifecycle, config, due)
        continue
      }
    }
    throw refusal(admission)
  }
}

/**
 * Check, without reserving, that one more add could be admitted now. A route that must do
 * remote work before its write, such as fetching a page to add, calls this first so a full
 * portal refuses before anything is fetched. Any add brings at least one byte. When crawled
 * links awaiting measurement may be in the way, they are read, and the add that follows records
 * what was found rather than reading them again. The write itself is still admitted by the guard.
 */
export async function precheckAdd(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
  options: ManagementOptions = {},
): Promise<void> {
  assertManagementWritable(lifecycle, config.slug, options)
  const limits = lifecycle.get(config.slug).limits
  if (limits?.maxResources === undefined && limits?.maxBytes === undefined) return
  const observed = await resources(management, config)
  assertManagementWritable(lifecycle, config.slug, options)
  const check = () =>
    lifecycle.checkAdd(config.slug, {
      observed,
      bytes: 1,
      measurements: foundReadings(lifecycle, config.slug),
    })
  let admission = check()
  const due = measurable(admission) ? dueReadings(lifecycle, config.slug, MEASURE_PER_CHECK) : []
  if (due.length) {
    await measure(management, lifecycle, config, due)
    admission = check()
  }
  if (!('admitted' in admission)) throw refusal(admission)
}

/** Run an admitted write and settle its reservation whatever the outcome. */
async function settled<T>(
  lifecycle: PortalLifecycleStore,
  slug: string,
  token: string | null,
  write: () => Promise<T>,
  outcome: (result: T) => AddOutcome,
): Promise<T> {
  let result: T
  try {
    result = await write()
  } catch (error) {
    try {
      lifecycle.settleAdd(slug, token, { created: false })
    } catch { /* The write's own failure is the one reported. */ }
    throw error
  }
  lifecycle.settleAdd(slug, token, outcome(result))
  return result
}

function createdId(result: unknown): AddOutcome {
  const id = (result as { id?: unknown } | undefined)?.id
  return { created: true, ...(typeof id === 'string' ? { id } : {}) }
}

/**
 * Source bytes an add sends: file bytes and text bytes. A link the platform crawls stores
 * content the portal has not seen yet, so its size is unknown (null): it holds provisional bytes
 * until the ledger measures the processed resource. An add whose size cannot be read is refused
 * rather than admitted.
 */
function addBytes(name: string, input: unknown): number | null {
  const value = input as { body?: unknown; bytes?: unknown } | undefined
  if (name === 'uploadFile' && value?.bytes instanceof Uint8Array) return value.bytes.byteLength
  if (name === 'createText' && typeof value?.body === 'string') {
    return encoder.encode(value.body).byteLength
  }
  if (name === 'createLink') return null
  throw unavailable()
}

/**
 * Wrap the management provider so every write checks lifecycle state at the moment it happens,
 * including writes made deep inside compound operations and scheduled jobs. Adds are admitted
 * against the limits and recorded on the capacity ledger; deletions release their size.
 */
export function guardManagement(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  options: ManagementOptions = {},
): AragProvider {
  const methods = new Map<PropertyKey, unknown>()
  const provisional = options.linkProvisionalBytes ?? DEFAULT_LINK_PROVISIONAL_BYTES
  return new Proxy(management, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (methods.has(property)) return methods.get(property)
      const name = String(property)
      let wrapped: unknown
      if (name === 'ingestDocumentation') {
        wrapped = async (config: TenantConfig, pages: DocPage[] = DOC_PAGES) => {
          const result = {
            created: [] as string[],
            updated: [] as string[],
            failed: [] as { id: string; error: string }[],
          }
          // One page at a time, so each new page is admitted against the limits it meets.
          for (const page of pages) {
            assertManagementWritable(lifecycle, config.slug, options)
            const bytes = encoder.encode(docPageToMarkdown(page)).byteLength
            const part = await value.call(receiver, config, [page], {
              beforeCreate: async () => {
                const token = await admitAdd(management, lifecycle, config, bytes, options)
                return (outcome: AddOutcome) => lifecycle.settleAdd(config.slug, token, outcome)
              },
              beforeUpdate: () => assertManagementWritable(lifecycle, config.slug, options),
            })
            result.created.push(...part.created)
            result.updated.push(...part.updated)
            result.failed.push(...part.failed)
          }
          return result
        }
      } else if (MUTATIONS.has(name)) {
        wrapped = async (config: TenantConfig, ...args: unknown[]) => {
          assertManagementWritable(lifecycle, config.slug, options)
          if (name === 'startAgent' && lifecycle.get(config.slug).limits?.agentsEnabled === false) {
            throw new PortalLifecycleError(403, { error: 'agents_disabled' })
          }
          if (ADDS.has(name)) {
            const bytes = addBytes(name, args[0])
            const token = await admitAdd(
              management,
              lifecycle,
              config,
              bytes,
              options,
              name === 'createLink' ? provisional : undefined,
            )
            return await settled(
              lifecycle,
              config.slug,
              token,
              () => value.call(receiver, config, ...args),
              // A crawled link is recorded by id, for the ledger to measure once processed.
              createdId,
            )
          }
          const result = await value.call(receiver, config, ...args)
          if (name === 'deleteResource' && typeof args[0] === 'string') {
            lifecycle.forgetResource(config.slug, args[0])
          }
          return result
        }
      } else wrapped = value.bind(receiver)
      methods.set(property, wrapped)
      return wrapped
    },
  })
}

interface BindingWrites {
  get(slug: string): { baseUrl: string } | undefined
  set(slug: string, ...rest: never[]): unknown
  remove(slug: string, ...rest: never[]): unknown
}

/**
 * A capacity ledger describes one knowledge box. Wrap the binding store so that connecting a
 * different box, or disconnecting one, starts the portal's ledger afresh once the write lands,
 * whichever route or job made it. A binding the store withholds (one it cannot open) names no
 * box, so replacing or removing it always starts afresh: the ledger cannot be shown to describe
 * the box that follows.
 */
export function resetCapacityOnRebind<T extends BindingWrites>(
  bindings: T,
  lifecycle: PortalLifecycleStore,
): T {
  const methods = new Map<PropertyKey, unknown>()
  const unreadable = Symbol('unreadable')
  return new Proxy(bindings, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (methods.has(property)) return methods.get(property)
      let wrapped: unknown = value.bind(target)
      if (property === 'set' || property === 'remove') {
        const boxOf = (slug: string) => {
          try {
            return target.get(slug)?.baseUrl
          } catch {
            return unreadable
          }
        }
        wrapped = (slug: string, ...rest: unknown[]) => {
          const before = boxOf(slug)
          const reset = () => {
            const after = boxOf(slug)
            if (before === unreadable || after === unreadable || after !== before) {
              lifecycle.resetCapacity(slug)
            }
          }
          const result = value.call(target, slug, ...rest)
          if (result instanceof Promise) {
            return result.then((settled) => {
              reset()
              return settled
            })
          }
          reset()
          return result
        }
      }
      methods.set(property, wrapped)
      return wrapped
    },
  })
}
