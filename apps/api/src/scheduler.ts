import type { EnrichmentRunEvent, TenantConfig } from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'
import {
  CRAWLER_USER_AGENT,
  describeFetchFailure,
  discoverLinks,
  extractMainContent,
  looksLikeChallengePage,
} from './crawl.ts'
import { type Source, type SourceStoreApi, type WatchStoreApi } from './stores.ts'
import { FeedbackStore, type FeedbackStoreApi } from './stores.ts'
import {
  type EnrichmentStoreApi,
  isAccountBackpressure,
  runEnrichmentOverCorpus,
} from './enrichments.ts'
import type { BindingStoreApi } from './bindings.ts'
import { runSuggestedQuestionsOverCorpus } from './suggested-questions.ts'
import type { TenantStoreApi } from './tenants.ts'
import { appendAudit, type AuditStore, createAuditEvent } from './audit.ts'
import type { RbacState } from './rbac-state.ts'
import { executeAudited, type LocalMutationScope } from './audit-execution.ts'
import { DECLARATIONS } from './permissions.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import {
  assertAgentRunAllowed,
  guardManagement,
  guardPortalWrites,
} from './lifecycle-management.ts'
import { PortalLifecycleError } from './lifecycle-error.ts'
import { readLifecycle } from './lifecycle-policy.ts'

interface SystemJobContext {
  localMutations?: LocalMutationScope
  audit: AuditStore
  requestId: string
  lifecycle?: PortalLifecycleStore
  /** Knowledge-box bindings: a portal without a connected box has nothing to maintain. */
  bindings?: Pick<BindingStoreApi, 'status'>
  /** The pass's clock, which also picks the portal that goes first. */
  now?: () => number
}

type MaintenanceJob = 'sync' | 'watch' | 'enrichment'

/**
 * One unit of scheduled work that failed: which job, and the portal and the kind of thing it was
 * for. Never the error itself, which can carry a source's address or upstream detail.
 */
export interface MaintenanceFailure {
  job: MaintenanceJob
  slug?: string
  target: 'source' | 'watch' | 'enrichment' | 'questions' | 'portal' | 'job'
}

/**
 * Every failed unit of a maintenance pass, thrown once the pass is over so the runtime still
 * records a failed invocation. `halted` says the pass stopped early on account back-pressure.
 */
export class MaintenanceError extends Error {
  constructor(readonly failures: readonly MaintenanceFailure[], readonly halted = false) {
    const units = failures.map((f) => [f.job, f.slug, f.target].filter(Boolean).join(':'))
    super(
      `Scheduled maintenance: ${failures.length} ${
        failures.length === 1 ? 'unit' : 'units'
      } failed${halted ? ', and the pass stopped early on account back-pressure' : ''} (${
        units.join(', ')
      })`,
    )
    this.name = 'MaintenanceError'
  }
}

/** A scheduled run stopped by a 429 from the account every portal shares. */
class AccountBackpressureError extends Error {
  constructor() {
    super('The platform account is refusing requests (429)')
    this.name = 'AccountBackpressureError'
  }
}

const isBackpressure = (error: unknown): boolean =>
  error instanceof AccountBackpressureError || isAccountBackpressure(error)

/**
 * The failures of one job's pass over the portals. A unit that fails is recorded against its
 * portal by its own audit and the pass moves on; only back-pressure from the shared account
 * stops it, because the next portal would only add to the pressure.
 */
class MaintenanceLedger {
  readonly failures: MaintenanceFailure[] = []
  halted = false
  /** Back-pressure seen inside the unit under way, before its audit reclassified the error. */
  private backpressure = false

  constructor(private readonly job: MaintenanceJob) {}

  /** Run one unit; true when it completed. */
  async unit(
    failure: Omit<MaintenanceFailure, 'job'>,
    run: () => Promise<unknown>,
  ): Promise<boolean> {
    this.backpressure = false
    try {
      await run()
      return true
    } catch (error) {
      this.fail(failure, error)
      return false
    }
  }

