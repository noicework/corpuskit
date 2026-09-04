import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * Label definitions live in the platform's per-label `text`; labeller agents
 * carry their own copy in task configuration. These cover the provider's
 * side of the editor: reading definitions, replacing a labelset without
 * losing its colour/kind, exposing agent configs, and the exact wire shape of
 * a re-instantiation (filter passthrough, `cleanup=false` on delete).
 */

const TENANT: TenantConfig = {
  slug: 'marine',
  branding: {
    productName: 'Southern Waters Research Portal',
    organisation: 'Southern Waters Research Institute',
    tagline: 'Fisheries research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

const LABELSETS = {
  labelsets: {
    topic: {
      title: 'Topic',
      color: '#1f6f8b',
      multiple: false,
      kind: ['RESOURCES'],
      labels: [
        { title: 'stock-assessment', text: 'Surveys and models of a fished population.' },
        { title: 'marine-sustainability', text: '' },
        { title: '', text: 'orphan without a title' },
      ],
    },
    finding: {
      title: 'Finding',
      color: '#aa3355',
      multiple: true,
      kind: ['PARAGRAPHS'],
      labels: [{ title: 'result' }],
    },
  },
}

const TASKS = {
  tasks: [],
  running: [],
  done: [],
  configs: [
    {
      id: 'task-topic',
      task: { name: 'labeler' },
      parameters: {
        name: 'topic-labeller',
        on: 1,
        llm: { model: 'chatgpt-azure-4o-mini' },
        filter: { field_types: ['FILE', 'LINK'], apply_to_agent_generated_fields: false },
        operations: [{ label: { ident: 'topic', labels: [{ label: 'x' }], multiple: false } }],
      },
      enabled: true,
    },
    {
      id: 'task-graph',
      task: 'llm-graph',
      parameters: { name: 'kg-marine', operations: [{ graph: { ident: 'kg1' } }] },
      enabled: false,
    },
    { task: { name: 'ask' }, parameters: { name: 'no-id-entry' } },
  ],
}

type Call = { method: string; url: string; body?: unknown }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function harness(routes: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { method, url, body }
    calls.push(call)
    return Promise.resolve(routes(call) ?? jsonResponse({ detail: 'not found' }, 404))
  }
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl,
  })
  return { provider, calls }
}

describe('AragProvider.labelsets - definitions', () => {
  it('captures each label text into definitions keyed by title, skipping empties', async () => {
    const { provider } = harness((call) =>
      call.url.endsWith('/labelsets') ? jsonResponse(LABELSETS) : undefined
    )
    const sets = await provider.labelsets(TENANT)
    const topic = sets.find((ls) => ls.id === 'topic')
    expect(topic?.labels).toEqual(['stock-assessment', 'marine-sustainability'])
    expect(topic?.definitions).toEqual({
      'stock-assessment': 'Surveys and models of a fished population.',
    })
    expect(topic?.kind).toBe('RESOURCES')
    const finding = sets.find((ls) => ls.id === 'finding')
    expect(finding?.definitions).toBeUndefined()
    expect(finding?.kind).toBe('PARAGRAPHS')
  })
})

describe('AragProvider.updateLabelset', () => {
  it('reads the existing set, then posts the full replacement keeping colour and kind', async () => {
    const { provider, calls } = harness((call) => {
      if (call.url.endsWith('/labelsets')) return jsonResponse(LABELSETS)
      if (call.method === 'POST' && call.url.endsWith('/labelset/finding')) return jsonResponse({})
      return undefined
    })
    await provider.updateLabelset(TENANT, {
      id: 'finding',
      title: 'Findings',
      multiple: false,
      labels: [
        { title: 'result', text: 'A stated outcome of the study.' },
        { title: 'caveat', text: '' },
      ],
    })
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v1/kb/test-kb/labelsets',
      'POST /api/v1/kb/test-kb/labelset/finding',
    ])
    expect(calls[1]?.body).toEqual({
      title: 'Findings',
      color: '#aa3355',
      multiple: false,
      kind: ['PARAGRAPHS'],
      labels: [
        { title: 'result', text: 'A stated outcome of the study.' },
        { title: 'caveat', text: '' },
      ],
    })
  })

  it('refuses to create a set that does not exist', async () => {
    const { provider, calls } = harness((call) =>
      call.url.endsWith('/labelsets') ? jsonResponse(LABELSETS) : undefined
    )
    await expect(
      provider.updateLabelset(TENANT, {
        id: 'region',
        title: 'Region',
        multiple: true,
        labels: [],
      }),
    ).rejects.toThrow(/does not exist/)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })
})

