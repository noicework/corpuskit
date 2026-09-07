/**
 * The figure audit for a generated briefing (
 * review loop 3 D3-03). A briefing's sections and key takeaways get the
 * same check an answer does: every figure must sit beside its claim in
 * the extracted text (or the data-augmentation summary and takeaways) of
 * one of the section's own sources, at the claim's outcome and follow-up
 * and for its population. A sentence that fails is removed from the
 * section and counted; a takeaway that fails is removed with its markers.
 * The structured ask also returns one statement per figure - the figure,
 * its outcome, its population and its study - and a statement whose study
 * text carries the figure for a different outcome or a narrower population
 * fails the sentence that states it. Deterministic; no model in the loop.
 */
import {
  claimFeatures,
  extractNumbers,
  figurePattern,
  figureSupportedBy,
  normaliseFigures,
  normaliseSource,
  outcomeConflict,
  outcomeFamilies,
  ownSentenceBounds,
  populationQualifier,
  type PreparedSource,
  prepareSource,
} from './answer-audit.ts'
import { namedEntities, splitSentences } from './citation-binding.ts'
import { carriesQualifier } from './figure-rescue.ts'

export interface BriefingStatement {
  figure?: string
  outcome?: string
  population?: string
  study?: string
}

export interface AuditableSection {
  heading: string
  content: string
  sources: { resourceId: string; title: string }[]
  refs: number[]
  statements?: BriefingStatement[]
}

export interface BriefingAudit {
  figuresChecked: number
  figuresRemoved: string[]
  sentencesRemoved: number
  takeawaysRemoved: number
  /** Of the takeaways removed, those whose figure the referenced papers carry only second-hand. */
  takeawaysSecondhand?: number
  /** Statements whose figure sits in the study text beside a different outcome or population. */
  statementsFailed: { figure: string; reason: 'outcome' | 'population' | 'absent' }[]
}

export interface AuditBriefingResult {
  sections: AuditableSection[]
  key_takeaways: string[]
  takeaway_refs: number[][]
  audit: BriefingAudit
}

/** Words that mark a subgroup or a narrower analysis set in a passage. */
const SUBGROUP =
  /\b(?:mFAS|subgroup|sub-group|per[- ]protocol|completers?|responders? only|aged? (?:\d|<|>|≥|≤)|(?:in|among) (?:patients|people|participants|adults|children) (?:with|without|aged|who)\b)/i

/**
 * Whether a statement's figure sits in its study's text for the outcome
 * and population the statement names. The figure must be present; the
 * sentence it sits in must not name a different outcome family, must
 * carry the outcome's own qualifier ("due to adverse events" needs
 * "adverse" or "tolerab" beside the figure), and must not restrict the
 * figure to a subgroup the statement's population does not name.
 */
export function checkStatement(
  statement: BriefingStatement,
  text: PreparedSource,
): { ok: true } | { ok: false; reason: 'outcome' | 'population' | 'absent' } {
  const figure = (statement.figure ?? '').trim()
  const tokens = extractNumbers(figure)
  if (tokens.length === 0) return { ok: true }
  const token = tokens[0]!
  const re = figurePattern(token, 'g')
  const outcome = (statement.outcome ?? '').toLowerCase()
  const families = outcomeFamilies(outcome)
  const qualifiers: RegExp[] = []
  if (/adverse|tolerab|side[- ]effect/.test(outcome)) {
    qualifiers.push(/adverse|tolerab|side[- ]effect|\bAEs?\b|teae/i)
  }
  if (/lack of (?:efficacy|effect)|ineffective/.test(outcome)) {
    qualifiers.push(/lack of (?:efficacy|effect)|ineffective|insufficient/i)
  }
  let reason: 'outcome' | 'population' | 'absent' = 'absent'
  let m: RegExpExecArray | null
  while ((m = re.exec(text.lower)) !== null) {
    const own = ownSentenceBounds(text.lower, m.index)
    const sentence = text.lower.slice(own.start, own.end)
    const original = text.original.slice(own.start, own.end)
    if (families.length > 0 && outcomeConflict(families, sentence)) {
      reason = 'outcome'
      continue
    }
    if (qualifiers.length > 0 && !qualifiers.every((q) => q.test(original))) {
      reason = 'outcome'
      continue
    }
    const population = (statement.population ?? '').toLowerCase()
    const qualifier = populationQualifier(original)
    const subgroup = SUBGROUP.exec(original)
    if (qualifier && !carriesQualifier(population, qualifier)) {
      reason = 'population'
      continue
    }
    if (
      subgroup && !SUBGROUP.test(population) &&
      !population.includes(subgroup[0].toLowerCase().slice(0, 5))
    ) {
      reason = 'population'
      continue
    }
    return { ok: true }
  }
  return { ok: false, reason }
}

