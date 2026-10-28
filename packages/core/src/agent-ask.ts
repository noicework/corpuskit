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

/** One source the agent searches: a knowledge box behind one of its drivers. */
export const AgentSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})

/** A passage a source returned for one of the agent's lookups. */
export const AgentChunkSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  text: z.string(),
  url: HttpUrlSchema.optional(),
})

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
  /** First on every stream, before the agent has done anything: the sources it can search. */
  z.object({ type: z.literal('agent-start'), sources: AgentSourceSchema.array() }),
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

/** The body of `POST /api/t/:slug/ask-agent`. */
export const AgentAskRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  /** Prior turns, oldest first. */
  context: z
    .object({ author: z.enum(['USER', 'AGENT']), text: z.string().max(20_000) }).strict()
    .array()
    .max(24)
    .optional(),
}).strict()

/** Whether a portal offers agent ask: only when it opts in. */
export function offersAgentAsk(config: { agentAsk?: boolean }): boolean {
  return config.agentAsk === true
}

export type AgentSource = z.infer<typeof AgentSourceSchema>
export type AgentChunk = z.infer<typeof AgentChunkSchema>
export type AgentStepStatus = z.infer<typeof AgentStepStatusSchema>
export type AgentAskErrorCode = z.infer<typeof AgentAskErrorCodeSchema>
export type AgentAskEvent = z.infer<typeof AgentAskEventSchema>
export type AgentAskRequest = z.infer<typeof AgentAskRequestSchema>
