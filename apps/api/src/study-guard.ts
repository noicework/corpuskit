/**
 * The study-name guard. A question that names a study - "the BREATHS trial",
 * "UMPIRE", "the PERMIT pooled analysis", or a quoted title - must ground on
 * that study's paper, whatever retrieval ranks first. The guard finds the
 * catalogue resources a name in the question identifies, so the ask can pin
 * them into the grounding set and lead the sources with them.
 *
 * A study name is an upper-case token of four or more characters that names
 * at most a few articles: an acronym that titles a dozen papers (ILAE,
 * SUDEP, COVID-19) is a topic, not a study, and a gene symbol is a gene.
 * A distinctive term works the same way (D2-05): an eponym ("Lennox-Gastaut")
 * or a lexicon entry ("lamotrigine") that titles at most a few articles
 * names those papers, so a question about the ILAE criteria for LGS reads
 * the LGS paper in depth rather than whatever ranks first.
 * Pure functions over the catalogue, tested without the platform.
 */
import type { ResourceSummary } from '@research-portal/core'
import { GENERIC_ACRONYMS, looksLikeGeneSymbol } from './intent-router.ts'

export interface StudyMatch {
  id: string
  title: string
  /** The acronym, quoted fragment, distinctive term or cohort designator in the question that named it. */
  term: string
  kind: 'acronym' | 'title' | 'term' | 'cohort'
}

/** A name that titles more articles than this is a topic, not a study. */
export const MAX_ARTICLES_PER_NAME = 3
/** Resources pinned into one ask, at most. */
export const MAX_PINNED = 3

/** Upper-case tokens in the question that could name a study. */
export function studyAcronyms(query: string): string[] {
  const out: string[] = []
  for (const token of query.match(/\b[A-Z][A-Z0-9-]{3,}\b/g) ?? []) {
    const bare = token.replace(/-+$/, '')
    if (bare.length < 4 || out.includes(bare)) continue
    if (GENERIC_ACRONYMS.has(bare) || looksLikeGeneSymbol(bare)) continue
    if (/^(?:PMC|PMID)\d+$/i.test(bare) || /^\d+$/.test(bare)) continue
    out.push(bare)
  }
  return out
}

/**
 * Distinctive terms in the question that could title a paper: capitalised
 * hyphenated eponyms ("Lennox-Gastaut", "Rasmussen-type") and lexicon
 * entries of five letters or more that the question uses as whole words.
 * Acronyms are handled by `studyAcronyms`; a hyphenated compound with an
 * upper-case half ("EEG-fMRI", "anti-NMDAR") is not an eponym.
 */
export function distinctiveTerms(query: string, lexicon: readonly string[] = []): string[] {
  const out: string[] = []
  const add = (term: string) => {
    if (!out.some((t) => t.toLowerCase() === term.toLowerCase())) out.push(term)
  }
  for (const m of query.matchAll(/\b([A-Z][a-z]{2,}-[A-Z][a-z]{2,})\b/g)) add(m[1]!)
  const lower = query.toLowerCase()
  for (const term of lexicon) {
    const t = term.trim()
    if (t.length < 5 || GENERIC_ACRONYMS.has(t.toUpperCase())) continue
    if (new RegExp(`(?:^|[^a-z0-9])${escape(t.toLowerCase())}(?=$|[^a-z0-9])`).test(lower)) add(t)
  }
  return out
}

/** Quoted fragments long enough to be a title, straight or curly quotes. */
export function quotedTitles(query: string): string[] {
  const out: string[] = []
  for (const m of query.matchAll(/["“]([^"”]{12,})["”]/g)) {
    const fragment = m[1]?.trim()
    if (fragment && !out.includes(fragment)) out.push(fragment)
  }
  return out
}

/** Supplements, peer-review files and media attached to an article. */
export function isAttachmentTitle(title: string): boolean {
  return /^(?:supplementary|supplement\b|peer review|video|movie|media|additional file|appendix)/i
    .test(title)
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, ' ').trim()
}

