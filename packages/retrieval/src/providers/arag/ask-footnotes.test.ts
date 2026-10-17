import { expect } from '@std/expect'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { TenantConfigSchema } from '@research-portal/core'
import type { AskOptions } from '../../provider.ts'
import { AragProvider } from './index.ts'
import { CITATION_MODE, type CitationMode, FOOTNOTE_PROMPT } from './citation-mode.ts'

const tenant: TenantConfig = {
  accessMode: 'public',
  slug: 'test',
  branding: {
    productName: 'Portal',
    organisation: 'Research',
    tagline: 'Research',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}
function fixture(opts: {
  id?: string
  doc?: boolean
  mode?: CitationMode
  broken?: boolean
  retry?: boolean
  failures?: { status: number; detail: string }[]
  inferenceModel?: string
  answer?: string
} = {}) {
  const bodies: Record<string, unknown>[] = []
  const resource = {
    title: 'Original report',
    metadata: { status: 'PROCESSED' },
    ...(opts.doc ? { slug: 'doc-getting-started' } : {}),
    fields: {
      'f/pdf': {
        paragraphs: {
          'report/f/pdf/0-16': { score: 0.9, text: 'Stocks recovered.' },
        },
      },
    },
  }
  const provider = new AragProvider({
    ...(opts.mode ? { citationMode: opts.mode } : {}),
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
      token: 'test',
      ...(opts.inferenceModel ? { inferenceModel: opts.inferenceModel } : {}),
    }),
    fetchImpl: (input, init) => {
      const url = String(input)
      if (url.includes('/catalog')) {
        return Promise.resolve(Response.json({ resources: { report: resource } }))
      }
      if (url.includes('/predict/remi')) return Promise.resolve(Response.json({}))
      if (!url.endsWith('/ask')) throw new Error('Unexpected endpoint')
      bodies.push(JSON.parse(String(init?.body)))
      const failure = opts.failures?.[bodies.length - 1]
      if (failure) {
        return Promise.resolve(
          Response.json({ detail: failure.detail }, { status: failure.status }),
        )
      }
      if (opts.retry && bodies.length === 1) {
        return Promise.resolve(Response.json({ detail: 'Unsupported strategy' }, { status: 400 }))
      }
      if (bodies.at(-1)?.answer_json_schema) {
        return Promise.resolve(
          new Response(JSON.stringify({ item: { type: 'answer_json', object: {} } }) + '\n'),
        )
      }
      const raw = opts.mode === 'standard'
        ? 'Stocks recovered.'
        : opts.answer ?? '## Findings\n\nStocks recovered [7] .\n\n[7]: block-AA\n'
      const items: unknown[] = [
        { type: 'retrieval', results: { resources: { report: resource } } },
        ...Array.from(raw).map((text) => ({ type: 'answer', text })),
        opts.mode === 'standard'
          ? { type: 'citations', citations: { [opts.id ?? 'report/f/pdf/0-16']: [[0, 17]] } }
          : {
            type: 'footnote_citations',
            footnote_to_context: opts.broken ? {} : { 'block-AA': opts.id ?? 'report/f/pdf/0-16' },
          },
      ]
      return Promise.resolve(
        new Response(items.map((item) => JSON.stringify({ item })).join('\n') + '\n'),
      )
    },
  })
  return { provider, bodies }
}
async function collect(provider: AragProvider, opts: AskOptions = {}, config = tenant) {
  const events: AskEvent[] = []
  for await (const event of provider.ask(config, 'What happened?', opts)) events.push(event)
  return events
}

Deno.test('all prose surfaces use the code flag, with claim-level footnotes after punctuation', async () => {
  expect(CITATION_MODE).toBe('llm_footnotes')
  for (const options of [{}, { resourceId: 'report' }, { docScope: true }, { sandbox: true }]) {
    const f = fixture({ doc: 'docScope' in options })
    const events = await collect(f.provider, options)
    expect(f.bodies[0]?.citations).toBe('llm_footnotes')
    expect(events.find((e) => e.type === 'done')).toEqual({
      type: 'done',
      refused: false,
      text: '## Findings\n\nStocks recovered.[1]\n\n',
      citationPresentation: 'authored_blocks',
    })
    expect(events.filter((e) => e.type === 'citation')).toEqual([{
      type: 'citation',
      citation: { index: 1, resourceId: 'report', title: 'Original report' },
    }])
    const deltas = events.flatMap((e) => e.type === 'delta' ? [e.text] : []).join('')
    expect(deltas).toContain('Stocks recovered.')
    expect(deltas).not.toMatch(/block-AA|\[7\]/)
    expect(events.some((e) => e.type === 'error')).toBe(false)
  }
})

