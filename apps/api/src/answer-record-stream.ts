import { AskEventSchema, type TenantConfig } from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import { AnswerRecorder } from './answer-recorder.ts'
import type { AnswerRecordStoreApi } from './answer-record-store.ts'

/** Hold the terminal event until persistence commits, including early refusal paths. */
export function recordAnswerStream(
  options: {
    store: AnswerRecordStoreApi
    config: TenantConfig
    question: string
    resourceId?: string
    modelId?: string
    buildId?: string
    now?: () => number
    cancelled: (stream: SSEStreamingApi) => boolean
  },
  provider: RetrievalProvider,
  run: (
    stream: SSEStreamingApi,
    provider: RetrievalProvider,
    send: (event: unknown) => Promise<void>,
  ) => Promise<void>,
): (stream: SSEStreamingApi) => Promise<void> {
  return async (stream) => {
    let modelId = options.modelId
    if (!modelId) {
      try {
        modelId = await provider.generativeModel?.(options.config)
      } catch { /* Unknown model is explicit. */ }
    }
    let storeId: string | undefined
    try {
      storeId = provider.storeIdentifier?.(options.config)
    } catch { /* Unknown store identifier. */ }
    const recorder = new AnswerRecorder({
      store: options.store,
      portal: options.config.slug,
      question: options.question,
      surface: options.resourceId ? 'document' : 'ask',
      modelId: modelId || null,
      storeId,
      buildId: options.buildId,
      now: options.now,
    })
    let terminal: unknown
    const send = async (event: unknown) => {
      const parsed = AskEventSchema.safeParse(event)
      if (parsed.success) recorder.observe(parsed.data)
      if (parsed.success && parsed.data.type === 'done') {
        terminal = event
        return
      }
      await stream.writeSSE({ data: JSON.stringify(event) })
    }
    try {
      await run(stream, recorder.provider(provider), send)
      if (options.cancelled(stream)) {
        recorder.finish('cancelled')
        return
      }
      const answerId = recorder.finish()
      await stream.writeSSE({ data: JSON.stringify({ type: 'answer-record', answerId }) })
      if (terminal) await stream.writeSSE({ data: JSON.stringify(terminal) })
    } catch {
      try {
        recorder.finish(options.cancelled(stream) ? 'cancelled' : 'error')
      } catch { /* The stream fails closed below. */ }
      // No upstream details or personal data in operational logs or the public error.
      console.error('Answer evidence could not be completed')
      if (!options.cancelled(stream)) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            message: 'The answer record could not be saved. Please try again.',
          }),
        })
      }
    }
  }
}

export function recordSSE(
  context: Context,
  options: Parameters<typeof recordAnswerStream>[0] & { provider: RetrievalProvider },
  run: Parameters<typeof recordAnswerStream>[2],
): Response {
  return streamSSE(context, recordAnswerStream(options, options.provider, run))
}

/** One separately grounded source answer in an estate/composed fan-out, owned by that portal. */
export async function* recordComposedSource(
  options: Pick<
    Parameters<typeof recordAnswerStream>[0],
    'store' | 'config' | 'question' | 'buildId' | 'now'
  >,
  provider: RetrievalProvider,
): AsyncIterable<import('@research-portal/core').AskEvent> {
  let modelId: string | undefined, storeId: string | undefined
  try {
    modelId = await provider.generativeModel?.(options.config)
  } catch { /* Unknown model. */ }
  try {
    storeId = provider.storeIdentifier?.(options.config)
  } catch { /* Unknown store. */ }
  const recorder = new AnswerRecorder({
    store: options.store,
    portal: options.config.slug,
    question: options.question,
    surface: 'composed',
    modelId,
    storeId,
    buildId: options.buildId,
    now: options.now,
  })
  let terminal: import('@research-portal/core').AskEvent | undefined
  let completed = false
  try {
    for await (
      const event of recorder.provider(provider).ask(options.config, options.question, {})
    ) {
      recorder.observe(event)
      if (event.type === 'done') terminal = event
      else yield event
    }
    const answerId = recorder.finish()
    completed = true
    yield { type: 'answer-record', answerId }
    if (terminal) yield terminal
  } catch (error) {
    recorder.finish('error')
    completed = true
    throw error
  } finally {
    if (!completed) recorder.finish('cancelled')
  }
}