/** Newest first, then by title, so a pinned set is stable across calls. */
function newestFirst(a: ResourceSummary, b: ResourceSummary): number {
  return (b.year ?? b.published ?? '').localeCompare(a.year ?? a.published ?? '') ||
    a.title.localeCompare(b.title)
}

/**
 * The catalogue resources the question names. An acronym pins the articles
 * whose title carries it as a whole upper-case word, when there are few
 * enough to be one study; a quoted fragment pins the resources whose title
 * contains it; a distinctive term (an eponym, a lexicon drug or syndrome)
 * pins the articles whose title carries it as a whole word, again only when
 * there are few enough to be the papers meant. Acronyms and quoted titles
 * come first, then terms; articles come before their attachments and the
 * list is capped, so a pinned set never crowds the grounding window.
 */
export function matchStudies(
  query: string,
  catalogue: readonly ResourceSummary[],
  lexicon: readonly string[] = [],
): StudyMatch[] {
  const out: StudyMatch[] = []
  const seen = new Set<string>()
  const add = (resource: ResourceSummary, term: string, kind: StudyMatch['kind']) => {
    if (seen.has(resource.id) || out.length >= MAX_PINNED) return
    seen.add(resource.id)
    out.push({ id: resource.id, title: resource.title, term, kind })
  }
  for (const acronym of studyAcronyms(query)) {
    const word = new RegExp(`(?:^|[^A-Z0-9])${escape(acronym)}(?=$|[^A-Z0-9])`)
    const articles = catalogue
      .filter((r) => !isAttachmentTitle(r.title) && word.test(r.title))
      .sort(newestFirst)
    if (articles.length === 0 || articles.length > MAX_ARTICLES_PER_NAME) continue
    for (const article of articles) add(article, acronym, 'acronym')
  }
  for (const fragment of quotedTitles(query)) {
    const wanted = normalise(fragment)
    const matches = catalogue
      .filter((r) => normalise(r.title).includes(wanted))
      .sort((a, b) =>
        Number(isAttachmentTitle(a.title)) - Number(isAttachmentTitle(b.title)) ||
        newestFirst(a, b)
      )
    if (matches.length === 0 || matches.length > MAX_ARTICLES_PER_NAME) continue
    for (const match of matches) add(match, fragment, 'title')
  }
  // A cohort the question describes outranks a drug or syndrome it merely
  // names: "the LGI1 encephalitis cohort ... rituximab" pins the LGI1
  // papers before the rituximab papers.
  for (const designator of cohortDesignators(query)) {
    const articles = catalogue
      .filter((r) => !isAttachmentTitle(r.title) && carriesDesignator(r, designator.words))
      .sort(newestFirst)
    if (articles.length === 0 || articles.length > MAX_ARTICLES_PER_NAME) continue
    for (const article of articles) add(article, designator.phrase, 'cohort')
  }
  for (const term of distinctiveTerms(query, lexicon)) {
    const word = new RegExp(`(?:^|[^a-z0-9])${escape(term.toLowerCase())}(?=$|[^a-z0-9])`)
    const articles = catalogue
      .filter((r) => !isAttachmentTitle(r.title) && word.test(normalise(r.title)))
      .sort(newestFirst)
    if (articles.length === 0) continue
    if (articles.length <= MAX_ARTICLES_PER_NAME) {
      for (const article of articles) add(article, term, 'term')
      continue
    }
    // A term that titles many papers is a topic - unless the rest of the
    // question singles one of them out ("the ILAE diagnostic criteria for
    // Lennox-Gastaut syndrome in the real-world cohort" names the criteria
    // paper, not the fenfluramine trials).
    const best = bestTitleMatch(query, term, articles)
    if (best) add(best, term, 'term')
  }
  return out
}

export interface CohortDesignator {
  /** The designator as written, without its article: "video-EEG monitoring mortality cohort". */
  phrase: string
  /** Its content words, lower-cased and cut to six characters. */
  words: string[]
}

