import { localOwnedStores } from '../apps/api/src/local-owned-stores.ts'
import { EnrichmentStore } from '../apps/api/src/enrichments.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import { PublicHttpClient } from '../apps/api/src/public-http.ts'
import { checkLink } from '../apps/api/src/link-health.ts'
import { LinkHealthStore } from '../apps/api/src/link-health-store.ts'
import { SourceStore } from '../apps/api/src/stores.ts'
import { runAutoSyncs, runSystemMaintenance, syncSource } from '../apps/api/src/scheduler.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

const origin = 'https://fixture.example.test'
function fixture() {
  const calls: { path: string; method: string; at: number; conditional: string | null }[] = []
  let version = 1
  let recovered = false
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url)
    calls.push({
      path: url.pathname,
      method: request.method,
      at: Date.now(),
      conditional: request.headers.get('if-none-match'),
    })
    if (url.pathname.endsWith('/catalog')) {
      const published = {
        title: 'Published research',
        metadata: { status: 'PROCESSED' },
        origin: { url: origin + '/gone' },
      }
      const draft = { ...published, title: 'Draft research', hidden: true }
      const failed = { ...published, title: 'Incomplete research', metadata: { status: 'ERROR' } }
      return Response.json({
        resources: url.searchParams.get('hidden') === 'false'
          ? { published }
          : { published, draft, failed },
      })
    }
    if (url.pathname === '/redirect-private') {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
    }
    if (url.pathname === '/redirect-dns') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://private.example.test/secret' },
      })
    }
    if (url.pathname === '/loop') {
      return new Response(null, { status: 302, headers: { location: '/loop' } })
    }
    if (url.pathname === '/redirect') {
      return new Response(null, { status: 302, headers: { location: '/fallback' } })
    }
    if (url.pathname === '/fallback') {
      return new Response(null, { status: request.method === 'HEAD' ? 405 : 200 })
    }
    if (url.pathname === '/gone') return new Response(null, { status: recovered ? 200 : 410 })
    if (url.pathname === '/restricted') return new Response(null, { status: 403 })
    if (url.pathname === '/busy') return new Response(null, { status: 503 })
    if (url.pathname === '/slow') {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return new Response(null)
    }
    if (url.pathname === '/news') {
      return new Response('<a href="/article">Research</a><a href="/hash">Hash page</a>', {
        headers: { 'content-type': 'text/html' },
      })
    }
    const etag = `"version-${version}"`
    if (url.pathname === '/article' && request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } })
    }
    const body = `<html><title>Research findings</title><main><p>${
      ('Version ' + version + ' fisheries research evidence ').repeat(45)
    }</p></main></html>`
    return new Response(body, {
      headers: { 'content-type': 'text/html', ...(url.pathname === '/article' ? { etag } : {}) },
    })
  })
  const local = `http://127.0.0.1:${server.addr.port}`
  const transport: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin) throw new Error('Fixture transport refused a non-fixture address')
    return fetch(local + url.pathname + url.search, init)
  }
  const client = new PublicHttpClient({
    resolve: async (host) => host === 'fixture.example.test' ? ['93.184.216.34'] : ['10.0.0.1'],
    fetch: transport,
    intervalMs: 20,
  })
  return {
    client,
    transport,
    local,
    calls,
    change: () => version++,
    recover: () => recovered = true,
    close: () => server.shutdown(),
  }
}

