import { expect } from '@std/expect'
import { workerSecrets } from './upload-secrets.ts'

Deno.test('Worker secret upload excludes account provisioning credentials', () => {
  const values = workerSecrets(`
ARAG_ZONE=aws-ap-southeast-2-1
ARAG_ACCOUNT=must-not-upload
ARAG_NUA_KEY=must-not-upload
ARAG_KB_MARINE=box-id
ARAG_KB_MARINE_TOKEN="box-token"
ENTRA_CLIENT_SECRET=client-secret
SESSION_SECRET=session-secret
BINDING_KEY=test-only-key
PLATFORM_DOMAIN=research.example
CLOUDFLARE_ACCOUNT_ID=cloudflare-account-id
CLOUDFLARE_DOMAINS_TOKEN=domain-token
`)

  expect(values).toEqual({
    ARAG_ZONE: 'aws-ap-southeast-2-1',
    ARAG_KB_MARINE: 'box-id',
    ARAG_KB_MARINE_TOKEN: 'box-token',
    ENTRA_CLIENT_SECRET: 'client-secret',
    SESSION_SECRET: 'session-secret',
    BINDING_KEY: 'test-only-key',
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
    CLOUDFLARE_DOMAINS_TOKEN: 'domain-token',
  })
})

Deno.test('Worker secret allowlist includes an optional operator key without non-secret labels', () => {
  const fixture = btoa('operator-test-fixture-only-32bytes').replace(/=+$/g, '')
  expect(workerSecrets(`OPERATOR_API_KEY=${fixture}\nOPERATOR_ID=hosting-test`)).toEqual({
    OPERATOR_API_KEY: fixture,
  })
  expect(workerSecrets('OPERATOR_API_KEY=\nOPERATOR_ID=hosting-test')).toEqual({})
})
