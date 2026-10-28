import { expect } from '@std/expect'
import type { ExportResource } from '@research-portal/retrieval'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { readExportZip } from '../../../e2e/support/portal-export-fixture.ts'
import { createAuditEvent } from './audit.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { declarationFor } from './permissions.ts'
import { redactExport } from './portal-export-redaction.ts'
import { ExportLimitError, ExportZip } from './portal-export-zip.ts'
import { PORTAL_EXPORT_MAX_BYTES, PORTAL_EXPORT_PATH } from './portal-export.ts'

const path = '/api/admin/t/a/export'
const key = 'ck_' + 'k'.repeat(43)
const jwt = 'eyJ0ZXN0IjoidGVzdCJ9.eyJleHAiOjF9.c2lnbmF0dXJl'

Deno.test('export redacts nested credentials and signed URLs, retaining ordinary metadata', () => {
  const input = {
    title: 'Fisheries research',
    apiKey: 'plain-api-value',
    token: 'plain-token-value',
    nested: {
      sealedToken: 'enc:v1:sealed-value',
      private_key: 'private-value',
      authorization: 'Bearer bearer-value',
      password: 'password-value',
      data: [{
        hash: 'hashed-value',
        value: `${key} ${jwt} Bearer bearer-value enc:v1:sealed-value`,
      }],
    },
    originUrl:
      'https://user:password-value@research.example.test/article?year=2026&token=url-token&X-Amz-Signature=signed-value#fragment-value',
    logoUrl: '/api/t/a/branding/logo?v=7&sig=signed-value',
    description: 'See https://research.example.test/article?api_key=url-key&year=2026',
  }
  const output = JSON.stringify(redactExport(input))
  for (
    const secret of [
      'plain-api-value',
      'plain-token-value',
      'sealed-value',
      'private-value',
      'bearer-value',
      'password-value',
      'hashed-value',
      key,
      jwt,
      'url-token',
      'signed-value',
      'fragment-value',
      'url-key',
    ]
  ) expect(output).not.toContain(secret)
  expect(output).toContain('Fisheries research')
  expect(output).toContain('year=2026')
  expect(output).toContain('/api/t/a/branding/logo?v=7')
  expect(input.apiKey).toBe('plain-api-value')
})

