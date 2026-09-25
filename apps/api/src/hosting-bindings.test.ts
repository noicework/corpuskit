import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { BindingCipher, BindingCryptoError } from './binding-crypto.ts'

const token = 'fixture-only-knowledge-box-secret'
const connect = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://zone.rag.progress.cloud/api/v1/kb/research', token }),
}

Deno.test('Cloudflare missing binding key reports readiness and refuses writes before upstream calls', async () => {
  const f = createEnforcementFixture({ bindingKey: '' })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => {
    calls++
    throw new Error('Unexpected upstream call')
  }
  try {
    const expected = {
      configured: false,
      required: true,
      writable: false,
      error: 'binding_key_missing',
      unavailable: 0,
    }
    // Anonymous health carries one coarse flag; the cause is for authorised administrators.
    const health = await f.requestAs(null, '/api/health')
    const healthBody = await health.json()
    expect(healthBody.bindingsReady).toBe(false)
    expect(healthBody.bindingEncryption).toBeUndefined()
    expect(JSON.stringify(healthBody)).not.toContain('binding_key')
    const overview = await f.requestAs(f.sessionFor('platform-admin'), '/api/admin/overview')
    expect(overview.status).toBe(200)
    const rows = await overview.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.every((row: { bindingEncryption: unknown }) =>
        JSON.stringify(row.bindingEncryption) === JSON.stringify(expected)
      ),
    ).toBe(true)
    for (const suffix of ['', '/create']) {
      const response = await f.requestAs(
        f.sessionFor('portal-admin'),
        `/api/admin/t/a/knowledge-box${suffix}`,
        connect,
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'binding_key_missing' })
    }
    // Authentication and scope checks still precede storage configuration errors.
    const denied = await f.requestAs(null, '/api/admin/t/a/knowledge-box', connect)
    expect(denied.status).toBe(401)
    expect(await denied.text()).not.toContain('binding_key_missing')
    expect(calls).toBe(0)
    expect(JSON.stringify(f.rbac.audit.read({ scope: { kind: 'platform' } }))).not.toContain(token)
  } finally {
    globalThis.fetch = originalFetch
    f.close()
  }
})

Deno.test('binding API persists sealed tokens and keeps credentials out of responses and audit', async () => {
  const f = createEnforcementFixture()
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(Response.json({ resources: 7 }))
  try {
    const response = await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/knowledge-box',
      connect,
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body).resourceCount).toBe(7)
    expect(body).not.toContain(token)
    const stored = f.state.get<Record<string, { token: string }>>('bindings', {})
    expect(stored.a?.token).toMatch(/^enc:v1:/)
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(f.stores.bindings.get('a')?.token).toBe(token)
    for (const path of ['/api/admin/overview', '/api/t/a/knowledge-box', '/api/health']) {
      const result = await f.requestAs(f.sessionFor('owner'), path)
      expect(await result.text()).not.toContain(token)
    }
    const audit = f.rbac.audit.read({ scope: { kind: 'platform' } })
    expect(audit.some((event) => event.action === 'local.mutation')).toBe(true)
    expect(JSON.stringify(audit)).not.toContain(token)
  } finally {
    globalThis.fetch = originalFetch
    f.close()
  }
})

Deno.test('binding verification and storage failures return safe errors without logging secrets', async () => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const logs: unknown[] = []
  console.error = (...values) => logs.push(values)
  try {
    for (const failure of ['upstream', 'storage']) {
      const f = createEnforcementFixture()
      try {
        globalThis.fetch = () =>
          Promise.resolve(
            failure === 'upstream'
              ? new Response(token, { status: 500 })
              : Response.json({ resources: 0 }),
          )
        if (failure === 'storage') {
          f.stores.bindings.set = () => {
            throw new BindingCryptoError('binding_encryption_failed')
          }
        }
        const response = await f.requestAs(
          f.sessionFor('portal-admin'),
          '/api/admin/t/a/knowledge-box',
          connect,
        )
        expect(response.status).toBe(failure === 'upstream' ? 400 : 503)
        const body = await response.text()
        expect(JSON.parse(body).error).toBe(
          failure === 'upstream' ? 'verification_failed' : 'binding_encryption_failed',
        )
        expect(body).not.toContain(token)
        expect(JSON.stringify(f.rbac.audit.read({ scope: { kind: 'platform' } }))).not.toContain(
          token,
        )
      } finally {
        f.close()
      }
    }
    expect(JSON.stringify(logs)).not.toContain(token)
  } finally {
    console.error = originalError
    globalThis.fetch = originalFetch
  }
})

