import { expect } from '@std/expect'
import { AragProvider } from '@research-portal/retrieval'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** A knowledge box whose hiding works, is turned off, or fails, and whose removals may fail. */
function box(hide: 'ok' | 'off' | 'fail', remove: 'ok' | 'fail' = 'ok') {
  const calls: string[] = []
  const management = new AragProvider({ resolveBinding: () => undefined })
  Object.assign(management, {
    resourceCount: () => Promise.resolve(0),
    createLink: (_config: unknown, input: { hidden?: boolean }) => {
      calls.push(`create:${input.hidden ? 'hidden' : 'public'}`)
      return Promise.resolve({ id: 'draft-1' })
    },
    setResourceHidden: (_config: unknown, id: string, hidden: boolean) => {
      calls.push(`hide:${id}:${hidden}`)
      if (hide === 'off') {
        return Promise.reject(
          new Error(
            'Agentic RAG API 412: This knowledge box does not have hidden resources enabled',
          ),
        )
      }
      if (hide === 'fail') return Promise.reject(new Error('upstream unavailable'))
      return Promise.resolve()
    },
    deleteResource: (_config: unknown, id: string) => {
      calls.push(`delete:${id}`)
      return remove === 'fail' ? Promise.reject(new Error('delete failed')) : Promise.resolve()
    },
  })
  return { management, calls }
}

/** Without the account key this server cannot turn hidden resources on, as on a hosted portal. */
async function withoutAccountKey(work: () => Promise<void>) {
  const saved = ['ARAG_NUA_KEY', 'ARAG_ACCOUNT'].map((name) => [name, Deno.env.get(name)] as const)
  for (const [name] of saved) Deno.env.delete(name)
  try {
    await work()
  } finally {
    for (const [name, value] of saved) if (value !== undefined) Deno.env.set(name, value)
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

Deno.test('a draft that cannot be hidden is taken back and the refusal says why', async () => {
  await withoutAccountKey(async () => {
    for (
      const [hide, status, error, message] of [
        ['off', 409, 'draft_unavailable', 'drafts need hidden resources'],
        ['fail', 502, 'draft_unavailable', 'could not be kept as a draft'],
      ] as const
    ) {
      const { management, calls } = box(hide)
      const f = createEnforcementFixture({ management })
      try {
        const response = await f.requestAs(
          f.sessionFor('portal-admin'),
          '/api/admin/t/a/resources/link',
          json('POST', draft),
        )
        expect(response.status, hide).toBe(status)
        const body = await response.json()
        expect(body.error).toBe(error)
        expect(body.message).toContain(message)
        // Never left published: the link is removed before the answer.
        expect(calls, hide).toEqual(['create:hidden', 'hide:draft-1:true', 'delete:draft-1'])
      } finally {
        f.close()
      }
    }
  })
})

Deno.test('a draft that can be neither hidden nor removed is named, so it can be dealt with', async () => {
  await withoutAccountKey(async () => {
    const { management, calls } = box('off', 'fail')
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
          'The link was added but could not be kept as a draft, and removing it failed. Hide or remove it from Recent additions.',
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
