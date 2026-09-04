import { expect } from '@std/expect'
import { describe, it } from '@std/testing/bdd'
import { KbClient } from './client.ts'

describe('KbClient fetch integration', () => {
  it('preserves the global receiver required by host-provided fetch implementations', async () => {
    let receiver: unknown
    const receiverCheckingFetch = function (this: unknown): Promise<Response> {
      receiver = this
      return Promise.resolve(Response.json({ ok: true }))
    } as typeof fetch

    const client = new KbClient(
      {
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
        token: 'test-token',
      },
      receiverCheckingFetch,
    )

    await expect(client.getJson('/catalog')).resolves.toEqual({ ok: true })
    expect(receiver).toBe(globalThis)
  })
})
