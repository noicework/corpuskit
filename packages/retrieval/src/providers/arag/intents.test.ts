import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { TenantConfigSchema } from '@research-portal/core'
import {
  groundingPrequeries,
  intentConfigurationName,
  intentFilterExpression,
  intentSearchConfigs,
  intentStrategies,
  MAX_PREQUERIES,
  PINNED_CLAUSE_TOP_K,
  PINNED_TOP_K,
  researchExcludeFilterExpression,
  SCOPED_TOP_K,
  shapeSourcesForIntent,
  splitPartialMarker,
} from './index.ts'

const tenant = TenantConfigSchema.parse({
  slug: 't',
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
  defaultIntent: 'general',
  intents: [
    {
      id: 'lookup',
      label: 'Lookup',
      description: '',
      retrieval: { features: ['keyword'], topK: 30, reranker: 'noop' },
      answer: { surfaces: ['search'], strategy: 'none', promptVariant: 'default' },
    },
    {
      id: 'data',
      label: 'Data',
      description: '',
      retrieval: {
        features: ['keyword', 'semantic'],
        topK: 20,
        reranker: 'predict',
        only: [{ labelset: 'format', label: 'supplement' }],
      },
      answer: {
        surfaces: ['ask', 'search'],
        strategy: 'neighbours',
        neighbours: 4,
        promptVariant: 'data',
      },
    },
    {
      id: 'general',
      label: 'General',
      description: '',
      retrieval: { features: ['keyword', 'semantic'], topK: 20, reranker: 'predict' },
      answer: { surfaces: ['ask', 'search'], strategy: 'neighbours', promptVariant: 'default' },
    },
  ],
})

describe('intent search configurations', () => {
  it('derives one stored configuration per surface, skipping the default intent', () => {
    const configs = intentSearchConfigs(tenant)
    expect(Object.keys(configs).sort()).toEqual([
      'portal-intent-data',
      'portal-intent-data-find',
      'portal-intent-lookup',
    ])
    const lookup = configs['portal-intent-lookup'] as {
      kind: string
      config: Record<string, unknown>
    }
    expect(lookup.kind).toBe('find')
    expect(lookup.config.features).toEqual(['keyword'])
    expect(lookup.config.reranker).toBe('noop')
    expect(lookup.config.top_k).toBe(30)
    const data = configs['portal-intent-data'] as { kind: string; config: Record<string, unknown> }
    expect(data.kind).toBe('ask')
    expect(data.config.citations).toBe(true)
  })

  it('names the default intent after the default pair', () => {
    expect(intentConfigurationName(tenant, 'general', 'ask')).toBe('portal-ask')
    expect(intentConfigurationName(tenant, 'general', 'find')).toBe('portal-search')
    expect(intentConfigurationName(tenant, 'lookup', 'find')).toBe('portal-intent-lookup')
    expect(intentConfigurationName(tenant, 'data', 'find')).toBe('portal-intent-data-find')
  })

  it('builds an only-filter that still excludes documentation, and leaves the plain shape alone', () => {
    const only = intentFilterExpression({ only: [{ labelset: 'format', label: 'supplement' }] })
    expect(only).toEqual({
      field: {
        and: [
          { not: { prop: 'label', labelset: 'content-type', label: 'documentation' } },
          { prop: 'label', labelset: 'format', label: 'supplement' },
        ],
      },
    })
    expect(intentFilterExpression({})).toEqual(researchExcludeFilterExpression())
  })

  it('maps the portal half to strategies and shapes sources', () => {
    const data = tenant.intents!.find((i) => i.id === 'data')!
    expect(intentStrategies(data)).toEqual([{
      name: 'neighbouring_paragraphs',
      before: 4,
      after: 4,
    }])
    const sources = [
      { id: 'a', relevance: 0.2, published: '2020-01-01' },
      { id: 'b', relevance: 0.9, published: '2024-01-01' },
    ] as unknown as Parameters<typeof shapeSourcesForIntent>[0]
    expect(
      shapeSourcesForIntent(sources, {
        ...data,
        answer: { ...data.answer, minScore: 0.5, sortByPublished: true },
      }).map((s) => s.id),
    ).toEqual(['b', 'a'])
    expect(shapeSourcesForIntent(sources, undefined)).toHaveLength(2)
  })
})

