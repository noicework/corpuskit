import { expect } from '@std/expect'
import { type Permission, type Role, ROLES, type Scope } from '@research-portal/core'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { DurableState, durableStores, type SqlStorageLike } from '../../cloudflare/src/state.ts'
import { buildApp, type BuildAppOptions, type PortalRequestContext } from './app.ts'
import { coarseAdminEligibility, resolveEffectiveRoles } from './assignments.ts'
import type { AuthorityDependencies } from './authorisation.ts'
import type { BreakGlassPolicy } from './break-glass.ts'
import { type TrustedSessionFacts, validSessionFacts } from './principal.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import type { SqlValue } from './rbac-state.ts'
import { tenantConfig } from './tenants.ts'
import { type Declaration, declarationFor } from './permissions.ts'
import { localOwnedStores } from './local-owned-stores.ts'

/** Expectations are supplied independently by each activated route family's fixtures. */
export function assertExpectedPermission(
  method: string,
  path: string,
  permission: Permission,
  scope: Declaration['scope'],
): void {
  const declaration = declarationFor(method, path)
  expect(declaration.permission).toBe(permission)
  expect(declaration.scope).toBe(scope)
}

export interface ProviderCall {
  method: string
  args: unknown[]
}

/** Independent test expectations. Never populate this from production declarations. */
export interface EnforcementRouteCase {
  method: string
  path: string
  params: Record<string, string>
  body: unknown
  seed: (fixture: EnforcementFixture) => void | Promise<void>
  expectedPermission: Permission
  expectedScope: Scope
  assertAllowed: (response: Response, fixture: EnforcementFixture) => void | Promise<void>
}

export function assertNoProtectedDispatch(calls: readonly ProviderCall[], since = 0): void {
  expect(calls.slice(since)).toEqual([])
}

/** Hermetic trusted facts. The slug is part of the oid to keep every persona distinct. */
export function sessionFor(
  role: Role,
  slug = 'a',
  now = Date.UTC(2026, 8, 12),
): TrustedSessionFacts {
  return {
    verified: true,
    tenantId: 'tenant-1',
    oid: `${role}-${slug}`,
    email: `${role}-${slug}@example.test`,
    roles: role === 'owner'
      ? ['CorpusKit.Owner']
      : role === 'platform-admin'
      ? ['CorpusKit.PlatformAdmin']
      : [],
    groups: [],
    groupStatus: 'absent',
    claimIssuedAt: now - 120_000,
    createdAt: now - 60_000,
    expiresAt: now + 3600_000,
  }
}

