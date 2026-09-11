import type { Context } from 'hono'
import {
  appendAudit,
  type AuditInput,
  type AuditOutcome,
  type AuditStore,
  AuditWriteError,
  createAuditEvent,
} from './audit.ts'

export const AUDIT_MAX_RESPONSE_BYTES = 1024 * 1024
export const AUDIT_TIMEOUT_MS = 120_000
export type AuditExecutionCode =
  | 'operation_failed'
  | 'deadline_exceeded'
  | 'response_too_large'
  | 'client_aborted'

export class AuditExecutionError extends Error {
  constructor(readonly code: AuditExecutionCode) {
    super(code)
    this.name = 'AuditExecutionError'
  }
}
type ResultOutcome = Exclude<AuditOutcome, 'intent'>
/** Adapter-owned scope; only individual synchronous store mutations enter a SQL transaction. */
export interface LocalMutationScope {
  run<T>(
    input: Omit<AuditInput, 'outcome'>,
    signal: AbortSignal,
    work: () => T | Promise<T>,
  ): Promise<T>
}
interface AuditExecutionOptions<T> {
  audit: Pick<AuditStore, 'append'>
  input: Omit<AuditInput, 'outcome'>
  run: (signal: AbortSignal) => T | Promise<T>
  signal?: AbortSignal
  localMutations?: LocalMutationScope
  /** May tighten the production bound, never relax it. */
  timeoutMs?: number
  classify?: (result: T) => ResultOutcome
  log?: (record: { requestId: string; action: string; code: 'audit_write_failed' }) => void
  /** Internal clock seam for deterministic deadline verification. Returns timer disposal. */
  schedule?: (callback: () => void, ms: number) => () => void
}
function bound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value <= 0) throw new AuditExecutionError('operation_failed')
  return Math.min(value, maximum)
}

/**
 * One remote/non-transactional attempt, with mandatory intent and result evidence.
 * Existing local RBAC services retain their own synchronous mutation/audit transaction.
 * Cancellation signals intent to stop; a remote side effect may still have happened.
 */
export async function executeAudited<T>(options: AuditExecutionOptions<T>): Promise<T> {
  const timeoutMs = bound(options.timeoutMs, AUDIT_TIMEOUT_MS)
  // Freeze safe correlation/actor/details before running caller code or awaiting remote work.
  const intent = createAuditEvent({ ...options.input, outcome: 'intent' })
  const input: Omit<AuditInput, 'outcome'> = {
    requestId: intent.request_id,
    actor: {
      kind: intent.actor_kind,
      ...(intent.actor_id === null ? {} : { id: intent.actor_id }),
      ...(intent.actor_label === null ? {} : { label: intent.actor_label }),
    },
    action: intent.action,
    scope: intent.scope_kind === 'portal'
      ? { kind: 'portal', slug: intent.scope_slug! }
      : { kind: 'platform' },
    target: {
      kind: intent.target_kind,
      ...(intent.target_id === null ? {} : { id: intent.target_id }),
    },
    detail: JSON.parse(intent.detail_json),
  }
  const write = (event: ReturnType<typeof createAuditEvent>) => {
    try {
      appendAudit(options.audit, event)
    } catch {
      try {
        ;(options.log ?? console.error)({
          requestId: intent.request_id,
          action: intent.action,
          code: 'audit_write_failed',
        })
      } catch { /* Logging cannot rescue a failed required append. */ }
      throw new AuditWriteError()
    }
  }
  write(intent)

  const upstream = new AbortController()
  let rejectStopped!: (error: AuditExecutionError) => void
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject
  })
  const stop = (code: AuditExecutionCode) => {
    if (upstream.signal.aborted) return
    const error = new AuditExecutionError(code)
    upstream.abort(error)
    rejectStopped(error)
  }
  const onClientAbort = () => stop('client_aborted')
  options.signal?.addEventListener('abort', onClientAbort, { once: true })
  const dispose = (options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }))(() => stop('deadline_exceeded'), timeoutMs)
  let dispatched = false
  let result!: T
  let failure: unknown
  let failed = false
  let outcome: ResultOutcome = 'success'
  try {
    // Promise.race installs rejection observers on both branches, including late remote failure.
    const running = Promise.resolve().then(() => {
      if (upstream.signal.aborted) throw upstream.signal.reason
      dispatched = true
      return options.localMutations
        ? options.localMutations.run(input, upstream.signal, () => options.run(upstream.signal))
        : options.run(upstream.signal)
    })
    const pending = Promise.race([running, stopped])
    if (options.signal?.aborted) onClientAbort()
    result = await pending
    if (upstream.signal.aborted) throw upstream.signal.reason
    outcome = options.classify?.(result) ?? 'success'
  } catch (error) {
    failed = true
    failure = error instanceof AuditWriteError || error instanceof AuditExecutionError
      ? error
      : new AuditExecutionError('operation_failed')
    outcome = dispatched ? 'uncertain' : 'failure'
    // Reject observers already exist before cancellation can settle the competing branch.
    stop(failure instanceof AuditExecutionError ? failure.code : 'operation_failed')
  } finally {
    dispose()
    options.signal?.removeEventListener('abort', onClientAbort)
  }
  // Outside the operation catch: a failed completion append never replays or reports rollback.
  write(createAuditEvent({
    ...input,
    outcome,
    detail: {
      ...(input.detail as Record<string, unknown>),
      ...(failed || outcome !== 'success'
        ? { code: failure instanceof AuditExecutionError ? failure.code : 'operation_failed' }
        : {}),
    },
  }))
  if (failed) throw failure
  return result
}

