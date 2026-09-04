import type { FacetCounts, Topic } from '@research-portal/core'

export interface TopicRow {
  topic: Topic
  count: number
}

/**
 * Non-empty topic rows for Explore, from the tenant's configured topics and
 * the box's real classification facet counts - never from a resource's own
 * `topicIds` (the DA classifier's labels don't reliably land there; see
 * `AragProvider.topicResources`'s doc comment). A topic with a zero or
 * missing facet count is dropped; nothing here implies the box has no
 * content overall, only that none of its resources carry that topic label.
 */
export function topicsWithFacetCounts(topics: Topic[], facets: FacetCounts): TopicRow[] {
  const counts = facets.topic ?? {}
  return topics
    .map((topic) => ({ topic, count: counts[topic.id] ?? 0 }))
    .filter((row): row is TopicRow => row.count > 0)
}