  /**
   * A unit's own work, watched for back-pressure. The audit around the unit records every
   * failure as `operation_failed`, so the cause has to be seen here, before it is rethrown.
   */
  watch<T>(work: (signal: AbortSignal) => Promise<T>): (signal: AbortSignal) => Promise<T> {
    return async (signal) => {
      try {
        return await work(signal)
      } catch (error) {
        if (isBackpressure(error)) this.backpressure = true
        throw error
      }
    }
  }

  fail(failure: Omit<MaintenanceFailure, 'job'>, error?: unknown): void {
    this.failures.push({ job: this.job, ...failure })
    if (this.backpressure || isBackpressure(error)) this.halted = true
    this.backpressure = false
  }

  /** Throw the job's failures together, once every portal has had its turn. */
  settle(): void {
    if (this.failures.length > 0) throw new MaintenanceError(this.failures, this.halted)
  }
}

/**
 * Units stop starting new work this long after they begin, so what is already under way can
 * finish inside the audited deadline (`AUDIT_TIMEOUT_MS`, 120 s). What is left waits for the
 * next pass rather than failing this one.
 */
export const MAINTENANCE_UNIT_BUDGET_MS = 75_000

const DAY_MS = 24 * 3600 * 1000

/**
 * The portals a pass visits, starting at a different one each day, so a portal late in the list
 * is not the one left out every night when a pass runs short of time.
 */
export function maintenanceOrder<T>(portals: readonly T[], now: number): T[] {
  if (portals.length === 0) return []
  const start = Math.floor(now / DAY_MS) % portals.length
  return [...portals.slice(start), ...portals.slice(0, start)]
}

/** The portal has a knowledge box to maintain (always true when bindings are not supplied). */
function hasKnowledgeBox(context: SystemJobContext | undefined, slug: string): boolean {
  if (!context?.bindings) return true
  try {
    const status = context.bindings.status(slug).status
    return status === 'connected' || status === 'demo'
  } catch {
    return false
  }
}

/** A unit's time budget, as a check its run makes before starting each piece of work. */
function unitBudget(context: SystemJobContext | undefined): () => boolean {
  const now = context?.now ?? Date.now
  const stopAt = now() + MAINTENANCE_UNIT_BUDGET_MS
  return () => now() >= stopAt
}

/** The portals a job visits, in today's order, with their configuration. */
function* scheduledPortals(
  tenants: TenantStoreApi,
  context: SystemJobContext | undefined,
  ledger: MaintenanceLedger,
): Generator<TenantConfig> {
  for (const summary of maintenanceOrder(tenants.list(), (context?.now ?? Date.now)())) {
    if (ledger.halted) return
    let config: TenantConfig | undefined
    try {
      config = tenants.get(summary.slug)
    } catch (error) {
      ledger.fail({ slug: summary.slug, target: 'portal' }, error)
      continue
    }
    if (config) yield config
  }
}
type SystemAction =
  | 'maintenance.source.sync'
  | 'maintenance.watch.run'
  | 'maintenance.enrichment.run'
  | 'maintenance.questions.run'
function scopedSystemAction<T>(
  context: SystemJobContext | undefined,
  action: SystemAction,
  slug: string,
  target: { kind: string; id: string },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!context) return run(new AbortController().signal)
  const declaration = DECLARATIONS.find((d) => d.kind === 'internal' && d.path === action)
  if (!declaration) throw new Error('Missing internal audit declaration')
  return executeAudited({
    audit: context.audit,
    localMutations: context.localMutations,
    input: {
      requestId: context.requestId,
      actor: { kind: 'system' },
      action,
      scope: { kind: 'portal', slug },
      target,
      detail: { permission: declaration.permission },
    },
    run,
  })
}

/** A typo must never silently shorten audit retention. */
export function auditRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return 400
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('AUDIT_RETENTION_DAYS must be a positive integer')
  }
  return Number(raw)
}