class WebsiteProvider extends DoubleProvider {
  bodies = new Map<string, string>()
  constructor() {
    super()
    this.resources = [
      {
        id: 'gone',
        title: 'Fisheries research findings',
        summary: 'Findings from a research study.',
        type: 'web',
        topicIds: ['research'],
        keyFacts: [],
        originUrl: `${origin}/gone`,
      },
      {
        id: 'busy',
        title: 'Soil research findings',
        summary: 'Findings from a research study.',
        type: 'web',
        topicIds: [],
        keyFacts: [],
        originUrl: `${origin}/busy`,
      },
    ]
  }
  curate(id: string) {
    const row = this.resources.find((row) => row.id === id)!
    row.title = 'Curated research findings'
    row.topicIds = ['curated-research']
    row.hidden = true
  }
  async counters() {
    return { resources: this.resources.length, paragraphs: 2, sentences: 4, indexMb: 1 }
  }
  async resourceCount() {
    return this.resources.length
  }
  async recentResources() {
    return []
  }
  async createText(
    _config: TenantConfig,
    input: { title: string; body: string; originUrl?: string; hidden?: boolean },
  ) {
    const id = crypto.randomUUID()
    this.resources.push({
      id,
      title: input.title,
      summary: 'Findings from a research study.',
      type: 'web',
      topicIds: [],
      keyFacts: [],
      originUrl: input.originUrl,
      ...(input.hidden ? { hidden: true as const } : {}),
    })
    this.bodies.set(id, input.body)
    return { id }
  }
  async resourceFull(config: TenantConfig, id: string) {
    const row = await this.resource(config, id)
    return row
      ? { title: row.title, kind: 'text', originUrl: row.originUrl, text: this.bodies.get(id) }
      : null
  }
  async patchResourceClassifications(
    _config: TenantConfig,
    id: string,
    labels: { labelset: string; label: string }[],
  ) {
    const row = this.resources.find((r) => r.id === id)!
    row.topicIds = labels.filter((label) => label.labelset === 'topic').map((label) => label.label)
  }
  async deleteResource(_config: TenantConfig, id: string) {
    this.resources = this.resources.filter((row) => row.id !== id)
    this.bodies.delete(id)
  }
}

Deno.test('management origin enumeration includes drafts and failed ingests without leaking them into the reader cache', async () => {
  const site = fixture()
  try {
    const provider = new AragProvider({
      resolveBinding: () => ({ baseUrl: origin + '/kb/fixture', token: 'fixture-token' }),
      fetchImpl: site.transport,
    })
    const config = {
      slug: 'fixture',
      suggestedQuestions: [],
      topics: [],
    } as unknown as TenantConfig
    const admin = await provider.listResources(config, { includeHidden: true })
    expect(admin.map((row) => row.id).sort()).toEqual(['draft', 'failed', 'published'])
    expect(admin.find((row) => row.id === 'draft')?.hidden).toBe(true)
    expect((await provider.listResources(config)).map((row) => row.id)).toEqual(['published'])
    const abort = new AbortController()
    abort.abort()
    await expect(provider.listResources(config, { includeHidden: true, signal: abort.signal }))
      .rejects.toThrow()
  } finally {
    await site.close()
  }
})

Deno.test('local HTTP fixtures exercise HEAD fallback, redirect guards, timeout and host pacing', async () => {
  const site = fixture()
  try {
    const target = (path: string) => ({ url: origin + path, title: 'Research link' })
    expect((await checkLink(target('/fallback'), undefined, site.client)).status).toBe('ok')
    expect(site.calls.slice(0, 2).map((call) => call.method)).toEqual(['HEAD', 'GET'])
    expect(site.calls[1]!.at - site.calls[0]!.at).toBeGreaterThanOrEqual(15)
    expect((await checkLink(target('/redirect'), undefined, site.client)).status).toBe('ok')
    for (const path of ['/redirect-private', '/redirect-dns', '/loop']) {
      expect((await checkLink(target(path), undefined, site.client)).status).toBe('blocked')
    }
    expect(site.calls.some((call) => call.path === '/secret')).toBe(false)
    expect(site.calls.filter((call) => call.path === '/loop')).toHaveLength(4)
    expect((await checkLink(target('/restricted'), undefined, site.client)).status).toBe(
      'restricted',
    )
    expect((await checkLink(target('/busy'), undefined, site.client)).status).toBe('temporary')
    const timed = new PublicHttpClient({
      resolve: async () => ['93.184.216.34'],
      fetch: site.transport,
      intervalMs: 0,
      timeoutMs: 20,
    })
    expect((await checkLink(target('/slow'), undefined, timed)).status).toBe('timeout')
  } finally {
    await site.close()
  }
})

