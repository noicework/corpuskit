import { expect } from '@std/expect'
import { portalHref } from './portal-url.ts'

Deno.test('portalHref uses a tenant custom domain on CorpusKit production hosts', () => {
  expect(portalHref('marine', {
    platformDomain: 'corpuskit.org',
    hostname: 'marine.corpuskit.org',
    currentHostname: 'corpuskit.org',
  })).toBe(
    'https://marine.corpuskit.org/t/marine',
  )
  expect(portalHref('grains', {
    platformDomain: 'corpuskit.org',
    hostname: 'grains.corpuskit.org',
    suffix: '/search?q=wheat',
    currentHostname: 'marine.corpuskit.org',
  })).toBe(
    'https://grains.corpuskit.org/t/grains/search?q=wheat',
  )
})

Deno.test('portalHref uses a runtime domain and keeps other deployments relative', () => {
  const options = {
    platformDomain: 'research.example.org',
    hostname: 'marine.research.example.org',
  }
  expect(portalHref('marine', { ...options, currentHostname: 'research.example.org' }))
    .toBe('https://marine.research.example.org/t/marine')
  expect(portalHref('marine', { ...options, currentHostname: 'grains.research.example.org' }))
    .toBe('https://marine.research.example.org/t/marine')
  expect(portalHref('marine', { ...options, currentHostname: 'marine.research.example.org' }))
    .toBe('/t/marine')
  for (
    const host of ['corpuskit.org', 'research.example.org.evil.test', 'notresearch.example.org']
  ) {
    expect(portalHref('marine', { ...options, currentHostname: host })).toBe('/t/marine')
  }
})

Deno.test('portalHref without valid runtime configuration or hostname stays relative', () => {
  for (
    const platformDomain of [undefined, '', '__CORPUSKIT_PLATFORM_DOMAIN__', 'https://example.org']
  ) {
    expect(portalHref('marine', {
      platformDomain,
      hostname: 'marine.corpuskit.org',
      currentHostname: 'corpuskit.org',
    })).toBe('/t/marine')
  }
  for (const hostname of ['evil.test/path', 'evil.test@other.test', 'evil.test#fragment']) {
    expect(portalHref('marine', {
      platformDomain: 'research.example.org',
      hostname,
      currentHostname: 'research.example.org',
    })).toBe('/t/marine')
  }
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
