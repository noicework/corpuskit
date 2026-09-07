/**
 * Deterministic checks on an investigation synthesis
 * (review loop 2 D2-16): every numbered reference
 * is either cited in the brief or listed as not used, so a reader never
 * wonders what happened to passage [3].
 */

export interface SynthesisText {
  summary?: string
  supported?: string[]
  contested?: string[]
  gaps?: string[]
}

/** The reference numbers a synthesis cites anywhere in its text. */
export function citedReferences(brief: SynthesisText): Set<number> {
  const text = [
    brief.summary ?? '',
    ...(brief.supported ?? []),
    ...(brief.contested ?? []),
    ...(brief.gaps ?? []),
  ].join('\n')
  const out = new Set<number>()
  for (const m of text.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const n of m[1]!.split(',')) out.add(Number(n.trim()))
  }
  return out
}

/** Reference numbers from 1 to `count` the brief never cites, ascending. */
export function unusedReferences(brief: SynthesisText, count: number): number[] {
  const cited = citedReferences(brief)
  const out: number[] = []
  for (let n = 1; n <= count; n++) if (!cited.has(n)) out.push(n)
  return out
}

/**
 * The denominators a kept passage carries - "n = 1644", "2698/4201",
 * "(4273/4721)", "60 patients" - so the prompt can name what each
 * statement must carry.
 */
export function passageDenominators(passage: string): string[] {
  const out: string[] = []
  for (
    const m of passage.matchAll(
      /\bn\s*=\s*\d[\d,]*|\b\d[\d,]*\s*\/\s*\d[\d,]*\b|\b\d[\d,]*\s+(?:patients|participants|adults|children|cases|controls|subjects|people|individuals)\b/gi,
    )
  ) {
    const value = m[0].replace(/\s+/g, ' ').trim()
    if (!out.includes(value)) out.push(value)
  }
  return out
}
