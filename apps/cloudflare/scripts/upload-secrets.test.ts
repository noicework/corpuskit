import { expect } from '@std/expect'
import { missingWorkerSecrets, unsafeWorkerSecrets, workerSecrets } from './upload-secrets.ts'

Deno.test('Worker secret upload excludes account provisioning credentials', () => {
  const values = workerSecrets(`
ARAG_ZONE=aws-ap-southeast-2-1
ARAG_ACCOUNT=must-not-upload
ARAG_NUA_KEY=must-not-upload
ARAG_KB_MARINE=box-id
ARAG_KB_MARINE_TOKEN="box-token"
ENTRA_CLIENT_SECRET=client-secret
SESSION_SECRET=session-secret
CLOUDFLARE_ACCOUNT_ID=cloudflare-account-id
CLOUDFLARE_DOMAINS_TOKEN=domain-token
`)

  expect(values).toEqual({
    ARAG_ZONE: 'aws-ap-southeast-2-1',
    ARAG_KB_MARINE: 'box-id',
    ARAG_KB_MARINE_TOKEN: 'box-token',
    ENTRA_CLIENT_SECRET: 'client-secret',
    SESSION_SECRET: 'session-secret',
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
    CLOUDFLARE_DOMAINS_TOKEN: 'domain-token',
  })
})

Deno.test('Worker secret upload includes external sign-in configuration but excludes private keys', () => {
  const values = workerSecrets(`
EXTERNAL_LOGIN_ISSUER=https://identity.example
EXTERNAL_LOGIN_JWK='{"kty":"OKP","crv":"Ed25519","x":"public-key"}'
EXTERNAL_LOGIN_NAME=Organisation account
EXTERNAL_LOGIN_START_URL=https://identity.example/start
EXTERNAL_LOGIN_PRIVATE_JWK=must-not-upload
`)
  expect(values).toEqual({
    EXTERNAL_LOGIN_ISSUER: 'https://identity.example',
    EXTERNAL_LOGIN_JWK: '{"kty":"OKP","crv":"Ed25519","x":"public-key"}',
    EXTERNAL_LOGIN_NAME: 'Organisation account',
    EXTERNAL_LOGIN_START_URL: 'https://identity.example/start',
  })
})

const baseSecrets = {
  ARAG_ZONE: 'aws-ap-southeast-2-1',
  ARAG_KB_MARINE: 'box-id',
  ARAG_KB_MARINE_TOKEN: 'box-token',
  SESSION_SECRET: 'session-secret',
}

Deno.test('Worker secret upload accepts Entra, external-only, or combined sign-in', () => {
  const external = {
    EXTERNAL_LOGIN_ISSUER: 'https://identity.example',
    EXTERNAL_LOGIN_JWK: '{"kty":"OKP","crv":"Ed25519","x":"public-key"}',
  }
  for (
    const identity of [
      { ENTRA_CLIENT_SECRET: 'client-secret' },
      external,
      { ...external, ENTRA_CLIENT_SECRET: 'client-secret' },
    ]
  ) {
    expect(missingWorkerSecrets({ ...baseSecrets, ...identity })).toEqual([])
  }
})

Deno.test('Worker secret upload rejects absent or partial external-only configuration', () => {
  const configurations: Record<string, string>[] = [
    {},
    { EXTERNAL_LOGIN_ISSUER: 'https://identity.example' },
    { EXTERNAL_LOGIN_JWK: 'public-key' },
  ]
  for (const identity of configurations) {
    expect(missingWorkerSecrets({ ...baseSecrets, ...identity })).toEqual([
      'ENTRA_CLIENT_SECRET or EXTERNAL_LOGIN_ISSUER + EXTERNAL_LOGIN_JWK',
    ])
  }
})

Deno.test('Worker secret upload retains session, zone and knowledge-box prerequisites', () => {
  expect(missingWorkerSecrets({ ENTRA_CLIENT_SECRET: 'client-secret' })).toEqual([
    'ARAG_ZONE',
    'SESSION_SECRET',
    'ARAG_KB_<SLUG> + token',
  ])
})

Deno.test('Worker secret upload refuses an external sign-in key that is not an Ed25519 public JWK', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  expect(privateJwk.d).toBeDefined()
  const message = 'EXTERNAL_LOGIN_JWK must be an Ed25519 public JWK without private key material'
  expect(unsafeWorkerSecrets({ ...baseSecrets })).toEqual([])
  expect(unsafeWorkerSecrets({ EXTERNAL_LOGIN_JWK: JSON.stringify(publicJwk) })).toEqual([])
  expect(
    unsafeWorkerSecrets({
      EXTERNAL_LOGIN_JWK:
        '{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWqFVT1RJXsGFiLKXMhzSk2YuOw"}',
    }),
  ).toEqual([])
  for (
    const value of [
      JSON.stringify(privateJwk),
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, d: '' }),
      JSON.stringify({ ...publicJwk, crv: 'X25519' }),
      JSON.stringify({ ...publicJwk, kty: 'EC' }),
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519' }),
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'public-key' }),
      JSON.stringify([publicJwk]),
      'public-key',
      '',
    ]
  ) {
    const unsafe = unsafeWorkerSecrets({ ...baseSecrets, EXTERNAL_LOGIN_JWK: value })
    expect(unsafe).toEqual([message])
    // The refusal names the setting only; it never echoes key material.
    if (value.length > 2) expect(unsafe.join()).not.toContain(value)
    if (privateJwk.d) expect(unsafe.join()).not.toContain(privateJwk.d)
  }
})
