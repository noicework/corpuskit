import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { SearchResults, TenantConfig } from '@research-portal/core'
import { DOCS_PROBE_QUERY, DocsHealth } from './docs-health.ts'

const tenant = (slug: string): TenantConfig => ({
  slug,
  branding: {
    productName: `${slug} portal`,
    organisation: slug,
    tagline: 'Testing',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
})

const results = (count: number): SearchResults => ({
  query: DOCS_PROBE_QUERY,
  resources: Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    title: `Doc ${i}`,
    summary: '',
    type: 'document' as const,
    topicIds: [],
    keyFacts: [],
    relevance: 0.9,
    citedCount: 0,
  })),
  relatedQuestions: [],
})

describe('DocsHealth', () => {
  it('records a documentation count per bound portal and stays quiet when docs are indexed', async () => {
    const logs: string[] = []
    const calls: { slug: string; docScope?: boolean; query: string }[] = []
    const health = new DocsHealth({
      tenants: () => [tenant('neuro'), tenant('unbound')],
      isBound: (slug) => slug === 'neuro',
      provider: {
        search: (config, query, opts) => {
          calls.push({ slug: config.slug, docScope: opts?.docScope, query })
          return Promise.resolve(results(14))
        },
      },
      log: (m) => logs.push(m),
      now: () => new Date('2026-09-04T00:00:00Z'),
    })
    const status = await health.check()
    expect(calls).toEqual([{ slug: 'neuro', docScope: true, query: DOCS_PROBE_QUERY }])
    expect(status.neuro).toEqual({
      documents: 14,
      ok: true,
      checkedAt: '2026-09-04T00:00:00.000Z',
    })
    expect(status.unbound).toBeUndefined()
    expect(health.ok()).toBe(true)
    expect(logs).toEqual([])
  })

  it('fails loudly when the documentation-scoped search returns nothing', async () => {
    const logs: string[] = []
    const health = new DocsHealth({
      tenants: () => [tenant('neuro')],
      isBound: () => true,
      provider: { search: () => Promise.resolve(results(0)) },
      log: (m) => logs.push(m),
    })
    const status = await health.check()
    expect(status.neuro?.ok).toBe(false)
    expect(status.neuro?.documents).toBe(0)
    expect(health.ok()).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('DOCUMENTATION NOT INDEXED')
    expect(logs[0]).toContain('/api/admin/t/neuro/docs/ingest')
  })

  it('records a probe failure as not ok rather than throwing', async () => {
    const logs: string[] = []
    const health = new DocsHealth({
      tenants: () => [tenant('neuro')],
      isBound: () => true,
      provider: { search: () => Promise.reject(new Error('box offline')) },
      log: (m) => logs.push(m),
    })
    const status = await health.check()
    expect(status.neuro?.ok).toBe(false)
    expect(status.neuro?.error).toBe('box offline')
    expect(logs[0]).toContain('box offline')
  })

  it('re-checking a single portal replaces its earlier result', async () => {
    let count = 0
    const health = new DocsHealth({
      tenants: () => [tenant('neuro')],
      isBound: () => true,
      provider: { search: () => Promise.resolve(results(count)) },
      log: () => {},
    })
    await health.check()
    expect(health.ok()).toBe(false)
    count = 14
    await health.checkTenant(tenant('neuro'))
    expect(health.ok()).toBe(true)
    expect(health.snapshot().neuro?.documents).toBe(14)
  })
})
