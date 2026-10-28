import { z } from 'zod'

// ---------------------------------------------------------------------------
// Agent ask - a retrieval agent's answer, streamed one step at a time: the
// agent plans, searches each of its sources, reasons, then writes a cited
// answer. A separate contract from `AskEventSchema`, so nothing that consumes
// the portal's own Ask stream changes. See docs/AGENT-ASK.md.
// ---------------------------------------------------------------------------

/** A link the page may render: http(s) only, never a script or data address. */
const HttpUrlSchema = z.string().url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'Must be an http(s) address',
})

/**
 * One source the answer searches: a knowledge box behind one of the agent's drivers, or one
 * portal of this deployment when the portal composes the answer itself.
 */
export const AgentSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** The portal's slug, when the source is a portal of this deployment (links go there). */
  portal: z.string().min(1).optional(),
  /**
   * When the portal composes: `hosted`, a portal of this deployment; `peer`, a federated
   * partner's collection the host searches on the reader's behalf.
   */
  kind: z.enum(['hosted', 'peer']).optional(),
  /** How a peer is reached: its knowledge box's search (`kb`) or its MCP server (`mcp`). */
  transport: z.enum(['kb', 'mcp']).optional(),
})

/** A passage a source returned for one of the agent's lookups. */
export const AgentChunkSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  text: z.string(),
  url: HttpUrlSchema.optional(),
  /** The resource in the source's portal the passage comes from, when it is a portal. */
  resourceId: z.string().min(1).optional(),
})

/**
 * Who wrote the answer. `agent`: a retrieval agent planned, searched and answered. `orchestrated`:
 * the portal searched each collection itself and composed one answer from what they returned.
 */
export const AgentAskModeSchema = z.enum(['agent', 'orchestrated'])

export const AgentStepStatusSchema = z.enum(['started', 'completed', 'failed'])

/**
 * Why an agent ask ended without an answer. `timeout`: the agent took longer than the portal
 * waits. `upstream`: the agent or one of its sources failed, or the stream broke off.
 * `cancelled`: the reader or the server stopped it. `not_configured`: the portal has no agent.
 */
export const AgentAskErrorCodeSchema = z.enum([
  'timeout',
  'upstream',
  'cancelled',
  'not_configured',
])

export const AgentAskEventSchema = z.discriminatedUnion('type', [
  /** First on every stream, before anything is searched: who answers, and its sources. */
  z.object({
    type: z.literal('agent-start'),
    mode: AgentAskModeSchema,
    sources: AgentSourceSchema.array(),
  }),
  /**
   * A step opening or closing. Every step id is `started` once, then at most once `completed`
   * or `failed`; a step still open when the stream ends is closed by the `done` or `error`.
   */
  z.object({
    type: z.literal('agent-step'),
    id: z.string().min(1),
    module: z.string().min(1),
    title: z.string().min(1),
    status: AgentStepStatusSchema,
    /** How long the step took, on its closing event. */
    elapsedMs: z.number().int().nonnegative().optional(),
    /** The agent's own reason for the step, when it gives one. */
    reason: z.string().optional(),
  }),
  /** What one source returned for a step: one event per source the step searched. */
  z.object({
    type: z.literal('agent-sources'),
    stepId: z.string().min(1),
    source: AgentSourceSchema,
    /** The question the agent put to this source, when it rephrased the reader's. */
    question: z.string().optional(),
    chunks: AgentChunkSchema.array(),
  }),
  /**
   * The sources that could not be searched (an error, or no answer within the time limit), sent
   * once, after every lookup has settled and before the answer. The answer comes from the rest.
   */
  z.object({
    type: z.literal('sources-failed'),
    sources: AgentSourceSchema.extend({ reason: z.enum(['timeout', 'unauthorised', 'error']) })
      .array().min(1),
  }),
  /** The agent thinking aloud. `last` closes the current run of reasoning. */
  z.object({ type: z.literal('reasoning'), text: z.string(), last: z.boolean() }),
  /** The next piece of the answer text. Citation markers appear in it as `[marker]`. */
  z.object({ type: z.literal('delta'), text: z.string() }),
  /** What a `[marker]` in the answer cites: a passage from one source. */
  z.object({
    type: z.literal('citation'),
    marker: z.string().min(1),
    sourceId: z.string().min(1),
    chunkId: z.string().min(1),
    title: z.string(),
    url: HttpUrlSchema.optional(),
  }),
  z.object({ type: z.literal('done'), elapsedMs: z.number().int().nonnegative() }),
  /** The stream's last event when it ends without an answer. */
  z.object({
    type: z.literal('error'),
    code: AgentAskErrorCodeSchema,
    message: z.string(),
    /** Whether asking again may work. */
    retryable: z.boolean(),
  }),
])

