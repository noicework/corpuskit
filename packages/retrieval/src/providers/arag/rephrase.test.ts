import { expect } from '@std/expect'
import { AragProvider } from './index.ts'
import { TenantConfigSchema } from '@research-portal/core'

const tenant = TenantConfigSchema.parse({
  slug: 'test',
  branding: {
    organisation: 'Test',
    productName: 'Test',
    tagline: 'Test',
    colours: { primary: '#000000', accent: '#ffffff', heroFrom: '#000000', heroTo: '#000000' },
  },
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
  searchPlaceholder: 'Search',
})

Deno.test('rephrase omits model refusal sentinels but preserves rewritten questions', async () => {
  for (
    const [raw, expected] of [
      ['Not enough context to answer this.-2', null],
      ['Not enough data to answer this.0', null],
      ['How do labels organise resources?1', 'How do labels organise resources?'],
    ] as const
  ) {
    const provider = new AragProvider({
      resolveBinding: () => ({
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test',
        token: 'test',
      }),
      fetchImpl: () => Promise.resolve(Response.json(raw)),
    })
    expect(await provider.rephrase(tenant, 'How do labels work?')).toBe(expected)
  }
})
