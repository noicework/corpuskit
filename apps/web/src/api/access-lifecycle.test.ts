import { expect } from '@std/expect'
import { AuthorityController } from './access-lifecycle.ts'
import { sessionFixture } from './auth.test.ts'

Deno.test('loading and invalidated authority deny synchronously and abort old work', () => {
  const authority = new AuthorityController()
  expect(authority.can('portal.read', { kind: 'portal', slug: 'marine' })).toBe(false)
  authority.setSession(sessionFixture(), 'marine')
  const request = authority.beginRequest()
  let cleared = false
  authority.registerCleanup(() => {
    cleared = true
  })
  authority.subscribe(() => {
    expect(authority.can('portal.read', { kind: 'portal', slug: 'marine' })).toBe(false)
  })
  authority.invalidate('denied')
  expect(cleared).toBe(true)
  expect(request.signal.aborted).toBe(true)
  expect(() => request.assertCurrent()).toThrow()
})

Deno.test('same slug with changed identity or generation cannot revive old requests', () => {
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const old = authority.beginRequest()
  authority.setSession(sessionFixture('marine', 'two'), 'marine')
  expect(() => authority.assertCurrent(old.context)).toThrow()
  const next = authority.beginRequest()
  authority.setSession(sessionFixture('marine', 'two'), 'marine')
  expect(() => next.assertCurrent()).toThrow()
  expect(authority.can('portal.read', { kind: 'portal', slug: 'other' })).toBe(false)
  expect(authority.can('portal.create', { kind: 'platform' })).toBe(false)
})

Deno.test('anonymous identity is assigned only after successful public access and snapshots are immutable', () => {
  let browserReads = 0
  const authority = new AuthorityController(() => {
    browserReads++
    return 'legacy-browser'
  })
  authority.setSession({ ...sessionFixture('marine', null), portalAccess: null })
  expect(authority.context.identityKey).toBe(null)
  expect(browserReads).toBe(0)
  authority.setSession(sessionFixture('marine', null), 'marine')
  expect(authority.context.identityKey).toBe(JSON.stringify(['anonymous', 'legacy-browser']))
  expect(browserReads).toBe(1)
  expect(() => authority.session!.portalAccess!.permissions.push('members.manage')).toThrow()
})

Deno.test('failed refresh clears authority and a late refresh cannot restore an obsolete identity', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  let resolve!: (response: Response) => void
  globalThis.fetch = () =>
    new Promise((done) => {
      resolve = done
    })
  try {
    const refresh = authority.refresh('marine')
    expect(authority.status).toBe('loading')
    expect(authority.can('portal.read', { kind: 'portal', slug: 'marine' })).toBe(false)
    authority.setSession(sessionFixture('marine', 'two'), 'marine')
    resolve(Response.json(sessionFixture()))
    await expect(refresh).rejects.toThrow()
    expect(authority.session?.user?.id).toBe('two')
    globalThis.fetch = () => Promise.reject(new Error('offline'))
    await expect(authority.refresh('marine')).rejects.toThrow()
    expect(authority.status).toBe('unavailable')
    expect(authority.session).toBe(null)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('scope entries are independent, never replace page scope and die with parent identity', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const signals: AbortSignal[] = []
  const pending: Array<(response: Response) => void> = []
  globalThis.fetch = (_input, init) => {
    signals.push(init!.signal!)
    return new Promise((resolve) => pending.push(resolve))
  }
  try {
    const a = authority.readScopeSnapshot('alpha')
    const b = authority.readScopeSnapshot('beta')
    authority.cancelScopeSnapshot('alpha')
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    pending[0]!(Response.json(sessionFixture('alpha')))
    pending[1]!(Response.json(sessionFixture('beta')))
    await expect(a).rejects.toThrow()
    expect((await b).portalAccess?.slug).toBe('beta')
    expect(authority.context.slug).toBe('marine')
    const c = authority.readScopeSnapshot('gamma')
    pending[2]!(Response.json(sessionFixture('gamma', 'two')))
    await expect(c).rejects.toThrow()
    expect(authority.status).toBe('unavailable')
  } finally {
    globalThis.fetch = original
  }
})
