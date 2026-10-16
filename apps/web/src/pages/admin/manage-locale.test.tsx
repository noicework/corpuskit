import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_RESEARCH_ENRICHMENT } from '@research-portal/core'
import { enrichmentDisplay } from '../../lib/enrichment-display.ts'
import { createPortalLocale, PortalLocaleContext } from '../../lib/portal-locale.tsx'
import { missingPortalMessages } from '../../lib/locale-messages.ts'
import { preflightEnrichmentArchive } from '../../api/enrichment-import.ts'
import { EnrichmentArchiveImport, enrichmentDoneMessage } from './EnrichmentsPanel.tsx'
import { validate } from './LabelsetsPanel.tsx'
import { messageFor } from './shared.ts'
import { MessagePanel } from './MessagePanel.tsx'
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
  // The retained queue row is language-neutral: switching renders again without an upload.
  const originalRow = structuredClone(row)
  const renderUpload = (language: 'en' | 'ja') => {
    const locale = createPortalLocale(language)
    return [announce(row, locale.ui, locale.error), summarise([row], locale.ui)]
  }
  expect(renderUpload('en')).toEqual(['Summary {name}.pdf is ready.', '1 file: 1 ready'])
  expect(renderUpload('ja')).toEqual([
    'Summary {name}.pdfの準備ができました。',
    'ファイル1件: 準備完了1件',
  ])
  expect(renderUpload('en')).toEqual(['Summary {name}.pdf is ready.', '1 file: 1 ready'])
  expect(row).toEqual(originalRow)
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

Deno.test('a retained operation message changes language at render time with its authored values intact', () => {
  const result = { imported: 2, skipped: 1, filename: 'Summary {name}.json' }
  const message = messageFor(
    'ok',
    ({ ui, number }) =>
      ui('Imported {records}. Kept {existing} unchanged.', {
        records: ui('{count} records', { count: number(result.imported) }),
        existing: ui('{count} existing record', { count: number(result.skipped) }),
      }),
  )
  const render = (language: 'ja' | 'en') =>
    renderToStaticMarkup(
      <PortalLocaleContext.Provider value={createPortalLocale(language)}>
        <MessagePanel message={message} />
      </PortalLocaleContext.Provider>,
    )
  expect(message.text).toBe('Imported 2 records. Kept 1 existing record unchanged.')
  expect(render('en')).toContain(message.text)
  expect(render('ja')).toContain(
    'レコード2件をインポートし、既存のレコード1件は変更せずに保持しました。',
  )
  expect(render('en')).toContain(message.text)
  expect(result.filename).toBe('Summary {name}.json')
  const failure = messageFor(
    'error',
    ({ error }) => error(new Error('untrusted {name}'), 'Could not read this archive.'),
  )
  expect(failure.render?.(japanese)).toBe('アーカイブを読み込めませんでした。')
  expect(failure.render?.(createPortalLocale('en'))).toBe('untrusted {name}')
})

Deno.test('stage labels localise finite app status while authored record labels are never passed through it', async () => {
  const { stageText } = await import('./shared.ts')
  expect(stageText('Extracting with 2 methods', japanese)).toBe('2種類の方法で抽出中')
  expect(stageText('Extracting with 2 methods', createPortalLocale('en'))).toBe(
    'Extracting with 2 methods',
  )
  expect(stageText('Reading the document', japanese)).toBe('資料を読み込み中')
  expect(stageText('An unknown service stage', japanese)).toBe('処理中…')
})
