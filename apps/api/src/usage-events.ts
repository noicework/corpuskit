import { z } from 'zod'
import type { Context, MiddlewareHandler } from 'hono'
import type { TenantConfig } from '@research-portal/core'
import type { AuditActor } from './audit.ts'
import type { LocalMutationScope } from './audit-execution.ts'
import type { InsightRecord, InsightsStoreApi } from './stores.ts'
import { admitAll, rateLimited, SlidingWindowLimiter } from './rate-limit.ts'

const Identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
/** Exactly one source id, no reader identity or free text. */
export const OpenEventSchema = z.object({
  answerId: Identifier.optional(),
  searchId: Identifier.optional(),
  resourceId: Identifier,
  rank: z.number().int().min(1).max(1000),
}).strict().refine((v) => Boolean(v.answerId) !== Boolean(v.searchId))

export interface UsageAnalyticsOptions {
  insights: InsightsStoreApi
  tenant: (slug: string) => TenantConfig | undefined
  context: (c: Context) => { requestId: string; actor?: AuditActor }
  address: (c: Context) => string
  localMutations?: LocalMutationScope
  now?: () => number
}

/** Read at most 1 KiB, including a chunked body without Content-Length. */
async function openBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 1024 || !request.body) {
    throw new Error('invalid_body')
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024) {
        await reader.cancel().catch(() => {})
        throw new Error('invalid_body')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/** Anonymous events use the same audited log and erasure boundary as asks. */
export function usageAnalytics(options: UsageAnalyticsOptions) {
  const now = options.now ?? Date.now
  const received = new WeakMap<Request, number>()
  const limiter = new SlidingWindowLimiter({ limit: 60, windowMs: 60_000, now })
  const portalLimiter = new SlidingWindowLimiter({ limit: 600, windowMs: 60_000, now })
  const record = async (c: Context, slug: string, value: InsightRecord) => {
    const work = () => options.insights.record(slug, value)
    if (!options.localMutations) return work()
    const context = options.context(c)
    await options.localMutations.run(
      {
        requestId: context.requestId,
        actor: context.actor ?? { kind: 'anonymous' },
        action: 'local.mutation',
        scope: { kind: 'portal', slug },
        target: { kind: 'request' },
        detail: { permission: 'portal.read', operation: `${c.req.method} ${c.req.routePath}` },
      },
      c.req.raw.signal,
      work,
    )
  }
  const receive: MiddlewareHandler = async (c, next) => {
    received.set(c.req.raw, performance.now())
    await next()
  }
  const search: MiddlewareHandler = async (c, next) => {
    const start = received.get(c.req.raw) ?? performance.now()
    await next()
    const config = options.tenant(c.req.param('slug')!)
    if (
      c.req.method !== 'GET' || c.res.status !== 200 || !config || config.analyticsEnabled === false
    ) return
    const result = await c.res.clone().json()
    const id = crypto.randomUUID()
    const response = c.json({ ...result, searchId: id })
    await record(c, config.slug, {
      kind: 'search',
      ts: new Date(now()).toISOString(),
      id,
      durationSec: (performance.now() - start) / 1000,
      resources: result.resources.slice(0, 1000).map((r: { id: string }, i: number) => ({
        resourceId: r.id,
        rank: i + 1,
      })),
    })
    c.res = response
  }
  const open = async (c: Context) => {
    const config = options.tenant(c.req.param('slug')!)
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (config.analyticsEnabled === false) return c.body(null, 204)
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ error: 'invalid_request' }, 403)
    }
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return c.json({ error: 'invalid_request' }, 415)
    }
    const verdict = admitAll([
      { limiter, key: `${config.slug}:${options.address(c)}` },
      { limiter: portalLimiter, key: config.slug },
    ])
    if (!verdict.allowed) return rateLimited(c, verdict.retryAfterSec)
    let body: unknown
    try {
      body = await openBody(c.req.raw)
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const parsed = OpenEventSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const { answerId, searchId, resourceId, rank } = parsed.data
    const at = now()
    const from = at - 24 * 3600 * 1000
    // A beacon can only name a source this portal actually returned in the last day.
    const resources = answerId
      ? options.insights.asksBetween(config.slug, from, at + 1).asks
        .find((a) => a.answerId === answerId)?.citedResources
      : options.insights.eventsBetween(config.slug, from, at + 1).events
        .find((e) => e.kind === 'search' && e.id === searchId)
    const entries = Array.isArray(resources)
      ? resources
      : resources?.kind === 'search'
      ? resources.resources
      : undefined
    if (!entries?.some((r) => r.resourceId === resourceId && r.rank === rank)) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    await record(c, config.slug, {
      kind: 'open',
      ts: new Date(at).toISOString(),
      source: answerId ? 'answer' : 'search',
      sourceId: (answerId ?? searchId)!,
      resourceId,
      rank,
    })
    return c.body(null, 204)
  }
  return { receive, search, open }
}

/** Captures only final public citations; all reported attempts contribute to token consumption. */
export function answerUsageTracker(enabled: boolean) {
  const answerId = crypto.randomUUID()
  const sources = new Map<string, import('@research-portal/core').ScoredResource>()
  const citations = new Map<number, import('./stores.ts').CitedUsageResource>()
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  return {
    consume(event: Extract<import('@research-portal/core').AskEvent, { type: 'usage' }>) {
      if (event.tokensReported !== false) {
        inputTokens = (inputTokens ?? 0) + event.inputTokens
        outputTokens = (outputTokens ?? 0) + event.outputTokens
      }
    },
    observe(value: unknown): unknown {
      const event = value as import('@research-portal/core').AskEvent
      if (event.type === 'sources') {
        for (const resource of event.resources) sources.set(resource.id, resource)
      }
      if (event.type === 'fallback') citations.clear()
      if (event.type === 'citation') {
        citations.set(event.citation.index, {
          resourceId: event.citation.resourceId,
          rank: event.citation.index,
          topicIds: sources.get(event.citation.resourceId)?.topicIds ?? [],
        })
      }
      return event.type === 'done' && enabled ? { ...event, answerId } : value
    },
    snapshot() {
      return {
        answerId,
        citedResources: [...citations.values()],
        ...(inputTokens !== undefined ? { inputTokens, outputTokens } : {}),
      }
    },
  }
}
