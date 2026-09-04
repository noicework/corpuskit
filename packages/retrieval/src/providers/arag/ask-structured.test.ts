import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider, MIN_GENERATE_GROUNDING } from './index.ts'

/**
 * askStructured's grounding gate is the fix for the credibility defect a
 * simulated grains scientist found: on a thin or broken corpus, structured
 * generation (Generate's six artefact kinds) had no groundedness check at
 * all - unlike /ask, which detects the platform's textual refusal. These
 * tests exercise the gate directly against a mocked /ask NDJSON stream, the
 * same shape the live platform returns for `answer_json_schema` requests.
 */

const TENANT: TenantConfig = {
  slug: 'test-tenant',
  branding: {
    productName: 'Test Portal',
    organisation: 'Test Org',
    tagline: 'Testing',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

const SCHEMA = {
  name: 'test_artefact',
  description: 'A test artefact',
  parameters: { type: 'object', properties: {}, required: [] },
}

/** Builds an NDJSON Response body from a list of stream items, matching the
 * shape the platform's /ask endpoint emits for answer_json_schema calls. */
function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

/** A fetch double: /catalog calls return an empty catalogue (listResources is
 * best-effort and irrelevant to the grounding decision); /ask calls return
 * the supplied canned NDJSON stream, regardless of how many times it is
 * called (each test issues at most one). */
function fetchStub(askLines: unknown[]): typeof fetch {
  return (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/catalog')) {
      return Promise.resolve(
        new Response(JSON.stringify({ resources: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    if (url.endsWith('/ask')) {
      return Promise.resolve(ndjsonResponse(askLines))
    }
    throw new Error(`unexpected fetch to ${url}`)
  }
}

function providerWith(askLines: unknown[]): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: fetchStub(askLines),
  })
}

/** A retrieval hit with a single paragraph at the given semantic score. */
function hit(id: string, title: string, score: number, text = 'Some retrieved passage text.') {
  return {
    [id]: {
      title,
      fields: { a: { paragraphs: { p1: { score, text } } } },
    },
  }
}

describe('askStructured grounding gate (requireGrounding)', () => {
  it('sufficient grounding: returns the generated artefact, sources above the floor', async () => {
    const provider = providerWith([
      {
        item: {
          type: 'retrieval',
          results: { resources: hit('res-1', 'Grain Storage Aeration Guide', 0.82) },
        },
      },
      { item: { type: 'answer_json', object: { title: 'A real artefact' } } },
    ])
    const result = await provider.askStructured(TENANT, SCHEMA, 'aeration of stored grain', {
      requireGrounding: true,
    })
    expect(result.insufficientGrounding).toBe(false)
    expect(result.object).toEqual({ title: 'A real artefact' })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.id).toBe('res-1')
    expect(result.sources[0]?.relevance).toBeGreaterThanOrEqual(MIN_GENERATE_GROUNDING)
  })

  it('zero grounding: refuses rather than returning the fabricated object', async () => {
    const provider = providerWith([
      { item: { type: 'retrieval', results: { resources: {} } } },
      // Even though the model still produced fluent JSON (as it does on a
      // thin/broken corpus, drawing on background knowledge), it must never
      // reach the caller once grounding is insufficient.
      { item: { type: 'answer_json', object: { title: 'A fabricated artefact' } } },
    ])
    const result = await provider.askStructured(TENANT, SCHEMA, 'an off-corpus topic', {
      requireGrounding: true,
    })
    expect(result.insufficientGrounding).toBe(true)
    expect(result.object).toBeNull()
    expect(result.sources).toEqual([])
  })

  it('weak grounding (below the relevance floor): refuses - the Cloudflare-bot-check case', async () => {
    // A resource that ingested "cleanly" (it is a real retrieved hit) but is
    // actually junk - a bot-check page, say - scores far below the floor.
    // The model still answers fluently from background knowledge; the gate
    // must catch this exactly like the zero-sources case.
    const provider = providerWith([
      {
        item: {
          type: 'retrieval',
          results: { resources: hit('res-junk', 'Untitled', 0.02, 'Checking your browser...') },
        },
      },
      { item: { type: 'answer_json', object: { title: 'A fabricated artefact' } } },
    ])
    const result = await provider.askStructured(TENANT, SCHEMA, 'a topic the junk page mentions', {
      requireGrounding: true,
    })
    expect(result.insufficientGrounding).toBe(true)
    expect(result.object).toBeNull()
    expect(result.sources).toEqual([])
  })

  it('weak-but-present grounding: sources are filtered to only those at/above the floor', async () => {
    const provider = providerWith([
      {
        item: {
          type: 'retrieval',
          results: {
            resources: {
              ...hit('res-strong', 'A Relevant Report', 0.6),
              ...hit('res-weak', 'An Unrelated Page', 0.03),
            },
          },
        },
      },
      { item: { type: 'answer_json', object: { title: 'Grounded artefact' } } },
    ])
    const result = await provider.askStructured(TENANT, SCHEMA, 'a mostly-covered topic', {
      requireGrounding: true,
    })
    expect(result.insufficientGrounding).toBe(false)
    expect(result.sources.map((s) => s.id)).toEqual(['res-strong'])
  })

  it('requireGrounding omitted (default): does not gate - existing callers (subqueries, verdicts, synthesis) are unaffected', async () => {
    const provider = providerWith([
      { item: { type: 'retrieval', results: { resources: {} } } },
      { item: { type: 'answer_json', object: { questions: ['A sub-question?'] } } },
    ])
    const result = await provider.askStructured(TENANT, SCHEMA, 'anything')
    expect(result.insufficientGrounding).toBe(false)
    expect(result.object).toEqual({ questions: ['A sub-question?'] })
  })
})
