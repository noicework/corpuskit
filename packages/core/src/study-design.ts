// ---------------------------------------------------------------------------
// Study design (the "kind" a card and facet show for a research article).
//
// A rule-first classifier over the record the ingest already stores - the
// curated title, the abstract, the author keywords and MeSH headings - so the
// kind an epidemiologist reads on a card is the design the paper states
// about itself, not a language model's guess. The knowledge box's own
// classifier label is consulted last and only when the text corroborates it;
// with neither, the card carries no kind at all. Supplements and media never
// carry a study design.
//
// Pure and dependency-free: every rule here is unit-tested against the
// persona corpus in study-design.test.ts.
// ---------------------------------------------------------------------------

export const STUDY_DESIGNS = [
  { id: 'protocol', label: 'Study protocol' },
  { id: 'guideline', label: 'Guideline or checklist' },
  { id: 'systematic-review', label: 'Systematic review or meta-analysis' },
  { id: 'pooled-analysis', label: 'Pooled analysis' },
  { id: 'genetic-association-study', label: 'Genetic association study' },
  { id: 'preclinical', label: 'Preclinical study' },
  { id: 'randomised-controlled-trial', label: 'Randomised controlled trial' },
  { id: 'clinical-trial', label: 'Clinical trial (non-randomised)' },
  { id: 'case-control-study', label: 'Case-control study' },
  { id: 'cross-sectional-study', label: 'Cross-sectional study' },
  { id: 'cohort-study', label: 'Cohort study' },
  { id: 'case-report', label: 'Case report or series' },
  { id: 'survey', label: 'Survey' },
  { id: 'qualitative-study', label: 'Qualitative study' },
  { id: 'narrative-review', label: 'Narrative review' },
] as const

export type StudyDesignId = (typeof STUDY_DESIGNS)[number]['id']

const LABEL_BY_ID: ReadonlyMap<string, string> = new Map(
  STUDY_DESIGNS.map((d) => [d.id, d.label]),
)

