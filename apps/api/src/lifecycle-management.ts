import {
  DOC_PAGES,
  type DocPage,
  docPageToMarkdown,
  type TenantConfig,
} from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'
import { AsyncLocalStorage } from 'node:async_hooks'
import { PortalLifecycleError } from './lifecycle-error.ts'
import type { AddOutcome, PortalLifecycleStore } from './lifecycle-store.ts'

interface ManagementOptions {
  /**
   * Let a write reach a suspended portal while it runs for a request the route guard admitted
   * for a platform administrator or owner (`withRequestAuthority`). Every other request, and
   * every write made outside a request, such as by a scheduled job, is refused.
   */
  platformRequests?: boolean
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

/** The knowledge box's own resource count, the authority for `maxResources`. */
async function resources(management: AragProvider, config: TenantConfig): Promise<number> {
  try {
    const value = await management.resourceCount(config)
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable()
    return value
  } catch {
    // Never expose upstream diagnostics or continue on an unknown count.
    throw unavailable()
  }
}

/** How many awaiting resources one check measures, so no add waits on a long list. */
const MEASURE_PER_CHECK = 5

/**
 * Measure resources admitted before their size was known (crawled links) once the platform has
 * processed them: what they hold is their extracted text, counted as text additions are. One
 * that failed processing holds nothing, and one the knowledge box no longer has is missing
 * (null). One still processing, or whose read fails, is left for a later check.
 */
async function measurePending(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
): Promise<{ id: string; bytes: number | null }[]> {
  const settled: { id: string; bytes: number | null }[] = []
  for (const id of lifecycle.pendingMeasurements(config.slug, MEASURE_PER_CHECK)) {
    let extraction: { status: string; text: string }
    try {
      extraction = await management.resourceExtraction(config, id)
    } catch (error) {
      if (error instanceof AragApiError && error.status === 404) settled.push({ id, bytes: null })
      continue
    }
    if (extraction.status === 'PROCESSED') {
      settled.push({ id, bytes: encoder.encode(extraction.text ?? '').byteLength })
    } else if (extraction.status === 'ERROR') settled.push({ id, bytes: 0 })
  }
  return settled
}

/** Record the sizes of processed resources the ledger was waiting to measure. */
export async function reconcileMeasurements(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
): Promise<void> {
  for (const { id, bytes } of await measurePending(management, lifecycle, config)) {
    lifecycle.measured(config.slug, id, bytes)
  }
}

/**
 * Resource count from the knowledge box, and source bytes from the portal's ledger. A report is
 * a read and writes nothing: resources still awaiting measurement are measured for the answer,
 * and the ledger records them at its next admission.
 */
export async function capacityUsage(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
): Promise<{ resources: number; bytes: number | null }> {
  const measured = await measurePending(management, lifecycle, config)
  const observed = await resources(management, config)
  const bytes = lifecycle.bytesUsed(config.slug, observed)
  return {
    resources: observed,
    bytes: bytes === null
      ? null
      : bytes + measured.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
  }
}

/**
 * Admit one add of `bytes` source bytes, returning the reservation to settle once the write
 * finishes. Refusals: 423 for lifecycle state, 413 for a limit, 503 when a limit cannot be
 * checked because the knowledge box cannot be counted or the portal's bytes are unknown.
 */
async function admitAdd(
  management: AragProvider,
  lifecycle: PortalLifecycleStore,
  config: TenantConfig,
  bytes: number | null,
  options: ManagementOptions,
  measure = false,
): Promise<string | null> {
  return await serialCapacity(lifecycle, config.slug, async () => {
    assertManagementWritable(lifecycle, config.slug, options)
    const limits = lifecycle.get(config.slug).limits
    const limited = limits?.maxResources !== undefined || limits?.maxBytes !== undefined
    // A byte limit decides on the bytes the ledger knows: measure what has since been processed.
    if (limits?.maxBytes !== undefined) await reconcileMeasurements(management, lifecycle, config)
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
    const admission = lifecycle.reserveAdd(config.slug, { observed, bytes, measure })
    if ('unavailable' in admission) throw unavailable()
    if ('limit' in admission) {
      throw new PortalLifecycleError(413, { error: 'limit_exceeded', ...admission })
    }
    return admission.admitted
  })
}

/**
 * Check, without reserving, that one more add could be admitted now. A route that must do
 * remote work before its write, such as fetching a page to add, calls this first so a full
 * portal refuses before anything is fetched. Any add brings at least one byte. The write itself
 * is still admitted by the guard.
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
  const admission = lifecycle.checkAdd(config.slug, { observed, bytes: 1 })
  if ('unavailable' in admission) throw unavailable()
  if ('limit' in admission) {
    throw new PortalLifecycleError(413, { error: 'limit_exceeded', ...admission })
  }
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
 * content the portal has not seen yet, so its size is unknown (null) until the ledger measures
 * the processed resource. An add whose size cannot be read is refused rather than admitted.
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
              name === 'createLink',
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
