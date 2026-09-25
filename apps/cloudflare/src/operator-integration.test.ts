/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from '@std/expect'
import { KbClient } from '@research-portal/retrieval'
import { DurableState, type DurableStores } from './state.ts'
import {
  PRINCIPAL_HEADER,
  signPrincipal,
  type TrustedSessionFacts,
  verifyPrincipal,
} from '../../api/src/principal.ts'
import { OPERATOR_FAILURE_LIMIT_PER_MIN, operatorRequestContext } from '../../api/src/operator.ts'
import type { PortalDurableObject, TrustedRequestContext } from './worker.ts'

const operatorKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const sessionSecret = 'operator-test-session-secret-longer-than-thirty-two-bytes'
const workerModule = await loadWorker()

type WorkerModule = {
  PortalDurableObject: typeof PortalDurableObject
  default: { fetch(request: Request, env: Env): Promise<Response> }
}

async function fixture(overrides: Record<string, string | undefined> = {}) {
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
        const parameters = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value
        ) as SQLInputValue[]
        const rows = statement.columns().length
          ? statement.all(...parameters) as T[]
          : (statement.run(...parameters), [])
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
  const forwarded: { headers: Record<string, string>; context: TrustedRequestContext }[] = []
  const refusals: {
    rpc: string
    method: string
    headers: Record<string, string>
    body: boolean
  }[] = []
  const env = {
    WORKER_NAME: 'corpuskit',
    SESSION_SECRET: sessionSecret,
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'hosting-automation',
    // Cloudflare stores new knowledge-box credentials only when it can seal them.
    BINDING_KEY: btoa('operator-fixture-binding-key-32b'),
    ENTRA_TENANT_ID: 'tenant-1',
    ENVIRONMENT: 'production',
    ADMIN_BREAK_GLASS: 'true',
    ADMIN_PASSCODE: 'fixture-passcode',
    RATE_LIMIT_ASK_PER_MIN: '0',
    RATE_LIMIT_ESTATE_PER_MIN: '0',
    CF_VERSION_METADATA: { id: 'fixture', tag: 'fixture' },
    ASSETS: { fetch: () => Promise.resolve(new Response('fixture asset')) },
    PORTAL: { getByName: () => object },
    ...overrides,
  } as unknown as Env
  let initialization: Promise<unknown> = Promise.resolve()
  const object = new workerModule.PortalDurableObject({
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const pending = callback()
      initialization = pending
      return pending
    },
  }, env)
  await initialization
  const ingress = object.handleTrustedRequest.bind(object)
  object.handleTrustedRequest = (request, context) => {
    forwarded.push({ headers: Object.fromEntries(request.headers), context })
    return ingress(request, context)
  }
  // Record exactly what the Worker hands the Durable Object when it refuses a request.
  const record = (rpc: string, request: Request) =>
    refusals.push({
      rpc,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body !== null,
    })
  const auditDenial = object.auditDenial.bind(object)
  object.auditDenial = (request, ...rest) => {
    record('auditDenial', request)
    return auditDenial(request, ...rest)
  }
  const auditOperatorFailure = object.auditOperatorFailure.bind(object)
  object.auditOperatorFailure = (request, clientIp) => {
    record('auditOperatorFailure', request)
    return auditOperatorFailure(request, clientIp)
  }
  const state = new DurableState(storage.sql, storage)
  const stores = (object as unknown as { stores: DurableStores }).stores
  const bootstrapEvents = new Set(
    state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 }).map((event) => event.id),
  )
  return {
    object,
    database,
    stores,
    forwarded,
    refusals,
    events: () =>
      state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
        .filter((event) => !bootstrapEvents.has(event.id)),
    invoke: (path: string, init: RequestInit = {}, authorization = `Operator ${operatorKey}`) => {
      const headers = new Headers(init.headers)
      if (authorization) headers.set('authorization', authorization)
      if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.1')
      return workerModule.default.fetch(
        new Request(`https://corpuskit.test${path}`, { ...init, headers }),
        env,
      )
    },
    close: () => database.close(),
  }
}

