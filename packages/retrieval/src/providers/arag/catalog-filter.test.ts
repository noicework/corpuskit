import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * Punch-list defect #1 (catalog browse/filter returning nothing because the
 * bare `/catalog?query=` does a title-substring match instead of real
 * retrieval) and defect #2 (failed/junk ingestions leaking into catalog,
 * library and search). These exercise `catalog()`, `search()` and
 * `listResources()` against a mocked `/find`/`/catalog` the same way
 * ask-structured.test.ts mocks `/ask`.
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const GOOD_RESOURCE = {
  title: 'Abalone stock management in the southern zone',
  metadata: { status: 'PROCESSED' },
  usermetadata: { classifications: [{ labelset: 'kind', label: 'report' }] },
  fields: {
    a: { paragraphs: { p1: { score: 0.72, text: 'Abalone stock levels remain stable.' } } },
  },
}

const ERROR_RESOURCE = {
  title: 'Some report that failed to ingest',
  metadata: { status: 'ERROR' },
  fields: { a: { paragraphs: { p1: { score: 0.9, text: 'irrelevant' } } } },
}

const HASH_TITLE_RESOURCE = {
  title: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  metadata: { status: 'PROCESSED' },
  fields: { a: { paragraphs: { p1: { score: 0.9, text: 'irrelevant' } } } },
}

/** A fetch double: /find returns the given resources map for any query; /catalog
 * (unfiltered browse) returns the given catalog resources map; /suggest is unused here. */
function fetchStub(
  findResources: Record<string, unknown>,
  catalogResources: Record<string, unknown> = {},
): typeof fetch {
  return (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/find')) return Promise.resolve(jsonResponse({ resources: findResources }))
    if (url.includes('/catalog')) {
      return Promise.resolve(
        jsonResponse({ resources: catalogResources, total: Object.keys(catalogResources).length }),
      )
    }
    throw new Error(`unexpected fetch to ${url}`)
  }
}

function providerWith(
  findResources: Record<string, unknown>,
  catalogResources: Record<string, unknown> = {},
): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: fetchStub(findResources, catalogResources),
  })
}

describe('catalog() filtered-query fix (defect #1)', () => {
  it('a filtered catalog query returns the document search finds for the same string', async () => {
    const provider = providerWith({ 'res-abalone': GOOD_RESOURCE })
    const catalogResult = await provider.catalog(TENANT, { query: 'abalone', kindIds: ['report'] })
    expect(catalogResult.items.map((i) => i.id)).toEqual(['res-abalone'])
    expect(catalogResult.items[0]?.title).toBe(GOOD_RESOURCE.title)
  })

  it('parity: catalog(query) and search(query) surface the same resource id', async () => {
    const provider = providerWith({ 'res-abalone': GOOD_RESOURCE })
    const [catalogResult, searchResult] = await Promise.all([
      provider.catalog(TENANT, { query: 'abalone' }),
      provider.search(TENANT, 'abalone'),
    ])
    expect(catalogResult.items.map((i) => i.id)).toEqual(searchResult.resources.map((r) => r.id))
    expect(catalogResult.items.map((i) => i.id)).toEqual(['res-abalone'])
  })

  it('unfiltered browse (no query) still pages the plain /catalog endpoint', async () => {
    const provider = providerWith({}, {
      'res-abalone': { ...GOOD_RESOURCE, created: '2024-01-01' },
    })
    const result = await provider.catalog(TENANT, {})
    expect(result.items.map((i) => i.id)).toEqual(['res-abalone'])
  })
})

describe('junk/failed-ingest filtering (defect #2)', () => {
  it('catalog(query) hides an ERROR-status resource and a raw-hash-titled resource', async () => {
    const provider = providerWith({
      'res-abalone': GOOD_RESOURCE,
      'res-error': ERROR_RESOURCE,
      'res-hash': HASH_TITLE_RESOURCE,
    })
    const result = await provider.catalog(TENANT, { query: 'abalone' })
    expect(result.items.map((i) => i.id)).toEqual(['res-abalone'])
  })

  it('search() hides the same junk resources', async () => {
    const provider = providerWith({
      'res-abalone': GOOD_RESOURCE,
      'res-error': ERROR_RESOURCE,
      'res-hash': HASH_TITLE_RESOURCE,
    })
    const result = await provider.search(TENANT, 'abalone')
    expect(result.resources.map((r) => r.id)).toEqual(['res-abalone'])
  })

  it('unfiltered catalog browse hides junk resources too', async () => {
    const provider = providerWith({}, {
      'res-abalone': { ...GOOD_RESOURCE, created: '2024-01-01' },
      'res-error': { ...ERROR_RESOURCE, created: '2024-01-01' },
      'res-hash': { ...HASH_TITLE_RESOURCE, created: '2024-01-01' },
    })
    const result = await provider.catalog(TENANT, {})
    expect(result.items.map((i) => i.id)).toEqual(['res-abalone'])
  })

  it('listResources() (backs the public /resources route) hides junk resources', async () => {
    const provider = providerWith({}, {
      'res-abalone': { ...GOOD_RESOURCE, created: '2024-01-01' },
      'res-error': { ...ERROR_RESOURCE, created: '2024-01-01' },
      'res-hash': { ...HASH_TITLE_RESOURCE, created: '2024-01-01' },
    })
    const result = await provider.listResources(TENANT)
    expect(result.map((r) => r.id)).toEqual(['res-abalone'])
  })

  it('keeps the recovered 1995-167 resource and drops its ERROR-status predecessor', async () => {
    const recovered = {
      ...GOOD_RESOURCE,
      title: '1995-167-DLD.pdf',
    }
    const failedVision = {
      ...recovered,
      metadata: { status: 'ERROR' },
    }
    const provider = providerWith({}, {
      'res-failed-vision': failedVision,
      'res-recovered': recovered,
    })

    const result = await provider.catalog(TENANT, {})
    expect(result.items.map((item) => item.id)).toEqual(['res-recovered'])
  })
})

describe('multi-part resource cards (issue #47)', () => {
  const main = {
    ...GOOD_RESOURCE,
    title: '2017-215-DLD.pdf',
    fields: {
      a: { paragraphs: { p1: { score: 0.62, text: 'The main project report.' } } },
    },
  }
  const appendix1 = {
    ...GOOD_RESOURCE,
    title: '2017-215-App-1',
    fields: {
      a: { paragraphs: { p1: { score: 0.71, text: 'Methods in appendix one.' } } },
    },
  }
  const appendix2 = {
    ...GOOD_RESOURCE,
    title: '2017-215-App-2',
    fields: {
      a: { paragraphs: { p1: { score: 0.96, text: 'Findings unique to appendix two.' } } },
    },
  }

  it('keeps one canonical card in an unfiltered browse response', async () => {
    const provider = providerWith({}, {
      'res-app-2': appendix2,
      'res-main': main,
      'res-app-1': appendix1,
    })

    const result = await provider.catalog(TENANT, {})
    expect(result.items.map((item) => item.id)).toEqual(['res-main'])
  })

  it('keeps the highest-scoring part reachable in search and filtered browse', async () => {
    const provider = providerWith({
      'res-main': main,
      'res-app-1': appendix1,
      'res-app-2': appendix2,
    })

    const [searchResult, catalogResult] = await Promise.all([
      provider.search(TENANT, 'appendix two findings'),
      provider.catalog(TENANT, { query: 'appendix two findings' }),
    ])
    expect(searchResult.resources.map((resource) => resource.id)).toEqual(['res-app-2'])
    expect(catalogResult.items.map((item) => item.id)).toEqual(['res-app-2'])
  })
})
