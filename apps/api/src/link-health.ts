import type { RetrievalProvider } from '@research-portal/retrieval'
import type { TenantConfig } from '@research-portal/core'
import { publicHttp, type PublicHttpClient, UnsafeUrlError } from './public-http.ts'

export type LinkStatus = 'ok' | 'broken' | 'restricted' | 'temporary' | 'timeout' | 'blocked'
export interface LinkTarget {
  url: string
  resourceId?: string
  sourceId?: string
  title: string
}
export interface LinkCheck extends LinkTarget {
  id: string
  status: LinkStatus
  httpStatus?: number
  firstFailed: string | null
  lastChecked: string
  attempts: number
  ignored: boolean
}
export interface LinkHealthStoreApi {
  list(slug: string): LinkCheck[]
  put(slug: string, entry: LinkCheck): void
  remove(slug: string, id: string): void
  erase(slug: string): number
}

export function classifyLink(status: number): LinkStatus {
  if (status >= 200 && status < 400) return 'ok'
  if (status === 404 || status === 410) return 'broken'
  if (status === 401 || status === 403) return 'restricted'
  return 'temporary'
}

export async function checkLink(
  target: LinkTarget,
  previous?: LinkCheck,
  client: PublicHttpClient = publicHttp,
  signal?: AbortSignal,
): Promise<LinkCheck> {
  let status: LinkStatus
  let httpStatus: number | undefined
  try {
    let response = await client.request(target.url, { method: 'HEAD', signal })
    if ([400, 403, 405, 501].includes(response.status)) {
      await response.body?.cancel()
      response = await client.request(target.url, { method: 'GET', signal })
    }
    httpStatus = response.status
    status = classifyLink(httpStatus)
    await response.body?.cancel()
  } catch (error) {
    signal?.throwIfAborted()
    status = error instanceof UnsafeUrlError
      ? 'blocked'
      : error instanceof Error && /timeout|abort/i.test(error.name)
      ? 'timeout'
      : 'temporary'
  }
  const now = new Date().toISOString()
  return {
    ...target,
    id: previous?.id ?? crypto.randomUUID(),
    status,
    ...(httpStatus ? { httpStatus } : {}),
    firstFailed: status === 'ok' ? null : previous?.firstFailed ?? now,
    lastChecked: now,
    attempts: (previous?.attempts ?? 0) + 1,
    ignored: previous?.ignored ?? false,
  }
}

export async function linkTargets(
  provider: RetrievalProvider,
  config: TenantConfig,
  sources: { list(slug: string): { id: string; url: string }[] },
  signal?: AbortSignal,
): Promise<LinkTarget[]> {
  const resources = await provider.listResources(config, { includeHidden: true, signal })
  return [
    ...sources.list(config.slug).map((s) => ({
      url: s.url,
      sourceId: s.id,
      title: 'Website source',
    })),
    ...resources.filter((r) => r.originUrl).map((r) => ({
      url: r.originUrl!,
      resourceId: r.id,
      title: r.title,
    })),
  ]
}
const sameTarget = (a: LinkTarget, b: LinkTarget) =>
  a.url === b.url && a.resourceId === b.resourceId && a.sourceId === b.sourceId

/** Oldest checks first; ignored decisions survive later checks and process restarts. */
export async function runLinkChecks(
  store: LinkHealthStoreApi,
  slug: string,
  targets: LinkTarget[],
  signal?: AbortSignal,
  client: PublicHttpClient = publicHttp,
  stopTaking: () => boolean = () => false,
): Promise<{ checked: number; failed: number; deferred: number }> {
  const targetKey = (target: LinkTarget) =>
    JSON.stringify([target.url, target.resourceId, target.sourceId])
  const targetKeys = new Set(targets.map(targetKey))
  const previousRows = store.list(slug)
  const claimed = new Set(
    previousRows.filter((row) => targetKeys.has(targetKey(row))).map(targetKey),
  )
  const saved: LinkCheck[] = []
  for (const row of previousRows) {
    signal?.throwIfAborted()
    if (targetKeys.has(targetKey(row))) {
      saved.push(row)
      continue
    }
    // Clean-text refresh replaces resource ids. Keep the URL's review and ignore decision.
    const replacement = targets.find((target) =>
      target.url === row.url && !claimed.has(targetKey(target)) &&
      (row.resourceId ? target.resourceId : row.sourceId ? target.sourceId : true)
    )
    if (replacement) {
      const next = {
        ...row,
        ...replacement,
        resourceId: replacement.resourceId,
        sourceId: replacement.sourceId,
      }
      store.put(slug, next)
      claimed.add(targetKey(replacement))
      saved.push(next)
    } else if (row.ignored) {
      const next = { ...row, resourceId: undefined, sourceId: undefined }
      if (row.resourceId || row.sourceId) store.put(slug, next)
      saved.push(next)
    } else store.remove(slug, row.id)
  }
  const pending = targets.map((target) => ({
    target,
    previous: saved.find((row) => sameTarget(row, target)),
  })).filter(({ previous }) => !previous?.ignored).sort((a, b) =>
    (a.previous?.lastChecked ?? '').localeCompare(b.previous?.lastChecked ?? '')
  )
  const deadline = Date.now() + 65_000
  let checked = 0, failed = 0
  for (const { target, previous } of pending.slice(0, 100)) {
    signal?.throwIfAborted()
    if (stopTaking() || Date.now() >= deadline) break
    const result = await checkLink(target, previous, client, signal)
    signal?.throwIfAborted()
    store.put(slug, result)
    checked++
    if (result.status !== 'ok') failed++
  }
  return { checked, failed, deferred: pending.length - checked }
}
