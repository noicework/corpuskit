import {
  type Declaration,
  DECLARATIONS,
  declaredRoute,
  declaredTool,
  infrastructureHandler,
  isPrivileged,
} from './permissions.ts'
import {
  AuthorisationError,
  authoriseOperation,
  type AuthorityDependencies,
  type RequestAuthority,
} from './authorisation.ts'
import {
  inspectScopedKeys,
  issueScopedKey,
  ScopedKeyError,
  type ScopedKeySummary,
} from './scoped-keys.ts'
import {
  appendAudit,
  type AuditActor,
  type AuditStore,
  AuditWriteError,
  createAuditEvent,
} from './audit.ts'
import {
  executeAudited,
  type LocalMutationScope,
  materialisedJsonResponse,
  stageAuditResponse,
} from './audit-execution.ts'
import type { PortalRequestContext } from './app.ts'
import { type Context, Hono } from 'hono'
import '@cfworker/json-schema'
import {
  McpServer,
  type ServerContext,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { PORTAL_ROLES, type TenantConfig } from '@research-portal/core'
import { AragApiError, type RetrievalProvider } from '@research-portal/retrieval'
import { type McpKeyStoreApi } from './stores.ts'
import { clientIp, rateLimit, SlidingWindowLimiter } from './rate-limit.ts'

const MCP_ROUTE = '/api/t/:slug/mcp'
const keyLabelSchema = z.object({
  label: z.string().trim().min(1).max(80).refine((value) =>
    [...value].every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  ),
  role: z.enum(PORTAL_ROLES),
  expiresAt: z.string().optional(),
}).strict()

const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const

export interface McpRoutesOptions {
  localMutations?: LocalMutationScope
  provider: RetrievalProvider
  tenant: (slug: string) => TenantConfig | undefined
  keys: McpKeyStoreApi
  authorityDependencies?: AuthorityDependencies
  authorise?: (context: Context) => Promise<RequestAuthority | null>
  rateLimitPerMin?: number
  audit?: AuditStore
  requestContext?: (request: Request) => PortalRequestContext
}

interface McpAuditContext {
  requestId: string
  actor: AuditActor
  slug: string
  signal?: AbortSignal
  mandatoryFailure?: AuditWriteError
}

/** Shared wrapper also covers future privileged tools declared in the sole catalogue. */
export async function executeMcpTool(
  declaration: Declaration,
  context: McpAuditContext,
  audit: AuditStore | undefined,
  call: (signal?: AbortSignal) => Promise<Record<string, unknown>>,
  localMutations?: LocalMutationScope,
): Promise<Record<string, unknown>> {
  const input = {
    requestId: context.requestId,
    actor: context.actor,
    scope: { kind: 'portal' as const, slug: context.slug },
    target: { kind: 'tool', id: declaration.path },
    detail: {
      ...(declaration.permission ? { permission: declaration.permission } : {}),
      operation: `MCP ${declaration.path}`,
    },
  }
  const invoke = async (signal = context.signal) => {
    try {
      signal?.throwIfAborted()
      const result = await call(signal)
      signal?.throwIfAborted()
      return result
    } catch (error) {
      if (
        error instanceof AuthorisationError ||
        (error instanceof AragApiError && (error.status === 401 || error.status === 403))
      ) {
        if (!audit) throw new AuditWriteError()
        appendAudit(
          audit,
          createAuditEvent({
            ...input,
            action: 'request.denied',
            outcome: 'denied',
            detail: {
              ...(declaration.permission ? { permission: declaration.permission } : {}),
              code: error.status === 401 ? 'unauthorised' : 'forbidden',
            },
          }),
        )
      }
      throw error
    }
  }
  try {
    if (!isPrivileged(declaration, context.actor)) return await invoke()
    if (!audit) throw new AuditWriteError()
    const execution = await executeAudited({
      audit,
      localMutations,
      signal: context.signal,
      input: { ...input, action: 'request.privileged' },
      run: async (signal) => {
        try {
          const result = await invoke(signal)
          const staged = await stageAuditResponse(materialisedJsonResponse(result), signal)
          return { result, outcome: staged.outcome, error: undefined }
        } catch (error) {
          if (
            error instanceof AuthorisationError ||
            (error instanceof AragApiError && (error.status === 401 || error.status === 403))
          ) {
            return { result: undefined, outcome: 'denied' as const, error }
          }
          throw error
        }
      },
      classify: (result) => result.outcome,
    })
    if (execution.error) throw execution.error
    return execution.result!
  } catch (error) {
    if (error instanceof AuditWriteError) context.mandatoryFailure = error
    throw error
  }
}

function hashBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) return new Uint8Array(32)
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** Compare fixed-length credential digests without revealing the first mismatch. */
export function constantTimeHashEqual(left: string, right: string): boolean {
  const a = hashBytes(left)
  const b = hashBytes(right)
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!
  return difference === 0 && /^[0-9a-f]{64}$/.test(left) && /^[0-9a-f]{64}$/.test(right)
}

function jsonResult(value: Record<string, unknown>) {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  }
}

