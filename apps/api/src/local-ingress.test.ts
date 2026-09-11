import { expect } from '@std/expect'
import { LocalIngress } from './local-ingress.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import type { TrustedSessionFacts } from './principal.ts'

const session = (): TrustedSessionFacts => ({
  verified: true,
  tenantId: 'tenant-1',
  oid: 'person-1',
  email: 'person@example.test',
  roles: [],
  groups: [],
  groupStatus: 'absent',
  claimIssuedAt: Date.now(),
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
})
const env = { ENTRA_TENANT_ID: 'tenant-1', ADMIN_PASSCODE: 'fixture' }
const peer = { remoteAddr: { transport: 'tcp' as const, hostname: '127.0.0.1', port: 1234 } }

Deno.test('local ingress strips caller authority and uses only actual peer metadata', async () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const rbac = new RbacState(db)
    rbac.migrate()
    const ingress = new LocalIngress({ rbac, tenants: { list: () => [] }, env })
    for (const info of [undefined, peer]) {
      const response = await ingress.handle(
        new Request('http://localhost/api/admin/overview', {
          headers: {
            'x-corpuskit-principal': 'forged',
            'x-corpuskit-sso-admin': '1',
            'x-sso-user-id': 'owner',
            'x-admin-passcode': 'fixture',
            'x-forwarded-for': '10.0.0.1',
            'cf-connecting-ip': '10.0.0.2',
          },
        }),
        (request) => {
          const context = ingress.requestContext(request)
          expect(context?.session).toBeNull()
          expect(context?.coarseAdminEligible).toBe(false)
          expect(context?.clientIp).toBe(info ? '127.0.0.1' : undefined)
          expect(request.headers.get('x-corpuskit-principal')).toBeNull()
          expect(request.headers.get('x-corpuskit-sso-admin')).toBeNull()
          expect(request.headers.get('x-sso-user-id')).toBeNull()
          expect(request.headers.has('x-admin-passcode')).toBe(Boolean(info))
          return new Response('ok')
        },
        info,
      )
      expect(response.status).toBe(200)
    }
    const me = await ingress.handle(new Request('http://localhost/auth/me'), () => {
      throw new Error('auth/me must be handled at ingress')
    })
    expect(await me.json()).toMatchObject({
      authenticated: false,
      user: null,
      coarseAdminEligible: false,
      breakGlassEnabled: true,
    })
  } finally {
    db.close()
  }
})

Deno.test('local verified fixtures sign and verify, activate bootstrap once and read current assignments', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'local-ingress-' })
  let db = new LocalRbacDatabase(`${dir}/rbac.sqlite`)
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const rbac = new RbacState(db)
      rbac.migrate()
      const ingress = new LocalIngress({
        rbac,
        tenants: { list: () => [{ slug: 'a' }] },
        env: { ...env, ENTRA_ADMIN_EMAILS: 'person@example.test' },
      })
      const me = await ingress.handle(
        new Request('http://localhost/auth/me'),
        () => new Response(),
        peer,
        session(),
      )
      expect(await me.json()).toMatchObject({
        authenticated: true,
        effectiveRoles: {
          platformRole: 'owner',
          portalRoles: [{ slug: 'a', role: 'portal-admin' }],
        },
      })
      expect(rbac.assignments.list('tenant-1')).toHaveLength(1)
      expect(
        rbac.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
          e.action === 'migration.admin_emails'
        ),
      ).toHaveLength(1)
      const service = rbac.assignmentService('tenant-1')
      service.create({
        subjectKind: 'active-oid',
        subjectId: 'other',
        role: 'platform-admin',
        scope: { kind: 'platform' },
      }, { requestId: 'fixture', actor: { kind: 'system' } })
      const other = { ...session(), oid: 'other', email: 'other@example.test' }
      const initial = await ingress.handle(
        new Request('http://localhost/auth/me'),
        () => new Response(),
        peer,
        other,
      )
      expect((await initial.json()).coarseAdminEligible).toBe(true)
      const row = rbac.assignments.list('tenant-1').find((a) => a.subjectId === 'other')!
      service.remove(row.id, { requestId: 'fixture', actor: { kind: 'system' } })
      const after = await ingress.handle(
        new Request('http://localhost/auth/me'),
        () => new Response(),
        peer,
        other,
      )
      expect((await after.json()).coarseAdminEligible).toBe(false)
      if (iteration === 0) {
        db.close()
        db = new LocalRbacDatabase(`${dir}/rbac.sqlite`)
      }
    }
  } finally {
    db.close()
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('local production never uses a dev secret or accepts disabled passcodes', async () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const rbac = new RbacState(db)
    rbac.migrate()
    const options = {
      rbac,
      tenants: { list: () => [] },
      env: { ...env, ENVIRONMENT: 'production' },
    }
    expect(() => new LocalIngress(options)).toThrow('SESSION_SECRET')
    const ingress = new LocalIngress({
      ...options,
      env: { ...options.env, SESSION_SECRET: 'x'.repeat(32) },
    })
    await ingress.handle(
      new Request('http://localhost/api/admin/overview', {
        headers: { 'x-admin-passcode': 'fixture' },
      }),
      (request) => {
        expect(request.headers.has('x-admin-passcode')).toBe(false)
        return new Response()
      },
      peer,
    )
    const invalid = await ingress.handle(
      new Request('http://localhost/auth/me'),
      () => new Response(),
      peer,
      { ...session(), expiresAt: 0 },
    )
    expect(invalid.status).toBe(401)
    expect(
      rbac.audit.read({ scope: { kind: 'platform' } }).some((event) =>
        event.action === 'request.denied' && event.outcome === 'denied'
      ),
    ).toBe(true)
  } finally {
    db.close()
  }
})

Deno.test('local signing and denial audit fail closed without dispatching', async () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const rbac = new RbacState(db)
    rbac.migrate()
    const ingress = new LocalIngress({
      rbac,
      tenants: { list: () => [] },
      env: { ...env, SESSION_SECRET: 'too-short' },
    })
    const dispatch = () => {
      throw new Error('Must not dispatch invalid identity')
    }
    expect(
      (await ingress.handle(new Request('http://localhost/auth/me'), dispatch, peer, session()))
        .status,
    ).toBe(401)
    db.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect(
      (await ingress.handle(new Request('http://localhost/auth/me'), dispatch, peer, session()))
        .status,
    ).toBe(500)
  } finally {
    db.close()
  }
})
