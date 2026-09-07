import { serveStatic } from 'hono/deno'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { AragProvider, labBindings } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { BindingStore } from './bindings.ts'
import { SourceStore, WatchStore } from './stores.ts'
import { EnrichmentStore } from './enrichments.ts'
import { DocsHealth } from './docs-health.ts'
import { TenantStore } from './tenants.ts'
import { loadRootEnv } from './load-env.ts'
import { startScheduler } from './scheduler.ts'

loadRootEnv()

const port = Number(process.env.PORT ?? 8787)
const zone = process.env.ARAG_ZONE ?? 'aws-ap-southeast-2-1'

const bindings = new BindingStore()
const tenants = new TenantStore()
// Extraction Lab sandboxes bind under `<slug>-lab` straight from the environment.
const labs = labBindings()
const provider = new AragProvider({
  resolveBinding: (slug) => bindings.get(slug) ?? labs[slug],
})
// Constructed once and shared with startScheduler below - a scheduled sync
// and a concurrent HTTP write (e.g. POST /watches) must serialise through
// the same in-process store, not two separate instances racing to
// read-modify-write the same file (see the note on startScheduler).
const sources = new SourceStore()
const watches = new WatchStore()
const enrichments = new EnrichmentStore()

// Documentation readiness: probe every bound portal's documentation-scoped
// search at boot and report it on /api/health, so a portal provisioned
// without its help pages ingested fails loudly instead of answering nothing.
const docsHealth = new DocsHealth({
  tenants: () =>
    tenants.list().map((t) => tenants.get(t.slug)).filter((t): t is NonNullable<typeof t> =>
      t !== undefined
    ),
  isBound: (slug) => bindings.get(slug) !== undefined,
  provider,
})

/** The stamp `deno task build:web` leaves beside the bundle (build:stamp), when present. */
function webBuildStamp(): { sha: string; builtAt: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync('./apps/web/dist/build.json', 'utf8')) as {
      sha?: unknown
      builtAt?: unknown
    }
    if (typeof raw.sha === 'string' && typeof raw.builtAt === 'string') {
      return { sha: raw.sha, builtAt: raw.builtAt }
    }
  } catch {
    // No stamp: an older build, or no build at all.
  }
  return undefined
}

const webBuild = webBuildStamp()
const app = buildApp({
  provider,
  tenants,
  management: provider,
  bindings,
  sources,
  watches,
  enrichments,
  zone,
  adminPasscode: process.env.ADMIN_PASSCODE,
  invalidate: (slug) => provider.invalidate(slug),
  docsHealth,
  buildSha: process.env.BUILD_SHA ?? webBuild?.sha,
  webBuild,
})

startScheduler(provider, tenants, sources, watches, enrichments)
// Off the listen path: the probe is a live retrieval call per portal.
setTimeout(() => void docsHealth.check(), 3_000)

// Serve the built SPA (deno task build:web) alongside the API - one origin, no proxy.
// Cache-bust the entry bundle so a deploy is never masked by a stale copy in the
// browser: the versioned ?v=<sha> asset URLs change every release, and the HTML
// itself is served no-cache so it always revalidates and hands out the new URLs.
// In production CI sets BUILD_SHA, so every deploy gets a fresh asset URL.
// Locally there is no SHA, and a constant literal meant `/app.js?v=dev` never
// changed between rebuilds - the browser kept serving a cached bundle and local
// changes looked like they had not landed. Fall back to the built bundle's
// mtime so each `deno task build:web` busts the cache.
function localBuildId(): string {
  try {
    return String(Deno.statSync('./apps/web/dist/app.js').mtime?.getTime() ?? Date.now())
  } catch {
    return String(Date.now())
  }
}

const buildSha = process.env.BUILD_SHA ?? webBuild?.sha ?? localBuildId()
let indexHtml = ''
let homeHtml = ''
try {
  indexHtml = readFileSync('./apps/web/dist/index.html', 'utf8')
    .replace('"/app.js"', `"/app.js?v=${buildSha}"`)
    .replace('"/styles.css"', `"/styles.css?v=${buildSha}"`)
  homeHtml = readFileSync('./apps/web/dist/home.html', 'utf8')
} catch {
  // No build present (e.g. a dev server before build:web) - the health check
  // reports web:false and the catch-all below returns 503.
  indexHtml = ''
}

// The versioned index must be served by our own handler, not serveStatic:
// registering `/` before the static middleware stops serveStatic from
// handing out the raw (unversioned, cacheable) index.html for the root, and
// the `*` fallback covers every client-side route. serveStatic in between
// serves the real asset files (app.js, styles.css, thumbnails).
app.get('/', (c) => {
  if (!homeHtml) return c.text('The web build is not available.', 503)
  c.header('Cache-Control', 'no-cache')
  return c.html(homeHtml)
})
app.use('*', serveStatic({ root: './apps/web/dist' }))
app.get('*', (c) => {
  if (!indexHtml) return c.text('The web build is not available.', 503)
  c.header('Cache-Control', 'no-cache')
  return c.html(indexHtml)
})

Deno.serve({ port }, app.fetch)
