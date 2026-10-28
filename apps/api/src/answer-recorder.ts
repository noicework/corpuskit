import {
  type AnswerRecord,
  type AnswerRecordCall,
  type AnswerRecordPassage,
  type AskEvent,
  type Citation,
  type ScoredResource,
} from '@research-portal/core'
import { intentConfigurationName, type RetrievalProvider } from '@research-portal/retrieval'
import type { TenantConfig } from '@research-portal/core'
import type { AskOptions } from '../../../packages/retrieval/src/provider.ts'
import type { AnswerRecordStoreApi } from './answer-record-store.ts'
import { redactAnswerRecordText } from './answer-record-redaction.ts'

const MAX_PASSAGES = 160
const MAX_TEXT = 2000
const MAX_QUERIES = 100
const MAX_CALLS = 200

/** Server-only recorder. Never pass request headers, identity, cookies or a request body to it. */
export class AnswerRecorder {
  readonly answerId = crypto.randomUUID()
  private readonly started: number
  private readonly value: AnswerRecord
  private readonly rawCitations = new Set<string>()
  private readonly finalCitations = new Map<number, Citation>()
  private readonly passageKeys = new Set<string>()
  private committed = false

  constructor(
    private readonly options: {
      store: AnswerRecordStoreApi
      portal: string
      question: string
      surface: AnswerRecord['surface']
      modelId?: string | null
      buildId?: string | null
      storeId?: string | null
      now?: () => number
    },
  ) {
    this.started = this.now()
    this.value = {
      version: 1,
      answerId: this.answerId,
      at: new Date(this.started).toISOString(),
      portal: options.portal,
      question: this.text(options.question, 8000),
      surface: options.surface,
      status: 'cancelled',
      retrievalQueries: [],
      retrieved: [],
      cited: [],
      verification: {
        citationsSeen: 0,
        citationsDropped: 0,
        sentencesChecked: null,
        sentencesCited: null,
        sentencesDropped: 0,
        figuresDropped: [],
        unsupportedFigures: [],
        unsupportedYears: [],
        unsupportedContraindications: [],
        outcome: 'not_reported',
      },
      generation: {
        modelId: options.modelId ?? null,
        buildId: options.buildId ?? null,
        configurationIds: [],
        promptHashes: [],
        depth: 'default',
        images: false,
        topK: null,
        maxTokens: null,
      },
      quality: { answerRelevance: null, groundedness: null, contextRelevance: null },
      timing: {
        durationMs: 0,
        providerTotalSec: null,
        firstChunkSec: null,
        inputTokens: null,
        outputTokens: null,
      },
      calls: [],
      truncated: options.question.length > 8000,
    }
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private text(value: string, limit = MAX_TEXT): string {
    if (value.length > limit && this.value) this.value.truncated = true
    return redactAnswerRecordText(value.slice(0, limit))
  }
  query(query: string): void {
    const text = this.text(query, 8000)
    if (this.value.retrievalQueries.includes(text)) return
    if (this.value.retrievalQueries.length < MAX_QUERIES) this.value.retrievalQueries.push(text)
    else this.value.truncated = true
  }
  retrieved(resources: ScoredResource[]): void {
    for (const resource of resources) {
      const passages = resource.passages?.length
        ? resource.passages
        : resource.matchedPassage
        ? [{ text: resource.matchedPassage, page: resource.matchedPage }]
        : []
      for (const passage of passages) {
        const key = JSON.stringify([resource.id, passage.page, passage.text])
        if (this.passageKeys.has(key)) continue
        if (this.value.retrieved.length >= MAX_PASSAGES) {
          this.value.truncated = true
          continue
        }
        this.passageKeys.add(key)
        this.value.retrieved.push({
          resourceId: this.text(resource.id, 256),
          title: this.text(resource.title, 300),
          text: this.text(passage.text),
          page: passage.page ?? null,
          score: resource.relevance,
          scoreScope: 'resource',
        })
      }
    }
  }
  /** A composed route calls this once for each peer/source, including failures. */
  call(call: AnswerRecordCall): void {
    if (this.value.calls.length >= MAX_CALLS) {
      this.value.truncated = true
      return
    }
    this.value.calls.push({
      source: this.text(call.source, 200),
      storeId: call.storeId ? this.text(call.storeId, 256) : null,
      operation: this.text(call.operation, 100),
      status: call.status,
      durationMs: call.durationMs,
    })
  }
  async configuration(options: AskOptions, tenant?: TenantConfig): Promise<void> {
    const ids = options.docScope ? ['portal-doc-ask'] : options.intent
      ? [
        tenant
          ? intentConfigurationName(tenant, options.intent, 'ask')
          : `portal-intent-${options.intent}`,
      ]
      : ['portal-ask']
    for (const id of ids) {
      if (!this.value.generation.configurationIds.includes(id)) {
        this.value.generation.configurationIds.push(id)
      }
    }
    this.value.generation.depth = options.depth ?? 'default'
    this.value.generation.images = options.images ?? false
    this.value.generation.topK = options.topK ?? null
    this.value.generation.maxTokens = options.maxTokens ?? null
    for (const prompt of [options.systemPrompt, options.promptAddendum]) {
      if (!prompt) continue
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt))
      const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
      if (!this.value.generation.promptHashes.includes(hash)) {
        this.value.generation.promptHashes.push(hash)
      }
    }
    for (
      const query of [
        ...options.prequeries ?? [],
        ...options.pinnedQueries ?? [],
        ...(options.scopedQueries ?? []).map((q) => q.query),
      ]
    ) this.query(query)
  }
  /** Provider events retain retrieval and rejected citations before the portal's trust layer. */
  providerEvent(event: AskEvent): void {
    if (event.type === 'sources') this.retrieved(event.resources)
    if (event.type === 'citation') {
      this.rawCitations.add(
        JSON.stringify([
          this.text(event.citation.resourceId, 256),
          this.text(event.citation.passage ?? ''),
        ]),
      )
    }
    if (event.type === 'searched') { for (const query of event.queries) this.query(query) }
    if (event.type === 'interpreted') this.query(event.query)
    if (event.type === 'quality') {
      this.value.quality = {
        answerRelevance: event.answerRelevance,
        groundedness: event.groundedness,
        contextRelevance: event.contextRelevance,
      }
    }
    if (event.type === 'usage') {
      Object.assign(this.value.timing, {
        providerTotalSec: event.totalSec ?? null,
        firstChunkSec: event.firstChunkSec ?? null,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      })
    }
  }
  /** Final events reflect the exact citations and verification delivered to the reader. */
  observe(event: AskEvent): void {
    if (event.type === 'citation') this.finalCitations.set(event.citation.index, event.citation)
    if (event.type === 'audit') {
      Object.assign(this.value.verification, {
        outcome: 'checked',
        sentencesChecked: event.sentencesChecked ?? null,
        sentencesCited: event.sentencesCited ?? null,
        sentencesDropped: event.sentencesRemoved ?? 0,
        figuresDropped: event.figuresRemoved ?? [],
        unsupportedFigures: event.figuresUnsupported,
        unsupportedYears: event.yearsUnsupported,
        unsupportedContraindications: event.contraindicationsUnsupported,
      })
    }
    if (event.type === 'error') this.value.status = 'error'
    if (event.type === 'done') {
      this.value.status = event.refused ? 'refused' : 'answered'
      // Only keep citation markers that survived the final sentence gate.
      if (event.text !== undefined) {
        const used = new Set([...event.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
        for (const index of this.finalCitations.keys()) {
          if (!used.has(index)) this.finalCitations.delete(index)
        }
      }
      if (event.refused) this.finalCitations.clear()
    }
  }
  /** Save before publishing the record event. A storage failure must fail the answer stream. */
  finish(status?: AnswerRecord['status']): string {
    if (this.committed) return this.answerId
    if (status) this.value.status = status
    this.value.cited = [...this.finalCitations.values()].slice(0, MAX_PASSAGES).map(
      (citation): AnswerRecordPassage => {
        const match = this.value.retrieved.find((p) =>
          !!citation.passage && p.resourceId === citation.resourceId &&
          p.text.includes(this.text(citation.passage ?? ''))
        )
        return {
          resourceId: this.text(citation.resourceId, 256),
          title: this.text(citation.title, 300),
          text: this.text(citation.passage ?? ''),
          citationIndex: citation.index,
          page: match?.page ?? null,
          score: match?.score ?? null,
          scoreScope: match?.scoreScope ?? 'unknown',
        }
      },
    )
    this.value.verification.citationsSeen = this.rawCitations.size
    const finalKeys = new Set(this.value.cited.map((c) => JSON.stringify([c.resourceId, c.text])))
    this.value.verification.citationsDropped =
      [...this.rawCitations].filter((key) => !finalKeys.has(key)).length
    this.value.timing.durationMs = Math.max(0, this.now() - this.started)
    while (new TextEncoder().encode(JSON.stringify(this.value)).byteLength > 384 * 1024) {
      this.value.truncated = true
      if (this.value.retrieved.length) this.value.retrieved.pop()
      else if (this.value.cited.length) this.value.cited.pop()
      else if (this.value.retrievalQueries.length) this.value.retrievalQueries.pop()
      else if (this.value.calls.length) this.value.calls.pop()
      else throw new Error('Answer evidence exceeds storage bound')
    }
    this.options.store.record(this.options.portal, this.value)
    this.committed = true
    return this.answerId
  }
  /** The same RetrievalProvider interface, instrumenting only ask and search. No extra calls. */
  provider(provider: RetrievalProvider): RetrievalProvider {
    const instrument = (recorder: AnswerRecorder) =>
      new Proxy(provider, {
        get(target, key) {
          if (key === 'ask') {
            return async function* (...args: Parameters<RetrievalProvider['ask']>) {
              const [tenant, question, options = {}] = args
              recorder.query(question)
              await recorder.configuration(options, tenant)
              const started = recorder.now()
              let status: AnswerRecordCall['status'] = 'cancelled'
              try {
                for await (const event of target.ask(tenant, question, options)) {
                  recorder.providerEvent(event)
                  if (event.type === 'error') status = 'error'
                  yield event
                }
                if (status !== 'error') status = 'ok'
              } catch (error) {
                status = 'error'
                throw error
              } finally {
                recorder.call({
                  source: tenant.slug,
                  storeId: recorder.options.storeId ?? null,
                  operation: 'ask',
                  status,
                  durationMs: Math.max(0, recorder.now() - started),
                })
              }
            }
          }
          if (key === 'search') {
            return async (...args: Parameters<RetrievalProvider['search']>) => {
              recorder.query(args[1])
              const started = recorder.now()
              let status: AnswerRecordCall['status'] = 'error'
              try {
                const result = await target.search(...args)
                recorder.retrieved(result.resources)
                status = 'ok'
                return result
              } finally {
                recorder.call({
                  source: args[0].slug,
                  storeId: recorder.options.storeId ?? null,
                  operation: 'search',
                  status,
                  durationMs: Math.max(0, recorder.now() - started),
                })
              }
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    return instrument(this)
  }
}
