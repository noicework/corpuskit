/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { expect } from '@std/expect'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DurableState } from './state.ts'
import {
  type PrincipalEnvelope,
  signPrincipal,
  type TrustedSessionFacts,
  verifyPrincipal,
} from '../../api/src/principal.ts'
import type { AuthUser } from './auth.ts'
import type { PortalDurableObject } from './worker.ts'

type WorkerHandler = {
  fetch(request: Request, env: Env): Promise<Response>
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>
}

type WorkerModule = {
  PortalDurableObject: typeof PortalDurableObject
  default: WorkerHandler
  marketingHomeRequest(request: Request): Request
  forwardPortalRequest(
    request: Request,
    user: AuthUser | null,
    env: Env,
  ): Promise<Request>
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

Deno.test('Worker forwards identity only from a validated session user', async () => {
  const forwarded = await workerModule.forwardPortalRequest(
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
      sessionFacts: facts(),
    },
    workerHarness().env,
  )

  expect(forwarded.headers.get('x-corpuskit-sso-user-id')).toBe('entra-object-id')
  expect(forwarded.headers.get('x-corpuskit-sso-admin')).toBe('1')
  expect(
    (await verifyPrincipal(forwarded.headers.get('x-corpuskit-principal'), {
      sessionSecret: secret,
      audience: 'corpuskit',
      tenantId: 'entra-tenant-id',
    })).kind,
  ).toBe('verified')
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
          handleTrustedRequest(request: Request) {
            portalRequests.push(request)
            return Promise.resolve(new Response('portal', { status: 202 }))
          },
          auditDenial() {
            return Promise.resolve()
          },
          requestPrincipal() {
            return Promise.resolve({
              requestId: 'fixture',
              session: null,
              coarseAdminEligible: false,
            })
          },
          maintenance() {
            return Promise.resolve()
          },
        }
      },
    },
  }
  Object.assign(env, { WORKER_NAME: 'corpuskit', SESSION_SECRET: secret })
  return { env, assetRequests, portalRequests }
}

const secret = 'test-session-secret-at-least-thirty-two-bytes'
function facts(): TrustedSessionFacts {
  return {
    verified: true,
    tenantId: 'entra-tenant-id',
    oid: 'entra-object-id',
    email: 'admin@example.test',
    roles: ['CorpusKit.Admin'],
    groups: [],
    groupStatus: 'absent',
    claimIssuedAt: Date.now() - 120_000,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3600_000,
  }
}

async function sessionCookie(session: TrustedSessionFacts): Promise<string> {
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('__Secure-corpuskit_session') },
    key,
    new TextEncoder().encode(
      JSON.stringify({
        id: session.oid,
        tenantId: session.tenantId,
        name: 'Verified user',
        email: session.email,
        roles: session.roles,
        isAdmin: false,
        expiresAt: session.expiresAt,
        sessionFacts: session,
      }),
    ),
  )
  return `__Secure-corpuskit_session=v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}
async function principalRequest(
  path = '/auth/me',
  session = facts(),
  extra: Partial<PrincipalEnvelope> = {},
) {
  const header = await signPrincipal({
    v: 1,
    aud: 'corpuskit',
    tid: session.tenantId,
    oid: session.oid,
    email: session.email ?? '',
    name: 'Verified user',
    roles: session.roles,
    groups: session.groups,
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  }, secret)
  return new Request(`https://corpuskit.test${path}`, {
    headers: { 'x-corpuskit-principal': header, 'x-corpuskit-sso-admin': '1' },
  })
}
function realHarness(extraEnv: Record<string, string> = {}) {
  const database = new DatabaseSync(':memory:')
  const storage: DurableObjectState['storage'] = {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        if (!bindings.length && !/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
          database.exec(query)
          return {
            toArray: () => [],
            one: (): T => {
              throw new Error('No rows')
            },
          }
        }
        const statement = database.prepare(query)
        const rows = statement.columns().length
          ? statement.all(...bindings as SQLInputValue[]) as T[]
          : (statement.run(...bindings as SQLInputValue[]), [])
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error('Expected one row')
            return rows[0]!
          },
        }
      },
    },
    transactionSync<T>(callback: () => T): T {
      database.exec('BEGIN IMMEDIATE')
      try {
        const value = callback()
        database.exec('COMMIT')
        return value
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  const harness = workerHarness()
  Object.assign(harness.env, {
    ENTRA_TENANT_ID: 'entra-tenant-id',
    ENTRA_CLIENT_SECRET: 'fixture',
    ADMIN_PASSCODE: 'fixture',
    ...extraEnv,
  })
  const object = new workerModule.PortalDurableObject({ storage }, harness.env)
  harness.env.PORTAL = { getByName: () => object }
  return { ...harness, object, database, state: new DurableState(storage.sql, storage) }
}

Deno.test('scheduled RPC runs retention while every HTTP maintenance spelling stays non-system', async () => {
  const h = realHarness()
  try {
    h.state.put('tenants', { disabled: ['marine', 'grains'] })
    for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (
        const path of [
          '/__corpuskit/maintenance',
          '/__corpuskit/maintenance/',
          '/%5f%5fcorpuskit/maintenance',
        ]
      ) {
        const response = await h.object.fetch(
          new Request(`https://corpuskit.test${path}`, {
            method,
            headers: { 'x-corpuskit-actor': 'system', 'x-corpuskit-sso-admin': '1' },
          }),
        )
        expect([200, 201, 202, 204]).not.toContain(response.status)
      }
    }
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
        e.action === 'maintenance.run' || e.action === 'audit.retention'
      ),
    ).toHaveLength(0)
    const pending: Promise<unknown>[] = []
    await worker.scheduled({ cron: '0 0 * * *', scheduledTime: Date.now() }, h.env, {
      waitUntil: (promise) => {
        pending.push(promise)
      },
    })
    await Promise.all(pending)
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).some((e) =>
        e.action === 'audit.retention' && e.actor_kind === 'system'
      ),
    ).toBe(true)
    h.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    pending.length = 0
    await worker.scheduled({ cron: '0 0 * * *', scheduledTime: Date.now() }, h.env, {
      waitUntil: (promise) => {
        pending.push(promise)
      },
    })
    await expect(Promise.all(pending)).rejects.toThrow()
  } finally {
    h.database.close()
  }
})

