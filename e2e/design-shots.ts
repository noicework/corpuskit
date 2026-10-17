// ---------------------------------------------------------------------------
// Design-review screenshot harness. Not a test: run it with
//
//   deno task shots --out .shots/<name> [--profiles deep,bright] [--routes home,library]
//     [--schemes light,dark] [--widths 1440,390] [--font 16|22] [--concurrency 3] [--scale 1]
//     [--vendor-cache .shots/.vendor-cache] [--offline]        (`--help` lists every option)
//
// It boots the real API and the built SPA (apps/web/dist) through the e2e test server, with the
// fictional marine corpus of support/design-fixture.ts behind the retrieval and management
// surfaces, then captures every route under each appearance profile, colour scheme and width.
// Each capture writes `<out>/<profile>/<route>-<scheme>-<width>.png` (the viewport) and, for
// scrolling pages, `...-full.png`, and records its findings in `<out>/manifest.json`: horizontal
// overflow, undersized interactive targets, console errors and, when AXE_PATH names an
// axe.min.js, the axe-core WCAG 2.2 AA violations. The server listens from port 8931 upward
// (DS_PORT_BASE), clear of the agents' dev servers.
//
// No backend service is involved: no knowledge box, no model. The browser's only outbound
// requests are the SPA's vendor modules (esm.sh) and web fonts (Google Fonts), which are kept in
// a local cache after their first fetch, so later runs are byte-for-byte repeatable and need no
// network; `--offline` refuses any request the cache cannot answer. Every other outbound request
// is blocked and reported.
//
// The exit code is non-zero only when the harness itself fails (a route that never became ready
// after one retry, a crash), never for what the captures find.
// ---------------------------------------------------------------------------
import { type Browser, launch, type Page } from '@astral/astral'
import { type Branding, BrandingSchema, type TenantConfig } from '@research-portal/core'
import { startTestServer, type TestServer } from './support/test-server.ts'
import {
  DESIGN_ENTITY,
  DESIGN_QUESTION,
  DESIGN_RESOURCES,
  designManagement,
  DesignProvider,
} from './support/design-fixture.ts'

// ---------------------------------------------------------------------------
// Appearance profiles
// ---------------------------------------------------------------------------

interface Profile {
  /** Branding fields laid over the seed's own, from the seed each time so nothing carries over. */
  branding: Partial<Branding>
  /** `light-only`: a dark-ink logo with no dark variant. `both`: a logo for each scheme. */
  logo?: 'light-only' | 'both'
  /** Serve the portal in Japanese (its language policy defaults to `ja`). */
  japanese?: boolean
}

const DEEP: Profile = {
  branding: {
    paletteId: 'default',
    colours: { primary: '#3d1a4f', accent: '#8cc63f', heroFrom: '#2a1036', heroTo: '#3d1a4f' },
    shape: 'rounded',
    density: 'comfortable',
    typography: 'default',
  },
  logo: 'light-only',
}

const PROFILES: Record<string, Profile> = {
  deep: DEEP,
  bright: {
    branding: {
      paletteId: 'default',
      colours: { primary: '#00a651', accent: '#f2a900', heroFrom: '#1c1c1c', heroTo: '#00a651' },
      shape: 'rounded',
      density: 'comfortable',
    },
    logo: 'both',
  },
  serif: {
    branding: {
      paletteId: 'kiln',
      typography: 'custom',
      headingFontUrl: '/fonts/newsreader-normal-latin.woff2',
      bodyFontUrl: '/fonts/source-sans-3-normal-latin.woff2',
      shape: 'soft',
      density: 'spacious',
    },
  },
  observatory: { branding: { paletteId: 'observatory', shape: 'square', density: 'compact' } },
  corpuskit: { branding: { paletteId: 'corpuskit', shape: 'square', density: 'default' } },
  ja: { ...DEEP, japanese: true },
}