Deno.test('footnote instruction survives custom prompt and addendum', async () => {
  const f = fixture()
  await collect(f.provider, {
    systemPrompt: 'Custom instructions',
    promptAddendum: 'Extra instructions',
  })
  const prompt = f.bodies[0]?.prompt as { system: string }
  expect(prompt.system).toContain('Custom instructions')
  expect(prompt.system).toContain('Extra instructions')
  expect(prompt.system).toContain('supplied footnote protocol')
  expect(prompt.system).not.toContain('number itself does not matter')
})

Deno.test('bilingual answer policy survives custom prompts and help scope', async () => {
  const config = TenantConfigSchema.parse({
    ...tenant,
    languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
  })
  for (const docScope of [false, true]) {
    const f = fixture({ doc: docScope })
    await collect(f.provider, {
      docScope,
      systemPrompt: 'Custom research instructions',
      promptAddendum: 'Custom house style',
    }, config)
    const prompt = (f.bodies[0]?.prompt as { system: string }).system
    expect(prompt).toContain('Custom research instructions')
    expect(prompt).toContain('Answer in the language of the user question')
    expect(prompt).toContain('both Japanese and English')
    expect(prompt).toContain('treat their observations as fictional')
    expect(prompt.indexOf('Portal language policy')).toBeGreaterThan(
      prompt.indexOf('Custom house style'),
    )
  }
})

Deno.test('footnote grouping guidance is shared across prose surfaces and overrides', async () => {
  const config = TenantConfigSchema.parse({
    ...tenant,
    intents: [{
      id: 'review',
      label: 'Review',
      description: '',
      retrieval: { features: ['keyword', 'semantic'], topK: 20, reranker: 'predict' },
      answer: { surfaces: ['ask', 'search'], strategy: 'none', promptVariant: 'synthesis' },
    }],
  })
  const options: AskOptions[] = [
    {},
    { resourceId: 'report' },
    { docScope: true },
    { sandbox: true },
    { intent: 'review' },
    { systemPrompt: 'Cite every sentence.', promptAddendum: 'Use a factual claim per sentence.' },
  ]
  for (const opts of options) {
    const f = fixture({ doc: opts.docScope })
    await collect(f.provider, opts, config)
    const prompt = (f.bodies[0]?.prompt as { system: string }).system
    expect(prompt.endsWith(FOOTNOTE_PROMPT)).toBe(true)
    expect(prompt).toContain('same passage or passages')
    expect(prompt).toContain('Sharing a document is not enough')
    expect(prompt).toContain('Cite direct quotations, statistics and specific findings immediately')
    expect(prompt).toContain('give each separate paragraph or bullet its own citations')
    expect(prompt).not.toContain('after each factual claim')
    expect(prompt).not.toContain('after each step or fact')
  }
})

Deno.test('standard citation mode retains its existing per-claim and per-step guidance', async () => {
  for (const docScope of [false, true]) {
    const f = fixture({ mode: 'standard', doc: docScope })
    await collect(f.provider, { docScope })
    const prompt = (f.bodies[0]?.prompt as { system: string }).system
    expect(prompt).toContain(docScope ? 'after each step or fact' : 'after each factual claim')
    expect(prompt).not.toContain(FOOTNOTE_PROMPT)
  }
})

Deno.test('grouping is generation guidance, not post-generation removal of repeated anchors', async () => {
  for (
    const prose of [
      'Stocks recovered. Monitoring continued.[7]',
      'Stocks recovered.[7] Monitoring continued.[7]',
    ]
  ) {
    const f = fixture({ answer: `${prose}\n\n[7]: block-AA\n` })
    const events = await collect(f.provider)
    expect(events.find((e) => e.type === 'done')).toEqual({
      type: 'done',
      refused: false,
      text: `${prose.replaceAll('[7]', '[1]')}\n\n`,
      citationPresentation: 'authored_blocks',
    })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  }
})

