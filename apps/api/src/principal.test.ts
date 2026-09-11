import { expect } from '@std/expect'
import { createHmac, hkdfSync } from 'node:crypto'
import {
  PrincipalEnvelopeSchema,
  signPrincipal,
  stripIdentityHeaders,
  verifyPrincipal,
} from './principal.ts'

const secret = '0123456789abcdef0123456789abcdef'
const config = { sessionSecret: secret, audience: 'corpuskit', tenantId: 'tenant-1' }
const payload = {
  v: 1 as const,
  aud: 'corpuskit' as const,
  tid: 'tenant-1',
  oid: 'oid-1',
  email: 'person@example.test',
  name: 'Person',
  roles: ['CorpusKit.Admin'],
  groups: ['group-1'],
  iat: 1800000000,
}
const now = payload.iat * 1000
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const encoder = new TextEncoder()
function independentSign(value: unknown, signingSecret = secret): string {
  const bytes = encoder.encode(JSON.stringify(value))
  const key = hkdfSync('sha256', signingSecret, new Uint8Array(), 'corpuskit-principal-v1', 32)
  return `${encode(bytes)}.${
    createHmac('sha256', new Uint8Array(key)).update(bytes).digest('base64url')
  }`
}

Deno.test('principal codec agrees with independent HKDF/HMAC and known Node vector', async () => {
  const header = await signPrincipal(payload, secret)
  expect(header).toBe(independentSign(payload))
  expect(header.split('.')[1]).toBe('XLc6bPuiuMbhW2NNOaWDIoVmkORoCnl2wcaO-ncglJk')
  expect(await verifyPrincipal(header, config, now)).toEqual({
    kind: 'verified',
    envelope: payload,
  })
  expect(await verifyPrincipal(null, config, now)).toEqual({ kind: 'anonymous' })
  expect(await verifyPrincipal('', config, now)).toMatchObject({ kind: 'rejected' })
})

Deno.test('principal codec rejects signed schema violations, cross-deployment and cross-tenant identity', async () => {
  for (
    const change of [
      { v: 2 },
      { aud: 'elsewhere' },
      { tid: '' },
      { oid: '' },
      { email: null },
      { name: 123 },
      { roles: [1] },
      { groups: ['bad group'] },
      { iat: '1800000000' },
      { iat: -1 },
      { iat: 1.1 },
      { iat: Number.MAX_SAFE_INTEGER + 1 },
      { preferredUsername: 'extra' },
    ]
  ) {
    expect(await verifyPrincipal(independentSign({ ...payload, ...change }), config, now))
      .toMatchObject({ kind: 'rejected' })
  }
  for (const key of Object.keys(payload)) {
    const missing: Record<string, unknown> = { ...payload }
    delete missing[key]
    expect(await verifyPrincipal(independentSign(missing), config, now)).toMatchObject({
      kind: 'rejected',
    })
  }
  const header = await signPrincipal(payload, secret)
  for (const audience of ['corpuskit-demo', 'corpuskit-demos']) {
    expect(await verifyPrincipal(header, { ...config, audience }, now)).toMatchObject({
      kind: 'rejected',
      code: 'audience',
    })
  }
  expect(await verifyPrincipal(header, { ...config, tenantId: 'other' }, now)).toMatchObject({
    kind: 'rejected',
    code: 'tenant',
  })
  expect(await verifyPrincipal(header, { ...config, sessionSecret: 'x'.repeat(32) }, now))
    .toMatchObject({ kind: 'rejected', code: 'signature' })
  expect(PrincipalEnvelopeSchema.safeParse({ ...payload, extra: true }).success).toBe(false)
})

Deno.test('principal codec accepts exact clock boundaries and rejects values beyond them', async () => {
  const header = await signPrincipal(payload, secret)
  for (const offset of [60_000, -30_000, 0]) {
    expect(await verifyPrincipal(header, config, now + offset)).toMatchObject({ kind: 'verified' })
  }
  for (const offset of [60_001, -30_001]) {
    expect(await verifyPrincipal(header, config, now + offset)).toMatchObject({
      kind: 'rejected',
      code: 'freshness',
    })
  }
  expect(await verifyPrincipal(header, config, NaN)).toMatchObject({ kind: 'rejected' })
})

