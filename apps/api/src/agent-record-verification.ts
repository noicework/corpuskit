import type { AgentChunk, AgentSource, AnswerRecord } from '@research-portal/core'
import type { BindResult } from './citation-binding.ts'

type Decision = NonNullable<AnswerRecord['agent']>['citationDecisions'][number]

/** Preserve the gate's decisions per sentence, including rejected and rebound markers. */
export function agentRecordVerification(input: {
  text: string
  bound: BindResult
  gathered: { source: AgentSource; chunk: AgentChunk }[]
  removed: ReadonlySet<number>
}) {
  const { text, bound, gathered, removed } = input
  const originalFor = (final: number) => {
    const citation = bound.citations.find((c) => c.index === final)
    return gathered.findIndex((entry) => entry.chunk.id === citation?.resourceId) + 1
  }
  const decisions: Decision[] = []
  const decide = (marker: string, sentenceIndex?: number): Decision => {
    const entry = gathered[Number(marker) - 1]
    const final = entry && bound.citations.find((c) => c.resourceId === entry.chunk.id)
    const kept = sentenceIndex !== undefined && !removed.has(sentenceIndex) && final &&
      bound.sentences[sentenceIndex]!.bound.includes(final.index)
    return {
      marker,
      ...(entry ? { sourceId: entry.source.id, chunkId: entry.chunk.id } : {}),
      ...(kept ? { finalMarker: String(final.index) } : {}),
      ...(sentenceIndex !== undefined ? { sentenceIndex } : {}),
      outcome: kept ? 'kept' : 'dropped',
    }
  }
  bound.sentences.forEach((sentence, index) => {
    const markers = new Set([
      ...sentence.original ?? [],
      ...sentence.block ?? [],
      ...sentence.bound.map(originalFor).filter((n) => n > 0),
    ])
    for (const marker of markers) decisions.push(decide(String(marker), index))
  })
  // Headings and malformed/out-of-range markers may not reach a bound sentence.
  const seen = new Set(decisions.map((d) => d.marker))
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    if (!seen.has(match[1]!)) {
      decisions.push(decide(match[1]!))
      seen.add(match[1]!)
    }
  }
  return {
    decisions,
    sentencesChecked: bound.sentences.length,
    sentencesCited: bound.sentences.filter((s, i) => !removed.has(i) && s.bound.length).length,
    sentencesDropped: removed.size,
  }
}
