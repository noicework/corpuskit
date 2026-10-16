import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_RESEARCH_ENRICHMENT } from '@research-portal/core'
import { enrichmentDisplay } from '../../lib/enrichment-display.ts'
import { createPortalLocale, PortalLocaleContext } from '../../lib/portal-locale.tsx'
import { missingPortalMessages } from '../../lib/locale-messages.ts'
import { preflightEnrichmentArchive } from '../../api/enrichment-import.ts'
import { EnrichmentArchiveImport, enrichmentDoneMessage } from './EnrichmentsPanel.tsx'
import { validate } from './LabelsetsPanel.tsx'
import { announce, summarise, type UploadRow } from './upload-queue.ts'

const japanese = createPortalLocale('ja')

Deno.test('built-in schema display is localised without changing generation schemas or custom copy', () => {
  const original = structuredClone(DEFAULT_RESEARCH_ENRICHMENT)
  const display = enrichmentDisplay(DEFAULT_RESEARCH_ENRICHMENT, japanese.ui)
  expect(display.title).toBe('研究資料の要約')
  expect(display.fields[0]?.label).toBe('タイトル')
  expect(display.fields[1]?.label).toBe('要約')
  expect(display.id).toBe(original.id)
  expect(display.fields.map((field) => [field.key, field.kind])).toEqual(
    original.fields.map((field) => [field.key, field.kind]),
  )
  expect(DEFAULT_RESEARCH_ENRICHMENT).toEqual(original)
  const authored = {
    ...original,
    id: 'authored-schema',
    title: 'Summary',
    description: 'Library {name} <study>',
  }
  expect(enrichmentDisplay(authored, japanese.ui)).toBe(authored)
  const customisedBuiltIn = { ...original, title: 'Summary', description: 'Library {name}' }
  expect(enrichmentDisplay(customisedBuiltIn, japanese.ui).title).toBe('Summary')
  expect(enrichmentDisplay(customisedBuiltIn, japanese.ui).description).toBe('Library {name}')
  expect(missingPortalMessages([
    original.title,
    original.description,
    ...original.fields.flatMap((field) => [field.label, field.description]),
  ])).toEqual([])
})

Deno.test('Manage templates keep authored keys and braces and English helper defaults', () => {
  const draft = {
    title: 'Summary',
    multiple: true,
    labels: [{ title: 'Library {name}', text: '' }, { title: 'Library {name}', text: '' }],
  }
  expect(validate(draft)).toEqual(['Label "Library {name}" appears more than once.'])
  expect(validate(draft, japanese.ui)).toEqual(['ラベル「Library {name}」が重複しています。'])
  expect(enrichmentDoneMessage({ type: 'done', enriched: 2, errors: 1 })).toEqual({
    tone: 'error',
    text: 'Enriched 2 resources, 1 could not be generated.',
  })
  expect(enrichmentDoneMessage({ type: 'done', enriched: 2, errors: 1 }, japanese).text).toBe(
    '2件の資料に付加情報を生成しました。1件は生成できませんでした。',
  )
  const row: UploadRow = {
    key: 'original-key',
    name: 'Summary {name}.pdf',
    size: 100,
    status: 'ready',
    progress: null,
  }
  expect(announce(row)).toBe('Summary {name}.pdf is ready.')
  expect(announce(row, japanese.ui, japanese.error)).toBe('Summary {name}.pdfの準備ができました。')
  expect(summarise([row], japanese.ui)).toBe('ファイル1件: 準備完了1件')
})

Deno.test('archive validation stays canonical while its presentation and chooser are Japanese', () => {
  let failure: unknown
  try {
    preflightEnrichmentArchive('{}')
  } catch (error) {
    failure = error
  }
  expect((failure as Error).message).toBe(
    'Choose an archive containing at least one enrichment record.',
  )
  expect(japanese.error(failure, 'Could not read this archive.')).toBe(
    '付加情報レコードが1件以上含まれるアーカイブを選択してください。',
  )
  expect(japanese.error(new Error('untrusted {name} <payload>'), 'Could not read this archive.'))
    .toBe('アーカイブを読み込めませんでした。')
  const markup = renderToStaticMarkup(
    <PortalLocaleContext.Provider value={japanese}>
      <EnrichmentArchiveImport
        slug='original-slug'
        access={{ request: () => Promise.reject(new Error('No request during render')) }}
        assertCurrent={() => {}}
        onImported={() => Promise.resolve()}
      />
    </PortalLocaleContext.Provider>,
  )
  expect(markup).toContain('アーカイブファイルを選択')
  expect(markup).toContain('ファイルが選択されていません')
  expect(markup).toContain('アーカイブを確認')
  expect(markup).toMatch(/type="file"[^>]*class="sr-only"/)
  expect(markup).not.toContain('Choose file')
})
