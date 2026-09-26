import { expect } from '@std/expect'
import { AragApiError, AragProvider } from '@research-portal/retrieval'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The platform's answer to hiding anything on a box whose hidden resources are off. */
const hiddenOff = (path: string) =>
  new AragApiError(
    422,
    path,
    JSON.stringify({
      detail: 'Cannot hide a resource: the KB does not have hidden resources enabled',
    }),
  )

/**
 * A knowledge box whose hidden resources are on, off, or on with hiding failing, and whose
 * removals may fail. Like the platform, a box with hidden resources off refuses to create a
 * hidden resource and creates nothing, and refuses to hide one later.
 */
function box(hide: 'ok' | 'off' | 'fail', remove: 'ok' | 'fail' = 'ok') {
  const calls: string[] = []
  const kb = { hiddenResources: hide !== 'off' }
  const create = (kind: string) => (_config: unknown, input: { hidden?: boolean }) => {
    calls.push(`${kind}:${input.hidden ? 'hidden' : 'public'}`)
    if (input.hidden && !kb.hiddenResources) return Promise.reject(hiddenOff('/resources'))
    return Promise.resolve({ id: 'draft-1' })
  }
  const management = new AragProvider({ resolveBinding: () => undefined })
  Object.assign(management, {
    resourceCount: () => Promise.resolve(0),
    createLink: create('create'),
    createText: create('text'),
    setResourceHidden: (_config: unknown, id: string, hidden: boolean) => {
      calls.push(`hide:${id}:${hidden}`)
      if (!kb.hiddenResources) return Promise.reject(hiddenOff(`/resource/${id}`))
      if (hide === 'fail') return Promise.reject(new Error('upstream unavailable'))
      return Promise.resolve()
    },
    deleteResource: (_config: unknown, id: string) => {
      calls.push(`delete:${id}`)
      return remove === 'fail' ? Promise.reject(new Error('delete failed')) : Promise.resolve()
    },
  })
  return { management, calls, kb }
}

/** Run with or without the account key, which lets this server turn hidden resources on. */
async function withAccountKey(present: boolean, work: () => Promise<void>) {
  const saved = ['ARAG_NUA_KEY', 'ARAG_ACCOUNT'].map((name) => [name, Deno.env.get(name)] as const)
  for (const [name] of saved) Deno.env.delete(name)
  if (present) {
    Deno.env.set('ARAG_NUA_KEY', 'fixture-key')
    Deno.env.set('ARAG_ACCOUNT', 'fixture-account')
  }
  try {
    await work()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name)
      else Deno.env.set(name, value)
    }
  }
}
const withoutAccountKey = (work: () => Promise<void>) => withAccountKey(false, work)

/**
 * Serve the page being added (as a readable page, or not at all so the platform crawls it), and
 * answer the account call that turns hidden resources on, recording what it sent.
 */
