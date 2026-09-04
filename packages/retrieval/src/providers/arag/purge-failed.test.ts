import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider, isPurgeEligible } from './index.ts'

/**
 * Safety-critical coverage for the failed-crawl purge (deletes bot-challenge
 * pages and blank-titled error resources from a knowledge box). This is the
 * only irreversible admin operation in the portal, so the eligibility rule
 * and the dry-run/bounded-delete/failure-tolerance behaviour are covered
 * directly, not just exercised incidentally.
 */

const TENANT: TenantConfig = {
  slug: 'grains',
  branding: {
    productName: 'Dryland Cropping Research Portal',
    organisation: 'Dryland Cropping Research Alliance',
    tagline: 'Grains research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

// -----------------------------------------------------------------------
// isPurgeEligible - the pure eligibility rule.
// -----------------------------------------------------------------------

describe('isPurgeEligible', () => {
  it('flags a known bot-challenge title', () => {
    expect(isPurgeEligible({ title: 'Just a moment...', metadata: { status: 'PROCESSED' } }))
      .toBe(true)
  })

  it('flags an error-status resource with no title at all', () => {
    expect(isPurgeEligible({ title: '', metadata: { status: 'ERROR' } })).toBe(true)
    expect(isPurgeEligible({ metadata: { status: 'ERROR' } })).toBe(true)
  })

  it('does NOT flag an error-status resource that has a real title', () => {
    expect(
      isPurgeEligible({
        title: 'Grain yield trial results 2024',
        metadata: { status: 'ERROR' },
      }),
    ).toBe(false)
  })

  it('does NOT flag a bare hash title, even under error status', () => {
    expect(
      isPurgeEligible({
        title: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        metadata: { status: 'ERROR' },
      }),
    ).toBe(false)
    expect(
      isPurgeEligible({
        title: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        metadata: { status: 'PROCESSED' },
      }),
    ).toBe(false)
  })

  it('does NOT flag a normally-processed resource with a real title', () => {
    expect(
      isPurgeEligible({
        title: 'Nitrogen use efficiency in wheat cropping systems',
        metadata: { status: 'PROCESSED' },
      }),
    ).toBe(false)
  })
})

// -----------------------------------------------------------------------
// purgeFailedResources - catalogue paging, dry run, real run, failure
// tolerance.
// -----------------------------------------------------------------------

/** Fixture catalogue: 3 eligible junk resources, 3 that must never be touched. */
const CATALOGUE_PAGE = {
  resources: {
    'bot-1': { title: 'Just a moment...', metadata: { status: 'PROCESSED' } },
    'bot-2': { title: 'Attention Required', metadata: { status: 'PROCESSED' } },
    'error-blank': { title: '', metadata: { status: 'ERROR' } },
    'error-real': { title: 'Grain yield trial results 2024', metadata: { status: 'ERROR' } },
    'hash-title': {
      title: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      metadata: { status: 'PROCESSED' },
    },
    'real-title': {
      title: 'Nitrogen use efficiency in wheat cropping systems',
      metadata: { status: 'PROCESSED' },
    },
  },
}
const ELIGIBLE_IDS = ['bot-1', 'bot-2', 'error-blank']
const NEVER_DELETE_IDS = ['error-real', 'hash-title', 'real-title']

describe('purgeFailedResources - dry run', () => {
  it('reports the correct scope and never calls DELETE', async () => {
    const deletedIds: string[] = []
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'DELETE') {
        deletedIds.push(url)
        return Promise.resolve(jsonResponse({}))
      }
      expect(url).toContain('/catalog?page_number=0')
      return Promise.resolve(jsonResponse(CATALOGUE_PAGE))
    })

    const result = await provider.purgeFailedResources(TENANT, { dryRun: true })

    expect(result.scanned).toBe(6)
    expect(result.eligible).toBe(3)
    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(0)
    expect(deletedIds).toEqual([])
    // Sample must be scoped to the eligible set, never the excluded ones.
    for (const id of NEVER_DELETE_IDS) {
      expect(result.sampleTitles.some((s) => s.includes(id))).toBe(false)
    }
    expect(result.sampleTitles.length).toBe(3)
  })
})

describe('purgeFailedResources - real run', () => {
  it('deletes exactly the eligible set and nothing else', async () => {
    const deletedIds: string[] = []
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'DELETE') {
        const id = url.split('/resource/')[1]
        deletedIds.push(id ?? '')
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse(CATALOGUE_PAGE))
    })

    const result = await provider.purgeFailedResources(TENANT, { dryRun: false })

    expect(result.eligible).toBe(3)
    expect(result.deleted).toBe(3)
    expect(result.failed).toBe(0)
    expect(deletedIds.sort()).toEqual([...ELIGIBLE_IDS].sort())
    for (const id of NEVER_DELETE_IDS) {
      expect(deletedIds).not.toContain(id)
    }
  })

  it('one delete failure is logged and counted but does not abort the rest', async () => {
    const deletedIds: string[] = []
    const originalError = console.error
    console.error = () => {} // expected failure log - keep test output clean
    try {
      const provider = providerWithFetch((input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (method === 'DELETE') {
          const id = url.split('/resource/')[1] ?? ''
          deletedIds.push(id)
          if (id === 'bot-2') {
            return Promise.resolve(jsonResponse({ message: 'boom' }, 500))
          }
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return Promise.resolve(jsonResponse(CATALOGUE_PAGE))
      })

      const result = await provider.purgeFailedResources(TENANT, { dryRun: false })

      // All three eligible deletes were attempted despite the one failure.
      expect(deletedIds.sort()).toEqual([...ELIGIBLE_IDS].sort())
      expect(result.eligible).toBe(3)
      expect(result.deleted).toBe(2)
      expect(result.failed).toBe(1)
    } finally {
      console.error = originalError
    }
  })
})

describe('purgeFailedResources - catalogue paging', () => {
  it('pages the entire catalogue, not just one slice', async () => {
    const pageRequests: string[] = []
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
      pageRequests.push(url)
      const pageMatch = url.match(/page_number=(\d+)/)
      const page = pageMatch ? Number(pageMatch[1]) : 0
      // Full page (200) on page 0, a short final page on page 1 to end paging.
      if (page === 0) {
        const resources: Record<string, unknown> = {}
        for (let i = 0; i < 200; i++) {
          resources[`filler-${i}`] = {
            title: 'A real research title',
            metadata: { status: 'PROCESSED' },
          }
        }
        return Promise.resolve(jsonResponse({ resources }))
      }
      return Promise.resolve(
        jsonResponse({
          resources: {
            'bot-last': { title: 'Just a moment...', metadata: { status: 'PROCESSED' } },
          },
        }),
      )
    })

    const result = await provider.purgeFailedResources(TENANT, { dryRun: true })

    expect(pageRequests.length).toBe(2)
    expect(result.scanned).toBe(201)
    expect(result.eligible).toBe(1)
  })
})
