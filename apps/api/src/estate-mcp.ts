import type { Context, Hono } from 'hono'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { TenantConfig } from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import type { PortalRequestContext } from './app.ts'
import { AuthorisationError, keyPortalRoles, type RequestAuthority } from './authorisation.ts'
import { appendAudit, type AuditStore, AuditWriteError, createAuditEvent } from './audit.ts'
import { PortalLifecycleError } from './lifecycle-error.ts'
import { collectVerifiedAnswer, safeTool, UnverifiedAnswerError, withNoStore } from './mcp.ts'
import {
  type Declaration,
  DECLARATIONS,
  declaredRoute,
  declaredTool,
  ESTATE_MCP_ROUTE,
} from './permissions.ts'
import { MAX_ESTATE_PORTALS } from './scoped-key-record.ts'

/** How long one portal may take to search or answer before it is named as a failed source. */
export const DEFAULT_ESTATE_SOURCE_TIMEOUT_MS = 25_000

/** Why one portal is missing from an estate result. */
export type EstateFailure = 'timeout' | 'upstream' | 'unavailable' | 'unverified'
/** The recorded code for each failure, from the audit log's fixed vocabulary. */
const FAILURE_CODES = {
  timeout: 'deadline_exceeded',
  upstream: 'operation_failed',
  unavailable: 'unavailable',
  unverified: 'operation_failed',
} as const satisfies Record<EstateFailure, string>

export interface EstateMcpOptions {
  provider: RetrievalProvider
  audit?: AuditStore
  requestContext?: (request: Request) => PortalRequestContext
  /** The guard's authority for the request. */
  authorise: (context: Context) => Promise<RequestAuthority | null>
  /** The portals the request may read; refuses, as a cross-portal ask does, when there are none. */
  readable: (context: Context) => Promise<TenantConfig[]>
  /** The portals one tool call reaches on the tool's own permission, narrowed to `slugs`. */
  portals: (
    context: Context,
    tool: Declaration,
    slugs?: readonly string[],
  ) => Promise<TenantConfig[]>
  /** Admit one paid answer on each portal against the caller's limits: seconds to wait, or null. */
  admitAnswers: (context: Context, targets: readonly TenantConfig[]) => number | null
  /** Checks one portal for one tool call: suspension and the daily ask limit. Throws to refuse. */
  beforePortal: (tool: Declaration, config: TenantConfig, authority: RequestAuthority) => void
  sourceTimeoutMs?: number
}

interface EstateCall {
  context: Context
  authority: RequestAuthority
  requestId: string
  signal: AbortSignal
  mandatoryFailure?: AuditWriteError
}

type PortalOutcome<T> =
  | { config: TenantConfig; value: T; failure?: undefined }
  | { config: TenantConfig; failure: EstateFailure }

class SourceTimeoutError extends Error {}

const READ_ONLY_TOOL = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const
// The slug rule of KeyPortalSlugSchema, in the zod version the MCP SDK takes.
const portalsInput = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1)
  .max(MAX_ESTATE_PORTALS + 1).optional()
  .describe('Portal slugs to limit the call to. Portals this credential cannot reach are left out.')

const portalTag = (config: TenantConfig) => ({
  portal: config.slug,
  portalTitle: config.branding.productName,
})

function failureOf(error: unknown): EstateFailure {
  if (error instanceof SourceTimeoutError) return 'timeout'
  if (error instanceof UnverifiedAnswerError) return 'unverified'
  if (error instanceof PortalLifecycleError) return 'unavailable'
  return 'upstream'
}

/**
 * Query every portal at once, each within the time limit. One portal failing, refusing or
 * running out of time is reported as that portal's failure; the others still return.
 */
