import type {
  AgentAskEvent,
  AgentSource,
  AnswerRecord,
  AnswerRecordPassage,
  TenantConfig,
} from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import { AnswerRecorder } from './answer-recorder.ts'
import type { AgentAnswerOptions } from './agent-compose.ts'

type Evidence = NonNullable<AnswerRecord['agent']>
const LIMIT = 200

/** Agent contract adapter over the existing bounded, audited answer recorder. No credentials. */
export class AgentAnswerRecorder extends AnswerRecorder {
  private readonly stepStarts = new Map<string, number>()
  private readonly evidence: Evidence = {
    mode: null,
    sources: [],
    steps: [],
    lookups: [],
    failedSources: [],
    citationCheck: 'not_reported',
    citationDecisions: [],
  }

  constructor(options: ConstructorParameters<typeof AnswerRecorder>[0]) {
    super(options)
    this.value.agent = this.evidence
  }

  async identify(provider: RetrievalProvider, host: TenantConfig): Promise<void> {
    try {
      this.value.generation.modelId =
        this.text(await provider.generativeModel?.(host) ?? '', 256) || null
    } catch { /* Unknown identifiers stay explicit. */ }
    for (const source of this.evidence.sources) {
      if (source.peerId) {
        const peer = host.federation?.peers?.find((p) => p.id === source.peerId)
        if (peer?.zone && peer.kbId) {
          source.storeId = this.text(peer.kbId, 256)
          source.endpoint = this.text(
            `https://${peer.zone}.dp.progress.cloud/api/v1/kb/${peer.kbId}/${
              peer.kind === 'arag-mcp' ? 'mcp' : 'find'
            }`,
          )
          this.storeIds.set(source.id, source.storeId)
        }
      }
      if (!source.portal) continue
      try {
        const storeId = provider.storeIdentifier?.({ ...host, slug: source.portal })
        source.storeId = storeId ? this.text(storeId, 256) : null
        if (source.storeId) this.storeIds.set(source.id, source.storeId)
      } catch { /* Unknown identifiers stay explicit. */ }
    }
  }
  private readonly storeIds = new Map<string, string>()

  protected override text(value: string, limit = 2000): string {
    const text = super.text(value, limit)
    if (value.length > limit && this.value) this.truncate('text')
    return text
  }

  override query(query: string): void {
    const text = this.text(query, 8000)
    if (this.value.retrievalQueries.length >= 100 && !this.value.retrievalQueries.includes(text)) {
      this.truncate('retrievalQueries')
    }
    super.query(query)
  }

  private append<T>(items: T[], item: T, field: string, limit = LIMIT): void {
    if (items.length < limit) items.push(item)
    else this.truncate(field)
  }

  private source(source: AgentSource): void {
    if (this.evidence.sources.some((s) => s.id === this.text(source.id, 256))) return
    this.append(this.evidence.sources, {
      id: this.text(source.id, 256),
      label: this.text(source.label, 300),
      ...(source.portal ? { portal: this.text(source.portal, 256) } : {}),
      ...(source.kind === 'peer'
        ? { peerId: this.text(source.id.replace(/^peer:/, ''), 256) }
        : {}),
      kind: source.kind ?? (source.portal ? 'hosted' : null),
      transport: source.transport ?? (source.kind === 'hosted' || source.portal ? 'kb' : null),
    }, 'agent.sources')
  }

  private lookup(stepId: string, sourceId: string, question: string): void {
    const item = {
      stepId: this.text(stepId, 256),
      sourceId: this.text(sourceId, 256),
      question: this.text(question, 8000),
    }
    if (this.evidence.lookups.some((v) => JSON.stringify(v) === JSON.stringify(item))) return
    this.query(question)
    this.append(this.evidence.lookups, item, 'agent.lookups')
  }

  readonly verification: NonNullable<AgentAnswerOptions['onVerification']> = (check) => {
    this.evidence.citationCheck = 'checked'
    this.value.verification.outcome = 'checked'
    Object.assign(this.value.verification, {
      sentencesChecked: check.sentencesChecked,
      sentencesCited: check.sentencesCited,
      sentencesDropped: check.sentencesDropped,
    })
    for (const decision of check.decisions) {
      this.append(this.evidence.citationDecisions, {
        marker: this.text(decision.marker, 256),
        ...(decision.sourceId ? { sourceId: this.text(decision.sourceId, 256) } : {}),
        ...(decision.chunkId ? { chunkId: this.text(decision.chunkId, 256) } : {}),
        ...(decision.finalMarker ? { finalMarker: this.text(decision.finalMarker, 256) } : {}),
        ...(decision.sentenceIndex !== undefined ? { sentenceIndex: decision.sentenceIndex } : {}),
        outcome: decision.outcome,
      }, 'agent.citationDecisions')
    }
    this.value.verification.citationsSeen = check.decisions.length
    this.value.verification.citationsDropped =
      check.decisions.filter((d) => d.outcome === 'dropped').length
  }

