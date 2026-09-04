import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'
// Type-only: erased at compile time, so it does not load stores.ts before
// DATA_DIR is set below (which is what the dynamic imports exist to avoid).
import type { Source } from './stores.ts'

// ---------------------------------------------------------------------------
// Website sources: register a site once, sync it on demand, and let the daily
// job pick up whatever was published since. These tests cover the parts that
// make that demonstrable rather than merely present:
//
//  - a run is BOUNDED by the source's own page cap (a first sync of a large
//    site used to pull the global 60-page cap in one go);
//  - the API never ships the internal `synced` url ledger to the browser, and
//    always reports a running item count;
//  - a failing sync is RECORDED against the source, so a scheduled run that
//    fails at 3am is still visible in Manage the next morning (it used to be
//    swallowed whole, leaving a stale "last synced" time and no explanation);
//  - a read-only knowledge box (every write 403s while retrieval keeps
//    working) is named as such instead of surfacing as `internal_error`;
//  - a site that cannot be crawled is refused at registration time, not
//    silently accepted and left to fail on the daily schedule forever.
//
// As in stores.test.ts, DATA_DIR is read once at stores.ts module load, so it
// must be set before that module is imported - hence the dynamic imports.
// ---------------------------------------------------------------------------

const dir = await Deno.makeTempDir()
Deno.env.set('DATA_DIR', dir)

const { buildApp } = await import('./app.ts')
const { pagesPerRun, recordSyncFailure, SYNC_CAP, syncSource } = await import('./scheduler.ts')
const { SourceStore } = await import('./stores.ts')
const { TenantStore } = await import('./tenants.ts')

const freshTenants = () =>
  new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/tenants.json` })

const PASSCODE = 'test-passcode'
const config = { slug: 'marine' } as TenantConfig

/** A page that survives extractMainContent's 80-word minimum. */
const pageHtml = (title: string) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${
    'fisheries stock assessment evidence '.repeat(40)
  }</p></main></body></html>`

/** An index page linking to `count` same-origin article pages. */
const indexHtml = (count: number) =>
  `<html><body>${
    Array.from({ length: count }, (_, i) => `<a href="/article-${i}">Article ${i}</a>`).join('')
  }</body></html>`

/**
 * Stubs global fetch for the crawler's outbound calls only. Returns a restore
 * function; every stub must be restored or later tests inherit it.
 */
function stubFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return Promise.resolve(handler(url))
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } })

/** Counts createText calls; enough of AragProvider's shape for syncSource. */
function fakeManagement(onCreate?: () => void): AragProvider {
  return {
    createText: async () => {
      onCreate?.()
      return { id: crypto.randomUUID() }
    },
    createLink: async () => ({ id: crypto.randomUUID() }),
  } as unknown as AragProvider
}

describe('pagesPerRun - the per-source ceiling on one sync run', () => {
  it('falls back to the server default when the source sets no cap', () => {
    expect(pagesPerRun({})).toBe(SYNC_CAP)
    expect(pagesPerRun({ maxPages: undefined })).toBe(SYNC_CAP)
  })

  it('honours a source cap below the default', () => {
    expect(pagesPerRun({ maxPages: 5 })).toBe(5)
  })

  it('clamps a cap above the hard ceiling rather than trusting it', () => {
    expect(pagesPerRun({ maxPages: 100_000 })).toBe(200)
  })

  it('treats a nonsensical cap as unset instead of ingesting nothing forever', () => {
    expect(pagesPerRun({ maxPages: 0 })).toBe(SYNC_CAP)
    expect(pagesPerRun({ maxPages: -3 })).toBe(SYNC_CAP)
  })
})

describe('SourceStore.summaries - what the admin API is allowed to expose', () => {
  it('omits the synced url ledger and reports a running item count', () => {
    const store = new SourceStore()
    const source = store.add('summaries', 'https://example.org/news', true, 10)
    store.update('summaries', source.id, {
      synced: ['https://example.org/a', 'https://example.org/b'],
      itemCount: 2,
    })

    const [summary] = store.summaries('summaries')

    expect(summary).toBeDefined()
    // The ledger runs to thousands of urls; the browser only needs the count.
    expect('synced' in summary!).toBe(false)
    expect(summary!.itemCount).toBe(2)
    expect(summary!.maxPages).toBe(10)
  })

  it('counts a source registered before itemCount existed from its ledger', () => {
    const store = new SourceStore()
    const source = store.add('legacy', 'https://example.org/legacy', true)
    // Simulate a pre-upgrade record: a ledger, but no itemCount field.
    store.update('legacy', source.id, {
      synced: ['https://example.org/x', 'https://example.org/y', 'https://example.org/z'],
      itemCount: undefined,
    })

    expect(store.summaries('legacy')[0]?.itemCount).toBe(3)
  })
})