Deno.test('portal bundle permission matrix isolates portals and denies MCP keys before dispatch', async () => {
  expect(declarationFor('GET', PORTAL_EXPORT_PATH)).toMatchObject({
    permission: 'audit.export',
    scope: 'portal',
  })
  for (
    const role of [
      'anonymous',
      'viewer',
      'analyst',
      'curator',
      'wrong-portal',
      'other-tenant',
      'portal-admin',
      'platform-admin',
      'owner',
    ] as const
  ) {
    const f = createEnforcementFixture()
    try {
      const session = role === 'anonymous'
        ? null
        : role === 'other-tenant'
        ? f.otherTenant
        : role === 'wrong-portal'
        ? f.sessionFor('portal-admin', 'b')
        : f.sessionFor(role)
      const response = await f.requestAs(session, path)
      const allowed = ['portal-admin', 'platform-admin', 'owner'].includes(role)
      expect(response.status, role).toBe(allowed ? 200 : role === 'anonymous' ? 401 : 403)
      if (allowed) {
        expect(response.headers.get('content-type')).toBe('application/zip')
        const files = readExportZip(new Uint8Array(await response.arrayBuffer()))
        expect(JSON.parse(files.get('manifest.json')!).portal).toBe('a')
      } else {
        await response.body?.cancel()
        f.assertNoProtectedDispatch()
      }
    } finally {
      f.close()
    }
  }
  const f = createEnforcementFixture()
  try {
    const created = await f.requestAs(f.creator, '/api/t/a/mcp/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Export fixture', role: 'portal-admin' }),
    })
    expect(created.status).toBe(201)
    const issued = await created.json()
    const response = await f.requestAs(null, path, {
      headers: { authorization: `Bearer ${issued.key}` },
    })
    expect(response.status).toBe(401)
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('bundle allowlists key metadata and resources and excludes feedback unless explicitly audited', async () => {
  class SecretProvider extends DoubleProvider {
    override async *exportResources(
      tenant: Parameters<DoubleProvider['exportResources']>[0],
      signal: AbortSignal,
    ): AsyncIterable<ExportResource> {
      for await (const row of super.exportResources(tenant, signal)) {
        yield {
          ...row,
          resource: { ...row.resource, serviceToken: 'summary-secret' } as typeof row.resource,
          metadata: {
            useful: 'Kept metadata',
            credentials: { value: 'metadata-secret' },
            note: `${key} ${jwt} enc:v1:sealed-value`,
            sourceUrl: 'https://research.example.test/source?token=url-token&year=2026',
          },
        }
      }
    }
  }
  const f = createEnforcementFixture({ provider: new SecretProvider() })
  try {
    await f.stores.bindings.initialize()
    await f.stores.bindings.set('a', {
      baseUrl: 'https://binding.example.test/kb/a',
      token: 'unlabelled-binding-secret-fixture',
      kbId: 'a',
    })
    f.stores.tenants.patch('a', { prompts: { ask: `Use the evidence. ${jwt}` } })
    f.stores.mcpKeys.add({
      v: 1,
      id: 'export-key',
      tenant: 'a',
      issuerUserId: 'fixture',
      label: 'Research client',
      prefix: 'key-prefix-value',
      hash: 'a'.repeat(64),
      role: 'analyst',
      createdAt: new Date(0).toISOString(),
      expiresAt: null,
      revokedAt: null,
      creator: { tenantId: 'tenant-1', oid: 'fixture' },
      provenance: 'verified-session',
    })
    const learningId = 'a'.repeat(32)
    const ts = new Date().toISOString()
    f.stores.feedback.record('a', {
      learningId,
      good: false,
      ts,
      text: '=Personal feedback fixture',
    })
    f.rbac.audit.append(
      createAuditEvent({
        requestId: 'other-portal',
        actor: { kind: 'system' },
        action: 'maintenance.run',
        scope: { kind: 'portal', slug: 'b' },
        target: { kind: 'portal', id: 'b' },
        outcome: 'success',
      }),
    )
    const admin = f.sessionFor('portal-admin')
    const response = await f.requestAs(admin, path)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const files = readExportZip(new Uint8Array(await response.arrayBuffer()))
    const text = [...files.values()].join('\n')
    for (
      const secret of [
        key,
        jwt,
        'summary-secret',
        'metadata-secret',
        'sealed-value',
        'url-token',
        'key-prefix-value',
        'a'.repeat(64),
        'Personal feedback fixture',
        'other-portal',
        'unlabelled-binding-secret-fixture',
      ]
    ) {
      expect(text).not.toContain(secret)
    }
    expect(files.has('feedback.csv')).toBe(false)
    expect(JSON.parse(files.get('mcp-keys.json')!)).toEqual([{
      id: 'export-key',
      label: 'Research client',
      role: 'analyst',
      createdAt: new Date(0).toISOString(),
      expiresAt: null,
      revokedAt: null,
      legacy: false,
    }])
    expect(JSON.parse(files.get('manifest.json')!)).toMatchObject({
      schemaVersion: 1,
      complete: true,
      includeFeedback: false,
      counts: {
        resources: 2,
        fileLinks: 1,
        keys: 1,
        feedback: 0,
        evaluationSets: 0,
        evaluationResults: 0,
      },
    })
    expect(JSON.parse(files.get('resources.json')!)[0]).toMatchObject({
      metadata: { useful: 'Kept metadata' },
      files: [{ fieldId: 'file', url: '/api/t/a/resources/res-1/file/file' }],
    })
    expect(JSON.parse(files.get('evaluations.json')!)).toMatchObject({
      status: 'unavailable',
      sets: [],
      results: [],
    })
    const included = await f.requestAs(admin, path + '?includeFeedback=true')
    expect(included.status).toBe(200)
    const withFeedback = readExportZip(new Uint8Array(await included.arrayBuffer()))
    expect(withFeedback.get('feedback.csv')).toContain('"\'=Personal feedback fixture"')
    expect(JSON.parse(withFeedback.get('manifest.json')!)).toMatchObject({
      includeFeedback: true,
      counts: { feedback: 1 },
    })
    const audits = f.rbac.audit.read({
      scope: { kind: 'portal', slug: 'a' },
      action: 'portal.export.bundle',
      limit: 100,
    })
    for (const flag of [false, true]) {
      for (const outcome of ['intent', 'success']) {
        expect(
          audits.some((row) =>
            row.outcome === outcome && JSON.parse(row.detail_json).includeFeedback === flag
          ),
        ).toBe(true)
      }
    }
  } finally {
    f.close()
  }
})

