import { expect } from '@std/expect'
import { webBuildStamp } from '../../api/src/build-stamp.ts'
import { stampBundle } from '../scripts/stamp-worker.ts'
import {
  decodeWebBuild,
  EMBEDDED_WEB_BUILD,
  embeddedWebBuild,
  encodeWebBuild,
} from './build-stamp.ts'

const stamp = { sha: '0cb3f0953d60', builtAt: '2026-09-27T01:02:03.000Z', release: '2026.9.27' }

Deno.test('a build stamp keeps its scalar fields and nothing else', () => {
  expect(webBuildStamp({ ...stamp, extra: 'private' })).toEqual(stamp)
  expect(webBuildStamp({ sha: 'dev', builtAt: stamp.builtAt, release: '' })).toEqual({
    sha: 'dev',
    builtAt: stamp.builtAt,
  })
  for (const raw of [null, 'text', {}, { sha: '', builtAt: 'x' }, { sha: 'a', builtAt: 1 }]) {
    expect(webBuildStamp(raw)).toBeUndefined()
  }
})

Deno.test('the embedded stamp round-trips through a string-literal-safe encoding', () => {
  const encoded = encodeWebBuild(stamp)
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(decodeWebBuild(encoded)).toEqual(stamp)
  for (const bad of [EMBEDDED_WEB_BUILD, '', 'not base64!', btoa('{"sha":1}')]) {
    expect(decodeWebBuild(bad)).toBeUndefined()
  }
  // Source and tests run unstamped, so the Worker reports no stamp there.
  expect(embeddedWebBuild()).toBeUndefined()
})

Deno.test('stamping a bundle replaces its one placeholder with the build stamp', () => {
  const bundle = `var a = 1;\nvar EMBEDDED = "${EMBEDDED_WEB_BUILD}";\nexport { a };\n`
  const stamped = stampBundle(bundle, JSON.stringify({ ...stamp, other: true }))
  expect(stamped).not.toContain(EMBEDDED_WEB_BUILD)
  const literal = /var EMBEDDED = "([^"]*)";/.exec(stamped)?.[1]
  expect(decodeWebBuild(literal ?? '')).toEqual(stamp)
  expect(stamped.replace(literal!, EMBEDDED_WEB_BUILD)).toBe(bundle)
})

Deno.test('stamping refuses a bundle without exactly one placeholder, or a bad stamp', () => {
  const json = JSON.stringify(stamp)
  expect(() => stampBundle('var a = 1;', json)).toThrow('found 0')
  expect(() => stampBundle(`"${EMBEDDED_WEB_BUILD}" + "${EMBEDDED_WEB_BUILD}"`, json)).toThrow(
    'found 2',
  )
  expect(() => stampBundle(`"${EMBEDDED_WEB_BUILD}"`, '{"sha":""}')).toThrow('not a build stamp')
})