Deno.test('knowledge box provisioning errors never echo upstream credential details', async () => {
  const f = createEnforcementFixture()
  const originalFetch = globalThis.fetch
  const saved = ['ARAG_ACCOUNT', 'ARAG_NUA_KEY'].map((key) => [key, Deno.env.get(key)] as const)
  Deno.env.set('ARAG_ACCOUNT', 'fixture-account')
  Deno.env.set('ARAG_NUA_KEY', 'fixture-key')
  globalThis.fetch = () => Promise.resolve(new Response(token, { status: 500 }))
  try {
    const response = await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/knowledge-box/create',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'creation_failed',
      message: 'Knowledge box creation failed.',
    })
    expect(JSON.stringify(f.rbac.audit.read({ scope: { kind: 'platform' } }))).not.toContain(token)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
    globalThis.fetch = originalFetch
    f.close()
  }
})

Deno.test('a binding sealed under another key is withheld per portal and recoverable through the API', async () => {
  const originalFetch = globalThis.fetch
  const warn = console.warn
  console.warn = () => {}
  const sealed = await new BindingCipher(btoa('o'.repeat(32))).seal('a', token)
  const f = createEnforcementFixture({
    storedBindings: {
      a: { baseUrl: 'https://zone.rag.progress.cloud/api/v1/kb/research', token: sealed },
    },
  })
  try {
    const admin = f.sessionFor('platform-admin')
    const status = await f.requestAs(admin, '/api/t/a/knowledge-box')
    expect(await status.json()).toEqual({ slug: 'a', status: 'unavailable', kbId: 'research' })
    const health = await f.requestAs(null, '/api/health')
    expect(health.status).toBe(200)
    expect((await health.json()).bindingsReady).toBe(false)
    const overview = await (await f.requestAs(admin, '/api/admin/overview')).json()
    const row = overview.find((entry: { tenant: { slug: string } }) => entry.tenant.slug === 'a')
    expect(row.knowledgeBox.status).toBe('unavailable')
    expect(row.bindingEncryption).toEqual({
      configured: true,
      required: true,
      writable: true,
      unavailable: 1,
    })
    // Another portal on the same deployment is unaffected.
    const other = await f.requestAs(admin, '/api/t/b/knowledge-box')
    expect(other.status).toBe(200)
    expect((await other.json()).status).toBe('none')
    expect(f.state.get<Record<string, { token: string }>>('bindings', {}).a?.token).toBe(sealed)
    // Hosting state stays readable; usage needs the box, so it names the withheld binding.
    const lifecycle = await f.requestAs(admin, '/api/admin/t/a/lifecycle')
    expect(lifecycle.status).toBe(200)
    expect((await lifecycle.json()).status).toBe('active')
    const usage = await f.requestAs(admin, '/api/admin/t/a/usage')
    expect(usage.status).toBe(503)
    expect(await usage.json()).toEqual({ error: 'binding_unavailable' })
    f.stores.lifecycle.reserveAdd('a', { observed: 0, bytes: 1 })
    expect(f.stores.lifecycle.hasCapacityLedger('a')).toBe(true)

    globalThis.fetch = () => Promise.resolve(Response.json({ resources: 3 }))
    const replaced = await f.requestAs(admin, '/api/admin/t/a/knowledge-box', connect)
    expect(replaced.status).toBe(200)
    expect((await replaced.json()).status.status).toBe('connected')
    expect(f.stores.bindings.get('a')?.token).toBe(token)
    // The withheld record named no box, so its replacement starts a fresh capacity ledger.
    expect(f.stores.lifecycle.hasCapacityLedger('a')).toBe(false)
    const removed = await f.requestAs(admin, '/api/admin/t/a/knowledge-box', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await removed.json()).status.status).toBe('none')
    expect((await (await f.requestAs(null, '/api/health')).json()).bindingsReady).toBe(true)
    expect(JSON.stringify(f.rbac.audit.read({ scope: { kind: 'platform' } }))).not.toContain(token)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = warn
    f.close()
  }
})