/** Test-only SQLite, trusted request-context and provider boundary for all route families. */
export function createEnforcementFixture(
  options: Pick<BuildAppOptions, 'management' | 'domainProvisioner'> & {
    breakGlassPolicy?: BreakGlassPolicy
  } = {},
  ownedAdapter: 'durable' | 'local' = 'durable',
) {
  const directory = Deno.makeTempDirSync({ prefix: 'enforcement-' })
  const database = new LocalRbacDatabase(`${directory}/state.sqlite`)
  let clock = Date.UTC(2026, 8, 12)
  const now = () => clock
  const sql: SqlStorageLike = {
    exec<T extends Record<string, ArrayBuffer | string | number | null>>(
      query: string,
      ...bindings: unknown[]
    ) {
      const values = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value
      ) as SqlValue[]
      let rows: T[] = []
      if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
        rows = database.all<T>(query, ...values)
      } else database.exec(query, ...values)
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error('Expected exactly one SQL row')
          return rows[0]!
        },
      }
    },
  }
  const state = new DurableState(sql, database, now)
  state.migrate()
  const durable = durableStores(state, {})
  const stores = {
    ...durable,
    ...(ownedAdapter === 'local'
      ? localOwnedStores(directory, state.rbacDatabase, state.rbac.audit)
      : {}),
    tenants: durable.tenants,
  }
  const tenantId = 'tenant-1'
  const audience = 'corpuskit'
  for (const accessMode of ['public', 'authenticated', 'restricted'] as const) {
    for (const suffix of ['a', 'b']) {
      const slug = accessMode === 'restricted' ? suffix : `${accessMode}-${suffix}`
      stores.tenants.seed({ ...tenantConfig('marine')!, slug, accessMode })
    }
  }
  stores.tenants.seed({ ...tenantConfig('marine')!, slug: 'disabled', accessMode: 'public' })
  stores.tenants.setDisabled('disabled', true)
  const raw = state.get<{ custom: Record<string, unknown> }>('tenants', { custom: {} })
  raw.custom.corrupt = { ...tenantConfig('marine'), slug: 'corrupt', accessMode: null }
  state.put('tenants', raw)
  const personas = new Map<string, TrustedSessionFacts>()
  const assignmentService = () => state.rbac.assignmentService(tenantId, audience)
  const persona = (role: Role, slug = 'a') => {
    const id = `${role}-${slug}`
    const existing = personas.get(id)
    if (existing) return structuredClone(existing)
    const session = sessionFor(role, slug, clock)
    if (role !== 'owner' && role !== 'platform-admin') {
      const result = assignmentService().create({
        subjectKind: 'active-oid',
        subjectId: session.oid,
        scope: { kind: 'portal', slug },
        role,
      }, { requestId: 'fixture-seed', actor: { kind: 'system' } })
      if (!result.ok) throw new Error('Fixture role assignment failed')
    }
    assignmentService().observeSession(session)
    personas.set(id, session)
    return structuredClone(session)
  }
  for (const role of ROLES) for (const slug of ['a', 'b']) persona(role, slug)
  const unassigned: TrustedSessionFacts = {
    ...sessionFor('viewer', 'unassigned', clock),
    oid: 'unassigned',
  }
  const otherTenant = { ...unassigned, tenantId: 'other-tenant', oid: 'other-tenant-user' }
  const providerCalls: ProviderCall[] = []
  const provider = new Proxy(new DoubleProvider(), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        providerCalls.push({ method: String(property), args })
        return value.apply(target, args)
      }
    },
  })
  const contexts = new WeakMap<Request, PortalRequestContext>()
  const contextFor = async (session: TrustedSessionFacts | null): Promise<PortalRequestContext> => {
    if (session && !validSessionFacts(session, clock)) throw new Error('Invalid fixture session')
    const resolution = await resolveEffectiveRoles(
      session,
      {
        rbac: state.rbac,
        tenants: stores.tenants,
        audience,
      },
      tenantId,
      clock,
    )
    return {
      requestId: crypto.randomUUID(),
      session,
      ...resolution,
      coarseAdminEligible: coarseAdminEligibility(resolution.effectiveRoles),
      clientIp: '192.0.2.1',
      actor: session ? { kind: 'user', id: session.oid } : { kind: 'anonymous' },
    }
  }
  const app = buildApp({
    ...stores,
    ...options,
    configuredTenantId: tenantId,
    audience,
    now,
    provider,
    requestContext: (request) => contexts.get(request),
    breakGlass: state.rbac.breakGlassService(
      options.breakGlassPolicy ?? { environment: 'production' },
    ),
    brandingPath: `${directory}/branding`,
    rateLimitAskPerMin: 0,
    rateLimitEstatePerMin: 0,
    rateLimitMcpAuthPerMin: 0,
  })
  const routeCases: EnforcementRouteCase[] = []
  return {
    directory,
    database,
    state,
    stores,
    rbac: state.rbac,
    tenantId,
    audience,
    now,
    advance: (ms: number) => {
      clock += ms
    },
    app,
    provider,
    providerCalls,
    routeCases,
    sessionFor: persona,
    anonymous: null,
    unassigned,
    otherTenant,
    creator: persona('portal-admin', 'a'),
    contextFor,
    authorityDependencies: (
      policy: BreakGlassPolicy = { environment: 'production' },
    ): AuthorityDependencies => ({
      configuredTenantId: tenantId,
      tenants: stores.tenants,
      keys: stores.mcpKeys,
      creatorStores: { rbac: state.rbac, audience },
      audit: state.rbac.audit,
      breakGlass: state.rbac.breakGlassService(policy),
      now,
    }),
    async requestAs(session: TrustedSessionFacts | null, path: string, init?: RequestInit) {
      const request = new Request(`http://localhost${path}`, init)
      contexts.set(request, await contextFor(session))
      try {
        return await app.fetch(request)
      } finally {
        contexts.delete(request)
      }
    },
    assertNoProtectedDispatch: (since = 0) => assertNoProtectedDispatch(providerCalls, since),
    failAudit: () =>
      database.exec(
        "CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
      ),
    recoverAudit: () => database.exec('DROP TRIGGER fixture_fail_audit'),
    close: () => {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

export type EnforcementFixture = ReturnType<typeof createEnforcementFixture>

/** Independent audit expectations, exercised by audit-routes.test.ts. */
export const AUDIT_ROUTE_CASES = [
  ['/api/admin/t/:slug/audit', 'audit.read', 'portal'],
  ['/api/admin/t/:slug/audit/export', 'audit.export', 'portal'],
  ['/api/admin/audit', 'audit.read', 'platform'],
  ['/api/admin/audit/export', 'audit.export', 'platform'],
] as const

/** Independent access endpoint fixtures, exercised by access-routes.test.ts. */
export const ACCESS_ROUTE_CASES = [
  { method: 'GET', path: '/api/admin/people' },
  {
    method: 'POST',
    path: '/api/admin/people',
    body: { subjectKind: 'active-oid', subjectId: 'access-target', role: 'platform-admin' },
  },
  { method: 'PATCH', path: '/api/admin/people/:id', body: { role: 'owner' } },
  { method: 'DELETE', path: '/api/admin/people/:id' },
  { method: 'GET', path: '/api/admin/groups' },
  {
    method: 'POST',
    path: '/api/admin/groups',
    body: { subjectId: 'access-target', role: 'platform-admin' },
  },
  { method: 'PATCH', path: '/api/admin/groups/:id', body: { role: 'owner' } },
  { method: 'DELETE', path: '/api/admin/groups/:id' },
  { method: 'GET', path: '/api/admin/t/:slug/members' },
  {
    method: 'POST',
    path: '/api/admin/t/:slug/members',
    body: { subjectKind: 'active-oid', subjectId: 'access-target', role: 'viewer' },
  },
  { method: 'PATCH', path: '/api/admin/t/:slug/members/:id', body: { role: 'curator' } },
  { method: 'DELETE', path: '/api/admin/t/:slug/members/:id' },
  { method: 'GET', path: '/api/admin/t/:slug/groups' },
  {
    method: 'POST',
    path: '/api/admin/t/:slug/groups',
    body: { subjectId: 'access-target', role: 'viewer' },
  },
  { method: 'PATCH', path: '/api/admin/t/:slug/groups/:id', body: { role: 'curator' } },
  { method: 'DELETE', path: '/api/admin/t/:slug/groups/:id' },
] as const
