import { expect } from '@std/expect'
import {
  type PortalLimits,
  PortalLimitsSchema,
  type TenantConfig,
  TenantConfigSchema,
} from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import { generateFollowUpQuestions } from './follow-up-questions.ts'
import { lifecycleMessage, PortalLifecycleError } from './lifecycle-error.ts'
import { guardManagement } from './lifecycle-management.ts'
import { admitAsks, boxModelOnly } from './lifecycle-policy.ts'
import { PortalLifecycleStore } from './lifecycle-store.ts'
import { generateSuggestedQuestions } from './suggested-questions.ts'

/**
 * The `boxModelOnly` and `askLimitMessage` hosting limits (docs/HOSTING.md, H3). A box-model-only
 * portal generates only on its knowledge box's own model: the management guard takes the model
 * a feature names out of its request, and refuses work that can only run on another model.
 */

const config: TenantConfig = TenantConfigSchema.parse({
  slug: 'locked',
  branding: {
    productName: 'P',
    organisation: 'O',
    tagline: 'T',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 's',
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

function store(limits: PortalLimits | null, slug = config.slug) {
  const lifecycle = new PortalLifecycleStore()
  lifecycle.set(slug, { status: 'active', limits })
  return lifecycle
}

async function refused(work: Promise<unknown>, error: string) {
  try {
    await work
    throw new Error('Expected a refusal')
  } catch (failure) {
    expect(failure).toBeInstanceOf(PortalLifecycleError)
    expect((failure as PortalLifecycleError).status).toBe(403)
    expect((failure as PortalLifecycleError).body.error).toBe(error)
  }
}

const passage = 'The southern rock lobster stock assessment found recruitment stable across ' +
  'the eastern zone for the third straight year, with catch rates up eleven per cent and ' +
  'the biomass estimate above the target reference point set by the management plan.'

/** A real provider over a fetch double that records every /ask body and answers it. */
function recordingProvider() {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/ask')) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const lines = [
        { item: { type: 'retrieval', results: { resources: {} } } },
        { item: { type: 'answer_json', object: { questions: [], intent: 'general' } } },
      ]
      return Promise.resolve(
        new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      )
    }
    return Promise.resolve(Response.json({ resources: {} }))
  }) as typeof fetch
  // No transport policy here: these tests prove the guard alone keeps the model out.
  const provider = new AragProvider({
    resolveBinding: () => ({ baseUrl: 'https://t.rag.progress.cloud/api/v1/kb/k', token: 't' }),
    fetchImpl,
  })
  Object.assign(provider, {
    resourceContent: () =>
      Promise.resolve({ texts: [{ text: passage.repeat(4) }], pageSummary: null }),
  })
  return { provider, bodies }
}

Deno.test('the two limits parse strictly: a flag, and a short plain-text message trimmed', () => {
  expect(
    PortalLimitsSchema.parse({
      boxModelOnly: true,
      askLimitMessage: '  This trial has used its questions. Talk to us about keeping it.  ',
    }),
  ).toEqual({
    boxModelOnly: true,
    askLimitMessage: 'This trial has used its questions. Talk to us about keeping it.',
  })
  expect(PortalLimitsSchema.parse({ askLimitMessage: 'x'.repeat(300) }).askLimitMessage)
    .toHaveLength(300)
  for (
    const limits of [
      { boxModelOnly: 'true' },
      { boxModelOnly: 1 },
      { askLimitMessage: '' },
      { askLimitMessage: '   ' },
      { askLimitMessage: 'x'.repeat(301) },
      { askLimitMessage: '<a href="https://example.test">Upgrade</a>' },
      { askLimitMessage: 'Ask‮us' },
      { askLimitMessage: 'line\nbreak' },
      { askLimitMessage: 'token=private-fixture-value' },
      { askLimitMessage: 42 },
    ]
  ) expect(PortalLimitsSchema.safeParse(limits).success, JSON.stringify(limits)).toBe(false)
})

Deno.test('a portal is box-model-only by an explicit true, and its Extraction Lab follows it', () => {
  expect(boxModelOnly(store({ boxModelOnly: true }), 'locked')).toBe(true)
  expect(boxModelOnly(store({ boxModelOnly: false }), 'locked')).toBe(false)
  expect(boxModelOnly(store({}), 'locked')).toBe(false)
  expect(boxModelOnly(store(null), 'locked')).toBe(false)
  expect(boxModelOnly(store({ boxModelOnly: true }), 'locked-lab')).toBe(true)
  expect(boxModelOnly(store({ boxModelOnly: true }), 'other-lab')).toBe(false)
})

