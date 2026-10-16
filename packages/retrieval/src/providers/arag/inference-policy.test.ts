import { expect } from '@std/expect'
import { KbClient } from './client.ts'
import { AragProvider } from './index.ts'
import type { TenantConfig } from '@research-portal/core'

const binding = {
  baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/example',
  token: 'local-test-token',
  inferenceModel: 'openai-compatible',
}

Deno.test('binding model policy overrides ask callers, DA agents and extraction without affecting other bindings', async () => {
  const bodies: Record<string, unknown>[] = []
  const transport = ((_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const restricted = new KbClient(binding, transport)
  await restricted.postStream('/ask', { query: 'question', generative_model: 'expensive-model' })
  await restricted.postJson('/ask', { query: 'retry' })
  await restricted.dpJson('POST', '/task/start', {
    name: 'labeler',
    parameters: { name: 'labels', llm: { model: 'expensive-model' } },
  })
  await restricted.postJson('/extract_strategies', {
    name: 'tables',
    ai_tables: { llm: { generative_model: 'other' } },
  })
  expect(bodies[0]?.generative_model).toBe('openai-compatible')
  expect(bodies[1]?.generative_model).toBe('openai-compatible')
  expect(bodies[2]?.parameters).toEqual({ name: 'labels', llm: { model: 'openai-compatible' } })
  expect(bodies[3]?.ai_tables).toEqual({ llm: { generative_model: 'openai-compatible' } })
  const normal = new KbClient({ ...binding, inferenceModel: undefined }, transport)
  await normal.postStream('/ask', { query: 'paid tenant', generative_model: 'paid-model' })
  expect(bodies[4]?.generative_model).toBe('paid-model')
})

Deno.test('restricted prediction endpoints fail before sending a request and metadata remains per tenant', async () => {
  let calls = 0
  const transport = (() => {
    calls++
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const restricted = new KbClient(binding, transport)
  for (const path of ['/summarize', '/predict/remi', '/predict/rephrase']) {
    await expect(restricted.postJson(path, {})).rejects.toThrow('inference_policy_unsupported')
  }
  const provider = new AragProvider({
    resolveBinding: (slug) => slug === 'trial' ? binding : undefined,
    augmentationModel: 'normal-augmentation',
    fetchImpl: transport,
  })
  const trial = { slug: 'trial' } as TenantConfig
  expect(await provider.augmentationModel(trial)).toBe('openai-compatible')
  expect(await provider.generativeModel(trial)).toBe('openai-compatible')
  expect(await provider.rephrase(trial, 'question')).toBeNull()
  expect(await provider.remi(trial, { question: '', answer: '', contexts: [] })).toEqual({
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
  })
  expect(await provider.augmentationModel({ slug: 'paid' } as TenantConfig)).toBe(
    'normal-augmentation',
  )
  expect(calls).toBe(0)
})

Deno.test('strategy update and nested split model overrides cannot bypass binding policy', async () => {
  let sent: unknown
  const client = new KbClient(
    binding,
    ((_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return Promise.resolve(Response.json({}))
    }) as typeof fetch,
  )
  await client.patchJson('/extract_strategies/strategy/existing', {
    llm_split: { llm: { generative_model: 'expensive', user_keys: { key: 'uncapped' } } },
  })
  expect(sent).toEqual({ llm_split: { llm: { generative_model: 'openai-compatible' } } })
  await client.postJson('/split_strategies', {
    llm_split: { llm: { generative_model: 'expensive' } },
  })
  expect(sent).toEqual({ llm_split: { llm: { generative_model: 'openai-compatible' } } })
})