describe('syncSource', () => {
  it('ingests at most the source page cap, leaving the rest for the next run', async () => {
    const restore = stubFetch((url) =>
      url.endsWith('/news') ? html(indexHtml(20)) : html(pageHtml('Article'))
    )
    try {
      const sources = new SourceStore()
      const source = sources.add('cap', 'https://example.org/news', true, 3)
      let created = 0

      const result = await syncSource(
        fakeManagement(() => created++),
        sources,
        { ...config, slug: 'cap' },
        source,
        () => {},
      )

      // 20 pages were discovered; the cap is what bounds the run.
      expect(result.added).toBe(3)
      expect(created).toBe(3)
      const summary = sources.summaries('cap')[0]
      expect(summary?.itemCount).toBe(3)
      expect(summary?.lastStatus).toBe('ok')
    } finally {
      restore()
    }
  })

  it('never re-ingests a page it has already taken from the source', async () => {
    const restore = stubFetch((url) =>
      url.endsWith('/news') ? html(indexHtml(4)) : html(pageHtml('Article'))
    )
    try {
      const sources = new SourceStore()
      const source = sources.add('dedupe', 'https://example.org/news', true, 10)
      let created = 0
      const management = fakeManagement(() => created++)
      const tenant = { ...config, slug: 'dedupe' }

      const first = await syncSource(management, sources, tenant, source, () => {})
      // Re-read: the second run must start from the ledger the first wrote.
      const reread = sources.find('dedupe', source.id) as Source
      const second = await syncSource(management, sources, tenant, reread, () => {})

      expect(first.added).toBe(4)
      expect(second.added).toBe(0)
      expect(created).toBe(4)
      // The running total counts pages once, not once per run.
      expect(sources.summaries('dedupe')[0]?.itemCount).toBe(4)
    } finally {
      restore()
    }
  })

  it('rejects a bot-walled page instead of handing the blocked url to the platform crawler', async () => {
    const restore = stubFetch((url) =>
      url.endsWith('/news') ? html(indexHtml(2)) : html(
        '<html><head><title>Just a moment...</title></head><body>Cloudflare</body></html>',
        403,
      )
    )
    try {
      const sources = new SourceStore()
      const source = sources.add('walled', 'https://example.org/news', true, 10)
      let createdText = 0
      let createdLink = 0
      const management = {
        createText: async () => {
          createdText++
          return { id: 'x' }
        },
        createLink: async () => {
          createdLink++
          return { id: 'x' }
        },
      } as unknown as AragProvider

      const labels: string[] = []
      const result = await syncSource(
        management,
        sources,
        { ...config, slug: 'walled' },
        source,
        (label) => void labels.push(label),
      )

      expect(result.added).toBe(0)
      expect(createdText).toBe(0)
      // The old behaviour fell through to createLink, which asks the platform
      // to crawl the same blocked url and leaves an empty junk resource.
      expect(createdLink).toBe(0)
      expect(labels.some((l) => /bot challenge/i.test(l))).toBe(true)
    } finally {
      restore()
    }
  })

  it('rejects a challenge page that answers 200 with enough prose to look like content', async () => {
    // Verified live on a bot-walled research site: its interstitial is served
    // intermittently, sometimes with 200, and carries ~139 words of visible
    // copy - comfortably past extractMainContent's 80-word floor. Checking
    // the challenge signatures only as extraction's FALLBACK let it through,
    // and the platform crawler then stored it as a resource titled
    // "Just a moment...".
    const challenge = `<html><head><title>Just a moment...</title></head><body><main>` +
      `<h1>www.example.org</h1><h2>Performing security verification</h2>` +
      `<p>This website uses a security service to protect against malicious bots. ${
        'This page is displayed while the website verifies you are not a bot. '.repeat(8)
      }</p><p>Enable JavaScript and cookies to continue. Ray ID: a338ba13df951713</p>` +
      `</main></body></html>`
    const restore = stubFetch((url) => url.endsWith('/news') ? html(indexHtml(2)) : html(challenge))
    try {
      const sources = new SourceStore()
      const source = sources.add('challenge200', 'https://example.org/news', true, 10)
      let createdText = 0
      const management = {
        createText: async () => {
          createdText++
          return { id: 'x' }
        },
        createLink: async () => ({ id: 'x' }),
      } as unknown as AragProvider

      const result = await syncSource(
        management,
        sources,
        { ...config, slug: 'challenge200' },
        source,
        () => {},
      )

      expect(result.added).toBe(0)
      expect(createdText).toBe(0)
    } finally {
      restore()
    }
  })

  it('skips a page it cannot read rather than handing it to the platform crawler', async () => {
    // The platform crawler has no bot-wall check of its own, so using it as a
    // fallback quietly reintroduces exactly the junk this function screens for.
    const restore = stubFetch((url) =>
      url.endsWith('/news')
        ? html(indexHtml(3))
        : html('<html><body><p>too short</p></body></html>')
    )
    try {
      const sources = new SourceStore()
      const source = sources.add('thin', 'https://example.org/news', true, 10)
      let createdLink = 0
      const management = {
        createText: async () => ({ id: 'x' }),
        createLink: async () => {
          createdLink++
          return { id: 'x' }
        },
      } as unknown as AragProvider

      const labels: string[] = []
      const result = await syncSource(
        management,
        sources,
        { ...config, slug: 'thin' },
        source,
        (label) => void labels.push(label),
      )

      expect(result.added).toBe(0)
      expect(createdLink).toBe(0)
      expect(labels.some((l) => /no readable content/i.test(l))).toBe(true)
      // Recorded as seen, so one unreadable url cannot starve every later
      // page of every future run by permanently occupying the page cap.
      expect(sources.find('thin', source.id)?.synced?.length).toBe(3)
    } finally {
      restore()
    }
  })

  it('stops on a read-only knowledge box and names the cause', async () => {
    const restore = stubFetch((url) =>
      url.endsWith('/news') ? html(indexHtml(10)) : html(pageHtml('Article'))
    )
    try {
      const sources = new SourceStore()
      const source = sources.add('readonly', 'https://example.org/news', true, 10)
      let attempts = 0
      const management = {
        createText: () => {
          attempts++
          throw new AragApiError(403, 'https://kb.example/resources', '{"detail":"Forbidden"}')
        },
        createLink: async () => ({ id: 'x' }),
      } as unknown as AragProvider

      await expect(
        syncSource(management, sources, { ...config, slug: 'readonly' }, source, () => {}),
      ).rejects.toThrow(/service-account token can read this box but not add to it/)
      // One attempt, not ten - every page would fail identically.
      expect(attempts).toBe(1)
    } finally {
      restore()
    }
  })
})

