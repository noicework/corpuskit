import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * Explore page empty state fix: topic rows must come from the box's
 * classification INDEX (facets + a topic-filtered `/catalog` query), not
 * from a listed resource's own `topicIds` - the DA classifier's labels
 * don't reliably land in `usermetadata.classifications`, so that field is
 * often `[]` even on a resource genuinely filed under a topic (see
 * `AragProvider.topicResources`'s doc comment and the final report).
 * `catalog-filter.test.ts` covers the sibling `catalog()`/`search()` fixes;
 * these cover the new `topicResources()` method and `toSummary`'s defensive
 * read of platform-computed classifications.
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

function providerWithFetch(fetchImpl: typeof fetch): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl,
  })
}

describe('topicResources()', () => {
  it('filters the catalogue by the classification index path for the given topic', async () => {
    let requestedUrl = ''
    const provider = providerWithFetch((input) => {
      requestedUrl = typeof input === 'string' ? input : input.toString()
      return Promise.resolve(jsonResponse({
        resources: {
          'res-1': {
            title: 'Carp control in the Murray-Darling',
            metadata: { status: 'PROCESSED' },
          },
        },
      }))
    })

    const items = await provider.topicResources(TENANT, 'carp-control', 5)

    expect(requestedUrl).toContain('/catalog?')
    expect(requestedUrl).toContain(
      encodeURIComponent('/classification.labels/topic/carp-control'),
    )
    // Over-fetches rather than asking for exactly `limit`: documentation and
    // junk are filtered out after the fetch, so an exact page can filter to
    // nothing. See the all-documentation case below.
    expect(requestedUrl).toContain('page_size=30')
    expect(items.map((r) => r.id)).toEqual(['res-1'])
    expect(items[0]?.title).toBe('Carp control in the Murray-Darling')
  })

  it('hides junk (failed-ingest) resources from a topic row, same as catalog()', async () => {
    const provider = providerWithFetch(() =>
      Promise.resolve(jsonResponse({
        resources: {
          'res-good': {
            title: 'Governance reporting cycle',
            metadata: { status: 'PROCESSED' },
          },
          'res-error': { title: 'Failed ingest', metadata: { status: 'ERROR' } },
        },
      }))
    )

    const items = await provider.topicResources(TENANT, 'governance-reporting')
    expect(items.map((r) => r.id)).toEqual(['res-good'])
  })

  it('shows one primary card for a report and its appendix resources', async () => {
    const provider = providerWithFetch(() =>
      Promise.resolve(jsonResponse({
        resources: {
          'res-app-2': { title: '2017-215-App-2', metadata: { status: 'PROCESSED' } },
          'res-main': { title: '2017-215-DLD.pdf', metadata: { status: 'PROCESSED' } },
          'res-app-1': { title: '2017-215-App-1', metadata: { status: 'PROCESSED' } },
        },
      }))
    )

    const items = await provider.topicResources(TENANT, 'research-development')
    expect(items.map((resource) => resource.id)).toEqual(['res-main'])
  })

  it('still returns real resources when the newest page is all documentation', async () => {
    // One showcase box sorts its own help articles newest-first, so asking for
    // exactly `limit` returned a page of documentation that filtered to zero
    // and the topic row rendered empty on a corpus of 842 resources.
    const docs = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`doc-${i}`, {
        title: `Getting started ${i}`,
        icon: 'text/html',
        metadata: { status: 'PROCESSED' },
        usermetadata: {
          classifications: [{ labelset: 'content-type', label: 'documentation' }],
        },
      }]),
    )
    const real = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`real-${i}`, {
        title: `GGL260${i}-003FAX.txt`,
        icon: 'text/plain',
        metadata: { status: 'PROCESSED' },
      }]),
    )
    const provider = providerWithFetch(() =>
      Promise.resolve(jsonResponse({ resources: { ...docs, ...real } }))
    )

    const items = await provider.topicResources(TENANT, 'research-development', 3)

    expect(items.length).toBe(3)
    expect(items.every((item: { title: string }) => !item.title.startsWith('Getting started')))
      .toBe(true)
  })

  it('an empty index (no resources filed under the topic) resolves to an empty row, not an error', async () => {
    const provider = providerWithFetch(() => Promise.resolve(jsonResponse({ resources: {} })))
    const items = await provider.topicResources(TENANT, 'standards')
    expect(items).toEqual([])
  })
})

describe('computed classification labels (defect #3 - toSummary)', () => {
  it('a platform-computed classification with no usermetadata still maps into topicIds/kind', async () => {
    const provider = providerWithFetch(() =>
      Promise.resolve(jsonResponse({
        title: 'Stakeholder engagement outcomes 2025',
        metadata: { status: 'PROCESSED' },
        // No usermetadata.classifications at all - only the DA classifier's
        // computed output.
        computedmetadata: {
          field_classifications: [
            {
              classifications: [
                { labelset: 'topic', label: 'stakeholder-engagement' },
                { labelset: 'kind', label: 'report' },
              ],
            },
          ],
        },
      }))
    )

    const resource = await provider.resource(TENANT, 'res-1')
    expect(resource?.topicIds).toEqual(['stakeholder-engagement'])
    expect(resource?.kind).toBe('report')
  })

  it('user-applied and computed labels for the same labelset are merged and deduplicated', async () => {
    const provider = providerWithFetch(() =>
      Promise.resolve(jsonResponse({
        title: 'International connections review',
        metadata: { status: 'PROCESSED' },
        usermetadata: {
          classifications: [{ labelset: 'topic', label: 'international-connections' }],
        },
        computedmetadata: {
          field_classifications: [
            {
              classifications: [
                { labelset: 'topic', label: 'international-connections' },
                { labelset: 'topic', label: 'research-development' },
              ],
            },
          ],
        },
      }))
    )

    const resource = await provider.resource(TENANT, 'res-1')
    expect([...(resource?.topicIds ?? [])].sort()).toEqual([
      'international-connections',
      'research-development',
    ])
  })

  it('a computed label the user has since removed (cancelled_by_user) is excluded', async () => {
    const provider = providerWithFetch(() =>
      Promise.resolve(jsonResponse({
        title: 'Some resource',
        metadata: { status: 'PROCESSED' },
        computedmetadata: {
          field_classifications: [
            {
              classifications: [
                { labelset: 'topic', label: 'standards', cancelled_by_user: true },
              ],
            },
          ],
        },
      }))
    )

    const resource = await provider.resource(TENANT, 'res-1')
    expect(resource?.topicIds).toEqual([])
  })

  it('a resource with no classifications anywhere gets empty topicIds, not a crash', async () => {
    const provider = providerWithFetch(() =>
      Promise.resolve(
        jsonResponse({ title: 'Untagged resource', metadata: { status: 'PROCESSED' } }),
      )
    )
    const resource = await provider.resource(TENANT, 'res-1')
    expect(resource?.topicIds).toEqual([])
  })
})
