import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

const TENANT: TenantConfig = {
  accessMode: 'public',
  slug: 'host',
  branding: {
    productName: 'Host Portal',
    organisation: 'Host Org',
    tagline: 'Testing',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

/** A provider whose /ask answers with `object`, recording each /ask body it was sent. */
function providerAnswering(object: unknown) {
  const bodies: Record<string, unknown>[] = []
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
      inferenceModel: 'host-model',
    }),
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/catalog')) return Promise.resolve(Response.json({ resources: {} }))
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return Promise.resolve(
        new Response(`${JSON.stringify({ item: { type: 'answer_json', object } })}\n`, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      )
    },
  })
  return { provider, bodies }
}

const PASSAGES = [
  { source: 'Fisheries collection', title: 'Oyster mortality', text: 'Oysters died after heat.' },
  { source: 'Grains collection', title: 'Rust timing', text: 'Rust arrived earlier.' },
]

describe('AragProvider.compose', () => {
  it("writes on the host's structured generation path from the numbered passages", async () => {
    const { provider, bodies } = providerAnswering({ answer: ' Oysters died after heat. [1] ' })
    const answer = await provider.compose(TENANT, 'What changed?', PASSAGES, {
      context: [{ author: 'USER', text: 'An earlier question' }],
    })
    expect(answer).toBe('Oysters died after heat. [1]')
    expect(bodies.length).toBe(1)
    const body = bodies[0]!
    expect((body.answer_json_schema as { name: string }).name).toBe('composed_answer')
    expect(body.query).toBe([
      'Question: What changed?',
      '',
      'Earlier question: An earlier question',
      '',
      '[1] Fisheries collection | Oyster mortality\nOysters died after heat.',
      '[2] Grains collection | Rust timing\nRust arrived earlier.',
    ].join('\n'))
    expect((body.prompt as { system: string }).system).toMatch(
      /STRICTLY from the numbered passages/,
    )
    expect((body.prompt as { system: string }).system).toMatch(/Australian English/)
    // The passages are the grounding: the box's own retrieval is held to one paragraph.
    expect(body.top_k).toBe(1)
    expect(body.generative_model).toBe('host-model')
  })

  it('composes as a plain answer when the model refuses structured output', async () => {
    const bodies: Record<string, unknown>[] = []
    const provider = new AragProvider({
      resolveBinding: () => ({
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
        token: 'test-token',
        inferenceModel: 'host-model',
      }),
      fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/catalog')) return Promise.resolve(Response.json({ resources: {} }))
        const body = JSON.parse(String(init?.body ?? '{}'))
        bodies.push(body)
        if (body.answer_json_schema) {
          return Promise.resolve(
            Response.json({ detail: 'Unknown LLM exception' }, { status: 412 }),
          )
        }
        const lines = [
          { item: { type: 'answer', text: 'Oysters died after heat. [1] ' } },
          { item: { type: 'answer', text: 'Rust arrived earlier. [2]' } },
        ].map((line) => JSON.stringify(line)).join('\n')
        return Promise.resolve(
          new Response(`${lines}\n`, { headers: { 'content-type': 'application/x-ndjson' } }),
        )
      },
    })
    const answer = await provider.compose(TENANT, 'What changed?', PASSAGES)
    expect(answer).toBe('Oysters died after heat. [1] Rust arrived earlier. [2]')
    const plain = bodies.at(-1)!
    expect(plain.answer_json_schema).toBeUndefined()
    expect(plain.query).toBe(bodies[0]!.query)
    expect(plain.top_k).toBe(1)
    const system = (plain.prompt as { system: string }).system
    expect(system).toMatch(/^Answer the question STRICTLY from the numbered passages/)
    expect(system).toMatch(/Australian English/)
  })

  it('fails rather than return an empty answer', async () => {
    for (const object of [{ answer: '   ' }, { other: 'x' }]) {
      const { provider } = providerAnswering(object)
      await expect(provider.compose(TENANT, 'What changed?', PASSAGES)).rejects.toThrow(
        'no composed answer',
      )
    }
  })
})
