import { expect } from '@std/expect'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { buildApp } from './app.ts'
import { LocalIngress } from './local-ingress.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import type { TrustedSessionFacts } from './principal.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'

const operatorKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const owner = (): TrustedSessionFacts => ({
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

function fixture(overrides: Record<string, string | undefined> = {}) {
  const directory = Deno.makeTempDirSync({ prefix: 'local-operator-' })
  const database = new LocalRbacDatabase(`${directory}/rbac.sqlite`)
  const rbac = new RbacState(database)
  rbac.migrate()
  const env = {
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'hosting-test',
    ...overrides,
  }
  const owned = localOwnedStores(directory, database, rbac.audit, env)
  const tenants = owned.tenants!
  const ingress = new LocalIngress({ rbac, tenants, env })
  const initialAuditIds = new Set(
    rbac.audit.read({ scope: { kind: 'platform' } }).map((event) => event.id),
  )
  const app = buildApp({
    ...owned,
    rbac,
    tenants,
    configuredTenantId: env.ENTRA_TENANT_ID,
    audience: 'corpuskit',
    provider: new DoubleProvider(),
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
  })
  const invoke = (
    path: string,
    init: RequestInit = {},
    session: TrustedSessionFacts | null = null,
  ) => {
    const headers = new Headers(init.headers)
    if (!headers.has('authorization')) headers.set('authorization', `Operator ${operatorKey}`)
    return ingress.handle(
      new Request(`http://localhost${path}`, { ...init, headers }),
      (request) => app.fetch(request),
      undefined,
      session,
    )
  }
  return {
    database,
    rbac,
    tenants,
    ingress,
    invoke,
    events: () =>
      rbac.audit.read({ scope: { kind: 'platform' } }).filter((event) =>
        !initialAuditIds.has(event.id)
      ),
    dispose() {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('local operator uses a signed principal without credentials, a session or assignment activation', async () => {
  const f = fixture()
  try {
    const assignment = f.rbac.assignmentService('tenant-1').create({
      subjectKind: 'pending-email',
      subjectId: 'owner@example.test',
      role: 'owner',
      scope: { kind: 'platform' },
    }, { requestId: 'setup', actor: { kind: 'system' } })
    expect(assignment.ok).toBe(true)
    const response = await f.ingress.handle(
      new Request('http://localhost/api/admin/t/marine/members', {
        headers: {
          authorization: `Operator ${operatorKey}`,
          'x-corpuskit-principal': 'forged',
          'x-sso-user-id': 'forged-owner',
        },
      }),
      (request) => {
        expect(request.headers.has('authorization')).toBe(false)
        expect(request.headers.has('x-corpuskit-principal')).toBe(false)
        expect(request.headers.has('x-sso-user-id')).toBe(false)
        const context = f.ingress.requestContext(request)
        expect(context?.operator).toEqual({ id: 'hosting-test' })
        expect(context?.session).toBeNull()
        expect(context?.user).toBeNull()
        expect(context?.effectiveRoles).toEqual({
          platformRole: 'platform-admin',
          portalRoles: [],
        })
        expect(context?.coarseAdminEligible).toBe(true)
        return new Response('ok')
      },
      undefined,
      owner(),
    )
    expect(response.status).toBe(200)
    expect(f.rbac.assignments.list('tenant-1')[0]?.subjectKind).toBe('pending-email')
    expect(f.database.all('SELECT * FROM rbac_owner_evidence')).toEqual([])
  } finally {
    f.dispose()
  }
})

Deno.test('local operator manages portal access and email members with its audit actor', async () => {
  const f = fixture()
  try {
    const created = await f.invoke(
      '/api/admin/t/marine/members',
      json('POST', {
        subjectKind: 'pending-email',
        subjectId: 'reader@example.test',
        role: 'viewer',
      }),
    )
    expect(created.status).toBe(201)
    const member = await created.json()
    expect(member.subjectKind).toBe('pending-email')
    const list = await f.invoke('/api/admin/t/marine/members')
    expect(list.status).toBe(200)
    expect((await list.json()).items).toHaveLength(1)
    const access = await f.invoke(
      '/api/admin/t/marine/access',
      json('PATCH', {
        accessMode: 'restricted',
      }),
    )
    expect(access.status).toBe(200)
    expect(f.tenants.get('marine')?.accessMode).toBe('restricted')
    expect(
      (await f.invoke(`/api/admin/t/marine/members/${member.id}`, {
        method: 'DELETE',
      })).status,
    ).toBe(200)
    const events = f.events()
    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events.every((event) => event.actor_kind === 'operator')).toBe(true)
    expect(events.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(events.filter((event) => event.action === 'request.privileged')).toHaveLength(8)
    expect(JSON.stringify(events)).not.toContain(operatorKey)
    expect(JSON.stringify(events)).not.toContain('Authorization')
  } finally {
    f.dispose()
  }
})

Deno.test('local operator refuses malformed, wrong, missing, disabled and conflicting credentials without fallback', async () => {
  const cases: [Record<string, string | undefined>, HeadersInit][] = [
    [{}, { authorization: `Operator ${'Ag'.repeat(22)}` }],
    [{}, { authorization: 'Operator' }],
    [{}, { authorization: 'Operator invalid' }],
    [{ OPERATOR_API_KEY: undefined }, { authorization: `Operator ${operatorKey}` }],
    [{ OPERATOR_API_KEY: '' }, { authorization: `Operator ${operatorKey}` }],
    [{ OPERATOR_API_KEY: 'short' }, { authorization: 'Operator short' }],
    [{ OPERATOR_ID: '\ninvalid' }, { authorization: `Operator ${operatorKey}` }],
    [{}, { authorization: `Bearer ${operatorKey}` }],
    [{ ADMIN_PASSCODE: 'fixture' }, {
      authorization: `Operator ${operatorKey}`,
      'x-admin-passcode': 'fixture',
    }],
  ]
  for (const [env, headers] of cases) {
    const f = fixture(env)
    try {
      const response = await f.invoke('/api/admin/t/marine/members', { headers }, owner())
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_operator' })
      const events = f.events()
      expect(events.some((event) => event.action === 'request.denied')).toBe(true)
      expect(JSON.stringify(events)).not.toContain(operatorKey)
      expect(f.rbac.assignments.list('tenant-1')).toEqual([])
    } finally {
      f.dispose()
    }
  }
})

Deno.test('local operator refuses public, data-plane, unflagged and owner-only routes', async () => {
  const f = fixture()
  try {
    const cases: [string, string][] = [
      ['GET', '/api/health'],
      ['GET', '/api/t/marine/config'],
      ['GET', '/api/t/marine/search?query=evidence'],
      ['POST', '/api/t/marine/ask'],
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/t/marine/groups'],
      ['PATCH', '/api/admin/t/marine/members/unknown'],
      ['GET', '/api/admin/people'],
      ['DELETE', '/api/admin/tenants/marine'],
      ['GET', '/api/admin/unmatched'],
      ['GET', '/auth/me'],
      ['GET', '/'],
      ['GET', '/__corpuskit/private'],
    ]
    for (const [method, path] of cases) {
      const response = await f.invoke(path, { method }, owner())
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'operator_not_allowed' })
    }
    const events = f.events()
    expect(events.filter((event) => event.action === 'request.denied')).toHaveLength(cases.length)
    expect(events.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(f.tenants.get('marine')).not.toBeNull()
  } finally {
    f.dispose()
  }
})

Deno.test('local operator defaults its audit id and leaves requests without credentials anonymous', async () => {
  const f = fixture({ OPERATOR_ID: undefined })
  try {
    expect((await f.invoke('/api/admin/t/marine/members')).status).toBe(200)
    expect(
      f.events().every((event) => event.actor_id === 'operator:operator'),
    ).toBe(true)
    const anonymous = await f.ingress.handle(
      new Request('http://localhost/api/health'),
      (request) => {
        expect(f.ingress.requestContext(request)?.operator).toBeUndefined()
        expect(f.ingress.requestContext(request)?.effectiveRoles?.platformRole).toBeUndefined()
        return new Response('ok')
      },
    )
    expect(anonymous.status).toBe(200)
  } finally {
    f.dispose()
  }
})

Deno.test('local operator fails closed on audit and signing failure without logging credentials', async () => {
  const originalError = console.error
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => logs.push(args)
  try {
    for (const path of ['/auth/me', '/api/admin/t/marine/access']) {
      const f = fixture()
      try {
        f.database.exec(
          "CREATE TRIGGER fail_operator_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
        )
        const response = await f.invoke(
          path,
          path === '/auth/me' ? {} : json('PATCH', { accessMode: 'restricted' }),
        )
        expect(response.status).toBe(500)
        expect(await response.text()).not.toContain(operatorKey)
        expect(f.tenants.get('marine')?.accessMode).toBe('public')
      } finally {
        f.dispose()
      }
    }
    const f = fixture({ SESSION_SECRET: 'too-short' })
    try {
      const response = await f.invoke('/api/admin/t/marine/members')
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_principal' })
      expect(f.events()[0]?.actor_id).toBe(
        'operator:hosting-test',
      )
    } finally {
      f.dispose()
    }
    expect(JSON.stringify(logs)).not.toContain(operatorKey)
  } finally {
    console.error = originalError
  }
})
