/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { expect } from '@std/expect'

type WorkerHandler = {
  fetch(request: Request, env: Env): Promise<Response>
}

type WorkerModule = {
  default: WorkerHandler
  marketingHomeRequest(request: Request): Request
  forwardPortalRequest(
    request: Request,
    user: {
      id: string
      tenantId: string
      name: string
      email: string
      roles: string[]
      isAdmin: boolean
    } | null,
  ): Request
}

type WorkerHarness = {
  env: Env
  assetRequests: Request[]
  portalRequests: Request[]
}

const workerModule = await loadWorker()
const worker = workerModule.default

Deno.test('Worker sends each portal custom domain to its tenant route', async () => {
  for (const slug of ['marine', 'grains', 'opax', 'new-portal']) {
    const harness = workerHarness()
    const response = await worker.fetch(
      new Request(`https://${slug}.corpuskit.org/?from=directory`),
      harness.env,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(`/t/${slug}?from=directory`)
    expect(harness.assetRequests).toHaveLength(0)
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker keeps the apex canonical when www is requested', async () => {
  const harness = workerHarness()
  const response = await worker.fetch(
    new Request('https://www.corpuskit.org/why?ref=www'),
    harness.env,
  )

  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe('https://corpuskit.org/why?ref=www')
})

Deno.test('Worker serves the marketing app at the CorpusKit apex', async () => {
  const harness = workerHarness()
  const response = await worker.fetch(new Request('https://corpuskit.org/'), harness.env)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('asset')
  expect(harness.assetRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/home',
  ])
})

Deno.test('Worker preserves the marketing URL query while selecting the homepage asset', () => {
  const request = workerModule.marketingHomeRequest(
    new Request('https://corpuskit.org/?campaign=launch', { method: 'HEAD' }),
  )

  expect(new URL(request.url).pathname).toBe('/home')
  expect(new URL(request.url).search).toBe('?campaign=launch')
  expect(request.method).toBe('HEAD')
})

Deno.test('Worker permanently redirects the Assistant route alias for GET and HEAD', async () => {
  for (const method of ['GET', 'HEAD']) {
    const harness = workerHarness()

    const response = await worker.fetch(
      new Request('https://corpuskit.test/t/marine/assistant?ask=x', { method }),
      harness.env,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/t/marine/ask?ask=x')
    expect(harness.assetRequests).toHaveLength(0)
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker alias redirects preserve nested paths and query strings', async () => {
  const harness = workerHarness()

  const response = await worker.fetch(
    new Request(
      'https://corpuskit.test/t/grains/assistant/sessions/report-42?view=evidence&sort=recent',
    ),
    harness.env,
  )

  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe(
    '/t/grains/ask/sessions/report-42?view=evidence&sort=recent',
  )
  expect(harness.assetRequests).toHaveLength(0)
  expect(harness.portalRequests).toHaveLength(0)
})

Deno.test('Worker keeps normal tenant routes on the static asset fast path', async () => {
  const harness = workerHarness()

  const response = await worker.fetch(
    new Request('https://corpuskit.test/t/marine/library'),
    harness.env,
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('asset')
  expect(harness.assetRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/t/marine/library',
  ])
  expect(harness.portalRequests).toHaveLength(0)
})

Deno.test('Worker keeps API requests routed through the Durable Object', async () => {
  const harness = workerHarness()

  const response = await worker.fetch(
    new Request('https://corpuskit.test/api/t/marine/config'),
    harness.env,
  )

  expect(response.status).toBe(202)
  expect(await response.text()).toBe('portal')
  expect(harness.assetRequests).toHaveLength(0)
  expect(harness.portalRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/api/t/marine/config',
  ])
})

Deno.test('Worker removes caller-supplied identity markers before forwarding API requests', async () => {
  const harness = workerHarness()

  await worker.fetch(
    new Request('https://corpuskit.test/api/t/marine/mcp/keys', {
      headers: {
        'x-corpuskit-sso-admin': '1',
        'x-corpuskit-sso-user-id': 'spoofed-user',
      },
    }),
    harness.env,
  )

  expect(harness.portalRequests[0]?.headers.get('x-corpuskit-sso-admin')).toBeNull()
  expect(harness.portalRequests[0]?.headers.get('x-corpuskit-sso-user-id')).toBeNull()
})

Deno.test('Worker forwards identity only from a validated session user', () => {
  const forwarded = workerModule.forwardPortalRequest(
    new Request('https://corpuskit.test/api/t/marine/mcp/keys', {
      headers: {
        'x-corpuskit-sso-admin': 'spoofed',
        'x-corpuskit-sso-user-id': 'spoofed-user',
      },
    }),
    {
      id: 'entra-object-id',
      tenantId: 'entra-tenant-id',
      name: 'Portal administrator',
      email: 'admin@example.test',
      roles: ['CorpusKit.Admin'],
      isAdmin: true,
    },
  )

  expect(forwarded.headers.get('x-corpuskit-sso-user-id')).toBe('entra-object-id')
  expect(forwarded.headers.get('x-corpuskit-sso-admin')).toBe('1')
})

function workerHarness(): WorkerHarness {
  const assetRequests: Request[] = []
  const portalRequests: Request[] = []
  const env: Env = {
    CF_VERSION_METADATA: { id: 'test', tag: 'test' },
    ASSETS: {
      fetch(request) {
        assetRequests.push(request)
        return Promise.resolve(new Response('asset', { headers: { 'content-type': 'text/html' } }))
      },
    },
    ENVIRONMENT: 'production',
    ENTRA_CLIENT_ID: '147a13c9-2a9e-4e32-aa01-3f020d2a18cd',
    ENTRA_TENANT_ID: '15c1eb19-1f38-4a09-bb25-7ff9892387b8',
    ENTRA_REDIRECT_URI: 'https://corpuskit.org/auth/callback',
    PORTAL: {
      getByName() {
        return {
          fetch(request) {
            portalRequests.push(request)
            return Promise.resolve(new Response('portal', { status: 202 }))
          },
        }
      },
    },
  }
  return { env, assetRequests, portalRequests }
}

/**
 * Deno cannot resolve Cloudflare's runtime-only `cloudflare:workers` module.
 * Replace only that platform base class, then import the actual worker module
 * so these tests execute its exported default fetch handler.
 */
async function loadWorker(): Promise<WorkerModule> {
  const workerUrl = new URL('./worker.ts', import.meta.url)
  const durableObjectShim =
    'data:application/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }'
  const source = (await Deno.readTextFile(workerUrl))
    .replace("from 'cloudflare:workers'", `from '${durableObjectShim}'`)
    .replaceAll(
      /from '(\.\.?\/[^']+)'/g,
      (_match, specifier: string) => `from '${new URL(specifier, workerUrl).href}'`,
    )
  const moduleUrl = `data:application/typescript,${encodeURIComponent(source)}`
  return await import(moduleUrl) as WorkerModule
}
