import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { AragProvider, isGuardrailRefusal, MIN_REFUSAL_OVERRIDE_RELEVANCE } from './index.ts'

/**
 * Punch-list defect #4: refusal calibration was inconsistent at the corpus
 * boundary - a question phrased one way refused despite an 0.86-relevance
 * source being retrieved, while a near-identical rephrasing answered. Root
 * cause: Nuclia's default guardrail sentence ("Not enough data to answer
 * this.") can fire even when the system prompt forbids it and a genuinely
 * relevant source was retrieved (see docs/ARAG-DEV.md). `ask()` now retries
 * once with a firmer directive when that happens AND a retrieved source
 * clears MIN_REFUSAL_OVERRIDE_RELEVANCE; a true out-of-corpus question (no
 * source that relevant) still refuses, and only ever gets one /ask call.
 */

const TENANT: TenantConfig = {
  slug: 'marine',
  branding: {
    productName: 'Southern Waters Research Portal',
    organisation: 'Southern Waters Research Institute',
    tagline: 'Fisheries research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

/** One /ask stream: a retrieval event carrying the given resources, then an answer. */
function askStream(
  resources: Record<string, unknown>,
  answerText: string,
): unknown[] {
  return [
    { item: { type: 'retrieval', results: { resources } } },
    { item: { type: 'answer', text: answerText } },
  ]
}

/** A retrieval hit with a single paragraph at the given semantic score. */
function hit(id: string, title: string, score: number, text = 'Retrieved passage text.') {
  return { [id]: { title, fields: { a: { paragraphs: { p1: { score, text } } } } } }
}

const REFUSAL_TEXT = 'Not enough data to answer this.'

/** Queues successive NDJSON responses for successive /ask calls; /catalog and
 * /predict/remi are answered generically since they're not under test here. */
function providerQueuingAskResponses(
  askResponses: unknown[][],
): { provider: AragProvider; askCalls: () => number } {
  let askCallCount = 0
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/ask')) {
        const lines = askResponses[askCallCount] ?? askResponses[askResponses.length - 1] ?? []
        askCallCount += 1
        return Promise.resolve(ndjsonResponse(lines))
      }
      if (url.includes('/catalog')) return Promise.resolve(jsonResponse({ resources: {} }))
      if (url.includes('/predict/remi')) return Promise.resolve(jsonResponse({}))
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
  return { provider, askCalls: () => askCallCount }
}

async function collect(events: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('ask() refusal calibration (defect #4)', () => {
  it('does not accept a refusal when a source above the override floor was retrieved - retries and answers', async () => {
    const { provider, askCalls } = providerQueuingAskResponses([
      // Attempt 1: guardrail-only refusal despite a strong 0.86-relevance source.
      askStream(hit('res-abalone', 'Abalone Stock Report', 0.86), REFUSAL_TEXT),
      // Attempt 2 (after the firmer-directive retry): the model actually answers.
      askStream(
        hit('res-abalone', 'Abalone Stock Report', 0.86),
        'Abalone stocks in the southern zone are stable.',
      ),
    ])
    const events = await collect(
      provider.ask(TENANT, 'What does the research say about abalone stock in the southern zone?'),
    )
    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; refused: boolean }
      | undefined
    expect(done?.refused).toBe(false)
    expect(askCalls()).toBe(2)
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)
    expect(deltas.join('')).toContain('Abalone stocks in the southern zone are stable.')
  })

  it('still refuses a true out-of-corpus question - nothing relevant retrieved at all', async () => {
    const { provider } = providerQueuingAskResponses([
      // Nothing relevant retrieved at all - no resources. (A separate,
      // pre-existing retry sheds a broken stored search config on exactly
      // this zero-source shape before accepting the refusal - unrelated to
      // this defect, so this test only asserts the outcome, not call count.)
      askStream({}, REFUSAL_TEXT),
    ])
    const events = await collect(provider.ask(TENANT, 'What are orange roughy quotas in Iceland?'))
    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; refused: boolean }
      | undefined
    expect(done?.refused).toBe(true)
  })

  it('still refuses when only a weak, below-floor source was retrieved (never weakens a true refusal) - exactly one call', async () => {
    const { provider, askCalls } = providerQueuingAskResponses([
      askStream(
        hit(
          'res-weak',
          'Unrelated Page',
          MIN_REFUSAL_OVERRIDE_RELEVANCE - 0.15,
          'barely related text',
        ),
        REFUSAL_TEXT,
      ),
    ])
    const events = await collect(provider.ask(TENANT, 'What are orange roughy quotas in Iceland?'))
    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; refused: boolean }
      | undefined
    expect(done?.refused).toBe(true)
    expect(askCalls()).toBe(1)
  })

  it('never retries more than once even if the model refuses again after the firmer directive', async () => {
    const { provider, askCalls } = providerQueuingAskResponses([
      askStream(hit('res-abalone', 'Abalone Stock Report', 0.86), REFUSAL_TEXT),
      askStream(hit('res-abalone', 'Abalone Stock Report', 0.86), REFUSAL_TEXT),
    ])
    const events = await collect(provider.ask(TENANT, 'abalone stock question'))
    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; refused: boolean }
      | undefined
    expect(done?.refused).toBe(true)
    expect(askCalls()).toBe(2)
  })
})

