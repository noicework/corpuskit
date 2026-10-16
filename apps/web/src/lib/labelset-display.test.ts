import { expect } from '@std/expect'
import { LabelsetSchema } from '@research-portal/core'
import { createPortalLocale } from './portal-locale.tsx'
import { labelsetDisplayTitle } from './labelset-display.ts'

Deno.test('only unchanged built-in taxonomy names are display-localised', () => {
  const { ui } = createPortalLocale('ja')
  const topic = LabelsetSchema.parse({
    id: 'topic',
    title: 'Topic',
    labels: [],
    multiple: false,
    paragraphs: false,
  })
  const original = structuredClone(topic)
  expect(labelsetDisplayTitle(topic, ui)).toBe('テーマ')
  expect(topic).toEqual(original)
  expect(labelsetDisplayTitle({ ...topic, id: 'authored' }, ui)).toBe('Topic')
  expect(labelsetDisplayTitle({ ...topic, title: 'Library' }, ui)).toBe('Library')
  expect(labelsetDisplayTitle({ ...topic, title: 'Summary {name}' }, ui)).toBe('Summary {name}')
})
