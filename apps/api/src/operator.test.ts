import { expect } from '@std/expect'
import { authenticateOperator, configuredOperatorId, operatorEnvelope } from './operator.ts'
import { signPrincipal, verifyPrincipal } from './principal.ts'

const key = btoa('operator-test-fixture-only-32bytes').replace(/=+$/g, '')
const env = { OPERATOR_API_KEY: key }
const request = (authorization: string, headers: HeadersInit = {}) =>
  new Request('https://portal.test/api/admin/tenants', {
    headers: { authorization, ...headers },
  })

Deno.test('operator authenticates only the distinct scheme with a configured canonical key', async () => {
  expect(await authenticateOperator(request(`Operator ${key}`), env))
    .toEqual({ kind: 'verified', id: 'operator' })
  expect(await authenticateOperator(request(`operator ${key}`), { ...env, OPERATOR_ID: 'host-1' }))
    .toEqual({ kind: 'verified', id: 'host-1' })
  expect(await authenticateOperator(new Request('https://portal.test/'), env))
    .toEqual({ kind: 'absent' })
  expect(await authenticateOperator(request('Bearer ck_other'), env)).toEqual({ kind: 'absent' })
  for (
    const header of [
      `Operator ${key.slice(0, -1)}A`,
      'Operator',
      'Operator wrong',
      `Operator ${key} extra`,
      `Operator ${key}=`,
      `Bearer ${key}`,
    ]
  ) {
    expect(await authenticateOperator(request(header), env)).toEqual({ kind: 'rejected' })
  }
  expect(
    await authenticateOperator(request(`Operator ${key}`, { 'x-admin-passcode': 'fixture' }), env),
  )
    .toEqual({ kind: 'rejected' })
})

Deno.test('operator configuration rejects absent, short, malformed keys and unsafe actor identifiers', async () => {
  for (
    const configuredKey of [
      undefined,
      '',
      'x'.repeat(31),
      `${key}=`,
      'a'.repeat(45),
      '!'.repeat(43),
    ]
  ) {
    const config = { OPERATOR_API_KEY: configuredKey }
    expect(configuredOperatorId(config)).toBeUndefined()
    expect(await authenticateOperator(request(`Operator ${key}`), config))
      .toEqual({ kind: 'rejected' })
  }
  for (const id of ['', 'a b', '\n', 'x'.repeat(152), 'https://invalid']) {
    const config = { ...env, OPERATOR_ID: id }
    expect(configuredOperatorId(config)).toBeUndefined()
    expect(await authenticateOperator(request(`Operator ${key}`), config))
      .toEqual({ kind: 'rejected' })
  }
  const longer = btoa('fixture'.repeat(10)).replace(/=+$/g, '')
  expect(await authenticateOperator(request(`Operator ${longer}`), { OPERATOR_API_KEY: longer }))
    .toEqual({ kind: 'verified', id: 'operator' })
})

Deno.test('operator envelope requires its configured actor, audience, signature and freshness', async () => {
  const secret = 'principal-signing-fixture-32bytes-long'
  const now = 1_800_000_000_000
  const payload = operatorEnvelope('host-1', 'custom-portal-worker', now)
  const header = await signPrincipal(payload, secret)
  const config = {
    sessionSecret: secret,
    audience: payload.aud,
    tenantId: '',
    operatorId: 'host-1',
  }
  expect(await verifyPrincipal(header, config, now)).toEqual({
    kind: 'verified',
    envelope: payload,
  })
  for (
    const change of [
      { operatorId: undefined },
      { operatorId: 'another-host' },
      { audience: 'other-worker' },
      { sessionSecret: secret + 'wrong' },
    ]
  ) {
    expect(await verifyPrincipal(header, { ...config, ...change }, now))
      .toMatchObject({ kind: 'rejected' })
  }
  for (const offset of [60_000, -30_000]) {
    expect(await verifyPrincipal(header, config, now + offset)).toMatchObject({ kind: 'verified' })
  }
  for (const offset of [60_001, -30_001]) {
    expect(await verifyPrincipal(header, config, now + offset)).toMatchObject({ kind: 'rejected' })
  }
  const changed = btoa(JSON.stringify({ ...payload, id: 'other' })).replace(/=+$/g, '')
  expect(await verifyPrincipal(`${changed}.${header.split('.')[1]}`, config, now))
    .toMatchObject({ kind: 'rejected' })
  // Operator authority contains no roles or session identity that could grant owner access.
  for (const extra of [{ roles: ['CorpusKit.Owner'] }, { tid: 'tenant-1' }, { key }]) {
    await expect(signPrincipal({ ...payload, ...extra }, secret)).rejects.toThrow()
  }
  expect(JSON.stringify(payload)).not.toContain(key)
})
