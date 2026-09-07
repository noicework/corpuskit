import { type TenantConfig, TenantConfigSchema } from '@research-portal/core'
import { RESULTS_QUESTION_RULE } from '../intent-router.ts'
import { TenantStore } from '../tenants.ts'

// ---------------------------------------------------------------------------
// A fictional clinical-research tenant with the full intent-routing contract
// (docs/INTENT-ROUTING.md): six intents on their own stored configurations, a
// lexicon of medication and syndrome terms, and search exclusions. The seeded
// showcase portals run the default configuration; this tenant exists so the
// router, the study guard, the safety prequeries and the trust layer are
// exercised end to end in tests. It is never registered in product code.
// ---------------------------------------------------------------------------

export const NEURO_TENANT: TenantConfig = TenantConfigSchema.parse({
  slug: 'neuro',
  branding: {
    productName: 'Neurology Research Portal',
    organisation: 'Neurology Research Collective',
    tagline: 'A fictional epilepsy research corpus used to exercise intent routing',
    colours: {
      // Deep violet carries the identity (lavender is the international
      // epilepsy awareness colour); the lighter violet is the call to action.
      primary: '#2e2359',
      accent: '#8b6fd8',
      heroFrom: '#1f1740',
      heroTo: '#4a3a8f',
    },
  },
  searchPlaceholder: 'Search seizure forecasting, genetics, antiseizure medications, surgery…',
  assessmentHeading: 'Research knowledge areas',
  // Dates the portal writes are the portal's, not the server's.
  timezone: 'Australia/Melbourne',
  // A global research initiative: the corpus is not organised by Australian
  // state, so Explore omits the regional discovery band.
  regionalDiscovery: false,
  // Supplements and videos stay browsable in the library, but search and ask
  // are grounded in the articles themselves.
  searchExclude: [
    { labelset: 'format', label: 'supplement' },
    { labelset: 'format', label: 'media' },
  ],
  // One ask box, six jobs-to-be-done, each on its own stored search
  // configuration (docs/INTENT-ROUTING.md). Order matters: stage-1 rules are
  // tried in this order and the first match wins.
  defaultIntent: 'general',
  entityTerms: [
    'fenfluramine',
    'stiripentol',
    'cannabidiol',
    'clobazam',
    'valproate',
    'sodium valproate',
    'lamotrigine',
    'levetiracetam',
    'carbamazepine',
    'oxcarbazepine',
    'phenytoin',
    'vigabatrin',
    'topiramate',
    'lacosamide',
    'cenobamate',
    'perampanel',
    'brivaracetam',
    'zonisamide',
    'ethosuximide',
    'phenobarbital',
    'rufinamide',
    'everolimus',
    'ganaxolone',
    'diazepam',
    'midazolam',
    'ketogenic diet',
    // The autoimmune encephalitis immunotherapies the group's papers
    // report on: a terse clinic question about them routes by rule, and
    // the study guard reads them as the question's drug (D4-08).
    'rituximab',
    'cyclophosphamide',
    'methylprednisolone',
    'immunoglobulin',
    'Dravet',
    'Lennox-Gastaut',
    'LGI1',
    'NMDAR',
  ],
  intents: [
    {
      id: 'lookup',
      label: 'Exact lookup',
      description: 'An identifier or a bare term: the reader wants the documents, not an essay.',
      examples: ['SCN8A', 'PMC8371239', 'cenobamate', 'Dravet'],
      retrieval: {
        features: ['keyword'],
        topK: 30,
        reranker: 'noop',
        exclude: [
          { labelset: 'format', label: 'supplement' },
          { labelset: 'format', label: 'media' },
        ],
      },
      answer: { surfaces: ['search'], strategy: 'none', promptVariant: 'default' },
      // One or two bare tokens, and only when one of them is a recognised
      // entity (a gene-symbol shape or a lexicon term): "SCN8A", "cenobamate",
      // "Dravet syndrome". Two arbitrary words ("Okafor recurrence") and
      // hyphenated compounds ("EEG-fMRI") are questions for retrieval, not a
      // listing. Identifiers (DOI, PMCID, PMID) are handled by the router
      // itself, before any rule. The classifier can never pick this intent.
      rules: ['^\\s*\\S+(?:\\s+\\S+)?\\s*$'],
      requireEntity: true,
      rulesOnly: true,
    },
    {
      id: 'data',
      label: 'Supplementary data',
      description:
        'Only for a question that explicitly asks for a supplementary table, data sheet, ' +
        'appendix, protocol document, peer review history or raw data. Never for a result, ' +
        'a rate or a trial design that the paper itself reports.',
      examples: [
        'Sample size calculation in the SERIAS protocol',
        'Supplementary table of variants in the exome study',
        'What did the peer reviewers say about the BREATHS protocol?',
      ],
      // The papers and their attachments together, with a second retrieval
      // pass over the attachments alone: a data question reads the paper's
      // own results beside its tables, never the tables alone (a supplement
      // never states what the trial was).
      retrieval: {
        features: ['keyword', 'semantic'],
        topK: 20,
        reranker: 'predict',
        exclude: [{ labelset: 'format', label: 'media' }],
        prefer: [{ labelset: 'format', label: 'supplement' }],
      },
      answer: {
        surfaces: ['ask', 'search'],
        strategy: 'neighbours',
        neighbours: 4,
        promptVariant: 'data',
      },
      // The word must name an attachment: "protocol" alone is a methods
      // question, "the BREATHS trial protocol" is a document. A sample size
      // is a figure the paper reports, so it is a results question below.
      rules: [
        '\\b(supplement|supplementary|data ?sheet|table s\\d|appendix|appendices|' +
        '(?:study|trial|research) protocol|protocol (?:paper|document|publication)|' +
        'peer[- ]review\\w*|raw data|datasets?)\\b',
      ],
      ruleRationale: 'the question names a table, a protocol document or a peer review file',
      classifierGate: [
        '\\b(tables?|supplement\\w*|data ?sheets?|appendi(?:x|ces)|protocol\\w*|' +
        'peer[- ]review\\w*|raw data|datasets?)\\b',
      ],
    },
    {
      id: 'latest',
      label: 'Latest evidence',
      description: 'What is newest on a topic, newest first with the year stated.',
      examples: ['Latest on responsive neurostimulation', 'Any 2026 papers on cannabidiol?'],
      retrieval: {
        features: ['keyword', 'semantic'],
        topK: 20,
        reranker: 'predict',
        exclude: [
          { labelset: 'format', label: 'supplement' },
          { labelset: 'format', label: 'media' },
        ],
      },
      answer: {
        surfaces: ['ask'],
        strategy: 'neighbours',
        neighbours: 2,
        promptVariant: 'recency',
        prequeries: ['{query} published 2025 or 2026'],
        sortByPublished: true,
      },
      // A recency word is required: a bare year ("Seery 2025 rituximab") is an
      // author-year lookup, not a request for what is newest.
      rules: [
        '\\b(latest|newest|most recent|recent|recently|this year|since 20\\d\\d|(?:in|from|published in) 202[5-9]|202[5-9] (?:papers?|studies|publications|trials?))\\b',
      ],
    },
    {
      id: 'clinical',
      label: 'Clinical decision',
      description:
        'Choosing, avoiding or dosing a treatment for a patient: contraindications and monitoring are checked every time.',
      examples: [
        'Which ASMs should be avoided in SCN1A Dravet?',
        'Fenfluramine dose with stiripentol?',
      ],
      retrieval: {
        features: ['keyword', 'semantic'],
        topK: 12,
        reranker: 'predict',
        exclude: [
          { labelset: 'format', label: 'supplement' },
          { labelset: 'format', label: 'media' },
          { labelset: 'kind', label: 'case-study' },
        ],
      },
      answer: {
        surfaces: ['ask'],
        strategy: 'neighbours',
        neighbours: 3,
        graph: true,
        promptVariant: 'safety',
        prequeries: [
          'contraindications, drugs to avoid and safety monitoring for {entities}',
          'dose limits, starting dose and interactions for {entities}',
        ],
        minScore: 0.6,
      },
      rules: [
        '\\b(dose|dosing|dosage|start(ing)?|titrat|avoid|contraindicat|safe|safety|should i|which asm|first[- ]line|add[- ]on|switch|interaction|pregnan|monitor)',
      ],
      // A medication or syndrome from the lexicon must be named: "dose" in a
      // rodent selenate protocol is a methods question, not a prescribing one.
      requireEntity: true,
      requireLexiconEntity: true,
    },
    {
      id: 'review',
      label: 'Evidence review',
      description: 'Synthesis across the corpus, grounded on full text.',
      examples: [
        'What is known about multiday seizure cycles?',
        'Compare SCN1A, SCN2A and SCN8A gain versus loss of function',
      ],
      retrieval: {
        features: ['keyword', 'semantic'],
        topK: 20,
        reranker: 'predict',
        exclude: [
          { labelset: 'format', label: 'supplement' },
          { labelset: 'format', label: 'media' },
        ],
      },
      answer: { surfaces: ['ask'], strategy: 'full', promptVariant: 'synthesis', depth: 'deep' },
      // Length is not a rule: a 26-word fitness-to-drive lookup is not a
      // review, and the classifier reads the question instead.
      rules: [
        '\\b(compare|comparison|versus|\\bvs\\b|synthesis|what is known|evidence for|overview|across studies|mechanism)\\b',
        // A survey of what a group or a field has published is a review,
        // not a lookup of one figure.
        '\\b(what (?:has|have) .{0,80}published|published on|literature on|body of work|state of the (?:art|evidence))\\b',
      ],
    },
    {
      id: 'general',
      label: 'General',
      description: 'Everything else, on the default configuration.',
      examples: ['How does the ketogenic diet work?'],
      retrieval: {
        features: ['keyword', 'semantic'],
        topK: 30,
        reranker: 'predict',
        exclude: [
          { labelset: 'format', label: 'supplement' },
          { labelset: 'format', label: 'media' },
        ],
      },
      answer: {
        surfaces: ['ask', 'search'],
        strategy: 'neighbours',
        neighbours: 2,
        graph: true,
        promptVariant: 'default',
      },
      // A question for a figure the paper reports (a rate, a count, an
      // outcome, a sample size) reads the papers by rule: the classifier
      // used to send every such question to the supplements, and the
      // rule answers in microseconds.
      rules: [RESULTS_QUESTION_RULE],
      ruleRationale: 'a results question, answered from the papers themselves',
    },
  ],
  topics: [
    { id: 'seizure-forecasting-cycles', label: 'Seizure forecasting and cycles' },
    { id: 'genetics-genomics', label: 'Genetics and genomics' },
    { id: 'antiseizure-medications', label: 'Antiseizure medications' },
    { id: 'pregnancy-teratogenicity', label: 'Pregnancy and teratogenicity' },
    { id: 'epilepsy-surgery-imaging', label: 'Epilepsy surgery and imaging' },
    { id: 'eeg-neurophysiology', label: 'EEG and neurophysiology' },
    { id: 'autoimmune-encephalitis', label: 'Autoimmune encephalitis' },
    { id: 'devices-neurostimulation', label: 'Devices and neurostimulation' },
    { id: 'psychiatry-functional-seizures', label: 'Psychiatry and functional seizures' },
    { id: 'epidemiology-outcomes', label: 'Epidemiology and outcomes' },
  ],
  suggestedQuestions: [
    {
      id: 'neuro-q1',
      text: 'What are the common clinical misconceptions about multiday seizure cycles?',
    },
    {
      id: 'neuro-q2',
      text:
        'Which antiseizure medications carry the highest risk of major congenital malformations?',
    },
    {
      id: 'neuro-q3',
      text: 'How effective is adjunctive cannabidiol for drug-resistant focal epilepsy?',
    },
    {
      id: 'neuro-q4',
      text: 'When is stereo-EEG indicated in presurgical evaluation of focal epilepsy?',
    },
    {
      id: 'neuro-q5',
      text: 'What predicts quality of life and depression after a first seizure?',
    },
    {
      id: 'neuro-q6',
      text: 'Which genes are implicated in developmental and epileptic encephalopathies?',
    },
  ],
  entityTypes: [
    { id: 'condition', label: 'Condition or syndrome', colour: '#e5533d' },
    { id: 'gene', label: 'Gene or variant', colour: '#f2a93b' },
    { id: 'medication', label: 'Medication or treatment', colour: '#3fa66b' },
    { id: 'researcher', label: 'Researcher', colour: '#5e97f6' },
    { id: 'institution', label: 'Institution', colour: '#8b6fd8' },
    { id: 'method', label: 'Method or device', colour: '#26a69a' },
  ],
  relationTypes: [
    'studies',
    'treats',
    'associated-with',
    'causes',
    'conducted-at',
    'collaborates-with',
  ],
})

/**
 * A hermetic tenant store carrying the seeded showcase portals plus the
 * fixture tenant above, persisted under a fresh temporary directory so no
 * test reads the repository's live data/tenants.json.
 */
export function tenantsWithNeuro(): TenantStore {
  const dir = Deno.makeTempDirSync()
  const path = `${dir}/tenants.json`
  Deno.writeTextFileSync(path, JSON.stringify({ custom: { neuro: NEURO_TENANT } }))
  return new TenantStore({ TENANTS_PATH: path })
}