function jsonRequest(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

const ownerFacts = (): TrustedSessionFacts => ({
  verified: true,
  tenantId: 'tenant-1',
  oid: 'owner-1',
  email: 'owner@example.test',
  roles: ['CorpusKit.Owner'],
  groups: [],
  groupStatus: 'absent',
  claimIssuedAt: Date.now(),
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
})

const operatorPrincipal = () =>
  signPrincipal({
    v: 1,
    kind: 'operator',
    aud: 'corpuskit',
    id: 'hosting-automation',
    iat: Math.floor(Date.now() / 1000),
  }, sessionSecret)

const newMember = {
  subjectKind: 'pending-email',
  subjectId: 'reader@example.test',
  role: 'viewer',
}

Deno.test('Worker operator ingress signs a restricted principal and strips raw credentials', async () => {
  const f = await fixture()
  try {
    const response = await f.invoke('/api/admin/t/marine/members', {
      headers: {
        [PRINCIPAL_HEADER]: 'caller-forgery',
        'x-corpuskit-sso-admin': '1',
        'x-sso-user': 'caller-forgery',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
    expect(f.forwarded).toHaveLength(1)
    const forwarded = f.forwarded[0]!
    expect(forwarded.headers.authorization).toBeUndefined()
    expect(forwarded.headers['x-corpuskit-sso-admin']).toBeUndefined()
    expect(forwarded.headers['x-sso-user']).toBeUndefined()
    expect(forwarded.context.session).toBeNull()
    expect(JSON.stringify(forwarded)).not.toContain(operatorKey)
    const verified = await verifyPrincipal(forwarded.headers[PRINCIPAL_HEADER]!, {
      sessionSecret,
      audience: 'corpuskit',
      tenantId: 'tenant-1',
      operatorId: 'hosting-automation',
    })
    expect(verified.kind).toBe('verified')
    if (verified.kind !== 'verified') throw new Error('Expected verified operator')
    expect(verified.envelope).toEqual({
      v: 1,
      kind: 'operator',
      aud: 'corpuskit',
      id: 'hosting-automation',
      iat: expect.any(Number),
    })
    const principal = await f.object.requestPrincipal(
      new Request('https://corpuskit.test/api/admin/t/marine/members', {
        headers: { [PRINCIPAL_HEADER]: forwarded.headers[PRINCIPAL_HEADER]! },
      }),
      { session: null },
    )
    expect(principal.operator).toEqual({ id: 'hosting-automation' })
    expect(principal.session).toBeNull()
    expect(principal.effectiveRoles?.platformRole).toBe('platform-admin')
    // Local ingress builds its operator context with the same helper.
    expect(principal).toEqual(operatorRequestContext('hosting-automation', principal.requestId))
    const events = f.events()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.actor_kind === 'operator')).toBe(true)
    expect(events.every((event) => event.actor_id === 'operator:hosting-automation')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(operatorKey)
  } finally {
    f.close()
  }
})

Deno.test('Worker operator allowlist reaches portal setup, email assignments, counters and branding', async () => {
  const f = await fixture()
  const originalGetJson = KbClient.prototype.getJson
  const probes: string[] = []
  KbClient.prototype.getJson = <T>(path: string): Promise<T> => {
    probes.push(path)
    return Promise.resolve({ resources: 2 } as T)
  }
  try {
    const created = await f.invoke(
      '/api/admin/tenants',
      jsonRequest('POST', { name: 'Hosted Lab' }),
    )
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({
      ok: true,
      slug: 'hosted-lab',
      domain: { status: 'active', hostname: 'hosted-lab.corpuskit.org', created: true },
    })
    expect(f.stores.tenants.get('hosted-lab')?.hostname).toBe('hosted-lab.corpuskit.org')
    const updated = await f.invoke(
      '/api/admin/tenants/hosted-lab',
      jsonRequest('PATCH', { name: 'Updated Lab', searchPlaceholder: 'Find evidence' }),
    )
    expect(updated.status).toBe(200)
    expect(f.stores.tenants.get('hosted-lab')?.branding.productName).toBe('Updated Lab')
    const connected = await f.invoke(
      '/api/admin/t/hosted-lab/knowledge-box',
      jsonRequest('POST', {
        endpoint: 'https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/fixture-box',
        token: 'fixture-binding-token-long-enough',
      }),
    )
    expect(connected.status).toBe(200)
    expect(probes).toEqual(['/counters'])
    expect(f.stores.bindings.get('hosted-lab')?.kbId).toBe('fixture-box')
    const disconnected = await f.invoke('/api/admin/t/hosted-lab/knowledge-box', {
      method: 'DELETE',
    })
    expect(disconnected.status).toBe(200)
    expect(f.stores.bindings.get('hosted-lab')).toBeUndefined()
    const access = await f.invoke(
      '/api/admin/t/hosted-lab/access',
      jsonRequest('PATCH', { accessMode: 'restricted' }),
    )
    expect(access.status).toBe(200)
    expect(f.stores.tenants.get('hosted-lab')?.accessMode).toBe('restricted')
    const assignment = await f.invoke(
      '/api/admin/t/hosted-lab/members',
      jsonRequest('POST', {
        subjectKind: 'pending-email',
        subjectId: 'researcher@example.test',
        role: 'portal-admin',
      }),
    )
    expect(assignment.status).toBe(201)
    const assigned = await assignment.json()
    const members = await f.invoke('/api/admin/t/hosted-lab/members')
    expect(members.status).toBe(200)
    expect((await members.json()).items).toEqual([assigned])
    const removed = await f.invoke(`/api/admin/t/hosted-lab/members/${assigned.id}`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    const counters = await f.invoke('/api/admin/t/hosted-lab/counters')
    expect(counters.status).toBe(200)
    expect(await counters.json()).toEqual({ resources: 2, paragraphs: 3, sentences: 4 })
    const branding = await f.invoke('/api/admin/t/hosted-lab/branding/logo', {
      method: 'POST',
      headers: { 'content-type': 'image/svg+xml' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
    expect(branding.status).toBe(200)
    expect(f.stores.branding.get('hosted-lab', 'logo')?.contentType).toBe('image/svg+xml')
    const migration = await f.invoke(
      '/api/admin/migrate',
      jsonRequest('POST', {
        from: 'marine',
        to: 'hosted-lab',
      }),
    )
    expect(migration.status).toBe(200)
    expect(await migration.text()).toContain('"type":"done"')
    const events = f.events()
    expect(events.some((event) => event.action === 'tenant.domain.attach')).toBe(true)
    expect(events.some((event) => event.action === 'assignment.create')).toBe(true)
    expect(events.some((event) => event.action === 'assignment.delete')).toBe(true)
    expect(events.every((event) => event.actor_id === 'operator:hosting-automation')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(operatorKey)
    expect(JSON.stringify(events)).not.toContain('fixture-binding-token-long-enough')
  } finally {
    KbClient.prototype.getJson = originalGetJson
    f.close()
  }
})

Deno.test('Worker operator reads and sets portal lifecycle and reads usage, and nothing wider', async () => {
  const f = await fixture()
  try {
    const initial = await f.invoke('/api/admin/t/marine/lifecycle')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ status: 'active', limits: null })
    const set = await f.invoke(
      '/api/admin/t/marine/lifecycle',
      jsonRequest('PUT', { status: 'read_only', limits: { maxResources: 20 } }),
    )
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({
      ok: true,
      lifecycle: { status: 'read_only', limits: { maxResources: 20 } },
    })
    expect(f.stores.lifecycle.get('marine')).toMatchObject({
      status: 'read_only',
      limits: { maxResources: 20 },
    })
    const usage = await f.invoke('/api/admin/t/marine/usage')
    expect(usage.status).toBe(200)
    expect(await usage.json()).toMatchObject({
      status: 'read_only',
      limits: { maxResources: 20 },
      asksToday: 0,
      asks30d: 0,
    })
    // Portal deletion, platform administration and other portal routes stay closed.
    for (
      const [method, path] of [
        ['DELETE', '/api/admin/tenants/marine'],
        ['GET', '/api/admin/groups'],
        ['GET', '/api/admin/t/marine/audit'],
        ['POST', '/api/admin/t/marine/disable'],
      ] as const
    ) {
      const refused = await f.invoke(path, { method })
      expect([method, path, refused.status]).toEqual([method, path, 403])
      expect(await refused.json()).toEqual({ error: 'operator_not_allowed' })
    }
    expect(f.stores.tenants.get('marine')).not.toBeNull()
    const events = f.events()
    expect(
      events.filter((event) => event.action === 'portal.lifecycle.update')
        .map((event) => event.outcome).sort(),
    ).toEqual(['intent', 'success', 'success'])
    expect(events.every((event) => event.actor_id === 'operator:hosting-automation')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(operatorKey)
  } finally {
    f.close()
  }
})

Deno.test('Operator KB binding accepts endpoint or legacy url and rejects ambiguous or missing endpoints', async () => {
  const f = await fixture()
  const originalGetJson = KbClient.prototype.getJson
  const probes: string[] = []
  KbClient.prototype.getJson = <T>(path: string): Promise<T> => {
    probes.push(path)
    return Promise.resolve({ resources: 2 } as T)
  }
  const endpoint = 'https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/fixture-box'
  const token = 'fixture-binding-token-long-enough'
  try {
    for (
      const body of [
        { endpoint, url: endpoint, token },
        { token },
        { endpoint, token, extra: 'ignored' },
      ]
    ) {
      const response = await f.invoke(
        '/api/admin/t/marine/knowledge-box',
        jsonRequest('POST', body),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_binding' })
    }
    expect(probes).toEqual([])
    for (
      const body of [{ endpoint: ` ${endpoint} `, token: `Bearer ${token}` }, {
        url: endpoint,
        token,
      }]
    ) {
      const response = await f.invoke(
        '/api/admin/t/marine/knowledge-box',
        jsonRequest('POST', body),
      )
      expect(response.status).toBe(200)
      expect(f.stores.bindings.get('marine')?.kbId).toBe('fixture-box')
      expect(f.stores.bindings.get('marine')?.token).toBe(token)
    }
    expect(probes).toEqual(['/counters', '/counters'])
    expect(JSON.stringify(f.events())).not.toContain(operatorKey)
    expect(JSON.stringify(f.events())).not.toContain(token)
  } finally {
    KbClient.prototype.getJson = originalGetJson
    f.close()
  }
})

Deno.test('Worker refuses wrong, absent, malformed and disabled operator credentials without downgrade', async () => {
  for (
    const [configured, authorization] of [
      [operatorKey, `Operator ${'B'.repeat(43)}`],
      [operatorKey, 'Operator'],
      [operatorKey, 'Operator short'],
      [operatorKey, `Operator ${operatorKey} extra`],
      [undefined, `Operator ${operatorKey}`],
      ['', `Operator ${operatorKey}`],
      ['short', 'Operator short'],
      ['x'.repeat(43) + '=', `Operator ${'x'.repeat(43)}=`],
    ] as const
  ) {
    const f = await fixture({ OPERATOR_API_KEY: configured })
    try {
      const response = await f.invoke('/api/admin/t/marine/members', {
        headers: { 'x-admin-passcode': 'fixture-passcode' },
      }, authorization)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_operator' })
      expect(f.forwarded).toHaveLength(0)
      expect(f.events().some((event) => event.action === 'request.denied')).toBe(true)
      expect(JSON.stringify(f.events())).not.toContain(operatorKey)
    } finally {
      f.close()
    }
  }
})

Deno.test('Worker operators cannot use unflagged, owner-only, data-plane or non-API routes', async () => {
  const f = await fixture()
  try {
    for (
      const [method, path] of [
        ['GET', '/api/admin/overview'],
        ['POST', '/api/admin/t/marine/disable'],
        ['DELETE', '/api/admin/tenants/marine'],
        ['GET', '/api/admin/people'],
        ['POST', '/api/admin/people'],
        ['GET', '/api/t/marine/config'],
        ['POST', '/api/t/marine/ask'],
        ['GET', '/api/health'],
        ['GET', '/auth/me'],
        ['GET', '/auth/login'],
        ['GET', '/'],
        ['GET', '/app.js'],
      ]
    ) {
      const before = f.events().length
      const response = await f.invoke(path!, { method })
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(await response.json()).toEqual({ error: 'operator_not_allowed' })
      const added = f.events().filter((event) => event.actor_id === 'operator:hosting-automation')
      expect(f.events().length).toBeGreaterThan(before)
      expect(added.some((event) => event.action === 'request.denied')).toBe(true)
    }
    expect(f.stores.tenants.isDisabled('marine')).toBe(false)
    expect(f.stores.tenants.get('marine')).not.toBeNull()
  } finally {
    f.close()
  }
})

Deno.test('Worker refuses the operator key under Bearer and never uses it as a session or data key', async () => {
  const f = await fixture()
  try {
    for (const path of ['/api/admin/t/marine/members', '/api/t/marine/config', '/auth/me', '/']) {
      const response = await f.invoke(path, {}, `Bearer ${operatorKey}`)
      expect(response.status, path).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_operator' })
    }
    expect(f.forwarded).toHaveLength(0)
    expect(JSON.stringify(f.events())).not.toContain(operatorKey)
  } finally {
    f.close()
  }
})

Deno.test('Operator data-plane denial remains audited after the MCP credential limiter is exhausted', async () => {
  const f = await fixture()
  try {
    const path = '/api/t/marine/mcp'
    const invalidBearer = `Bearer ck_${'A'.repeat(43)}`
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await f.invoke(path, {}, invalidBearer)
      expect(response.status).toBe(401)
      await response.text()
    }
    const limited = await f.invoke(path, {}, invalidBearer)
    expect(limited.status).toBe(429)
    await limited.text()
    const previousIds = new Set(f.events().map((event) => event.id))
    const operator = await f.invoke(path)
    expect(operator.status).toBe(403)
    expect(await operator.json()).toEqual({ error: 'operator_not_allowed' })
    const denials = f.events().filter((event) => !previousIds.has(event.id))
    expect(denials).toHaveLength(1)
    expect(denials[0]?.action).toBe('request.denied')
    expect(denials[0]?.actor_kind).toBe('operator')
    expect(denials[0]?.actor_id).toBe('operator:hosting-automation')
    expect(denials[0]?.outcome).toBe('denied')
    expect(JSON.stringify(denials)).not.toContain(operatorKey)
  } finally {
    f.close()
  }
})

Deno.test('Worker operator automation works without Entra and defaults the audit identity', async () => {
  const f = await fixture({ ENTRA_TENANT_ID: undefined, OPERATOR_ID: undefined })
  try {
    const response = await f.invoke(
      '/api/admin/tenants',
      jsonRequest('POST', { name: 'Headless Lab' }),
    )
    expect(response.status).toBe(200)
    expect(f.stores.tenants.get('headless-lab')).not.toBeNull()
    expect(f.events().every((event) => event.actor_id === 'operator:operator')).toBe(true)
    expect(f.events().every((event) => event.actor_kind === 'operator')).toBe(true)
  } finally {
    f.close()
  }
})

Deno.test('DO rejects forged, stale, wrong-audience and raw operator credentials', async () => {
  const f = await fixture()
  try {
    const payload = {
      v: 1 as const,
      kind: 'operator' as const,
      aud: 'corpuskit' as const,
      id: 'hosting-automation',
      iat: Math.floor(Date.now() / 1000),
    }
    const valid = await signPrincipal(payload, sessionSecret)
    const malformed = [
      'caller-forgery',
      `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`,
      await signPrincipal({ ...payload, iat: payload.iat - 61 }, sessionSecret),
      await signPrincipal({ ...payload, iat: payload.iat + 32 }, sessionSecret),
      await signPrincipal({ ...payload, aud: 'corpuskit-demo' }, sessionSecret),
      await signPrincipal({ ...payload, id: 'another-operator' }, sessionSecret),
    ]
    for (const header of malformed) {
      const response = await f.object.fetch(
        new Request('https://corpuskit.test/api/admin/t/marine/members', {
          headers: { [PRINCIPAL_HEADER]: header },
        }),
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_principal' })
    }
    const raw = await f.object.fetch(
      new Request('https://corpuskit.test/api/admin/t/marine/members', {
        headers: { authorization: `Operator ${operatorKey}` },
      }),
    )
    expect(raw.status).toBe(401)
    const forgedIngress = await f.invoke('/api/admin/t/marine/members', {
      headers: { [PRINCIPAL_HEADER]: valid, 'x-corpuskit-sso-admin': '1' },
    }, '')
    expect(forgedIngress.status).toBe(401)
    expect(JSON.stringify(f.events())).not.toContain(operatorKey)
  } finally {
    f.close()
  }
})

Deno.test('DO refuses a correctly signed operator envelope while the operator key is disabled', async () => {
  for (const configured of [undefined, '', 'short']) {
    const f = await fixture({ OPERATOR_API_KEY: configured })
    try {
      const header = await signPrincipal({
        v: 1,
        kind: 'operator',
        aud: 'corpuskit',
        id: 'hosting-automation',
        iat: Math.floor(Date.now() / 1000),
      }, sessionSecret)
      const response = await f.object.fetch(
        new Request('https://corpuskit.test/api/admin/t/marine/members', {
          method: 'POST',
          headers: { [PRINCIPAL_HEADER]: header, 'content-type': 'application/json' },
          body: JSON.stringify({
            subjectKind: 'pending-email',
            subjectId: 'reader@example.test',
            role: 'viewer',
          }),
        }),
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_principal' })
      const denials = f.events().filter((event) => event.action === 'request.denied')
      expect(denials).toHaveLength(1)
      expect(denials[0]?.actor_kind).toBe('anonymous')
      expect(f.events().some((event) => event.action === 'assignment.create')).toBe(false)
    } finally {
      f.close()
    }
  }
})

Deno.test('Operator audit failures stop mutations and credentials never enter diagnostic logs', async () => {
  const f = await fixture()
  const messages: unknown[][] = []
  const originals = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => messages.push(args)
  console.warn = (...args: unknown[]) => messages.push(args)
  console.error = (...args: unknown[]) => messages.push(args)
  try {
    f.database.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'audit fixture failure'); END",
    )
    const response = await f.invoke(
      '/api/admin/tenants',
      jsonRequest('POST', { name: 'Blocked Lab' }),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain(operatorKey)
    expect(f.stores.tenants.get('blocked-lab')).toBeUndefined()
    const denied = await f.invoke('/api/admin/t/marine/members', {}, `Operator ${'B'.repeat(43)}`)
    expect(denied.status).toBe(500)
    expect(await denied.json()).toEqual({ error: 'audit_write_failed' })
    expect(JSON.stringify(messages)).not.toContain(operatorKey)
    expect(JSON.stringify(messages)).not.toContain('B'.repeat(43))
  } finally {
    Object.assign(console, originals)
    f.close()
  }
})

Deno.test('Worker refusals reach the Durable Object without credentials, cookies, passcodes or a body', async () => {
  const cases = [
    ['operator key under Bearer', {}, `Bearer ${operatorKey}`, true, 'invalid_operator'],
    ['wrong operator key', {}, `Operator ${'B'.repeat(43)}`, true, 'invalid_operator'],
    // A correct key still fails closed when the Worker cannot sign the principal.
    [
      'short signing secret',
      { SESSION_SECRET: 'too-short' },
      `Operator ${operatorKey}`,
      false,
      'invalid_principal',
    ],
    [
      'missing audience',
      { WORKER_NAME: '' },
      `Operator ${operatorKey}`,
      false,
      'invalid_principal',
    ],
  ] as const
  for (const [label, overrides, authorization, passcode, error] of cases) {
    const f = await fixture(overrides)
    try {
      const response = await f.invoke('/api/admin/t/marine/members', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'corpuskit_session=fixture-session-cookie',
          ...(passcode ? { 'x-admin-passcode': 'fixture-passcode' } : {}),
        },
        body: JSON.stringify(newMember),
      }, authorization)
      expect(response.status, label).toBe(401)
      expect(await response.json()).toEqual({ error })
      expect(f.forwarded).toHaveLength(0)
      expect(f.refusals.length, label).toBeGreaterThan(0)
      for (const refusal of f.refusals) {
        expect(refusal.method).toBe('POST')
        expect(refusal.headers.authorization, label).toBeUndefined()
        expect(refusal.headers.cookie, label).toBeUndefined()
        expect(refusal.headers['x-admin-passcode'], label).toBeUndefined()
        expect(refusal.headers[PRINCIPAL_HEADER], label).toBeUndefined()
        expect(refusal.body, label).toBe(false)
      }
      expect(JSON.stringify(f.refusals)).not.toContain(operatorKey)
      expect(JSON.stringify(f.refusals)).not.toContain('fixture-session-cookie')
      const denials = f.events().filter((event) => event.action === 'request.denied')
      expect(denials).toHaveLength(1)
      expect(denials[0]?.actor_kind).toBe('anonymous')
      expect(f.events().some((event) => event.action === 'assignment.create')).toBe(false)
    } finally {
      f.close()
    }
  }
})

Deno.test('DO refuses a signed operator envelope that arrives with a session or explicit credential', async () => {
  const cases: [string, TrustedRequestContext, Record<string, string>][] = [
    ['session facts', { session: ownerFacts() }, {}],
    ['portal data key', {}, { authorization: `Bearer ck_${'A'.repeat(43)}` }],
    ['raw operator key', {}, { authorization: `Operator ${operatorKey}` }],
    ['break-glass passcode', {}, { 'x-admin-passcode': 'fixture-passcode' }],
  ]
  for (const [label, context, headers] of cases) {
    const f = await fixture()
    try {
      const response = await f.object.handleTrustedRequest(
        new Request('https://corpuskit.test/api/admin/t/marine/members', {
          method: 'POST',
          headers: {
            [PRINCIPAL_HEADER]: await operatorPrincipal(),
            'content-type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(newMember),
        }),
        context,
      )
      expect(response.status, label).toBe(401)
      expect(await response.json(), label).toEqual({ error: 'invalid_principal' })
      const events = f.events()
      expect(events, label).toHaveLength(1)
      expect(events[0]?.action).toBe('request.denied')
      expect(events[0]?.actor_kind, label).toBe('anonymous')
      expect(f.stores.rbac.assignments.list('tenant-1'), label).toEqual([])
      expect(JSON.stringify(events)).not.toContain(operatorKey)
    } finally {
      f.close()
    }
  }
})

Deno.test('Worker rate limits invalid operator credentials per address without limiting verified calls', async () => {
  const f = await fixture()
  const path = '/api/admin/t/marine/members'
  const wrong = `Operator ${'B'.repeat(43)}`
  const denials = () => f.events().filter((event) => event.action === 'request.denied').length
  try {
    for (let attempt = 0; attempt < OPERATOR_FAILURE_LIMIT_PER_MIN; attempt++) {
      const response = await f.invoke(path, {}, wrong)
      expect(response.status).toBe(401)
      await response.body?.cancel()
    }
    expect(denials()).toBe(OPERATOR_FAILURE_LIMIT_PER_MIN)
    for (const authorization of [wrong, `Bearer ${operatorKey}`]) {
      const limited = await f.invoke(path, {}, authorization)
      expect(limited.status).toBe(429)
      expect(await limited.json()).toEqual({ error: 'rate_limited' })
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    expect(denials()).toBe(OPERATOR_FAILURE_LIMIT_PER_MIN)
    const elsewhere = await f.invoke(
      path,
      { headers: { 'cf-connecting-ip': '198.51.100.7' } },
      wrong,
    )
    expect(elsewhere.status).toBe(401)
    expect(await elsewhere.json()).toEqual({ error: 'invalid_operator' })
    expect(denials()).toBe(OPERATOR_FAILURE_LIMIT_PER_MIN + 1)
    const verified = await f.invoke(path)
    expect(verified.status).toBe(200)
    expect(JSON.stringify(f.events())).not.toContain(operatorKey)
  } finally {
    f.close()
  }
})

Deno.test('Durable Object warns once without the value when a present operator key is unusable', async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  const operatorWarnings = () => warnings.filter((line) => line.includes('operator credential'))
  try {
    const misconfigured = [
      [{ OPERATOR_API_KEY: `${operatorKey}=` }, 'OPERATOR_API_KEY'],
      [{ OPERATOR_API_KEY: 'short-operator-fixture' }, 'OPERATOR_API_KEY'],
      [{ OPERATOR_ID: 'hosting automation' }, 'OPERATOR_ID'],
    ] as const
    for (const [overrides, variable] of misconfigured) {
      warnings.length = 0
      const f = await fixture(overrides)
      try {
        expect(operatorWarnings()).toHaveLength(1)
        expect(operatorWarnings()[0]).toContain(variable)
        const response = await f.invoke('/api/admin/t/marine/members')
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'invalid_operator' })
        expect(operatorWarnings()).toHaveLength(1)
        expect(JSON.stringify(warnings)).not.toContain(operatorKey)
        expect(JSON.stringify(warnings)).not.toContain('short-operator-fixture')
        expect(JSON.stringify(warnings)).not.toContain('hosting automation')
      } finally {
        f.close()
      }
    }
    for (const overrides of [{}, { OPERATOR_API_KEY: undefined }, { OPERATOR_API_KEY: '' }]) {
      warnings.length = 0
      const f = await fixture(overrides)
      f.close()
      expect(operatorWarnings()).toEqual([])
    }
  } finally {
    console.warn = originalWarn
  }
})

/** Platform base class and provider/domain I/O are doubled; signed ingress and SQLite are real. */
async function loadWorker(): Promise<WorkerModule> {
  const workerUrl = new URL('./worker.ts', import.meta.url)
  const durableObjectShim =
    'data:application/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }'
  const source = (await Deno.readTextFile(workerUrl))
    .replace("from 'cloudflare:workers'", `from '${durableObjectShim}'`)
    .replace(
      "import { AragProvider } from '@research-portal/retrieval'",
      `import { DoubleProvider } from '${
        new URL('../../../e2e/support/double-provider.ts', import.meta.url).href
      }'; class AragProvider extends DoubleProvider {
        invalidate() {}
        counters() { return Promise.resolve({ resources: 2, paragraphs: 3, sentences: 4 }) }
        resourceFull(_config, id) {
          return Promise.resolve({ id, title: 'Fixture document', slug: id, kind: 'text',
            texts: [{ body: 'Fixture evidence' }], topicIds: [] })
        }
        hasSlug() { return Promise.resolve(false) }
        createText() { return Promise.resolve({ id: 'copied-resource' }) }
      }`,
    )
    .replace(
      'domainProvisioner: createCloudflareDomainProvisioner(bindings),',
      `domainProvisioner: {
        attach: async (hostname) => ({ hostname, created: true }),
        detach: async (hostname) => ({ hostname, removed: true }),
      },`,
    )
    .replaceAll(
      /from '(\.\.?\/[^']+)'/g,
      (_match, specifier: string) => `from '${new URL(specifier, workerUrl).href}'`,
    )
  return await import(`data:application/typescript,${encodeURIComponent(source)}`) as WorkerModule
}