async function safeTool(call: () => Promise<Record<string, unknown>>) {
  try {
    return jsonResult(await call())
  } catch (error) {
    if (error instanceof AuditWriteError) throw error
    return toolError('The corpus could not complete this request. Please try again.')
  }
}

export function createMcpServer(opts: McpRoutesOptions): {
  transport: WebStandardStreamableHTTPServerTransport
  connected: Promise<void>
} {
  const server = new McpServer({ name: 'corpuskit-knowledge-box', version: '1.0.0' })
  const auditedTool = (
    name: string,
    context: ServerContext,
    call: (signal?: AbortSignal) => Promise<Record<string, unknown>>,
  ) => {
    const declaration = DECLARATIONS.find((d) => d.kind === 'mcp' && d.path === name)
    const auditContext = context.http?.authInfo?.extra?.auditContext as McpAuditContext | undefined
    return safeTool(async () => {
      try {
        const authority = context.http?.authInfo?.extra?.authority as RequestAuthority | undefined
        const slug = context.http?.authInfo?.extra?.slug
        if (
          !declaration || !auditContext || !authority || typeof slug !== 'string' ||
          slug !== auditContext.slug || !opts.authorityDependencies ||
          declaration.scope !== 'portal'
        ) {
          throw new AuditWriteError()
        }
        const config = opts.tenant(slug)
        authoriseOperation(authority, declaration.permission, { kind: 'portal', slug }, {
          slug,
          accessMode: config?.accessMode,
          configuredTenantId: opts.authorityDependencies.configuredTenantId,
        })
        return await executeMcpTool(
          declaration,
          auditContext,
          opts.audit,
          call,
          opts.localMutations,
        )
      } catch (error) {
        if (auditContext && error instanceof AuditWriteError) auditContext.mandatoryFailure = error
        throw error
      }
    })
  }

  const tenantFor = (context: ServerContext): TenantConfig => {
    const slug = context.http?.authInfo?.extra?.slug
    const config = typeof slug === 'string' ? opts.tenant(slug) : undefined
    if (!config) throw new Error('Unknown tenant')
    return config
  }

  server.registerTool(
    declaredTool('search_corpus'),
    {
      title: 'Search the corpus',
      description: 'Find relevant research documents and passages in this portal.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(2000),
        mode: z.enum(['hybrid', 'semantic', 'keyword']).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }).strict(),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ query, mode, limit }, context) =>
      auditedTool('search_corpus', context, async () => {
        const result = await opts.provider.search(tenantFor(context), query, {
          mode,
          pageSize: limit,
        })
        return {
          query: result.query,
          resources: result.resources.slice(0, limit),
          relatedQuestions: result.relatedQuestions,
        }
      }),
  )

  server.registerTool(
    declaredTool('answer_question'),
    {
      title: 'Answer from the corpus',
      description:
        'Answer a research question from this portal and return the verified citations with it.',
      inputSchema: z.object({ question: z.string().trim().min(1).max(4000) }).strict(),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: false },
    },
    ({ question }, context) =>
      auditedTool('answer_question', context, async (signal) => {
        let answer = ''
        let refused = false
        let sources: unknown[] = []
        const citations: unknown[] = []
        let quality: Record<string, number | null> | undefined

        for await (const event of opts.provider.ask(tenantFor(context), question)) {
          signal?.throwIfAborted()
          if (event.type === 'delta') answer += event.text
          else if (event.type === 'sources') sources = event.resources
          else if (event.type === 'citation') citations.push(event.citation)
          else if (event.type === 'quality') {
            quality = {
              answerRelevance: event.answerRelevance,
              groundedness: event.groundedness,
              contextRelevance: event.contextRelevance,
            }
          } else if (event.type === 'done') {
            if (event.text) answer = event.text
            refused = event.refused === true
          } else if (event.type === 'error') {
            throw new Error('Answer failed')
          }
        }

        if (!refused && citations.length === 0) {
          throw new Error('Answer had no verified citations')
        }
        return {
          answer,
          refused,
          citations,
          sources,
          ...(quality ? { quality } : {}),
        }
      }),
  )

  server.registerTool(
    declaredTool('get_document'),
    {
      title: 'Get one document',
      description: 'Fetch the portal metadata, summary and key facts for one document.',
      inputSchema: z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      }).strict(),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ id }, context) =>
      auditedTool('get_document', context, async () => {
        const document = await opts.provider.resource(tenantFor(context), id)
        if (!document || document.id !== id) throw new AuthorisationError(403)
        return { document }
      }),
  )

  server.registerTool(
    declaredTool('browse_catalogue'),
    {
      title: 'Browse the catalogue',
      description: 'Browse or filter the documents available in this portal.',
      inputSchema: z.object({
        page: z.number().int().min(0).default(0),
        pageSize: z.number().int().min(1).max(50).default(20),
        query: z.string().trim().min(1).max(500).optional(),
        sort: z.enum(['created', 'modified', 'title']).default('created'),
        order: z.enum(['asc', 'desc']).default('desc'),
      }).strict(),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ page, pageSize, query, sort, order }, context) =>
      auditedTool('browse_catalogue', context, async () => ({
        catalogue: await opts.provider.catalog(tenantFor(context), {
          page,
          pageSize,
          query,
          sortField: sort,
          sortOrder: order,
        }),
      })),
  )

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  return { transport, connected: server.connect(transport) }
}

