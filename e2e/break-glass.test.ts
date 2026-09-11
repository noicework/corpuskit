import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { type EmergencyFixtureState, startTestServer } from './support/test-server.ts'

// Suite duration must not age a build that was fresh when this test run started.
const browserRunStartedAt = Date.now()

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function click(page: Page, selector: string) {
  await (await page.waitForSelector(selector)).click()
}

async function settle(page: Page) {
  await page.bringToFront()
  // Use the runner clock: Chromium may suspend page timers after a polling wait.
  await new Promise((resolve) => setTimeout(resolve, 50))
  await page.evaluate(() => document.readyState)
}

async function clickText(page: Page, text: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.trim().includes(label)
    )
    if (!button) throw new Error(`Missing button: ${label}`)
    button.click()
  }, { args: [text] })
  await settle(page)
}

async function fill(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector, value] })
}

Deno.test({
  name: 'administration pages discard legacy credentials and use explicit isolated requests',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const marker = `pages-${crypto.randomUUID()}`
    const directory = `.planning/logs/02-14-${marker}`
    await Deno.mkdir(directory, { recursive: true })
    const root = Deno.cwd()
    // Bundle real page components; only their network responses and outlet config are fixtures.
    await Deno.writeTextFile(
      `${directory}/source.tsx`,
      `
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom'
import { BrandingSchema } from '@research-portal/core'
import { AdminPage } from '${root}/apps/web/src/pages/AdminPage.tsx'
import { ManagePage } from '${root}/apps/web/src/pages/ManagePage.tsx'
import { TaxonomyPage } from '${root}/apps/web/src/pages/TaxonomyPage.tsx'
import { googleFontsUrl, tenantThemeVars, useBodyTheme } from '${root}/apps/web/src/lib/theme.ts'
const params = new URLSearchParams(location.search)
const branding = BrandingSchema.parse({ productName: 'Fixture research', organisation: 'Example research', tagline: 'Research administration', colours: { primary: '#17372d', accent: '#e0ba63', heroFrom: '#17372d', heroTo: '#234f45' }, paletteId: params.get('palette') === 'observatory' ? 'observatory' : 'default', shape: 'soft', density: 'spacious', typography: 'lexend-zilla' })
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const font = document.createElement('link')
font.rel = 'stylesheet'
font.href = googleFontsUrl('lexend-zilla')
font.onload = async () => {
  await Promise.all([document.fonts.load('600 16px Lexend'), document.fonts.load('16px "Zilla Slab"')])
  document.body.dataset.fixtureFonts = 'ready'
}
document.head.append(font)
sessionStorage.setItem('rp-admin-passcode', 'legacy-test-value')
function Layout() {
 useBodyTheme(branding)
 useEffect(() => {
 const refresh = () => client.invalidateQueries({ queryKey: ['auth-session'] })
 const invalidate = () => client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth-session' })
 const seedProtected = () => client.setQueryData(['suggestions', 'alpha'], [{ title: 'Prior identity private suggestion' }])
 const inspect = () => { document.body.dataset.cache = JSON.stringify(client.getQueryCache().getAll().map(q => ({ key: q.queryKey, data: q.state.data }))) }
 const unsubscribe = client.getQueryCache().subscribe(() => { document.body.dataset.authId = client.getQueryData(['auth-session'])?.user?.id ?? 'anonymous' })
 addEventListener('fixture-seed-protected', seedProtected)
 addEventListener('fixture-refresh-capability', refresh)
 addEventListener('fixture-invalidate', invalidate)
 addEventListener('fixture-inspect', inspect)
 return () => { removeEventListener('fixture-seed-protected', seedProtected); unsubscribe(); removeEventListener('fixture-refresh-capability', refresh); removeEventListener('fixture-invalidate', invalidate); removeEventListener('fixture-inspect', inspect) }
 }, [])
 return <div className='rp-tenant min-h-screen bg-app text-ink' style={tenantThemeVars(branding)} data-fixture-build='${marker}'><header className='border-b border-line bg-surface p-6'>CorpusKit administration</header><Outlet context={{ config: { slug: 'alpha', branding } }} /></div>
}
createRoot(document.getElementById('emergency-fixture-root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/' + (params.get('page') || 'admin')]}><Routes><Route element={<Layout />}><Route path='/admin' element={<AdminPage />} /><Route path='/manage' element={<ManagePage />} /><Route path='/taxonomy' element={<TaxonomyPage />} /></Route></Routes></MemoryRouter></QueryClientProvider>)
`,
    )
    const build = await new Deno.Command('esbuild', {
      args: [
        `${directory}/source.tsx`,
        '--bundle',
        '--format=esm',
        '--jsx=automatic',
        `--outfile=${directory}/entry.js`,
        '--alias:@research-portal/core=./packages/core/src/index.ts',
        ...[
          'react',
          'react/jsx-runtime',
          'react-dom',
          'react-dom/client',
          'react-router-dom',
          '@tanstack/react-query',
          'zod',
          'd3-force',
          'three',
          'pdfjs-dist',
        ].map((name) => `--external:${name}`),
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    expect(build.success, new TextDecoder().decode(build.stderr)).toBe(true)
    const appHash = await digest(await Deno.readFile('apps/web/dist/app.js'))
    const fixtureHash = await digest(await Deno.readFile(`${directory}/entry.js`))
    const stamp = JSON.parse(await Deno.readTextFile('apps/web/dist/build.json'))
    expect(browserRunStartedAt - Date.parse(stamp.builtAt)).toBeLessThan(180_000)
    expect(Date.parse(stamp.builtAt)).toBeLessThanOrEqual(browserRunStartedAt)
    const state: EmergencyFixtureState = {
      capability: 'enabled',
      status: 200,
      requests: 0,
      credentialRequests: 0,
      delayMs: 0,
    }
    const base = startTestServer({ emergencyFixture: { directory, state } })
    const requests: { path: string; method: string; emergency: boolean }[] = []
    let migrationComplete = true
    let malformedResponse: unknown = undefined
    let migrationMalformed = false
    let migrationLateError = false
    let renameOk = true
    let syncComplete = true
    let syncMalformed = false
    let malformedRead = false
    let taxonomyPopulated = false
    const taxonomyBodies: unknown[] = []
    const brandingUploads: { path: string; contentType: string | null; bytes: number }[] = []
    let behaviourActive = false
    let behaviourMalformed = false
    let promptText = 'Answer with cited research.'
    let graphComplete = true
    let graphMalformed = false
    let graphAgentTitle = 'Research graph'
    let analysisComplete = true
    let suggestionsMalformed = false
    let labComplete = true
    let labMalformed = false
    let methodName = 'Default extraction'
    let enrichedCount = 2
    const labRules = { default: 'default', rules: [], visualPageCap: 60 }
    const comparisons: { question?: string; resourceId: string }[] = []
    const profile = {
      pages: 2,
      bytes: 1000,
      chars: 200,
      charsPerPage: 100,
      fonts: 1,
      imageOnlyPages: 0,
      tableRowsPerPage: 0,
      dictionaryHitRate: 0.9,
      class: 'prose',
      source: 'platform',
    }
    const suggestions = ['one', 'two'].map((id) => ({
      id,
      kind: 'entity-type',
      title: `Research suggestion ${id}`,
      detail: 'Add research participants.',
      status: 'pending',
      createdAt: '2026-09-12',
      entityType: { label: 'Person', description: 'Research participants' },
    }))
    const graphStrategy = {
      entityDefs: [{ label: 'Person', description: 'Research participants' }],
      examples: Array.from({ length: 6 }, (_, index) => ({
        text: `Alex works with Sam on research ${index + 1}.`,
        entities: [{ name: 'Alex', label: 'Person' }, { name: 'Sam', label: 'Person' }],
        relations: [{ source: 'Alex', target: 'Sam', label: 'works with' }],
      })),
    }
    const source = {
      id: 'source-one',
      url: 'https://example.invalid/research',
      addedAt: '2026-09-12',
      lastSync: null,
      lastAdded: 0,
      itemCount: 0,
      auto: true,
      maxPages: 25,
    }
    const recent = [{
      id: 'resource-one',
      title: 'Research resource',
      status: 'pending',
      hidden: false,
      created: '2026-09-12',
    }]
    let sessionIdentity = 'original-user'
    const renameBodies: unknown[] = []
    const rows = ['alpha', 'beta'].map((slug) => ({
      tenant: {
        slug,
        productName: `Protected ${slug}`,
        organisation: 'Example research',
        tagline: 'Research administration',
      },
      knowledgeBox: { slug, status: 'connected', kbId: 'fixture-box' },
      resourceCount: 7,
      custom: true,
      disabled: false,
    }))
    const proxy = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/auth/me' && state.capability === 'session') {
        const session = await (await fetch(`${base.url}/auth/me`)).json()
        return Response.json({ ...session, user: { ...session.user, id: sessionIdentity } })
      }
      if (url.pathname.startsWith('/api/admin/')) {
        const emergency = request.headers.has('x-admin-passcode')
        requests.push({ path: url.pathname, method: request.method, emergency })
        const status = !emergency && state.capability !== 'session' ? 403 : state.status
        if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
        if (status !== 200) {
          return Response.json({ message: 'Refused' }, {
            status: status === 429 ? 403 : status,
            headers: status === 429 ? { 'retry-after': '125' } : {},
          })
        }
        if (malformedResponse !== undefined) return Response.json(malformedResponse)
        if (url.pathname.includes('/labelsets')) {
          taxonomyBodies.push(await request.json())
          return Response.json({ ok: true, id: 'region', agents: [] })
        }
        if (url.pathname.endsWith('/kg/propose')) {
          if (graphMalformed) return Response.json({ rationale: 'Invalid response' })
          return Response.json({
            rationale: 'Connect research participants.',
            entityTypes: [],
            resourceLabels: [],
            chunkLabels: [],
          })
        }
        if (url.pathname.endsWith('/extraction/methods')) {
          return Response.json(
            labMalformed ? {} : {
              lab: 'Research sandbox',
              available: true,
              poppler: false,
              methods: [{ id: 'default', name: methodName, kind: 'default' }],
              rules: labRules,
            },
          )
        }
        if (url.pathname.endsWith('/extraction/profile')) {
          return Response.json({ profile, filename: 'research.pdf' })
        }
        if (url.pathname.endsWith('/extraction/rules')) {
          return Response.json({ ok: true, rules: await request.json() })
        }
        if (url.pathname.endsWith('/extraction/compare')) {
          comparisons.push(await request.json())
          return new Response(
            [
              { type: 'stage', label: 'Comparing methods' },
              ...(labComplete
                ? [{
                  type: 'done',
                  purged: 1,
                  recommended: 'Default extraction',
                  reason: 'Clear research text.',
                  yields: {},
                }]
                : []),
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (url.pathname.endsWith('/enrichments')) {
          return Response.json(
            labMalformed ? {} : [{
              agent: {
                id: 'research-summary',
                title: 'Research summary',
                description: 'Cited research summary fields.',
                scope: 'resource',
                cardinality: 'single',
                isDefault: true,
                fields: [{
                  key: 'title',
                  label: 'Title',
                  kind: 'title',
                  description: 'A useful research title.',
                }],
              },
              jsonSchema: { type: 'object' },
              enrichedCount,
              totalCount: 7,
              generationNote: 'Generated from research text.',
            }],
          )
        }
        if (url.pathname.endsWith('/enrichments/run')) {
          return new Response(
            [
              { type: 'start', total: 1 },
              ...(labComplete ? [{ type: 'done', enriched: 1, errors: 0 }] : []),
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (url.pathname.endsWith('/analyse')) {
          return new Response(
            [
              { type: 'stage', label: 'Analysing research' },
              ...(analysisComplete
                ? [{ type: 'done', topics: 2, kinds: 1, labelled: 3, questions: 4 }]
                : []),
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (url.pathname.endsWith('/interrogate') || url.pathname.endsWith('/suggestions')) {
          return Response.json(
            suggestionsMalformed ? [{ ...suggestions[0], entityType: { label: 5 } }] : suggestions,
          )
        }
        if (url.pathname.includes('/suggestions/') && url.pathname.endsWith('/implement')) {
          return Response.json({ ok: true, summary: 'Suggestion implemented.' })
        }
        if (url.pathname.endsWith('/agents')) {
          return Response.json([{ id: 'agent-one', task: 'graph', title: graphAgentTitle }])
        }
        if (url.pathname.endsWith('/kg/strategy') && request.method === 'GET') {
          return Response.json({ strategy: graphStrategy })
        }
        if (
          url.pathname.endsWith('/kg/implement') ||
          (url.pathname.endsWith('/kg/strategy') && request.method === 'PUT')
        ) {
          return new Response(
            [
              { type: 'stage', label: 'Preparing graph agents' },
              ...(graphComplete ? [{ type: 'done', agents: 1 }] : []),
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (url.pathname.includes('/branding/')) {
          brandingUploads.push({
            path: url.pathname,
            contentType: request.headers.get('content-type'),
            bytes: (await request.arrayBuffer()).byteLength,
          })
          return Response.json({ ok: true, url: '/api/t/alpha/branding/logo' })
        }
        if (url.pathname.endsWith('/prompts')) {
          if (request.method === 'PUT') {
            promptText = (await request.json()).ask
            return Response.json({ ok: true })
          }
          return Response.json(behaviourMalformed ? { ask: 12 } : { ask: promptText, images: true })
        }
        if (url.pathname.endsWith('/search-configs/ensure')) {
          return Response.json({ ok: true, created: ['portal-ask'] })
        }
        if (url.pathname.endsWith('/search-configs')) {
          return Response.json(behaviourMalformed ? [] : { 'portal-ask': {}, 'portal-search': {} })
        }
        if (url.pathname.endsWith('/routing')) {
          return Response.json(
            behaviourMalformed ? {} : {
              recent: [],
              summary: { total: 4, byIntent: { research: 4 }, byStage: { rule: 4 } },
            },
          )
        }
        if (url.pathname.endsWith('/sources/source-one/sync')) {
          return new Response(
            [
              { type: 'item', label: 'Research page' },
              ...(syncComplete ? [{ type: 'done', added: syncMalformed ? 'invalid' : 1 }] : []),
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (url.pathname.endsWith('/sources')) {
          return Response.json(
            request.method === 'GET'
              ? [source]
              : { ...source, discovered: 3, discoveredVia: 'sitemap' },
          )
        }
        if (url.pathname.endsWith('/sources/source-one')) {
          return Response.json(
            request.method === 'PATCH' ? { ...source, ...await request.json() } : { ok: true },
          )
        }
        if (url.pathname.endsWith('/recent')) return Response.json(recent)
        if (url.pathname.endsWith('/counters')) {
          return Response.json(malformedRead ? {} : { paragraphs: 12, sentences: 24, indexMb: 1.5 })
        }
        if (url.pathname.endsWith('/insights')) {
          return Response.json(
            malformedRead ? {} : {
              totalAsks: 3,
              answered: 2,
              unanswered: 1,
              avgGroundedness: 4.2,
              avgAnswerRelevance: 4.5,
              topQuestions: [{ question: 'How do research findings help?', count: 2 }],
              gaps: [{
                question: 'What evidence is missing?',
                ts: '2026-09-12',
                reason: 'Few sources',
              }],
              recent: [{
                ts: '2026-09-12',
                question: 'How do research findings help?',
                answered: true,
                citations: 2,
                durationSec: 1.2,
                answerRelevance: 4.5,
                groundedness: 4.2,
                contextRelevance: 4,
              }],
            },
          )
        }
        if (url.pathname.endsWith('/corpus-health')) {
          return Response.json(
            malformedRead ? {} : [
              { id: 'thin', title: 'Thin research page', words: 8, status: 'thin', hidden: false },
              {
                id: 'healthy',
                title: 'Complete research paper',
                words: 2400,
                status: 'ok',
                hidden: false,
              },
            ],
          )
        }
        if (url.pathname.endsWith('/crawl')) {
          return Response.json({
            links: ['https://example.invalid/one', 'https://example.invalid/two'],
          })
        }
        if (url.pathname === '/api/admin/migrate') {
          return new Response(
            [
              { type: 'start', total: 1 },
              { type: 'item', id: 'one', title: 'Example resource', outcome: 'copied' },
              migrationMalformed
                ? { type: 'done' }
                : { type: 'done', copied: 1, skipped: 0, errors: 0 },
              ...(migrationLateError ? [{ type: 'error', message: 'Uncertain completion' }] : []),
            ].filter((event) => migrationComplete || event.type !== 'done')
              .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          )
        }
        if (request.method === 'PATCH' && url.pathname === '/api/admin/tenants/alpha') {
          renameBodies.push(await request.json())
          return Response.json(renameOk ? { ok: true } : {})
        }
        return Response.json(
          url.pathname === '/api/admin/overview' ? rows : {
            ok: true,
            id: 'region',
            slug: 'created',
            resourceCount: 7,
            status: { slug: 'alpha', status: 'connected' },
          },
        )
      }
      if (url.pathname.endsWith('/labelsets')) {
        return Response.json(
          taxonomyPopulated
            ? [{
              id: 'region',
              title: 'Region',
              multiple: false,
              kind: 'RESOURCES',
              labels: ['North', 'South'],
              definitions: { North: 'Northern research' },
            }]
            : [],
        )
      }
      if (url.pathname.endsWith('/facets')) return Response.json({})
      if (url.pathname.endsWith('/catalog')) {
        return Response.json({
          items: [{
            id: 'research-one',
            title: 'Research document',
            status: 'processed',
            topicIds: [],
          }],
          total: 1,
        })
      }
      if (url.pathname.endsWith('/counters')) return Response.json({ resources: 7 })
      if (behaviourActive && url.pathname === '/api/t/alpha/config') {
        return Response.json({
          slug: 'alpha',
          defaultIntent: 'research',
          intents: [{
            id: 'research',
            label: 'Research',
            description: 'Cited research answers',
            retrieval: {
              features: ['semantic'],
              topK: 10,
              reranker: 'noop',
              only: [],
              exclude: [],
            },
            answer: {
              surfaces: ['ask', 'search'],
              strategy: 'full',
              graph: false,
              promptVariant: 'default',
              prequeries: [],
              minScore: 0.35,
            },
          }],
        })
      }
      return fetch(`${base.url}${url.pathname}${url.search}`, request)
    })
    const url = `http://127.0.0.1:${(proxy.addr as Deno.NetAddr).port}`
    const browser = await launch({
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    })
    const evidence: unknown[] = []
    let page: Page | undefined
    async function open(kind: string, palette = 'light', width = 390) {
      await page?.close()
      page = await browser.newPage(`${url}/__test/emergency-access?page=${kind}&palette=${palette}`)
      await page.setViewportSize({ width, height: 1000 })
      await page.waitForSelector('h1')
      await page.waitForSelector('body[data-fixture-fonts=ready]')
      await page.evaluate(async () => {
        document.documentElement.style.fontSize = '22px'
        await document.fonts.ready
      })
      await settle(page)
      const fresh = await page.evaluate(async () => {
        const hash = async (path: string) =>
          [
            ...new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                await (await fetch(path, { cache: 'no-store' })).arrayBuffer(),
              ),
            ),
          ].map((v) => v.toString(16).padStart(2, '0')).join('')
        return {
          appHash: await hash('/app.js'),
          fixtureHash: await hash('/__test/emergency-access.js'),
          stamp: await (await fetch('/build.json', { cache: 'no-store' })).json(),
          marker: document.querySelector('[data-fixture-build]')?.getAttribute(
            'data-fixture-build',
          ),
        }
      })
      expect(fresh).toEqual({ appHash, fixtureHash, stamp, marker })
      expect(await page.evaluate(() => sessionStorage.getItem('rp-admin-passcode'))).toBe(null)
      return page
    }
    async function capture(name: string) {
      await settle(page!)
      const metrics = await page!.evaluate(() => ({
        width: innerWidth,
        overflow: document.documentElement.scrollWidth - innerWidth,
        rootFont: getComputedStyle(document.documentElement).fontSize,
        bodyFont: getComputedStyle(document.querySelector('main')!).fontFamily,
        lexendLoaded: document.fonts.check('16px Lexend'),
        zillaLoaded: document.fonts.check('16px "Zilla Slab"'),
        controlOverflow: Math.max(
          0,
          ...[...document.querySelectorAll<HTMLElement>('.rp-btn, .rp-badge')].map((element) =>
            element.scrollWidth - element.clientWidth
          ),
        ),
      }))
      expect(metrics.overflow).toBeLessThanOrEqual(1)
      expect(metrics.rootFont).toBe('22px')
      expect(metrics.bodyFont).toContain('Zilla Slab')
      expect(metrics.lexendLoaded).toBe(true)
      expect(metrics.zillaLoaded).toBe(true)
      const screenshot = `${directory}/${name}.png`
      await Deno.writeFile(screenshot, await page!.screenshot())
      if (metrics.controlOverflow > 1) {
        console.log(
          await page!.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('.rp-btn, .rp-badge')].filter((el) =>
              el.scrollWidth - el.clientWidth > 1
            ).map((el) => ({ text: el.textContent, width: el.clientWidth, scroll: el.scrollWidth }))
          ),
        )
      }
      expect(metrics.controlOverflow).toBeLessThanOrEqual(1)
      evidence.push({ name, metrics, screenshot })
    }
    async function confirm() {
      await page!.waitForSelector('[role=dialog] input')
      await fill(page!, '[role=dialog] input', 'one-request-test-value')
      await click(page!, '[role=dialog] [type=submit]')
      await settle(page!)
    }
    async function explicitAction(action: () => Promise<void>, label: string) {
      const before = requests.length
      await action()
      await page!.waitForSelector('[role=dialog]')
      expect(requests.length).toBe(before)
      await click(page!, '[data-emergency-cancel]')
      await settle(page!)
      expect(requests.length).toBe(before)
      await action()
      await confirm()
      await settle(page!)
      expect(requests.length).toBe(before + 1)
      expect(requests.at(-1)?.emergency).toBe(true)
      expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      await page!.evaluate(() => {
        dispatchEvent(new Event('fixture-invalidate'))
        dispatchEvent(new Event('focus'))
        dispatchEvent(new Event('fixture-inspect'))
      })
      await settle(page!)
      expect(requests.length).toBe(before + 1)
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain(
        'one-request-test-value',
      )
      evidence.push({ action: label, requests: 1 })
    }
    try {
      evidence.push({ freshness: { appHash, fixtureHash, stamp, marker } })
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Extraction')
          await page!.waitForSelector('[data-extraction-read]')
          await explicitAction(() => click(page!, '[data-extraction-read]'), 'extraction-methods')
          await fill(page!, 'input[type=number]', '42')
          labRules.visualPageCap = 80
          await explicitAction(
            () => click(page!, '[data-extraction-read]'),
            'extraction-dirty-refresh',
          )
          expect(
            await page!.evaluate(() =>
              document.querySelector<HTMLInputElement>('input[type=number]')!.value
            ),
          ).toBe('42')
          await fill(page!, '[aria-label="Find a document"]', 'Research')
          await settle(page!)
          await explicitAction(() => clickText(page!, 'Research document'), 'extraction-profile')
          await fill(
            page!,
            '[aria-label="Question for the before and after ask"]',
            'What are the research findings?',
          )
          await explicitAction(() => clickText(page!, 'Run comparison'), 'extraction-compare')
          expect(comparisons.at(-1)?.question).toBe('What are the research findings?')
          await page!.evaluate(() =>
            document.querySelector('[aria-label="Question for the before and after ask"]')!
              .scrollIntoView({ block: 'center' })
          )
          await capture(`extraction-comparison-${palette}-${width}`)
          await explicitAction(() => clickText(page!, 'Save rules'), 'extraction-rules')
          labRules.visualPageCap = 90
          await explicitAction(
            () => click(page!, '[data-extraction-read]'),
            'extraction-clean-refresh',
          )
          expect(
            await page!.evaluate(() =>
              document.querySelector<HTMLInputElement>('input[type=number]')!.value
            ),
          ).toBe('90')
          await page!.evaluate(() =>
            document.querySelector('input[type=number]')!.closest('.rp-card')!.scrollIntoView({
              block: 'start',
            })
          )
          await capture(`extraction-rules-${palette}-${width}`)
          await page!.evaluate(() => scrollTo(0, 0))
          await capture(`extraction-header-${palette}-${width}`)
          labComplete = false
          await clickText(page!, 'Run comparison')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await capture(`extraction-uncertain-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          labComplete = true
          labMalformed = true
          await click(page!, '[data-extraction-read]')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await click(page!, '[data-emergency-cancel]')
          labMalformed = false
          await clickText(page!, 'Enrichments')
          await page!.waitForSelector('[data-enrichments-read]')
          await explicitAction(() => click(page!, '[data-enrichments-read]'), 'enrichment-schemas')
          await clickText(page!, 'Show raw schema')
          await explicitAction(() => click(page!, '[data-enrichment-run]'), 'enrichment-missing')
          await click(page!, '[data-enrichment-scope=all]')
          await explicitAction(() => click(page!, '[data-enrichment-run]'), 'enrichment-all')
          await capture(`enrichment-schema-${palette}-${width}`)
          labComplete = false
          await click(page!, '[data-enrichment-run]')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await capture(`enrichment-uncertain-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          labComplete = true
        }
      }
      state.capability = 'session'
      await open('manage')
      await page!.waitForSelector('[data-admin-overview]')
      await clickText(page!, 'Extraction')
      await click(page!, '[data-extraction-read]')
      methodName = 'Refreshed extraction'
      await page!.evaluate(() => dispatchEvent(new Event('fixture-invalidate')))
      await settle(page!)
      expect(await page!.evaluate(() => document.body.textContent)).toContain(methodName)
      await clickText(page!, 'Enrichments')
      await click(page!, '[data-enrichments-read]')
      enrichedCount = 5
      await page!.evaluate(() => dispatchEvent(new Event('fixture-invalidate')))
      await settle(page!)
      expect(await page!.evaluate(() => document.body.textContent)).toContain('5 of 7 resources')
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Taxonomy')
          await page!.waitForSelector('[data-suggestions-read]')
          await explicitAction(() => clickText(page!, 'Run analysis'), 'analysis-run')
          await explicitAction(() => click(page!, '[data-suggestions-read]'), 'suggestions-read')
          await explicitAction(() => clickText(page!, 'Run interrogation'), 'interrogation-run')
          await explicitAction(
            () => click(page!, '[data-suggestion=one] [data-suggestion-implement]'),
            'suggestion-implement',
          )
          await explicitAction(
            () => click(page!, '[data-suggestion=two] [data-suggestion-ignore]'),
            'suggestion-ignore',
          )
          await capture(`suggestions-${palette}-${width}`)
          await explicitAction(() => click(page!, '[data-suggestions-read]'), 'suggestions-refresh')
          await page!.waitForSelector('[data-suggestion=one] [data-suggestion-implement]')
          await page!.waitForSelector('[data-suggestion=two] [data-suggestion-ignore]')
          suggestionsMalformed = true
          await click(page!, '[data-suggestions-read]')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await click(page!, '[data-emergency-cancel]')
          suggestionsMalformed = false
          analysisComplete = false
          await clickText(page!, 'Run analysis')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await capture(`analysis-uncertain-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          analysisComplete = true
          state.status = 500
          await clickText(page!, 'Run interrogation')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await click(page!, '[data-emergency-cancel]')
          state.status = 200
        }
      }
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Knowledge graph')
          await page!.waitForSelector('[data-graph-read=agents]')
          await explicitAction(() => clickText(page!, 'Propose strategy'), 'graph-propose')
          await explicitAction(() => clickText(page!, 'Implement strategy'), 'graph-implement')
          await explicitAction(() => click(page!, '[data-graph-read=agents]'), 'graph-agents')
          await explicitAction(() => clickText(page!, 'Remove'), 'graph-remove-agent')
          await explicitAction(() => click(page!, '[data-graph-read=strategy]'), 'graph-strategy')
          await fill(page!, 'input[placeholder="Description (optional)"]', 'Research people')
          await explicitAction(() => clickText(page!, 'Save and re-register agent'), 'graph-save')
          await capture(`graph-editor-${palette}-${width}`)
          await page!.evaluate(() => scrollTo(0, 0))
          await capture(`graph-header-${palette}-${width}`)
          await page!.evaluate(() => scrollTo(0, document.body.scrollHeight))
          await capture(`graph-examples-${palette}-${width}`)
          graphComplete = false
          await clickText(page!, 'Implement strategy')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await capture(`graph-uncertain-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          graphComplete = true
          graphMalformed = true
          await clickText(page!, 'Propose strategy')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await click(page!, '[data-emergency-cancel]')
          graphMalformed = false
        }
      }
      state.capability = 'session'
      await open('manage')
      await page!.waitForSelector('[data-admin-overview]')
      await clickText(page!, 'Knowledge graph')
      await page!.waitForSelector('input[placeholder="Description (optional)"]')
      await click(page!, '[data-graph-read=agents]')
      await click(page!, '[data-graph-read=strategy]')
      graphAgentTitle = 'Refreshed graph agent'
      graphStrategy.entityDefs[0]!.description = 'Refreshed research participants'
      await page!.evaluate(() => dispatchEvent(new Event('fixture-invalidate')))
      await settle(page!)
      expect(await page!.evaluate(() => document.body.textContent)).toContain(graphAgentTitle)
      expect(
        await page!.evaluate(() =>
          document.querySelector<HTMLInputElement>('input[placeholder="Description (optional)"]')!
            .value
        ),
      ).toBe(graphStrategy.entityDefs[0]!.description)
      expect(requests.slice(-4).every((request) => !request.emergency)).toBe(true)
      behaviourActive = true
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          promptText = 'Answer with cited research.'
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Behaviour')
          await page!.waitForSelector('[data-behaviour-read=prompts]')
          const start = requests.length
          expect(
            await page!.evaluate(() =>
              document.querySelector<HTMLButtonElement>('[data-behaviour-save]')!.disabled
            ),
          ).toBe(true)
          await page!.evaluate(() => {
            dispatchEvent(new Event('fixture-invalidate'))
            dispatchEvent(new Event('focus'))
          })
          await settle(page!)
          expect(requests.length).toBe(start)
          await explicitAction(() => click(page!, '[data-behaviour-read=prompts]'), 'read-prompts')
          expect(
            await page!.evaluate(() =>
              document.querySelector<HTMLTextAreaElement>('[data-behaviour-prompt]')!.value
            ),
          ).toBe(promptText)
          await fill(page!, '[data-behaviour-prompt]', 'Keep all answers cited.')
          await explicitAction(() => click(page!, '[data-behaviour-save]'), 'save-prompts')
          expect(promptText).toBe('Keep all answers cited.')
          for (const name of ['configs', 'routing']) {
            await explicitAction(
              () => click(page!, `[data-behaviour-read=${name}]`),
              `read-${name}`,
            )
          }
          await explicitAction(
            () => click(page!, '[data-behaviour-ensure]'),
            'ensure-search-configs',
          )
          for (const name of ['prompts', 'configs', 'routing']) {
            await page!.evaluate(
              (name) =>
                document.querySelector(`[data-behaviour-read=${name}]`)!.scrollIntoView({
                  block: 'center',
                }),
              { args: [name] },
            )
            await capture(`behaviour-${name}-${palette}-${width}`)
            behaviourMalformed = true
            const beforeMalformed = requests.length
            await click(page!, `[data-behaviour-read=${name}]`)
            await confirm()
            await page!.waitForSelector('[role=dialog] [role=alert]')
            await click(page!, '[data-emergency-cancel]')
            expect(requests.length).toBe(beforeMalformed + 1)
            expect(
              await page!.evaluate(() =>
                document.querySelector<HTMLTextAreaElement>('[data-behaviour-prompt]')!.value
              ),
            ).toBe('Keep all answers cited.')
            behaviourMalformed = false
          }
          state.status = 500
          await click(page!, '[data-behaviour-save]')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await capture(`behaviour-uncertain-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          state.status = 200
          const after = requests.length
          if (palette === 'observatory' && width === 390) {
            await new Promise((resolve) => setTimeout(resolve, 31_000))
          }
          await page!.evaluate(() => {
            dispatchEvent(new Event('fixture-invalidate'))
            dispatchEvent(new Event('focus'))
            dispatchEvent(new Event('fixture-inspect'))
          })
          await settle(page!)
          expect(requests.length).toBe(after)
          expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain(
            'Keep all answers cited.',
          )
        }
      }
      state.capability = 'session'
      await open('manage')
      await page!.waitForSelector('[data-admin-overview]')
      await clickText(page!, 'Behaviour')
      await page!.waitForSelector('[data-behaviour-prompt]:not(:disabled)')
      const sessionBehaviourStart = requests.length
      await new Promise((resolve) => setTimeout(resolve, 31_000))
      await page!.evaluate(() => {
        dispatchEvent(new Event('fixture-invalidate'))
        dispatchEvent(new Event('focus'))
      })
      await settle(page!)
      expect(requests.slice(sessionBehaviourStart).some((r) => r.path.endsWith('/routing'))).toBe(
        true,
      )
      expect(requests.slice(sessionBehaviourStart).every((r) => !r.emergency)).toBe(true)
      await click(page!, '[data-behaviour-save]')
      await settle(page!)
      expect(requests.at(-1)?.emergency).toBe(false)
      expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      behaviourActive = false
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Appearance')
          await page!.waitForSelector('[aria-label="Rounded shape"]')
          const before = requests.length
          for (
            const label of [
              palette === 'light' ? 'Observatory palette' : 'Portal default colours',
              'Rounded shape',
              'Comfortable density',
              'Custom uploaded fonts',
              'Larger text size',
            ]
          ) {
            await click(page!, `[aria-label="${label}"]`)
            expect(requests.length).toBe(before)
            expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
          }
          for (const name of ['colours', 'typography', 'shape', 'density']) {
            await page!.evaluate(
              (name) =>
                document.querySelector(`[data-appearance-save=${name}]`)!.scrollIntoView({
                  block: 'center',
                }),
              { args: [name] },
            )
            await capture(`appearance-${name}-${palette}-${width}`)
            await explicitAction(
              () => click(page!, `[data-appearance-save=${name}]`),
              `save-${name}`,
            )
          }
          for (const kind of ['logo', 'hero', 'font-heading', 'font-body']) {
            const upload = async () => {
              await page!.evaluate((kind) => {
                const input = document.querySelector<HTMLInputElement>(
                  `input[data-branding-upload=${kind}]`,
                )!
                const transfer = new DataTransfer()
                transfer.items.add(
                  new File(['fixture-file'], kind.startsWith('font') ? 'test.woff2' : 'test.svg', {
                    type: 'image/svg+xml',
                  }),
                )
                input.files = transfer.files
                input.dispatchEvent(new Event('change', { bubbles: true }))
              }, { args: [kind] })
              await settle(page!)
            }
            await explicitAction(upload, `upload-${kind}`)
            expect(brandingUploads.at(-1)).toEqual({
              path: `/api/admin/t/alpha/branding/${kind}`,
              contentType: kind.startsWith('font') ? 'font/woff2' : 'image/svg+xml',
              bytes: 12,
            })
            await page!.evaluate((kind) => {
              const input = document.querySelector(`input[data-branding-upload=${kind}]`)!
              input.parentElement!.parentElement!.scrollIntoView({ block: 'start' })
            }, { args: [kind] })
            await capture(`appearance-upload-${kind}-${palette}-${width}`)
          }
          await click(page!, '[aria-label="Square shape"]')
          state.status = 500
          const failureStart = requests.length
          await click(page!, '[data-appearance-save=shape]')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          await capture(`appearance-failed-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          await settle(page!)
          expect(requests.length).toBe(failureStart + 1)
          state.status = 200
        }
      }
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          taxonomyPopulated = true
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Taxonomy')
          await page!.waitForSelector('#ls-region-title')
          const before = requests.length
          await fill(page!, '#ls-region-title', 'Research region')
          await clickText(page!, 'Remove')
          await clickText(page!, 'Save')
          await page!.waitForSelector('[role=dialog]')
          await capture(`taxonomy-prompt-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          expect(requests.length).toBe(before)
          expect(
            await page!.evaluate(() =>
              document.querySelector<HTMLInputElement>('#ls-region-title')!.value
            ),
          ).toBe('Research region')
          await clickText(page!, 'Save')
          await confirm()
          expect(requests.length).toBe(before + 1)
          expect(taxonomyBodies.at(-1)).toEqual({
            title: 'Research region',
            multiple: false,
            labels: [{ title: 'South', text: '' }],
          })
          expect(await page!.evaluate(() => document.body.textContent)).toContain(
            'No labeller carries this set',
          )
          await page!.evaluate(() =>
            document.querySelector('#ls-region-title')!.scrollIntoView({ block: 'center' })
          )
          await capture(`taxonomy-editor-${palette}-${width}`)
          await fill(page!, '#ls-region-title', 'Uncertain region')
          state.status = 500
          await clickText(page!, 'Save')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          expect(await page!.evaluate(() => document.body.textContent)).toContain(
            'Check whether the action completed',
          )
          await click(page!, '[data-emergency-cancel]')
          await page!.evaluate(() => {
            dispatchEvent(new Event('fixture-invalidate'))
            dispatchEvent(new Event('focus'))
          })
          await settle(page!)
          expect(requests.length).toBe(before + 2)
          state.status = 200
          await clickText(page!, 'New label set')
          await fill(page!, '#ls-new-title', 'New region')
          await fill(page!, '#ls-new-label-0', 'West')
          await clickText(page!, 'Create label set')
          await click(page!, '[data-emergency-cancel]')
          await clickText(page!, 'Create label set')
          await confirm()
          expect(requests.length).toBe(before + 3)
          expect(requests.slice(before).every((r) => r.emergency)).toBe(true)
        }
      }
      taxonomyPopulated = false
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          for (
            const [section, action, selector, content] of [
              ['Overview', 'Refresh metrics', '[data-admin-metrics]', '1.5'],
              [
                'Insights',
                'Refresh insights',
                '[data-admin-insights]',
                'What evidence is missing?',
              ],
              ['Content', 'Scan corpus', '[data-admin-health]', 'Thin research page'],
            ]
          ) {
            const before = requests.length
            await clickText(page!, section!)
            await settle(page!)
            expect(requests.length).toBe(before)
            await clickText(page!, action!)
            await page!.waitForSelector('[role=dialog]')
            expect(requests.length).toBe(before)
            await click(page!, '[data-emergency-cancel]')
            expect(requests.length).toBe(before)
            await clickText(page!, action!)
            await confirm()
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            expect(requests.at(-1)?.emergency).toBe(true)
            expect(
              await page!.evaluate(
                (selector, content) =>
                  document.querySelector(selector)!.textContent!.includes(content),
                {
                  args: [selector!, content!],
                },
              ),
            ).toBe(true)
            await page!.evaluate(
              (selector) => document.querySelector(selector)!.scrollIntoView({ block: 'start' }),
              { args: [selector!] },
            )
            await capture(`reads-${section!.toLowerCase()}-${palette}-${width}`)
            if (section === 'Insights') {
              await page!.evaluate(() =>
                [...document.querySelectorAll('h4')].find((h) =>
                  h.textContent === 'Knowledge gaps'
                )!.scrollIntoView({ block: 'center' })
              )
              await capture(`reads-insights-detail-${palette}-${width}`)
            }
            const repeat = section === 'Content' ? 'Rescan corpus' : action!
            state.status = 500
            await clickText(page!, repeat)
            await confirm()
            await page!.waitForSelector('[role=dialog] [role=alert]')
            expect(requests.length).toBe(before + 2)
            expect(
              await page!.evaluate(
                (selector, content) =>
                  document.querySelector(selector)!.textContent!.includes(content),
                {
                  args: [selector!, content!],
                },
              ),
            ).toBe(true)
            await click(page!, '[data-emergency-cancel]')
            state.status = 200
            malformedRead = true
            await clickText(page!, repeat)
            await confirm()
            await page!.waitForSelector('[role=dialog] [role=alert]')
            expect(requests.length).toBe(before + 3)
            await click(page!, '[data-emergency-cancel]')
            malformedRead = false
            if (section === 'Content') {
              for (const visibility of ['Hide', 'Publish']) {
                const beforeToggle = requests.length
                await clickText(page!, visibility)
                await page!.waitForSelector('[role=dialog]')
                await click(page!, '[data-emergency-cancel]')
                expect(requests.length).toBe(beforeToggle)
                await clickText(page!, visibility)
                await confirm()
                await settle(page!)
                expect(requests.length).toBe(beforeToggle + 1)
                expect(requests.at(-1)?.path.endsWith('/hidden')).toBe(true)
              }
              await clickText(page!, '1 healthy resource')
            }
            const beforeBackground = requests.length
            await page!.evaluate(() => {
              dispatchEvent(new Event('fixture-invalidate'))
              dispatchEvent(new Event('focus'))
              dispatchEvent(new Event('fixture-inspect'))
            })
            await settle(page!)
            expect(requests.length).toBe(beforeBackground)
            expect(
              await page!.evaluate(() =>
                document.body.dataset.cache!.includes('one-request-test-value')
              ),
            ).toBe(false)
            expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
          }
          state.capability = 'disabled'
          await page!.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
          await page!.waitForSelector('[data-admin-unavailable]')
          expect(await page!.evaluate(() => document.querySelector('[data-admin-health]'))).toBe(
            null,
          )
        }
      }
      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          await open('manage', palette, width)
          await clickText(page!, 'Use emergency access')
          await confirm()
          await page!.waitForSelector('[data-admin-overview]')
          await clickText(page!, 'Content')
          const contentStart = requests.length
          await clickText(page!, 'Add content')
          await clickText(page!, 'Add link')
          await fill(page!, '#link-url-alpha', 'https://example.invalid/research')
          const submit = async (selector: string) => {
            await page!.evaluate(
              (selector) => document.querySelector(selector)!.closest('form')!.requestSubmit(),
              { args: [selector] },
            )
            await settle(page!)
          }
          const oneAction = async (action: () => Promise<void>, name: string) => {
            console.log(`Content action: ${name} ${palette} ${width}`)
            const before = requests.length
            await action()
            await page!.waitForSelector('[role=dialog]')
            expect(requests.length).toBe(before)
            await click(page!, '[data-emergency-cancel]')
            expect(requests.length).toBe(before)
            await action()
            await confirm()
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            expect(requests.at(-1)?.emergency).toBe(true)
            expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
            await page!.evaluate(() => {
              dispatchEvent(new Event('fixture-invalidate'))
              dispatchEvent(new Event('focus'))
            })
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            evidence.push({ action: name, palette, width, requests: 1 })
          }
          expect(requests.length).toBe(contentStart)
          await oneAction(() => submit('#link-url-alpha'), 'add-link')
          await fill(page!, '#link-url-alpha', 'https://example.invalid/failure')
          state.status = 500
          const beforeFailure = requests.length
          await submit('#link-url-alpha')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          expect(requests.length).toBe(beforeFailure + 1)
          expect(
            await page!.evaluate(() =>
              document.querySelector<HTMLInputElement>('#link-url-alpha')!.value
            ),
          ).toBe('https://example.invalid/failure')
          await click(page!, '[data-emergency-cancel]')
          state.status = 200
          await clickText(page!, 'Paste text')
          await fill(page!, '#text-title-alpha', 'Research note')
          await fill(page!, '#text-body-alpha', 'A research note for the portal.')
          await oneAction(() => submit('#text-title-alpha'), 'add-text')
          await clickText(page!, 'Upload file')
          const upload = async (count = 1) => {
            await page!.evaluate((count) => {
              const input = document.querySelector<HTMLInputElement>('input[type=file]')!
              const transfer = new DataTransfer()
              for (let i = 0; i < count; i++) {
                transfer.items.add(
                  new File(['Research content'], `research-${i}.txt`, { type: 'text/plain' }),
                )
              }
              input.files = transfer.files
              input.dispatchEvent(new Event('change', { bubbles: true }))
            }, { args: [count] })
            await settle(page!)
          }
          const beforeBulk = requests.length
          await upload(2)
          expect(requests.length).toBe(beforeBulk)
          expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
          await oneAction(() => upload(), 'upload-file')
          await clickText(page!, 'Crawl site')
          await fill(page!, '#crawl-url-alpha', 'https://example.invalid')
          await oneAction(() => submit('#crawl-url-alpha'), 'discover-crawl')
          expect(
            await page!.evaluate(() =>
              [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
                b.textContent?.includes('Ingest 2 selected')
              )?.disabled
            ),
          ).toBe(true)
          await page!.evaluate(() =>
            document.querySelector('#crawl-url-alpha')!.scrollIntoView({ block: 'center' })
          )
          await capture(`content-crawl-${palette}-${width}`)
          await fill(page!, '#source-url-alpha', 'https://example.invalid/research')
          await oneAction(() => submit('#source-url-alpha'), 'add-source')
          await oneAction(() => clickText(page!, 'Refresh sources'), 'read-sources')
          malformedResponse = {}
          await clickText(page!, 'Refresh sources')
          await confirm()
          await page!.waitForSelector('[role=dialog] [role=alert]')
          expect(await page!.evaluate(() => document.body.textContent)).toContain(
            'https://example.invalid/research',
          )
          await capture(`sources-malformed-${palette}-${width}`)
          await click(page!, '[data-emergency-cancel]')
          malformedResponse = undefined
          await oneAction(() => clickText(page!, 'Sync now'), 'sync-source')
          for (const malformed of [false, true]) {
            syncComplete = malformed
            syncMalformed = malformed
            await clickText(page!, 'Sync now')
            await confirm()
            await page!.waitForSelector('[role=dialog] [role=alert]')
            await click(page!, '[data-emergency-cancel]')
            expect(
              await page!.evaluate(() =>
                document.body.textContent!.includes('We could not confirm the result')
              ),
            ).toBe(true)
          }
          syncComplete = true
          syncMalformed = false
          await oneAction(async () => {
            await page!.evaluate(() => {
              const select = document.querySelector<HTMLSelectElement>('#source-cap-source-one')!
              select.value = '50'
              select.dispatchEvent(new Event('change', { bubbles: true }))
            })
            await settle(page!)
          }, 'update-source')
          await oneAction(async () => {
            await page!.evaluate(() =>
              document.querySelector<HTMLInputElement>('#source-cap-source-one')!.closest('li')!
                .querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
            )
            await settle(page!)
          }, 'source-auto')
          await page!.evaluate(() =>
            document.querySelector('#source-cap-source-one')!.scrollIntoView({ block: 'center' })
          )
          await capture(`content-sources-${palette}-${width}`)
          await oneAction(() => clickText(page!, 'Remove'), 'delete-source')
          await oneAction(() => clickText(page!, 'Refresh recent additions'), 'read-recent')
          await oneAction(() => clickText(page!, 'Hide'), 'hide-resource')
          recent[0]!.hidden = true
          await oneAction(() => clickText(page!, 'Refresh recent additions'), 'refresh-draft')
          await oneAction(() => clickText(page!, 'Publish'), 'publish-resource')
          recent[0]!.hidden = false
          const beforePoll = requests.length
          await new Promise((resolve) => setTimeout(resolve, 4200))
          await page!.evaluate(() => {
            dispatchEvent(new Event('fixture-invalidate'))
            dispatchEvent(new Event('focus'))
            dispatchEvent(new Event('fixture-inspect'))
          })
          await settle(page!)
          expect(requests.length).toBe(beforePoll)
          expect(
            await page!.evaluate(() =>
              document.body.dataset.cache!.includes('one-request-test-value')
            ),
          ).toBe(false)
          await page!.evaluate(() =>
            [...document.querySelectorAll('h3')].find((h) => h.textContent === 'Recent additions')!
              .scrollIntoView({ block: 'center' })
          )
          await capture(`content-recent-${palette}-${width}`)
        }
      }
      state.capability = 'session'
      await open('manage')
      await page!.waitForSelector('[data-admin-overview]')
      await clickText(page!, 'Content')
      await clickText(page!, 'Add content')
      const sessionStart = requests.length
      await page!.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('input[type=file]')!
        const transfer = new DataTransfer()
        for (let i = 0; i < 2; i++) transfer.items.add(new File(['Research'], `research-${i}.txt`))
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await settle(page!)
      expect(
        requests.slice(sessionStart).filter((r) => r.path.endsWith('/resources/upload')).length,
      ).toBe(2)
      expect(requests.slice(sessionStart).every((r) => !r.emergency)).toBe(true)
      await clickText(page!, 'Crawl site')
      await fill(page!, '#crawl-url-alpha', 'https://example.invalid')
      await clickText(page!, 'Discover')
      await settle(page!)
      state.status = 503
      const beforeBusy = requests.length
      await clickText(page!, 'Ingest 2 selected')
      await settle(page!)
      expect(requests.slice(beforeBusy).filter((r) => r.path.endsWith('/resources/link')).length)
        .toBe(1)
      expect(await page!.evaluate(() => document.body.textContent!.includes('remaining 1 link')))
        .toBe(true)
      state.status = 200
      const beforeSessionPoll = requests.length
      await new Promise((resolve) => setTimeout(resolve, 4200))
      await page!.evaluate(() => dispatchEvent(new Event('fixture-invalidate')))
      await settle(page!)
      expect(requests.length).toBeGreaterThan(beforeSessionPoll)
      expect(requests.slice(beforeSessionPoll).every((r) => !r.emergency)).toBe(true)
      expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      for (const kind of ['admin', 'manage', 'taxonomy']) {
        for (const palette of ['light', 'observatory']) {
          for (const width of [1440, 390]) {
            state.capability = 'enabled'
            state.status = 200
            const current = await open(kind, palette, width)
            if (kind === 'taxonomy') {
              await current.waitForSelector('#taxonomy-name')
              await fill(current, '#taxonomy-name', 'Region')
              await clickText(current, 'Add category')
            } else await clickText(current, 'Use emergency access')
            await current.waitForSelector('[role=dialog]')
            await capture(`${kind}-${palette}-${width}-prompt`)
            const before = requests.length
            await click(current, '[data-emergency-cancel]')
            expect(requests.length).toBe(before)
            if (kind === 'taxonomy') await clickText(current, 'Add category')
            else await clickText(current, 'Use emergency access')
            await confirm()
            await current.waitForSelector(
              kind === 'taxonomy' ? '#taxonomy-name' : '[data-admin-overview]',
            )
            await settle(current)
            expect(requests.filter((r) => r.emergency).length).toBe(
              requests.slice(0, before).filter((r) => r.emergency).length + 1,
            )
            const after = requests.length
            await current.evaluate(() => {
              dispatchEvent(new Event('fixture-invalidate'))
              dispatchEvent(new Event('focus'))
              dispatchEvent(new Event('fixture-inspect'))
            })
            await settle(current)
            expect(requests.length).toBe(after)
            expect(await current.evaluate(() => document.body.dataset.cache)).not.toContain(
              'one-request-test-value',
            )
            expect(await current.evaluate(() => document.body.dataset.cache)).not.toContain(
              'legacy-test-value',
            )
            await capture(`${kind}-${palette}-${width}-result`)
            malformedResponse = kind === 'taxonomy' ? {} : null
            if (kind === 'taxonomy') {
              await fill(current, '#taxonomy-name', 'Preserved category')
              await clickText(current, 'Add category')
            } else await clickText(current, 'Use emergency access')
            await confirm()
            await current.waitForSelector('[role=dialog] [role=alert]')
            if (kind === 'taxonomy') {
              expect(
                await current.evaluate(() =>
                  document.querySelector<HTMLInputElement>('#taxonomy-name')?.value
                ),
              ).toBe('Preserved category')
            } else {
              expect(
                await current.evaluate(() =>
                  Boolean(document.querySelector('[data-admin-overview]'))
                ),
              ).toBe(true)
            }
            await capture(`${kind}-malformed-${palette}-${width}`)
            await click(current, '[data-emergency-cancel]')
            malformedResponse = undefined
            state.capability = 'disabled'
            await current.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
            await settle(current)
            await current.waitForSelector(kind === 'taxonomy' ? 'h1' : '[data-admin-unavailable]')
            expect(await current.evaluate(() => document.querySelector('[data-admin-overview]')))
              .toBe(null)
            await current.evaluate(() => dispatchEvent(new Event('fixture-inspect')))
            expect(await current.evaluate(() => document.body.dataset.cache)).not.toContain(
              'Protected alpha',
            )
          }
        }
      }
      for (const status of [401, 429, 500]) {
        state.capability = 'enabled'
        state.status = status
        const current = await open('admin')
        await clickText(current, 'Use emergency access')
        await confirm()
        await current.waitForSelector('[role=dialog] [role=alert]')
        await capture(`admin-${status}-result`)
        expect(await current.evaluate(() => document.querySelector('[data-admin-overview]'))).toBe(
          null,
        )
      }
      state.capability = 'enabled'
      state.status = 200
      await open('admin')
      await clickText(page!, 'Use emergency access')
      await confirm()
      await page!.waitForSelector('[data-admin-overview]')
      await clickText(page!, 'Add a knowledge box')
      await fill(page!, '#portal-name', 'Example portal')
      let before = requests.length
      await clickText(page!, 'Add portal')
      await page!.waitForSelector('[role=dialog]')
      await click(page!, '[data-emergency-cancel]')
      expect(requests.length).toBe(before)
      expect(
        await page!.evaluate(() => document.querySelector<HTMLInputElement>('#portal-name')?.value),
      ).toBe('Example portal')
      state.status = 500
      await clickText(page!, 'Add portal')
      await confirm()
      await page!.waitForSelector('[role=dialog] [role=alert]')
      expect(await page!.evaluate(() => Boolean(document.querySelector('[data-admin-overview]'))))
        .toBe(true)
      await click(page!, '[data-emergency-cancel]')
      state.status = 200
      for (const malformed of [null, {}, { ok: false }]) {
        malformedResponse = malformed
        await clickText(page!, 'Add portal')
        await confirm()
        await page!.waitForSelector('[role=dialog] [role=alert]')
        expect(
          await page!.evaluate(() =>
            document.querySelector<HTMLInputElement>('#portal-name')?.value
          ),
        ).toBe('Example portal')
        await click(page!, '[data-emergency-cancel]')
      }
      malformedResponse = undefined
      before = requests.length
      await clickText(page!, 'Add portal')
      await confirm()
      await settle(page!)
      expect(requests.length).toBe(before + 1)
      expect(requests.at(-1)?.method).toBe('POST')
      expect(
        await page!.evaluate(() => document.querySelector<HTMLInputElement>('#portal-name')?.value),
      ).toBe('')
      state.delayMs = 300
      await clickText(page!, 'Use emergency access')
      await confirm()
      await page!.waitForSelector('[role=dialog][aria-busy=true]')
      await capture('admin-pending')
      state.capability = 'disabled'
      await page!.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page!.waitForSelector('[data-admin-unavailable]')
      await capture('admin-disabled')
      state.delayMs = 0
      state.status = 200
      state.capability = 'session'
      await open('admin')
      await page!.waitForSelector('[data-admin-overview]')
      expect(requests.at(-1)?.emergency).toBe(false)
      await clickText(page!, 'Add a knowledge box')
      await fill(page!, '#portal-name', 'Example portal')
      before = requests.length
      await clickText(page!, 'Add portal')
      await settle(page!)
      expect(requests.slice(before).some((r) => r.method === 'POST' && !r.emergency)).toBe(true)
      expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)

      for (
        const action of [
          'Create new box',
          'Verify and connect',
          'Revert to demo box',
          'Disable',
          'Enable',
          'Remove',
          'Run migration',
        ]
      ) {
        for (const palette of ['light', 'observatory']) {
          for (const width of [1440, 390]) {
            state.capability = 'enabled'
            state.status = 200
            rows[0]!.knowledgeBox.status = action === 'Create new box' ? 'demo' : 'connected'
            rows[0]!.disabled = action === 'Enable'
            await open('admin', palette, width)
            await clickText(page!, 'Use emergency access')
            await confirm()
            await page!.waitForSelector('[data-admin-overview]')
            if (action === 'Run migration') {
              await clickText(page!, 'Migrate resources')
              await page!.evaluate(() => {
                for (const [id, value] of [['migrate-from', 'alpha'], ['migrate-to', 'beta']]) {
                  const select = document.getElementById(id!) as HTMLSelectElement
                  select.value = value!
                  select.dispatchEvent(new Event('change', { bubbles: true }))
                }
              })
            } else {
              await clickText(page!, 'Protected alpha')
              if (action === 'Verify and connect') {
                await fill(page!, '#kb-id-alpha', 'https://example.invalid/api/v1/kb/example')
                await fill(page!, '#kb-token-alpha', 'fixture-service-key')
              }
            }
            await page!.evaluate(() => {
              globalThis.confirm = () => true
            })
            malformedResponse = action === 'Run migration' ? undefined : {}
            migrationMalformed = action === 'Run migration'
            const failedBefore = requests.length
            await clickText(page!, action)
            await confirm()
            await page!.waitForSelector('[role=dialog] [role=alert]')
            expect(requests.length).toBe(failedBefore + 1)
            if (action === 'Verify and connect') {
              expect(
                await page!.evaluate(() =>
                  document.querySelector<HTMLInputElement>('#kb-id-alpha')?.value
                ),
              ).toBe('https://example.invalid/api/v1/kb/example')
            }
            await capture(
              `malformed-${action.toLowerCase().replaceAll(' ', '-')}-${palette}-${width}`,
            )
            await click(page!, '[data-emergency-cancel]')
            malformedResponse = undefined
            migrationMalformed = false
            const before = requests.length
            await clickText(page!, action)
            // Before migration, these controls send session requests instead of opening a prompt.
            expect(requests.length).toBe(before)
            await page!.waitForSelector('[role=dialog]')
            const name = `${action.toLowerCase().replaceAll(' ', '-')}-${palette}-${width}`
            await capture(`${name}-prompt`)
            await click(page!, '[data-emergency-cancel]')
            expect(requests.length).toBe(before)
            await clickText(page!, action)
            await confirm()
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            expect(requests.at(-1)?.emergency).toBe(true)
            expect(await page!.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
            await page!.evaluate(() => dispatchEvent(new Event('fixture-invalidate')))
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            await page!.evaluate((migration) => {
              document.querySelector(migration ? '#migrate-from' : '#kb-id-alpha')?.scrollIntoView({
                block: 'center',
              })
            }, { args: [action === 'Run migration'] })
            await capture(`${name}-result`)
            if (action === 'Run migration') {
              expect(await page!.evaluate(() => document.body.textContent)).toContain(
                'Copied 1, skipped 0, 0 errors.',
              )
              state.status = 500
              const failedBefore = requests.length
              await clickText(page!, action)
              await confirm()
              await page!.waitForSelector('[role=dialog] [role=alert]')
              expect(requests.length).toBe(failedBefore + 1)
              expect(await page!.evaluate(() => document.body.textContent)).not.toContain(
                'Copied 1, skipped 0, 0 errors.',
              )
              await capture(`${name}-uncertain`)
              await click(page!, '[data-emergency-cancel]')
              state.status = 200
              migrationComplete = false
              await clickText(page!, action)
              await confirm()
              await page!.waitForSelector('[role=dialog] [role=alert]')
              expect(await page!.evaluate(() => document.body.textContent)).not.toContain(
                'Copied 1, skipped 0, 0 errors.',
              )
              migrationComplete = true
              await click(page!, '[data-emergency-cancel]')
              migrationLateError = true
              await clickText(page!, action)
              await confirm()
              await page!.waitForSelector('[role=dialog] [role=alert]')
              expect(await page!.evaluate(() => document.body.textContent)).not.toContain(
                'Copied 1, skipped 0, 0 errors.',
              )
              await click(page!, '[data-emergency-cancel]')
              migrationLateError = false
            }
          }
        }
      }
      for (const kind of ['admin', 'manage']) {
        for (const palette of ['light', 'observatory']) {
          for (const width of [1440, 390]) {
            state.capability = 'enabled'
            state.status = 200
            await open(kind, palette, width)
            await clickText(page!, 'Use emergency access')
            await confirm()
            await page!.waitForSelector('[data-admin-overview]')
            await clickText(page!, kind === 'admin' ? 'Protected alpha' : 'Details')
            await clickText(page!, 'Rename')
            await fill(page!, '#rename-name-alpha', 'Renamed portal')
            await fill(page!, '#rename-org-alpha', 'Renamed organisation')
            await fill(page!, '#rename-tagline-alpha', 'Renamed tagline')
            const name = `rename-${kind}-${palette}-${width}`
            await page!.evaluate(() =>
              document.querySelector('#rename-name-alpha')?.closest('form')?.scrollIntoView({
                block: 'center',
              })
            )
            await capture(`${name}-form`)
            const before = requests.length
            await clickText(page!, 'Save')
            expect(requests.length).toBe(before)
            await page!.waitForSelector('[role=dialog]')
            await capture(`${name}-prompt`)
            await click(page!, '[data-emergency-cancel]')
            expect(requests.length).toBe(before)
            expect(
              await page!.evaluate(() =>
                document.querySelector<HTMLInputElement>('#rename-name-alpha')?.value
              ),
            ).toBe('Renamed portal')
            await clickText(page!, 'Save')
            await confirm()
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            expect(requests.at(-1)).toEqual({
              path: '/api/admin/tenants/alpha',
              method: 'PATCH',
              emergency: true,
            })
            expect(renameBodies.at(-1)).toEqual({
              name: 'Renamed portal',
              organisation: 'Renamed organisation',
              tagline: 'Renamed tagline',
            })
            expect(await page!.evaluate(() => document.querySelector('#rename-name-alpha'))).toBe(
              null,
            )
            await page!.evaluate(() => dispatchEvent(new Event('fixture-invalidate')))
            await settle(page!)
            expect(requests.length).toBe(before + 1)
            await capture(`${name}-result`)
            await clickText(page!, 'Rename')
            for (const status of [401, 500, 200]) {
              state.status = status
              renameOk = false
              await clickText(page!, 'Save')
              await confirm()
              await page!.waitForSelector('[role=dialog] [role=alert]')
              expect(
                await page!.evaluate(() => Boolean(document.querySelector('#rename-name-alpha'))),
              ).toBe(true)
              const message = await page!.evaluate(() =>
                document.querySelector('[role=dialog] [role=alert]')?.textContent
              )
              expect(message).toContain(
                status === 401 ? 'not accepted' : 'could not confirm the result',
              )
              await capture(`${name}-${status}-failure`)
              await click(page!, '[data-emergency-cancel]')
            }
            renameOk = true
          }
        }
      }
      state.status = 200
      state.capability = 'session'
      await open('admin')
      await page!.waitForSelector('[data-admin-overview]')
      await page!.evaluate(() => {
        dispatchEvent(new Event('fixture-seed-protected'))
        dispatchEvent(new Event('fixture-inspect'))
      })
      expect(await page!.evaluate(() => document.body.dataset.cache)).toContain(
        'Prior identity private suggestion',
      )
      sessionIdentity = 'replacement-user'
      state.delayMs = 300
      await page!.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page!.waitForSelector('body[data-auth-id=replacement-user]')
      await settle(page!)
      expect(await page!.evaluate(() => document.querySelector('[data-admin-overview]'))).toBe(null)
      await page!.evaluate(() => dispatchEvent(new Event('fixture-inspect')))
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain('original-user')
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain(
        'Prior identity private suggestion',
      )
      await page!.evaluate(() => {
        dispatchEvent(new Event('fixture-seed-protected'))
        dispatchEvent(new Event('fixture-inspect'))
      })
      expect(await page!.evaluate(() => document.body.dataset.cache)).toContain(
        'Prior identity private suggestion',
      )
      state.capability = 'disabled'
      await page!.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page!.waitForSelector('body[data-auth-id=anonymous]')
      await settle(page!)
      expect(await page!.evaluate(() => document.querySelector('[data-admin-overview]'))).toBe(null)
      await page!.evaluate(() => dispatchEvent(new Event('fixture-inspect')))
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain(
        'Protected alpha',
      )
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain(
        'Prior identity private suggestion',
      )
      state.delayMs = 0
    } finally {
      await Deno.writeTextFile(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2))
      await page?.close()
      await browser.close()
      await proxy.shutdown()
      await base.close()
      await Deno.remove(`${directory}/source.tsx`)
      await Deno.remove(`${directory}/entry.js`)
    }
    console.log(`Administration page evidence: ${directory}/evidence.json`)
  },
})

Deno.test({
  name: 'emergency access real component, one request, accessible themes and fresh assets',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const marker = `emergency-${crypto.randomUUID()}`
    const directory = `.planning/logs/02-09-fixture-${marker}`
    await Deno.mkdir(directory, { recursive: true })
    const command = await new Deno.Command('esbuild', {
      args: [
        'e2e/support/emergency-access-entry.tsx',
        '--bundle',
        '--format=esm',
        '--jsx=automatic',
        `--outfile=${directory}/entry.js`,
        '--alias:@research-portal/core=./packages/core/src/index.ts',
        '--external:react',
        '--external:react/jsx-runtime',
        '--external:react-dom',
        '--external:react-dom/client',
        '--external:@tanstack/react-query',
        '--external:zod',
        `--define:__EMERGENCY_FIXTURE_BUILD__=${JSON.stringify(marker)}`,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    expect(command.success, new TextDecoder().decode(command.stderr)).toBe(true)
    const appHash = await digest(await Deno.readFile('apps/web/dist/app.js'))
    const fixtureHash = await digest(await Deno.readFile(`${directory}/entry.js`))
    const stamp = JSON.parse(await Deno.readTextFile('apps/web/dist/build.json'))
    expect(browserRunStartedAt - Date.parse(stamp.builtAt)).toBeLessThan(180_000)
    expect(Date.parse(stamp.builtAt)).toBeLessThanOrEqual(browserRunStartedAt)
    const state: EmergencyFixtureState = {
      capability: 'enabled',
      status: 200,
      requests: 0,
      credentialRequests: 0,
      delayMs: 0,
    }
    const server = startTestServer({ emergencyFixture: { directory, state } })
    const browser = await launch({
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    })
    const evidence: unknown[] = []
    let page: Page | undefined
    try {
      page = await browser.newPage(`${server.url}/__test/emergency-access`)
      await page.waitForSelector('[data-fixture-ready]')
      const fresh = await page.evaluate(async () => {
        async function hash(path: string) {
          const bytes = await (await fetch(path, { cache: 'no-store' })).arrayBuffer()
          return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((v) => v.toString(16).padStart(2, '0')).join('')
        }
        return {
          appHash: await hash('/app.js'),
          fixtureHash: await hash('/__test/emergency-access.js'),
          stamp: await (await fetch('/build.json', { cache: 'no-store' })).json(),
          marker: document.querySelector('[data-fixture-build]')?.getAttribute(
            'data-fixture-build',
          ),
        }
      })
      expect(fresh).toEqual({ appHash, fixtureHash, stamp, marker })
      evidence.push({ freshness: fresh })
      await page.close()
      page = undefined

      for (const palette of ['light', 'observatory']) {
        for (const width of [1440, 390]) {
          state.capability = 'enabled'
          state.status = 200
          page = await browser.newPage(`${server.url}/__test/emergency-access?palette=${palette}`)
          await page.setViewportSize({ width, height: 1000 })
          await page.waitForSelector('#emergency-entry')
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '22px'
          })
          await click(page, '#emergency-entry')
          await page.waitForSelector('[role=dialog] input')
          await settle(page)
          const metrics = await page.evaluate(() => {
            const dialog = document.querySelector<HTMLElement>('[role=dialog]')!
            const input = dialog.querySelector('input')!
            const button = dialog.querySelector<HTMLElement>('[type=submit]')!
            const surface = getComputedStyle(dialog)
            const probe = document.createElement('span')
            probe.style.cssText =
              'background:var(--rp-surface);border-radius:var(--rp-radius);font-family:var(--rp-font-body);color:var(--rp-ink)'
            dialog.append(probe)
            const tokens = getComputedStyle(probe)
            const result = {
              width: innerWidth,
              overflow: document.documentElement.scrollWidth - innerWidth,
              rootFont: getComputedStyle(document.documentElement).fontSize,
              focused: document.activeElement === input,
              radius: surface.borderRadius,
              tokenRadius: tokens.borderRadius,
              background: surface.backgroundColor,
              tokenBackground: tokens.backgroundColor,
              font: surface.fontFamily,
              tokenFont: tokens.fontFamily,
              density: surface.getPropertyValue('--rp-density').trim(),
              buttonOverflow: button.scrollHeight - button.clientHeight,
              dialogLeft: dialog.getBoundingClientRect().left,
              dialogRight: dialog.getBoundingClientRect().right,
            }
            probe.remove()
            return result
          })
          expect(metrics.width).toBe(width)
          expect(metrics.overflow).toBeLessThanOrEqual(1)
          expect(metrics.rootFont).toBe('22px')
          expect(metrics.focused).toBe(true)
          expect(metrics.radius).toBe(metrics.tokenRadius)
          expect(metrics.background).toBe(metrics.tokenBackground)
          expect(metrics.font).toBe(metrics.tokenFont)
          expect(metrics.buttonOverflow).toBeLessThanOrEqual(1)
          expect(metrics.dialogLeft).toBeGreaterThanOrEqual(0)
          expect(metrics.dialogRight).toBeLessThanOrEqual(width)
          const screenshot = `${directory}/${palette}-${width}-prompt.png`
          await Deno.writeFile(screenshot, await page.screenshot())
          evidence.push({ palette, ...metrics, screenshot })
          await page.keyboard.down('Shift')
          await page.keyboard.press('Tab')
          await page.keyboard.up('Shift')
          expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Cancel')
          await page.keyboard.press('Tab')
          expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT')
          for (let i = 0; i < 5; i++) await page.keyboard.press('Tab')
          expect(
            await page.evaluate(() =>
              document.querySelector('[role=dialog]')!.contains(document.activeElement)
            ),
          ).toBe(true)
          const before = state.requests
          await page.keyboard.press('Escape')
          await settle(page)
          expect(state.requests).toBe(before)
          expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
          expect(await page.evaluate(() => document.activeElement?.id)).toBe('emergency-entry')
          await Deno.writeFile(
            `${directory}/${palette}-${width}-cancelled.png`,
            await page.screenshot(),
          )
          await page.close()
          page = undefined
        }
      }

      for (const capability of ['disabled', 'unknown', 'failed', 'loading'] as const) {
        state.capability = capability
        page = await browser.newPage(`${server.url}/__test/emergency-access`)
        await page.waitForSelector('[data-fixture-mounted]')
        if (capability !== 'loading') await page.waitForSelector('[data-fixture-ready]')
        expect(await page.evaluate(() => document.querySelector('#emergency-entry'))).toBe(null)
        expect(await page.evaluate(() => document.querySelector('input[type=password]'))).toBe(null)
        await Deno.writeFile(`${directory}/${capability}.png`, await page.screenshot())
        await page.close()
        page = undefined
      }

      state.capability = 'enabled'
      for (const status of [401, 403, 429, 500, 200]) {
        state.status = status
        state.delayMs = 700
        const before = state.requests
        page = await browser.newPage(`${server.url}/__test/emergency-access?palette=observatory`)
        await page.setViewportSize({ width: 390, height: 1000 })
        await page.waitForSelector('#emergency-entry')
        await click(page, '#emergency-entry')
        await (await page.waitForSelector('input[type=password]')).type('fixture-only-value')
        await page.evaluate(() => {
          const form = document.querySelector('form')!
          form.requestSubmit()
          form.requestSubmit()
        })
        await page.waitForSelector('[aria-busy=true]')
        expect(
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-emergency-cancel]')!.disabled
          ),
        ).toBe(true)
        await page.keyboard.press('Escape')
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe(
          'dialog',
        )
        expect(await page.evaluate(() => document.querySelectorAll('[role=dialog]').length)).toBe(1)
        expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input')!.value))
          .toBe('')
        await Deno.writeFile(`${directory}/${status}-pending.png`, await page.screenshot())
        await page.waitForSelector(status === 200 ? '[data-outcome=completed]' : '[role=alert]')
        expect(state.requests).toBe(before + 1)
        const message = await page.evaluate(() =>
          document.querySelector('[role=alert]')?.textContent ?? ''
        )
        if (status === 429) expect(message).toContain('3 minutes')
        if (status === 401 || status === 403) expect(message).toContain('was not accepted')
        if (status === 500) expect(message).toContain('Check whether the action completed')
        await Deno.writeFile(`${directory}/${status}-result.png`, await page.screenshot())
        expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not
          .toContain('fixture-only-value')
        expect(await page.evaluate(() => location.href)).not.toContain('fixture-only-value')
        if (status !== 200) {
          expect(
            await page.evaluate(() =>
              document.activeElement?.hasAttribute('data-emergency-cancel')
            ),
          ).toBe(true)
          expect(
            await page.evaluate(() =>
              document.querySelector<HTMLButtonElement>('[type=submit]')!.disabled
            ),
          ).toBe(true)
          await click(page, '[data-emergency-cancel]')
        }
        await page.close()
        page = undefined
      }

      state.delayMs = 0
      state.status = 200
      // Losing capability during dispatch is uncertain, never a zero-request cancellation.
      state.capability = 'enabled'
      state.delayMs = 1000
      page = await browser.newPage(`${server.url}/__test/emergency-access`)
      await page.waitForSelector('#emergency-entry')
      const beforeLoss = state.requests
      await click(page, '#emergency-entry')
      await (await page.waitForSelector('input[type=password]')).type('fixture-only-value')
      await click(page, '[type=submit]')
      await page.waitForSelector('[aria-busy=true]')
      state.capability = 'disabled'
      await page.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page.waitForSelector('[data-outcome=failed]')
      expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      state.capability = 'enabled'
      await page.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await click(page, '#emergency-entry')
      await settle(page)
      expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      expect(state.requests).toBe(beforeLoss + 1)
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)))
      await click(page, '#emergency-entry')
      await page.waitForSelector('input[type=password]')
      expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input')!.value))
        .toBe('')
      await click(page, '[data-emergency-cancel]')
      evidence.push({ scenario: 'pending-capability-loss', requests: state.requests - beforeLoss })
      await page.close()
      page = undefined
      state.delayMs = 0
      for (
        const scenario of [
          'cancel',
          'batch',
          'network',
          'capability-loss',
          'session',
          'unmount',
          'stack',
        ]
      ) {
        state.capability = scenario === 'session' ? 'session' : 'enabled'
        page = await browser.newPage(`${server.url}/__test/emergency-access?scenario=${scenario}`)
        await page.waitForSelector('[data-fixture-ready]')
        const before = state.requests
        if (scenario === 'session') {
          const credentials = state.credentialRequests
          await click(page, '#session-action')
          await page.waitForSelector('[data-outcome=completed]')
          expect(state.requests).toBe(before + 1)
          expect(state.credentialRequests).toBe(credentials)
          expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
        } else {
          await click(page, '#emergency-entry')
          await (await page.waitForSelector('input[type=password]')).type('fixture-only-value')
          if (scenario === 'cancel') {
            await click(page, '[data-emergency-cancel]')
          } else if (scenario === 'unmount') {
            expect(
              await page.evaluate(async () => {
                const input = document.querySelector<HTMLInputElement>('input')!
                dispatchEvent(new Event('fixture-unmount'))
                await new Promise<void>((resolve) => {
                  const detached = () =>
                    input.isConnected ? requestAnimationFrame(detached) : resolve()
                  detached()
                })
                return input.value
              }),
            ).toBe('')
          } else if (scenario === 'stack') {
            await page.evaluate(() => document.getElementById('emergency-entry')!.click())
            expect(await page.evaluate(() => document.querySelectorAll('[role=dialog]').length))
              .toBe(1)
            await click(page, '[data-emergency-cancel]')
          } else if (scenario === 'capability-loss') {
            state.capability = 'disabled'
            await page.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
            await page.waitForSelector('[data-outcome=cancelled]')
          } else {
            if (scenario === 'network') {
              await page.evaluate(() => {
                const original = fetch
                globalThis.fetch = (input, init) =>
                  String(input).includes('__test/emergency-action')
                    ? Promise.reject(new TypeError('Network unavailable'))
                    : original(input, init)
              })
            }
            await click(page, '[type=submit]')
            await page.waitForSelector('[role=alert]')
          }
          expect(state.requests).toBe(before + (scenario === 'batch' ? 1 : 0))
          expect(
            await page.evaluate(() =>
              document.querySelector<HTMLInputElement>('input')?.value ?? ''
            ),
          ).toBe('')
        }
        evidence.push({ scenario, requests: state.requests - before })
        await page.close()
        page = undefined
      }
      state.capability = 'enabled'
      state.status = 403
      page = await browser.newPage(`${server.url}/__test/emergency-access`)
      await page.waitForSelector('#emergency-entry')
      await page.evaluate(async () => {
        await fetch('/api/admin/__test/emergency-action')
        await fetch('/auth/me')
        dispatchEvent(new Event('focus'))
      })
      expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      evidence.push({ scenario: 'background-denial', prompts: 0 })
      await page.close()
      page = undefined
    } finally {
      await Deno.writeTextFile(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2))
      await page?.close()
      await browser.close()
      await server.close()
      await Deno.remove(`${directory}/entry.js`)
    }
    console.log(`Emergency access evidence: ${directory}/evidence.json`)
  },
})
