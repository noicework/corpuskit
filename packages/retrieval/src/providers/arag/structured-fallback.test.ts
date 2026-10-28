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

const SCHEMA = {
  name: 'summary',
  description: 'A short summary',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

/** A provider whose structured /ask fails with `refusal`, and whose plain /ask answers `lines`. */
function providerRefusing(refusal: { status: number; detail: string } | null, lines: string[]) {
  const bodies: Record<string, unknown>[] = []
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 't',
    }),
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/catalog')) return Promise.resolve(Response.json({ resources: {} }))
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      if (body.answer_json_schema && refusal) {
        return Promise.resolve(
          Response.json({ detail: refusal.detail }, { status: refusal.status }),
        )
      }
      const out = body.answer_json_schema
        ? [{ item: { type: 'answer_json', object: { text: 'From the schema.' } } }]
        : lines.map((text) => ({ item: { type: 'answer', text } }))
      return Promise.resolve(
        new Response(`${out.map((line) => JSON.stringify(line)).join('\n')}\n`, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      )
    },
  })
  return { provider, bodies }
}

const REFUSAL = {
  status: 412,
  detail:
    'Unknown LLM exception: Unknown bad request error received from LLM: 400 Provider returned error',
}

describe('AragProvider.askStructured', () => {
  it('uses the structured answer when the model gives one', async () => {
    const { provider, bodies } = providerRefusing(null, [])
    const result = await provider.askStructured(TENANT, SCHEMA, 'Summarise.', {
      instructions: 'Be brief.',
    })
    expect(result.object).toEqual({ text: 'From the schema.' })
    expect(bodies.length).toBe(1)
  })

  it('asks for JSON text when the model refuses structured output', async () => {
    const { provider, bodies } = providerRefusing(REFUSAL, [
      '```json\n{"text": "From ',
      'the text."}\n```',
    ])
    const result = await provider.askStructured(TENANT, SCHEMA, 'Summarise.', {
      instructions: 'Be brief.',
    })
    expect(result.object).toEqual({ text: 'From the text.' })
    expect(bodies.length).toBe(2)
    const plain = bodies[1]!
    expect(plain.answer_json_schema).toBeUndefined()
    expect(plain.query).toBe('Summarise.')
    const system = (plain.prompt as { system: string }).system
    expect(system.startsWith('Be brief.')).toBe(true)
    expect(system).toMatch(/only one JSON object/)
    expect(system).toContain(JSON.stringify(SCHEMA.parameters))
  })

  it('fails as before when the text holds no JSON object', async () => {
    const { provider } = providerRefusing(REFUSAL, ['Sorry, I cannot.'])
    await expect(provider.askStructured(TENANT, SCHEMA, 'Summarise.')).rejects.toThrow(
      'no structured answer',
    )
  })

  it('does not retry other platform errors', async () => {
    const { provider, bodies } = providerRefusing({
      status: 412,
      detail: 'Error generating json: max_tokens',
    }, [])
    await expect(provider.askStructured(TENANT, SCHEMA, 'Summarise.')).rejects.toThrow('412')
    expect(bodies.length).toBe(1)
  })
  it('remembers only model refusals per portal, and forgets them after rebinding', async () => {
    const { provider, bodies } = providerRefusing(REFUSAL, ['{"text":"A summary."}'])
    await provider.askStructured(TENANT, SCHEMA, 'First')
    await provider.askStructured(TENANT, SCHEMA, 'Second')
    expect(bodies.map((body) => Boolean(body.answer_json_schema))).toEqual([true, false, false])
    await provider.askStructured({ ...TENANT, slug: 'other' }, SCHEMA, 'Other portal')
    expect(bodies.slice(-2).map((body) => Boolean(body.answer_json_schema))).toEqual([true, false])
    await provider.askStructured(TENANT, SCHEMA, 'Other model', { model: 'different' })
    expect(bodies.slice(-2).map((body) => Boolean(body.answer_json_schema))).toEqual([true, false])
    provider.invalidate(TENANT.slug)
    await provider.askStructured(TENANT, SCHEMA, 'Rebound')
    expect(bodies.slice(-2).map((body) => Boolean(body.answer_json_schema))).toEqual([true, false])
  })
})