Deno.test('unresolvable references keep the prose; out-of-scope ones still fail explicitly', async () => {
  for (const options of [{ broken: true }, { id: 'USER_CONTEXT_0' }]) {
    const f = fixture(options)
    const events = await collect(f.provider)
    expect(events.some((e) => e.type === 'citation' || e.type === 'error')).toBe(false)
    const done = events.find((e) => e.type === 'done')
    // The prose stands without a marker that could not be tied to a passage.
    expect(done && done.type === 'done' && !done.refused && done.text?.trim()).toBe(
      '## Findings\n\nStocks recovered.',
    )
    expect(f.bodies.length).toBe(1)
  }
  for (const options of [{ id: 'unknown/f/pdf/0-16' }, { doc: true }]) {
    const f = fixture(options)
    const events = await collect(f.provider)
    expect(events.some((e) => e.type === 'citation')).toBe(false)
    if (options.doc) {
      expect(events.some((e) => e.type === 'done' && e.refused)).toBe(true)
    } else {
      expect(events.some((e) => e.type === 'done')).toBe(false)
      expect(events.some((e) => e.type === 'error')).toBe(true)
    }
    expect(f.bodies.length).toBe(1)
  }
})

Deno.test('capability retry keeps the citation mode and resets footnote parsing', async () => {
  const f = fixture({ retry: true })
  const events = await collect(f.provider)
  expect(f.bodies.length).toBe(2)
  expect(f.bodies.every((b) => b.citations === 'llm_footnotes')).toBe(true)
  expect(events.some((e) => e.type === 'done' && !e.refused)).toBe(true)
})

Deno.test('document pins reject references leaked by weak platform filters', async () => {
  for (const options of [{ resourceId: 'different' }, { resourceIds: ['different'] }]) {
    const f = fixture()
    const events = await collect(f.provider, options)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'citation' || e.type === 'done')).toBe(false)
  }
})

Deno.test('standard attribution returned despite the footnote request is bound the standard way', async () => {
  const resource = {
    title: 'Original report',
    fields: { 'f/pdf': { paragraphs: { 'report/f/pdf/0-16': { score: 0.9, text: 'x' } } } },
  }
  const footnoteProvider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
      token: 'test',
    }),
    fetchImpl: async (input) => {
      if (String(input).includes('/catalog')) return Response.json({ resources: {} })
      if (String(input).includes('/predict/remi')) return Response.json({})
      return new Response(
        [
          { item: { type: 'retrieval', results: { resources: { report: resource } } } },
          { item: { type: 'answer', text: 'Stocks recovered.' } },
          { item: { type: 'citations', citations: { 'report/f/pdf/0-16': [[0, 17]] } } },
        ].map((item) => JSON.stringify(item)).join('\n') + '\n',
      )
    },
  })
  const events = await collect(footnoteProvider)
  expect(events.some((e) => e.type === 'error')).toBe(false)
  expect(
    events.filter((e) => e.type === 'citation').map((e) =>
      e.type === 'citation' && e.citation.resourceId
    ),
  ).toEqual(['report'])
  const done = events.find((e) => e.type === 'done')
  expect(done && done.type === 'done' && done.text).toBe('Stocks recovered.[1]')
})

Deno.test('standard mode remains available through server construction only', async () => {
  const f = fixture({ mode: 'standard' })
  const events = await collect(f.provider)
  expect(f.bodies[0]?.citations).toBe(true)
  expect(events.find((e) => e.type === 'done')).toEqual({
    type: 'done',
    refused: false,
    text: 'Stocks recovered.[1]',
  })
})

Deno.test('structured JSON never receives either citation mode', async () => {
  const f = fixture()
  await f.provider.askStructured(
    tenant,
    { name: 'test', description: 'Test', parameters: {} },
    'Test',
  )
  expect(f.bodies[0]?.answer_json_schema).toBeDefined()
  expect(f.bodies[0]?.citations).toBeUndefined()
})