  observeAgent(event: AgentAskEvent): void {
    const agent = this.evidence
    if (event.type === 'agent-start') {
      agent.mode = event.mode
      this.value.surface = event.mode === 'agent' ? 'agent' : 'composed'
      this.value.generation.configurationIds = event.mode === 'agent'
        ? ['agent-ask']
        : ['portal-search', 'agent-compose-v1', 'citation-binding-v1']
      this.query(this.value.question)
      for (const source of event.sources) this.source(source)
    }
    if (event.type === 'agent-step') {
      const id = this.text(event.id, 256)
      let step = agent.steps.find((s) => s.id === id)
      if (!step) {
        if (agent.steps.length >= LIMIT) {
          this.truncate('agent.steps')
          return
        }
        step = {
          id,
          module: this.text(event.module, 100),
          title: this.text(event.title, 300),
          status: event.status,
          durationMs: null,
        }
        agent.steps.push(step)
      }
      if (event.status === 'started') this.stepStarts.set(id, this.now())
      step.status = event.status
      step.durationMs = event.elapsedMs ??
        (event.status === 'started'
          ? null
          : Math.max(0, this.now() - (this.stepStarts.get(id) ?? this.now())))
      if (event.reason) step.reason = this.text(event.reason)
      // Composed searches all receive the original question, including those that fail.
      if (agent.mode === 'orchestrated' && event.module === 'search') {
        const source = agent.sources.find((s) => `source/${s.id}` === id)
        if (source) this.lookup(id, source.id, this.value.question)
      }
    }
    if (event.type === 'agent-sources') {
      this.source(event.source)
      this.lookup(event.stepId, event.source.id, event.question ?? this.value.question)
      for (const chunk of event.chunks) {
        this.append(
          this.value.retrieved,
          {
            sourceId: this.text(event.source.id, 256),
            chunkId: this.text(chunk.id, 256),
            resourceId: this.text(chunk.resourceId ?? chunk.id, 256),
            ...(event.source.kind === 'peer'
              ? { peerId: this.text(event.source.id.replace(/^peer:/, ''), 256) }
              : {}),
            title: this.text(chunk.title, 300),
            text: this.text(chunk.text),
            ...(chunk.url ? { url: this.text(chunk.url, 2000) } : {}),
            page: null,
            score: null,
            scoreScope: 'unknown',
          },
          'retrieved',
          160,
        )
      }
    }
    if (event.type === 'sources-failed') {
      for (const source of event.sources) {
        this.source(source)
        this.append(agent.failedSources, {
          sourceId: this.text(source.id, 256),
          reason: source.reason,
        }, 'agent.failedSources')
      }
    }
    if (event.type === 'citation') {
      const passage = this.value.retrieved.find((p) =>
        p.sourceId === this.text(event.sourceId, 256) && p.chunkId === this.text(event.chunkId, 256)
      )
      const cited: AnswerRecordPassage = {
        resourceId: passage?.resourceId ?? this.text(event.chunkId, 256),
        sourceId: this.text(event.sourceId, 256),
        chunkId: this.text(event.chunkId, 256),
        ...(passage?.peerId ? { peerId: passage.peerId } : {}),
        title: this.text(event.title, 300),
        text: passage?.text ?? '',
        marker: this.text(event.marker, 256),
        ...(event.url ? { url: this.text(event.url) } : {}),
        page: null,
        score: null,
        scoreScope: 'unknown',
      }
      this.append(this.value.cited, cited, 'cited', 160)
    }
    if (event.type === 'error') {
      this.value.status = event.code === 'cancelled' ? 'cancelled' : 'error'
    }
    if (event.type === 'done') {
      this.value.status = this.value.cited.length ? 'answered' : 'refused'
      this.value.timing.providerTotalSec = event.elapsedMs / 1000
    }
  }

  private prepared = false
  protected override prepare(): void {
    if (this.prepared) return
    this.prepared = true
    for (const step of this.evidence.steps) {
      if (step.status === 'started') {
        step.status = this.value.status === 'answered' || this.value.status === 'refused'
          ? 'completed'
          : 'failed'
        step.durationMs = Math.max(0, this.now() - (this.stepStarts.get(step.id) ?? this.now()))
      }
    }
    for (const lookup of this.evidence.lookups) {
      const step = this.evidence.steps.find((s) => s.id === lookup.stepId)
      const failed = this.evidence.failedSources.some((s) => s.sourceId === lookup.sourceId)
      this.call({
        source: lookup.sourceId,
        storeId: this.storeIds.get(lookup.sourceId) ?? null,
        operation: 'search',
        status: failed || step?.status === 'failed'
          ? 'error'
          : this.value.status === 'cancelled'
          ? 'cancelled'
          : 'ok',
        durationMs: step?.durationMs ?? 0,
      })
    }
    if (this.evidence.citationCheck === 'not_reported') {
      this.value.verification.citationsSeen = this.value.cited.length
    }
  }
}