async function fanOut<T>(
  targets: readonly TenantConfig[],
  timeoutMs: number,
  signal: AbortSignal,
  run: (config: TenantConfig, signal: AbortSignal) => Promise<T>,
): Promise<PortalOutcome<T>[]> {
  return await Promise.all(targets.map(async (config): Promise<PortalOutcome<T>> => {
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal.addEventListener('abort', stop, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        run(config, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new SourceTimeoutError())
          }, timeoutMs)
        }),
      ])
      return { config, value }
    } catch (error) {
      if (error instanceof AuditWriteError) throw error
      return { config, failure: failureOf(error) }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }))
}

function createEstateMcpServer(opts: EstateMcpOptions, call: EstateCall) {
  const server = new McpServer({ name: 'corpuskit-estate', version: '1.0.0' })
  const timeoutMs = opts.sourceTimeoutMs ?? DEFAULT_ESTATE_SOURCE_TIMEOUT_MS

  /** One audit row per portal a call queried, in that portal's own log, with its outcome. */
  const audit = (tool: Declaration, outcomes: readonly PortalOutcome<unknown>[]) => {
    if (!opts.audit) throw new AuditWriteError()
    const roles = call.authority.kind === 'key' ? keyPortalRoles(call.authority) : []
    for (const outcome of outcomes) {
      const keyRole = roles.find((grant) => grant.slug === outcome.config.slug)?.role
      appendAudit(
        opts.audit,
        createAuditEvent({
          requestId: call.requestId,
          actor: call.authority.actor,
          action: 'estate.query',
          scope: { kind: 'portal', slug: outcome.config.slug },
          target: { kind: 'tool', id: tool.path },
          outcome: outcome.failure ? 'failure' : 'success',
          detail: {
            permission: tool.permission,
            operation: `MCP ${tool.path}`,
            count: outcomes.length,
            ...(keyRole ? { keyRole } : {}),
            ...(outcome.failure ? { code: FAILURE_CODES[outcome.failure] } : {}),
          },
        }),
      )
    }
  }

  /**
   * Authorise the portals one call reaches on the tool's own permission, query each, record
   * every portal queried, then shape what the portals returned. `failed_sources` names each
   * portal that did not; a call where every portal failed is an error that still names them.
   */
  const estateTool = async <T>(
    name: string,
    slugs: readonly string[] | undefined,
    query: (config: TenantConfig, signal: AbortSignal) => Promise<T>,
    shape: (returned: { config: TenantConfig; value: T }[]) => Record<string, unknown>,
    admit: (targets: readonly TenantConfig[]) => void = () => {},
  ) => {
    let returned = 0
    const result = await safeTool(async () => {
      try {
        const tool = DECLARATIONS.find((d) => d.kind === 'mcp' && d.path === name)
        if (!tool || tool.aggregate !== 'authorised-portals') throw new AuditWriteError()
        const targets = await opts.portals(call.context, tool, slugs)
        admit(targets)
        const outcomes = await fanOut(targets, timeoutMs, call.signal, (config, signal) => {
          opts.beforePortal(tool, config, call.authority)
          return query(config, signal)
        })
        // Recorded even when the caller has gone: its portals were queried all the same.
        audit(tool, outcomes)
        call.signal.throwIfAborted()
        const answered = outcomes.flatMap((outcome) =>
          outcome.failure ? [] : [{ config: outcome.config, value: outcome.value }]
        )
        returned = answered.length
        return {
          ...shape(answered),
          portals: targets.map(portalTag),
          failed_sources: outcomes.flatMap((outcome) =>
            outcome.failure ? [{ ...portalTag(outcome.config), reason: outcome.failure }] : []
          ),
        }
      } catch (error) {
        if (error instanceof AuditWriteError) call.mandatoryFailure = error
        throw error
      }
    })
    return returned === 0 && !('isError' in result) ? { ...result, isError: true } : result
  }

  server.registerTool(
    declaredTool('search_estate'),
    {
      title: 'Search the estate',
      description: 'Find research documents and passages across every portal this credential ' +
        'may read. Each result names its portal. Portals that fail or take too long are listed ' +
        'in failed_sources while the rest still return.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(2000),
        mode: z.enum(['hybrid', 'semantic', 'keyword']).optional(),
        limit: z.number().int().min(1).max(20).default(5).describe('Results from each portal.'),
        portals: portalsInput,
      }).strict(),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: true },
    },
    ({ query, mode, limit, portals }) =>
      estateTool(
        'search_estate',
        portals,
        async (config) =>
          (await opts.provider.search(config, query, { mode, pageSize: limit })).resources
            .slice(0, limit),
        (returned) => ({
          query,
          // One ranked list: by relevance where a portal gives one, then in each portal's order.
          results: returned.flatMap(({ config, value }) =>
            value.map((resource) => ({ ...resource, ...portalTag(config) }))
          ).map((resource, order) => ({ resource, order })).sort((a, b) =>
            (b.resource.relevance ?? -1) - (a.resource.relevance ?? -1) || a.order - b.order
          ).map(({ resource }) => resource),
        }),
      ),
  )

  server.registerTool(
    declaredTool('answer_estate'),
    {
      title: 'Answer from the estate',
      description: 'Answer a research question from every portal this credential may ask. ' +
        'Each portal answers from its own corpus with its own verified citations, and every ' +
        'answer and citation names its portal. Portals that fail or take too long are listed ' +
        'in failed_sources while the rest still answer.',
      inputSchema: z.object({
        question: z.string().trim().min(1).max(4000),
        portals: portalsInput,
      }).strict(),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: false },
    },
    ({ question, portals }) =>
      estateTool(
        'answer_estate',
        portals,
        (config, signal) => collectVerifiedAnswer(opts.provider, config, question, signal),
        (returned) => ({
          question,
          answers: returned.map(({ config, value }) => ({
            ...portalTag(config),
            ...value,
            citations: value.citations.map((citation) => ({ ...citation, portal: config.slug })),
          })),
        }),
        // Each portal's answer is a paid ask: the whole fan-out is admitted, or none of it.
        (targets) => {
          const retryAfter = opts.admitAnswers(call.context, targets)
          if (retryAfter !== null) {
            throw new PortalLifecycleError(429, { error: 'rate_limited', retryAfter })
          }
        },
      ),
  )

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  return { transport, connected: server.connect(transport) }
}