/** Internal jobs record intent before work and never replay side effects after audit failure. */
export async function runSystemJob(
  audit: AuditStore,
  job: MaintenanceJob,
  work: (context: SystemJobContext) => Promise<void>,
): Promise<void> {
  const requestId = crypto.randomUUID()
  const record = (outcome: 'intent' | 'success' | 'failure' | 'uncertain', count?: number) =>
    appendAudit(
      audit,
      createAuditEvent({
        requestId,
        actor: { kind: 'system' },
        action: 'maintenance.run',
        scope: { kind: 'platform' },
        target: { kind: 'maintenance', id: job },
        outcome,
        detail: outcome === 'failure' || outcome === 'uncertain'
          ? { code: 'operation_failed', ...(count === undefined ? {} : { count }) }
          : {},
      }),
    )
  record('intent')
  try {
    await work({ audit, requestId })
  } catch (error) {
    try {
      // How many units failed; each is also recorded against its own portal.
      record('failure', error instanceof MaintenanceError ? error.failures.length : undefined)
    } catch (auditError) {
      console.error('[scheduler] required failure audit could not be written')
      throw auditError
    }
    throw error
  }
  try {
    record('success')
  } catch (error) {
    // Work already completed remotely. This is an audit failure, never a rollback claim.
    console.error('[scheduler] job completed but its required completion audit failed')
    try {
      record('uncertain')
    } catch {
      console.error('[scheduler] required uncertain-outcome audit could not be written')
    }
    throw error
  }
}

interface MaintenanceStores {
  localMutations?: LocalMutationScope
  rbac: RbacState
  tenants: TenantStoreApi
  sources: SourceStoreApi
  watches: WatchStoreApi
  enrichments: EnrichmentStoreApi
  lifecycle?: PortalLifecycleStore
  bindings?: Pick<BindingStoreApi, 'status'>
  /** Answer feedback, whose expired ratings the retention pass removes. */
  feedback?: Pick<FeedbackStoreApi, 'purgeExpired'>
}

/** Remove expired answer feedback; a failure is logged and never stops the maintenance jobs. */
function purgeExpiredFeedback(feedback: MaintenanceStores['feedback']): void {
  try {
    feedback?.purgeExpired()
  } catch {
    console.error('[scheduler] expired answer feedback could not be removed')
  }
}

/**
 * One maintenance pass: each job in turn over every portal. A failing source, watch or portal is
 * recorded and passed over, and every job still runs; the failures are thrown together at the
 * end. Only a 429 from the platform account that every portal shares stops the pass early.
 */
export async function runSystemMaintenance(
  management: AragProvider,
  stores: MaintenanceStores,
  retentionDays: string | undefined,
  jobs: readonly MaintenanceJob[] = ['sync', 'watch', 'enrichment'],
  retain = true,
  options: { now?: () => number } = {},
): Promise<void> {
  const days = auditRetentionDays(retentionDays)
  const guarded = stores.lifecycle ? guardManagement(management, stores.lifecycle) : management
  // No platform exception: a background job never writes to a suspended or read-only portal.
  const sources = guardPortalWrites(stores.sources, stores.lifecycle)
  const enrichments = guardPortalWrites(stores.enrichments, stores.lifecycle)
  if (retain) stores.rbac.retainAudit(days)
  if (retain) purgeExpiredFeedback(stores.feedback)
  const failures: MaintenanceFailure[] = []
  let halted = false
  for (const job of jobs) {
    try {
      await runSystemJob(stores.rbac.audit, job, (context) => {
        context.localMutations = stores.localMutations
        context.lifecycle = stores.lifecycle
        context.bindings = stores.bindings
        context.now = options.now
        if (job === 'sync') return runAutoSyncs(guarded, stores.tenants, sources, context)
        if (job === 'watch') return runWatches(guarded, stores.tenants, stores.watches, context)
        return runAutoEnrichments(guarded, stores.tenants, enrichments, context)
      })
    } catch (error) {
      if (error instanceof MaintenanceError) {
        failures.push(...error.failures)
        halted = error.halted
      } else {
        // The job could not run at all, such as when its audit could not be written.
        failures.push({ job, target: 'job' })
      }
    }
    if (halted) break
  }
  if (failures.length > 0) throw new MaintenanceError(failures, halted)
}