/** Words of a designator that say nothing about which paper it names. */
const DESIGNATOR_STOP = new Set([
  'study',
  'trial',
  'cohort',
  'analysis',
  'analyses',
  'register',
  'registry',
  'series',
  'pooled',
  'named',
  'same',
  'this',
  'that',
  'their',
  'other',
  'whole',
  'entire',
  'overall',
  'prospective',
  'retrospective',
  'multisite',
  'multicentre',
  'multicenter',
  'australian',
  'real-world',
  'patients',
  'adults',
  'people',
  'epilepsy',
  'seizure',
  'seizures',
])

/**
 * The cohorts a question designates by description rather than by acronym
 * (review loop 4 D4-01): "the video-EEG monitoring
 * mortality cohort", "the Melbourne video-EEG monitoring cohort", "the
 * LGI1 encephalitis cohort", "the psychiatric comorbidity and mortality
 * study". Each is the phrase between "the" and a study word, with at
 * least two content words; a one-word designator is an acronym's business.
 */
export function cohortDesignators(query: string): CohortDesignator[] {
  const out: CohortDesignator[] = []
  for (
    const m of query.matchAll(
      /\b[Tt]he\s+((?:[\w-]+\s+){1,6}?)(cohort|study|trial|analysis|analyses|register|registry|series|programme|program)\b/g,
    )
  ) {
    const phrase = `${m[1]!.trim()} ${m[2]}`
    const words = [
      ...new Set(
        (m[1]!.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])
          .filter((w) => !DESIGNATOR_STOP.has(w))
          .map((w) => w.slice(0, 6)),
      ),
    ]
    if (words.length < 2) continue
    if (!out.some((d) => d.phrase === phrase)) out.push({ phrase, words })
  }
  return out
}

/** Whether a resource's title or summary carries every word of a designator, by six-letter stem. */
export function carriesDesignator(
  resource: { title: string; summary?: string },
  words: readonly string[],
): boolean {
  const haystack = normalise(`${resource.title} ${resource.summary ?? ''}`)
  // "heart-rate" in the question is "heart rate" in the title (loop 5 XF).
  return words.every((w) =>
    new RegExp(`(?:^|[^a-z0-9])${escape(w).replace(/-/g, '[-\\s]?')}`).test(haystack)
  )
}

/** Words of a question that do not single out a paper. */
const TITLE_STOP = new Set([
  'what',
  'which',
  'were',
  'does',
  'that',
  'this',
  'with',
  'from',
  'have',
  'been',
  'them',
  'they',
  'their',
  'there',
  'about',
  'into',
  'than',
  'when',
  'where',
  'many',
  'much',
  'rate',
  'rates',
  'proportion',
  'percentage',
  'patients',
  'study',
  'trial',
  'paper',
  'syndrome',
  'epilepsy',
  'seizure',
  'seizures',
])

/** How many of the question's other content words a title must carry to be singled out. */
export const MIN_TITLE_WORDS = 3

/**
 * Among the articles a topic term titles, the one the question's other
 * content words single out: at least `MIN_TITLE_WORDS` of them in the
 * title, and clearly ahead of the runner-up. Undefined when the question
 * is about the topic rather than one paper.
 */
export function bestTitleMatch(
  query: string,
  term: string,
  articles: readonly ResourceSummary[],
): ResourceSummary | undefined {
  const termWords = new Set(term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const words = new Set(
    (query.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) =>
      !TITLE_STOP.has(w) && !termWords.has(w)
    ),
  )
  if (words.size === 0) return undefined
  const scored = articles.map((article) => {
    const have = new Set(normalise(article.title).match(/[a-z][a-z-]{3,}/g) ?? [])
    let hits = 0
    for (const w of words) if (have.has(w)) hits++
    return { article, hits }
  }).sort((a, b) => b.hits - a.hits)
  const top = scored[0]
  const next = scored[1]
  if (!top || top.hits < MIN_TITLE_WORDS) return undefined
  if (next && next.hits >= top.hits - 1) return undefined
  return top.article
}