/**
 * The estate MCP endpoint: search and answer across every portal its caller may use. A key
 * reaches its own portal and the portals its estate names; a session reaches its directory, as
 * a cross-portal ask does. Each tool call is authorised again on its own permission, each portal
 * is checked for suspension and its daily ask limit, and every portal queried is audited.
 */
export function registerEstateMcpRoutes(app: Hono, opts: EstateMcpOptions): void {
  app.all(declaredRoute('ALL', ESTATE_MCP_ROUTE), async (context) => {
    const request = opts.requestContext?.(context.req.raw)
    context.header('www-authenticate', 'Bearer realm="CorpusKit MCP"')
    const authority = await opts.authorise(context)
    if (!authority) throw new AuthorisationError(403)
    if (request) request.actor = authority.actor
    if (context.req.method !== 'POST') {
      context.header('allow', 'POST')
      return context.json({ error: 'method_not_allowed' }, 405)
    }
    await opts.readable(context)

    // A server per request, as on a portal's endpoint, so callers may reuse JSON-RPC ids.
    const call: EstateCall = {
      context,
      authority,
      requestId: request?.requestId ?? crypto.randomUUID(),
      signal: context.req.raw.signal,
    }
    const { transport, connected } = createEstateMcpServer(opts, call)
    await connected
    try {
      const response = await transport.handleRequest(context.req.raw)
      // The SDK turns callback exceptions into protocol errors; a required audit failure is a 500.
      if (call.mandatoryFailure) throw call.mandatoryFailure
      return withNoStore(response)
    } finally {
      await transport.close()
    }
  })
}
