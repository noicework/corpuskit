import type { TopicUsage, UsageCounts } from '@research-portal/core'
import type { AskInsight, UsageEvent } from './stores.ts'
import { percentile, type UsageSources } from './usage-report.ts'

type DiscoveryCounts = Pick<
  UsageCounts,
  | 'topics'
  | 'searches'
  | 'searchP50'
  | 'searchP90'
  | 'searchP95'
  | 'opens'
  | 'openRate'
  | 'meanOpenRank'
>

/** Counts are derived from citation metadata, never inferred from question text. */
export function discoveryCounts(
  asks: readonly AskInsight[] | null,
  events: readonly UsageEvent[] | null,
  sources: Pick<UsageSources, 'catalogue' | 'topics'>,
): DiscoveryCounts {
  if (!asks || !events) {
    return {
      topics: null,
      searches: null,
      searchP50: null,
      searchP90: null,
      searchP95: null,
      opens: null,
      openRate: null,
      meanOpenRank: null,
    }
  }
  const searches = events.filter((e) => e.kind === 'search')
  const opens = events.filter((e) => e.kind === 'open')
  const times = searches.map((e) => e.durationSec).filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)
  const eligible = new Set([
    ...asks.filter((a) => a.answered && a.citedResources?.length && a.answerId)
      .map((a) => `answer:${a.answerId}`),
    ...searches.filter((s) => s.resources.length > 0).map((s) => `search:${s.id}`),
  ])
  const opened = new Set(
    opens.map((e) => `${e.source}:${e.sourceId}`).filter((id) => eligible.has(id)),
  )
  const topicCounts = new Map<string, { questions: number }>()
  for (const topic of sources.topics ?? []) {
    topicCounts.set(topic.id, { questions: 0 })
  }
  for (const ask of asks.filter((a) => a.answered)) {
    const seen = new Set<string>()
    for (const resource of ask.citedResources ?? []) {
      for (const id of resource.topicIds) {
        const topic = topicCounts.get(id) ?? { questions: 0 }
        if (!seen.has(id)) topic.questions++
        seen.add(id)
        topicCounts.set(id, topic)
      }
    }
  }
  const cited = new Set(
    asks.filter((a) => a.answered).flatMap((a) => a.citedResources ?? []).map((r) => r.resourceId),
  )
  // Coverage joins citations to the current catalogue, so deleted documents never inflate it.
  const topics: TopicUsage[] = [...topicCounts].map(([id, topic]) => {
    const current = sources.catalogue
      ? new Set(sources.catalogue.filter((r) => r.topicIds.includes(id)).map((r) => r.id))
      : null
    return {
      id,
      label: sources.topics?.find((t) => t.id === id)?.label ?? id,
      questions: topic.questions,
      citedDocuments: current ? [...current].filter((r) => cited.has(r)).length : null,
      totalDocuments: current?.size ?? null,
    }
  }).sort((a, b) => b.questions - a.questions || a.id.localeCompare(b.id))
  return {
    topics,
    searches: searches.length,
    searchP50: percentile(times, 50),
    searchP90: percentile(times, 90),
    searchP95: percentile(times, 95),
    opens: opens.length,
    openRate: eligible.size ? opened.size / eligible.size : null,
    meanOpenRank: opens.length ? opens.reduce((sum, e) => sum + e.rank, 0) / opens.length : null,
  }
}