describe('AragProvider.agentConfigs', () => {
  it('exposes each configured agent with task, name, model, filter and operations', async () => {
    const { provider } = harness((call) =>
      call.url.includes('.dp.progress.cloud') && call.url.endsWith('/tasks')
        ? jsonResponse(TASKS)
        : undefined
    )
    const agents = await provider.agentConfigs(TENANT)
    expect(agents).toEqual([
      {
        id: 'task-topic',
        task: 'labeler',
        title: 'topic-labeller',
        model: 'chatgpt-azure-4o-mini',
        on: 1,
        filter: { field_types: ['FILE', 'LINK'], apply_to_agent_generated_fields: false },
        operations: [{ label: { ident: 'topic', labels: [{ label: 'x' }], multiple: false } }],
        enabled: true,
      },
      {
        id: 'task-graph',
        task: 'llm-graph',
        title: 'kg-marine',
        model: '',
        on: undefined,
        filter: undefined,
        operations: [{ graph: { ident: 'kg1' } }],
        enabled: false,
      },
    ])
  })
})

describe('AragProvider.startAgent / deleteAgent - re-instantiation wire shape', () => {
  it('passes filter and on through verbatim and applies to NEW only', async () => {
    const { provider, calls } = harness((call) =>
      call.method === 'POST' && call.url.endsWith('/task/start') ? jsonResponse({}) : undefined
    )
    const filter = { field_types: ['FILE'], apply_to_agent_generated_fields: true }
    await provider.startAgent(TENANT, {
      task: 'labeler',
      title: 'topic-labeller',
      operations: [{ label: { ident: 'topic', labels: [], multiple: true } }],
      applyExisting: false,
      model: 'chatgpt-azure-4o-mini',
      filter,
      on: 2,
    })
    expect(calls[0]?.url).toBe('https://test.dp.progress.cloud/api/v1/kb/test-kb/task/start')
    expect(calls[0]?.body).toEqual({
      name: 'labeler',
      parameters: {
        name: 'topic-labeller',
        on: 2,
        operations: [{ label: { ident: 'topic', labels: [], multiple: true } }],
        llm: { model: 'chatgpt-azure-4o-mini' },
        filter,
      },
      apply: 'NEW',
      enabled: true,
    })
  })

  it('omits filter and defaults on when not supplied (existing callers unchanged)', async () => {
    const { provider, calls } = harness((call) =>
      call.method === 'POST' && call.url.endsWith('/task/start') ? jsonResponse({}) : undefined
    )
    await provider.startAgent(TENANT, {
      task: 'ask',
      title: 'summariser',
      operations: [],
      applyExisting: true,
      model: '',
    })
    const body = calls[0]?.body as { apply: string; parameters: Record<string, unknown> }
    expect(body.apply).toBe('ALL')
    expect(body.parameters.on).toBe(1)
    expect('filter' in body.parameters).toBe(false)
    expect('llm' in body.parameters).toBe(false)
  })

  it('deletes with cleanup=false so generated data is kept', async () => {
    const { provider, calls } = harness((call) =>
      call.method === 'DELETE' ? jsonResponse({}) : undefined
    )
    await provider.deleteAgent(TENANT, 'task-topic')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe(
      'https://test.dp.progress.cloud/api/v1/kb/test-kb/task/task-topic?cleanup=false',
    )
  })
})
