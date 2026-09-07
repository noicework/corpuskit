/**
 * Which of an intent's mandatory prequeries actually fit the question.
 *
 * The clinical intent's safety prequeries ("contraindications, drugs to
 * avoid and safety monitoring for {entities}") were firing on every entity
 * the router found - antigens ("NMDAR", "LGI1"), journals ("JAMA") - and on
 * questions about retention or effectiveness, where a drug-safety probe
 * only adds noise to the grounding set and reads as a howler in the
 * "Searched for" list. Two deterministic gates fix both.
 */

/** Suffixes that mark a lower-case lexicon term as a medication. */
const DRUG_SUFFIX =
  /(?:ine|ate|am|ol|ide|mate|tol|one|ril|pine|mide|nel|tam|toin|bital|mus|ium|zole|xin|vir|mab|nib|statin|pril|sartan|cillin|mycin|cycline|oxacin|dipine|olol|apine|azine|epine|amide|idone|prazole|tidine|triptan|parin|gliptin|flozin|diol|oid|nate|zepam|olam|trel|rin|tin|pin|cin|min|lin|sin|fen|ace|ane|ene|ase|ose)$/i

/** Words that make a lower-case term a treatment rather than a medicine. */
const NOT_A_DRUG = /\b(?:diet|therapy|surgery|stimulation|device|implant|resection|ablation)\b/i

/**
 * A term names a medication when it is a lower-case lexicon entry (genes,
 * acronyms and syndrome names are capitalised) whose last word carries a
 * drug suffix and which is not a diet or a procedure.
 */
export function isMedicationTerm(term: string): boolean {
  const t = term.trim()
  if (!t || /[A-Z]/.test(t)) return false
  if (NOT_A_DRUG.test(t)) return false
  const last = t.split(/\s+/).at(-1) ?? ''
  return DRUG_SUFFIX.test(last)
}

/** The medication entities among the router's findings, in order. */
export function medicationEntities(entities: readonly string[]): string[] {
  return entities.filter(isMedicationTerm)
}

/**
 * Whether the question is about choosing, avoiding, starting, dosing or
 * combining a treatment - the questions a drug-safety probe belongs to.
 * Retention, efficacy and mechanism questions do not qualify.
 */
export function isTreatmentDecisionQuestion(query: string): boolean {
  return /\b(?:contraindicat\w*|avoid\w*|safe|safely|safety|should (?:i|we|you|it|they)|which (?:asms?|drugs?|medications?|anti-?seizure|agents?|treatments?|options?)|first[- ]line|second[- ]line|add[- ]on|switch\w*|start\w*|titrat\w*|dos(?:e|es|ing|age)|interact\w*|pregnan\w*|monitor\w*|choose|choice|select\w*|prefer\w*|recommend\w*|prophyla\w*|given|use of|be used)\b/i
    .test(query)
}

/**
 * Whether the omitted-drug pointer ("the cited sources also discuss X in the
 * context of contraindication") fits: only a question about which treatment
 * to choose or avoid, not one about a single drug's cardiac safety or a
 * retention rate.
 */
export function isTreatmentSelectionQuestion(query: string): boolean {
  return /\b(?:contraindicat\w*|avoid\w*|which (?:asms?|drugs?|medications?|anti-?seizure|agents?|treatments?|options?)|what (?:asms?|drugs?|medications?|treatments?)|first[- ]line|second[- ]line|best (?:choice|option|drug)|should (?:i|we|you) (?:use|give|start|choose|prescribe)|drugs? to (?:use|avoid)|choice of)\b/i
    .test(query)
}

/**
 * Fills an intent's prequery templates for a question: templates that name
 * `{entities}` fire only for medication entities on a treatment-decision
 * question; templates without a placeholder always fire.
 */
export function applicablePrequeries(
  templates: readonly string[],
  query: string,
  entities: readonly string[],
): string[] {
  const medications = medicationEntities(entities)
  const decision = isTreatmentDecisionQuestion(query)
  // The probe's subject: the drugs asked about; failing that, on a
  // which-drug question, the gene or syndrome the choice is for ("SCN1A,
  // Dravet"); never a journal or an antigen, and never a bare acronym.
  const conditions = entities.filter((e) =>
    !isMedicationTerm(e) && (/\d/.test(e) || /^[A-Z][a-z]/.test(e))
  )
  const subject = medications.length > 0
    ? medications
    : isTreatmentSelectionQuestion(query)
    ? conditions
    : []
  return templates
    .filter((t) => !t.includes('{entities}') || (decision && subject.length > 0))
    .map((t) => t.replaceAll('{entities}', subject.join(', ')).replaceAll('{query}', query).trim())
    .filter((t) => t.length > 3)
}