/**
 * Punch-list BUG 2/3: a real /ask call was observed returning
 * `done.refused === false` while `done.text` carried the platform's bare
 * guardrail sentence verbatim, with a fistful of irrelevant retrieved
 * sources still attached - the guardrail detection that decides `refused`
 * had diverged from what the client was ultimately shown. `ask()` now drives
 * every refusal decision (the retry gates AND the final refused/done.text
 * outcome) off one function, `isGuardrailRefusal`, checked against the
 * COMPLETE answer text - not the incremental streaming heuristic that only
 * exists to avoid flashing the bare sentence mid-stream.
 */
describe('ask() refusal correctness (BUG 2/3)', () => {
  it('a guardrail refusal with only weak, below-floor sources sets refused:true, clears the sources, and puts the honest message in done.text', async () => {
    // Fifteen irrelevant, below-floor sources - none clears
    // MIN_REFUSAL_OVERRIDE_RELEVANCE, so this is a true out-of-corpus
    // question and must refuse outright, on the first call.
    const weakSources = Object.fromEntries(
      Array.from(
        { length: 15 },
        (_, i) => hit(`res-${i}`, `Unrelated Resource ${i}`, 0.05)[`res-${i}`]!,
      ).map((raw, i) => [`res-${i}`, raw]),
    )
    const { provider, askCalls } = providerQueuingAskResponses([
      askStream(weakSources, REFUSAL_TEXT),
    ])
    const events = await collect(provider.ask(TENANT, 'What are orange roughy quotas in Iceland?'))
    expect(askCalls()).toBe(1)

    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; refused: boolean; text?: string }
      | undefined
    expect(done?.refused).toBe(true)
    // BUG 3: done.text must carry the honest refusal message, not be absent,
    // and must never be the bare platform guardrail sentence.
    expect(done?.text).toBeTruthy()
    expect(done?.text?.toLowerCase()).not.toContain('not enough data to answer this')
    expect(done?.text).toContain('does not hold enough relevant material')

    // BUG 2: no citations for a refusal, and the initial (irrelevant)
    // sources are superseded by an empty correction before `done`.
    expect(events.some((e) => e.type === 'citation')).toBe(false)
    const sourceEvents = events.filter((e) => e.type === 'sources') as {
      type: 'sources'
      resources: unknown[]
    }[]
    expect(sourceEvents.length).toBeGreaterThanOrEqual(2)
    expect(sourceEvents[0]?.resources.length).toBe(15)
    expect(sourceEvents.at(-1)?.resources.length).toBe(0)
  })

  it('never shows a source for a true out-of-corpus refusal when nothing was retrieved to begin with', async () => {
    // Reused for every retry attempt (see providerQueuingAskResponses) - a
    // pre-existing, unrelated retry also sheds the stored search config on
    // this exact zero-source shape, so this only asserts every `sources`
    // event this run emits is empty, not how many attempts it took.
    const { provider } = providerQueuingAskResponses([askStream({}, REFUSAL_TEXT)])
    const events = await collect(provider.ask(TENANT, 'What are orange roughy quotas in Iceland?'))
    const sourceEvents = events.filter((e) => e.type === 'sources') as {
      type: 'sources'
      resources: unknown[]
    }[]
    expect(sourceEvents.length).toBeGreaterThan(0)
    for (const event of sourceEvents) expect(event.resources.length).toBe(0)
  })

  it('a genuine answer keeps its done.text and its sources - refusal handling never fires', async () => {
    const { provider } = providerQueuingAskResponses([
      askStream(
        hit('res-abalone', 'Abalone Stock Report', 0.8),
        'Abalone stocks in the southern zone are stable [1].',
      ),
    ])
    const events = await collect(
      provider.ask(TENANT, 'What does the research say about abalone stock?'),
    )
    const done = events.find((e) => e.type === 'done') as
      | { type: 'done'; refused: boolean; text?: string }
      | undefined
    expect(done?.refused).toBe(false)
    expect(done?.text).toContain('Abalone stocks in the southern zone are stable')
    const sourceEvents = events.filter((e) => e.type === 'sources') as {
      type: 'sources'
      resources: unknown[]
    }[]
    expect(sourceEvents.length).toBe(1)
    expect(sourceEvents[0]?.resources.length).toBe(1)
  })
})

describe('isGuardrailRefusal', () => {
  it('matches the exact guardrail sentence, case-insensitively', () => {
    expect(isGuardrailRefusal('Not enough data to answer this.')).toBe(true)
    expect(isGuardrailRefusal('NOT ENOUGH DATA TO ANSWER THIS.')).toBe(true)
  })

  it('tolerates a missing trailing period', () => {
    expect(isGuardrailRefusal('Not enough data to answer this')).toBe(true)
  })

  it('tolerates surrounding whitespace, newlines and wrapping quote marks', () => {
    expect(isGuardrailRefusal('  \n Not enough data to answer this.  \n')).toBe(true)
    expect(isGuardrailRefusal('"Not enough data to answer this."')).toBe(true)
    expect(isGuardrailRefusal("'Not enough data to answer this.'")).toBe(true)
  })

  it('tolerates non-breaking spaces and collapsed internal whitespace noise', () => {
    expect(isGuardrailRefusal('Not enough data  to   answer this.')).toBe(true)
  })

  it('does not flag a real answer that merely starts with similar wording', () => {
    expect(
      isGuardrailRefusal(
        'Not enough data to answer this precisely, but available studies indicate stable stocks.',
      ),
    ).toBe(false)
  })

  it('does not flag an empty or unrelated string', () => {
    expect(isGuardrailRefusal('')).toBe(false)
    expect(isGuardrailRefusal('   ')).toBe(false)
    expect(isGuardrailRefusal('Abalone stocks are stable.')).toBe(false)
  })
})
