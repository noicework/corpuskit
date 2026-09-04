import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { createProviderFromEnv } from './env.ts'
import { AragProvider } from './providers/arag/index.ts'
import { ndjson } from './providers/arag/client.ts'

describe('createProviderFromEnv', () => {
  it('throws a clear error when ARAG_ZONE is missing', () => {
    expect(() => createProviderFromEnv({})).toThrow(/ARAG_ZONE/)
  })

  it('throws a clear error when no bindings are present', () => {
    expect(() => createProviderFromEnv({ ARAG_ZONE: 'aws-ap-southeast-2-1' })).toThrow(
      /deno task provision/,
    )
  })

  it('discovers per-tenant bindings from the environment', () => {
    const provider = createProviderFromEnv({
      ARAG_ZONE: 'aws-ap-southeast-2-1',
      ARAG_KB_GRAINS: 'kb-1',
      ARAG_KB_GRAINS_TOKEN: 'token-1',
      ARAG_KB_MARINE: 'kb-2',
      ARAG_KB_MARINE_TOKEN: 'token-2',
      ARAG_KB_ORPHAN: 'kb-3',
    })
    expect(provider).toBeInstanceOf(AragProvider)
  })
})

describe('ndjson', () => {
  it('yields each JSON line and tolerates blank and partial lines', async () => {
    const body = '{"a":1}\n\n{"b":2}\nnot-json\n{"c":3}'
    const res = new Response(body)
    const items: unknown[] = []
    for await (const item of ndjson(res)) items.push(item)
    expect(items).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })
})