/** A fictional wordmark: the "Southern Waters" name beside a wave mark, in one ink. */
function wordmark(ink: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="56" viewBox="0 0 300 56">
  <g fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round">
    <circle cx="28" cy="28" r="22"/>
    <path d="M12 26c5-5 10-5 16 0s11 5 16 0"/>
    <path d="M12 35c5-5 10-5 16 0s11 5 16 0"/>
  </g>
  <text x="62" y="27" fill="${ink}" font-family="Helvetica, Arial, sans-serif" font-size="21"
    font-weight="700" letter-spacing="0.2">Southern Waters</text>
  <text x="62" y="46" fill="${ink}" font-family="Helvetica, Arial, sans-serif" font-size="12.5"
    letter-spacing="1.6">RESEARCH INSTITUTE</text>
</svg>`
}

/**
 * Apply a profile to the marine portal. The whole branding is replaced through `tenants.patch`
 * rather than `patchBranding`, which only carries the Manage-editable fields and would drop the
 * custom font URLs. Logos are written where an administrator's upload lands (the branding
 * directory), so the portal serves them from its own origin as it would in production.
 */
async function applyProfile(server: TestServer, seed: TenantConfig, profile: Profile) {
  server.tenants.patch('marine', {
    branding: BrandingSchema.parse({ ...seed.branding, ...profile.branding }),
    languagePolicy: profile.japanese
      ? { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] }
      : undefined,
  })
  const directory = `${server.directory}/branding`
  await Deno.mkdir(directory, { recursive: true })
  for (const kind of ['logo', 'logo-dark']) {
    await Deno.remove(`${directory}/marine-${kind}.svg`).catch(() => {})
  }
  if (profile.logo) await Deno.writeTextFile(`${directory}/marine-logo.svg`, wordmark('#18222e'))
  if (profile.logo === 'both') {
    await Deno.writeTextFile(`${directory}/marine-logo-dark.svg`, wordmark('#f4f7f9'))
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Route {
  path: string
  /** A selector that marks the page as rendered, or `text:` and words the page must show. */
  ready: string[]
  /** Something to do once the page is ready: open a menu, a dialog, a palette. */
  action?: (page: Page) => Promise<void>
  /** Only these widths (the mobile menu exists at 390 only). */
  widths?: number[]
  /** Capture a full-page image as well as the viewport (default true). */
  full?: boolean
  /** Extra settle time, for canvases that lay themselves out. */
  settle?: number
  /** A platform page, the same under every profile: captured under the first profile only. */
  platform?: boolean
}

const FIRST = DESIGN_RESOURCES[0]!.summary
const SECOND = DESIGN_RESOURCES[1]!.summary

const manage = (tab: string, ready: string): Route => ({
  path: `/t/marine/manage?tab=${tab}`,
  ready: ['main h1', ready],
})

const ROUTES: Record<string, Route> = {
  home: { path: '/t/marine', ready: ['main h1'] },
  library: { path: '/t/marine/library', ready: ['main h1', `text:${SECOND.title}`] },
  document: {
    path: `/t/marine/library/${FIRST.id}`,
    // The first resource is a PDF: wait for the reader's first rendered page.
    ready: ['main h1', '.rp-library-pdf-reader canvas'],
    settle: 1000,
  },
  graph: {
    path: '/t/marine/graph',
    ready: ['[data-graph-stage] canvas'],
    full: false,
    settle: 2500,
  },
  entity: {
    path: `/t/marine/entity/${encodeURIComponent(DESIGN_ENTITY)}`,
    ready: ['main h1', 'text:Reef Recruitment Monitoring Program'],
    settle: 1500,
  },
  ask: { path: '/t/marine/ask', ready: ['#ask-composer'] },
  answer: {
    path: `/t/marine/ask?ask=${encodeURIComponent(DESIGN_QUESTION)}`,
    ready: ['main table', 'answer'],
    // The thread follows the stream to its end; open it at the question, as a reader scrolling
    // back would, so the table and the first citations are in view.
    action: async (page) => {
      await page.evaluate(() => {
        for (
          let el = document.querySelector('main table')?.parentElement ?? null;
          el;
          el = el.parentElement
        ) {
          const overflow = getComputedStyle(el).overflowY
          if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) {
            el.scrollTo({ top: 0, behavior: 'instant' })
          }
        }
        scrollTo({ top: 0, behavior: 'instant' })
      })
    },
  },
  'answer-end': {
    path: `/t/marine/ask?ask=${encodeURIComponent(DESIGN_QUESTION)}`,
    ready: ['main table', 'answer'],
    full: false,
    settle: 600,
    // The end of the answer: its toolbar, the retrieved sources and the composer.
    action: async (page) => {
      await page.evaluate(() => {
        for (
          let el = document.querySelector('main table')?.parentElement ?? null;
          el;
          el = el.parentElement
        ) {
          const overflow = getComputedStyle(el).overflowY
          if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
          }
        }
        scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      })
    },
  },
  search: { path: '/t/marine/search?q=heatwave', ready: ['main h1', `text:${FIRST.title}`] },
  help: { path: '/t/marine/help', ready: ['main h1'] },
  how: { path: '/t/marine/how-it-works', ready: ['main h1'] },
  tools: { path: '/t/marine/tools', ready: ['[data-tools-page]', 'main h1'] },
  investigations: { path: '/t/marine/investigations', ready: ['main h1'] },
  notfound: { path: '/t/marine/no-such-page', ready: ['h1'] },
  'manage-overview': manage('overview', '[data-manage-counts]'),
  'manage-content': manage('content', '[data-admin-health]'),
  'manage-taxonomy': manage('taxonomy', 'main h2'),
  'manage-graph': manage('graph', '[data-graph-read=strategy]'),
  'manage-enrichments': manage('enrichments', '[data-enrichments-export]'),
  'manage-behaviour': manage('behaviour', '[data-behaviour-read=prompts]'),
  'manage-extraction': manage('extraction', '[data-extraction-read]'),
  'manage-appearance': manage('appearance', '[data-appearance-save=shape]'),
  'manage-details': manage('details', 'main h2'),
  'manage-connections': manage('connections', 'main h2'),
  'manage-access': manage('access', '[data-access-mode]'),
  'manage-audit': manage('audit', '[data-audit-results]'),
  admin: { path: '/admin', ready: ['h1', '[data-portal-row]'], platform: true },
  navsheet: {
    path: '/t/marine/library',
    ready: ['button.rp-navtoggle'],
    widths: [390],
    full: false,
    action: async (page) => {
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>('button.rp-navtoggle')!.click()
      )
      await waitFor(page, '#mobile-nav-sheet')
    },
  },
  palette: {
    path: '/t/marine/library',
    ready: ['main h1'],
    full: false,
    action: async (page) => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.down('Control')
      await page.keyboard.press('k')
      await page.keyboard.up('Control')
      await waitFor(page, '[role=dialog]')
    },
  },
  'delete-dialog': {
    path: '/t/marine/manage?tab=content',
    ready: ['main h1', '[data-admin-health]'],
    full: false,
    action: async (page) => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('main button')].find((
          el,
        ) => /^(Delete|削除)/.test(el.textContent?.trim() ?? ''))
        if (!button) throw new Error('No Delete button on the content tab')
        button.scrollIntoView({ block: 'center', behavior: 'instant' })
        button.click()
      })
      await waitFor(page, 'dialog[open] h2')
    },
  },
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const [key, value] = arg.slice(2).split(/=(.*)/s, 2)
    if (value !== undefined) out[key!] = value
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out[key!] = argv[++i]!
    else out[key!] = true
  }
  return out
}

function list(value: string | true | undefined, fallback: string[]): string[] {
  return typeof value === 'string'
    ? value.split(',').map((v) => v.trim()).filter(Boolean)
    : fallback
}

const args = parseArgs(Deno.args)
if (args.help) {
  console.log(
    'deno task shots --out .shots/<name> [--profiles deep,bright,serif,observatory]\n' +
      `  [--routes ${Object.keys(ROUTES).join(',')}]\n` +
      '  [--schemes light,dark] [--widths 1440,390] [--font 16|22] [--concurrency 3] [--scale 1]\n' +
      '  [--vendor-cache .shots/.vendor-cache] [--offline]\n' +
      `Profiles: ${Object.keys(PROFILES).join(', ')}. AXE_PATH=<axe.min.js> adds axe-core checks.`,
  )
  Deno.exit(0)
}
if (typeof args.out !== 'string') throw new Error('--out <directory> is required')
const OUT = args.out.replace(/\/$/, '')
const profileIds = list(args.profiles, ['deep', 'bright', 'serif', 'observatory'])
const routeIds = list(args.routes, Object.keys(ROUTES))
const schemes = list(args.schemes, ['light', 'dark'])
const widths = list(args.widths, ['1440', '390']).map(Number)
const fonts = list(args.font, ['16']).map(Number)
const concurrency = Math.max(1, Number(typeof args.concurrency === 'string' ? args.concurrency : 3))
const scale = Number(typeof args.scale === 'string' ? args.scale : 1)
if (!(scale >= 1 && scale <= 3)) throw new Error(`Bad scale: ${scale}`)
const vendorDir = typeof args['vendor-cache'] === 'string'
  ? args['vendor-cache']
  : '.shots/.vendor-cache'
const offline = args.offline === true
for (const id of profileIds) if (!PROFILES[id]) throw new Error(`Unknown profile: ${id}`)
for (const id of routeIds) if (!ROUTES[id]) throw new Error(`Unknown route: ${id}`)
for (const scheme of schemes) {
  if (scheme !== 'light' && scheme !== 'dark') throw new Error(`Unknown scheme: ${scheme}`)
}
for (const width of widths) {
  if (!(width >= 320 && width <= 3840)) throw new Error(`Bad width: ${width}`)
}
for (const font of fonts) if (!(font >= 10 && font <= 40)) throw new Error(`Bad font: ${font}`)

// ---------------------------------------------------------------------------
// Vendor cache and the outbound guard
// ---------------------------------------------------------------------------

const VENDOR_HOSTS = new Set(['esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com'])
const blockedHosts = new Set<string>()
let vendorFetched = 0
let vendorCached = 0

interface VendorEntry {
  url: string
  status: number
  headers: { name: string; value: string }[]
  body: string
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

async function cacheKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const vendorPending = new Map<string, Promise<VendorEntry | null>>()

function vendorEntry(url: string, userAgent: string): Promise<VendorEntry | null> {
  const pending = vendorPending.get(url)
  if (pending) return pending
  const load = (async () => {
    const path = `${vendorDir}/${await cacheKey(url)}.json`
    try {
      const entry = JSON.parse(await Deno.readTextFile(path)) as VendorEntry
      vendorCached++
      return entry
    } catch {
      if (offline) return null
    }
    const response = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: '*/*' },
      redirect: 'manual',
    })
    const headers = [{ name: 'access-control-allow-origin', value: '*' }]
    for (const name of ['content-type', 'location', 'cache-control']) {
      const value = response.headers.get(name)
      if (value) headers.push({ name, value })
    }
    const entry: VendorEntry = {
      url,
      status: response.status,
      headers,
      body: base64(new Uint8Array(await response.arrayBuffer())),
    }
    if (response.status < 500) {
      await Deno.mkdir(vendorDir, { recursive: true })
      await Deno.writeTextFile(path, JSON.stringify(entry))
    }
    vendorFetched++
    return entry
  })()
  vendorPending.set(url, load)
  return load
}

/**
 * Answer the page's https requests (the test server is plain http on 127.0.0.1, so its traffic
 * is never paused): vendor modules and fonts from the cache, anything else refused. Astral's own
 * interceptor reads bodies as text, which corrupts font files, so this speaks CDP directly.
 */
async function guardOutbound(page: Page) {
  const celestial = page.unsafelyGetCelestialBindings()
  celestial.addEventListener('Fetch.requestPaused', async (event) => {
    const { requestId, request } = event.detail
    try {
      const host = new URL(request.url).hostname
      if (VENDOR_HOSTS.has(host) && request.method === 'GET') {
        const headers = request.headers as Record<string, string | undefined>
        const entry = await vendorEntry(request.url, headers['User-Agent'] ?? '')
        if (entry) {
          await celestial.Fetch.fulfillRequest({
            requestId,
            responseCode: entry.status,
            responseHeaders: entry.headers,
            body: entry.body,
          })
          return
        }
      }
      blockedHosts.add(`${request.method} ${host}`)
      await celestial.Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' })
    } catch {
      await celestial.Fetch.failRequest({ requestId, errorReason: 'Failed' }).catch(() => {})
    }
  })
  await celestial.Fetch.enable({ patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] })
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

interface Tracked {
  browser: Browser
  page: Page
  /** Requests of the current page still loading, by id, with their URLs. */
  inflight: Map<string, string>
  errors: string[]
}

/**
 * One browser per worker: headless Chrome paints only its front tab, so tabs sharing a browser
 * hand back stale frames when they take turns at the screenshot.
 */
async function openPage(): Promise<Tracked> {
  const browser = await launch()
  const page = await browser.newPage()
  const tracked: Tracked = { browser, page, inflight: new Map(), errors: [] }
  const celestial = page.unsafelyGetCelestialBindings()
  celestial.addEventListener('Network.requestWillBeSent', (e) => {
    // A server-sent stream stays open by design, and Chrome never reports the favicon's end:
    // neither is page loading.
    if (e.detail.type === 'EventSource' || e.detail.request.url.endsWith('/favicon.ico')) return
    tracked.inflight.set(e.detail.requestId, e.detail.request.url)
  })
  celestial.addEventListener('Network.loadingFinished', (e) => {
    tracked.inflight.delete(e.detail.requestId)
  })
  celestial.addEventListener('Network.loadingFailed', (e) => {
    tracked.inflight.delete(e.detail.requestId)
  })
  page.addEventListener('console', (e) => {
    if (e.detail.type === 'error') tracked.errors.push(e.detail.text.slice(0, 500))
  })
  page.addEventListener('pageerror', (e) => {
    tracked.errors.push(`Uncaught: ${String(e.detail.message).slice(0, 500)}`)
  })
  await guardOutbound(page)
  return tracked
}

/** An error's message; astral throws CDP exception details, which are plain objects. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  const details = error as { exception?: { description?: string }; text?: string } | null
  return details?.exception?.description?.split('\n')[0] ?? details?.text ?? String(error)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for a selector, a `text:` phrase, or the answer to finish, up to a deadline. */
async function waitFor(page: Page, ready: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const done = await page.evaluate((ready: string) => {
      if (ready === 'answer') {
        return !document.querySelector('[aria-busy="true"]') &&
          document.querySelectorAll('main sup').length >= 3
      }
      if (ready.startsWith('text:')) return document.body.innerText.includes(ready.slice(5))
      const element = document.querySelector(ready)
      return !!element && element.getBoundingClientRect().height > 0
    }, { args: [ready] })
    if (done) return
    await sleep(100)
  }
  throw new Error(`Not ready within ${timeoutMs / 1000}s: ${ready}`)
}

/** Wait until the access check has resolved (in either language). */
async function waitForAccess(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const checking = await page.evaluate(() =>
      /Checking access|アクセス権を確認中/.test(document.body?.innerText ?? '') ||
      !document.querySelector('#root')?.childElementCount
    )
    if (!checking) return
    await sleep(100)
  }
  throw new Error('The access check did not finish within 20s')
}

/**
 * Wait until no request has been in flight for `quietMs`, for at most `maxMs`. Returns the URLs
 * still loading when it gave up, which the manifest keeps.
 */
async function waitForQuiet(tracked: Tracked, quietMs = 400, maxMs = 8_000): Promise<string[]> {
  const deadline = Date.now() + maxMs
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    if (tracked.inflight.size > 0) quietSince = Date.now()
    else if (Date.now() - quietSince >= quietMs) return []
    await sleep(50)
  }
  return [...new Set(tracked.inflight.values())]
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const FULL_PAGE_CAP = 12_000

interface Target {
  label: string
  tag: string
  width: number
  height: number
}

/** Evaluated in the page, so it must not close over anything: the width comes in as an argument. */
function measure(width: number) {
  const doc = document.documentElement
  const interactive = [
    ...document.querySelectorAll<HTMLElement>(
      'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],' +
        '[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],' +
        '[tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => {
    if (el.closest('[inert],[aria-hidden="true"]')) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    // WCAG 2.5.8's inline exception: a link inside running text is sized by its line.
    const inline = el.tagName === 'A' && style.display === 'inline' &&
      !!el.parentElement?.closest('p,li,td,dd,blockquote,figcaption')
    return !inline
  })
  const labelOf = (el: HTMLElement) =>
    (el.getAttribute('aria-label') ?? el.textContent ?? el.getAttribute('title') ??
      el.getAttribute('placeholder') ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) ||
    `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}>`
  const under = (size: number) => {
    const small = interactive.map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => Math.min(r.width, r.height) < size)
    return {
      count: small.length,
      items: small.slice(0, 20).map(({ el, r }) => ({
        label: labelOf(el),
        tag: el.tagName.toLowerCase(),
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
      })),
    }
  }
  return {
    innerWidth,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    overflowX: doc.scrollWidth > doc.clientWidth + 1,
    height: Math.max(doc.scrollHeight, document.body.scrollHeight),
    targetsUnder24: under(24),
    targetsUnder44: width <= 480 ? under(44) : null,
    title: document.title,
    lang: doc.lang,
  }
}

const AXE_PATH = Deno.env.get('AXE_PATH')
const axeSource = AXE_PATH ? await Deno.readTextFile(AXE_PATH) : null

async function axe(page: Page) {
  if (!axeSource) return null
  await page.evaluate(`${axeSource};void 0`)
  return await page.evaluate(async () => {
    // deno-lint-ignore no-explicit-any
    const runner = (globalThis as any).axe
    const result = await runner.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    })
    // deno-lint-ignore no-explicit-any
    return result.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      count: v.nodes.length,
      // deno-lint-ignore no-explicit-any
      targets: v.nodes.slice(0, 5).map((n: any) => n.target.join(' ')),
    }))
  })
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface Job {
  profile: string
  route: string
  scheme: 'light' | 'dark'
  width: number
  font: number
}

type ManifestEntry = Record<string, unknown> & Job

const manifestPath = `${OUT}/manifest.json`
let manifest: ManifestEntry[] = []
try {
  manifest = JSON.parse(await Deno.readTextFile(manifestPath))
} catch {
  manifest = []
}
const sameCapture = (a: Job, b: Job) =>
  a.profile === b.profile && a.route === b.route && a.scheme === b.scheme &&
  a.width === b.width && a.font === b.font
let writing = Promise.resolve()
function record(entry: ManifestEntry) {
  manifest = manifest.filter((existing) => !sameCapture(existing, entry)).concat(entry)
  writing = writing.then(() => Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2)))
  return writing
}

/** Capture one job; a thrown error names the step it failed at. */
async function capture(tracked: Tracked, server: TestServer, job: Job): Promise<ManifestEntry> {
  const at = { step: 'emulation' }
  try {
    return await captureSteps(tracked, server, job, at)
  } catch (error) {
    throw new Error(`${at.step}: ${describe(error)}`)
  }
}

async function captureSteps(
  tracked: Tracked,
  server: TestServer,
  job: Job,
  at: { step: string },
): Promise<ManifestEntry> {
  const { page } = tracked
  const route = ROUTES[job.route]!
  const started = Date.now()
  const name = `${job.route}-${job.scheme}-${job.width}${job.font === 16 ? '' : `-f${job.font}`}`
  const directory = `${OUT}/${job.profile}`
  const url = `${server.url}${route.path}`
  const entry: ManifestEntry = { ...job, url: route.path, file: `${job.profile}/${name}.png` }
  // A phone width is emulated as a phone: touch input and a mobile viewport, so coarse-pointer
  // styles apply. The scale is pinned so captures match from one machine to the next.
  const phone = job.width <= 480
  const celestial = page.unsafelyGetCelestialBindings()
  await celestial.Emulation.setDeviceMetricsOverride({
    width: job.width,
    height: phone ? 844 : 900,
    deviceScaleFactor: scale,
    mobile: phone,
  })
  await celestial.Emulation.setTouchEmulationEnabled({ enabled: phone, maxTouchPoints: 5 })
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-color-scheme', value: job.scheme },
  ])
  // A clean viewer every time: no research trail, language choice or client id carries over.
  at.step = 'reset'
  await page.goto(`${server.url}/api/health`, { waitUntil: 'load' })
  await page.evaluate((scheme: string) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('rp-scheme', scheme)
  }, { args: [job.scheme] })
  tracked.errors.length = 0
  tracked.inflight.clear()
  const pending = new Set<string>()
  at.step = 'navigation'
  await page.goto(url, { waitUntil: 'load' })
  at.step = 'readiness'
  try {
    await waitForAccess(page)
    for (const ready of route.ready) await waitFor(page, ready)
    for (const url of await waitForQuiet(tracked)) pending.add(url)
    await page.evaluate(async (font: number) => {
      // A blinking caret would make otherwise identical captures differ.
      const style = document.createElement('style')
      style.textContent = '*{caret-color:transparent!important}'
      document.head.append(style)
      if (font !== 16) document.documentElement.style.fontSize = `${font}px`
      await document.fonts.ready
    }, { args: [job.font] })
    if (route.action) await route.action(page)
    for (const url of await waitForQuiet(tracked)) pending.add(url)
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    if (route.settle) await sleep(route.settle)
  } catch (error) {
    entry.error = describe(error)
  }
  at.step = 'screenshot'
  await Deno.mkdir(directory, { recursive: true })
  if (!route.action) await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: 'instant' }))
  await Deno.writeFile(`${directory}/${name}.png`, await page.screenshot())
  const metrics = await page.evaluate(measure, { args: [job.width] })
  if (route.full !== false && !entry.error) {
    const height = Math.min(metrics.height, FULL_PAGE_CAP)
    if (height > (job.width <= 480 ? 844 : 900) + 1) {
      await Deno.writeFile(
        `${directory}/${name}-full.png`,
        await page.screenshot({
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: job.width, height, scale: 1 },
        }),
      )
      entry.fullFile = `${job.profile}/${name}-full.png`
      if (metrics.height > FULL_PAGE_CAP) entry.fullTruncatedAt = FULL_PAGE_CAP
    }
  }
  at.step = 'findings'
  let violations: Awaited<ReturnType<typeof axe>> = null
  try {
    violations = await axe(page)
  } catch (error) {
    entry.axeError = describe(error)
  }
  Object.assign(entry, {
    overflowX: metrics.overflowX,
    scrollWidth: metrics.scrollWidth,
    clientWidth: metrics.clientWidth,
    pageHeight: metrics.height,
    title: metrics.title,
    lang: metrics.lang,
    targetsUnder24: metrics.targetsUnder24,
    ...(metrics.targetsUnder44 ? { targetsUnder44: metrics.targetsUnder44 } : {}),
    consoleErrors: [...tracked.errors],
    ...(pending.size ? { pendingRequests: [...pending] } : {}),
    ...(violations ? { axe: violations } : {}),
    ms: Date.now() - started,
  })
  await record(entry)
  return entry
}

function summaryLine(entry: ManifestEntry): string {
  const notes = [
    entry.error ? `ERROR ${entry.error}` : '',
    entry.overflowX ? 'overflow-x' : '',
    `t24:${(entry.targetsUnder24 as { count: number } | undefined)?.count ?? 0}`,
    entry.targetsUnder44 ? `t44:${(entry.targetsUnder44 as { count: number }).count}` : '',
    (entry.consoleErrors as string[] | undefined)?.length
      ? `console:${(entry.consoleErrors as string[]).length}`
      : '',
    entry.axe ? `axe:${(entry.axe as unknown[]).length}` : '',
  ].filter(Boolean).join(' ')
  return `${entry.file}  ${notes}  ${entry.ms}ms`
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (!Deno.env.get('DS_PORT_BASE')) Deno.env.set('DS_PORT_BASE', '8931')
await Deno.mkdir(OUT, { recursive: true })
const unmodelled = new Set<string>()
const server = startTestServer({
  identity: { role: 'owner' },
  management: designManagement((message) => {
    unmodelled.add(message.replace(/^.*: /, ''))
    console.error(message)
  }),
  provider: new DesignProvider(),
})
const seed = structuredClone(server.tenants.get('marine')!)
const pages: Tracked[] = []
const results: ManifestEntry[] = []
let harnessFailure = false
console.log(`Design shots: ${server.url} -> ${OUT}`)
try {
  // The portal reads as connected to a knowledge box, as a live portal does. The binding is a
  // placeholder on an unresolvable host: every read goes to the fixture, never to it.
  await server.bindings.set('marine', {
    baseUrl: 'https://design-review.invalid/api/v1/kb/swri-design-review',
    token: 'design-review-placeholder',
    kbId: 'swri-design-review',
  })
  for (let i = 0; i < concurrency; i++) pages.push(await openPage())
  let platformDone = false
  for (const profileId of profileIds) {
    await applyProfile(server, seed, PROFILES[profileId]!)
    const jobs: Job[] = []
    for (const route of routeIds) {
      const definition = ROUTES[route]!
      if (definition.platform && platformDone) continue
      for (const scheme of schemes as Job['scheme'][]) {
        for (const width of widths) {
          if (definition.widths && !definition.widths.includes(width)) continue
          for (const font of fonts) jobs.push({ profile: profileId, route, scheme, width, font })
        }
      }
    }
    platformDone ||= routeIds.some((route) => ROUTES[route]!.platform)
    const queue = [...jobs]
    await Promise.all(pages.map(async (worker) => {
      let tracked = worker
      for (let job = queue.shift(); job; job = queue.shift()) {
        // One retry, in a fresh browser when the first attempt broke the page.
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const entry = await capture(tracked, server, job)
            if (entry.error && attempt === 1) continue
            results.push(entry)
            if (entry.error) harnessFailure = true
            console.log(summaryLine(entry))
            break
          } catch (error) {
            const message = describe(error)
            const label = `${job.profile}/${job.route}-${job.scheme}-${job.width}`
            await tracked.browser.close().catch(() => {})
            const fresh = await openPage()
            pages[pages.indexOf(tracked)] = fresh
            tracked = fresh
            if (attempt === 1) {
              console.error(`Retrying ${label} after: ${message}`)
              continue
            }
            harnessFailure = true
            console.error(`FAILED ${label}: ${message}`)
            const failed: ManifestEntry = { ...job, url: ROUTES[job.route]!.path, error: message }
            results.push(failed)
            await record(failed)
          }
        }
      }
    }))
  }
} catch (error) {
  harnessFailure = true
  console.error(error)
} finally {
  await writing
  for (const tracked of pages) await tracked.browser.close().catch(() => {})
  await server.close()
}

const count = (predicate: (entry: ManifestEntry) => boolean) => results.filter(predicate).length
const axeIds = new Map<string, number>()
for (const entry of results) {
  for (const violation of (entry.axe as { id: string }[] | undefined) ?? []) {
    axeIds.set(violation.id, (axeIds.get(violation.id) ?? 0) + 1)
  }
}
console.log(
  [
    '',
    `Captures: ${results.length} (${count((e) => !!e.fullFile)} with a full-page image), ` +
    `${count((e) => !!e.error)} failed`,
    `Horizontal overflow: ${count((e) => e.overflowX === true)}`,
    `Console errors: ${count((e) => ((e.consoleErrors as string[] | undefined)?.length ?? 0) > 0)}`,
    axeSource
      ? `Axe violations by rule (captures): ${
        [...axeIds].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ') ||
        'none'
      }`
      : 'Axe: skipped (set AXE_PATH to an axe.min.js)',
    `Unmodelled management methods: ${[...unmodelled].join(', ') || 'none'}`,
    `Vendor requests: ${vendorCached} from cache, ${vendorFetched} fetched` +
    (blockedHosts.size ? `; blocked: ${[...blockedHosts].join(', ')}` : ''),
    `Manifest: ${manifestPath}`,
  ].join('\n'),
)
Deno.exit(harnessFailure ? 1 : 0)