Deno.test('export validates options, rate limits and refuses partial oversized files', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('portal-admin')
    for (
      const query of [
        '?includeFeedback=1',
        '?includeFeedback=true&includeFeedback=false',
        '?portal=b',
        '?limit=1',
      ]
    ) {
      expect((await f.requestAs(admin, path + query)).status).toBe(400)
    }
    f.assertNoProtectedDispatch()
    for (let i = 0; i < 2; i++) {
      const res = await f.requestAs(admin, path)
      expect(res.status).toBe(200)
      await res.body?.cancel()
    }
    const limited = await f.requestAs(admin, path)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  } finally {
    f.close()
  }
  class LargeProvider extends DoubleProvider {
    override async *exportResources(
      tenant: Parameters<DoubleProvider['exportResources']>[0],
      signal: AbortSignal,
    ): AsyncIterable<ExportResource> {
      for await (const row of super.exportResources(tenant, signal)) {
        yield { ...row, metadata: { large: 'x'.repeat(PORTAL_EXPORT_MAX_BYTES) } }
      }
    }
  }
  const large = createEnforcementFixture({ provider: new LargeProvider() })
  try {
    const response = await large.requestAs(large.sessionFor('portal-admin'), path)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'portal_export_too_large' })
    expect(response.headers.has('content-disposition')).toBe(false)
  } finally {
    large.close()
  }
  const controller = new AbortController()
  const zip = new ExportZip(256, controller.signal)
  await expect(zip.add('file.txt', ['x'.repeat(256)])).rejects.toBeInstanceOf(ExportLimitError)
  controller.abort()
  await expect(zip.add('other.txt', ['hello'])).rejects.toBeDefined()
})

Deno.test('export observes read-only and suspended lifecycle and fails closed when audit fails', async () => {
  for (const status of ['read_only', 'suspended'] as const) {
    const f = createEnforcementFixture()
    try {
      f.stores.lifecycle.set('a', { status, limits: null })
      const response = await f.requestAs(f.sessionFor('portal-admin'), path)
      expect(response.status).toBe(status === 'read_only' ? 200 : 423)
      await response.body?.cancel()
      if (status === 'suspended') f.assertNoProtectedDispatch()
      const recovery = await f.requestAs(f.sessionFor('platform-admin'), path)
      expect(recovery.status).toBe(200)
      await recovery.body?.cancel()
    } finally {
      f.close()
    }
  }
  const f = createEnforcementFixture()
  try {
    f.failAudit()
    const response = await f.requestAs(f.sessionFor('portal-admin'), path)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'audit_write_failed' })
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('export prevents concurrent preparation and handles a bundle above the producer audit cap', async () => {
  const entered = Promise.withResolvers<void>()
  const secondEntered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  class HeldProvider extends DoubleProvider {
    override async *exportResources(
      tenant: Parameters<DoubleProvider['exportResources']>[0],
      signal: AbortSignal,
    ): AsyncIterable<ExportResource> {
      if (++calls === 1) entered.resolve()
      else secondEntered.resolve()
      await release.promise
      for await (const row of super.exportResources(tenant, signal)) {
        yield { ...row, metadata: { large: 'x'.repeat(600_000) } }
      }
    }
  }
  const f = createEnforcementFixture({ provider: new HeldProvider() })
  try {
    const admin = f.sessionFor('portal-admin')
    const pending = f.requestAs(admin, path)
    await entered.promise
    const concurrent = await f.requestAs(admin, path)
    expect(concurrent.status).toBe(409)
    expect(await concurrent.json()).toEqual({ error: 'export_in_progress' })
    expect(concurrent.headers.get('retry-after')).toBe('5')
    const second = f.requestAs(f.sessionFor('owner'), '/api/admin/t/b/export')
    await secondEntered.promise
    const capacity = await f.requestAs(f.sessionFor('owner'), '/api/admin/t/public-a/export')
    expect(capacity.status).toBe(429)
    expect(capacity.headers.get('retry-after')).toBe('5')
    release.resolve()
    const otherPortal = await second
    expect(otherPortal.status).toBe(200)
    await otherPortal.arrayBuffer()
    const response = await pending
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(1024 * 1024)
    expect(JSON.parse(readExportZip(bytes).get('manifest.json')!).complete).toBe(true)
  } finally {
    release.resolve()
    f.close()
  }
})

Deno.test('a failed bundle completion audit withholds every download byte and attachment header', async () => {
  for (const action of ['portal.export.bundle', 'request.privileged']) {
    const f = createEnforcementFixture()
    try {
      f.database.exec(`CREATE TRIGGER fixture_fail_export_completion BEFORE INSERT ON audit_events
        WHEN NEW.action = '${action}' AND NEW.outcome = 'success'
        BEGIN SELECT RAISE(ABORT, 'fixture completion failure'); END`)
      const response = await f.requestAs(f.sessionFor('portal-admin'), path)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'audit_write_failed' })
      expect(response.headers.has('content-disposition')).toBe(false)
      expect(f.providerCalls.some((call) => call.method === 'exportResources')).toBe(true)
    } finally {
      f.close()
    }
  }
})