Deno.test('scheduled website sync picks up changed pages with ETag and content hash within its cap', async () => {
  const site = fixture()
  const directory = Deno.makeTempDirSync({ prefix: 'link-refresh-' })
  const originalFetch = globalThis.fetch
  // Only the existing website crawler is redirected; the transport always uses the captured fetch.
  globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin) throw new Error('Only the local website fixture may be fetched')
    return originalFetch(site.local + url.pathname, init).then((response) => {
      // Preserve the public URL that the fixture transport represents.
      Object.defineProperty(response, 'url', { value: url.href })
      return response
    })
  }) as typeof fetch
  try {
    const sources = new SourceStore(directory)
    const source = sources.add('refresh', origin + '/news', true, 2)
    const provider = new WebsiteProvider()
    const management = provider as unknown as AragProvider
    const config = { slug: 'refresh' } as TenantConfig
    const first = await syncSource(management, sources, config, source, () => {})
    expect(first.summary).toEqual({ new: 2, changed: 0, unchanged: 0, failed: 0 })
    const originalIds = Object.values(sources.find('refresh', source.id)!.pages!).map((page) =>
      page.resourceId
    )
    for (const id of originalIds) provider.curate(id!)
    const unchanged = await syncSource(
      management,
      sources,
      config,
      sources.find('refresh', source.id)!,
      () => {},
    )
    expect(unchanged.summary).toEqual({ new: 0, changed: 0, unchanged: 2, failed: 0 })
    expect(site.calls.some((call) => call.conditional === '"version-1"')).toBe(true)
    site.change()
    sources.update('refresh', source.id, { maxPages: 1 })
    await runAutoSyncs(
      management,
      { list: () => [{ slug: 'refresh' }], get: () => config } as never,
      sources,
    )
    expect(sources.find('refresh', source.id)!.lastSummary).toEqual({
      new: 0,
      changed: 1,
      unchanged: 0,
      failed: 0,
    })
    await runAutoSyncs(
      management,
      { list: () => [{ slug: 'refresh' }], get: () => config } as never,
      sources,
    )
    expect(sources.find('refresh', source.id)!.lastSummary?.changed).toBe(1)
    const saved = sources.find('refresh', source.id)!
    expect(saved.itemCount).toBe(2)
    expect(
      (await provider.listResources(config)).filter((r) => r.originUrl?.match(/\/(article|hash)$/)),
    ).toHaveLength(2)
    for (const id of originalIds) expect(await provider.resource(config, id!)).toBeNull()
    expect([...provider.bodies.values()].every((body) => body.includes('Version 2'))).toBe(true)
    const refreshed = (await provider.listResources(config)).filter((row) =>
      row.originUrl?.match(/\/(article|hash)$/)
    )
    expect(
      refreshed.every((row) =>
        row.hidden && row.title === 'Curated research findings' &&
        row.topicIds.includes('curated-research')
      ),
    ).toBe(true)
    expect('pages' in sources.summaries('refresh')[0]!).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    await site.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

function readQueue(directory: string) {
  const { database } = openLocalRbac({ DATA_DIR: directory })
  try {
    return new LinkHealthStore(database).list('marine')
  } finally {
    database.close()
  }
}

Deno.test('daily link maintenance records portal audit and honours read-only and suspended hosting', async () => {
  const site = fixture()
  const directory = Deno.makeTempDirSync({ prefix: 'link-maintenance-' })
  const { database, rbac } = openLocalRbac({ DATA_DIR: directory })
  try {
    const owned = localOwnedStores(directory, database, rbac.audit)
    const config = { slug: 'maintenance' } as TenantConfig
    const provider = new WebsiteProvider()
    const stores = {
      ...owned,
      rbac,
      linkHttp: site.client,
      tenants: { list: () => [{ slug: config.slug }], get: () => config } as never,
      sources: new SourceStore(directory),
      enrichments: new EnrichmentStore(directory),
    }
    stores.sources.add(config.slug, origin + '/fallback', false)
    await runSystemMaintenance(provider as unknown as AragProvider, stores, undefined, ['links'])
    expect(owned.linkHealth.list(config.slug)).toHaveLength(3)
    const failed = owned.linkHealth.list(config.slug).filter((row) => row.status !== 'ok')
    expect(failed).toHaveLength(2)
    const events = rbac.audit.read({ scope: { kind: 'portal', slug: config.slug }, limit: 100 })
    expect(
      events.some((event) =>
        event.action === 'maintenance.link.check' && event.outcome === 'success'
      ),
    ).toBe(true)
    expect(events.filter((event) => event.action === 'local.mutation')).toHaveLength(3)
    const attempts = site.calls.length
    for (const status of ['read_only', 'suspended'] as const) {
      owned.lifecycle.set(config.slug, { status, limits: null })
      await runSystemMaintenance(provider as unknown as AragProvider, stores, undefined, ['links'])
    }
    expect(site.calls).toHaveLength(attempts)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
    await site.close()
  }
})

async function click(page: Page, label: string, scope = '[data-link-health]') {
  await page.evaluate((label, scope) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(scope + ' button')].find((
      button,
    ) => button.textContent?.trim() === label)
    if (!button) throw new Error(`Missing button: ${label}`)
    button.scrollIntoView({ block: 'center' })
    button.focus()
  }, { args: [label, scope] })
  await page.keyboard.press('Enter')
}