Deno.test('footnote repair and failure log fixed codes and counts, never source IDs or payloads', async () => {
  const originalError = console.error
  const originalInfo = console.info
  const errors: unknown[][] = []
  const info: unknown[][] = []
  console.error = (...args: unknown[]) => errors.push(args)
  console.info = (...args: unknown[]) => info.push(args)
  try {
    for (
      const id of [
        'USER_CONTEXT_0',
        'report/a/private-metadata/0-16',
        'private-unsupported-value',
      ]
    ) {
      const f = fixture({ id })
      const events = await collect(f.provider)
      expect(events.some((e) => e.type === 'error' || e.type === 'citation')).toBe(false)
      expect(events.some((e) => e.type === 'done' && !e.refused)).toBe(true)
      expect(info.at(-1)).toEqual([JSON.stringify({
        event: 'arag_footnote_repaired',
        unresolved: 1,
        kept: 0,
      })])
    }
    const f = fixture({ id: 'private-excluded-source/f/pdf/0-16' })
    const events = await collect(f.provider)
    expect(events.some((e) => e.type === 'done' || e.type === 'citation')).toBe(false)
    expect(events.filter((e) => e.type === 'error')).toEqual([{
      type: 'error',
      message: 'The response citation links could not be verified. Please try again.',
    }])
    expect(errors.at(-1)).toEqual([JSON.stringify({
      event: 'arag_footnote_validation_failed',
      reason: 'out_of_scope',
    })])
    expect(f.bodies.length).toBe(1)
    expect(errors.length).toBe(1)
    expect(JSON.stringify([errors, info])).not.toMatch(/private|USER_CONTEXT|block-AA|Stocks/)
  } finally {
    console.error = originalError
    console.info = originalInfo
  }
})

/** Run with console.info and console.error captured; returns what each received. */
async function withLogs<T>(run: () => Promise<T>) {
  const originalInfo = console.info
  const originalError = console.error
  const info: unknown[][] = []
  const errors: unknown[][] = []
  console.info = (...args: unknown[]) => info.push(args)
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    return { result: await run(), info, errors }
  } finally {
    console.info = originalInfo
    console.error = originalError
  }
}

Deno.test('a generated-summary reference no longer fails the answer: it binds to its resource', async () => {
  for (const mode of ['llm_footnotes', 'standard'] as const) {
    const f = fixture({ id: 'report/t/da-private-summary/0-16', mode })
    const { result: events, info, errors } = await withLogs(() => collect(f.provider))
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(errors).toEqual([])
    const done = events.find((e) => e.type === 'done')
    expect(done?.type === 'done' && done.text).toContain('Stocks recovered.[1]')
    // Resource level: the citation carries no passage, so the generated
    // summary is never presented as a quote from the document.
    expect(events.filter((e) => e.type === 'citation')).toEqual([{
      type: 'citation',
      citation: { index: 1, resourceId: 'report', title: 'Original report' },
    }])
    expect(info).toEqual([[JSON.stringify({
      event: 'arag_generated_context_citation',
      remapped: 1,
      dropped: 0,
    })]])
    expect(JSON.stringify(info)).not.toMatch(/private|block-AA|Stocks|report|da-/)
    expect(f.bodies.length).toBe(1)
  }
})

Deno.test('a generated-summary reference to a resource outside scope is dropped, not failed', async () => {
  for (const mode of ['llm_footnotes', 'standard'] as const) {
    for (const options of [{}, { resourceId: 'report' }]) {
      // `elsewhere` was never retrieved and is not in the catalogue; under a
      // document pin it is outside the pinned document as well.
      const f = fixture({ id: 'elsewhere/t/da-summary/0-16', mode })
      const { result: events, info } = await withLogs(() => collect(f.provider, options))
      expect(events.some((e) => e.type === 'error')).toBe(false)
      expect(events.some((e) => e.type === 'citation')).toBe(false)
      const done = events.find((e) => e.type === 'done')
      expect(done?.type === 'done' && done.refused).toBe(false)
      expect(done?.type === 'done' && done.text).not.toMatch(/\[\d+\]/)
      expect(info).toEqual([[JSON.stringify({
        event: 'arag_generated_context_citation',
        remapped: 0,
        dropped: 1,
      })]])
    }
  }
})

