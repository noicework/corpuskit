import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { AgentAskEvent, AgentChunk, AgentSource } from '@research-portal/core'
import {
  agentAnswer,
  type AgentAnswerOptions,
  portalSource,
  SOURCE_TIMEOUT_MS,
} from './agent-compose.ts'
import { appendAudit, type AuditStore, AuditWriteError, createAuditEvent } from './audit.ts'
import type { PortalRequestContext } from './app.ts'
import { declaredTool } from './permissions.ts'
import { composeDeadline, ComposeTimedOut } from './compose-deadline.ts'
import { COMPOSE_PASSAGE_CHARS } from '@research-portal/retrieval'

export interface FederatedMcpTools {
  admit(): void
  ask(question: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  search(query: string, limit: number, signal?: AbortSignal): Promise<Record<string, unknown>>
}

type AuditedTool = (
  name: string,
  context: ServerContext,
  call: (signal?: AbortSignal) => Promise<Record<string, unknown>>,
) => ReturnType<typeof import('./mcp.ts').safeTool>

export function registerFederatedMcpTools(
  server: McpServer,
  tools: FederatedMcpTools,
  audited: AuditedTool,
): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  server.registerTool(
    declaredTool('ask_federated'),
    {
      title: 'Ask across federated collections',
      description: "Run this portal's agent ask across its collection and participating peers. " +
        'Returns the answer, attributed citations and failed_sources.',
      inputSchema: z.object({ question: z.string().trim().min(1).max(2000) }).strict(),
      annotations: { ...annotations, idempotentHint: false },
    },
    ({ question }, context) =>
      audited('ask_federated', context, (signal) => tools.ask(question, signal)).then(markFailure),
  )
  server.registerTool(
    declaredTool('search_federated'),
    {
      title: 'Search federated collections',
      description: 'Retrieve passages from this portal and its participating peers. ' +
        'Every passage names its source; failed_sources identifies unavailable collections.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(2000),
        limit: z.number().int().min(1).max(20).default(4).describe('Passages per collection.'),
      }).strict(),
      annotations: { ...annotations, idempotentHint: true },
    },
    ({ query, limit }, context) =>
      audited('search_federated', context, (signal) => tools.search(query, limit, signal))
        .then(markFailure),
  )
}

function markFailure(result: Awaited<ReturnType<typeof import('./mcp.ts').safeTool>>) {
  return 'structuredContent' in result && result.structuredContent.failed === true
    ? { ...result, isError: true }
    : result
}

/** Materialise the HTTP agent stream without returning steps or private upstream errors. */
export async function collectFederatedAnswer(events: AsyncIterable<AgentAskEvent>) {
  let answer = '', complete = false, failed = false
  let mode: 'agent' | 'orchestrated' | undefined
  const sources = new Map<string, AgentSource>()
  const citations: Extract<AgentAskEvent, { type: 'citation' }>[] = []
  const failedSources: (AgentSource & { reason: string })[] = []
  for await (const event of events) {
    if (event.type === 'agent-start') {
      mode = event.mode
      for (const source of event.sources) sources.set(source.id, source)
    } else if (event.type === 'agent-sources') sources.set(event.source.id, event.source)
    else if (event.type === 'delta') answer += event.text
    else if (event.type === 'citation') citations.push({ ...event })
    else if (event.type === 'sources-failed') failedSources.push(...event.sources)
    else if (event.type === 'error') failed = true
    else if (event.type === 'done') {
      if (event.text !== undefined) answer = event.text
      complete = true
    }
  }
  // A stream that fails or ends early must not release a partly written answer.
  failed ||= !complete || citations.some((citation) => !sources.has(citation.sourceId))
  return {
    answer: failed ? '' : answer,
    citations: failed ? [] : citations.map(({ type: _type, ...citation }) => ({
      ...citation,
      source: sources.get(citation.sourceId),
    })),
    sources: [...sources.values()],
    failed_sources: failedSources,
    ...(mode ? { mode } : {}),
    ...(failed ? { failed: true, error: 'answer_failed' } : {}),
  }
}

