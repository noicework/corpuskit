import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const names: Record<string, string> = { a: 'AP-M0', b: 'QC-P2' }
const routes = (name: string) => [
  `entity?name=${encodeURIComponent(name)}`,
  `graph/relations?entity=${encodeURIComponent(name)}`,
]
const nativeGraph = (slug: string) => ({
  nodes: [
    { id: names[slug], group: 'Material', weight: 1 },
    { id: `experiment-${slug}`, group: 'Experiment', weight: 1 },
  ],
  edges: [{ source: `experiment-${slug}`, target: names[slug], label: 'uses material' }],
})

function fixture(adapter: 'local' | 'durable' = 'local') {
  const calls: string[] = []
  const state = {
    catalogue: [] as string[],
    catalogueError: false,
    graphError: false,
    graph: undefined as unknown,
  }
  const f = createEnforcementFixture({
    management: {
      entityGroups: (config: { slug: string }) => {
        calls.push(`groups:${config.slug}`)
        if (state.catalogueError) return Promise.reject(new Error('Unavailable catalogue'))
        return Promise.resolve([{ group: 'Material', entities: state.catalogue }])
      },
      relationsGraph: (config: { slug: string }, options?: { entity?: string }) => {
        calls.push(
          options?.entity
            ? `neighbourhood:${config.slug}:${options.entity}`
            : `graph:${config.slug}`,
        )
        if (!options?.entity && state.graphError) {
          return Promise.reject(new Error('Unavailable graph'))
        }
        return Promise.resolve(
          options?.entity
            ? nativeGraph(config.slug)
            : state.graph === undefined
            ? nativeGraph(config.slug)
            : state.graph,
        )
      },
      listAgents: () => Promise.resolve([]),
    } as unknown as AragProvider,
  }, adapter)
  return { ...f, calls, state }
}

Deno.test('native user graph nodes absent from entity groups open dossiers and expand in their portal', async (t) => {
  for (const adapter of ['local', 'durable'] as const) {
    await t.step(adapter, async () => {
      const f = fixture(adapter)
      try {
        const viewer = f.sessionFor('viewer')
        for (const suffix of routes(' AP-M0 ')) {
          f.calls.length = 0
          const response = await f.requestAs(viewer, `/api/t/a/${suffix}`)
          expect(response.status).toBe(200)
          const body = await response.json()
          const graph = body.relations ?? body
          expect(graph.edges).toEqual(nativeGraph('a').edges)
          expect(graph.nodes.some((node: { id: string }) => node.id === 'AP-M0')).toBe(true)
          expect(f.calls).toEqual(['groups:a', 'graph:a', 'neighbourhood:a:AP-M0'])
        }
        expect(f.providerCalls.some((call) => /ask|generate/i.test(call.method))).toBe(false)
      } finally {
        f.close()
      }
    })
  }
})

Deno.test('registered entity membership keeps its existing short circuit without a graph catalogue read', async () => {
  const f = fixture()
  try {
    f.state.catalogue = ['AP-M0']
    f.state.graphError = true
    const response = await f.requestAs(
      f.sessionFor('viewer'),
      '/api/t/a/graph/relations?entity=AP-M0',
    )
    expect(response.status).toBe(200)
    expect(f.calls).toEqual(['groups:a', 'neighbourhood:a:AP-M0'])
  } finally {
    f.close()
  }
})

Deno.test('native entity fallback rejects unknown, case-folded, partial and foreign-portal names', async () => {
  const f = fixture()
  try {
    const viewer = f.sessionFor('viewer')
    for (const name of ['missing', 'ap-m0', 'AP-M', 'AP-M0 extra', 'QC-P2']) {
      for (const suffix of routes(name)) {
        f.calls.length = 0
        f.providerCalls.length = 0
        const response = await f.requestAs(viewer, `/api/t/a/${suffix}`)
        expect(response.status).toBe(404)
        expect(f.calls).toEqual(['groups:a', 'graph:a'])
        expect(f.providerCalls).toEqual([])
        expect(await response.text()).not.toContain('experiment-b')
      }
    }
    f.calls.length = 0
    const denied = await f.requestAs(viewer, '/api/t/b/graph/relations?entity=QC-P2')
    expect(denied.status).toBe(403)
    expect(f.calls).toEqual([])
    const own = await f.requestAs(
      f.sessionFor('viewer', 'b'),
      '/api/t/b/graph/relations?entity=QC-P2',
    )
    expect(own.status).toBe(200)
    expect(f.calls).toEqual(['groups:b', 'graph:b', 'neighbourhood:b:QC-P2'])
  } finally {
    f.close()
  }
})

Deno.test('unavailable entity catalogues and native graphs fail closed before evidence or neighbourhood dispatch', async () => {
  const f = fixture()
  try {
    const viewer = f.sessionFor('viewer')
    for (const failure of ['catalogueError', 'graphError'] as const) {
      f.state[failure] = true
      for (const suffix of routes('AP-M0')) {
        f.calls.length = 0
        f.providerCalls.length = 0
        expect((await f.requestAs(viewer, `/api/t/a/${suffix}`)).status).toBe(404)
        expect(f.calls).toEqual(
          failure === 'catalogueError' ? ['groups:a'] : ['groups:a', 'graph:a'],
        )
        expect(f.providerCalls).toEqual([])
      }
      f.state[failure] = false
    }
  } finally {
    f.close()
  }
})

Deno.test('matching names in malformed native graph nodes do not establish membership', async () => {
  const f = fixture()
  try {
    const viewer = f.sessionFor('viewer')
    const malformed = [
      null,
      {},
      { nodes: null },
      { nodes: { id: 'AP-M0', group: 'Material', weight: 1 } },
      { nodes: [null, 'AP-M0', ['AP-M0']] },
      { nodes: [{ id: 'AP-M0' }] },
      { nodes: [{ id: 'AP-M0', group: null, weight: 1 }] },
      { nodes: [{ id: 'AP-M0', group: 1, weight: 1 }] },
      { nodes: [{ id: 1, group: 'Material', weight: 1 }] },
      { nodes: [{ group: 'Material', weight: 1 }] },
      ...[NaN, Infinity, -1, '1', null, undefined].map((weight) => ({
        nodes: [{ id: 'AP-M0', group: 'Material', weight }],
      })),
    ]
    for (const graph of malformed) {
      f.state.graph = graph
      for (const suffix of routes('AP-M0')) {
        f.calls.length = 0
        f.providerCalls.length = 0
        expect((await f.requestAs(viewer, `/api/t/a/${suffix}`)).status).toBe(404)
        expect(f.calls).toEqual(['groups:a', 'graph:a'])
        expect(f.providerCalls).toEqual([])
      }
    }
  } finally {
    f.close()
  }
})
