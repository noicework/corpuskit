import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * Punch-list defect #3: `/api/t/:slug/typeahead?q=abal` returned
 * author-name/fragment noise and never "abalone". `typeahead()` now requires
 * every candidate to actually match the query as a prefix/word, drops hits
 * on hidden/junk resources, and backs the platform's weak short-prefix
 * suggest index with a local prefix match over real, displayable titles and
 * topic labels.
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
  topics: [{ id: 'abalone', label: 'Abalone' }],
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

function providerWith(opts: {
  suggest?: unknown
  catalogResources?: Record<string, unknown>
}): AragProvider {
  const catalogResources = opts.catalogResources ?? {}
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/suggest')) {
        return Promise.resolve(jsonResponse(opts.suggest ?? { entities: {}, paragraphs: {} }))
      }
      if (url.includes('/catalog')) {
        return Promise.resolve(
          jsonResponse({
            resources: catalogResources,
            total: Object.keys(catalogResources).length,
          }),
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
}

const ABALONE_RESOURCE = {
  title: 'Abalone stock assessment for the southern zone',
  metadata: { status: 'PROCESSED' },
}

describe('typeahead (defect #3)', () => {
  it('drops platform entity noise that does not actually match the query', async () => {
    const provider = providerWith({
      suggest: { entities: { entities: [{ value: 'Dr J Smith' }, { value: 'et al' }] } },
    })
    const result = await provider.typeahead(TENANT, 'abal')
    expect(result.entities).not.toContain('Dr J Smith')
  })

  it('falls back to a local prefix match over real titles when the platform suggest index misses', async () => {
    // The platform's /suggest returns nothing useful for this short prefix -
    // the exact bug reported: "abal" never surfaces "abalone".
    const provider = providerWith({
      suggest: { entities: { entities: [] }, paragraphs: { results: [] } },
      catalogResources: { 'res-abalone': ABALONE_RESOURCE },
    })
    const result = await provider.typeahead(TENANT, 'abal')
    expect(result.titles).toContain(ABALONE_RESOURCE.title)
  })

  it('surfaces a matching topic label as an entity chip', async () => {
    const provider = providerWith({
      suggest: { entities: { entities: [] }, paragraphs: { results: [] } },
    })
    const result = await provider.typeahead(TENANT, 'abal')
    expect(result.entities).toContain('Abalone')
  })

  it('drops a platform title hit on a resource hidden by isDisplayableResource (error status)', async () => {
    const provider = providerWith({
      suggest: {
        entities: { entities: [] },
        paragraphs: {
          results: [{ rid: 'res-error', field: 'title', text: 'Abalone error report' }],
        },
      },
      catalogResources: {
        'res-error': { title: 'Abalone error report', metadata: { status: 'ERROR' } },
      },
    })
    const result = await provider.typeahead(TENANT, 'abal')
    expect(result.titles).not.toContain('Abalone error report')
  })

  it('drops a platform title hit that does not actually contain the query', async () => {
    const provider = providerWith({
      suggest: {
        entities: { entities: [] },
        paragraphs: { results: [{ rid: 'res-x', field: 'title', text: 'Prawn farming outlook' }] },
      },
      catalogResources: {
        'res-x': { title: 'Prawn farming outlook', metadata: { status: 'PROCESSED' } },
      },
    })
    const result = await provider.typeahead(TENANT, 'abal')
    expect(result.titles).not.toContain('Prawn farming outlook')
  })

  it('returns nothing for a blank query rather than erroring', async () => {
    const provider = providerWith({})
    const result = await provider.typeahead(TENANT, '   ')
    expect(result).toEqual({ entities: [], titles: [] })
  })
})
