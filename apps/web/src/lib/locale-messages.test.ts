import { expect } from '@std/expect'
import {
  combineJapaneseCatalogs,
  missingPortalMessages,
  portalDate,
  portalError,
  portalNumber,
  portalUi,
} from './locale-messages.ts'
import { createPortalLocale } from './portal-locale.tsx'

Deno.test('Japanese feature catalogs reject collisions, empty copy and changed parameters', () => {
  expect(combineJapaneseCatalogs({ Save: '保存' }, { Save: '保存' })).toEqual({ Save: '保存' })
  expect(() => combineJapaneseCatalogs({ Save: '保存' }, { Save: '別の意味' })).toThrow(
    'Conflicting',
  )
  expect(() => combineJapaneseCatalogs({ '': '空' })).toThrow('Empty')
  expect(() => combineJapaneseCatalogs({ Name: '' })).toThrow('Empty')
  expect(() => combineJapaneseCatalogs({ 'Open {name}': '{other}を開く' })).toThrow('parameters')
  expect(missingPortalMessages(['Save', 'Untranslated interface copy', 'Save']))
    .toEqual(['Untranslated interface copy'])
})

Deno.test('shared locale preserves English and authored interpolation values without another pass', () => {
  const source = 'Original {count} <研究> AP-M1'
  expect(portalUi('en', 'Open {name}', { name: source })).toBe(`Open ${source}`)
  expect(portalUi('ja', 'Open {name}', { name: source })).toBe(`${source}を開く`)
  expect(portalUi('ja', 'Save')).toBe('保存')
  expect(portalUi('ja', 'Authored source text')).toBe('Authored source text')
  expect(createPortalLocale('ja').ui('Summary')).toBe('要約')
  expect(createPortalLocale('en').ui('Summary')).toBe('Summary')
})

Deno.test('dates and numbers use the selected locale with safe invalid values', () => {
  const options = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' } as const
  expect(portalDate('ja', '2026-10-16T00:00:00Z', options)).toBe('2026年10月16日')
  expect(portalDate('en', '2026-10-16T00:00:00Z', options)).toBe('16 October 2026')
  expect(portalDate('ja', 'invalid')).toBe('日付不明')
  expect(portalNumber('ja', 1234.5)).toBe('1,234.5')
  expect(portalNumber('en', 1234.5)).toBe('1,234.5')
  expect(portalNumber('ja', NaN)).toBe('—')
})

Deno.test('Japanese errors use known static copy or codes and never expose arbitrary payloads', () => {
  expect(portalError('ja', new Error('Something went wrong'), 'Try again')).toBe(
    '問題が発生しました',
  )
  expect(portalError('ja', { code: 'forbidden', message: 'private source payload' }, 'Try again'))
    .toBe('この操作を行う権限がありません。')
  expect(portalError('ja', new Error('private source payload'), 'Try again')).toBe('再試行')
  expect(portalError('ja', new Error('再試行'), 'Save')).toBe('再試行')
  expect(portalError('en', new Error('Existing English error'), 'Try again'))
    .toBe('Existing English error')
})
