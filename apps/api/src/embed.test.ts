import { expect } from '@std/expect'
import { EmbeddingOriginSchema, EmbeddingSettingsSchema } from '@research-portal/core'
import { embedFramePolicy, embedPath, embedPolicyForResponse } from './embed.ts'
import { withSecurityHeaders } from './edge.ts'
import { infrastructureHandler } from './permissions.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const embedding = {
  enabled: true,
  allowedOrigins: ['https://research.example'],
  defaultView: 'own' as const,
}

Deno.test('embedding accepts exact HTTPS origins, canonicalises and bounds the list', () => {
  expect(EmbeddingOriginSchema.parse(' https://RESEARCH.example:443/ ')).toBe(
    'https://research.example',
  )
  expect(EmbeddingOriginSchema.parse('https://research.example:8443')).toBe(
    'https://research.example:8443',
  )
  for (
    const value of [
      'http://research.example',
      'https://*.example',
      '*',
      'null',
      'data:text/plain,a',
      'https://a.example/path',
      'https://a.example?x=1',
      'https://a.example#x',
      'https://a:b@a.example',
      'https://a.example; frame-ancestors *',
      'https://a.example\nhttps://b.example',
      'https://a.example//',
      'https://a.example/../',
    ]
  ) {
    expect(EmbeddingOriginSchema.safeParse(value).success, value).toBe(false)
  }
  expect(
    EmbeddingSettingsSchema.parse({
      ...embedding,
      allowedOrigins: ['https://research.example', 'https://RESEARCH.example/'],
    }).allowedOrigins,
  ).toEqual(embedding.allowedOrigins)
  expect(
    EmbeddingSettingsSchema.safeParse({
      ...embedding,
      allowedOrigins: Array(21).fill('https://a.example'),
    }).success,
  ).toBe(false)
  expect(EmbeddingSettingsSchema.safeParse({ ...embedding, defaultView: '*' }).success).toBe(false)
})

Deno.test('only the successful exact embed shell gains its configured frame ancestors', () => {
  const tenants = { get: () => ({ embedding }), isDisabled: () => false }
  for (
    const path of [
      '/t/a',
      '/t/a/ask',
      '/t/a/embed.js',
      '/t/a/embed/',
      '/t/a/embed/more',
      '/api/t/a/config',
    ]
  ) {
    expect(
      embedPolicyForResponse(
        new Request(`https://portal.example${path}`),
        new Response(''),
        tenants as never,
      ),
    ).toBe("frame-ancestors 'none'")
  }
  expect(embedPath('/t/a/embed')).toEqual({ slug: 'a', script: false })
  expect(embedFramePolicy(undefined)).toBe("frame-ancestors 'none'")
  expect(embedFramePolicy({ embedding: { ...embedding, allowedOrigins: [] } })).toBe(
    "frame-ancestors 'none'",
  )
  const url = new Request('https://portal.example/t/a/embed')
  expect(embedPolicyForResponse(url, new Response(''), tenants as never)).toBe(
    'frame-ancestors https://research.example',
  )
  expect(embedPolicyForResponse(url, new Response('', { status: 404 }), tenants as never)).toBe(
    "frame-ancestors 'none'",
  )
  const response = () =>
    new Response('', { headers: { 'content-security-policy': embedFramePolicy({ embedding }) } })
  expect(withSecurityHeaders(response(), '/t/a/embed').headers.has('x-frame-options')).toBe(false)
  expect(withSecurityHeaders(response(), '/t/a/ask').headers.get('x-frame-options')).toBe('DENY')
  expect(withSecurityHeaders(new Response(''), '/t/a/embed').headers.get('x-frame-options')).toBe(
    'DENY',
  )
})