Deno.test('a mixed answer binds real and generated references with consistent numbering', async () => {
  const resource = (title: string, text: string) => ({
    title,
    metadata: { status: 'PROCESSED' },
    fields: { 'f/pdf': { paragraphs: { p: { score: 0.9, text } } } },
  })
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
      token: 'test',
    }),
    fetchImpl: (input) => {
      const url = String(input)
      const resources = {
        survey: resource('Dive survey', 'Stocks fell by a third.'),
        closure: resource('Closure review', 'The fishery closed in 2019.'),
      }
      if (url.includes('/catalog')) return Promise.resolve(Response.json({ resources }))
      if (url.includes('/predict/remi')) return Promise.resolve(Response.json({}))
      const raw = 'Stocks fell [1][2]. The fishery closed [3]. Recovery was slow [4][5].\n\n' +
        '[1]: block-A1\n[2]: block-A2\n[3]: block-A3\n[4]: block-A4\n[5]: block-A5\n'
      const items = [
        { type: 'retrieval', results: { resources } },
        { type: 'answer', text: raw },
        {
          type: 'footnote_citations',
          footnote_to_context: {
            'block-A1': 'elsewhere/t/da-summary/0-10',
            'block-A2': 'survey/t/da-summary/0-10',
            'block-A3': 'closure/f/pdf/0-27',
            'block-A4': 'survey/f/pdf/0-23',
            'block-A5': 'closure/t/da-takeaways/0-10',
          },
        },
      ]
      return Promise.resolve(
        new Response(items.map((item) => JSON.stringify({ item })).join('\n') + '\n'),
      )
    },
  })
  const { result: events, info } = await withLogs(() => collect(provider))
  expect(events.some((e) => e.type === 'error')).toBe(false)
  const done = events.find((e) => e.type === 'done')
  expect(done?.type === 'done' && done.text).toBe(
    'Stocks fell.[1] The fishery closed.[2] Recovery was slow.[1][2]\n\n',
  )
  expect(events.flatMap((e) => e.type === 'citation' ? [e.citation] : [])).toEqual([
    { index: 1, resourceId: 'survey', title: 'Dive survey' },
    { index: 2, resourceId: 'closure', title: 'Closure review' },
  ])
  expect(info).toEqual([[JSON.stringify({
    event: 'arag_generated_context_citation',
    remapped: 2,
    dropped: 1,
  })]])
})

Deno.test('verified extra context binds at resource level in both citation modes', async () => {
  for (const mode of ['llm_footnotes', 'standard'] as const) {
    const f = fixture({ id: 'USER_CONTEXT_0', mode })
    const events = await collect(f.provider, {
      sourceContext: [{ resourceId: 'report', text: 'Stocks recovered.' }],
    })
    expect(f.bodies[0]?.extra_context).toEqual(['Stocks recovered.'])
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'citation')).toEqual([{
      type: 'citation',
      citation: { index: 1, resourceId: 'report', title: 'Original report' },
    }])
    expect(events.some((e) => e.type === 'done' && e.text?.includes('Stocks recovered.[1]')))
      .toBe(true)
  }
})

Deno.test('extra context alias order survives filtering, retry and anonymous entries', async () => {
  const f = fixture({ id: 'USER_CONTEXT_1', retry: true })
  const events = await collect(f.provider, {
    extraContext: ['', 'Anonymous context', '   '],
    sourceContext: [
      { resourceId: 'ignored', text: '' },
      { resourceId: 'report', text: 'Stocks recovered.' },
    ],
  })
  expect(f.bodies.every((b) =>
    JSON.stringify(b.extra_context) ===
      JSON.stringify(['Anonymous context', 'Stocks recovered.'])
  )).toBe(true)
  expect(events.some((e) => e.type === 'error')).toBe(false)
  expect(events.some((e) => e.type === 'citation' && e.citation.resourceId === 'report')).toBe(true)
})

