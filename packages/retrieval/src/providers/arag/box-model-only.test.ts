import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type AskEvent, type TenantConfig, TenantConfigSchema } from '@research-portal/core'
import { BoxModelOnlyError, KbClient } from './client.ts'
import { AragProvider } from './index.ts'

/**
 * A portal with the `boxModelOnly` hosting limit generates only on its knowledge box's own
 * model. The client enforces it on every request it sends, so no feature, including one added
 * later, can name another model for such a portal.
 */

const BINDING = { baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb', token: 'token' }

const TENANT: TenantConfig = TenantConfigSchema.parse({
  accessMode: 'public',
  slug: 'locked',
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
  intents: [{
    id: 'general',
    label: 'General',
    description: 'Anything',
    examples: ['What is known?'],
    retrieval: { features: ['keyword', 'semantic'], topK: 20, reranker: 'predict' },
    answer: { surfaces: ['ask'], strategy: 'none', promptVariant: 'default' },
  }],
})

interface Sent {
  url: string
  method: string
  body: Record<string, unknown> | null
  headers: Record<string, string>
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

const ASK_LINES = [
  {
    item: {
      type: 'retrieval',
      results: {
        resources: {
          r1: {
            title: 'Report',
            fields: { a: { paragraphs: { p1: { score: 0.9, text: 'Text' } } } },
          },
        },
      },
    },
  },
  { item: { type: 'answer', text: 'The report says the stock is stable.' } },
  { item: { type: 'answer_json', object: { intent: 'general', confidence: 1, rationale: 'x' } } },
]

/** A fetch double that records every request and answers the platform's shapes. */
function recorder() {
  const sent: Sent[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const raw = typeof init?.body === 'string' ? init.body : null
    sent.push({
      url,
      method: init?.method ?? 'GET',
      body: raw ? JSON.parse(raw) as Record<string, unknown> : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    if (url.endsWith('/ask')) return Promise.resolve(ndjsonResponse(ASK_LINES))
    if (url.includes('/catalog')) return Promise.resolve(jsonResponse({ resources: {} }))
    if (url.includes('/predict/remi')) {
      return Promise.resolve(jsonResponse({ answer_relevance: { score: 4 } }))
    }
    return Promise.resolve(jsonResponse({}))
  }) as typeof fetch
  return { sent, fetchImpl }
}

const asks = (sent: Sent[]) => sent.filter((request) => request.url.endsWith('/ask'))

async function collect(events: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('KbClient under a box-model-only policy', () => {
  it('removes a model override from every JSON body it sends, read at the moment of sending', async () => {
    const { sent, fetchImpl } = recorder()
    let locked = true
    const client = new KbClient(BINDING, fetchImpl, { boxModelOnly: () => locked })
    await client.postStream('/ask', { query: 'q', generative_model: 'other-model' })
    await client.postJson('/summarize', { resources: ['r1'], generative_model: 'other-model' })
    await client.postJson('/predict/rephrase', { question: 'q', generative_model: 'other-model' })
    await client.patchJson('/search_configurations/portal-ask', { generative_model: 'other' })
    for (const request of sent) expect(request.body).not.toHaveProperty('generative_model')
    expect(sent[0]!.body).toEqual({ query: 'q' })
    // The policy is read per request: once lifted, the caller's body goes out as given.
    locked = false
    await client.postStream('/ask', { query: 'q', generative_model: 'other-model' })
    expect(sent.at(-1)!.body).toEqual({ query: 'q', generative_model: 'other-model' })
  })

  it('refuses, before anything is sent, every request that can only run on another model', async () => {
    const { sent, fetchImpl } = recorder()
    const client = new KbClient(BINDING, fetchImpl, { boxModelOnly: () => true })
    const refusals: Promise<unknown>[] = [
      client.postJson('/predict/remi', { question: 'q', answer: 'a', contexts: [] }),
      client.dpJson('POST', '/task/start', { name: 'labeler', parameters: {} }),
      client.postJson('/extract_strategies', { name: 'v', vllm_config: { rules: [] } }),
      client.postJson('/extract_strategies', { name: 't', ai_tables: { llm: {} } }),
      client.postRaw('/upload', new Uint8Array(1), 'application/pdf', 'a.pdf', {
        'x-extract-strategy': 'strategy-1',
      }),
    ]
    for (const refusal of refusals) {
      await expect(refusal).rejects.toBeInstanceOf(BoxModelOnlyError)
    }
    expect(sent).toEqual([])
    // What runs on the box's own model or on no model still goes through.
    await client.postJson('/extract_strategies', { name: 'plain' })
    await client.dpJson('DELETE', '/task/agent-1?cleanup=false')
    await client.postRaw('/upload', new Uint8Array(1), 'application/pdf', 'a.pdf')
    expect(sent.map((request) => request.method)).toEqual(['POST', 'DELETE', 'POST'])
  })

  it('changes nothing for a portal without the policy', async () => {
    const { sent, fetchImpl } = recorder()
    const client = new KbClient(BINDING, fetchImpl)
    await client.postStream('/ask', { query: 'q', generative_model: 'other-model' })
    await client.postJson('/predict/remi', { question: 'q', answer: 'a', contexts: [] })
    await client.dpJson('POST', '/task/start', { name: 'labeler', parameters: {} })
    expect(sent[0]!.body).toEqual({ query: 'q', generative_model: 'other-model' })
    expect(sent).toHaveLength(3)
  })
})

describe('AragProvider for a box-model-only portal', () => {
  function provider(locked: boolean) {
    const { sent, fetchImpl } = recorder()
    const checked: string[] = []
    const aragProvider = new AragProvider({
      resolveBinding: () => BINDING,
      fetchImpl,
      boxModelOnly: (slug) => {
        checked.push(slug)
        return locked
      },
    })
    return { provider: aragProvider, sent, checked }
  }

  it('sends no /ask body with a model of its own, whichever method builds it', async () => {
    const { provider: locked, sent, checked } = provider(true)
    await locked.classifyIntent(TENANT, 'What is known?', { model: 'fast-model' })
    await locked.askStructured(TENANT, { name: 's', description: 'd', parameters: {} }, 'q', {
      model: 'fast-model',
    })
    await collect(locked.ask(TENANT, 'What does the report say?'))
    expect(asks(sent).length).toBeGreaterThanOrEqual(3)
    for (const request of asks(sent)) expect(request.body).not.toHaveProperty('generative_model')
    expect(new Set(checked)).toEqual(new Set(['locked']))
  })

  it('names the requested model for a portal without the limit', async () => {
    const { provider: open, sent } = provider(false)
    await open.classifyIntent(TENANT, 'What is known?', { model: 'fast-model' })
    await open.askStructured(TENANT, { name: 's', description: 'd', parameters: {} }, 'q', {
      model: 'fast-model',
    })
    expect(asks(sent).map((request) => request.body?.generative_model)).toEqual([
      'fast-model',
      'fast-model',
    ])
  })

  it('answers without a quality score, since scoring runs on a model of its own', async () => {
    const { provider: locked, sent } = provider(true)
    const events = await collect(locked.ask(TENANT, 'What does the report say?'))
    expect(events.some((event) => event.type === 'done')).toBe(true)
    expect(events.some((event) => event.type === 'quality')).toBe(false)
    expect(sent.some((request) => request.url.includes('/predict/remi'))).toBe(false)

    const { provider: open, sent: openSent } = provider(false)
    await collect(open.ask(TENANT, 'What does the report say?'))
    expect(openSent.some((request) => request.url.includes('/predict/remi'))).toBe(true)
  })

  it('refuses to start an agent rather than run it on a task model', async () => {
    const { provider: locked, sent } = provider(true)
    await expect(
      locked.startAgent(TENANT, {
        task: 'labeler',
        title: 'Topics',
        operations: [],
        applyExisting: false,
        model: 'task-model',
      }),
    ).rejects.toBeInstanceOf(BoxModelOnlyError)
    expect(sent.some((request) => request.url.includes('/task/start'))).toBe(false)
  })
})