async function withPages(
  page: 'readable' | 'unreachable',
  kb: { hiddenResources: boolean },
  work: (account: { path: string; body: unknown }[]) => Promise<void>,
) {
  const original = globalThis.fetch
  const account: { path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.includes('/account/')) {
      account.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
      kb.hiddenResources = true
      return Response.json({})
    }
    if (page === 'unreachable') throw new TypeError('network unreachable')
    const paragraph = '<p>' +
      'The findings of the report are written out in full here. '.repeat(12) +
      '</p>'
    return new Response(
      `<html><head><title>Report</title></head><body><main><h1>Report</h1>${
        paragraph.repeat(3)
      }</main></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )
  }) as typeof fetch
  try {
    await work(account)
  } finally {
    globalThis.fetch = original
  }
}

const draft = { url: 'https://example.test/report', hidden: true }

Deno.test('a link added as a draft is created hidden and confirmed hidden', async () => {
  const { management, calls } = box('ok')
  const f = createEnforcementFixture({ management })
  try {
    const response = await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/resources/link',
      json('POST', draft),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'draft-1' })
    expect(calls).toEqual(['create:hidden', 'hide:draft-1:true'])
    // A link added without drafting is never hidden.
    calls.length = 0
    await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/resources/link',
      json('POST', { url: 'https://example.test/public' }),
    )
    expect(calls).toEqual(['create:public'])
  } finally {
    f.close()
  }
})

Deno.test('a draft on a box without hidden resources is refused, and nothing is created', async () => {
  await withoutAccountKey(async () => {
    // Whether the page is read here or handed to the platform crawler, the box refuses the
    // hidden create. The refusal is the designed one, and a page already read never falls
    // through to the crawler.
    for (const page of ['readable', 'unreachable'] as const) {
      const { management, calls, kb } = box('off')
      const f = createEnforcementFixture({ management })
      try {
        await withPages(page, kb, async (account) => {
          const response = await f.requestAs(
            f.sessionFor('portal-admin'),
            '/api/admin/t/a/resources/link',
            json('POST', draft),
          )
          expect(response.status, page).toBe(409)
          const body = await response.json()
          expect(body.error, page).toBe('draft_unavailable')
          expect(body.message, page).toContain('drafts need hidden resources')
          expect(calls, page).toEqual([page === 'readable' ? 'text:hidden' : 'create:hidden'])
          expect(account, page).toEqual([])
        })
      } finally {
        f.close()
      }
    }
  })
})

Deno.test('with the account key, a draft turns hidden resources on and is created hidden', async () => {
  await withAccountKey(true, async () => {
    for (const page of ['readable', 'unreachable'] as const) {
      const { management, calls, kb } = box('off')
      const f = createEnforcementFixture({ management })
      try {
        await f.stores.bindings.set('a', {
          baseUrl: 'https://example.test/kb/kb-a',
          token: 'fixture',
          kbId: 'kb-a',
        })
        await withPages(page, kb, async (account) => {
          const response = await f.requestAs(
            f.sessionFor('portal-admin'),
            '/api/admin/t/a/resources/link',
            json('POST', draft),
          )
          expect(response.status, page).toBe(200)
          expect(await response.json(), page).toEqual({ id: 'draft-1' })
          const create = page === 'readable' ? 'text:hidden' : 'create:hidden'
          expect(calls, page).toEqual([create, create, 'hide:draft-1:true'])
          expect(account, page).toEqual([
            {
              path: '/api/v1/account/fixture-account/kb/kb-a',
              body: { hidden_resources_enabled: true },
            },
          ])
        })
      } finally {
        f.close()
      }
    }
  })
})

Deno.test('a draft that cannot be confirmed hidden is taken back and the refusal says why', async () => {
  await withoutAccountKey(async () => {
    const { management, calls } = box('fail')
    const f = createEnforcementFixture({ management })
    try {
      const response = await f.requestAs(
        f.sessionFor('portal-admin'),
        '/api/admin/t/a/resources/link',
        json('POST', draft),
      )
      expect(response.status).toBe(502)
      const body = await response.json()
      expect(body.error).toBe('draft_unavailable')
      expect(body.message).toContain('could not be kept as a draft')
      // Never left published: the link is removed before the answer.
      expect(calls).toEqual(['create:hidden', 'hide:draft-1:true', 'delete:draft-1'])
    } finally {
      f.close()
    }
  })
})

Deno.test('a draft that can be neither confirmed nor removed is named, so it can be dealt with', async () => {
  await withoutAccountKey(async () => {
    const { management, calls } = box('fail', 'fail')
    const f = createEnforcementFixture({ management })
    try {
      const response = await f.requestAs(
        f.sessionFor('portal-admin'),
        '/api/admin/t/a/resources/link',
        json('POST', draft),
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: 'draft_not_hidden',
        message:
          'The link was added, but it could not be confirmed as a draft and removing it failed. Check it in Recent additions, and hide or remove it.',
        id: 'draft-1',
      })
      expect(calls).toEqual(['create:hidden', 'hide:draft-1:true', 'delete:draft-1'])
    } finally {
      f.close()
    }
  })
})

Deno.test('hiding on a knowledge box without hidden resources is a clear refusal, not a failure', async () => {
  await withoutAccountKey(async () => {
    const { management, calls } = box('off')
    const f = createEnforcementFixture({ management })
    try {
      const response = await f.requestAs(
        f.sessionFor('portal-admin'),
        '/api/admin/t/a/resources/res-1/hidden',
        json('POST', { hidden: true }),
      )
      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('hidden_resources_off')
      expect(body.message).toContain('not turned on')
      expect(calls).toEqual(['hide:res-1:true'])
    } finally {
      f.close()
    }
  })
})