/** The text of a study a statement names, by title match against the section's sources. */
function studyText(
  study: string | undefined,
  sources: readonly { resourceId: string; title: string }[],
  texts: ReadonlyMap<string, PreparedSource>,
): PreparedSource | undefined {
  const wanted = (study ?? '').toLowerCase().trim()
  if (!wanted) return undefined
  const words = wanted.match(/[a-z][a-z0-9-]{3,}/g) ?? []
  let best: { text: PreparedSource; hits: number } | undefined
  for (const source of sources) {
    const text = texts.get(source.resourceId)
    if (!text) continue
    const title = source.title.toLowerCase()
    const hits = words.filter((w) => title.includes(w)).length
    if (hits > 0 && (!best || hits > best.hits)) best = { text, hits }
  }
  return best?.text
}

/**
 * Runs the audit over the attributed briefing. `texts` maps resource ids
 * to extracted texts, `generated` to the DA summary and takeaways.
 */
export function auditBriefing(
  briefing: { sections: AuditableSection[]; key_takeaways: string[]; takeaway_refs?: number[][] },
  deps: {
    texts: ReadonlyMap<string, string>
    generated: ReadonlyMap<string, string>
    lexicon: readonly string[]
    query: string
  },
): AuditBriefingResult {
  const prepared = new Map<string, PreparedSource>()
  const preparedGenerated = new Map<string, PreparedSource>()
  const prepare = (id: string): PreparedSource[] => {
    const out: PreparedSource[] = []
    const raw = deps.texts.get(id)
    if (raw) {
      if (!prepared.has(id)) prepared.set(id, prepareSource(raw))
      out.push(prepared.get(id)!)
    }
    const da = deps.generated.get(id)
    if (da) {
      if (!preparedGenerated.has(id)) preparedGenerated.set(id, prepareSource(da))
      out.push(preparedGenerated.get(id)!)
    }
    return out
  }
  const questionEntities = namedEntities(deps.query, deps.lexicon)
  const audit: BriefingAudit = {
    figuresChecked: 0,
    figuresRemoved: [],
    sentencesRemoved: 0,
    takeawaysRemoved: 0,
    statementsFailed: [],
  }
  const allTexts = new Map<string, PreparedSource[]>()
  const supported = (sentence: string, texts: readonly PreparedSource[]): boolean => {
    const figures = extractNumbers(sentence)
    if (figures.length === 0) return true
    const claim = claimFeatures(sentence, deps.lexicon, questionEntities)
    audit.figuresChecked += figures.length
    const failing = figures.filter((figure) =>
      !texts.some((text) => figureSupportedBy(figure, claim, text).supported)
    )
    if (failing.length === 0) return true
    for (const f of failing) if (!audit.figuresRemoved.includes(f)) audit.figuresRemoved.push(f)
    return false
  }
  // Figures the statements fail anywhere: their sentences go whatever the
  // plain check says, in the sections and in the key takeaways alike.
  const failedEverywhere = new Set<string>()
  // Sections whose every kept sentence passed the check against their own
  // sources: their figures are verified where they stand (D8-02).
  const verified = new WeakSet<AuditableSection>()
  const sections = briefing.sections.map((section) => {
    const texts = section.sources.flatMap((s) => prepare(s.resourceId))
    for (const s of section.sources) allTexts.set(s.resourceId, prepare(s.resourceId))
    const failedFigures = new Set<string>()
    for (const statement of section.statements ?? []) {
      const text = studyText(statement.study, section.sources, prepared)
      if (!text) continue
      const verdict = checkStatement(statement, text)
      if (verdict.ok) continue
      const figure = extractNumbers(statement.figure ?? '')[0]
      if (!figure) continue
      failedFigures.add(figure)
      failedEverywhere.add(figure)
      audit.statementsFailed.push({ figure, reason: verdict.reason })
    }
    if (texts.length === 0 && failedFigures.size === 0) return section
    const kept: string[] = []
    for (const sentence of splitSentences(section.content)) {
      const figures = extractNumbers(sentence)
      const statementFailed = figures.some((f) => failedFigures.has(f))
      if (statementFailed) {
        audit.figuresChecked += figures.length
        for (const f of figures) {
          if (failedFigures.has(f) && !audit.figuresRemoved.includes(f)) {
            audit.figuresRemoved.push(f)
          }
        }
        audit.sentencesRemoved += 1
        continue
      }
      if (texts.length > 0 && !supported(sentence, texts)) {
        audit.sentencesRemoved += 1
        continue
      }
      kept.push(sentence)
    }
    const audited = { ...section, content: kept.join(' ') }
    // Every sentence kept here passed the check against this section's own
    // sources, so a figure it carries is verified where it stands.
    if (texts.length > 0) verified.add(audited)
    return audited
  }).filter((section) => section.content.trim().length > 0)
  const every = [...new Set([...allTexts.values()].flat())]
  const takeaways: string[] = []
  const refs: number[][] = []
  briefing.key_takeaways.forEach((takeaway, i) => {
    const figures = extractNumbers(takeaway)
    if (figures.some((f) => failedEverywhere.has(f))) {
      audit.figuresChecked += figures.length
      audit.takeawaysRemoved += 1
      return
    }
    if (every.length > 0 && !supported(takeaway, every)) {
      audit.takeawaysRemoved += 1
      return
    }
    takeaways.push(takeaway)
    refs.push(briefing.takeaway_refs?.[i] ?? [])
  })
  // Removal is real (review loop 8 D8-02). A figure
  // is checked once per section against that section's own sources and
  // once per takeaway against every source, so one claim can fail while
  // another carrying the same number passes. Reported globally, that read
  // as a briefing printing 90.5% under a note saying 90.5% was removed.
  // Two passes settle it: a sentence that repeats a failed figure without
  // having passed its own check goes, and the audit then names only what
  // is no longer on the page.
  const swept = sections.map((section) => {
    if (verified.has(section)) return section
    const failed = audit.figuresRemoved.filter((f) =>
      figurePattern(f).test(normaliseFigures(section.content))
    )
    if (failed.length === 0) return section
    const kept = splitSentences(section.content).filter((sentence) =>
      !failed.some((f) => figurePattern(f).test(normaliseFigures(sentence)))
    )
    audit.sentencesRemoved += splitSentences(section.content).length - kept.length
    return { ...section, content: kept.join(' ') }
  }).filter((section) => section.content.trim().length > 0)
  const printed = [...swept.map((s) => s.content), ...takeaways].join('\n')
  audit.figuresRemoved = audit.figuresRemoved.filter((f) =>
    !figurePattern(f).test(normaliseFigures(printed))
  )
  // The statements list follows the sections: a statement whose figure the
  // briefing no longer prints is not a statement about this briefing.
  const statementsKept = swept.map((section) =>
    section.statements === undefined ? section : {
      ...section,
      statements: section.statements.filter((statement) => {
        const figure = extractNumbers(statement.figure ?? '')[0]
        return figure === undefined || figurePattern(figure).test(normaliseFigures(section.content))
      }),
    }
  )
  return { sections: statementsKept, key_takeaways: takeaways, takeaway_refs: refs, audit }
}

/** The normalised source text, for callers that already hold the raw one. */
export function prepareBriefingText(text: string): PreparedSource {
  return { lower: normaliseSource(text).toLowerCase(), original: normaliseSource(text), pairs: [] }
}
