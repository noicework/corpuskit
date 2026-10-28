import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'
import { COMPOSE_MAX_PASSAGES, COMPOSE_PROMPT_CHARS } from '../../compose.ts'

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
      expect(url).toMatch(/\/ask$/)
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return Promise.resolve(
        new Response(
          `${
            JSON.stringify({
              item: { type: 'answer', text: (object as { answer?: unknown })?.answer },
            })
          }\n`,
          {
            headers: { 'content-type': 'application/x-ndjson' },
          },
        ),
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
  it('retrieves composition passages without catalogue or display-summary reads', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const provider = new AragProvider({
      resolveBinding: () => ({
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
        token: 't',
      }),
      fetchImpl: (input, init) => {
        calls.push(String(input))
        expect(String(input)).toMatch(/\/find$/)
        expect(init?.signal).toBe(controller.signal)
        return Promise.resolve(Response.json({
          resources: {
            soil: {
              title: 'Soil moisture',
              metadata: { status: 'PROCESSED' },
              fields: {
                'f/body': {
                  paragraphs: { p: { text: 'Cover crops retained soil moisture.', score: 0.95 } },
                },
              },
            },
          },
        }))
      },
    })
    const result = await provider.search(TENANT, 'soil moisture', {
      passagesOnly: true,
      signal: controller.signal,
    })
    expect(result.resources[0]?.matchedPassage).toBe('Cover crops retained soil moisture.')
    expect(calls).toHaveLength(1)
    controller.abort()
    await expect(
      provider.search(TENANT, 'soil moisture', { passagesOnly: true, signal: controller.signal }),
    ).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('yields NDJSON answer fragments before the upstream body finishes and cancels on return', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const signal = new AbortController().signal
    const provider = new AragProvider({
      resolveBinding: () => ({
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
        token: 't',
      }),
      fetchImpl: (_input, init) => {
        expect(init?.signal).toBe(signal)
        expect(JSON.parse(String(init?.body)).answer_json_schema).toBeUndefined()
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(stream) {
                controller = stream
              },
              cancel() {
                cancelled = true
              },
            }),
          ),
        )
      },
    })
    const stream = provider.composeStream(TENANT, 'What changed?', PASSAGES, { signal })
      [Symbol.asyncIterator]()
    const first = stream.next()
    await Promise.resolve()
    const line = JSON.stringify({ item: { type: 'answer', text: 'Oysters died ' } }) + '\n'
    controller!.enqueue(new TextEncoder().encode(line.slice(0, 20)))
    controller!.enqueue(new TextEncoder().encode(line.slice(20)))
    expect(await first).toEqual({ done: false, value: 'Oysters died ' })
    const next = stream.next()
    controller!.enqueue(new TextEncoder().encode(
      JSON.stringify({ item: { type: 'answer', text: 'after heat. [1]' } }) + '\n',
    ))
    expect(await next).toEqual({ done: false, value: 'after heat. [1]' })
    await stream.return?.()
    expect(cancelled).toBe(true)
  })

  it('bounds all prompt material, including titles, collection labels and earlier turns', async () => {
    const { provider, bodies } = providerAnswering({ answer: 'A cited answer. [1]' })
    const long = 'x'.repeat(100_000)
    const passages = Array.from({ length: COMPOSE_MAX_PASSAGES }, () => ({
      source: long,
      title: long,
      text: long,
    }))
    await provider.compose(TENANT, long, passages, {
      context: Array.from({ length: 24 }, () => ({ author: 'USER', text: long })),
    })
    const body = bodies[0]!
    expect(String(body.query).length + (body.prompt as { system: string }).system.length)
      .toBeLessThanOrEqual(COMPOSE_PROMPT_CHARS)
    await expect(provider.compose(TENANT, 'q', [...passages, passages[0]!])).rejects.toThrow(
      'Too many composition passages',
    )
    expect(bodies).toHaveLength(1)
  })

  it("writes once on the host's plain streaming path from the numbered passages", async () => {
    const { provider, bodies } = providerAnswering({ answer: ' Oysters died after heat. [1] ' })
    const answer = await provider.compose(TENANT, 'What changed?', PASSAGES, {
      context: [{ author: 'USER', text: 'An earlier question' }],
      answerInstructions: 'Explain specialist terms.',
    })
    expect(answer).toBe('Oysters died after heat. [1]')
    expect(bodies.length).toBe(1)
    const body = bodies[0]!
    expect(body.answer_json_schema).toBeUndefined()
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
    const system = (body.prompt as { system: string }).system
    expect(system.indexOf('Explain specialist terms.')).toBeGreaterThan(
      system.indexOf('STRICTLY from the numbered passages'),
    )
    // The passages are the grounding: the box's own retrieval is held to one paragraph, and the
    // passages also ride extra_context so an empty retrieval cannot short-circuit generation.
    expect(body.top_k).toBe(1)
    expect(body.extra_context).toEqual([
      '[1] Fisheries collection | Oyster mortality\nOysters died after heat.',
      '[2] Grains collection | Rust timing\nRust arrived earlier.',
    ])
    expect(body.generative_model).toBe('host-model')
  })

  it('never attempts structured generation or a catalogue walk', async () => {
    const bodies: Record<string, unknown>[] = []
    const provider = new AragProvider({
      resolveBinding: () => ({
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
        token: 'test-token',
        inferenceModel: 'host-model',
      }),
      fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        expect(url).toMatch(/\/ask$/)
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
    expect(bodies).toHaveLength(1)
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
