/**
 * Retrieval accuracy measurement harness.
 *
 * Runs a fixed set of fisheries-research scientist questions against a live,
 * deployed portal's `/ask` API and scores each answer, then reports a
 * scorecard plus a machine-diffable summary block of aggregate numbers. This
 * is how "the accuracy level" gets reported at handover, and how a retrieval
 * config change (rag_strategies, search configurations, reranker) gets
 * compared before/after - evidence, not assertion (see docs/VISION.md's
 * 2026-08-28 trust-through-transparency directive).
 *
 * Each question is scored on:
 *   - retrieved sources count
 *   - REMi answer relevance, groundedness, context relevance (0-5, from the
 *     `quality` event the same live REMi call the product itself uses)
 *   - refused flag
 *   - citation integrity: every `[n]` marker in the final answer text
 *     resolves to a citation the platform actually returned (the same claim-
 *     level grounding guarantee the UI relies on - see citationIntegrity)
 *   - first-token and total latency
 *
 * In-corpus questions are graded on whether they were answered (not
 * refused, not errored, cited); out-of-corpus questions are graded on
 * whether the portal honestly refused rather than hallucinating.
 *
 * Usage:
 *   BASE_URL=https://your-portal.example.com TENANT=marine \
 *     deno run --allow-net --allow-env apps/api/scripts/accuracy-eval.ts
 *
 * Read-only: every question is a plain `/ask` call over HTTP, same as a real
 * user question. Asks are spaced (ASK_SPACING_MS) to stay under the
 * portal's 20/min/IP rate limit on the ask route (apps/api/src/app.ts,
 * RATE_LIMIT_ASK_PER_MIN).
 */
import process from 'node:process'
import { citationIntegrity, sseEvents } from './lib/ask-stream.ts'

/**
 * Re-exported so this module stays the import site for its own scorecard
 * helpers even though the implementation is now shared with the other live
 * harnesses.
 */
export { citationIntegrity }

export interface EvalQuestion {
  query: string
  /** Short label for the topic this question probes - for the scorecard and grouping, not an automated grading input. */
  expectedTopic: string
  /** True for a deliberately out-of-corpus question - graded on honest refusal, not on being answered. */
  outOfCorpus?: boolean
}

/**
 * Fisheries-research scientist questions written against the `marine` seed
 * corpus - the ten synthetic research documents in `content/seed/marine/` and
 * the metadata `content/seed/manifest.json` uploads alongside them. Every
 * in-corpus topic below was checked against those documents before this list
 * was written, so an unanswered in-corpus question is a portal finding rather
 * than a question about material the corpus never held.
 *
 * A bank written for a real corpus should be verified the same way against
 * that corpus first, through `/api/t/<tenant>/search`.
 */
export const QUESTIONS: EvalQuestion[] = [
  {
    query: 'What survey and catch-curve analysis methods are used to assess abalone stock status?',
    expectedTopic: 'abalone-stock-assessment',
  },
  {
    query:
      'What did the marine heatwave mean for juvenile abalone recruitment in the southern zone?',
    expectedTopic: 'marine-heatwave',
  },
  {
    query:
      'What do the southern rock lobster effort scenarios show about spawning biomass and the limit reference point?',
    expectedTopic: 'rock-lobster-assessment',
  },
  {
    query:
      'How are total allowable catch and legal minimum length used to control catch in these fisheries?',
    expectedTopic: 'catch-controls',
  },
  {
    query:
      'What trial results have been reported for reducing shark bycatch in longline fisheries?',
    expectedTopic: 'shark-bycatch',
  },
  {
    query: 'How are baited remote underwater video surveys standardised for reef fish monitoring?',
    expectedTopic: 'reef-monitoring',
  },
  {
    query: 'How is biosecurity risk tiered for sea-cage finfish farming operations?',
    expectedTopic: 'seacage-biosecurity',
  },
  {
    query: 'What fallowing practice reduces pathogen carryover between stocking cycles?',
    expectedTopic: 'aquaculture-fallowing',
  },
  {
    query: 'How was white spot disease transmitted between prawn farms and how is it controlled?',
    expectedTopic: 'white-spot-disease',
  },
  {
    query: 'How does triploid Pacific oyster growth compare with diploid stock?',
    expectedTopic: 'triploid-oysters',
  },
  {
    query: 'What post-harvest protocols best preserve premium finfish quality for export?',
    expectedTopic: 'coldchain-export',
  },
  {
    query: 'What did the seafood traceability pilot find about operator adoption and buyer demand?',
    expectedTopic: 'seafood-traceability',
  },
  {
    query: 'What do national surveys tell us about recreational fishing participation and catch?',
    expectedTopic: 'recreational-fishing',
  },
  {
    query:
      'How should catch estimates inform allocation between recreational and commercial sectors?',
    expectedTopic: 'fisheries-allocation',
  },
  {
    query:
      'What is the capital of Mongolia, and how many Michelin-starred restaurants does it have?',
    expectedTopic: 'out-of-corpus: geography/dining trivia',
    outOfCorpus: true,
  },
  {
    query: 'What were the main causes of the 2008 global financial crisis?',
    expectedTopic: 'out-of-corpus: macroeconomics',
    outOfCorpus: true,
  },
  {
    query: 'What are the recommended first-line treatments for type 2 diabetes in adults?',
    expectedTopic: 'out-of-corpus: clinical medicine',
    outOfCorpus: true,
  },
]