for (const adapter of ['local', 'durable'] as const) {
  Deno.test(`${adapter}: embed settings use behaviour permission, audit, lifecycle and erasure`, async () => {
    const f = createEnforcementFixture({}, adapter)
    f.app.get('*', infrastructureHandler(async (c) => c.html('<div id="root"></div>')))
    const patch = (value: unknown) => ({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embedding: value }),
    })
    try {
      for (const role of ['viewer', 'analyst', 'curator'] as const) {
        expect(
          (await f.requestAs(f.sessionFor(role), '/api/admin/tenants/a', patch(embedding))).status,
        ).toBe(403)
        expect(f.stores.tenants.get('a')?.embedding).toBeUndefined()
      }
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin', 'b'),
          '/api/admin/tenants/a',
          patch(embedding),
        )).status,
      ).toBe(403)
      expect(
        (await f.requestAs(f.sessionFor('portal-admin'), '/api/admin/tenants/a', patch(embedding)))
          .status,
      ).toBe(200)
      expect(f.stores.tenants.get('a')?.embedding).toEqual(embedding)
      const audit = f.database.all<{ action: string; scope_slug: string; detail_json: string }>(
        "SELECT action, scope_slug, detail_json FROM audit_events WHERE action = 'tenant.behaviour.update'",
      )
      expect(
        audit.some((event) => event.scope_slug === 'a' && event.detail_json.includes('embedding')),
      ).toBe(true)
      const page = await f.requestAs(null, '/t/a/embed')
      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toBe(
        'frame-ancestors https://research.example',
      )
      expect(page.headers.get('cache-control')).toBe('private, no-store')
      expect(await page.text()).toContain('root')
      const script = await f.requestAs(null, '/t/a/embed.js')
      expect(script.headers.get('content-type')).toContain('text/javascript')
      expect(script.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(await script.text()).toContain('showModal')
      // The private shell is public branding only. Asking remains protected in either mode.
      for (const endpoint of ['ask', 'ask-agent']) {
        expect(
          (await f.requestAs(null, `/api/t/a/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'Research?' }),
          })).status,
        ).toBe(401)
      }
      f.stores.lifecycle.set('a', { status: 'read_only', limits: null })
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin'),
          '/api/admin/tenants/a',
          patch({ ...embedding, enabled: false }),
        )).status,
      ).toBe(423)
      f.stores.lifecycle.set('a', { status: 'active', limits: null })
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin'),
          '/api/admin/tenants/a',
          patch({ ...embedding, allowedOrigins: ['http://a.example'] }),
        )).status,
      ).toBe(400)
      f.stores.tenants.patch('a', { embedding: { ...embedding, enabled: false } })
      const disabled = await f.requestAs(null, '/t/a/embed')
      expect(disabled.status).toBe(404)
      expect(disabled.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(f.stores.tenants.remove('a')).toBe(true)
      f.stores.tenants.erase('a')
      expect(f.stores.tenants.get('a')).toBeUndefined()
      f.assertNoProtectedDispatch()
    } finally {
      f.close()
    }
  })
}

Deno.test('local tenant adapter persists embed settings and removes them with configuration', async () => {
  const { TenantStore } = await import('./tenants.ts')
  const directory = Deno.makeTempDirSync({ prefix: 'embed-local-store-' })
  const env = { TENANTS_PATH: `${directory}/tenants.json`, DATA_DIR: directory }
  try {
    const first = new TenantStore(env)
    const portal = first.add({ name: 'Soil research hub' })
    first.patch(portal.slug, { embedding })
    expect(new TenantStore(env).get(portal.slug)?.embedding).toEqual(embedding)
    expect(() =>
      first.patch(portal.slug, {
        embedding: { ...embedding, allowedOrigins: ['http://invalid.example'] },
      })
    ).toThrow()
    expect(first.remove(portal.slug)).toBe(true)
    first.erase(portal.slug)
    expect(new TenantStore(env).get(portal.slug)).toBeUndefined()
    expect(Deno.readTextFileSync(env.TENANTS_PATH)).not.toContain('allowedOrigins')
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})
