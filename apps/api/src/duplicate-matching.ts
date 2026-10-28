import type { DuplicateCandidate, DuplicateItem } from '@research-portal/core'

export const MAX_REVIEW_ITEMS = 5_000
const MAX_COMPARISONS = 50_000
const MAX_CANDIDATES = 5_000

export function normaliseTitle(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

/** Preserve meaningful query parameters; only known tracking parameters and fragments go. */
export function normaliseOrigin(value?: string): string {
  try {
    const url = new URL(value ?? '')
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.hash = ''
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name)
    }
    url.searchParams.sort()
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch {
    return ''
  }
}

function shingles(value: string): Set<string> {
  const words = normaliseTitle(value).split(' ').filter(Boolean).slice(0, 150)
  return new Set(words.slice(1).map((word, i) => `${words[i]} ${word}`))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection++
  return intersection / (left.size + right.size - intersection)
}

export function pairId(left: string, right: string): string {
  return [left, right].sort().map(encodeURIComponent).join('/')
}

function prepare(item: DuplicateItem) {
  return {
    item,
    title: normaliseTitle(item.title),
    origin: normaliseOrigin(item.originUrl),
    name: normaliseTitle(item.sourceName ?? ''),
    titleShingles: shingles(item.title),
    textShingles: shingles(`${item.title} ${item.summary}`),
  }
}
type Prepared = ReturnType<typeof prepare>

/** Cheap, explainable metadata evidence. A score is a heuristic, never a probability. */
export function matchItems(left: DuplicateItem, right: DuplicateItem): DuplicateCandidate | null {
  return matchPrepared(prepare(left), prepare(right))
}

function matchPrepared(a: Prepared, b: Prepared): DuplicateCandidate | null {
  const left = a.item, right = b.item
  const reasons: string[] = []
  const signals: DuplicateCandidate['signals'] = []
  let score = 0
  if (a.title && a.title === b.title) {
    reasons.push('Same normalised title')
    signals.push('title')
    score = 0.95
  }
  if (a.origin && a.origin === b.origin) {
    reasons.push('Same origin URL after removing tracking parameters')
    signals.push('url')
    score = Math.max(score, 0.98)
  }
  if (a.name && a.name === b.name) {
    reasons.push('Same source file name (file bytes have not been compared)')
    signals.push('filename')
    score = Math.max(score, 0.8)
  }
  const titleSimilarity = jaccard(a.titleShingles, b.titleShingles)
  const similarity = jaccard(a.textShingles, b.textShingles)
  if (titleSimilarity >= 0.6 && similarity >= 0.7) {
    reasons.push(`Similar title and summary shingles (${Math.round(similarity * 100)}%)`)
    signals.push('similarity')
    score = Math.max(score, similarity)
  }
  if (!signals.length) return null
  if (left.published && right.published && left.published !== right.published) {
    reasons.push('Different publication dates: possible versions')
  }
  return { id: pairId(left.id, right.id), left, right, score, reasons, signals }
}

/**
 * Inverted shingle blocks avoid an all-resource Cartesian scan. Every high-similarity pair
 * shares at least one title shingle. Work and output caps are explicit in the report.
 */
export function findCandidates(
  items: readonly DuplicateItem[],
  crossAt?: number,
): { candidates: DuplicateCandidate[]; limited: boolean } {
  const blocks = new Map<string, number[]>()
  const compared = new Set<string>()
  const candidates: DuplicateCandidate[] = []
  let limited = items.length > MAX_REVIEW_ITEMS
  // When comparing large collections, sample both sides rather than dropping one side.
  const leftLimit = crossAt === undefined
    ? MAX_REVIEW_ITEMS
    : Math.min(crossAt, MAX_REVIEW_ITEMS - Math.min(items.length - crossAt, MAX_REVIEW_ITEMS / 2))
  const selectedItems = crossAt === undefined ? items.slice(0, MAX_REVIEW_ITEMS) : [
    ...items.slice(0, leftLimit),
    ...items.slice(crossAt, crossAt + MAX_REVIEW_ITEMS - leftLimit),
  ]
  const boundary = crossAt === undefined ? undefined : leftLimit
  const selected = selectedItems.map(prepare)
  outer: for (let i = 0; i < selected.length; i++) {
    const item = selected[i]!
    const keys = new Set([
      `title:${item.title}`,
      ...(item.origin ? [`url:${item.origin}`] : []),
      ...(item.name ? [`file:${item.name}`] : []),
      ...[...item.titleShingles].map((s) => `shingle:${s}`),
    ])
    for (const key of keys) {
      const previous = blocks.get(key) ?? []
      for (const j of previous) {
        if (boundary !== undefined && (j < boundary) === (i < boundary)) continue
        const pair = `${j}:${i}`
        if (compared.has(pair)) continue
        if (compared.size >= MAX_COMPARISONS || candidates.length >= MAX_CANDIDATES) {
          limited = true
          break outer
        }
        compared.add(pair)
        const candidate = matchPrepared(selected[j]!, item)
        if (candidate) candidates.push(candidate)
      }
      previous.push(i)
      blocks.set(key, previous)
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return { candidates, limited }
}
