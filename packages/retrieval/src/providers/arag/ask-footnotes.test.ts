import { expect } from '@std/expect'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { TenantConfigSchema } from '@research-portal/core'
import type { AskOptions } from '../../provider.ts'
import { AragProvider } from './index.ts'
import { CITATION_MODE, type CitationMode, FOOTNOTE_PROMPT } from './citation-mode.ts'

const tenant: TenantConfig = {
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
    }),
    fetchImpl: (input, init) => {
      const url = String(input)
      if (url.includes('/catalog')) {
        return Promise.resolve(Response.json({ resources: { report: resource } }))
      }
      if (url.includes('/predict/remi')) return Promise.resolve(Response.json({}))
      if (!url.endsWith('/ask')) throw new Error('Unexpected endpoint')
      bodies.push(JSON.parse(String(init?.body)))
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

Deno.test('broken or excluded references fail explicitly without success or standard-mode retry', async () => {
  for (
    const options of [
      { broken: true },
      { id: 'unknown/f/pdf/0-16' },
      { id: 'report/t/da-summary/0-16' },
      { id: 'USER_CONTEXT_0' },
      { doc: true },
    ]
  ) {
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

Deno.test('standard attribution returned despite the footnote request is not silently accepted', async () => {
  const footnoteProvider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
      token: 'test',
    }),
    fetchImpl: async (input) => {
      if (String(input).includes('/catalog')) return Response.json({ resources: {} })
      return new Response(
        [
          { item: { type: 'answer', text: 'Stocks recovered.' } },
          { item: { type: 'citations', citations: { 'report/f/pdf/0-16': [[0, 17]] } } },
        ].map((item) => JSON.stringify(item)).join('\n') + '\n',
      )
    },
  })
  const events = await collect(footnoteProvider)
  expect(events.some((e) => e.type === 'error')).toBe(true)
  expect(events.some((e) => e.type === 'done')).toBe(false)
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

Deno.test('footnote validation logs fixed reason codes without leaking source IDs or payloads', async () => {
  const originalError = console.error
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => logs.push(args)
  try {
    for (
      const [id, reason] of [
        ['USER_CONTEXT_0', 'anonymous_context'],
        ['report/t/da-private-summary/0-16', 'generated_context'],
        ['report/a/private-metadata/0-16', 'metadata_context'],
        ['private-excluded-source/f/pdf/0-16', 'out_of_scope'],
        ['private-unsupported-value', 'unsupported_context'],
      ]
    ) {
      const f = fixture({ id })
      const events = await collect(f.provider)
      expect(events.some((e) => e.type === 'done' || e.type === 'citation')).toBe(false)
      expect(events.filter((e) => e.type === 'error')).toEqual([{
        type: 'error',
        message: 'The response citation links could not be verified. Please try again.',
      }])
      expect(logs.at(-1)).toEqual([JSON.stringify({
        event: 'arag_footnote_validation_failed',
        reason,
      })])
      expect(f.bodies.length).toBe(1)
    }
    expect(logs.length).toBe(5)
    expect(JSON.stringify(logs)).not.toMatch(/private|USER_CONTEXT|block-AA|Stocks|report/)
  } finally {
    console.error = originalError
  }
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