/** Pause between successive asks - stays well under the portal's 20/min/IP ask rate limit. */
const ASK_SPACING_MS = 3_500
const ASK_TIMEOUT_MS = 60_000

export interface QuestionResult {
  query: string
  expectedTopic: string
  outOfCorpus: boolean
  /** False when the harness itself failed to get a usable stream (HTTP error, timeout, no `done` event). */
  ok: boolean
  detail?: string
  sourcesCount: number
  refused: boolean
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
  citationMarkers: number
  citationUnresolved: number
  firstTokenMs: number | null
  totalMs: number
}

async function runQuestion(base: string, tenant: string, q: EvalQuestion): Promise<QuestionResult> {
  const start = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)

  const empty: QuestionResult = {
    query: q.query,
    expectedTopic: q.expectedTopic,
    outOfCorpus: q.outOfCorpus ?? false,
    ok: false,
    sourcesCount: 0,
    refused: false,
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
    citationMarkers: 0,
    citationUnresolved: 0,
    firstTokenMs: null,
    totalMs: 0,
  }

  let firstTokenMs: number | null = null
  let sourcesCount = 0
  const citationIndices = new Set<number>()
  let refused = false
  let finalText = ''
  let streamedText = ''
  let sawDone = false
  let sawError: string | null = null
  let answerRelevance: number | null = null
  let groundedness: number | null = null
  let contextRelevance: number | null = null

  try {
    const res = await fetch(`${base}/api/t/${tenant}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q.query }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ...empty, detail: `HTTP ${res.status}`, totalMs: performance.now() - start }
    }

    for await (const event of sseEvents(res)) {
      switch (event.type) {
        case 'sources': {
          const resources = event.resources
          if (Array.isArray(resources)) sourcesCount = Math.max(sourcesCount, resources.length)
          break
        }
        case 'delta': {
          if (firstTokenMs === null) firstTokenMs = performance.now() - start
          if (typeof event.text === 'string') streamedText += event.text
          break
        }
        case 'citation': {
          const citation = event.citation as { index?: unknown } | undefined
          if (citation && typeof citation.index === 'number') citationIndices.add(citation.index)
          break
        }
        case 'quality': {
          answerRelevance = typeof event.answerRelevance === 'number' ? event.answerRelevance : null
          groundedness = typeof event.groundedness === 'number' ? event.groundedness : null
          contextRelevance = typeof event.contextRelevance === 'number'
            ? event.contextRelevance
            : null
          break
        }
        case 'done': {
          sawDone = true
          refused = event.refused === true
          finalText = typeof event.text === 'string' ? event.text : streamedText
          break
        }
        case 'error': {
          sawError = typeof event.message === 'string' ? event.message : 'unknown error'
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    return {
      ...empty,
      detail: controller.signal.aborted
        ? `timed out after ${ASK_TIMEOUT_MS}ms`
        : err instanceof Error
        ? err.message
        : String(err),
      totalMs: performance.now() - start,
    }
  } finally {
    clearTimeout(timeout)
  }

  const totalMs = performance.now() - start
  if (!sawDone) {
    return {
      ...empty,
      detail: sawError ? `stream errored: ${sawError}` : 'stream ended without a done event',
      totalMs,
    }
  }

  const { markers, unresolved } = citationIntegrity(finalText, citationIndices)
  return {
    query: q.query,
    expectedTopic: q.expectedTopic,
    outOfCorpus: q.outOfCorpus ?? false,
    ok: true,
    detail: sawError ?? undefined,
    sourcesCount,
    refused,
    answerRelevance,
    groundedness,
    contextRelevance,
    citationMarkers: markers.length,
    citationUnresolved: unresolved.length,
    firstTokenMs,
    totalMs,
  }
}

export interface Summary {
  questionsTotal: number
  inCorpusTotal: number
  outOfCorpusTotal: number
  harnessErrors: number
  answeredCount: number
  answeredPct: number
  refusedInCorpusCount: number
  outOfCorpusRefusedCount: number
  outOfCorpusRefusedPct: number
  meanSourcesCount: number | null
  meanAnswerRelevance: number | null
  meanGroundedness: number | null
  meanContextRelevance: number | null
  citationCoverageRate: number | null
  citationIntegrityRate: number | null
  meanFirstTokenMs: number | null
  meanTotalMs: number | null
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
}

function pct(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((part / whole) * 1000) / 10
}

/**
 * Aggregates per-question results into the scorecard's summary block. Pure
 * and side-effect free so it is unit-testable against fabricated results -
 * this is the arithmetic the client-facing accuracy numbers rest on, so it
 * is worth locking down independently of any live platform call.
 *
 * "Answered" (for the answered/refused/citation metrics) means an in-corpus
 * question the harness itself completed successfully (`ok`) and the portal
 * did not refuse - a harness-level failure (timeout, HTTP error) is
 * reported separately as `harnessErrors` rather than folded into "refused",
 * since the two mean different things at handover: one is the portal
 * declining honestly, the other is the harness (or the portal) breaking.
 */
export function summarize(results: QuestionResult[]): Summary {
  const inCorpus = results.filter((r) => !r.outOfCorpus)
  const outOfCorpus = results.filter((r) => r.outOfCorpus)
  const harnessErrors = results.filter((r) => !r.ok)
  const answered = inCorpus.filter((r) => r.ok && !r.refused)
  const refusedInCorpus = inCorpus.filter((r) => r.ok && r.refused)
  const outOfCorpusRefused = outOfCorpus.filter((r) => r.ok && r.refused)

  const withCitationMarkers = answered.filter((r) => r.citationMarkers > 0)
  const integrityClean = withCitationMarkers.filter((r) => r.citationUnresolved === 0)

  return {
    questionsTotal: results.length,
    inCorpusTotal: inCorpus.length,
    outOfCorpusTotal: outOfCorpus.length,
    harnessErrors: harnessErrors.length,
    answeredCount: answered.length,
    answeredPct: pct(answered.length, inCorpus.length) ?? 0,
    refusedInCorpusCount: refusedInCorpus.length,
    outOfCorpusRefusedCount: outOfCorpusRefused.length,
    outOfCorpusRefusedPct: pct(outOfCorpusRefused.length, outOfCorpus.length) ?? 0,
    meanSourcesCount: mean(answered.map((r) => r.sourcesCount)),
    meanAnswerRelevance: mean(
      answered.map((r) => r.answerRelevance).filter((v): v is number => v !== null),
    ),
    meanGroundedness: mean(
      answered.map((r) => r.groundedness).filter((v): v is number => v !== null),
    ),
    meanContextRelevance: mean(
      answered.map((r) => r.contextRelevance).filter((v): v is number => v !== null),
    ),
    citationCoverageRate: pct(withCitationMarkers.length, answered.length),
    citationIntegrityRate: pct(integrityClean.length, withCitationMarkers.length),
    meanFirstTokenMs: mean(
      answered.map((r) => r.firstTokenMs).filter((v): v is number => v !== null),
    ),
    meanTotalMs: mean(answered.map((r) => r.totalMs)),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fmtMs(ms: number | null): string {
  return ms === null ? 'n/a' : `${Math.round(ms)}ms`
}

function printScorecard(results: QuestionResult[]) {
  console.log('\n=== SCORECARD ===')
  for (const r of results) {
    const tag = r.outOfCorpus ? '[out-of-corpus]' : '[in-corpus]    '
    if (!r.ok) {
      console.log(`${tag} FAIL  "${r.query}" - ${r.detail}`)
      continue
    }
    const verdict = r.outOfCorpus
      ? (r.refused ? 'PASS (refused)' : 'FAIL (should have refused)')
      : (r.refused ? 'REFUSED' : 'ANSWERED')
    const quality = r.outOfCorpus
      ? ''
      : ` sources=${r.sourcesCount} citations=${r.citationMarkers}` +
        `${r.citationUnresolved > 0 ? ` (${r.citationUnresolved} unresolved!)` : ''}` +
        ` relevance=${r.answerRelevance ?? 'n/a'} groundedness=${r.groundedness ?? 'n/a'}` +
        ` contextRel=${r.contextRelevance ?? 'n/a'} firstToken=${fmtMs(r.firstTokenMs)}` +
        ` total=${fmtMs(r.totalMs)}`
    console.log(`${tag} ${verdict.padEnd(26)} [${r.expectedTopic}] "${r.query}"${quality}`)
  }
}

/**
 * The machine-diffable summary block: stable `key: value` lines so two runs
 * (before/after a retrieval config change) can be diffed directly with
 * `diff` or `git diff` on saved output, per docs/VISION.md's directive to
 * tune retrieval "against measured results, not assertion".
 */
function printSummary(base: string, tenant: string, s: Summary) {
  console.log('\n=== SUMMARY ===')
  console.log(`base_url: ${base}`)
  console.log(`tenant: ${tenant}`)
  console.log(`timestamp: ${new Date().toISOString()}`)
  console.log(`questions_total: ${s.questionsTotal}`)
  console.log(`in_corpus_total: ${s.inCorpusTotal}`)
  console.log(`out_of_corpus_total: ${s.outOfCorpusTotal}`)
  console.log(`harness_errors: ${s.harnessErrors}`)
  console.log(`answered_count: ${s.answeredCount}`)
  console.log(`answered_pct: ${s.answeredPct}`)
  console.log(`refused_in_corpus_count: ${s.refusedInCorpusCount}`)
  console.log(`out_of_corpus_refused_count: ${s.outOfCorpusRefusedCount}`)
  console.log(`out_of_corpus_refused_pct: ${s.outOfCorpusRefusedPct}`)
  console.log(`mean_sources_count: ${s.meanSourcesCount ?? 'n/a'}`)
  console.log(`mean_answer_relevance: ${s.meanAnswerRelevance ?? 'n/a'}`)
  console.log(`mean_groundedness: ${s.meanGroundedness ?? 'n/a'}`)
  console.log(`mean_context_relevance: ${s.meanContextRelevance ?? 'n/a'}`)
  console.log(`citation_coverage_rate_pct: ${s.citationCoverageRate ?? 'n/a'}`)
  console.log(`citation_integrity_rate_pct: ${s.citationIntegrityRate ?? 'n/a'}`)
  console.log(`mean_first_token_ms: ${s.meanFirstTokenMs ?? 'n/a'}`)
  console.log(`mean_total_ms: ${s.meanTotalMs ?? 'n/a'}`)
  console.log('\n=== SUMMARY (JSON) ===')
  console.log(JSON.stringify(s))
}

async function main() {
  const base = (process.env.BASE_URL ?? '').replace(/\/+$/, '')
  if (!base) {
    console.error('Missing BASE_URL - e.g. BASE_URL=https://your-portal.example.com')
    process.exit(1)
  }
  const tenant = process.env.TENANT ?? 'marine'

  console.log(`Accuracy evaluation against ${base} (tenant: ${tenant})`)
  console.log(
    `${QUESTIONS.length} questions (${QUESTIONS.filter((q) => !q.outOfCorpus).length} ` +
      `in-corpus, ${QUESTIONS.filter((q) => q.outOfCorpus).length} out-of-corpus), spaced ` +
      `${ASK_SPACING_MS}ms apart\n`,
  )

  const results: QuestionResult[] = []
  for (const [index, q] of QUESTIONS.entries()) {
    if (index > 0) await sleep(ASK_SPACING_MS)
    const result = await runQuestion(base, tenant, q)
    results.push(result)
    const verdict = !result.ok
      ? `FAIL (${result.detail})`
      : q.outOfCorpus
      ? (result.refused ? 'refused correctly' : 'DID NOT REFUSE')
      : (result.refused ? 'refused' : `answered (${result.sourcesCount} sources)`)
    console.log(`[${index + 1}/${QUESTIONS.length}] ${q.query.slice(0, 70)} -> ${verdict}`)
  }

  printScorecard(results)
  const summary = summarize(results)
  printSummary(base, tenant, summary)
}

if (import.meta.main) {
  await main()
}
