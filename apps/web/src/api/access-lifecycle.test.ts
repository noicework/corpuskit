import { expect } from '@std/expect'
import { AuthorityController, registerAuthorityController } from './access-lifecycle.ts'
import { sessionFixture } from './auth.test.ts'
import { sessionAccess } from './break-glass.ts'
import {
  analysePortal,
  compareExtraction,
  generateArtifact,
  getResourceContent,
  implementKg,
  listServerSessions,
  migrateKb,
  request,
  routeIntent,
  runEnrichment,
  saveGraphStrategy,
  setPortalDisabled,
  streamAsk,
  streamDocsAsk,
  streamEstateAsk,
  syncSource,
  uploadAdminFile,
  uploadBranding,
} from './client.ts'

function browserStorage() {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['rp-client-id', 'legacy-browser']])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    },
  })
  return () => {
    if (old) Object.defineProperty(globalThis, 'localStorage', old)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

Deno.test('every transport family rejects late reads, mutation responses and streams', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  let callbacks = 0
  const event = () => {
    callbacks++
  }
  const operations = [
    () => getResourceContent('marine', 'one'),
    () => listServerSessions('marine'),
    () => setPortalDisabled('marine', sessionAccess, true),
    () => uploadAdminFile('marine', sessionAccess, new File(['x'], 'a.txt')),
    () => uploadBranding('marine', sessionAccess, 'logo', new File(['x'], 'a.png')),
    () => generateArtifact('marine', 'briefing', 'question'),
    () => routeIntent('marine', 'question'),
    () => streamAsk('marine', { query: 'question' }, event),
    () => streamDocsAsk('marine', { query: 'question' }, event),
    () => streamEstateAsk('question', event),
    () => migrateKb('marine', 'other', sessionAccess, event),
    () => analysePortal('marine', sessionAccess, event),
    () =>
      implementKg(
        'marine',
        sessionAccess,
        { applyExisting: false, includeSummaries: false },
        event,
      ),
    () => syncSource('marine', sessionAccess, 'source', event),
    () =>
      saveGraphStrategy('marine', sessionAccess, {
        entityTypes: [],
        examples: [],
        applyExisting: false,
      }, event),
    () => runEnrichment('marine', sessionAccess, { scope: 'all' }, event),
    () => compareExtraction('marine', sessionAccess, { resourceId: 'one', methods: [] }, event),
  ]
  try {
    for (const operation of operations) {
      const authority = new AuthorityController()
      authority.setSession(sessionFixture(), 'marine')
      const unregister = registerAuthorityController(authority)
      let resolve!: (response: Response) => void
      let signal: AbortSignal | null | undefined
      globalThis.fetch = (_input, init) => {
        signal = init?.signal
        return new Promise((done) => {
          resolve = done
        })
      }
      const pending = operation()
      authority.invalidate('denied')
      expect(signal?.aborted).toBe(true)
      resolve(Response.json({ ok: true }))
      await expect(pending).rejects.toThrow()
      expect(callbacks).toBe(0)
      unregister()
    }
  } finally {
    globalThis.fetch = original
    restore()
  }
})

Deno.test('denial clears authority before notification with no retry or emergency header', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  try {
    for (const status of [401, 403]) {
      const authority = new AuthorityController()
      authority.setSession(sessionFixture(), 'marine')
      const unregister = registerAuthorityController(authority)
      let calls = 0
      let noticed = false
      authority.subscribe(() => {
        noticed = true
        expect(authority.session).toBe(null)
      })
      globalThis.fetch = (_input, init) => {
        calls++
        expect(new Headers(init?.headers).has('x-admin-passcode')).toBe(false)
        return Promise.resolve(new Response('{}', { status, headers: { 'retry-after': '30' } }))
      }
      await expect(listServerSessions('marine')).rejects.toMatchObject({
        status,
        retryAfterSec: 30,
      })
      expect(noticed).toBe(true)
      expect(calls).toBe(1)
      unregister()
    }
  } finally {
    globalThis.fetch = original
    restore()
  }
})

Deno.test('bytes received before JSON cancellation cannot publish a successful mutation', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const unregister = registerAuthorityController(authority)
  let completed = false
  globalThis.fetch = () => {
    const response = Response.json({ ok: true })
    response.json = () => {
      authority.invalidate('access lost during parse')
      return Promise.resolve({ ok: true })
    }
    return Promise.resolve(response)
  }
  try {
    await expect(
      setPortalDisabled('marine', sessionAccess, false).then(() => {
        completed = true
      }),
    ).rejects.toThrow()
    expect(completed).toBe(false)
  } finally {
    unregister()
    globalThis.fetch = original
  }
})

Deno.test('explicit cancellation after JSON bytes arrive and obsolete context fail before publication', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const context = authority.context
  const abort = new AbortController()
  let calls = 0
  globalThis.fetch = () => {
    calls++
    const response = Response.json({ private: true })
    response.json = () => {
      abort.abort()
      return Promise.resolve({ private: true })
    }
    return Promise.resolve(response)
  }
  try {
    await expect(
      request('/api/t/marine/resources', undefined, { authority, context, signal: abort.signal }),
    ).rejects.toThrow()
    authority.invalidate('changed')
    await expect(request('/api/t/marine/resources', undefined, { authority, context })).rejects
      .toThrow()
    expect(calls).toBe(1)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('explicit stream cancellation consumes its signal without cancelling unrelated authority', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const abort = new AbortController()
  let read!: () => void
  const reading = new Promise<void>((resolve) => {
    read = resolve
  })
  let cancelled = false
  globalThis.fetch = (_input, init) => {
    expect(init?.signal).toBeDefined()
    return Promise.resolve(
      new Response(
        new ReadableStream({
          pull() {
            read()
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
  }
  try {
    const stream = analysePortal('marine', sessionAccess, () => {}, {
      authority,
      context: authority.context,
      signal: abort.signal,
    })
    await reading
    abort.abort()
    await expect(stream).rejects.toThrow()
    expect(cancelled).toBe(true)
    expect(authority.status).toBe('ready')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('public ask streams incrementally with legacy client id and stops same-chunk stale callbacks', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  const authority = new AuthorityController(() => 'legacy-browser')
  authority.setSession(sessionFixture('marine', null), 'marine')
  const unregister = registerAuthorityController(authority)
  let writer!: ReadableStreamDefaultController<Uint8Array>
  let first!: () => void
  const receivedFirst = new Promise<void>((resolve) => {
    first = resolve
  })
  const received: string[] = []
  let completed = false
  globalThis.fetch = (_input, init) => {
    expect(new Headers(init?.headers).get('x-rp-client')).toBe('legacy-browser')
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            writer = controller
          },
        }),
      ),
    )
  }
  try {
    const stream = streamAsk('marine', { query: 'question' }, (event) => {
      received.push(event.type)
      first()
      if (received.length === 2) authority.invalidate('lost between frames')
    }).then(() => {
      completed = true
    })
    writer.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"first"}\n\n'))
    await receivedFirst
    expect(completed).toBe(false)
    writer.enqueue(
      new TextEncoder().encode(
        'data: {"type":"delta","text":"second"}\n\ndata: {"type":"done"}\n\n',
      ),
    )
    await expect(stream).rejects.toThrow()
    expect(received).toEqual(['delta', 'delta'])
    expect(localStorage.getItem('rp-client-id')).toBe('legacy-browser')
  } finally {
    unregister()
    globalThis.fetch = original
    restore()
  }
})

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
