/**
 * The grounding set for a briefing (review loop 2
 * D2-06, D1-10). A briefing generated over whatever paragraphs a single
 * retrieval returned presented the papers' introductions - other groups'
 * results - as the consortium's findings, and the papers' own hazard ratios
 * never reached the model. Here the set is built from the platform's
 * outputs, deterministically: one retrieval per named drug or study plus
 * one for the topic chooses the papers; each paper's extracted text is
 * read by section and only its Abstract, Results, Methods and Conclusion
 * paragraphs are kept (the Introduction and Discussion are excluded where
 * the headings allow it); the data-augmentation key takeaways and summary
 * ride along. The blocks go to the structured ask as `extra_context`, each
 * headed by the exact source title the model must name.
 */
import type { ScoredResource } from '@research-portal/core'
import { paragraphsOf } from './evidence-passages.ts'
import { hasBodyHeadings, type Section, sectionAt, sectionSpans } from './secondhand.ts'
import { comparisonEntities, entityQuery, pickEntityPaper } from './ask-entities.ts'
import { distinctiveTerms, isAttachmentTitle } from './study-guard.ts'

/** Papers a briefing grounds on, at most. */
export const MAX_BRIEFING_SOURCES = 6
/** Paragraphs kept per paper. */
export const MAX_PARAGRAPHS_PER_SOURCE = 7
/** Characters per kept paragraph and per source block. */
const PARAGRAPH_CHARS = 1100
const BLOCK_CHARS = 5200

const KEEP: ReadonlySet<Section> = new Set(['abstract', 'results', 'methods', 'conclusion'])

const STOP = new Set([
  'with',
  'from',
  'that',
  'this',
  'study',
  'analysis',
  'using',
  'their',
  'briefing',
  'about',
  'rates',
  'sizes',
  'cohort',
  'patients',
  'were',
  'have',
  'been',
])

function contentWords(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w)),
  )
}

/** Figures in a paragraph: percentages, decimals, ratios, counts with a unit word and effect-size labels. */
function figureDensity(paragraph: string): number {
  const numeric = paragraph.match(
    /\d+(?:\.\d+)?%|\b\d+\.\d+\b|\b\d+\/\d+\b|\bn\s*=\s*\d+|\b\d{2,4}\s+(?:patients|participants|cases|controls|subjects|adults|children)\b/gi,
  ) ?? []
  // Case-sensitive: "or" is a word, "OR" an odds ratio.
  const labels = paragraph.match(/\b(?:HR|OR|RR|aHR|CI)\b/g) ?? []
  return numeric.length + labels.length
}

export interface GroundingParagraph {
  text: string
  section: Section
  score: number
}

/**
 * The paragraphs of an extracted paper worth grounding a briefing on: those
 * in its own-findings sections, ranked by the query's content words and by
 * figure density, the abstract's paragraphs first at equal score. A text
 * without body headings keeps every prose paragraph, ranked the same way.
 */
export function groundingParagraphs(
  text: string,
  query: string,
  max = MAX_PARAGRAPHS_PER_SOURCE,
): GroundingParagraph[] {
  const spans = sectionSpans(text)
  const sectioned = hasBodyHeadings(spans)
  const words = contentWords(query)
  const collapsed = collapseWithMap(text)
  const out: GroundingParagraph[] = []
  let cursor = 0
  for (const paragraph of paragraphsOf(text)) {
    // Locate the paragraph in the text to read its section: paragraphsOf
    // collapses whitespace, so match its first 40 characters against the
    // collapsed text and map that offset back to the original.
    const at = collapsed.text.indexOf(paragraph.slice(0, 40), cursor)
    if (at >= 0) cursor = at
    const section = sectioned && at >= 0 ? sectionAt(spans, collapsed.origin[at] ?? 0) : 'other'
    if (sectioned && !KEEP.has(section)) continue
    const have = contentWords(paragraph)
    let hits = 0
    for (const w of words) if (have.has(w)) hits++
    const density = figureDensity(paragraph)
    if (hits === 0 && density === 0) continue
    const score = hits * 2 + Math.min(density, 6) + (section === 'abstract' ? 1 : 0) +
      (section === 'results' ? 1 : 0)
    out.push({ text: paragraph.slice(0, PARAGRAPH_CHARS), section, score })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max)
}

