import { expect } from '@std/expect'
import {
  addAdminLink,
  addAdminText,
  ApiError,
  askError,
  implementKg,
  RATE_LIMIT_MESSAGE,
  request,
  runEnrichment,
  streamDocsAsk,
  streamEstateAsk,
  syncSource,
  uploadAdminFile,
} from './client.ts'
import { AdminAccessError, authorityFetch, sessionAccess } from './break-glass.ts'
import { AuthorityController, registerAuthorityController } from './access-lifecycle.ts'
import { sessionFixture } from './auth.test.ts'
import { hostingErrorMessage } from './hosting-errors.ts'

const resourceLimit = { error: 'limit_exceeded', limit: 'maxResources', value: 3, max: 2 }
const byteLimit = { error: 'limit_exceeded', limit: 'maxBytes', value: 2048, max: 1024 }

Deno.test('all add content transports translate resource and byte limits without exposing raw codes', async () => {
  const original = globalThis.fetch
  let response = resourceLimit
  globalThis.fetch = () => Promise.resolve(Response.json(response, { status: 413 }))
  try {
    for (const body of [resourceLimit, byteLimit]) {
      response = body
      for (
        const action of [
          () => uploadAdminFile('marine', sessionAccess, new File(['test'], 'test.txt')),
          () => addAdminLink('marine', sessionAccess, { url: 'https://example.test/report' }),
          () => addAdminText('marine', sessionAccess, { title: 'Report', body: 'test' }),
        ]
      ) {
        await expect(action()).rejects.toMatchObject({
          status: 413,
          message: hostingErrorMessage(body),
        })
      }
    }
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('an add held back by links still being processed says to wait, not that the portal is full', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () =>
    Promise.resolve(Response.json({ error: 'links_pending' }, { status: 503 }))
  try {
    for (
      const action of [
        () => uploadAdminFile('marine', sessionAccess, new File(['test'], 'test.txt')),
        () => addAdminLink('marine', sessionAccess, { url: 'https://example.test/report' }),
        () => addAdminText('marine', sessionAccess, { title: 'Report', body: 'test' }),
      ]
    ) {
      await expect(action()).rejects.toMatchObject({
        status: 503,
        message:
          'Links added earlier are still being processed, so this cannot be added yet. Try again in a minute or two.',
      })
    }
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('daily ask quotas carry a distinct code and reset time while burst limits keep their retry copy', async () => {
  const error = await askError(
    Response.json({
      error: 'ask_quota_exceeded',
      limit: 100,
      resetsAt: '2026-09-26T14:00:00.000Z',
    }, { status: 429, headers: { 'retry-after': '600' } }),
    'Unavailable',
  )
  expect(error).toBeInstanceOf(ApiError)
  expect(error.code).toBe('ask_quota_exceeded')
  expect(error.message).toContain('daily question limit')
  expect(error.message).toContain('Try again after')
  expect(error.message).toContain('2026')
  expect(error.retryAfterSec).toBe(600)
  const burst = await askError(new Response(null, { status: 429 }), 'Unavailable')
  expect(burst.message).toBe(RATE_LIMIT_MESSAGE)
  expect(burst.code).toBeUndefined()
  expect(hostingErrorMessage({ error: 'ask_quota_exceeded', resetsAt: 'invalid' }))
    .toContain('after the daily limit resets')
})

Deno.test('read-only and suspended API errors retain their code and useful messages', async () => {
  const original = globalThis.fetch
  try {
    for (const code of ['portal_read_only', 'portal_suspended']) {
      globalThis.fetch = () => Promise.resolve(Response.json({ error: code }, { status: 423 }))
      await expect(request('/api/t/marine/config')).rejects.toMatchObject({
        code,
        status: 423,
        message: hostingErrorMessage({ error: code }),
      })
    }
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('help and estate ask streams retain the daily quota explanation without publishing events', async () => {
  const original = globalThis.fetch
  let events = 0
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      error: 'ask_quota_exceeded',
      limit: 0,
      resetsAt: '2026-09-26T14:00:00.000Z',
    }, { status: 429 }))
  try {
    for (
      const action of [
        () => streamDocsAsk('marine', { query: 'Help' }, () => events++),
        () => streamEstateAsk('Research', () => events++),
      ]
    ) {
      await expect(action()).rejects.toMatchObject({ code: 'ask_quota_exceeded', status: 429 })
    }
    expect(events).toBe(0)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('disabled agents preserve identity and explain both graph and enrichment start failures', async () => {
  const original = globalThis.fetch
  const authority = new AuthorityController()
  authority.setSession(sessionFixture(), 'marine')
  const unregister = registerAuthorityController(authority)
  globalThis.fetch = () =>
    Promise.resolve(Response.json({ error: 'agents_disabled' }, { status: 403 }))
  try {
    for (
      const action of [
        () => runEnrichment('marine', sessionAccess, { scope: 'missing' }, () => {}),
        () =>
          implementKg('marine', sessionAccess, {
            applyExisting: false,
            includeSummaries: false,
          }, () => {}),
      ]
    ) {
      await expect(action()).rejects.toMatchObject({
        status: 403,
        message: hostingErrorMessage({ error: 'agents_disabled' }),
      })
      expect(authority.status).toBe('ready')
    }
  } finally {
    unregister()
    globalThis.fetch = original
  }
})

Deno.test('ordinary, malformed and mismatched denials still retire authority', async () => {
  for (
    const [status, body] of [
      [401, { error: 'agents_disabled' }],
      [403, { error: 'forbidden', message: 'agents_disabled' }],
      [403, { error: ['agents_disabled'] }],
      [403, null],
    ] as const
  ) {
    const authority = new AuthorityController()
    authority.setSession(sessionFixture(), 'marine')
    await expect(
      authorityFetch(
        '/api/admin/t/marine/kg/implement',
        undefined,
        { authority },
        () => Promise.resolve(Response.json(body, { status })),
      ),
    ).rejects.toBeInstanceOf(AdminAccessError)
    expect(authority.status).toBe('unavailable')
  }
})

Deno.test('an unmeasurable storage limit explains why content cannot be added', () => {
  const message = hostingErrorMessage({ error: 'usage_unavailable' })
  expect(message).toContain('cannot be checked')
  expect(message).not.toContain('usage_unavailable')
})

Deno.test('a source sync refused or stopped by hosting state explains it in the app words', async () => {
  const original = globalThis.fetch
  try {
    // Refused before it starts: the read-only copy, with its code.
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: 'portal_read_only' }, { status: 423 }))
    await expect(syncSource('marine', sessionAccess, 'source-1', () => {})).rejects.toMatchObject({
      status: 423,
      code: 'portal_read_only',
      message: hostingErrorMessage({ error: 'portal_read_only' }),
    })
    // Stopped part way by a limit: the streamed error event carries the limit copy.
    const frames = [
      { type: 'item', label: 'Found 3 pages' },
      {
        type: 'error',
        message: 'This portal has reached its resource limit, so no more content can be added.',
        ...resourceLimit,
      },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      )
    const events: unknown[] = []
    await syncSource('marine', sessionAccess, 'source-1', (event) => void events.push(event))
    expect(events[0]).toEqual({ type: 'item', label: 'Found 3 pages' })
    expect(events[1]).toMatchObject({
      type: 'error',
      error: 'limit_exceeded',
      message: hostingErrorMessage(resourceLimit),
    })
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('a request that goes stale while its denial is read releases the response body', async () => {
  const controller = new AbortController()
  let response!: Response
  const failure = await authorityFetch(
    '/api/admin/t/marine/kg/implement',
    undefined,
    { signal: controller.signal },
    () => {
      const body = JSON.stringify({ error: 'agents_disabled' })
      response = new Response(
        new ReadableStream({
          pull(stream) {
            // The request is superseded while its 403 body is being read.
            controller.abort()
            stream.enqueue(new TextEncoder().encode(body))
            stream.close()
          },
        }, { highWaterMark: 0 }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
      return Promise.resolve(response)
    },
  ).then(() => undefined, (error) => error)
  expect(failure).toBeDefined()
  expect(failure).not.toBeInstanceOf(AdminAccessError)
  // The caller never received the response; its body was cancelled, not left open.
  expect(response.bodyUsed).toBe(true)
})