/** The body of `POST /api/t/:slug/ask-agent`; `POST /api/ask-agent` also takes `slugs`. */
export const AgentAskRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  /** Prior turns, oldest first. */
  context: z
    .object({ author: z.enum(['USER', 'AGENT']), text: z.string().max(20_000) }).strict()
    .array()
    .max(24)
    .optional(),
}).strict()

// ---------------------------------------------------------------------------
// Federation: the partner collections a portal's composed answers also search,
// and whether the portal itself takes part in federated answers.
// ---------------------------------------------------------------------------

/** A Progress Agentic RAG zone: a host label under `.dp.progress.cloud`, nothing else. */
export const FEDERATION_ZONE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export const FEDERATION_PEER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A resource carrying this label (labelset `federation`) never leaves its portal in a federated answer. */
export const FEDERATION_EXCLUDE_LABEL = { labelset: 'federation', label: 'exclude' } as const

/**
 * A partner collection: a knowledge box searched with its read-only service-account key, which
 * is stored sealed on the server and never part of this record. `arag-kb` searches the box's
 * own retrieval (`/find`); `arag-mcp` calls its MCP server's `search_documents` tool.
 */
export const FederationPeerSchema = z.object({
  id: z.string().regex(FEDERATION_PEER_ID),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(['arag-kb', 'arag-mcp']),
  zone: z.string().regex(FEDERATION_ZONE),
  kbId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  /** Whether citations link to the passage's origin URL. Off: title, label and passage only. */
  linkOrigins: z.boolean().optional(),
}).strict()

/** The federation settings as `PATCH /api/admin/tenants/:slug` takes them. */
export const FederationSettingsSchema = z.object({
  /** Whether the portal takes part in federated answers. Absent means it does. */
  participates: z.boolean().optional(),
  peers: FederationPeerSchema.array().max(6).refine(
    (peers) => new Set(peers.map((peer) => peer.id)).size === peers.length,
    { message: 'Peer ids must be unique' },
  ).optional(),
}).strict()

/**
 * The federation settings as a portal's configuration carries them. Readers get each peer's
 * id, label and kind only, so a peer's zone and box are optional here.
 */
export const FederationConfigSchema = z.object({
  participates: z.boolean().optional(),
  peers: FederationPeerSchema.partial({ zone: true, kbId: true, linkOrigins: true }).array()
    .optional(),
})

/** Whether the portal takes part in federated answers: unless it opts out. */
export function participatesInFederation(config: { federation?: { participates?: boolean } }) {
  return config.federation?.participates !== false
}

/** Whether a portal offers agent ask: only when it opts in. */
export function offersAgentAsk(config: { agentAsk?: boolean }): boolean {
  return config.agentAsk === true
}

export type AgentSource = z.infer<typeof AgentSourceSchema>
export type AgentChunk = z.infer<typeof AgentChunkSchema>
export type AgentAskMode = z.infer<typeof AgentAskModeSchema>
export type AgentStepStatus = z.infer<typeof AgentStepStatusSchema>
export type AgentAskErrorCode = z.infer<typeof AgentAskErrorCodeSchema>
export type AgentAskEvent = z.infer<typeof AgentAskEventSchema>
export type AgentAskRequest = z.infer<typeof AgentAskRequestSchema>
export type FederationPeer = z.infer<typeof FederationPeerSchema>
export type FederationSettings = z.infer<typeof FederationSettingsSchema>