describe('grounding prequeries', () => {
  it('pins named resources first, then the preferred labels, then the sub-questions', () => {
    const queries = groundingPrequeries('the BREATHS trial design', {
      pinnedResourceIds: ['breaths'],
      prefer: [{ labelset: 'format', label: 'supplement' }],
      prequeries: ['what is the control arm?'],
    })
    expect(queries).toEqual([
      {
        request: {
          query: 'the BREATHS trial design',
          features: ['keyword', 'semantic'],
          resource_filters: ['breaths'],
          top_k: PINNED_TOP_K,
        },
        weight: 2,
      },
      {
        request: {
          query: 'the BREATHS trial design',
          features: ['keyword', 'semantic'],
          filters: ['/classification.labels/format/supplement'],
        },
        weight: 1,
      },
      {
        request: { query: 'what is the control arm?', features: ['keyword', 'semantic'] },
        weight: 1,
      },
    ])
  })
  it('runs each clause of a multi-part question against the first pinned papers', () => {
    const queries = groundingPrequeries('criteria, and what proportion met them', {
      pinnedResourceIds: ['lgs', 'other', 'third'],
      pinnedQueries: ['What are the ILAE criteria', 'what proportion met them', 'a third clause'],
    })
    const clausePasses = queries.filter((q) =>
      (q.request as { top_k?: number }).top_k === PINNED_CLAUSE_TOP_K
    )
    expect(clausePasses.map((q) => (q.request as { query: string; resource_filters: string[] })))
      .toEqual([
        expect.objectContaining({ query: 'What are the ILAE criteria', resource_filters: ['lgs'] }),
        expect.objectContaining({ query: 'what proportion met them', resource_filters: ['lgs'] }),
        expect.objectContaining({
          query: 'What are the ILAE criteria',
          resource_filters: ['other'],
        }),
        expect.objectContaining({ query: 'what proportion met them', resource_filters: ['other'] }),
      ])
    expect(queries.length).toBe(7)
  })
  it('sends nothing when there is nothing to add, and never more than the platform cap', () => {
    expect(groundingPrequeries('q', {})).toEqual([])
    const many = groundingPrequeries('q', {
      pinnedResourceIds: ['a', 'b', 'c', 'd'],
      prefer: [{ labelset: 'format', label: 'supplement' }],
      prequeries: Array.from({ length: 12 }, (_, i) => `sub-question ${i}`),
    })
    expect(many.length).toBe(MAX_PREQUERIES)
    // At most four pinned resources (named studies plus the top paper per
    // entity): a pinned set never crowds the window.
    expect(many.filter((q) => 'resource_filters' in (q.request as object)).length).toBe(4)
  })
  it("runs a scoped topic pass over an author's articles ahead of everything else", () => {
    const queries = groundingPrequeries("What has O'Neill published on cycles?", {
      scopedQueries: [{ query: 'seizure cycles', resourceIds: ['a', 'b'] }, {
        query: '   ',
        resourceIds: ['a'],
      }],
      prequeries: ['sub-question'],
    })
    expect(queries[0]).toEqual({
      request: {
        query: 'seizure cycles',
        features: ['keyword', 'semantic'],
        resource_filters: ['a', 'b'],
        top_k: SCOPED_TOP_K,
      },
      weight: 2,
    })
    expect(queries.length).toBe(2)
  })
  it('holds back the start of a marker a later chunk completes', () => {
    expect(splitPartialMarker('relapse [')).toEqual({ emit: 'relapse', hold: ' [' })
    expect(splitPartialMarker('relapse [1')).toEqual({ emit: 'relapse', hold: ' [1' })
    expect(splitPartialMarker('relapse [1, 2')).toEqual({ emit: 'relapse', hold: ' [1, 2' })
    expect(splitPartialMarker('relapse [1].')).toEqual({ emit: 'relapse [1].', hold: '' })
    expect(splitPartialMarker('plain text')).toEqual({ emit: 'plain text', hold: '' })
  })
  it('stores an additive filter for a preferring intent: excluded labels only, nothing restricted', () => {
    const additive = intentFilterExpression(
      {
        exclude: [{ labelset: 'format', label: 'media' }],
        prefer: [{ labelset: 'format', label: 'supplement' }],
      } as Parameters<typeof intentFilterExpression>[0],
    )
    expect(additive).toEqual(
      researchExcludeFilterExpression([{ labelset: 'format', label: 'media' }]),
    )
  })
})

describe('groundingPrequeries - follow-ups and Help (D4-07, D4-17)', () => {
  it("gives an earlier turn's paper a lighter pass than a pinned paper, and never twice", () => {
    const queries = groundingPrequeries('how does that cohort compare', {
      pinnedResourceIds: ['pin'],
      priorResourceIds: ['pin', 'prior'],
    })
    expect(queries).toHaveLength(2)
    expect(queries[0]).toMatchObject({
      weight: 2,
      request: { resource_filters: ['pin'], top_k: 20 },
    })
    expect(queries[1]).toMatchObject({
      weight: 1,
      request: { resource_filters: ['prior'], top_k: 10 },
    })
  })
  it('carries the documentation filter on every Help prequery', () => {
    const filter = { field: { prop: 'label', labelset: 'content-type', label: 'documentation' } }
    const queries = groundingPrequeries('internet and model', {
      prequeries: ['does the portal look anything up on the internet', 'which model writes'],
      filterExpression: filter,
    })
    expect(queries).toHaveLength(2)
    for (const q of queries) expect(q.request).toMatchObject({ filter_expression: filter })
  })
})
