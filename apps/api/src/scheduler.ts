import type { TenantConfig } from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'
import {
  CRAWLER_USER_AGENT,
  describeFetchFailure,
  discoverLinks,
  extractMainContent,
  looksLikeChallengePage,
} from './crawl.ts'
import { type Source, type SourceStoreApi, type WatchStoreApi } from './stores.ts'
import { type EnrichmentStoreApi, runEnrichmentOverCorpus } from './enrichments.ts'
import type { TenantStoreApi } from './tenants.ts'

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

/** Ingest new pages from one source; reports how many were added vs left for next time. */
export async function syncSource(
  management: AragProvider,
  sources: SourceStoreApi,
  config: TenantConfig,
  source: Source,
  emit: (label: string) => void | Promise<void>,
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
  for (const [i, url] of fresh.entries()) {
    try {
      // Fetch and clean the page ourselves so the index holds body content,
      // not nav chrome - and so bot walls never enter the corpus.
      let ingested = false
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': CRAWLER_USER_AGENT },
          signal: AbortSignal.timeout(25_000),
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
        // Errors from the knowledge box are not fetch/parse failures and must
        // not be masked as "the site was awkward, skip it". Back-pressure
        // needs the outer catch's deferral, and a 401/403 means the box
        // refuses writes outright - both belong to the caller.
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
): Promise<void> {
  for (const summary of tenants.list()) {
    const config = tenants.get(summary.slug)
    if (!config) continue
    for (const watch of watches.list(config.slug)) {
      try {
        const results = await management.search(config, watch.query, {
          mode: 'hybrid',
          pageSize: 10,
        })
        const fingerprint = results.resources.map((r) => r.id).sort().join('|')
        watches.update(config.slug, watch.id, {
          lastRun: new Date().toISOString(),
          fingerprint,
          // Only flag change once a baseline exists - the first run is setup.
          changed: watch.changed ||
            (watch.fingerprint !== null && watch.fingerprint !== fingerprint),
        })
      } catch {
        // box offline or rebinding - try again next cycle
      }
    }
  }
}

/** Merchandise up to this many still-unenriched resources per portal, per run. */
const AUTO_ENRICH_CAP = 400

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
): Promise<void> {
  for (const summary of tenants.list()) {
    const config = tenants.get(summary.slug)
    if (!config) continue
    try {
      let problem: string | undefined
      for await (
        const event of runEnrichmentOverCorpus(management, enrichments, config, {
          scope: 'missing',
          limit: AUTO_ENRICH_CAP,
        })
      ) {
        if (event.type === 'error') problem = event.message
      }
      if (problem) {
        console.warn(`[scheduler] auto-enrichment paused for ${config.slug}: ${problem}`)
        // Tenants share the platform account. Once one box says it is
        // strained, moving straight to the next box would only transfer the
        // pressure; leave every remaining portal for the next cadence.
        return
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      console.error(`[scheduler] auto-enrichment failed for ${config.slug}: ${message}`)
    }
  }
}

/** Sync every auto source across all portals (daily job). */
export async function runAutoSyncs(
  management: AragProvider,
  tenants: TenantStoreApi,
  sources: SourceStoreApi,
): Promise<void> {
  for (const summary of tenants.list()) {
    const config = tenants.get(summary.slug)
    if (!config) continue
    for (const source of sources.list(config.slug)) {
      if (!source.auto) continue
      try {
        await syncSource(management, sources, config, source, () => {})
      } catch (err) {
        // The site is unreachable, or the box refuses writes. Either way the
        // run is over for this source - but record WHY against the source so
        // an administrator can see it in Manage, then carry on with the rest.
        const message = recordSyncFailure(sources, config.slug, source, err)
        console.error(`[scheduler] auto-sync failed for ${config.slug} ${source.url}: ${message}`)
      }
    }
  }
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
): () => void {
  const runDaily = async () => {
    await runAutoSyncs(management, tenants, sources).catch(() => {})
    await runWatches(management, tenants, watches).catch(() => {})
  }
  const runEnrichments = () => runAutoEnrichments(management, tenants, enrichments)

  // Serialise scheduled platform work. A configurable enrichment timer must
  // never overlap the daily ingest pass and recreate the contention this
  // scheduler is meant to avoid.
  let stopped = false
  let queue = Promise.resolve()
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(() => stopped ? undefined : task()).catch(() => {})
  }

  // First pass shortly after boot (machines may sleep between requests).
  const boot = setTimeout(() =>
    enqueue(async () => {
      await runDaily()
      await runEnrichments()
    }), 90_000)
  const daily = setInterval(() => enqueue(runDaily), 24 * 3600 * 1000)
  const cadence = autoEnrichmentCadenceMs(Deno.env.get('AUTO_ENRICH_CADENCE_HOURS'))
  const enrichment = setInterval(() => enqueue(runEnrichments), cadence)
  return () => {
    stopped = true
    clearTimeout(boot)
    clearInterval(daily)
    clearInterval(enrichment)
  }
}