// ---------------------------------------------------------------------------
// Background upkeep: re-sync registered sources (ingest pages that appeared
// since the last sync) and re-run saved-search watches so users see a
// "results changed" badge. Runs daily on the server; each source can also be
// synced on demand from Manage > Content.
// ---------------------------------------------------------------------------

/**
 * A knowledge box whose service-account token has read scope only accepts
 * every retrieval call and refuses every write with a bare 403 "Forbidden".
 * Nothing about that says "wrong token", so name it explicitly wherever an
 * ingestion write hits it.
 */
export const READ_ONLY_BOX_MESSAGE =
  'The knowledge box refused the write (HTTP 403). Its service-account token can read this ' +
  'box but not add to it, so no content can be ingested until a token with write access is ' +
  'connected.'

/** Pages discovered per crawl - deep enough to reach past already-synced ones. */
const DISCOVER_CAP = 500
/** Default new pages per sync run when a source sets no cap of its own. */
export const SYNC_CAP = 60
/** Hard ceiling on a per-source cap, so one source cannot monopolise a run. */
export const MAX_SYNC_CAP = 200

/** The pages-per-run ceiling for a source: its own cap, clamped, else the default. */
export function pagesPerRun(source: Pick<Source, 'maxPages'>): number {
  const requested = source.maxPages
  if (!requested || !Number.isFinite(requested) || requested < 1) return SYNC_CAP
  return Math.min(Math.floor(requested), MAX_SYNC_CAP)
}

/**
 * Ingest new pages from one source; reports how many were added vs left for next time.
 * `stopTaking` is checked before each page: once it returns true the run stops there, keeps what
 * it added, and leaves the remaining pages for the next sync.
 */