Deno.test('Durable retention rolls back deleted history if its purge event cannot be written', () => {
  const h = realHarness()
  try {
    const before = h.state.rbac.audit.read({ scope: { kind: 'platform' } })
    h.database.exec("UPDATE audit_events SET at = '2020-01-01T00:00:00.000Z'")
    h.database.exec(
      "CREATE TRIGGER fail_purge BEFORE INSERT ON audit_events WHEN NEW.action = 'audit.retention' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect(() => h.state.rbac.retainAudit(400)).toThrow()
    expect(h.state.rbac.audit.read({ scope: { kind: 'platform' } })).toHaveLength(before.length)
    h.database.exec('DROP TRIGGER fail_purge')
    expect(h.state.rbac.retainAudit(400).deletedCount).toBe(before.length)
  } finally {
    h.database.close()
  }
})

Deno.test('real DO rejects invalid envelope or mismatched method facts without legacy rescue', async () => {
  const h = realHarness()
  try {
    const session = facts()
    const requests = [
      await principalRequest('/api/health', session, { iat: Math.floor(Date.now() / 1000) - 61 }),
      await principalRequest('/api/health', session, { aud: 'corpuskit-demo' }),
      new Request('https://corpuskit.test/api/health', {
        headers: { 'x-corpuskit-principal': 'x'.repeat(8193), 'x-corpuskit-sso-admin': '1' },
      }),
      new Request('https://corpuskit.test/api/health', {
        headers: { 'x-corpuskit-principal': 'forged', 'x-corpuskit-sso-admin': '1' },
      }),
    ]
    for (const request of requests) {
      expect(
        (await h.object.handleTrustedRequest(request, { session, clientIp: '192.0.2.1' })).status,
      ).toBe(401)
    }
    expect(
      (await h.object.handleTrustedRequest(await principalRequest(), {
        session: { ...session, oid: 'other' },
      })).status,
    ).toBe(401)
    for (
      const changed of [{ ...session, roles: ['CorpusKit.Owner'] }, {
        ...session,
        groups: ['injected-group'],
        groupStatus: 'complete' as const,
      }, { ...session, expiresAt: Date.now() - 1 }]
    ) {
      expect(
        (await h.object.handleTrustedRequest(await principalRequest('/api/health', session), {
          session: changed,
        })).status,
      ).toBe(401)
    }
    expect(
      (await h.object.handleTrustedRequest(new Request('https://corpuskit.test/api/health'), {
        session,
      })).status,
    ).toBe(401)
    expect((await h.object.fetch(await principalRequest('/api/admin/overview'))).status).toBe(401)
    expect(
      (await h.object.fetch(new Request('https://corpuskit.test/__corpuskit/maintenance'))).status,
    ).toBe(404)
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).filter((row) =>
        row.action === 'request.denied'
      ).length,
    ).toBeGreaterThanOrEqual(7)
  } finally {
    h.database.close()
  }
})

