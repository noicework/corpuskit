// ---------------------------------------------------------------------------
// Entity hygiene shared by the relations graph, the entity groups and the
// typeahead. The knowledge-graph agent extracts anything that looks like a
// noun phrase, so its groups carry table numbers ("100", "191"), single
// letters ("U"), author strings ("Sowcik M", "Igarashi et al."), journal names
// ("Frontiers in Neurology"), case vignettes ("26-year-old woman") and e-mail
// addresses. None of those is an entity a reader wants to explore, and none of
// them belongs in a group called Gene. This is a display-side judgement, so it
// lives here rather than in the extraction.
// ---------------------------------------------------------------------------

/** Numbers, percentages, ranges and bare punctuation: "100", "0.5%", "18-24". */
const NUMERIC_ONLY = /^[\d.,%:+\-–—/\s()]+$/

/**
 * A person: "Sowcik M", "Cho H", "Vajda F", "Terence J. O'Brien", "Igarashi et
 * al.", "Mehndiratta 2002", "Faden et al., 1989". Surname plus initials or an
 * "et al." tail or a trailing year.
 */
const PERSON_NAME = new RegExp(
  [
    String.raw`^[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?\s+[A-Z]{1,3}\.?$`,
    String.raw`^[A-Z][\p{L}'’-]+(?:\s+[A-Z]\.?)+(?:\s+[A-Z][\p{L}'’-]+)?$`,
    String.raw`^(?:[A-Z]\.?\s*){1,3}[A-Z][\p{L}'’-]+$`,
    String
      .raw`^[A-Z][\p{L}'’-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’-]+)?\s+et\s+al\.?,?(?:\s*\(?\d{4}\)?)?$`,
    String.raw`^[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?,?\s+\(?(?:19|20)\d{2}\)?$`,
    String.raw`^(?:Dr|Prof|Professor|Mr|Mrs|Ms)\.?\s+[A-Z]`,
    String.raw`^[A-Z][\p{L}'’-]+,\s*(?:[A-Z]\.?\s*){1,3}$`,
  ].join('|'),
  'u',
)

/** Journal and publisher names - the extraction reads reference lists too. */
const JOURNAL_NAME =
  /^(?:frontiers in|journal of|annals of|archives of|proceedings of|the lancet|lancet|nature|science|cell|neuron|brain|epilepsia|epilepsy (?:research|& behavior|and behavior)|seizure|neurology|jama|bmj|nejm|new england journal|plos|elife|springer|elsevier|wiley|oxford university press|cambridge university press|cochrane)\b/i

/** "26-year-old woman", "3 month old boy", "a 45-year-old". */
const AGE_VIGNETTE = /\b\d+\s*[- ]?\s*(?:year|month|week|day)s?[- ]?old\b/i

/** Case vignette subjects with no age: "the patient", "a woman". */
const VIGNETTE_SUBJECT =
  /^(?:the\s+|a\s+|an\s+)?(?:patient|proband|woman|man|boy|girl|child|infant|neonate|adult)s?$/i

const EMAIL_OR_URL = /@|https?:\/\/|www\.|^10\.\d{4,9}\//i

/**
 * Digit-led measurements and cohort counts: "10 Hz", "100 children", "13
 * probands", "0.2 mg/kg/d", "16% PFA stock", "1X TBS", "7T". A string that
 * carries on past the unit ("24 hour ambulatory EEG") is a real thing.
 */
const COUNT_OR_DOSE = new RegExp(
  [
    String
      .raw`^\d[\d.,/-]*\s*-?\s*(?:[a-z-]+\s+){0,2}(?:children|patients|probands|subjects|cases|individuals|participants|adults|infants|neonates|mice|rats|animals|controls|families|people|women|men|electrodes|samples|sessions|trials|hz|khz|ms|s|sec|min|h|hr|hours?|days?|weeks?|months?|years?|yrs?)$`,
    String
      .raw`^\d[\d.,/-]*\s*-?\s*(?:mg|g|mcg|µg|ug|ng|ml|mL|l|iu|mmol|µm|um|mm|cm|m|nm|x|X|%|M|mM|nM|T|Tesla)(?![A-Za-z])`,
  ].join('|'),
  'i',
)

/** Protein variants and residues ("A193V", "R1648H", "Arg55", "Lys114") are not entities. */
const VARIANT_OR_RESIDUE =
  /^(?:[A-Z]\d{1,4}[A-Z*]|(?:Ala|Arg|Asn|Asp|Cys|Gln|Glu|Gly|His|Ile|Leu|Lys|Met|Phe|Pro|Ser|Thr|Trp|Tyr|Val)\d+[A-Za-z]*|p\.[A-Za-z0-9_*]+|c\.[A-Za-z0-9_>+\-*]+|chr\d+[:pq].*)$/

/** "Table 18", "Figure 3", "Pathway 7", "Supplementary Table S2". */
const DOCUMENT_ARTEFACT =
  /^(?:supplementary\s+)?(?:table|figure|fig|pathway|appendix|section|chapter|panel|step|phase|group|cohort|arm)\s*[a-z]?\d+[a-z]?$/i

/**
 * True when a string is not worth showing as an entity in any group.
 * Case-insensitive on the words; the "single letter" test uses the trimmed
 * length so "U" and "b" both go.
 */
export function isNoiseEntity(name: string): boolean {
  return noiseReason(name) !== null
}

