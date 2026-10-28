import { runScheduledEvaluations } from './evaluation-schedule.ts'
import {
  externalLoginConfig,
  externalLoginConfigured,
  ExternalLoginReplayStore,
} from './external-login.ts'
import { serveStatic } from 'hono/deno'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { AragProvider, labBindings } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { BindingStore } from './bindings.ts'
import { SourceStore } from './stores.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { EnrichmentStore } from './enrichments.ts'
import { DocsHealth } from './docs-health.ts'
import { loadRootEnv } from './load-env.ts'
import { startScheduler } from './scheduler.ts'
import { installShutdown, secondsSetting } from './local-runtime.ts'
import { acquireStorageLocks, localStoragePaths, sweepAtomicTemps } from './local-storage.ts'
import { scheduleAfter } from './local-timers.ts'
import { LocalIngress } from './local-ingress.ts'
import { openLocalRbac } from './rbac-local.ts'
import { infrastructureHandler } from './permissions.ts'
import { documentPath, probePath } from './public-paths.ts'
import { platformShellResponse } from './platform-shell.ts'
import {
  indexNowKeyFile,
  llmsTxt,
  robotsTag,
  robotsTxt,
  sitemapXml,
  withRobotsMeta,
} from './search-files.ts'
import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'
import { operatorDeleteWarning } from './portal-erasure.ts'
import { showcasePortalsWarning } from './tenants.ts'
import { type WebBuildStamp, webBuildStamp } from './build-stamp.ts'

loadRootEnv()
const deleteWarning = operatorDeleteWarning(process.env)
if (deleteWarning) console.warn(deleteWarning)
const showcaseWarning = showcasePortalsWarning(process.env)
if (showcaseWarning) console.warn(showcaseWarning)

const port = Number(process.env.PORT ?? 8791)
const zone = process.env.ARAG_ZONE ?? 'aws-ap-southeast-2-1'

const shutdownGrace = secondsSetting(
  process.env.SHUTDOWN_GRACE_SECONDS,
  100,
  'SHUTDOWN_GRACE_SECONDS',
)
const storagePaths = localStoragePaths(process.env)
const storageEnv = { ...process.env, ...storagePaths }
const releaseWriter = await acquireStorageLocks(
  storagePaths,
  secondsSetting(process.env.WRITER_LOCK_WAIT_SECONDS, 60, 'WRITER_LOCK_WAIT_SECONDS'),
).catch((error) => {
  console.error(
    JSON.stringify({ event: 'server.writer_lock', outcome: 'failure', message: error.message }),
  )
  Deno.exit(1)
})
console.log(JSON.stringify({ event: 'server.writer_lock', outcome: 'acquired' }))
sweepAtomicTemps(storagePaths, releaseWriter.paths)
const shutdownController = new AbortController()

const bindings = new BindingStore(storageEnv)
await bindings.initialize()
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
const enrichments = new EnrichmentStore()
const { database, rbac } = openLocalRbac(storageEnv)
const owned = localOwnedStores(storagePaths.DATA_DIR, database, rbac.audit, storageEnv)
owned.attach({ bindings, sources, enrichments })
const tenants = owned.tenants!
const { watches } = owned
const ingress = new LocalIngress({
  rbac,
  tenants,
  env: process.env,
  externalReplays: new ExternalLoginReplayStore(database),
})

// Documentation readiness: probe every bound portal's documentation-scoped
// search at boot and report it on /api/health, so a portal provisioned
// without its help pages ingested fails loudly instead of answering nothing.
const docsHealth = new DocsHealth({
  tenants: () =>
    tenants.list().map((t) => tenants.get(t.slug)).filter((t): t is NonNullable<typeof t> =>
      t !== undefined
    ),
  // A withheld (unavailable) credential is not probed; the admin overview reports it.
  isBound: (slug) => ['connected', 'demo'].includes(bindings.status(slug).status),
  provider,
})

/** The stamp `deno task build:web` leaves beside the bundle (build:stamp), when present. */
function readWebBuildStamp(): WebBuildStamp | undefined {
  try {
    return webBuildStamp(JSON.parse(readFileSync('./apps/web/dist/build.json', 'utf8')))
  } catch {
    // No stamp: an older build, or no build at all.
    return undefined
  }
}

const webBuild = readWebBuildStamp()
const app = buildApp({
  ...owned,
  rbac,
  configuredTenantId: process.env.ENTRA_TENANT_ID ||
    (externalLoginConfigured(externalLoginConfig(process.env)) ? 'external' : undefined),
  externalLoginEnabled: externalLoginConfigured(externalLoginConfig(process.env)),
  audience: process.env.WORKER_NAME ?? 'corpuskit',
  provider,
  tenants,
  management: provider,
  bindings,
  sources,
  watches,
  enrichments,
  zone,
  audit: rbac.audit,
  breakGlass: ingress.breakGlass,
  requestContext: ingress.requestContext,
  invalidate: (slug) => provider.invalidate(slug),
  docsHealth,
  buildSha: process.env.BUILD_SHA ?? webBuild?.sha,
  webBuild,
})

