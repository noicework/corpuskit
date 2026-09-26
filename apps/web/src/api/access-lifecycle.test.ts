import { expect } from '@std/expect'
import {
  AuthorityController,
  FILE_PICKER_BLUR_MS,
  FilePickerFocus,
  registerAuthorityController,
} from './access-lifecycle.ts'
import { sessionFixture } from './auth.test.ts'
import { sessionAccess } from './break-glass.ts'
import {
  addAdminText,
  analysePortal,
  compareExtraction,
  generateArtifact,
  getAdminCounters,
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

Deno.test('revalidation keeps an unchanged session, its generation and its in-flight requests', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const context = authority.context
  const upload = authority.beginRequest()
  let notified = 0
  let cleaned = 0
  authority.subscribe(() => notified++)
  authority.registerCleanup(() => cleaned++)
  let reads = 0
  let resolve!: (response: Response) => void
  globalThis.fetch = () => {
    reads++
    return new Promise((done) => {
      resolve = done
    })
  }
  try {
    // A file picker returns focus to the window just before its input's change event: the
    // upload is dispatched while the re-check is still pending, so authority must stay current.
    const first = authority.revalidate('marine')
    const second = authority.revalidate('marine')
    expect(authority.status).toBe('ready')
    expect(authority.can('portal.read', { kind: 'portal', slug: 'marine' })).toBe(true)
    expect(() => authority.assertCurrent(context)).not.toThrow()
    const dispatched = authority.beginRequest()
    resolve(Response.json({ ...sessionFixture(), claimAgeSeconds: 42 }))
    await Promise.all([first, second])
    expect(reads).toBe(1)
    expect(authority.context).toBe(context)
    for (const request of [upload, dispatched]) {
      expect(request.signal.aborted).toBe(false)
      expect(() => request.assertCurrent()).not.toThrow()
    }
    expect(notified).toBe(0)
    expect(cleaned).toBe(0)
    expect(authority.session?.claimAgeSeconds).toBe(42)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('revalidation withdraws changed identity or authority exactly as a new session does', async () => {
  const original = globalThis.fetch
  const revoked = {
    ...sessionFixture(),
    portalAccess: {
      slug: 'marine',
      permissions: [],
      effectiveRole: null,
      available: false,
      canEnable: false,
    },
  }
  try {
    for (const next of [sessionFixture('marine', 'two'), revoked]) {
      const authority = new AuthorityController()
      authority.setSession(sessionFixture(), 'marine')
      const context = authority.context
      const upload = authority.beginRequest()
      let cleaned = 0
      authority.registerCleanup(() => cleaned++)
      globalThis.fetch = () => Promise.resolve(Response.json(next))
      await authority.revalidate('marine')
      expect(authority.context.generation).toBeGreaterThan(context.generation)
      expect(upload.signal.aborted).toBe(true)
      expect(() => upload.assertCurrent()).toThrow()
      expect(cleaned).toBe(1)
      expect(authority.status).toBe('ready')
      expect(authority.session?.user?.id).toBe(next.user?.id)
      expect(authority.can('portal.read', { kind: 'portal', slug: 'marine' })).toBe(
        next !== revoked,
      )
    }
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('failed or superseded revalidation never keeps or restores obsolete authority', async () => {
  const original = globalThis.fetch
  try {
    // An unreadable session fails closed, as a refresh does.
    for (const response of [new Response('unavailable', { status: 503 }), Response.json({})]) {
      const authority = new AuthorityController()
      authority.setSession(sessionFixture(), 'marine')
      const upload = authority.beginRequest()
      globalThis.fetch = () => Promise.resolve(response)
      await expect(authority.revalidate('marine')).rejects.toThrow()
      expect(authority.status).toBe('unavailable')
      expect(authority.session).toBe(null)
      expect(upload.signal.aborted).toBe(true)
    }
    // A change made while the read is pending owns the state; the late read cannot undo it.
    const authority = new AuthorityController()
    authority.setSession(sessionFixture(), 'marine')
    let resolve!: (response: Response) => void
    let signal: AbortSignal | undefined
    globalThis.fetch = (_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise((done) => {
        resolve = done
      })
    }
    const late = authority.revalidate('marine')
    authority.setSession(sessionFixture('marine', 'two'), 'marine')
    expect(signal?.aborted).toBe(true)
    resolve(Response.json(sessionFixture()))
    await expect(late).rejects.toThrow()
    expect(authority.status).toBe('ready')
    expect(authority.session?.user?.id).toBe('two')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('revalidation without a ready session for the page scope is a full refresh', async () => {
  const original = globalThis.fetch
  let resolve!: (response: Response) => void
  globalThis.fetch = () =>
    new Promise((done) => {
      resolve = done
    })
  try {
    for (const setup of ['none', 'other-scope'] as const) {
      const authority = new AuthorityController()
      if (setup === 'other-scope') authority.setSession(sessionFixture('grains'), 'grains')
      const revalidation = authority.revalidate('marine')
      expect(authority.status).toBe('loading')
      expect(authority.can('portal.read', { kind: 'portal', slug: 'grains' })).toBe(false)
      resolve(Response.json(sessionFixture()))
      await revalidation
      expect(authority.context.slug).toBe('marine')
      expect(authority.can('portal.read', { kind: 'portal', slug: 'marine' })).toBe(true)
    }
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('a failed admin upload says what went wrong instead of a code or a bare failure', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  const cases: Array<[Response, string, string | undefined]> = [
    [
      new Response('<html>413 Request Entity Too Large</html>', { status: 413 }),
      'That file is too large to upload.',
      undefined,
    ],
    [Response.json({ error: 'file_too_large' }, { status: 413 }), 'too large', 'file_too_large'],
    [Response.json({ error: 'empty_file' }, { status: 400 }), 'That file is empty', 'empty_file'],
    [Response.json({ error: 'not_found' }, { status: 404 }), 'could not be found', 'not_found'],
    [new Response('<html>Bad gateway</html>', { status: 502 }), 'on our side', undefined],
    [Response.json({ error: 'new_code' }, { status: 409 }), 'failed (HTTP 409)', 'new_code'],
    [
      Response.json({ error: 'unsupported_type', message: 'PDF, Word or text only.' }, {
        status: 415,
      }),
      'PDF, Word or text only.',
      'unsupported_type',
    ],
  ]
  try {
    for (const [response, message, code] of cases) {
      const authority = new AuthorityController()
      authority.setSession(sessionFixture(), 'marine')
      const unregister = registerAuthorityController(authority)
      globalThis.fetch = () => Promise.resolve(response)
      try {
        const error = await uploadAdminFile('marine', sessionAccess, new File(['x'], 'a.pdf'))
          .then(() => null, (error: unknown) => error)
        expect(error).toMatchObject({ status: response.status, code })
        expect((error as Error).message).toContain(message)
        expect((error as Error).message).not.toMatch(/^[a-z_]+$|^Request failed$/)
        // A refused upload is not a loss of access: the page stays mounted to show the message.
        expect(authority.status).toBe('ready')
      } finally {
        unregister()
      }
    }
  } finally {
    globalThis.fetch = original
    restore()
  }
})

Deno.test('only the focus a file picker hands back skips withdrawal, and only once', () => {
  const focus = new FilePickerFocus()
  // Choosing a file: the input is activated, its picker blurs the window, focus comes back.
  focus.activated(1_000)
  focus.blurred(1_020)
  expect(focus.focused()).toBe('picker')
  // The next return is an ordinary one.
  focus.blurred(5_000)
  expect(focus.focused()).toBe('return')
  // A focus with no blur since activation (a picker that never took focus) is a return.
  focus.activated(6_000)
  expect(focus.focused()).toBe('return')
  // An activation long before an unrelated blur never excuses the later return.
  focus.activated(7_000)
  focus.blurred(7_000 + FILE_PICKER_BLUR_MS + 1)
  expect(focus.focused()).toBe('return')
  // Without any activation every focus is a return.
  focus.blurred(9_000)
  expect(focus.focused()).toBe('return')
})

/** A fetch double that answers the session read and holds each admin request until told. */
function routedFetch(session: () => Response | Promise<Response>) {
  const admin: { url: string; signal?: AbortSignal; resolve: (response: Response) => void }[] = []
  let authReads = 0
  let releaseAuth: (() => void) | undefined
  let authGate: Promise<void> | undefined
  const fetchDouble = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('/auth/me')) {
      authReads++
      return (authGate ?? Promise.resolve()).then(() => session())
    }
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      admin.push({ url, signal, resolve })
    })
  }
  return {
    fetch: fetchDouble as typeof fetch,
    admin,
    reads: () => authReads,
    gateAuth: () => {
      authGate = new Promise((resolve) => {
        releaseAuth = resolve
      })
    },
    releaseAuth: () => releaseAuth?.(),
  }
}

Deno.test('an add in flight is held through an access check and published to the same authority', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  const routed = routedFetch(() => Response.json(sessionFixture()))
  globalThis.fetch = routed.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const unregister = registerAuthorityController(authority)
  try {
    const upload = uploadAdminFile('marine', sessionAccess, new File(['x'], 'a.pdf'))
    let settled = false
    upload.then(() => settled = true, () => settled = true)
    while (routed.admin.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    // An observed return: reads and the page are withdrawn, the write is not cut off.
    routed.gateAuth()
    const check = authority.refresh('marine')
    expect(authority.status).toBe('loading')
    expect(routed.admin[0]!.signal?.aborted).toBe(false)
    // Its answer arrives mid-check and waits: nothing publishes while access is unknown.
    routed.admin[0]!.resolve(Response.json({ id: 'res-1' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    routed.releaseAuth()
    await check
    expect(await upload).toEqual({ id: 'res-1' })
  } finally {
    unregister()
    globalThis.fetch = original
    restore()
  }
})

Deno.test('a held add is dropped when the check finds another person, other authority or no answer', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  const narrower = {
    ...sessionFixture(),
    portalAccess: { ...sessionFixture().portalAccess, permissions: ['portal.read'] },
  }
  const outcomes: [string, () => Response][] = [
    ['identity', () => Response.json(sessionFixture('marine', 'two'))],
    ['authority', () => Response.json(narrower)],
    ['failure', () => new Response('unavailable', { status: 503 })],
  ]
  try {
    for (const [name, answer] of outcomes) {
      const routed = routedFetch(answer)
      globalThis.fetch = routed.fetch
      const authority = new AuthorityController()
      authority.setSession(sessionFixture(), 'marine')
      const unregister = registerAuthorityController(authority)
      try {
        const add = addAdminText('marine', sessionAccess, { title: 't', body: 'b' })
        while (routed.admin.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        routed.gateAuth()
        const check = authority.refresh('marine').catch(() => {})
        expect(routed.admin[0]!.signal?.aborted, name).toBe(false)
        routed.releaseAuth()
        await check
        // Anything but the same authority ends the write's answer: it never publishes.
        expect(routed.admin[0]!.signal?.aborted, name).toBe(true)
        await expect(add).rejects.toThrow()
      } finally {
        unregister()
      }
    }
  } finally {
    globalThis.fetch = original
    restore()
  }
})

Deno.test('reads, streams and adds not marked to be held still end the moment access is withdrawn', async () => {
  const original = globalThis.fetch
  const restore = browserStorage()
  const routed = routedFetch(() => Response.json(sessionFixture()))
  globalThis.fetch = routed.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const unregister = registerAuthorityController(authority)
  try {
    const read = getAdminCounters('marine', sessionAccess)
    const toggle = setPortalDisabled('marine', sessionAccess, true)
    const held = uploadAdminFile('marine', sessionAccess, new File(['x'], 'a.pdf'))
    while (routed.admin.length < 3) await new Promise((resolve) => setTimeout(resolve, 0))
    routed.gateAuth()
    const check = authority.refresh('marine')
    expect(routed.admin.map((request) => request.signal?.aborted)).toEqual([true, true, false])
    await expect(read).rejects.toThrow()
    await expect(toggle).rejects.toThrow()
    // A denial, unlike a check, ends a held add too.
    authority.invalidate('denied')
    expect(routed.admin[2]!.signal?.aborted).toBe(true)
    await expect(held).rejects.toThrow()
    routed.releaseAuth()
    await check.catch(() => {})
  } finally {
    unregister()
    globalThis.fetch = original
    restore()
  }
})
