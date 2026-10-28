import type { AnswerRecord } from '@research-portal/core'
import { AnswerRecorder } from './answer-recorder.ts'
import { transientAnswerRecordStore } from './answer-record-store.ts'

/** Test fixture through the real recorder, with no retrieval or service calls. */
export function answerRecordFixture(portal = 'marine', now = Date.now()): AnswerRecord {
  const store = transientAnswerRecordStore(() => now)
  const recorder = new AnswerRecorder({
    store,
    portal,
    question: 'How is stock health measured?',
    surface: 'ask',
    now: () => now,
    modelId: 'fixture-model',
  })
  recorder.query('stock health')
  recorder.observe({ type: 'done', text: 'Stock health is surveyed.' })
  recorder.finish()
  return store.get(portal, recorder.answerId)!
}
