import { z } from 'zod'

/**
 * A portal's monthly usage report (docs/USAGE-REPORTS.md): one row for each calendar day of the
 * month in the portal's timezone, and the month's totals, counted from the ask log, readers'
 * ratings and the knowledge box. The CSV export and the printable report share these columns and
 * their definitions. A count the portal no longer holds is null, never zero.
 */

/** A calendar month, as `YYYY-MM`. */
export const UsageMonthSchema = z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])$/)

const UsageDateSchema = z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/)
const Count = z.number().int().nonnegative().nullable()
/** A response time in seconds, to one decimal place; null when none was measured. */
const Seconds = z.number().nonnegative().nullable()

export const TopicUsageSchema = z.object({
  id: z.string(),
  label: z.string(),
  questions: z.number().int().nonnegative(),
  citedDocuments: z.number().int().nonnegative().nullable(),
  totalDocuments: z.number().int().nonnegative().nullable(),
}).strict()
export type TopicUsage = z.infer<typeof TopicUsageSchema>

const UsageCountsSchema = z.object({
  topics: TopicUsageSchema.array().nullable(),
  searches: Count,
  searchP50: Seconds,
  searchP90: Seconds,
  searchP95: Seconds,
  opens: Count,
  openRate: z.number().min(0).max(1).nullable(),
  meanOpenRank: z.number().nonnegative().nullable(),
  consumptionAnswers: Count,
  inputTokens: Count,
  outputTokens: Count,
  questions: Count,
  answered: Count,
  unanswered: Count,
  weaklyGrounded: Count,
  knowledgeGaps: Count,
  scoredAnswers: Count,
  averageGroundedness: z.number().min(0).max(5).nullable(),
  ratings: Count,
  unhelpfulRatings: Count,
  documentsAdded: Count,
  timedAnswers: Count,
  firstTokenP50: Seconds,
  firstTokenP90: Seconds,
  firstTokenP95: Seconds,
  answerTimeP50: Seconds,
  answerTimeP90: Seconds,
  answerTimeP95: Seconds,
  generationTimed: Count,
  generationTimeP50: Seconds,
  generationTimeP90: Seconds,
  generationTimeP95: Seconds,
}).strict()
export type UsageCounts = z.infer<typeof UsageCountsSchema>

export const UsageDaySchema = UsageCountsSchema.extend({ date: UsageDateSchema }).strict()
export type UsageDay = z.infer<typeof UsageDaySchema>

/**
 * Where a source's records begin. `from` is the first day whose records the portal still holds
 * in full, when that is later than the report's first day; null when it holds the whole period.
 */
const CoverageSchema = z.object({ from: UsageDateSchema.nullable() }).strict()

export const UsageReportSchema = z.object({
  slug: z.string().min(1),
  month: UsageMonthSchema,
  /** The IANA timezone the days are counted in: the portal's, or UTC when it states none. */
  timezone: z.string().min(1),
  generatedAt: z.string().datetime(),
  /** The report's last day: the month's last day, or today while the month is in progress. */
  through: UsageDateSchema,
  inProgress: z.boolean(),
  days: UsageDaySchema.array(),
  /** Sums over the days each source holds; null when it holds none of them. */
  totals: UsageCountsSchema,
  coverage: z.object({
    asks: CoverageSchema,
    /** Ratings are kept for `retentionDays`, and at most `kept` of them. */
    ratings: CoverageSchema.extend({
      retentionDays: z.number().int().positive(),
      kept: z.number().int().positive(),
    }).strict(),
    /** `available` is false when the knowledge box could not be read at all. */
    documents: CoverageSchema.extend({ available: z.boolean() }).strict(),
  }).strict(),
}).strict()
export type UsageReport = z.infer<typeof UsageReportSchema>

/** Which record a column is counted from. */
export type UsageSource = 'asks' | 'ratings' | 'documents'

