import type { AgentAskEvent } from '@research-portal/core'
import { agentAnswer, type AgentAnswerOptions } from './agent-compose.ts'
import { AgentAnswerRecorder } from './agent-answer-recorder.ts'
import type { AnswerRecordStoreApi } from './answer-record-store.ts'

/** Same persist-before-terminal contract as recordComposedSource, owned by the host portal. */
export async function* recordAgentAnswer(
  options: AgentAnswerOptions & { store: AnswerRecordStoreApi; buildId?: string },
): AsyncGenerator<AgentAskEvent> {
  const recorder = new AgentAnswerRecorder({
    store: options.store,
    portal: options.host.slug,
    question: options.question,
    surface: 'agent',
    buildId: options.buildId,
    now: options.now,
  })
  let committed = false
  let ended = false
  try {
    for await (const event of agentAnswer({ ...options, onVerification: recorder.verification })) {
      if (options.signal?.aborted) return
      if (event.type === 'answer-record') continue
      recorder.observeAgent(event)
      if (event.type === 'done' || event.type === 'error') {
        await recorder.identify(options.provider, options.host)
        const answerId = recorder.finish()
        committed = true
        yield { type: 'answer-record', answerId }
        yield event
        return
      }
      yield event
    }
    ended = true
  } catch (error) {
    if (!committed) {
      recorder.finish('error')
      committed = true
    }
    throw error
  } finally {
    if (!committed) recorder.finish(options.signal?.aborted || !ended ? 'cancelled' : 'error')
  }
}