/** Observe cancellation failures without waiting indefinitely for an uncooperative producer. */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {})
  } catch { /* The reader can already have released its lock. */ }
}

function logicalFailure(text: string, contentType: string): boolean {
  if (contentType.includes('text/event-stream')) {
    for (const event of text.replace(/\r\n?/g, '\n').split('\n\n')) {
      const lines = event.split('\n')
      if (lines.some((line) => /^event:\s*error\s*$/.test(line))) return true
      const data = lines.filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n')
      try {
        if (data && JSON.parse(data)?.type === 'error') return true
      } catch { /* Non-JSON SSE data is not itself a logical failure marker. */ }
    }
  } else if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(text)
      return data?.isError === true || data?.result?.isError === true ||
        (typeof data?.error === 'string' && data.error.length > 0)
    } catch {
      return true
    }
  }
  return false
}

export interface StagedResponse {
  response: Response
  outcome: ResultOutcome
}

// Track the body rather than response headers, which middleware can replace. Only
// local constructors with a fully materialised input may bypass the producer cap.
const materialisedBodies = new WeakSet<ReadableStream<Uint8Array>>()

function markMaterialised<T extends Response>(response: T): T {
  if (response.body) materialisedBodies.add(response.body)
  return response
}

export function materialisedJsonResponse(value: unknown): Response {
  return markMaterialised(Response.json(value))
}

/** Preserve Hono's serialisation, status and headers while recording body provenance. */
export function trackMaterialisedResponses(context: Context): void {
  context.json = new Proxy(context.json, {
    apply(target, receiver, args) {
      const response = Reflect.apply(target as (...args: unknown[]) => Response, receiver, args)
      return markMaterialised(response)
    },
  })
  const track = <K extends 'text' | 'body' | 'newResponse' | 'html'>(method: K) => {
    context[method] = new Proxy(context[method], {
      apply(target, receiver, args) {
        const response = Reflect.apply(target, receiver, args)
        const body = args[0]
        // HTML may be asynchronous and body/newResponse also accept streams.
        // Unknown producers retain the fixed cap, regardless of their headers.
        return response instanceof Response &&
            (body === null || typeof body === 'string' || body instanceof ArrayBuffer ||
              ArrayBuffer.isView(body) || body instanceof Blob)
          ? markMaterialised(response)
          : response
      },
    })
  }
  for (const method of ['text', 'body', 'newResponse', 'html'] as const) track(method)
}

/** Consume privileged bytes before a Response can escape the mandatory audit boundary. */
export async function stageAuditResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes = AUDIT_MAX_RESPONSE_BYTES,
): Promise<StagedResponse> {
  // Materialised values are already in memory. Their staging bound is their
  // actual encoded size; only incremental producers need a fixed byte cap.
  const limit = response.body && materialisedBodies.has(response.body)
    ? Infinity
    : bound(maxBytes, AUDIT_MAX_RESPONSE_BYTES)
  const reader = response.body?.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let bytes = 0
  let complete = false
  const onAbort = () => {
    if (reader) cancelReader(reader)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw signal.reason
    if (reader) {
      for (;;) {
        const item = await reader.read()
        if (signal.aborted) throw signal.reason
        if (item.done) break
        bytes += item.value.byteLength
        if (bytes > limit) throw new AuditExecutionError('response_too_large')
        chunks.push(item.value.slice())
      }
    }
    complete = true
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (reader) {
      if (!complete) cancelReader(reader)
      reader.releaseLock()
    }
  }
  const blob = new Blob(chunks)
  const contentType = response.headers.get('content-type') ?? ''
  const outcome = response.status === 401 || response.status === 403
    ? 'denied'
    : response.status >= 400 ||
        ((contentType.includes('text/event-stream') || contentType.includes('application/json')) &&
          logicalFailure(await blob.text(), contentType))
    ? 'failure'
    : 'success'
  return {
    response: new Response(response.body === null ? null : blob, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    outcome,
  }
}

export interface AuditedResponseOptions extends Omit<AuditExecutionOptions<Response>, 'classify'> {
  privileged: boolean
  maxBytes?: number
}

/** Ordinary reads/ask keep streaming. Verified break-glass always requires staged audit. */
export async function executeAuditedResponse(options: AuditedResponseOptions): Promise<Response> {
  if (!options.privileged && options.input.actor.kind !== 'break-glass') {
    return options.run(options.signal ?? new AbortController().signal)
  }
  try {
    const result = await executeAudited({
      ...options,
      run: async (signal) => {
        const response = await options.run(signal)
        // Even a response arriving after the deadline enters staging, which cancels its reader.
        return stageAuditResponse(response, signal, options.maxBytes)
      },
      classify: (result) => result.outcome,
    })
    return result.response
  } catch (error) {
    const code = error instanceof AuditWriteError
      ? 'audit_write_failed'
      : error instanceof AuditExecutionError
      ? error.code
      : 'operation_failed'
    return Response.json({ error: code }, { status: 500, headers: { 'cache-control': 'no-store' } })
  }
}