export interface UsageColumn {
  key: keyof UsageDay | 'notes'
  /** The CSV heading. */
  heading: string
  /** The printable report's column label. */
  label: string
  /**
   * What the column counts. Written without commas or double quotes, so it can head a CSV as a
   * `#` comment line that spreadsheets show in one cell and CSV readers skip.
   */
  definition: string
  source?: UsageSource
  /**
   * A response time column: the printable report shows the month's times in a table of their
   * own rather than a column per day.
   */
  timing?: true
}

export const USAGE_COLUMNS: readonly UsageColumn[] = Object.freeze(
  [
    {
      key: 'date',
      heading: 'date',
      label: 'Date',
      definition:
        "The calendar day in the portal's timezone as YYYY-MM-DD; the row named total covers the whole month",
    },
    {
      key: 'questions',
      heading: 'questions',
      label: 'Questions',
      definition:
        "Research questions asked in the portal's assistant that day; a question asked across several portals counts in each portal it searched; help questions are not counted",
      source: 'asks',
    },
    {
      key: 'answered',
      heading: 'answered',
      label: 'Answered',
      definition: 'Questions answered with at least one cited source',
      source: 'asks',
    },
    {
      key: 'unanswered',
      heading: 'unanswered',
      label: 'Unanswered',
      definition:
        'Questions the collection could not answer: declined or failed answers and answers without a cited source',
      source: 'asks',
    },
    {
      key: 'weaklyGrounded',
      heading: 'weakly_grounded',
      label: 'Weakly grounded',
      definition: 'Answered questions with a groundedness score of 2 or less out of 5',
      source: 'asks',
    },
    {
      key: 'knowledgeGaps',
      heading: 'knowledge_gaps',
      label: 'Knowledge gaps',
      definition:
        'Unanswered plus weakly grounded questions; the questions Insights lists as knowledge gaps',
      source: 'asks',
    },
    {
      key: 'scoredAnswers',
      heading: 'scored_answers',
      label: 'Scored answers',
      definition: 'Answered questions that received a groundedness score',
      source: 'asks',
    },
    {
      key: 'averageGroundedness',
      heading: 'average_groundedness',
      label: 'Average groundedness',
      definition:
        'The mean groundedness score of scored answers from 0 to 5 to one decimal place; it measures how well the cited passages support each answer; blank when no answer was scored',
      source: 'asks',
    },
    {
      key: 'ratings',
      heading: 'ratings',
      label: 'Ratings',
      definition:
        "Readers' helpful and unhelpful ratings received that day for answers this portal gave",
      source: 'ratings',
    },
    {
      key: 'unhelpfulRatings',
      heading: 'unhelpful_ratings',
      label: 'Unhelpful ratings',
      definition: 'Ratings received that day that marked an answer unhelpful',
      source: 'ratings',
    },
    {
      key: 'documentsAdded',
      heading: 'documents_added',
      label: 'Documents added',
      definition:
        'Library documents added that day that the knowledge box still holds; drafts and help pages and failed imports are not counted',
      source: 'documents',
    },
    {
      key: 'timedAnswers',
      heading: 'timed_answers',
      label: 'Timed answers',
      definition:
        'Answered questions whose response times the portal server measured; it has measured them since the release that added these columns',
      source: 'asks',
      timing: true,
    },
    {
      key: 'firstTokenP50',
      heading: 'first_token_p50',
      label: 'Time to first token p50',
      definition:
        'Median seconds from the portal server receiving a question to sending the first words of its answer; over timed answers',
      source: 'asks',
      timing: true,
    },
    {
      key: 'firstTokenP90',
      heading: 'first_token_p90',
      label: 'Time to first token p90',
      definition: 'The 90th percentile of the time to first token in seconds',
      source: 'asks',
      timing: true,
    },
    {
      key: 'firstTokenP95',
      heading: 'first_token_p95',
      label: 'Time to first token p95',
      definition: 'The 95th percentile of the time to first token in seconds',
      source: 'asks',
      timing: true,
    },
    {
      key: 'answerTimeP50',
      heading: 'answer_time_p50',
      label: 'Answer time p50',
      definition:
        'Median seconds from the portal server receiving a question to finishing its answer; over timed answers',
      source: 'asks',
      timing: true,
    },
    {
      key: 'answerTimeP90',
      heading: 'answer_time_p90',
      label: 'Answer time p90',
      definition: 'The 90th percentile of the answer time in seconds',
      source: 'asks',
      timing: true,
    },
    {
      key: 'answerTimeP95',
      heading: 'answer_time_p95',
      label: 'Answer time p95',
      definition: 'The 95th percentile of the answer time in seconds',
      source: 'asks',
      timing: true,
    },
    {
      key: 'generationTimed',
      heading: 'generation_timed',
      label: 'Generation timed',
      definition: 'Answered questions with a generation time reported by the knowledge box',
      source: 'asks',
      timing: true,
    },
    {
      key: 'generationTimeP50',
      heading: 'generation_time_p50',
      label: 'Generation time p50',
      definition:
        "Median seconds the knowledge box reports spending to generate an answer; it leaves out the portal's own routing and checks and the network to the reader",
      source: 'asks',
      timing: true,
    },
    {
      key: 'generationTimeP90',
      heading: 'generation_time_p90',
      label: 'Generation time p90',
      definition: 'The 90th percentile of the generation time in seconds',
      source: 'asks',
      timing: true,
    },
    {
      key: 'generationTimeP95',
      heading: 'generation_time_p95',
      label: 'Generation time p95',
      definition: 'The 95th percentile of the generation time in seconds',
      source: 'asks',
      timing: true,
    },
    {
      key: 'searches',
      heading: 'searches',
      label: 'Searches',
      definition: 'Successful search requests timed by the portal server',
      timing: true,
    },
    {
      key: 'searchP50',
      heading: 'search_p50',
      label: 'Search time p50',
      definition:
        'Median seconds from receiving a search to preparing its response; excludes the reader network',
      timing: true,
    },
    {
      key: 'searchP90',
      heading: 'search_p90',
      label: 'Search time p90',
      definition: 'The 90th percentile of search response time in seconds',
      timing: true,
    },
    {
      key: 'searchP95',
      heading: 'search_p95',
      label: 'Search time p95',
      definition: 'The 95th percentile of search response time in seconds',
      timing: true,
    },
    {
      key: 'opens',
      heading: 'opens',
      label: 'Opens',
      definition: 'Accepted citation and search result open events in the period',
    },
    {
      key: 'openRate',
      heading: 'open_rate',
      label: 'Open rate',
      definition:
        'Share of answers with citations and searches with results in the period that received at least one open in the period; not a unique reader count',
    },
    {
      key: 'meanOpenRank',
      heading: 'mean_open_rank',
      label: 'Mean rank opened',
      definition: 'Mean one-based citation or search result rank across accepted opens',
    },
    {
      key: 'consumptionAnswers',
      heading: 'consumption_answers',
      label: 'Answers with token usage',
      definition:
        'Questions with provider-reported consumption; includes failed attempts and retries when reported',
    },
    {
      key: 'inputTokens',
      heading: 'input_tokens',
      label: 'Input tokens',
      definition:
        'Provider-reported input tokens for research answers; blank when none were reported; excludes shared platform overhead and other operations',
    },
    {
      key: 'outputTokens',
      heading: 'output_tokens',
      label: 'Output tokens',
      definition:
        'Provider-reported output tokens for research answers; blank when none were reported; tokens have no price in this report',
    },
    {
      key: 'topics',
      heading: 'topics',
      label: 'Topics and evidence coverage',
      definition:
        'JSON by topic: questions count once per topic of cited documents; citedDocuments are distinct currently held documents cited in the period; totalDocuments is the current topic document count; null means unavailable',
    },
    {
      key: 'notes',
      heading: 'notes',
      label: 'Notes',
      definition:
        'Why cells in the row are blank: the records for that day are past their retention period or could not be read',
    },
  ] satisfies UsageColumn[],
)