function keySummary(record: ScopedKeySummary) {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    role: record.role,
    expiresAt: record.expiresAt,
    status: record.status,
    effectiveRole: record.effectiveRole,
  }
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'private, no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Register role-gated key management and the authenticated Streamable HTTP endpoint. */
export function registerMcpRoutes(app: Hono, opts: McpRoutesOptions): void {
  const limiter = new SlidingWindowLimiter({
    limit: opts.rateLimitPerMin ?? 60,
    windowMs: 60_000,
  })
  const authRateLimit = rateLimit(
    limiter,
    (context) => context.req.header('cf-connecting-ip') ?? clientIp(context),
  )

  const authority = async (context: Context) => {
    if (!opts.authorise || !opts.authorityDependencies) throw new AuthorisationError(403)
    const selected = await opts.authorise(context)
    if (!selected) throw new AuthorisationError(403)
    return selected
  }

  app.get(declaredRoute('GET', '/api/t/:slug/mcp/keys'), async (context) => {
    await authority(context)
    const config = opts.tenant(context.req.param('slug'))
    if (!config) return context.json({ error: 'unknown_tenant' }, 404)
    return context.json(
      (await inspectScopedKeys(config.slug, opts.authorityDependencies!)).map(keySummary),
    )
  })

  app.post(declaredRoute('POST', '/api/t/:slug/mcp/keys'), async (context) => {
    const selected = await authority(context)
    if (selected.kind === 'key' || !selected.provenanceSession) throw new AuthorisationError(403)
    const config = opts.tenant(context.req.param('slug'))
    if (!config) return context.json({ error: 'unknown_tenant' }, 404)
    const parsed = keyLabelSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const issued = await issueScopedKey(
        { slug: config.slug, ...parsed.data },
        selected.provenanceSession,
        opts.authorityDependencies!,
      )
      issued.commit()
      return context.json({ key: issued.key, credential: keySummary(issued.credential) }, 201)
    } catch (error) {
      if (!(error instanceof ScopedKeyError)) throw error
      if (error.code === 'forbidden') throw new AuthorisationError(403)
      if (error.code === 'invalid_input') return context.json({ error: 'invalid_request' }, 400)
      if (error.code === 'key_limit') return context.json({ error: 'key_limit_reached' }, 409)
      throw error
    }
  })

  app.delete(declaredRoute('DELETE', '/api/t/:slug/mcp/keys/:id'), async (context) => {
    await authority(context)
    const config = opts.tenant(context.req.param('slug'))
    if (!config) return context.json({ error: 'unknown_tenant' }, 404)
    const existing = opts.keys.list(config.slug).find((key) => key.id === context.req.param('id'))
    if (!existing) return context.json({ error: 'unknown_key' }, 404)
    if (existing.revokedAt) return context.json({ ok: true })
    const revoked = opts.keys.revoke(
      config.slug,
      context.req.param('id'),
      new Date((opts.authorityDependencies!.now ?? Date.now)()).toISOString(),
    )
    if (!revoked) return context.json({ error: 'unknown_key' }, 404)
    return context.json({ ok: true })
  })

  app.all(
    declaredRoute('ALL', MCP_ROUTE),
    infrastructureHandler(authRateLimit),
    async (context) => {
      const slug = context.req.param('slug')
      const request = opts.requestContext?.(context.req.raw)
      context.header('www-authenticate', 'Bearer realm="CorpusKit MCP"')
      const selected = await authority(context)
      const actor = selected.actor
      if (request) request.actor = actor
      if (context.req.method !== 'POST') {
        context.header('allow', 'POST')
        return context.json({ error: 'method_not_allowed' }, 405)
      }
      if (!opts.tenant(slug)) return context.json({ error: 'unknown_tenant' }, 404)

      // The pinned SDK indexes pending streams by JSON-RPC id. Isolate stateless
      // requests so different callers may safely reuse the same client-chosen id.
      const { transport, connected } = createMcpServer(opts)
      await connected
      const auditContext: McpAuditContext = {
        requestId: request?.requestId ?? crypto.randomUUID(),
        actor,
        slug,
        signal: context.req.raw.signal,
      }
      try {
        const response = await transport.handleRequest(context.req.raw, {
          authInfo: {
            token: 'credential-verified',
            clientId: selected.kind === 'key' ? selected.id : selected.actor.id ?? 'anonymous',
            scopes: [],
            extra: { slug, authority: selected, auditContext },
          },
        })
        // The SDK converts callback exceptions into protocol errors; required audit errors remain HTTP failures.
        if (auditContext.mandatoryFailure) throw auditContext.mandatoryFailure
        return withNoStore(response)
      } finally {
        await transport.close()
      }
    },
  )
}
