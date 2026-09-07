/**
 * Library browse filters and sorting for the catalogue.
 *
 * Pure helpers for the library browse path: the `/catalog` filter grammar
 * (OR within a facet, AND across facets) and the client-side sort the
 * platform cannot do (`sort_field` accepts only created/modified/title, so a
 * publication-date sort runs over the cached listing). Kept UI- and
 * network-free so every rule here is unit-tested.
 * Serves: R16 (PR #5).
 */

import type { CatalogItem } from '@research-portal/core'

export interface CatalogBrowseFilters {
  topicIds?: string[]
  formatIds?: string[]
  kindIds?: string[]
}

type LabelPredicate = { prop: 'label'; labelset: string; label?: string }
type FilterNode = LabelPredicate | { or: FilterNode[] } | { and: FilterNode[] } | {
  not: FilterNode
}

function label(labelset: string, value: string): LabelPredicate {
  return { prop: 'label', labelset, label: value }
}

/** One facet: a single label, or any of several (OR). */
function anyOf(labelset: string, values: string[]): FilterNode | undefined {
  const unique = [...new Set(values.filter(Boolean))]
  if (unique.length === 0) return undefined
  if (unique.length === 1) return label(labelset, unique[0]!)
  return { or: unique.map((v) => label(labelset, v)) }
}

/**
 * The `/catalog` `filter_expression` for a set of facet selections: labels
 * within one facet are ORed (Articles + Video means either), facets are ANDed
 * (a topic AND a format). Verified live against the platform's
 * `{ resource: ... }` keying for `/catalog` (see docs/ARAG-DEV.md). Undefined
 * when nothing is selected, so an unfiltered browse sends no expression.
 */
export function catalogFilterExpression(
  filters: CatalogBrowseFilters,
): { resource: FilterNode } | undefined {
  const parts = [
    anyOf('topic', filters.topicIds ?? []),
    anyOf('format', filters.formatIds ?? []),
    anyOf('kind', filters.kindIds ?? []),
  ].filter((p): p is FilterNode => p !== undefined)
  if (parts.length === 0) return undefined
  return { resource: parts.length === 1 ? parts[0]! : { and: parts } }
}

/** Resources carrying NO label from a labelset - the honest "Untagged" count. */
export function untaggedFilterExpression(labelset: string): { resource: FilterNode } {
  return { resource: { not: { prop: 'label', labelset } } }
}

/** The same OR-within/AND-across semantics applied to already-fetched items. */
export function matchesCatalogFilters(
  item: Pick<CatalogItem, 'topicIds' | 'format' | 'kind'>,
  filters: CatalogBrowseFilters,
): boolean {
  const topics = filters.topicIds ?? []
  const formats = filters.formatIds ?? []
  const kinds = filters.kindIds ?? []
  if (topics.length > 0 && !item.topicIds.some((t) => topics.includes(t))) return false
  if (formats.length > 0 && !(item.format && formats.includes(item.format))) return false
  if (kinds.length > 0 && !(item.kind && kinds.includes(item.kind))) return false
  return true
}

export type CatalogSortField = 'created' | 'modified' | 'title' | 'published'

/**
 * Sort a listing client-side. Publication dates are ISO strings, so a plain
 * string compare orders them; resources with no date always sort last
 * whichever direction is asked for, so "newest published" never opens on a
 * wall of undated records.
 */
export function sortCatalogItems(
  items: CatalogItem[],
  field: CatalogSortField,
  order: 'asc' | 'desc',
): CatalogItem[] {
  const key = (item: CatalogItem): string =>
    field === 'published'
      ? item.published ?? ''
      : field === 'title'
      ? item.title.toLowerCase()
      : item.created ?? ''
  const direction = order === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (field === 'published') {
      if (!ka && kb) return 1
      if (ka && !kb) return -1
    }
    if (ka === kb) return 0
    return ka < kb ? -direction : direction
  })
}

/** One page of a client-side listing. */
export function paginateCatalogItems<T>(items: T[], page: number, pageSize: number): T[] {
  const start = Math.max(0, page) * pageSize
  return items.slice(start, start + pageSize)
}
