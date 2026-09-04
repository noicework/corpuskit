import { type Context, Hono } from 'hono'
import '@cfworker/json-schema'
import {
  McpServer,
  type ServerContext,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { TenantConfig } from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import { type McpKeyRecord, type McpKeyStoreApi } from './stores.ts'
import { clientIp, rateLimit, SlidingWindowLimiter } from './rate-limit.ts'

const MCP_ROUTE = '/api/t/:slug/mcp'
const KEY_ID_BYTES = 9
const KEY_SECRET_BYTES = 32
const ACTIVE_KEY_LIMIT = 20
const DUMMY_HASH = '0'.repeat(64)
const KEY_PATTERN = /^(ck_mcp_[A-Za-z0-9_-]{12})_[A-Za-z0-9_-]{43}$/

const keyLabelSchema = z.object({ label: z.string().trim().min(1).max(80) })

const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const

export interface McpKeySummary {
  id: string
  label: string
  prefix: string
  createdAt: string
  revokedAt: string | null
}

export interface TrustedPortalUser {
  id: string
  isAdmin: boolean
}

export interface McpRoutesOptions {
  provider: RetrievalProvider
  tenant: (slug: string) => TenantConfig | undefined
  keys: McpKeyStoreApi
  trustedUser?: (request: Request) => TrustedPortalUser | null
  rateLimitPerMin?: number
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function credentialHash(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

function summary(record: McpKeyRecord): McpKeySummary {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  }
}

/** Mint a 256-bit CorpusKit credential and persist only its SHA-256 digest. */
export async function issueMcpCredential(
  keys: McpKeyStoreApi,
  tenant: string,
  issuerUserId: string,
  label: string,
  now = new Date().toISOString(),
): Promise<{ key: string; credential: McpKeySummary }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prefix = `ck_mcp_${randomToken(KEY_ID_BYTES)}`
    if (keys.findByPrefix(tenant, prefix)) continue
    const key = `${prefix}_${randomToken(KEY_SECRET_BYTES)}`
    const record: McpKeyRecord = {
      id: crypto.randomUUID(),
      tenant,
      issuerUserId,
      label: label.trim(),
      prefix,
      hash: await credentialHash(key),
      createdAt: now,
      revokedAt: null,
    }
    keys.add(record)
    return { key, credential: summary(record) }
  }
  throw new Error('Could not allocate an MCP credential identifier')
}

/** Authenticate one tenant-scoped credential. Every failure is indistinguishable to callers. */
export async function verifyMcpCredential(
  keys: McpKeyStoreApi,
  tenant: string,
  authorization: string | undefined,
): Promise<McpKeyRecord | null> {
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(authorization ?? '')?.[1]
  const match = bearer ? KEY_PATTERN.exec(bearer) : null
  if (!bearer || !match) return null

  const record = keys.findByPrefix(tenant, match[1]!)
  const suppliedHash = await credentialHash(bearer)
  const matches = constantTimeHashEqual(record?.hash ?? DUMMY_HASH, suppliedHash)
  return record && !record.revokedAt && matches ? record : null
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
  } catch {
    return toolError('The corpus could not complete this request. Please try again.')
  }
}