/** The display label for a study-design id; a slug it does not know is title-cased. */
export function studyDesignLabel(id: string): string {
  const known = LABEL_BY_ID.get(id)
  if (known) return known
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function isStudyDesignId(id: string): id is StudyDesignId {
  return LABEL_BY_ID.has(id)
}

export interface StudyDesignInput {
  /** The curated title. */
  title: string
  /** The abstract (or the first page) when the ingest stored one. */
  abstract?: string
  /** Author keywords and MeSH headings, as stored. */
  keywords?: readonly string[]
  /** The `format` label (article / supplement / media), when filed that way. */
  format?: string
  /** The viewer type; video and audio never carry a study design. */
  type?: string
  /** The knowledge box's classifier label, consulted only behind the corroboration gate. */
  label?: string
}

export interface StudyDesignVerdict {
  id: StudyDesignId
  /** `rule` when the text states the design; `label` when the stored label was corroborated. */
  stage: 'rule' | 'label'
}

const ATTACHMENT_TITLE =
  /^(?:supplementary|supplement\b|supplemental|peer review|appendix|additional file|video|movie|media|data sheet|datasheet)/i

function normalise(text: string): string {
  return text.replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Abstracts describe a study's own design beside its background, so a clause
 * about an earlier or parent study ("previously enrolled in a randomised
 * placebo-controlled trial") is dropped before a design term is read as the
 * paper's own.
 */
function ownDesignText(text: string): string {
  return text.replace(
    /\b(?:previously|prior|earlier|original(?:ly)?|parent|core|preceding)\b[^.;]{0,80}?\b(?:randomi[sz]ed|trials?|study|studies)\b/g,
    ' ',
  )
}

const MESH_COHORT =
  /^(cohort studies|prospective studies|retrospective studies|longitudinal studies|follow-up studies)$/i
const MESH_CASE_CONTROL = /^case-control studies$/i
const MESH_CROSS_SECTIONAL = /^cross-sectional studies$/i
const MESH_CASE_REPORT = /^case reports$/i
const MESH_ANIMALS = /^animals$/i
const MESH_HUMANS = /^humans$/i
const MESH_RCT = /^randomi[sz]ed controlled trials? as topic$/i

/**
 * The study design a record states about itself. Rules are tried in order of
 * specificity - a protocol of a trial is a protocol, an animal trial is
 * preclinical, a pooled analysis of trials is a pooled analysis - so the
 * first hit is the honest one. Returns undefined when nothing in the record
 * settles it: the card then carries no kind rather than a wrong one.
 */
export function classifyStudyDesign(input: StudyDesignInput): StudyDesignVerdict | undefined {
  if (input.format === 'supplement' || input.format === 'media') return undefined
  if (input.type === 'video') return undefined
  const rawTitle = input.title ?? ''
  if (ATTACHMENT_TITLE.test(rawTitle.trim())) return undefined
  const title = normalise(rawTitle)
  const abstractRaw = normalise(input.abstract ?? '')
  // A summary that merely repeats the title carries no design statement.
  const abstract = abstractRaw && abstractRaw !== title ? abstractRaw : ''
  const own = ownDesignText(abstract)
  const text = `${title}. ${own}`
  const keywords = (input.keywords ?? []).map((k) => k.trim())
  const hasMesh = (pattern: RegExp) => keywords.some((k) => pattern.test(k))
  const rule = (id: StudyDesignId): StudyDesignVerdict => ({ id, stage: 'rule' })

  // 1. Protocols describe a study that has not reported.
  if (
    /\bprotocol\b/.test(title) ||
    /\b(?:study|trial) protocol\b|\bprotocol for\b|\bthis protocol\b|\bwe describe the protocol\b/
      .test(abstract)
  ) {
    return rule('protocol')
  }

  // 1b. Guidelines, reporting checklists, consensus and position statements
  //     recommend rather than report, so they carry no study design of their
  //     own (a Delphi consensus is the statement it produced, not a survey).
  //     A bare "guidelines" in a title can be the subject of an audit or a
  //     cohort, so it counts only without those words.
  if (
    /\bchecklist\b|\breporting (?:guidelines?|standards?)\b|\bstandards? for (?:the )?reporting\b|\bconsensus\b|\brecommendations\b|\bposition (?:paper|statement)\b|\bpractice parameters?\b/
      .test(title) ||
    (/\bguidelines?\b/.test(title) &&
      !/\b(?:adherence|compliance|audit|cohort|survey|retrospective|prospective|outcomes?)\b/
        .test(title)) ||
    keywords.some((k) => /^(?:checklist|reporting standards?|practice guidelines?)$/i.test(k))
  ) {
    return rule('guideline')
  }

  // 2. Evidence syntheses. A genome-wide meta-analysis is a genetic study, not a review.
  const genetic = /\bgenome-wide association\b|\bgwas\b/.test(text) ||
    /\bassociation stud(?:y|ies)\b/.test(title)
  if (
    !genetic &&
    (/\bsystematic (?:literature )?review\b|\bmeta-?analys[ie]s\b|\bscoping review\b|\bumbrella review\b|\bcochrane\b/
      .test(title) ||
      /\bsystematic (?:literature )?review\b|\b(?:we|a|this) (?:conducted|performed|undertook|present|report|carried out)?\s?(?:a )?meta-?analysis\b/
        .test(own))
  ) {
    return rule('systematic-review')
  }
  // A pooled analysis is one the paper calls pooled (or individual participant
  // data). A trial that pools its own samples in a secondary analysis keeps
  // the design its title states.
  const pooled = /\bpooled analys[ie]s\b|\bindividual[- ](?:level|participant|patient)[- ]data\b/
  const titleTrial = /\brandomi[sz]ed\b|\bcontrolled trial\b|\bpilot trial\b/.test(title) &&
    !/\btrials\b/.test(title)
  if (pooled.test(title) || (!titleTrial && pooled.test(own))) {
    return rule('pooled-analysis')
  }
  if (genetic) return rule('genetic-association-study')

  // 3. Animal and bench work, whatever its design, is preclinical. A MeSH
  //    "Animals" heading without "Humans" settles it only when the title does
  //    not itself describe a clinical study.
  const clinicalTitle =
    /\b(?:patients?|cohort|clinical|children|adults?|individuals|people|humans?|participants)\b/
      .test(title)
  if (
    /\b(?:rats?|mice|mouse|murine|rodents?|zebrafish|drosophila|canine|dogs?|pigs?|piglets?|sheep|macaques?|primates?|in vitro|animal models?|organoids?|cell lines?|kainate|kainic acid|pilocarpine|kindling|kindled|knockout|knock-out)\b/
      .test(title) ||
    (!clinicalTitle && hasMesh(MESH_ANIMALS) && !hasMesh(MESH_HUMANS)) ||
    /\b(?:rats?|mice|mouse)\b[^.]{0,40}\b(?:were|was|model)\b/.test(own)
  ) {
    return rule('preclinical')
  }

  // 4. A title that names itself a review, guideline or position paper is one;
  //    a "retrospective review" of records is a cohort and falls through.
  const titleReview =
    /\b(?:review|overview|commentary|viewpoint|expert opinion|misconceptions?|pitfalls?|state of the art|primer|editorial|narrative|appraisal|hypothesis paper|guide)\b/
      .test(title) &&
    !/\b(?:retrospective|chart|record|case[- ]note|clinical|medical|file) review\b/.test(title)
  if (titleReview) return rule('narrative-review')
  if (/\bsurvey\b/.test(title)) return rule('survey')

  // 4b. Designs a trial-shaped title can hide. A historical-controlled study
  //     compares against an earlier cohort, not a concurrent randomised arm,
  //     whatever dose randomisation it also used; a qualitative interview
  //     study run inside a trial reports experience, not the trial's outcome.
  if (
    /\bhistorical(?:ly)?[- ]control(?:led|s)?\b/.test(text) ||
    keywords.some((k) => /^historical controls?$/i.test(k))
  ) {
    return rule('clinical-trial')
  }
  //     A semi-structured interview alone is also how a phenotyping study
  //     scores its participants, so on its own it settles nothing.
  if (
    /\bqualitative (?:study|studies|research|design|method|methodolog|interview|approach|analysis|inquiry|exploration)\w*\b|\bthematic analysis\b|\bfocus groups?\b|\binterpretative phenomenological\b|\bgrounded theory\b/
      .test(text) ||
    (/\bsemi-structured interviews?\b/.test(text) &&
      /\bqualitative\b|\bthematic\b|\bphenomenolog/.test(text)) ||
    keywords.some((k) => /^qualitative\b/i.test(k))
  ) {
    return rule('qualitative-study')
  }

  // 5. Trials. Randomisation has to be the paper's own, with an arm to compare
  //    against; a plural "trials" in the title is a paper about trials, and an
  //    open-label or extension phase of a trial is not itself randomised.
  const titleOpenLabel = /\bopen-label\b|\bextension\b|\bsingle-arm\b|\bfirst-in-human\b/.test(
    title,
  )
  const titleRct = !titleOpenLabel && /\brandomi[sz]ed\b/.test(title) && !/\btrials\b/.test(title)
  const ownRandomised =
    /\b(?:were|was|are|is) randomi[sz]ed\b|\bwe randomi[sz]ed\b|\brandomi[sz]ed (?:\d+|to|in a|\d+:\d+)\b|\brandomi[sz]ation\b/
      .test(own)
  const controlled = /\bplacebo\b|\bcontrol(?:led)?(?: group| arm)?\b|\bdouble-blind\b|\bsham\b/
    .test(text)
  if (
    titleRct ||
    (!titleOpenLabel &&
      (/\brandomi[sz]ed[- ](?:controlled|clinical|placebo-controlled|double-blind|crossover|cross-over)[- ]trial\b/
        .test(own) ||
        (ownRandomised && controlled)))
  ) {
    return rule('randomised-controlled-trial')
  }
  if (
    titleOpenLabel ||
    /\btrial of\b|\bphase (?:1|2|3|4|i|ii|iii|iv)\b|\bnon-?randomi[sz]ed\b|\bpilot trial\b|\bfeasibility trial\b/
      .test(title) ||
    /\bopen-label\b|\bsingle-arm\b|\bfirst-in-human\b|\bphase (?:1|2|3|4|i|ii|iii|iv)b?\b|\bnon-?randomi[sz]ed\b|\bextension (?:study|phase)\b/
      .test(own)
  ) {
    return rule('clinical-trial')
  }

  // 5b. Genetics papers. MeSH indexes a gene-burden or phenotype-spectrum
  //     paper as a case-control study, which it is not: the spectrum of a
  //     gene's disease in N patients is a case series, and the sequencing
  //     of thousands of cases is a cohort (D3-18). Only a paper that calls
  //     itself a case-control study keeps that design: a "case-control
  //     burden analysis" is the statistic, not the study.
  const geneticsPaper =
    /\b(?:genes?|genetic|variants?|mutations?|sequencing|exome|genome|de novo)\b/.test(text)
  if (geneticsPaper && !/\bcase[- ]control (?:study|studies|design)\b/.test(text)) {
    if (
      /\b(?:phenotypic|clinical|mutational|disease|phenotype) spectrum\b|\bspectrum of\b|\bin (?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty) (?:unrelated |affected |new )?(?:patients|individuals|children|probands|families|subjects)\b/
        .test(text)
    ) {
      return rule('case-report')
    }
    if (
      /\b(?:sequenc|screen|genotyp|analys)\w*\b[^.]{0,80}\b(?:in|of|from|across) (?:over |more than |a cohort of |a total of )?[\d,]{3,} (?:[\w-]+ ){0,2}(?:cases|patients|individuals|probands|participants|families|children)\b/
        .test(own) || hasMesh(MESH_COHORT)
    ) {
      return rule('cohort-study')
    }
  }

  // 6. Observational designs, most specific first.
  if (/\bcase[- ]control\b/.test(text) || hasMesh(MESH_CASE_CONTROL)) {
    return rule('case-control-study')
  }
  if (/\bcross[- ]sectional\b/.test(text) || hasMesh(MESH_CROSS_SECTIONAL)) {
    return rule('cross-sectional-study')
  }
  if (
    /\bcase (?:report|series|study)\b|\ba case of\b/.test(title) ||
    /\bwe (?:report|describe|present) (?:a|an|the|one|two|three|four|five|\d+) (?:[\w-]+ ){0,4}(?:case|patient|man|woman|child|boy|girl|infant|family|families)s?\b|\bthis case (?:report|series)\b|\bcase series of\b|\b(?:retrospective|consecutive|single-cent(?:re|er)) case series\b/
      .test(own) ||
    hasMesh(MESH_CASE_REPORT)
  ) {
    return rule('case-report')
  }
  if (
    /\bcohort stud(?:y|ies)\b/.test(text) ||
    /\b(?:a|our|the|this) (?:[\w-]+ ){0,3}cohort of\b/.test(own) ||
    /\bcohort\b[^.]{0,40}\b(?:were|was) (?:recruited|enrolled|followed|included|identified|assessed|studied)\b/
      .test(own) ||
    /\b(?:observational|prospective|retrospective|longitudinal|population-based|registry|register-based|linkage|nested|audit) (?:multi-?cent(?:re|er) |multi-?site |\w+ )?(?:study|analysis|design|series|audit)\b/
      .test(text) ||
    hasMesh(MESH_COHORT)
  ) {
    return rule('cohort-study')
  }
  if (
    /\b(?:an? (?:online |national |nationwide |international |web-based |electronic |cross-sectional )?survey (?:was|of|among|to|sent))\b|\bwe surveyed\b|\bsurvey respondents\b/
      .test(own)
  ) {
    return rule('survey')
  }
  if (
    /\b(?:this|in this|the present) (?:narrative )?(?:review|article|paper|chapter) (?:summari[sz]es|discusses|describes|reviews|provides an overview|examines|outlines|explores|considers|highlights)\b|\bwe review\b|\bthis review\b|\bnarrative review\b|\bin this review\b/
      .test(own)
  ) {
    return rule('narrative-review')
  }

  // 7. The stored label, only where the text corroborates it.
  const label = input.label?.trim().toLowerCase()
  if (!label) return undefined
  if (label === 'randomised-controlled-trial' || label === 'randomized-controlled-trial') {
    if (/\brandomi[sz]/.test(own) || hasMesh(MESH_RCT)) {
      return { id: 'randomised-controlled-trial', stage: 'label' }
    }
    return undefined
  }
  if (label === 'case-study' || label === 'case-report') {
    if (
      /\bcase stud(?:y|ies)\b|\bwe (?:report|describe|present) (?:a|an|the|one|two|three|\d+) (?:\w+ )?(?:patient|case|man|woman|child|boy|girl)s?\b/
        .test(text)
    ) {
      return { id: 'case-report', stage: 'label' }
    }
    return undefined
  }
  if (label === 'systematic-review') {
    if (/\breview\b/.test(text)) return { id: 'narrative-review', stage: 'label' }
    return undefined
  }
  if (label === 'protocol') {
    return /\bprotocol\b/.test(text) ? { id: 'protocol', stage: 'label' } : undefined
  }
  if (label === 'cohort-study') {
    return /\bcohort\b/.test(text) ? { id: 'cohort-study', stage: 'label' } : undefined
  }
  return undefined
}
