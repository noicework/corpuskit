import { expect } from '@std/expect'
import { DEFAULT_RESEARCH_ENRICHMENT, TenantConfigSchema } from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import { buildEnrichmentQuery, documentTextFor, generateEnrichment } from './enrichments.ts'
import type { ResourceContent } from '@research-portal/core'
import { tenantConfig } from './tenants.ts'

Deno.test('Japanese source enrichment overrides the English default field descriptions', () => {
  const query = buildEnrichmentQuery(DEFAULT_RESEARCH_ENRICHMENT, '日本語の研究記録', 'ja')
  expect(query).toContain('natural Japanese')
  expect(query).toContain('overrides')
  expect(query).toContain('Keep verbatim quotations in their source language')
  expect(query).toContain('日本語の研究記録')
})

Deno.test('ordinary source enrichment retains the existing English default', () => {
  const query = buildEnrichmentQuery(DEFAULT_RESEARCH_ENRICHMENT, 'Source document')
  expect(query).toContain('Australian English.')
  expect(query).not.toContain('natural Japanese')
})

Deno.test('a faithful authored transcript takes precedence over a broken office conversion', () => {
  const content = {
    texts: [
      { fieldId: 'files/source', text: '日日日日 レレレレレ' },
      {
        fieldId: 'texts/native_source',
        text: '日本語の実験ノート\n\n| 条件 | 結果 |\n| A | 22.4 |',
      },
      { fieldId: 'texts/da-pagesummary-f-source', text: 'An English generated summary.' },
    ],
  } as ResourceContent
  expect(documentTextFor(content, undefined)).toContain('日本語の実験ノート')
  expect(documentTextFor(content, undefined)).not.toContain('レレレレレ')
  expect(documentTextFor(content, undefined)).not.toContain('English generated summary')
})

Deno.test('generated DA text is never an original source fallback', () => {
  const content = {
    texts: [{ fieldId: 'texts/da-pagesummary-f-source', text: 'An English generated summary.' }],
  } as ResourceContent
  expect(documentTextFor(content, undefined)).toBe('')
})

Deno.test('Japanese file text survives a generated summary in the provider texts group', async (t) => {
  const sourceText = '日本語の試験記録と測定結果。熱サイクル後の接着強さは結果表に記載。'
  const generatedSummary =
    'An English summary translated during ingestion with no original Japanese source text.'
  const generatedAnswer = {
    title: '熱サイクル後の接着強さ',
    summary: '試験記録に基づく日本語の要約。',
    keyTakeaways: [],
    quotesOfInterest: [],
  }
  const queries: string[] = []
  const base = tenantConfig('grains')!
  const management = new AragProvider({
    resolveBinding: () => ({ baseUrl: 'https://example.test/api/v1/kb/test', token: 'test-token' }),
    fetchImpl: (input, init) => {
      const url = String(input)
      if (url.includes('/resource/')) {
        return Promise.resolve(Response.json({
          title: '日本語の試験記録',
          data: {
            files: { source: { extracted: { text: { text: sourceText } } } },
            texts: {
              'da-pagesummary-f-source': { extracted: { text: { text: generatedSummary } } },
            },
          },
        }))
      }
      if (url.includes('/catalog')) return Promise.resolve(Response.json({ resources: {} }))
      if (url.endsWith('/ask')) {
        queries.push(JSON.parse(String(init?.body)).query)
        return Promise.resolve(
          new Response(
            JSON.stringify({ item: { type: 'answer_json', object: generatedAnswer } }) + '\n',
          ),
        )
      }
      throw new Error(`Unexpected mocked request: ${url}`)
    },
  })

  await t.step(
    'bilingual generation embeds the original file and keeps its native summary',
    async () => {
      const config = TenantConfigSchema.parse({
        ...base,
        languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
      })
      const enrichment = await generateEnrichment(management, config, 'ja-source')
      expect(queries[0]).toContain(sourceText)
      expect(queries[0]).not.toContain(generatedSummary)
      expect(enrichment.data.summary).toBe(generatedAnswer.summary)
      expect(enrichment.usedPageSummary).toBeUndefined()
    },
  )

  await t.step('ordinary tenants retain deliberate ingest-summary reuse', async () => {
    const enrichment = await generateEnrichment(management, base, 'ja-source')
    expect(queries[1]).toContain(generatedSummary)
    expect(queries[1]).not.toContain(sourceText)
    expect(enrichment.data.summary).toBe(generatedSummary)
    expect(enrichment.usedPageSummary).toBe(true)
  })
})

Deno.test('a bilingual portal must offer its configured default language', () => {
  const config = tenantConfig('grains')!
  expect(
    TenantConfigSchema.safeParse({
      ...config,
      languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['en'] },
    }).success,
  ).toBe(false)
  expect(
    TenantConfigSchema.safeParse({
      ...config,
      languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
    }).success,
  ).toBe(true)
})

Deno.test('Japanese source never persists a translated ingest summary after generation failure', async () => {
  const config = TenantConfigSchema.parse({
    ...tenantConfig('grains')!,
    languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
  })
  const management = {
    resourceContent: () =>
      Promise.resolve({
        id: 'ja-source',
        title: '日本語の試験記録',
        summary: 'An English summary translated during ingestion.',
        pageSummary: 'Another English summary translated during ingestion.',
        texts: [{ fieldId: 'body', text: '日本語の試験記録と測定結果。' }],
      }),
    askStructured: () => Promise.resolve({ object: null }),
  } as unknown as AragProvider
  await expect(generateEnrichment(management, config, 'ja-source')).rejects.toThrow(
    'No content available',
  )
})