function createMcpServer(opts: McpRoutesOptions): {
  transport: WebStandardStreamableHTTPServerTransport
  connected: Promise<void>
} {
  const server = new McpServer({ name: 'corpuskit-knowledge-box', version: '1.0.0' })

  const tenantFor = (context: ServerContext): TenantConfig => {
    const slug = context.http?.authInfo?.extra?.tenant
    const config = typeof slug === 'string' ? opts.tenant(slug) : undefined
    if (!config) throw new Error('Unknown tenant')
    return config
  }

  server.registerTool(
    'search_corpus',
    {
      title: 'Search the corpus',
      description: 'Find relevant research documents and passages in this portal.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(2000),
        mode: z.enum(['hybrid', 'semantic', 'keyword']).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ query, mode, limit }, context) =>
      safeTool(async () => {
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
    'answer_question',
    {
      title: 'Answer from the corpus',
      description:
        'Answer a research question from this portal and return the verified citations with it.',
      inputSchema: z.object({ question: z.string().trim().min(1).max(4000) }),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: false },
    },
    ({ question }, context) =>
      safeTool(async () => {
        let answer = ''
        let refused = false
        let sources: unknown[] = []
        const citations: unknown[] = []
        let quality: Record<string, number | null> | undefined

        for await (const event of opts.provider.ask(tenantFor(context), question)) {
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
    'get_document',
    {
      title: 'Get one document',
      description: 'Fetch the portal metadata, summary and key facts for one document.',
      inputSchema: z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      }),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ id }, context) =>
      safeTool(async () => {
        const document = await opts.provider.resource(tenantFor(context), id)
        if (!document) throw new Error('Unknown document')
        return { document }
      }),
  )

  server.registerTool(
    'browse_catalogue',
    {
      title: 'Browse the catalogue',
      description: 'Browse or filter the documents available in this portal.',
      inputSchema: z.object({
        page: z.number().int().min(0).default(0),
        pageSize: z.number().int().min(1).max(50).default(20),
        query: z.string().trim().min(1).max(500).optional(),
        sort: z.enum(['created', 'modified', 'title']).default('created'),
        order: z.enum(['asc', 'desc']).default('desc'),
      }),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ page, pageSize, query, sort, order }, context) =>
      safeTool(async () => ({
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

function trustedAdmin(
  opts: McpRoutesOptions,
  context: Context,
): TrustedPortalUser | Response {
  const user = opts.trustedUser?.(context.req.raw) ?? null
  if (!user) {
    return context.json({ error: 'unauthenticated', message: 'Sign in to manage MCP keys.' }, 401)
  }
  if (!user.isAdmin) {
    return context.json({ error: 'forbidden', message: 'Administrator access is required.' }, 403)
  }
  return user
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Register role-gated key management and the authenticated Streamable HTTP endpoint. */
export function registerMcpRoutes(app: Hono, opts: McpRoutesOptions): void {
  const { transport, connected } = createMcpServer(opts)
  const limiter = new SlidingWindowLimiter({
    limit: opts.rateLimitPerMin ?? 60,
    windowMs: 60_000,
  })
  const authRateLimit = rateLimit(
    limiter,
    (context) => context.req.header('cf-connecting-ip') ?? clientIp(context),
  )

  app.get('/api/t/:slug/mcp/keys', (context) => {
    const user = trustedAdmin(opts, context)
    if (user instanceof Response) return user
    const config = opts.tenant(context.req.param('slug'))
    if (!config) return context.json({ error: 'unknown_tenant' }, 404)
    context.header('cache-control', 'no-store')
    return context.json(opts.keys.list(config.slug).map(summary))
  })

  app.post('/api/t/:slug/mcp/keys', async (context) => {
    const user = trustedAdmin(opts, context)
    if (user instanceof Response) return user
    const config = opts.tenant(context.req.param('slug'))
    if (!config) return context.json({ error: 'unknown_tenant' }, 404)
    const parsed = keyLabelSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ error: 'invalid_request' }, 400)
    const active = opts.keys.list(config.slug).filter((record) => !record.revokedAt).length
    if (active >= ACTIVE_KEY_LIMIT) {
      return context.json({
        error: 'key_limit_reached',
        message: 'Revoke an unused MCP key before creating another.',
      }, 409)
    }
    const issued = await issueMcpCredential(
      opts.keys,
      config.slug,
      user.id,
      parsed.data.label,
    )
    context.header('cache-control', 'no-store')
    return context.json(issued, 201)
  })

  app.delete('/api/t/:slug/mcp/keys/:id', (context) => {
    const user = trustedAdmin(opts, context)
    if (user instanceof Response) return user
    const config = opts.tenant(context.req.param('slug'))
    if (!config) return context.json({ error: 'unknown_tenant' }, 404)
    const revoked = opts.keys.revoke(
      config.slug,
      context.req.param('id'),
      new Date().toISOString(),
    )
    if (!revoked) return context.json({ error: 'unknown_key' }, 404)
    context.header('cache-control', 'no-store')
    return context.json({ ok: true })
  })

  app.all(MCP_ROUTE, authRateLimit, async (context) => {
    const slug = context.req.param('slug')
    const credential = await verifyMcpCredential(
      opts.keys,
      slug,
      context.req.header('authorization'),
    )
    if (!credential) {
      context.header('www-authenticate', 'Bearer realm="CorpusKit MCP"')
      context.header('cache-control', 'no-store')
      return context.json({ error: 'unauthorised' }, 401)
    }
    if (context.req.method !== 'POST') {
      context.header('allow', 'POST')
      context.header('cache-control', 'no-store')
      return context.json({ error: 'method_not_allowed' }, 405)
    }
    if (!opts.tenant(slug)) return context.json({ error: 'unknown_tenant' }, 404)

    await connected
    return withNoStore(
      await transport.handleRequest(context.req.raw, {
        authInfo: {
          token: 'credential-verified',
          clientId: credential.issuerUserId,
          scopes: ['corpus:read'],
          extra: { tenant: slug },
        },
      }),
    )
  })
}