export async function syncSource(
  management: AragProvider,
  sources: SourceStoreApi,
  config: TenantConfig,
  source: Source,
  emit: (label: string) => void | Promise<void>,
  signal?: AbortSignal,
  stopTaking?: () => boolean,
): Promise<{ added: number; deferred: number }> {
  const perRun = pagesPerRun(source)
  const discovered = await discoverLinks(source.url, DISCOVER_CAP)
  const known = new Set(source.synced ?? [])
  const freshAll = discovered.links.filter((l) => !known.has(l))
  const fresh = freshAll.slice(0, perRun)
  await emit(
    `Found ${discovered.links.length} pages via ${discovered.source} - ${freshAll.length} new` +
      (freshAll.length > fresh.length ? ` (ingesting ${fresh.length} this run)` : ''),
  )
  let added = 0
  let rejected = 0
  let deferred = 0
  /** Pages we could not read cleanly - never guessed at, never ingested. */
  let skipped = 0
  /** The first refusal reason seen, reported once instead of per page. */
  let rejectedReason: string | undefined
  /** A hosting refusal (a limit, read-only or paused) that stopped this run. */
  let refusal: PortalLifecycleError | undefined
  for (const [i, url] of fresh.entries()) {
    signal?.throwIfAborted()
    if (stopTaking?.()) {
      deferred = fresh.length - i
      await emit(
        `Stopping this run to stay within its time limit - ` +
          `${deferred} ${deferred === 1 ? 'page' : 'pages'} left for the next sync.`,
      )
      break
    }
    try {
      // Fetch and clean the page ourselves so the index holds body content,
      // not nav chrome - and so bot walls never enter the corpus.
      let ingested = false
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': CRAWLER_USER_AGENT },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
            : AbortSignal.timeout(25_000),
        })
        if (!res.ok) {
          // A refusal (typically a bot wall answering 403) used to fall
          // through to createLink, handing the same blocked URL to the
          // platform crawler - which fails the same way and leaves an empty
          // junk resource behind. Reject it here instead.
          const body = await res.text().catch(() => '')
          rejectedReason ??= describeFetchFailure(res.status, body)
          rejected += 1
          known.add(url)
          continue
        }
        if ((res.headers.get('content-type') ?? '').includes('html')) {
          const html = await res.text()
          if (looksLikeChallengePage(html)) {
            // Checked BEFORE extraction, not only as its fallback: a
            // challenge page can carry enough prose to clear the extractor's
            // word floor and would otherwise be ingested as real content.
            rejectedReason ??= describeFetchFailure(res.status, html)
            rejected += 1
            known.add(url)
            continue
          }
          const cleaned = extractMainContent(html)
          if (cleaned) {
            signal?.throwIfAborted()
            await management.createText(config, {
              title: cleaned.title,
              body: cleaned.body,
              format: 'MARKDOWN',
              originUrl: url,
            })
            ingested = true
          }
        }
      } catch (err) {
        signal?.throwIfAborted()
        // Errors from the knowledge box are not fetch/parse failures and must
        // not be masked as "the site was awkward, skip it". Back-pressure
        // needs the outer catch's deferral, and a 401/403 means the box
        // refuses writes outright - both belong to the caller.
        if (err instanceof PortalLifecycleError) throw err
        if (err instanceof AragApiError) {
          if (err.backpressure || err.status === 401 || err.status === 403) throw err
        }
        // Our own fetch or parse failed - fall through to the skip below.
      }
      if (!ingested) {
        // This used to hand the url to the platform's own crawler
        // (createLink) as a fallback. That bypasses this function's entire
        // quality gate: the platform crawler has no bot-wall check, so on a
        // site that challenges intermittently it stores the interstitial as
        // a resource - verified live, a page titled "Just a moment..."
        // carrying Cloudflare's "Performing security verification" copy.
        // An unattended job feeding a shared corpus must not create junk it
        // cannot recognise. Skip the page instead; `known` still records it
        // so one stubborn url cannot starve every later page of the run, and
        // an administrator can still force it in from Add content > Add link.
        skipped += 1
        known.add(url)
        continue
      }
      known.add(url)
      added += 1
      if (added % 5 === 0) await emit(`Ingested ${added} of ${fresh.length} new pages…`)
    } catch (err) {
      if (err instanceof PortalLifecycleError) {
        // The portal refuses every further page the same way (its limit is reached, or it is
        // read-only or paused): stop and say so once, keeping the pages already added.
        refusal = err
        await emit(err.message)
        break
      }
      if (err instanceof AragApiError && err.backpressure) {
        // The box's ingestion queue is full. Stop this run cleanly rather
        // than hammering it for every remaining page - they stay un-synced
        // (not added to `known`) so the next scheduled or manual sync picks
        // them up once the queue has drained.
        deferred = fresh.length - i
        await emit(
          `Knowledge box is busy processing recent changes - stopping this run early. ` +
            `${deferred} ${deferred === 1 ? 'page' : 'pages'} left for the next sync.`,
        )
        break
      }
      // A 401/403 from the platform is a credential problem, not a bad page:
      // it will reject every remaining page identically. Stop and say so once,
      // rather than emitting a "skipped" line per page and finishing "complete".
      if (err instanceof AragApiError && (err.status === 401 || err.status === 403)) {
        throw new Error(READ_ONLY_BOX_MESSAGE)
      }
      await emit(`Skipped ${url} - the platform rejected it`)
    }
  }
  if (rejected > 0) {
    await emit(
      `Rejected ${rejected} unreadable ${rejected === 1 ? 'page' : 'pages'}` +
        (rejectedReason ? ` - ${rejectedReason}` : ''),
    )
  }
  if (skipped > 0) {
    await emit(
      `Skipped ${skipped} ${skipped === 1 ? 'page' : 'pages'} with no readable content - ` +
        'they were not added rather than added empty.',
    )
  }
  signal?.throwIfAborted()
  if (refusal) {
    // Keep what this run got through, so the next sync neither re-adds nor re-reads it.
    sources.update(config.slug, source.id, {
      synced: [...known].slice(-5000),
      itemCount: (source.itemCount ?? source.synced?.length ?? 0) + added,
    })
    throw refusal
  }
  sources.update(config.slug, source.id, {
    lastSync: new Date().toISOString(),
    lastAdded: added,
    synced: [...known].slice(-5000),
    itemCount: (source.itemCount ?? source.synced?.length ?? 0) + added,
    lastStatus: 'ok',
    lastError: null,
  })
  await emit(added > 0 ? `Sync complete - ${added} pages added` : 'Sync complete - nothing new')
  return { added, deferred }
}

