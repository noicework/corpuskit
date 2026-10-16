import { expect } from '@std/expect'
import { createPortalLocale } from '../lib/portal-locale.tsx'
import { prettyLabel, savedFileNotice, typeLabel } from './ui.tsx'

Deno.test('shared UI formatters retain English defaults and translate only known display copy', () => {
  const { ui } = createPortalLocale('ja')
  expect(typeLabel('document')).toBe('Document')
  expect(typeLabel('document', ui)).toBe('資料')
  expect(prettyLabel('cohort-study')).toBe('Cohort study')
  expect(prettyLabel('cohort-study', undefined, ui)).toBe('コホート研究')
  // A known interface key as an authored title still must not be translated.
  expect(prettyLabel('Summary', undefined, ui)).toBe('Summary')
  expect(prettyLabel('Original {count} <study>', undefined, ui)).toBe('Original {count} <study>')
  expect(savedFileNotice('Library {name}.docx', 'Word document')).toBe(
    'Saved Library {name}.docx (Word document)',
  )
  expect(savedFileNotice('Library {name}.docx', 'Summary', ui)).toBe(
    'Library {name}.docxを保存しました（Summary）',
  )
})