Deno.test('principal codec rejects forged bytes, malformed tags and non-canonical base64url', async () => {
  const header = await signPrincipal(payload, secret)
  const [body, tag] = header.split('.') as [string, string]
  const forged = encode(encoder.encode(JSON.stringify({ ...payload, roles: ['CorpusKit.Owner'] })))
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const alternate = tag.slice(0, -1) + alphabet[alphabet.indexOf(tag.at(-1)!) + 1]
  for (
    const invalid of [
      `${forged}.${tag}`,
      `${body}.${tag}=`,
      `${body}=.${tag}`,
      `${body}.${alternate}`,
      `${body}.AA`,
      `${body}.!`,
      `${body}.${tag}.extra`,
      ` ${header}`,
      'not-json',
      'a.a',
    ]
  ) {
    expect(await verifyPrincipal(invalid, config, now)).toMatchObject({ kind: 'rejected' })
  }
  const invalidUtf8 = new Uint8Array([0xff])
  const key = hkdfSync('sha256', secret, new Uint8Array(), 'corpuskit-principal-v1', 32)
  const invalid = `${encode(invalidUtf8)}.${
    createHmac('sha256', new Uint8Array(key)).update(invalidUtf8).digest('base64url')
  }`
  expect(await verifyPrincipal(invalid, config, now)).toMatchObject({ kind: 'rejected' })
})

Deno.test('principal codec bounds full UTF-8 header bytes and requires 32 UTF-8 secret bytes', async () => {
  for (const short of ['', 'x'.repeat(31), 'é'.repeat(15)]) {
    await expect(signPrincipal(payload, short)).rejects.toThrow()
    expect(
      await verifyPrincipal(independentSign(payload), { ...config, sessionSecret: short }, now),
    ).toMatchObject({ kind: 'rejected', code: 'configuration' })
  }
  const multibyte = 'é'.repeat(16)
  expect(
    await verifyPrincipal(await signPrincipal(payload, multibyte), {
      ...config,
      sessionSecret: multibyte,
    }, now),
  ).toMatchObject({ kind: 'verified' })
  const large = { ...payload, roles: Array.from({ length: 100 }, () => 'é'.repeat(100)) }
  expect(await verifyPrincipal(independentSign(large), config, now)).toMatchObject({
    kind: 'rejected',
    code: 'size',
  })
  await expect(signPrincipal(large, secret)).rejects.toThrow()
  expect(await verifyPrincipal('é'.repeat(4097), config, now)).toMatchObject({
    kind: 'rejected',
    code: 'size',
  })
  expect(await verifyPrincipal('é'.repeat(4096), config, now)).toMatchObject({
    kind: 'rejected',
    code: 'encoding',
  })
  const edge = { ...payload, name: '', roles: Array.from({ length: 22 }, () => 'x'.repeat(256)) }
  edge.name = 'x'.repeat(6111 - encoder.encode(JSON.stringify(edge)).byteLength)
  const exact = independentSign(edge)
  expect(encoder.encode(exact).byteLength).toBe(8192)
  expect(await signPrincipal(edge, secret)).toBe(exact)
  expect(await verifyPrincipal(exact, config, now)).toMatchObject({ kind: 'verified' })
  const beyond = { ...edge, name: edge.name + 'x' }
  expect(await verifyPrincipal(independentSign(beyond), config, now)).toMatchObject({
    kind: 'rejected',
    code: 'size',
  })
  await expect(signPrincipal(beyond, secret)).rejects.toThrow()
})

Deno.test('identity sanitation removes all case-insensitive principal and legacy header variants', () => {
  const headers = new Headers({
    'X-CorpusKit-Principal': 'forged',
    'X-CorpusKit-SSO-User-ID': 'forged',
    'x-corpuskit-sso-admin': '1',
    'x-corpuskit-sso-future': 'forged',
    'x-sso-user-id': 'forged',
    'x-sso-admin': '1',
    'content-type': 'application/json',
    'x-admin-passcode': 'request-only',
  })
  const cleaned = stripIdentityHeaders(headers)
  expect([...cleaned.keys()]).toEqual(['content-type', 'x-admin-passcode'])
  expect(headers.has('x-corpuskit-principal')).toBe(true)
})