/**
 * Record a failed sync against the source so the failure is visible in Manage
 * long after the run. Scheduled syncs have no one watching a log, and used to
 * fail completely silently - the row simply kept showing its previous, stale
 * "last synced" time with no hint that nothing had happened since.
 */
export function recordSyncFailure(
  sources: SourceStoreApi,
  slug: string,
  source: Source,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : 'The sync could not complete.'
  sources.update(slug, source.id, {
    lastSync: new Date().toISOString(),
    lastAdded: 0,
    lastStatus: 'error',
    lastError: message.slice(0, 400),
  })
  return message
}

/** Re-run every watch and flag the ones whose top results changed. */
export async function runWatches(
  management: AragProvider,
  tenants: TenantStoreApi,
  watches: WatchStoreApi,
  context?: SystemJobContext,
): Promise<void> {
  const ledger = new MaintenanceLedger('watch')
  for (const config of scheduledPortals(tenants, context, ledger)) {
    // A job never acts on a portal whose hosting state it cannot read, or that is paused.
    if (context?.lifecycle) {
      const hosting = readLifecycle(context.lifecycle, config.slug)
      if (!hosting || hosting.status === 'suspended') continue
    }
    if (!hasKnowledgeBox(context, config.slug)) continue
    let saved
    try {
      saved = watches.list(config.slug)
    } catch (error) {
      ledger.fail({ slug: config.slug, target: 'portal' }, error)
      continue
    }
    for (const watch of saved) {
      if (ledger.halted) break
      await ledger.unit(
        { slug: config.slug, target: 'watch' },
        () =>
          scopedSystemAction(
            context,
            'maintenance.watch.run',
            config.slug,
            {
              kind: 'watch',
              id: watch.id,
            },
            ledger.watch(async (signal) => {
              const results = await management.search(config, watch.query, {
                mode: 'hybrid',
                pageSize: 10,
              })
              signal.throwIfAborted()
              const fingerprint = results.resources.map((r) => r.id).sort().join('|')
              watches.update(config.slug, watch.id, {
                lastRun: new Date().toISOString(),
                fingerprint,
                // Only flag change once a baseline exists - the first run is setup.
                changed: watch.changed ||
                  (watch.fingerprint !== null && watch.fingerprint !== fingerprint),
              })
            }),
          ),
      )
    }
  }
  ledger.settle()
}

/** Merchandise up to this many still-unenriched resources per portal, per run. */
const AUTO_ENRICH_CAP = 400
/** Per-document openers written per cadence, after the merchandising pass. */
const AUTO_QUESTIONS_CAP = 150

/** Daily by default; operators may safely choose an hourly-to-monthly cadence. */
export const DEFAULT_AUTO_ENRICH_CADENCE_MS = 24 * 3600 * 1000
const MIN_AUTO_ENRICH_CADENCE_HOURS = 1
const MAX_AUTO_ENRICH_CADENCE_HOURS = 24 * 31

/** Parse AUTO_ENRICH_CADENCE_HOURS without allowing a typo to create a hot loop. */
export function autoEnrichmentCadenceMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_AUTO_ENRICH_CADENCE_MS
  const requested = Number(raw)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_AUTO_ENRICH_CADENCE_MS
  const hours = Math.min(
    Math.max(requested, MIN_AUTO_ENRICH_CADENCE_HOURS),
    MAX_AUTO_ENRICH_CADENCE_HOURS,
  )
  return hours * 3600 * 1000
}

/**
 * Work through a bounded slice of missing merchandising for every portal.
 * `runEnrichmentOverCorpus` owns the bounded strain retries and never reports
 * an outstanding zero-yield run as done; anything left stays missing and is
 * naturally selected by the next cadence.
 */