/** Which rule calls this string noise, for tests and tuning; null when it is kept. */
export function noiseReason(name: string): string | null {
  const t = name.trim()
  if (t.length <= 1) return 'single-character'
  if (NUMERIC_ONLY.test(t)) return 'numeric'
  // Reference markers ("[1]", "[25]") and record codes ("A0122026").
  if (/^\[\d+\]$/.test(t) || /^[A-Z]{1,2}\d{6,}$/.test(t)) return 'reference-marker'
  if (/[\n\r\t]/.test(t)) return 'line-break'
  if (EMAIL_OR_URL.test(t)) return 'address'
  // Chemical shorthand ("2-AG", "5-HT") is a real entity despite its shape.
  if (/^\d+-[A-Z]{2,}$/.test(t)) return null
  if (COUNT_OR_DOSE.test(t)) return 'count-or-dose'
  if (VARIANT_OR_RESIDUE.test(t)) return 'variant'
  if (/^\d/.test(t)) {
    // Digit-led: a table row ("3/Male/18c", "0 and 1", "3q21.3") has almost
    // no letters; a numbered author or journal ("16 Shafi MM", "6 NATURE
    // COMMUNICATIONS") is the same noise with a row number in front.
    const letters = (t.match(/\p{L}/gu) ?? []).length
    if (letters < 4) return 'table-cell'
    if (/^\d+\/\S+$/.test(t)) return 'table-cell'
    const rest = t.replace(/^[\d.,/\s-]+/, '')
    if (PERSON_NAME.test(rest) || JOURNAL_NAME.test(rest)) return 'numbered-citation'
    if (/^[A-Z][A-Z\s]+$/.test(rest)) return 'numbered-citation'
  }
  if (AGE_VIGNETTE.test(t)) return 'age-vignette'
  if (VIGNETTE_SUBJECT.test(t)) return 'vignette-subject'
  if (DOCUMENT_ARTEFACT.test(t)) return 'document-artefact'
  if (JOURNAL_NAME.test(t)) return 'journal'
  if (PERSON_NAME.test(t)) return 'person'
  // OCR punctuation inside a word ("Glut!D") - a real name has no bang or
  // pipe in it.
  if (/[!|`^~]/.test(t)) return 'ocr-punctuation'
  return null
}

/**
 * Human gene symbols: upper case, two to eight characters, a digit somewhere
 * (SCN1A, KCNQ2, DEPDC5, SLC12A5, CDKL5, TBC1D24) or one of the digitless
 * epilepsy genes; optionally a variant suffix ("SCN1A p.R1648H", "KCNT1
 * mutation"); mouse or rat symbols (Scn1a) too.
 */
const DIGITLESS_GENES = new Set([
  'ARX',
  'PTEN',
  'MTOR',
  'WWOX',
  'PIGA',
  'PIGN',
  'PIGO',
  'PIGQ',
  'PIGT',
  'CASK',
  'ATRX',
  'AARS',
  'QARS',
  'ROGDI',
  'PURA',
  'NEXMIF',
  'TBCK',
  'DHDDS',
  'ITPA',
])

const GENE_TAIL =
  /^(?:\s+(?:gene|genes|variant|variants|mutation|mutations|deletion|duplication|haploinsufficiency|loss[- ]of[- ]function|gain[- ]of[- ]function|encephalopathy|p\.[A-Za-z0-9_*]+|c\.[A-Za-z0-9_>+\-*]+|[A-Z]\d+[A-Z*]))*$/

/** Does this Gene-group string actually name a gene? */
export function isGeneSymbolEntity(name: string): boolean {
  const t = name.trim()
  const m = /^([A-Za-z][A-Za-z0-9-]{1,9})(.*)$/.exec(t)
  if (!m) return false
  const symbol = m[1] ?? ''
  const tail = m[2] ?? ''
  if (!GENE_TAIL.test(tail)) return false
  if (VARIANT_OR_RESIDUE.test(symbol)) return false
  if (/^[A-Z][A-Z0-9]{1,7}(?:-[A-Z0-9]{1,3})?$/.test(symbol)) {
    return /\d/.test(symbol) || DIGITLESS_GENES.has(symbol)
  }
  return /^[A-Z][a-z]{1,6}\d[a-z0-9]{0,3}$/.test(symbol)
}

/**
 * Should this entity be shown under this group? Every group drops the noise;
 * the Gene group additionally demands a gene symbol.
 */
export function keepEntity(name: string, group: string): boolean {
  if (isNoiseEntity(name)) return false
  if (/^genes?$/i.test(group.trim())) return isGeneSymbolEntity(name)
  return true
}

/**
 * Case-fold and de-duplicate a list of names, keeping the first spelling
 * seen for each (the caller orders by preference). Whitespace is collapsed so
 * "Dravet syndrome" and "Dravet  syndrome" are one entry.
 */
export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = raw.replace(/\s+/g, ' ').trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Prefer the spelling that reads as a name: mixed case over all-caps or
 * all-lower, and the shorter of two equal-case spellings. Used when several
 * case variants of one entity compete for the single slot dedupeNames keeps.
 */
export function preferredSpelling(variants: readonly string[]): string {
  const score = (v: string): number => {
    const upper = v === v.toUpperCase()
    const lower = v === v.toLowerCase()
    // A symbol ("SCN1A", "GLUT1DS") is correctly all upper case.
    if (upper) return /\d/.test(v) && !/\s/.test(v) ? 3 : 0
    if (lower) return 1
    // Sentence or Title case reads as a name; "kainic Acid" does not.
    return /^[A-Z]/.test(v) ? 3 : 0
  }
  let best = variants[0] ?? ''
  for (const v of variants.slice(1)) {
    if (score(v) > score(best) || (score(v) === score(best) && v.length < best.length)) best = v
  }
  return best
}