Deno.test('real DO auth/me resolves current assignments and preserves original claim age', async () => {
  const h = realHarness()
  try {
    const session = { ...facts(), roles: [] }
    const read = async () =>
      (await h.object.handleTrustedRequest(await principalRequest('/auth/me', session), {
        session,
      })).json()
    const first = await read()
    expect(first.coarseAdminEligible).toBe(false)
    expect(first.claimAgeSeconds).toBeGreaterThanOrEqual(120)
    const service = h.state.rbac.assignmentService(session.tenantId, 'corpuskit')
    const created = service.create({
      subjectKind: 'active-oid',
      subjectId: session.oid,
      scope: { kind: 'platform' },
      role: 'platform-admin',
    }, { requestId: 'test-create', actor: { kind: 'user', id: 'owner' } })
    expect(created.ok).toBe(true)
    const second = await read()
    expect(second.coarseAdminEligible).toBe(true)
    expect(second.effectiveRoles.platformRole).toBe('platform-admin')
    expect(second.claimAgeSeconds).toBeGreaterThanOrEqual(first.claimAgeSeconds)
    expect(second.groupMappings).toBe('disabled')
    expect(
      (await h.object.handleTrustedRequest(await principalRequest('/api/admin/overview', session), {
        session,
      })).status,
    ).toBe(200)
    if (created.ok) {
      expect(
        service.remove(created.value.id, {
          requestId: 'test-remove',
          actor: { kind: 'user', id: 'owner' },
        }).ok,
      ).toBe(true)
    }
    expect((await read()).coarseAdminEligible).toBe(false)
  } finally {
    h.database.close()
  }
})

Deno.test('Worker auth/me retains cookie lifetime and original age across fresh envelopes', async () => {
  const h = realHarness()
  const originalNow = Date.now
  try {
    const now = originalNow()
    const session = { ...facts(), roles: [] }
    const cookie = await sessionCookie(session)
    const read = () =>
      worker.fetch(new Request('https://corpuskit.test/auth/me', { headers: { cookie } }), h.env)
    Date.now = () => now
    const first = await read()
    expect(first.headers.get('set-cookie')).toBeNull()
    const body = await first.json()
    Date.now = () => now + 90_000
    const later = await (await read()).json()
    expect(later.claimAgeSeconds).toBe(body.claimAgeSeconds + 90)
    Date.now = () => session.expiresAt
    expect(await (await read()).json()).toMatchObject({
      authenticated: false,
      coarseAdminEligible: false,
    })
  } finally {
    Date.now = originalNow
    h.database.close()
  }
})

Deno.test('Worker signing denials require audit before returning and concurrent DO contexts stay separate', async () => {
  const h = realHarness()
  try {
    const session = facts()
    const cookie = await sessionCookie(session)
    Object.assign(h.env, { WORKER_NAME: 'invalid-deployment' })
    const request = () => new Request('https://corpuskit.test/auth/me', { headers: { cookie } })
    expect((await worker.fetch(request(), h.env)).status).toBe(401)
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).some((event) =>
        event.action === 'request.denied'
      ),
    ).toBe(true)
    const ordinary = { ...facts(), oid: 'ordinary', roles: [] }
    const responses = await Promise.all([
      h.object.handleTrustedRequest(await principalRequest('/api/admin/overview', session), {
        session,
      }),
      h.object.handleTrustedRequest(await principalRequest('/api/admin/overview', ordinary), {
        session: ordinary,
      }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 401])
    h.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    )
    expect((await worker.fetch(request(), h.env)).status).toBe(500)
  } finally {
    h.database.close()
  }
})

Deno.test('real Worker and DO fail closed on audit outages and keep anonymous public requests usable', async () => {
  const h = realHarness()
  try {
    const response = await worker.fetch(
      new Request('https://corpuskit.test/api/t/marine/config', {
        headers: {
          'x-corpuskit-principal': 'forged',
          'x-corpuskit-sso-session': JSON.stringify(facts()),
          'x-corpuskit-sso-admin': '1',
        },
      }),
      h.env,
    )
    expect(response.status).toBe(200)
    Object.assign(h.env, { ENTRA_CLIENT_SECRET: undefined })
    const me = await worker.fetch(new Request('https://corpuskit.test/auth/me'), h.env)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      authenticated: false,
      coarseAdminEligible: false,
      breakGlassEnabled: false,
    })
    h.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    )
    expect(
      (await h.object.fetch(
        new Request('https://corpuskit.test/api/health', {
          headers: { 'x-corpuskit-principal': 'forged' },
        }),
      )).status,
    ).toBe(500)
    expect(
      (await worker.fetch(
        new Request('https://corpuskit.test/api/admin/tenants', {
          headers: { 'x-admin-passcode': 'wrong' },
        }),
        h.env,
      )).status,
    ).toBe(500)
  } finally {
    h.database.close()
  }
})

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