Deno.test('follow-ups, suggested questions and intent routing ask on the box model when the portal is box-model-only', async () => {
  for (const locked of [true, false]) {
    const { provider, bodies } = recordingProvider()
    const management = guardManagement(provider, store(locked ? { boxModelOnly: true } : null))
    await generateFollowUpQuestions(management, config, {
      question: 'How is the lobster stock?',
      answer: 'Recruitment is stable.',
      passages: [{ title: 'Assessment', text: passage }],
    })
    await generateSuggestedQuestions(management, config, 'res-1', 'Lobster assessment')
    const model = await management.augmentationModel(config)
    await management.classifyIntent(config, 'How is the lobster stock?', {
      model,
      allowed: ['general'],
    })
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      if (locked) expect(body).not.toHaveProperty('generative_model')
      else expect(typeof body.generative_model).toBe('string')
    }
  }
})

Deno.test('a box-model-only portal refuses agents, LLM extraction methods and uploads that name one', async () => {
  const calls: string[] = []
  const record = (name: string) => (..._args: unknown[]) => {
    calls.push(name)
    return Promise.resolve({ id: `${name}-result` })
  }
  const raw = {
    resourceCount: () => Promise.resolve(0),
    startAgent: record('startAgent'),
    registerExtractionMethod: record('registerExtractionMethod'),
    uploadFile: record('uploadFile'),
  } as unknown as AragProvider
  const file = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new Uint8Array(4) }
  const lab = { ...config, slug: 'locked-lab' }
  const guarded = guardManagement(raw, store({ boxModelOnly: true }))
  await refused(guarded.startAgent(config, {} as never), 'box_model_only')
  await refused(guarded.startAgent(lab, {} as never), 'box_model_only')
  for (const kind of ['visual', 'tables'] as const) {
    await refused(
      guarded.registerExtractionMethod(lab, { name: kind, kind } as never),
      'box_model_only',
    )
  }
  await refused(guarded.uploadFile(config, { ...file, method: 'strategy-1' }), 'box_model_only')
  expect(calls).toEqual([])
  // The platform's default extraction and an upload that names no method use no other model.
  await guarded.registerExtractionMethod(config, { name: 'plain', kind: 'default' } as never)
  await guarded.uploadFile(config, file)
  await guarded.uploadFile(config, { ...file, method: 'default' })
  expect(calls).toEqual(['registerExtractionMethod', 'uploadFile', 'uploadFile'])
  // Agents disabled is reported first when both limits apply.
  const both = guardManagement(raw, store({ boxModelOnly: true, agentsEnabled: false }))
  await refused(both.startAgent(config, {} as never), 'agents_disabled')
  // Without the limit, agents start as before.
  await guardManagement(raw, store({ boxModelOnly: false })).startAgent(config, {} as never)
  expect(calls.at(-1)).toBe('startAgent')
})

Deno.test('a question over the daily limit carries the portal message instead of the default words', () => {
  const at = Date.parse('2026-10-16T01:00:00Z')
  const message = 'This trial has used its questions. Talk to us about keeping it.'
  const custom = store({ asksPerDay: 0, askLimitMessage: message })
  try {
    admitAsks(custom, 'count', [config], at)
    throw new Error('Expected a refusal')
  } catch (failure) {
    expect(failure).toBeInstanceOf(PortalLifecycleError)
    const error = failure as PortalLifecycleError
    expect(error.status).toBe(429)
    expect(error.body).toMatchObject({ error: 'ask_quota_exceeded', limit: 0, message })
    expect(error.message).toBe(message)
  }
  // Without a message the refusal is unchanged.
  try {
    admitAsks(store({ asksPerDay: 0 }), 'count', [config], at)
  } catch (failure) {
    const body = (failure as PortalLifecycleError).body
    expect(body).not.toHaveProperty('message')
    expect(lifecycleMessage(body)).toBe('This portal has reached its daily question limit.')
  }
  expect(lifecycleMessage({ error: 'box_model_only' })).toContain("knowledge box's own model")
})
