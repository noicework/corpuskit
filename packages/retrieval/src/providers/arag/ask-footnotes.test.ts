import { expect } from '@std/expect'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import type { AskOptions } from '../../provider.ts'
import { AragProvider } from './index.ts'
import { CITATION_MODE, type CitationMode } from './citation-mode.ts'

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
        : '## Findings\n\nStocks recovered [7] .\n\n[7]: block-AA\n'
      const items: unknown[] = [
        { type: 'retrieval', results: { resources: { report: resource } } },
        ...Array.from(raw).map((text) => ({ type: 'answer', text })),
        opts.mode === 'standard'
          ? { type: 'citations', citations: { 'report/f/pdf/0-16': [[0, 17]] } }
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
async function collect(provider: AragProvider, opts: AskOptions = {}) {
  const events: AskEvent[] = []
  for await (const event of provider.ask(tenant, 'What happened?', opts)) events.push(event)
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