export function federatedMcpTools(
  options: Omit<AgentAnswerOptions, 'question' | 'portals'> & {
    audit: AuditStore
    auditContext: PortalRequestContext
    admit: (searches: number) => void
    /**
     * Composes the answer. The server passes the portal's answer policy wrapped round its answer
     * record, as the HTTP agent ask does; without it the answer is composed directly.
     */
    answer?: (options: AgentAnswerOptions) => AsyncIterable<AgentAskEvent>
  },
): FederatedMcpTools {
  const { host, provider } = options
  let auditFailure: AuditWriteError | undefined
  // The composer reports source failures as data. Required audit failures still fail closed.
  const peers = (options.peers ?? []).map((peer) => ({
    ...peer,
    search: async (question: string, signal: AbortSignal) => {
      try {
        return await peer.search(question, signal)
      } catch (error) {
        if (error instanceof AuditWriteError) auditFailure = error
        throw error
      }
    },
  }))
  const run = async (tool: string, call: () => Promise<Record<string, unknown>>) => {
    const result = await call()
    if (auditFailure) throw auditFailure
    appendAudit(
      options.audit,
      createAuditEvent({
        requestId: options.auditContext.requestId,
        actor: options.auditContext.actor ?? { kind: 'anonymous' },
        action: 'estate.query',
        scope: { kind: 'portal', slug: host.slug },
        target: { kind: 'tool', id: tool },
        outcome: result.failed ? 'failure' : 'success',
        detail: { permission: 'portal.ask', operation: `MCP ${tool}`, count: 1 + peers.length },
      }, options.now),
    )
    return result
  }
  return {
    admit: () => options.admit(1 + peers.length),
    ask: (question, signal) =>
      run('ask_federated', () =>
        collectFederatedAnswer((options.answer ?? agentAnswer)({
          ...options,
          peers,
          portals: [host],
          question,
          signal,
        }))),
    search: (query, limit, signal) =>
      run('search_federated', async () => {
        const sources = [{
          source: portalSource(host),
          search: async (query: string, signal: AbortSignal): Promise<AgentChunk[]> =>
            (await provider.search(host, query, { pageSize: limit, passagesOnly: true, signal }))
              .resources.slice(0, limit)
              .flatMap((resource) => {
                const text = (resource.matchedPassage ?? resource.summary ?? '').trim()
                return text
                  ? [{
                    id: `${host.slug}/${resource.id}`,
                    resourceId: resource.id,
                    title: resource.title,
                    text: text.slice(0, COMPOSE_PASSAGE_CHARS),
                  }]
                  : []
              }),
        }, ...peers]
        const outcomes = await Promise.all(sources.map(async ({ source, search }) => {
          const deadline = composeDeadline(options.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS, signal)
          try {
            const chunks = await deadline.run(() => search(query, deadline.signal))
            return { source, chunks: chunks.slice(0, limit) }
          } catch (error) {
            if (error instanceof AuditWriteError) throw error
            return {
              source,
              reason: error instanceof ComposeTimedOut
                ? 'timeout'
                : (error as { failure?: string }).failure === 'unauthorised'
                ? 'unauthorised'
                : 'error',
            }
          } finally {
            deadline.close()
          }
        }))
        signal?.throwIfAborted()
        return {
          query,
          results: outcomes.flatMap((outcome) =>
            (outcome.chunks ?? []).map((chunk) => ({ ...chunk, source: outcome.source }))
          ),
          sources: sources.map(({ source }) => source),
          failed_sources: outcomes.flatMap(({ source, reason }) =>
            reason ? [{ ...source, reason }] : []
          ),
          ...(outcomes.every((outcome) => outcome.reason) ? { failed: true } : {}),
        }
      }),
  }
}
