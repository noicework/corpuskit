import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * O'Neill loop 1, D1-06: the `kind` a research article shows is the study
 * design the record states, derived by the rule-first classifier in every
 * place a kind is read - cards, the resource header, the facet counts and the
 * kind filter - so the facet can never disagree with the cards under it.
 */

const TENANT: TenantConfig = {
  slug: 'neuro',
  branding: {
    productName: 'Neurology Research Portal',
    organisation: 'Neurology Research Collective',
    tagline: 'Epilepsy research',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A journal article the labeller filed as a randomised trial; it is a cohort study. */
const RITUXIMAB = {
  title:
    'Rituximab Use for Relapse Prevention in Anti-NMDAR Antibody-Mediated Encephalitis: A Multicenter Cohort Study',
  metadata: { status: 'PROCESSED' },
  usermetadata: {
    classifications: [{ labelset: 'topic', label: 'epilepsy-research' }, {
      labelset: 'format',
      label: 'article',
    }],
  },
  computedmetadata: {
    field_classifications: [{
      classifications: [{ labelset: 'kind', label: 'randomised-controlled-trial' }],
    }],
  },
  extra: {
    metadata: {
      summary: 'Methods This multicentre cohort study included 66 patients.',
      doi: '10.1212/NXI.0000000000200000',
      journal: 'Neurol Neuroimmunol Neuroinflamm',
      keywords: ['Cohort Studies', 'Humans'],
      titleCurated: true,
    },
  },
  fields: { a: { paragraphs: { p1: { score: 0.8, text: 'Rituximab reduced relapse risk.' } } } },
}

/** The same article's supplement: a format, never a study design. */
const RITUXIMAB_SUPPLEMENT = {
  title: 'Supplementary material 1: Rituximab Use for Relapse Prevention',
  metadata: { status: 'PROCESSED' },
  usermetadata: {
    classifications: [{ labelset: 'format', label: 'supplement' }, {
      labelset: 'kind',
      label: 'supplementary-material',
    }],
  },
  extra: { metadata: { doi: '10.1212/NXI.0000000000200000', journal: 'Neurol Neuroimmunol' } },
  fields: { a: { paragraphs: { p1: { score: 0.5, text: 'Table S1.' } } } },
}

/** A corpus of reports (no bibliographic record) keeps its labelset's kind. */
const REPORT = {
  title: 'Abalone stock management in the southern zone',
  metadata: { status: 'PROCESSED' },
  usermetadata: { classifications: [{ labelset: 'kind', label: 'report' }] },
  fields: { a: { paragraphs: { p1: { score: 0.7, text: 'Stock levels remain stable.' } } } },
}

const CATALOGUE = {
  'res-ritux': RITUXIMAB,
  'res-ritux-s1': RITUXIMAB_SUPPLEMENT,
  'res-report': REPORT,
}

function providerWith(): { provider: AragProvider; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url + (init?.body ? ` ${init.body}` : ''))
    if (url.includes('/find')) return Promise.resolve(jsonResponse({ resources: CATALOGUE }))
    if (url.includes('/labelsets')) {
      return Promise.resolve(jsonResponse({
        labelsets: {
          kind: { title: 'Kind', labels: [{ title: 'randomised-controlled-trial' }] },
          format: { title: 'Format', labels: [{ title: 'article' }, { title: 'supplement' }] },
        },
      }))
    }
    if (url.includes('/catalog')) {
      return Promise.resolve(jsonResponse({ resources: CATALOGUE, total: 3 }))
    }
    if (url.includes('/resource/res-ritux')) return Promise.resolve(jsonResponse(RITUXIMAB))
    throw new Error(`unexpected fetch to ${url}`)
  }
  const provider = new AragProvider({
    resolveBinding: () => ({ baseUrl: 'https://kb.example/kb/x', token: 't' }),
    fetchImpl,
  })
  return { provider, calls }
}

describe('study-design kind (D1-06)', () => {
  it('the resource header reads the derived design, not the labeller', async () => {
    const { provider } = providerWith()
    const resource = await provider.resource(TENANT, 'res-ritux')
    expect(resource?.kind).toBe('cohort-study')
  })

  it('library cards, and the supplement and report beside them', async () => {
    const { provider } = providerWith()
    const page = await provider.catalog(TENANT, { sortField: 'published' })
    const kinds = Object.fromEntries(page.items.map((i) => [i.id, i.kind]))
    expect(kinds['res-ritux']).toBe('cohort-study')
    expect(kinds['res-report']).toBe('report')
    // The supplement is folded into its article's family on browse; listed
    // resources still carry no kind for it.
    const listed = await provider.listResources(TENANT)
    expect(listed.find((r) => r.id === 'res-ritux-s1')?.kind).toBeUndefined()
  })

  it('search results carry the derived kind and a kind filter runs over it, not the index', async () => {
    const { provider, calls } = providerWith()
    const results = await provider.search(TENANT, 'rituximab', { kindIds: ['cohort-study'] })
    expect(results.resources.map((r) => r.id)).toEqual(['res-ritux'])
    expect(results.resources[0]?.kind).toBe('cohort-study')
    const find = calls.find((c) => c.includes('/find'))
    expect(find).not.toContain('classification.labels/kind')
  })

  it('the kind facet counts the derived designs and matches the filter', async () => {
    const { provider, calls } = providerWith()
    const facets = await provider.facets(TENANT, ['kind'])
    expect(facets.kind).toEqual({ 'cohort-study': 1, report: 1 })
    expect(calls.some((c) => c.includes('faceted='))).toBe(false)
    const filtered = await provider.catalog(TENANT, { kindIds: ['cohort-study'] })
    expect(filtered.items.map((i) => i.id)).toEqual(['res-ritux'])
    expect(filtered.total).toBe(1)
    const none = await provider.catalog(TENANT, { kindIds: ['randomised-controlled-trial'] })
    expect(none.items).toEqual([])
  })

  it('a kind filter on another facet counts that facet from the listing too', async () => {
    const { provider } = providerWith()
    const facets = await provider.facets(TENANT, ['format'], [
      '/classification.labels/kind/cohort-study',
    ])
    expect(facets.format).toEqual({ article: 1 })
  })
})
