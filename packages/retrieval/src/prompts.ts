/**
 * System-prompt variants selected by an intent's `promptVariant`. Each is a
 * short instruction prepended to the portal's default research prompt, so the
 * citation and Australian-English rules in the default still apply.
 */
export type PromptVariant = 'default' | 'safety' | 'synthesis' | 'recency' | 'data'

export const PROMPT_VARIANTS: Record<Exclude<PromptVariant, 'default'>, string> = {
  safety: 'This is a treatment decision question. Lead with contraindications, drugs to avoid ' +
    'and required safety monitoring whenever the context contains them, then the evidence for ' +
    'the options. State dose ranges only as cited, with the source, and note any dose cap that ' +
    'applies with co-medication. End with one line: verify against current prescribing ' +
    'information before acting.',
  synthesis: 'This is an evidence review. Structure the answer by theme, name where studies ' +
    'agree and where they disagree, and say how strong the evidence is for each theme (study ' +
    'design, size). If the sources contain only reviews and no primary study of the ' +
    'intervention asked about, say so plainly rather than describing the evidence as strong: ' +
    'state that the corpus holds no primary study of that intervention. Every figure stays ' +
    'attached to the intervention, population and study the source attaches it to - never ' +
    're-attribute a comparison sentence to another intervention, and never present a figure ' +
    'a source quotes second-hand about one procedure as a result for a different one. ' +
    'Close with what remains uncertain.',
  recency: 'The reader wants the newest evidence. Order findings newest first and state the ' +
    'year of each study as you cite it, taking the year only from the source itself or the ' +
    'publication years listed with the sources - never guess a year. Say plainly when the ' +
    'most recent source is older than two years.',
  data: 'The reader wants the numbers. Reproduce figures, table cells, sample sizes and ' +
    'thresholds exactly as they appear in the cited material, with units, and say which ' +
    'supplementary file each comes from.',
}

/**
 * A proportion without its denominator is not a figure a clinician or an
 * epidemiologist can repeat. Applied to the variants that answer with
 * numbers (the default, the clinical safety variant and the data variant).
 */
export const DENOMINATOR_RULE =
  'Every proportion, rate or ratio you state must carry its denominator and analysis set ' +
  'in the same sentence, exactly as the source gives them - "71.1% (n = 1644, full analysis ' +
  'set)", "HR 1.41 (95% CI 1.02 to 1.97; 1,805 patients)" - and when the source states no ' +
  'denominator, say so beside the figure rather than leaving it bare. When a cited passage ' +
  'gives an effect size for the claim - a hazard ratio, odds ratio or relative risk with its ' +
  'confidence interval - state it in the sentence exactly as the source gives it rather than ' +
  'paraphrasing it away. Where a source gives a proportion both in a results sentence and in a ' +
  'table, take the results sentence and give its count as well as its percentage - "16 (30%)", ' +
  'not "31%".'

/**
 * A figure belongs to the group the source reports it for. Applied to every
 * variant: the commonest wrong-figure defect is a headline result sold as a
 * subgroup's (loop 6 D6-01, where 16.0% for patients with psychiatric
 * comorbidity was given as the rate for those who switched from
 * levetiracetam to brivaracetam, whose rate the same paper puts at 13.9%
 * in the next paragraph).
 */
export const POPULATION_RULE =
  "When the question is about a narrower group than a source's headline result - patients who " +
  'switched from a named drug, a comorbidity, an age band, a genotype, one arm of a trial - ' +
  'state the figure the source reports for exactly that group and name the group in the same ' +
  "sentence. A figure a source reports for a broader group is not that group's figure: if the " +
  'sources report none for the group asked about, say so rather than offering the wider one. ' +
  'Keep an outcome exactly as the source names it: "continuous seizure freedom" is not "seizure ' +
  'freedom", and "all-cause discontinuation" is not "discontinuation for adverse events".'

/** The clinical variant names each source\'s study design the first time it cites it. */
export const DESIGN_RULE =
  "The first sentence that cites a source names that source's study design in the " +
  "source's own words (a randomised controlled trial, a nested case-control study, an " +
  'observational cohort, a case series, a modelling or simulation study, a review). A ' +
  'modelling or simulation result is reported as modelling, never as demonstrated ' +
  'clinical efficacy.'

const WITH_DENOMINATORS = new Set<PromptVariant>(['default', 'safety', 'data'])

export function variantPreamble(variant: PromptVariant | undefined): string {
  const parts: string[] = []
  if (variant && variant !== 'default') parts.push(PROMPT_VARIANTS[variant])
  if (WITH_DENOMINATORS.has(variant ?? 'default')) parts.push(DENOMINATOR_RULE)
  parts.push(POPULATION_RULE)
  if (variant === 'safety') parts.push(DESIGN_RULE)
  return parts.length > 0 ? parts.join(' ') + '\n\n' : ''
}