Deno.test('supplied context cannot evade resource pins or bind an unsent alias', async () => {
  for (const id of ['USER_CONTEXT_0', 'USER_CONTEXT_12', 'USER_CONTEXT_01']) {
    const f = fixture({ id })
    const events = await collect(f.provider, {
      resourceId: 'different',
      sourceContext: Array.from({ length: 13 }, () => ({
        resourceId: 'report',
        text: 'Stocks recovered.',
      })),
    })
    expect((f.bodies[0]?.extra_context as string[]).length).toBe(12)
    expect(events.some((e) => e.type === 'done' || e.type === 'citation')).toBe(false)
    expect(events.some((e) => e.type === 'error')).toBe(true)
  }
})

Deno.test('footnotes reserve a full default generation budget but respect explicit caps', async () => {
  const implicit = fixture()
  await collect(implicit.provider)
  expect(implicit.bodies[0]?.max_tokens).toBe(4096)

  for (const maxTokens of [1200, 4096, 6000]) {
    const explicit = fixture()
    await collect(explicit.provider, { maxTokens })
    expect(explicit.bodies[0]?.max_tokens).toBe(Math.min(maxTokens, 4096))
  }

  const standard = fixture({ mode: 'standard' })
  await collect(standard.provider)
  expect(standard.bodies[0]?.max_tokens).toBeUndefined()
  const structured = fixture()
  await structured.provider.askStructured(
    tenant,
    { name: 'test', description: 'Test', parameters: {} },
    'Test',
  )
  // Structured generation already requests 4096, independently of citations.
  expect(structured.bodies[0]?.max_tokens).toBe(4096)
})

Deno.test('stored-filter incompatibility removes only configuration and preserves pinned whole-source reading', async () => {
  const f = fixture({
    inferenceModel: 'openai-compatible',
    failures: [{
      status: 412,
      detail:
        'Invalid query. Error in filter_expression: Cannot mix old filters with filter_expression',
    }],
  })
  const events = await collect(f.provider, {
    resourceIds: ['report', 'paired'],
    depth: 'deep',
    prequeries: ['Earlier notebook hypothesis'],
    images: true,
    sourceContext: [{ resourceId: 'report', text: 'Stocks recovered.' }],
    maxTokens: 1200,
  })
  expect(f.bodies.length).toBe(2)
  expect(f.bodies[0]!.resource_filters).toEqual(['report', 'paired'])
  expect(f.bodies[0]!.generative_model).toBe('openai-compatible')
  expect(f.bodies[0]!.rag_strategies).toEqual([
    { name: 'full_resource' },
    {
      name: 'prequeries',
      queries: [{
        request: { query: 'Earlier notebook hypothesis', features: ['keyword', 'semantic'] },
        weight: 1,
      }],
    },
  ])
  const expected = { ...f.bodies[0] }
  delete expected.search_configuration
  expect(f.bodies[1]).toEqual(expected)
  expect(events.some((e) => e.type === 'done' && !e.refused)).toBe(true)
})

Deno.test('a later capability fallback keeps resource scope, answer settings and the binding model', async () => {
  const f = fixture({
    inferenceModel: 'openai-compatible',
    failures: [
      { status: 412, detail: 'Cannot mix old filters with filter_expression' },
      { status: 400, detail: 'Unsupported strategy' },
    ],
  })
  const events = await collect(f.provider, {
    resourceIds: ['report', 'paired'],
    depth: 'deep',
    sourceContext: [{ resourceId: 'report', text: 'Stocks recovered.' }],
    maxTokens: 1200,
  })
  expect(f.bodies.length).toBe(3)
  const expected = { ...f.bodies[0] }
  for (
    const key of ['search_configuration', 'rag_strategies', 'rag_images_strategies', 'reranker']
  ) delete expected[key]
  expect(f.bodies[2]).toEqual(expected)
  expect(f.bodies.every((b) => b.generative_model === 'openai-compatible')).toBe(true)
  expect(
    f.bodies.every((b) =>
      JSON.stringify(b.resource_filters) === JSON.stringify(['report', 'paired'])
    ),
  ).toBe(true)
  expect(events.some((e) => e.type === 'done' && !e.refused)).toBe(true)
})
