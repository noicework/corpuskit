import { expect } from '@std/expect'
import {
  AuthorisationPrincipalSchema,
  OperatorIdSchema,
  PrincipalSchema,
} from '@research-portal/core'
import {
  authenticateOperator,
  configuredOperatorId,
  operatorConfigurationWarning,
  operatorEnvelope,
  operatorRequestContext,
} from './operator.ts'
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

Deno.test('operator identifiers use one schema for configuration, envelopes and the core', async () => {
  const secret = 'principal-signing-fixture-32bytes-long'
  for (
    const id of [
      'operator',
      'host-1',
      'svc@example.org/automation',
      'region:host_2.a',
      'a'.repeat(151),
      '',
      'a b',
      '-leading',
      'x'.repeat(152),
      'https://invalid',
      'host\n',
    ]
  ) {
    const accepted = OperatorIdSchema.safeParse(id).success
    expect(configuredOperatorId({ ...env, OPERATOR_ID: id }) === id, id).toBe(accepted)
    expect(PrincipalSchema.safeParse({ kind: 'operator', id }).success, id).toBe(accepted)
    const signed = signPrincipal(operatorEnvelope(id, 'corpuskit'), secret)
    if (accepted) await expect(signed).resolves.toBeDefined()
    else await expect(signed).rejects.toThrow()
  }
})

Deno.test('operator configuration warning names the unusable setting and never its value', () => {
  expect(operatorConfigurationWarning({})).toBeUndefined()
  expect(operatorConfigurationWarning({ OPERATOR_API_KEY: '' })).toBeUndefined()
  expect(operatorConfigurationWarning(env)).toBeUndefined()
  expect(operatorConfigurationWarning({ ...env, OPERATOR_ID: 'host-1' })).toBeUndefined()
  for (const configuredKey of [`${key}=`, 'x'.repeat(31), '!'.repeat(43), ` ${key}`]) {
    const warning = operatorConfigurationWarning({ OPERATOR_API_KEY: configuredKey })
    expect(warning).toContain('OPERATOR_API_KEY')
    expect(warning).toContain('disabled')
    expect(warning).not.toContain(configuredKey.trim())
  }
  for (const id of ['hosting automation', 'https://invalid', 'x'.repeat(152)]) {
    const warning = operatorConfigurationWarning({ ...env, OPERATOR_ID: id })
    expect(warning).toContain('OPERATOR_ID')
    expect(warning).not.toContain(id)
    expect(warning).not.toContain(key)
  }
  // An identifier without a key leaves the scheme unconfigured rather than misconfigured.
  expect(operatorConfigurationWarning({ OPERATOR_ID: 'a b' })).toBeUndefined()
})

Deno.test('operator request context is platform-admin only with no session, user or group authority', () => {
  const context = operatorRequestContext('host-1', 'request-1', '192.0.2.1')
  expect(context).toEqual({
    requestId: 'request-1',
    operator: { id: 'host-1' },
    session: null,
    clientIp: '192.0.2.1',
    effectiveRoles: { platformRole: 'platform-admin', portalRoles: [] },
    provenance: [],
    groupCapability: 'disabled',
    coarseAdminEligible: true,
    user: null,
  })
  expect(
    AuthorisationPrincipalSchema.safeParse({
      identity: { kind: 'operator', id: context.operator!.id },
      effectiveRoles: context.effectiveRoles,
    }).success,
  ).toBe(true)
})
