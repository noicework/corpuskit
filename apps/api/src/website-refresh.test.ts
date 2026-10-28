import { expect } from '@std/expect'
import { conditionalHeaders, pageChanged, pageFingerprint } from './website-refresh.ts'

Deno.test('page fingerprints compare readable content independently of noisy validators', async () => {
  const first = await pageFingerprint(new Headers({ etag: 'v1' }), {
    title: 'Research',
    body: 'First findings',
  })
  const same = await pageFingerprint(new Headers({ etag: 'v2' }), {
    title: 'Research',
    body: 'First findings',
  })
  const changed = await pageFingerprint(new Headers({ etag: 'v2' }), {
    title: 'Research',
    body: 'Revised findings',
  })
  expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(pageChanged(first, same)).toBe(false)
  expect(pageChanged(first, changed)).toBe(true)
  expect(conditionalHeaders(first)).toEqual({ 'if-none-match': 'v1' })
  expect(conditionalHeaders({ hash: 'h', lastModified: 'Tue, 20 Oct 2026 00:00:00 GMT' })).toEqual({
    'if-modified-since': 'Tue, 20 Oct 2026 00:00:00 GMT',
  })
  expect(conditionalHeaders()).toEqual({})
})