Deno.test('Manage review queue checks, ignores, recovers and confirms retirement with audit and portal isolation', async () => {
  const site = fixture()
  const provider = new WebsiteProvider()
  const sourceDirectory = Deno.makeTempDirSync({ prefix: 'link-review-sources-' })
  const sources = new SourceStore(sourceDirectory)
  const source = sources.add('marine', origin + '/fallback', true, 2)
  sources.update('marine', source.id, {
    itemCount: 2,
    lastAdded: 1,
    lastSync: new Date().toISOString(),
    lastStatus: 'ok',
    lastSummary: { new: 1, changed: 1, unchanged: 3, failed: 0 },
  })
  const server = startTestServer({
    sources,
    identity: { role: 'owner' },
    provider,
    management: provider as unknown as AragProvider,
    linkHttp: site.client,
  })
  const browser = await launch()
  const page = await browser.newPage(server.url)
  try {
    await page.goto(server.url + '/t/marine/manage?tab=content')
    await page.waitForSelector('[data-link-health]').catch(async (error) => {
      console.error(await page.evaluate(() => document.body.innerText), server.requests)
      throw error
    })
    await assertCurrentBuild(page)
    await click(page, 'Check links now')
    await page.waitForFunction(() => document.querySelectorAll('[data-link-review]').length === 2)
    const reviews = await (await fetch(server.url + '/api/admin/t/marine/link-health')).json()
    expect(reviews).toHaveLength(2)
    const first = readQueue(server.directory)
    expect(first.map((row) => row.status).sort()).toEqual(['broken', 'ok', 'temporary'])
    expect(first.every((row) => (row.status === 'ok' || row.firstFailed) && row.attempts === 1))
      .toBe(true)
    const queueId = first.find((row) => row.resourceId === 'gone')!.id
    const cross = await fetch(server.url + `/api/admin/t/grains/link-health/${queueId}/ignore`, {
      method: 'POST',
    })
    expect(cross.status).toBe(404)
    await cross.body?.cancel()
    await click(page, 'Ignore', '[data-link-review="busy"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-link-review]').length === 1)
    expect(
      readQueue(server.directory).find((row) => row.resourceId === 'busy')
        ?.ignored,
    ).toBe(true)
    const before = site.calls.filter((call) => call.path === '/busy').length
    await click(page, 'Check links now')
    await page.waitForFunction(() =>
      document.querySelector('[data-link-health]')?.getAttribute('aria-busy') === 'false'
    )
    expect(site.calls.filter((call) => call.path === '/busy').length).toBe(before)
    const again = readQueue(server.directory).find((row) => row.resourceId === 'gone')!
    expect(again.attempts).toBe(2)
    expect(again.firstFailed).toBe(first.find((row) => row.resourceId === 'gone')!.firstFailed)
    site.recover()
    await click(page, 'Re-check', '[data-link-review="gone"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-link-review]').length === 0)
    expect(
      readQueue(server.directory).find((row) => row.resourceId === 'gone')
        ?.firstFailed,
    ).toBeNull()
    await click(page, 'Show ignored links')
    await page.waitForSelector('[data-link-review="busy"]')
    await click(page, 'Re-check', '[data-link-review="busy"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-link-review]').length === 0)
    expect(readQueue(server.directory).find((row) => row.resourceId === 'busy')?.ignored).toBe(
      false,
    )
    await click(page, 'Show review queue')
    await page.waitForSelector('[data-link-review="busy"]')
    await click(page, 'Ignore', '[data-link-review="busy"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-link-review]').length === 0)
    await click(page, 'Show ignored links')
    await page.waitForSelector('[data-link-review="busy"]')
    for (const dark of [false, true]) {
      server.tenants.patch('marine', {
        branding: {
          ...server.tenants.get('marine')!.branding,
          paletteId: dark ? 'observatory' : 'default',
          shape: 'soft',
          density: 'spacious',
          typography: 'lexend-zilla',
        },
      })
      await page.goto(server.url + '/t/marine/manage?tab=content')
      await page.waitForSelector('[data-link-health]')
      await click(page, 'Show ignored links')
      await page.waitForSelector('[data-link-review="busy"]')
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 960 })
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '22px'
          const top = document.querySelector('[data-link-health]')!.getBoundingClientRect().top
          const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
          scrollTo(0, scrollY + top - header - 16)
        })
        await captureBoundary(
          page,
          '.planning/logs/link-health',
          `${dark ? 'dark' : 'light'}-${width}`,
          width,
        )
        if (width < 500) {
          await page.evaluate(() =>
            document.querySelector('[data-link-review] button:last-child')!.scrollIntoView({
              block: 'center',
            })
          )
          await captureBoundary(
            page,
            '.planning/logs/link-health',
            `${dark ? 'dark' : 'light'}-${width}-actions`,
            width,
          )
        }
        await page.evaluate(() =>
          document.querySelector('select[id^="source-cap-"]')?.scrollIntoView({ block: 'center' })
        )
        await captureBoundary(
          page,
          '.planning/logs/link-health',
          `${dark ? 'dark' : 'light'}-${width}-source-summary`,
          width,
        )
      }
    }
    const countersBeforeRetire = server.requests.filter((request) =>
      request.path.endsWith('/counters')
    ).length
    await click(page, 'Retire resource', '[data-link-review="busy"]')
    await page.waitForSelector('dialog[open]')
    expect(await provider.resource({ slug: 'marine' } as TenantConfig, 'busy')).not.toBeNull()
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
      'Keep resource',
    )
    await click(page, 'Keep resource', 'dialog')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    await click(page, 'Retire resource', '[data-link-review="busy"]')
    await page.waitForSelector('dialog[open]')
    await click(page, 'Retire resource', 'dialog')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    await page.waitForFunction(() =>
      document.querySelector('[data-link-health]')?.getAttribute('aria-busy') === 'false'
    )
    expect(await provider.resource({ slug: 'marine' } as TenantConfig, 'busy')).toBeNull()
    expect(server.requests.filter((request) => request.path.endsWith('/counters')).length)
      .toBeGreaterThan(countersBeforeRetire)
    const audit = await (await fetch(server.url + '/api/admin/t/marine/audit?limit=100')).json()
    const serialised = JSON.stringify(audit)
    expect(serialised).toContain('resource.delete')
    expect(serialised).toContain('link-health/:id/ignore')
    expect(serialised).toContain('link-health/:id/recheck')
    expect(serialised).not.toContain(origin)
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    const denied = await fetch(server.url + '/api/admin/t/marine/link-health')
    expect(denied.status).toBe(403)
    await denied.body?.cancel()
  } finally {
    await browser.close()
    await server.close()
    await site.close()
    Deno.removeSync(sourceDirectory, { recursive: true })
  }
})