describe('recordSyncFailure', () => {
  it('leaves the reason on the source so a failed scheduled run is still visible', () => {
    const sources = new SourceStore()
    const source = sources.add('failing', 'https://example.org/gone', true)

    recordSyncFailure(sources, 'failing', source, new Error('The site could not be reached.'))

    const summary = sources.summaries('failing')[0]
    expect(summary?.lastStatus).toBe('error')
    expect(summary?.lastError).toBe('The site could not be reached.')
    expect(summary?.lastSync).not.toBeNull()
  })
})

describe('admin source routes', () => {
  const app = () =>
    buildApp({
      provider: {
        search: async () => ({ query: '', resources: [], relatedQuestions: [] }),
      } as never,
      tenants: freshTenants(),
      adminPasscode: PASSCODE,
    })

  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-passcode': PASSCODE },
    body: JSON.stringify(body),
  })

  it('refuses a site that cannot be crawled, rather than registering it to fail nightly', async () => {
    const restore = stubFetch(() =>
      html('<html><head><title>Just a moment...</title></head><body>Cloudflare</body></html>', 403)
    )
    try {
      const response = await app().request(
        '/api/admin/t/marine/sources',
        post({ url: 'https://blocked.example/news' }),
      )
      const body = await response.json() as { error: string; message: string }

      expect(response.status).toBe(400)
      expect(body.error).toBe('source_unreachable')
      expect(body.message).toMatch(/bot challenge/i)
    } finally {
      restore()
    }
  })

  it('reports what discovery found when a source is accepted', async () => {
    const restore = stubFetch(() => html(indexHtml(7)))
    try {
      const response = await app().request(
        '/api/admin/t/marine/sources',
        post({ url: 'https://good.example/news', maxPages: 5 }),
      )
      const body = await response.json() as {
        discovered: number
        discoveredVia: string
        maxPages: number
        itemCount: number
        synced?: unknown
      }

      expect(response.status).toBe(200)
      expect(body.discovered).toBe(7)
      expect(body.discoveredVia).toBe('page')
      expect(body.maxPages).toBe(5)
      expect(body.itemCount).toBe(0)
      expect(body.synced).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('reports a duplicate as a duplicate instead of silently confirming it as added', async () => {
    const restore = stubFetch(() => html(indexHtml(3)))
    try {
      const instance = app()
      const body = post({ url: 'https://dupe.example/news' })
      expect((await instance.request('/api/admin/t/marine/sources', body)).status).toBe(200)

      const second = await instance.request(
        '/api/admin/t/marine/sources',
        post({ url: 'https://dupe.example/news' }),
      )

      expect(second.status).toBe(409)
      expect((await second.json() as { error: string }).error).toBe('duplicate_source')
    } finally {
      restore()
    }
  })

  it('toggles daily auto-sync and the page cap over PATCH', async () => {
    const restore = stubFetch(() => html(indexHtml(3)))
    try {
      const instance = app()
      const created = await (await instance.request(
        '/api/admin/t/marine/sources',
        post({ url: 'https://patch.example/news' }),
      )).json() as { id: string; auto: boolean }
      expect(created.auto).toBe(true)

      const response = await instance.request(`/api/admin/t/marine/sources/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-admin-passcode': PASSCODE },
        body: JSON.stringify({ auto: false, maxPages: 50 }),
      })
      const patched = await response.json() as { auto: boolean; maxPages: number }

      expect(response.status).toBe(200)
      expect(patched.auto).toBe(false)
      expect(patched.maxPages).toBe(50)
    } finally {
      restore()
    }
  })

  it('rejects a page cap outside the allowed range', async () => {
    const response = await app().request(
      '/api/admin/t/marine/sources',
      post({ url: 'https://range.example/news', maxPages: 5000 }),
    )
    expect(response.status).toBe(400)
  })
})
