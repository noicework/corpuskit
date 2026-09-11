/** Preserve an authored shared citation only after every sentence has passed the existing audit. */
import type { Citation } from '@research-portal/core'
import {
  type BindResult,
  type BoundSentence,
  prepareText,
  sentenceFeatures,
  supportScore,
} from './citation-binding.ts'
import { paragraphsOf } from './evidence-passages.ts'

export interface AuthoredCitationGroup {
  line: number
  prefix: string
  sentences: string[]
  resources: string[]
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i])

const resourcesFor = (markers: readonly number[], citations: readonly Citation[]) =>
  markers.map((index) => citations.find((c) => c.index === index)?.resourceId ?? '').sort()

/**
 * Snapshot the model's one tail group, not runs of repeated citation numbers.
 * Every sentence must retain exactly that support, and each cited resource
 * must have one bounded original passage that supports ALL group members.
 */
export function captureAuthoredGroups(
  bound: BindResult,
  texts: ReadonlyMap<number, string>,
  lexicon: readonly string[],
): AuthoredCitationGroup[] {
  const groups: AuthoredCitationGroup[] = []
  // Request-local, matching the evidence-card passage budget. An answer with
  // many groups must not re-parse an entire PDF for each group.
  const passageCache = new Map<number, ReturnType<typeof prepareText>[]>()
  const passagesFor = (marker: number) => {
    let prepared = passageCache.get(marker)
    if (!prepared) {
      const source = texts.get(marker)
      prepared = source === undefined ? [] : paragraphsOf(source).slice(0, 400).map(prepareText)
      passageCache.set(marker, prepared)
    }
    return prepared
  }
  for (const [lineIndex, line] of bound.layout.entries()) {
    if (line.kind !== 'sentences' || line.sentences.length < 2 || line.sentences.length > 4) {
      continue
    }
    const sentences = line.sentences.map((i) => bound.sentences[i]!)
    if (sentences.reduce((n, s) => n + s.text.length, 0) > 900) continue
    if (sentences.some((s) => s.original?.length || !s.block?.length)) continue
    const markers = [...new Set(sentences[0]!.block)].sort((a, b) => a - b)
    const markerKeys = markers.map(String)
    if (
      sentences.some((s) =>
        !same(s.bound.map(String), markerKeys) ||
        !same([...new Set(s.block)].sort((a, b) => a - b).map(String), markerKeys)
      )
    ) continue
    const features = sentences.map((s) => sentenceFeatures(s.text, lexicon))
    // Keep immediate citations on quotes, numbers and explicitly reported findings.
    if (
      features.some((f) => f.numbers.length > 0 || f.designs.length > 0) ||
      sentences.some((s) =>
        /["“”]|(?:^|\s)['‘].+['’]|\b(?:found|observed|reported|demonstrated|measured|estimated)\b/i
          .test(s.text)
      )
    ) continue
    if (
      !markers.every((marker) =>
        passagesFor(marker).some((prepared) =>
          features.every((f) => supportScore(f, prepared) >= 0.6)
        )
      )
    ) continue
    const resources = resourcesFor(markers, bound.citations)
    if (resources.includes('')) continue
    groups.push({
      line: lineIndex,
      prefix: line.prefix,
      sentences: sentences.map((s) => s.text),
      resources,
    })
  }
  return groups
}

/** A final display-only pass. Any changed/removed/rebound member invalidates its entire group. */
export function compactAuthoredGroups(
  text: string,
  groups: readonly AuthoredCitationGroup[],
  sentences: readonly BoundSentence[],
  citations: readonly Citation[],
): string {
  const lines = text.split('\n')
  for (const group of groups) {
    const current = sentences.filter((s) => s.line === group.line)
    if (!same(current.map((s) => s.text), group.sentences)) continue
    if (current.some((s) => !same(resourcesFor(s.bound, citations), group.resources))) continue
    const marked = group.prefix +
      current.map((s) => `${s.text}${s.bound.map((n) => `[${n}]`).join('')}`).join(' ')
    const matches = lines.flatMap((line, i) => line === marked ? [i] : [])
    // An ambiguous repeated line is not enough proof of position after rewrites.
    if (matches.length !== 1) continue
    const last = current[current.length - 1]!
    lines[matches[0]!] = group.prefix + current.map((s) => s.text).join(' ') +
      last.bound.map((n) => `[${n}]`).join('')
  }
  return lines.join('\n')
}