export async function runAutoEnrichments(
  management: AragProvider,
  tenants: TenantStoreApi,
  enrichments: EnrichmentStoreApi,
  context?: SystemJobContext,
): Promise<void> {
  const ledger = new MaintenanceLedger('enrichment')
  for (const config of scheduledPortals(tenants, context, ledger)) {
    // Enrichment and suggested-question generators are agents: they need an active portal
    // whose agents are enabled, and a hosting state that can be read.
    const lifecycle = context?.lifecycle
    if (lifecycle) {
      const hosting = readLifecycle(lifecycle, config.slug)
      if (!hosting || hosting.status !== 'active' || hosting.limits?.agentsEnabled === false) {
        continue
      }
    }
    // A portal with no knowledge box has nothing to enrich.
    if (!hasKnowledgeBox(context, config.slug)) continue
    // Rechecked before each model call and write, so a portal paused, made read-only or with
    // agents disabled while its run is going stops there.
    const proceed = lifecycle ? () => assertAgentRunAllowed(lifecycle, config.slug) : undefined
    let refused = false
    let nothingToDo = false
    await ledger.unit(
      { slug: config.slug, target: 'enrichment' },
      () =>
        scopedSystemAction(
          context,
          'maintenance.enrichment.run',
          config.slug,
          {
            kind: 'portal',
            id: config.slug,
          },
          ledger.watch(async (signal) => {
            let problem: Extract<EnrichmentRunEvent, { type: 'error' }> | undefined
            for await (
              const event of runEnrichmentOverCorpus(management, enrichments, config, {
                scope: 'missing',
                limit: AUTO_ENRICH_CAP,
                proceed,
                stopTaking: unitBudget(context),
              })
            ) {
              signal.throwIfAborted()
              if (event.type !== 'error') continue
              // A hosting refusal stops this portal alone; the pass itself has not failed.
              if (event.error) refused = true
              // An empty or unbound box has nothing to enrich yet.
              else if (event.reason === 'empty_catalogue' || event.reason === 'not_connected') {
                nothingToDo = true
              } else problem = event
            }
            if (problem?.reason === 'backpressure') throw new AccountBackpressureError()
            if (problem) throw new Error('Scheduled enrichment did not complete')
          }),
        ),
    )
    if (ledger.halted) break
    if (refused || nothingToDo) continue
    // Openers for the resource pages ride the same cadence, so a page never generates them on
    // demand once the pass has caught up. They do not depend on the merchandising run, so they
    // still run when it failed.
    await ledger.unit(
      { slug: config.slug, target: 'questions' },
      () =>
        scopedSystemAction(
          context,
          'maintenance.questions.run',
          config.slug,
          {
            kind: 'portal',
            id: config.slug,
          },
          ledger.watch(async (signal) => {
            for await (
              const event of runSuggestedQuestionsOverCorpus(management, enrichments, config, {
                limit: AUTO_QUESTIONS_CAP,
                proceed,
                stopTaking: unitBudget(context),
              })
            ) {
              signal.throwIfAborted()
              if (event.type !== 'error') continue
              if (event.error || event.reason === 'not_connected') return
              if (event.reason === 'backpressure') throw new AccountBackpressureError()
              throw new Error('Scheduled suggested questions did not complete')
            }
          }),
        ),
    )
  }
  ledger.settle()
}

