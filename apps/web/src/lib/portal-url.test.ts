import { expect } from '@std/expect'
import { portalHref } from './portal-url.ts'

Deno.test('portalHref uses a tenant custom domain on CorpusKit production hosts', () => {
  expect(portalHref('marine', {
    hostname: 'marine.corpuskit.org',
    currentHostname: 'corpuskit.org',
  })).toBe(
    'https://marine.corpuskit.org/t/marine',
  )
  expect(portalHref('grains', {
    hostname: 'grains.corpuskit.org',
    suffix: '/search?q=wheat',
    currentHostname: 'marine.corpuskit.org',
  })).toBe(
    'https://grains.corpuskit.org/t/grains/search?q=wheat',
  )
})

Deno.test('portalHref keeps portals without a configured hostname relative', () => {
  expect(portalHref('new-portal', { currentHostname: 'corpuskit.org' })).toBe('/t/new-portal')
})

Deno.test('portalHref keeps local, preview and same-host navigation relative', () => {
  expect(portalHref('marine', {
    hostname: 'marine.corpuskit.org',
    suffix: '/library',
    currentHostname: '127.0.0.1',
  })).toBe('/t/marine/library')
  expect(portalHref('grains', {
    hostname: 'grains.corpuskit.org',
    currentHostname: 'corpuskit.test',
  })).toBe('/t/grains')
  expect(portalHref('marine', {
    hostname: 'marine.corpuskit.org',
    currentHostname: 'corpuskit.noice.net.au',
  })).toBe('/t/marine')
  expect(portalHref('marine', {
    hostname: 'marine.corpuskit.org',
    currentHostname: 'marine.corpuskit.org',
  })).toBe('/t/marine')
})