const stopScheduler = startScheduler(
  provider,
  tenants,
  sources,
  watches,
  enrichments,
  rbac,
  process.env,
  owned.lifecycle,
  bindings,
  () => runScheduledEvaluations(app),
)
// Off the listen path: the probe is a live retrieval call per portal.
const cancelDocsProbe = scheduleAfter(3_000, () => void docsHealth.check())

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
let aboutHtml = ''
try {
  indexHtml = readFileSync('./apps/web/dist/index.html', 'utf8')
    .replace('"/app.js"', `"/app.js?v=${buildSha}"`)
    .replace('"/styles.css"', `"/styles.css?v=${buildSha}"`)
  homeHtml = readFileSync('./apps/web/dist/home.html', 'utf8')
  aboutHtml = readFileSync('./apps/web/dist/about.html', 'utf8')
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
app.get(
  '/',
  infrastructureHandler(async (c) => {
    if (!homeHtml) return c.text('The web build is not available.', 503)
    return c.html(homeHtml)
  }),
)
// Local marketing preview, under the same static boundary as the homepage.
for (const path of ['/about', '/about/']) {
  app.get(
    path,
    infrastructureHandler(async (c) => {
      if (!aboutHtml) return c.text('The web build is not available.', 503)
      return c.html(aboutHtml)
    }),
  )
}
// The same robots.txt and apex sitemap the Worker serves (search-files.ts).
app.get(
  '/robots.txt',
  infrastructureHandler(async (c) =>
    c.text(
      robotsTxt(
        process.env.PLATFORM_DOMAIN ?? 'corpuskit.org',
        new URL(c.req.url).hostname,
        process.env.PORTAL_INDEXING,
      ),
    )
  ),
)
app.get(
  '/sitemap.xml',
  infrastructureHandler(async (c) => {
    const domain = getPlatformDomain(process.env.PLATFORM_DOMAIN)
    if (new URL(c.req.url).hostname !== domain) return c.text('Not found', 404)
    return c.body(sitemapXml(domain), 200, { 'Content-Type': 'application/xml; charset=utf-8' })
  }),
)
app.get(
  '/llms.txt',
  infrastructureHandler(async (c) => {
    const domain = getPlatformDomain(process.env.PLATFORM_DOMAIN)
    if (new URL(c.req.url).hostname !== domain) return c.text('Not found', 404)
    return c.text(llmsTxt(domain))
  }),
)
// The IndexNow key file, on the apex, when INDEXNOW_KEY is set (search-files.ts).
app.get(
  '*',
  infrastructureHandler(async (c, next) => {
    const url = new URL(c.req.url)
    const key = indexNowKeyFile(
      process.env.PLATFORM_DOMAIN ?? 'corpuskit.org',
      url.hostname,
      url.pathname,
      process.env.INDEXNOW_KEY,
    )
    if (!key) return await next()
    return c.text(key)
  }),
)
app.use('*', infrastructureHandler(serveStatic({ root: './apps/web/dist' })))
// The same answers the Worker gives: probes are refused, and an unknown path
// still renders the shell (the app has its own not-found page) but as a 404.
app.get(
  '*',
  infrastructureHandler(async (c) => {
    if (!indexHtml) return c.text('The web build is not available.', 503)
    const path = new URL(c.req.url).pathname
    if (!documentPath(path) && probePath(path)) return c.text('Not found', 404)
    return c.html(indexHtml, documentPath(path) ? 200 : 404)
  }),
)

const platformDomain = getPlatformDomain(process.env.PLATFORM_DOMAIN)
const server = Deno.serve(
  { port, hostname: process.env.HOST ?? '0.0.0.0' },
  async (request, info) => {
    request = new Request(request, {
      signal: AbortSignal.any([request.signal, shutdownController.signal]),
    })
    const url = new URL(request.url)
    const response = platformShellResponse(
      await ingress.handle(request, (clean) => app.fetch(clean), info),
      platformDomain,
      ingress.hostPortal(request),
      url.hostname,
    )
    // As in the Worker: PORTAL_INDEXING=deny keeps a portal's pages out of search.
    const tag = robotsTag(platformDomain, url.hostname, url.pathname, process.env.PORTAL_INDEXING)
    if (!tag || response.headers.has('x-robots-tag')) return response
    const headers = new Headers(response.headers)
    headers.set('x-robots-tag', tag)
    return await withRobotsMeta(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      tag,
    )
  },
)

installShutdown({
  graceSeconds: shutdownGrace,
  stopScheduler: () => {
    cancelDocsProbe()
    return stopScheduler()
  },
  abort: () => shutdownController.abort(),
  shutdownServer: () => server.shutdown(),
  closeDatabase: () => database.close(),
  releaseLock: releaseWriter,
})
