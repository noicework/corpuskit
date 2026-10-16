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
    ],
  } as ResourceContent
  expect(documentTextFor(content, undefined)).toContain('日本語の実験ノート')
  expect(documentTextFor(content, undefined)).not.toContain('レレレレレ')
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