/**
 * The text with whitespace runs collapsed to one space, plus the original
 * offset of every collapsed character, computed once per paper.
 */
function collapseWithMap(text: string): { text: string; origin: number[] } {
  let out = ''
  const origin: number[] = []
  let inSpace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      if (inSpace) continue
      inSpace = true
      out += ' '
    } else {
      inSpace = false
      out += ch
    }
    origin.push(i)
  }
  return { text: out, origin }
}

export interface BriefingSourceRecord {
  id: string
  title: string
  year?: string
  keyTakeaways?: string[]
  summary?: string
}

/**
 * One source block for `extra_context`: the exact title (the model names
 * it in each section's `sources`), the data-augmentation key takeaways and
 * summary, then the kept paragraphs labelled by section.
 */
export function sourceBlock(
  record: BriefingSourceRecord,
  paragraphs: readonly GroundingParagraph[],
): string {
  const lines = [`Source: "${record.title}"${record.year ? ` (${record.year})` : ''}`]
  if (record.keyTakeaways?.length) {
    lines.push(`Key takeaways: ${record.keyTakeaways.slice(0, 6).join(' ')}`)
  }
  if (record.summary) lines.push(`Summary: ${record.summary.slice(0, 600)}`)
  for (const p of paragraphs) lines.push(`[${p.section}] ${p.text}`)
  let out = ''
  for (const line of lines) {
    if (out.length + line.length + 1 > BLOCK_CHARS) break
    out += (out ? '\n' : '') + line
  }
  return out
}

/** The entities a briefing request names: drugs, studies, eponyms and lexicon terms. */
export function briefingEntities(query: string, lexicon: readonly string[]): string[] {
  const out: string[] = []
  const add = (e: string) => {
    if (!out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e)
  }
  for (const e of comparisonEntities(query, lexicon)) add(e)
  for (const e of distinctiveTerms(query, lexicon)) add(e)
  return out.slice(0, 4)
}

export interface BriefingGrounding {
  sources: ScoredResource[]
  context: string[]
}

/**
 * Choose the papers and build their blocks. `search` runs the stored
 * configuration (the caller decides which); `extraction` returns a paper's
 * extracted text; `record` returns its merchandised takeaways and summary.
 * A paper whose text cannot be fetched still contributes its takeaways.
 */
export async function briefingGrounding(
  query: string,
  lexicon: readonly string[],
  deps: {
    search: (text: string) => Promise<readonly ScoredResource[]>
    extraction: (id: string) => Promise<string>
    record: (id: string) => BriefingSourceRecord | undefined
  },
): Promise<BriefingGrounding> {
  const entities = briefingEntities(query, lexicon)
  const chosen: ScoredResource[] = []
  const add = (r: ScoredResource | undefined) => {
    if (r && !isAttachmentTitle(r.title) && !chosen.some((c) => c.id === r.id)) chosen.push(r)
  }
  const [main, ...perEntity] = await Promise.all([
    deps.search(query).catch(() => [] as readonly ScoredResource[]),
    ...entities.map((entity) =>
      deps.search(entityQuery(query, entity, entities)).catch(() => [] as readonly ScoredResource[])
    ),
  ])
  perEntity.forEach((results, i) => add(pickEntityPaper(results, entities[i]!)))
  for (const r of main) {
    if (chosen.length >= MAX_BRIEFING_SOURCES) break
    add(r)
  }
  const sources = chosen.slice(0, MAX_BRIEFING_SOURCES)
  const context = await Promise.all(
    sources.map(async (source) => {
      const record = deps.record(source.id) ?? { id: source.id, title: source.title }
      let paragraphs: GroundingParagraph[] = []
      try {
        paragraphs = groundingParagraphs(await deps.extraction(source.id), query)
      } catch {
        // The takeaways and summary still ground the section.
      }
      return sourceBlock({ ...record, title: source.title }, paragraphs)
    }),
  )
  return { sources, context: context.filter((block) => block.trim().length > 0) }
}
