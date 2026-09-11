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
    const directory = `.planning/logs/02-11-${marker}`
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
 const inspect = () => { document.body.dataset.cache = JSON.stringify(client.getQueryCache().getAll().map(q => ({ key: q.queryKey, data: q.state.data }))) }
 const unsubscribe = client.getQueryCache().subscribe(() => { document.body.dataset.authId = client.getQueryData(['auth-session'])?.user?.id ?? 'anonymous' })
 addEventListener('fixture-refresh-capability', refresh)
 addEventListener('fixture-invalidate', invalidate)
 addEventListener('fixture-inspect', inspect)
 return () => { unsubscribe(); removeEventListener('fixture-refresh-capability', refresh); removeEventListener('fixture-invalidate', invalidate); removeEventListener('fixture-inspect', inspect) }
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
    let renameOk = true
    let syncComplete = true
    let syncMalformed = false
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
      knowledgeBox: { status: 'connected', kbId: 'fixture-box' },
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
          return Response.json({ paragraphs: 12, sentences: 24, indexMb: 1.5 })
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
              { type: 'done', copied: 1, skipped: 0, errors: 0 },
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
          url.pathname === '/api/admin/overview'
            ? rows
            : { ok: true, id: 'region', slug: 'created', resourceCount: 7 },
        )
      }
      if (url.pathname.endsWith('/labelsets')) return Response.json([])
      if (url.pathname.endsWith('/facets')) return Response.json({})
      if (url.pathname.endsWith('/counters')) return Response.json({ resources: 7 })
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
      expect(metrics.controlOverflow).toBeLessThanOrEqual(1)
      const screenshot = `${directory}/${name}.png`
      await Deno.writeFile(screenshot, await page!.screenshot())
      evidence.push({ name, metrics, screenshot })
    }
    async function confirm() {
      await page!.waitForSelector('[role=dialog] input')
      await fill(page!, '[role=dialog] input', 'one-request-test-value')
      await click(page!, '[role=dialog] [type=submit]')
      await settle(page!)
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
      sessionIdentity = 'replacement-user'
      state.delayMs = 300
      await page!.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page!.waitForSelector('body[data-auth-id=replacement-user]')
      await settle(page!)
      expect(await page!.evaluate(() => document.querySelector('[data-admin-overview]'))).toBe(null)
      await page!.evaluate(() => dispatchEvent(new Event('fixture-inspect')))
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain('original-user')
      state.capability = 'disabled'
      await page!.evaluate(() => dispatchEvent(new Event('fixture-refresh-capability')))
      await page!.waitForSelector('body[data-auth-id=anonymous]')
      await settle(page!)
      expect(await page!.evaluate(() => document.querySelector('[data-admin-overview]'))).toBe(null)
      await page!.evaluate(() => dispatchEvent(new Event('fixture-inspect')))
      expect(await page!.evaluate(() => document.body.dataset.cache)).not.toContain(
        'Protected alpha',
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