/** Sync every auto source across all portals (daily job). */
export async function runAutoSyncs(
  management: AragProvider,
  tenants: TenantStoreApi,
  sources: SourceStoreApi,
  context?: SystemJobContext,
): Promise<void> {
  const ledger = new MaintenanceLedger('sync')
  for (const config of scheduledPortals(tenants, context, ledger)) {
    if (context?.lifecycle && readLifecycle(context.lifecycle, config.slug)?.status !== 'active') {
      continue
    }
    // Pages have nowhere to go without a knowledge box.
    if (!hasKnowledgeBox(context, config.slug)) continue
    let registered
    try {
      registered = sources.list(config.slug)
    } catch (error) {
      ledger.fail({ slug: config.slug, target: 'portal' }, error)
      continue
    }
    for (const source of registered) {
      if (!source.auto) continue
      if (ledger.halted) break
      let refused = false
      await ledger.unit(
        { slug: config.slug, target: 'source' },
        () =>
          scopedSystemAction(
            context,
            'maintenance.source.sync',
            config.slug,
            {
              kind: 'source',
              id: source.id,
            },
            ledger.watch(async (signal) => {
              try {
                await syncSource(
                  management,
                  sources,
                  config,
                  source,
                  () => {},
                  signal,
                  unitBudget(context),
                )
              } catch (err) {
                signal.throwIfAborted()
                if (err instanceof PortalLifecycleError) {
                  // The portal's hosting state (a limit reached, read-only or paused) refuses its
                  // other sources alike. Say so on the source and move on to the next portal; the
                  // pass itself has not failed.
                  refused = true
                  try {
                    recordSyncFailure(sources, config.slug, source, err)
                  } catch { /* A read-only or paused portal keeps its source record as it was. */ }
                  return
                }
                // The site is unreachable, or the box refuses writes. Record the reason against
                // the source, where Manage shows it, and fail this source's unit alone.
                try {
                  recordSyncFailure(sources, config.slug, source, err)
                } catch {
                  console.error(`[scheduler] auto-sync failure for ${config.slug} was not recorded`)
                }
                console.error(`[scheduler] auto-sync failed for ${config.slug}`)
                throw err
              }
            }),
          ),
      )
      if (refused) break
    }
  }
  ledger.settle()
}

/**
 * Start the daily upkeep timer; returns a stop function.
 *
 * `sources`, `watches` and `enrichments` must be the SAME store instances
 * buildApp uses for its HTTP routes, not fresh ones. The stores do a whole-file
 * read-modify-write on each mutation,
 * so a scheduled sync and a concurrent HTTP write against two separate
 * instances can each read the file before the other's write lands and
 * silently drop it. Sharing instances doesn't remove that race by itself,
 * but it keeps both writers serialised through one in-process object
 * instead of racing through the filesystem via two.
 */
export function startScheduler(
  management: AragProvider,
  tenants: TenantStoreApi,
  sources: SourceStoreApi,
  watches: WatchStoreApi,
  enrichments: EnrichmentStoreApi,
  rbac: RbacState,
  env: Record<string, string | undefined>,
  lifecycle?: PortalLifecycleStore,
  bindings?: Pick<BindingStoreApi, 'status'>,
): () => void {
  // The feedback files `buildApp` keeps by default, under the same DATA_DIR.
  const stores = {
    rbac,
    tenants,
    sources,
    watches,
    enrichments,
    lifecycle,
    bindings,
    feedback: new FeedbackStore(),
  }
  const runDaily = () =>
    runSystemMaintenance(management, stores, env.AUDIT_RETENTION_DAYS, ['sync', 'watch'])
  const runEnrichments = () =>
    runSystemMaintenance(management, stores, env.AUDIT_RETENTION_DAYS, ['enrichment'], false)

  // Serialise scheduled platform work. A configurable enrichment timer must
  // never overlap the daily ingest pass and recreate the contention this
  // scheduler is meant to avoid.
  let stopped = false
  let queue = Promise.resolve()
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(() => stopped ? undefined : task()).catch((error: unknown) => {
      // Keep the timer usable for its next cadence, without replaying this failed task. A
      // maintenance error names only jobs, portals and kinds of unit, never upstream detail.
      console.error(
        '[scheduler] maintenance failed; no automatic retry',
        error instanceof MaintenanceError ? error.message : '',
      )
    })
  }

  // First pass shortly after boot (machines may sleep between requests). The enrichment pass
  // runs even when the daily pass had failures.
  const boot = setTimeout(() =>
    enqueue(async () => {
      const daily = await runDaily().then(() => null, (error: unknown) => error)
      await runEnrichments()
      if (daily) throw daily
    }), 90_000)
  const daily = setInterval(() => enqueue(runDaily), 24 * 3600 * 1000)
  const cadence = autoEnrichmentCadenceMs(env.AUTO_ENRICH_CADENCE_HOURS)
  const enrichment = setInterval(() => enqueue(runEnrichments), cadence)
  return () => {
    stopped = true
    clearTimeout(boot)
    clearInterval(daily)
    clearInterval(enrichment)
  }
}
