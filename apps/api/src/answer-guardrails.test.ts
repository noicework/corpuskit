import { expect } from '@std/expect'
import { AnswerGuardrailsSchema, type AskEvent } from '@research-portal/core'
import {
  AnswerGuardrail,
  answerLength,
  guardAgentAnswer,
  guardedAskWriter,
  matchesPolicyPhrase,
  withPortalAnswerPolicy,
} from './answer-guardrails.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { withPortalInstructions } from './portal-instructions.ts'
import type { AskOptions, ComposePassage } from '../../../packages/retrieval/src/provider.ts'
import type { TenantConfig } from '@research-portal/core'
import { TenantStore } from './tenants.ts'
import { effectiveAskInsights } from './stores.ts'
import { openLocalRbac } from './rbac-local.ts'
import { localOwnedStores } from './local-owned-stores.ts'

const json = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('policy matching is literal, normalised, bounded for Latin words and supports Japanese', () => {
  expect(matchesPolicyPhrase('ＣＡＴ   care?', ['cat care'])).toBe(true)
  expect(matchesPolicyPhrase('concatenate and catch', ['cat'])).toBe(false)
  expect(matchesPolicyPhrase('Cats', ['cat'])).toBe(false)
  expect(matchesPolicyPhrase('cat\u200b care', ['cat care'])).toBe(true)
  expect(matchesPolicyPhrase('東京の政治について', ['政治'])).toBe(true)
  expect(matchesPolicyPhrase('a.b', ['a.b'])).toBe(true)
  expect(matchesPolicyPhrase('axb', ['a.b'])).toBe(false)
  expect(matchesPolicyPhrase('anything', [''])).toBe(false)
})

Deno.test('length cap counts Unicode characters, withholds whole and exempts policy messages', () => {
  const actions: string[] = []
  const policy = new AnswerGuardrail({
    guardrails: AnswerGuardrailsSchema.parse({ maxAnswerLength: 100 }),
  }, (a) => actions.push(a))
  expect(answerLength('🌱'.repeat(100))).toBe(100)
  expect(policy.answer('🌱'.repeat(100))).toBeNull()
  expect(policy.answer('🌱'.repeat(101))).toContain('withheld')
  expect(actions).toEqual(['length-withheld'])
  expect(AnswerGuardrailsSchema.safeParse({ maxAnswerLength: 99 }).success).toBe(false)
  expect(AnswerGuardrailsSchema.safeParse({ maxAnswerLength: 20001 }).success).toBe(false)
})

Deno.test('stream check never releases rejected chunks, including a term split across chunks', async () => {
  const actions: string[] = [], sent: unknown[] = []
  const policy = new AnswerGuardrail({
    guardrails: AnswerGuardrailsSchema.parse({
      blockedTerms: ['secret code'],
      withheldMessage: 'Please contact the team.',
      contactLine: 'help@example.test',
    }),
  }, (a) => actions.push(a))
  const writer = guardedAskWriter(policy, async (event) => {
    sent.push(event)
  })
  await writer.send({ type: 'delta', text: 'A secret ' })
  await writer.send({ type: 'delta', text: 'code is present.' })
  expect(sent).toEqual([])
  await writer.send({ type: 'done', text: 'A secret code is present.', refused: false })
  await writer.finish()
  expect(JSON.stringify(sent)).not.toContain('secret code')
  expect(sent).toEqual([
    { type: 'delta', text: 'Please contact the team.\n\nhelp@example.test' },
    { type: 'done', text: 'Please contact the team.\n\nhelp@example.test', refused: true },
  ])
  expect(actions).toEqual(['answer-withheld'])
})

Deno.test('buffered answers release only final verified text and never release incomplete output', async () => {
  const actions: string[] = [], sent: unknown[] = []
  const policy = new AnswerGuardrail({
    guardrails: AnswerGuardrailsSchema.parse({ maxAnswerLength: 100 }),
  }, (a) => actions.push(a))
  const writer = guardedAskWriter(policy, async (event) => {
    sent.push(event)
  })
  await writer.send({ type: 'delta', text: 'Unverified preliminary wording.' })
  await writer.send({ type: 'done', refused: false, text: 'Verified wording. [1]' })
  await writer.finish()
  expect(sent).toEqual([
    { type: 'delta', text: 'Verified wording. [1]' },
    { type: 'done', refused: false, text: 'Verified wording. [1]' },
  ])
  sent.length = 0
  const incomplete = guardedAskWriter(policy, async (event) => {
    sent.push(event)
  })
  await incomplete.send({ type: 'delta', text: 'Partial words' })
  await incomplete.finish()
  expect(JSON.stringify(sent)).not.toContain('Partial words')
  expect(actions).toEqual([])
})

Deno.test('local configuration survives restart, stays private and erases with its portal', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'answer-policy-local-' })
  const env = { TENANTS_PATH: `${directory}/tenants.json`, SHOWCASE_PORTALS: 'marine,grains' }
  try {
    const first = new TenantStore(env)
    const portal = first.add({ name: 'Soil Research Hub' })
    const settings = {
      ask: 'Explain specialist terms.',
      guardrails: AnswerGuardrailsSchema.parse({ blockedTerms: ['private phrase'] }),
    }
    first.patch(portal.slug, { prompts: settings })
    const second = new TenantStore(env)
    expect(second.promptsFor(portal.slug)).toEqual(settings)
    expect(second.promptsFor('marine')).toEqual({})
    expect(JSON.stringify(second.get(portal.slug))).not.toContain('private phrase')
    second.remove(portal.slug)
    second.erase(portal.slug)
    expect(Deno.readTextFileSync(env.TENANTS_PATH)).not.toContain('private phrase')
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('local configuration audit snapshots share the file mutation rollback boundary', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'policy-audit-local-' })
  const env = {
    DATA_DIR: directory,
    TENANTS_PATH: `${directory}/tenants.json`,
    SHOWCASE_PORTALS: 'marine',
  }
  const { database, rbac } = openLocalRbac(env)
  try {
    const stores = localOwnedStores(directory, database, rbac.audit, env)
    const input = {
      requestId: 'policy-local',
      actor: { kind: 'system' as const },
      action: 'tenant.behaviour.update' as const,
      scope: { kind: 'portal' as const, slug: 'marine' },
      target: { kind: 'tenant', id: 'marine' },
      detail: {
        permission: 'behaviour.write',
        previousPrompts: '{}',
        prompts: JSON.stringify({ ask: 'Use plain language.' }),
      },
    }
    await stores.localMutations.run(
      input,
      new AbortController().signal,
      () => stores.tenants!.patch('marine', { prompts: { ask: 'Use plain language.' } }),
    )
    expect(rbac.audit.read({ scope: input.scope, action: 'tenant.behaviour.update' })).toHaveLength(
      1,
    )
    database.exec(
      "CREATE TRIGGER reject_policy_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'tenant.behaviour.update' AND NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'Policy audit failed'); END",
    )
    await expect(
      stores.localMutations.run(
        input,
        new AbortController().signal,
        () => stores.tenants!.patch('marine', { prompts: { ask: 'Must roll back.' } }),
      ),
    ).rejects.toThrow()
    expect(stores.tenants!.promptsFor('marine').ask).toBe('Use plain language.')
    expect(new TenantStore(env).promptsFor('marine').ask).toBe('Use plain language.')
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('policy disposition changes the ask total without double counting or storing answer text', () => {
  const row = {
    ts: new Date().toISOString(),
    question: 'Stock health?',
    answered: true,
    citations: 1,
    durationSec: null,
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
    policyRequestId: 'request-one',
  }
  const actions = {
    ...row,
    answered: false,
    guardrailOnly: true,
    guardrailAction: 'answer-withheld' as const,
  }
  expect(effectiveAskInsights([row, actions])).toEqual([{ ...row, answered: false, citations: 0 }])
})

Deno.test('MCP and estate provider boundary applies the same preflight and answer checks', async () => {
  const provider = new DoubleProvider(), actions: string[] = []
  const policy = new AnswerGuardrail({
    guardrails: AnswerGuardrailsSchema.parse({
      outOfScope: ['politics'],
      blockedTerms: ['heatwaves'],
    }),
  }, (a) => actions.push(a))
  const wrapped = withPortalAnswerPolicy(provider, () => policy)
  const f = createEnforcementFixture()
  try {
    const portal = f.stores.tenants.get('a')!
    for (const query of ['Politics', 'Stock health?']) {
      const events = []
      for await (const event of wrapped.ask(portal, query)) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'done', refused: true })
      expect(JSON.stringify(events)).not.toContain('heatwaves')
    }
    expect(actions).toEqual(['question-refused', 'answer-withheld'])
    const events = []
    for await (
      const event of guardAgentAnswer(policy, 'Politics', () => {
        throw new Error('Must not generate')
      })
    ) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  } finally {
    f.close()
  }
})

class InstructionsDouble extends DoubleProvider {
  calls: { slug: string; instructions?: string }[] = []
  override async *ask(
    tenant: TenantConfig,
    query: string,
    options?: AskOptions,
  ): AsyncIterable<AskEvent> {
    this.calls.push({ slug: tenant.slug, instructions: options?.answerInstructions })
    yield* super.ask(tenant, query)
  }
  override compose(
    tenant: TenantConfig,
    _query: string,
    _passages: readonly ComposePassage[],
    options?: { answerInstructions?: string },
  ): Promise<string> {
    this.calls.push({ slug: tenant.slug, instructions: options?.answerInstructions })
    return Promise.resolve('Grounded answer. [1]')
  }
}

for (const adapter of ['local', 'durable'] as const) {
  if (adapter === 'durable') {
    Deno.test(`${adapter}: configuration is private, audited, permission checked, isolated and lifecycle guarded`, async () => {
      const f = createEnforcementFixture({}, adapter)
      try {
        const admin = f.sessionFor('portal-admin', 'a')
        const path = '/api/admin/t/a/prompts'
        const settings = {
          ask: 'Use plain language.',
          images: true,
          guardrails: AnswerGuardrailsSchema.parse({
            outOfScope: ['politics'],
            blockedTerms: ['restricted phrase'],
            contactLine: 'Team: help@example.test',
            maxAnswerLength: 400,
          }),
        }
        expect((await f.requestAs(admin, path, json(settings))).status).toBe(200)
        expect(f.stores.tenants!.promptsFor('a')).toEqual(settings)
        expect(f.stores.tenants!.promptsFor('b')).toEqual({})
        const saved = f.rbac.audit.read({
          scope: { kind: 'portal', slug: 'a' },
          action: 'tenant.behaviour.update',
        }).find((e) => e.outcome === 'success')!
        const detail = JSON.parse(saved.detail_json)
        expect(JSON.parse(detail.previousPrompts)).toEqual({})
        expect(JSON.parse(detail.prompts)).toEqual(settings)
        const large = {
          ...settings,
          ask: 'x'.repeat(2000),
          guardrails: {
            ...settings.guardrails,
            blockedTerms: Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(120, 'x')),
          },
        }
        expect((await f.requestAs(admin, path, json(large))).status).toBe(200)
        expect((await f.requestAs(admin, path, json(settings))).status).toBe(200)
        if (adapter === 'durable') {
          f.database.exec(
            "CREATE TRIGGER reject_policy_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'tenant.behaviour.update' AND NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'Policy audit failed'); END",
          )
          const failed = await f.requestAs(admin, path, json({ ask: 'Must roll back.' }))
          expect(failed.status).toBe(500)
          expect(f.stores.tenants!.promptsFor('a')).toEqual(settings)
          f.database.exec('DROP TRIGGER reject_policy_completion')
        }
        expect(JSON.stringify(f.stores.tenants.get('a'))).not.toContain('Use plain language.')
        expect(
          (await f.requestAs(f.sessionFor('curator', 'a'), path, json({ ask: 'Denied' }))).status,
        ).toBe(403)
        expect(
          (await f.requestAs(admin, path.replace('/a/', '/b/'), json({ ask: 'Denied' }))).status,
        )
          .toBe(403)
        expect((await f.requestAs(admin, path, json({ ask: 'x'.repeat(2001) }))).status).toBe(400)
        expect(
          (await f.requestAs(
            admin,
            path,
            json({ guardrails: { blockedTerms: ['x'.repeat(121)] } }),
          ))
            .status,
        ).toBe(400)

        const provider = new InstructionsDouble()
        const wrapped = withPortalInstructions(
          provider,
          (slug) => f.stores.tenants!.promptsFor(slug),
        )
        for (const slug of ['a', 'b']) {
          const tenant = f.stores.tenants.get(slug)!
          for await (const _event of wrapped.ask(tenant, 'Stock health?')) { /* Collect. */ }
          await wrapped.compose!(tenant, 'Stock health?', [])
        }
        expect(provider.calls).toEqual([
          { slug: 'a', instructions: 'Use plain language.' },
          { slug: 'a', instructions: 'Use plain language.' },
          { slug: 'b', instructions: undefined },
          { slug: 'b', instructions: undefined },
        ])
        f.stores.lifecycle.set('a', { status: 'read_only', limits: null })
        expect((await f.requestAs(admin, path, json({ ask: '' }))).status).toBe(423)
        f.stores.lifecycle.set('a', { status: 'active', limits: null })
        expect(
          (await f.requestAs(
            admin,
            path,
            json({ ask: '', guardrails: AnswerGuardrailsSchema.parse({}) }),
          )).status,
        ).toBe(200)
        expect(f.stores.tenants!.promptsFor('a').ask).toBeUndefined()
        expect(f.stores.tenants!.promptsFor('a').images).toBe(true)
      } finally {
        f.close()
      }
    })
  }
  Deno.test(`${adapter}: refused question never generates; policy actions count only in its portal`, async () => {
    const provider = new InstructionsDouble()
    const f = createEnforcementFixture({ provider }, adapter)
    try {
      f.stores.tenants!.patch('a', {
        prompts: {
          guardrails: AnswerGuardrailsSchema.parse({
            outOfScope: ['politics'],
            refusalMessage: 'Please ask about research.',
            contactLine: 'Team: help@example.test',
          }),
        },
      })
      const response = await f.requestAs(f.sessionFor('viewer', 'a'), '/api/t/a/ask', {
        ...json({ query: 'Tell me about politics' }),
        method: 'POST',
      })
      const events = await response.text()
      expect(events).toContain('Please ask about research.')
      expect(events).toContain('help@example.test')
      expect(provider.calls).toEqual([])
      expect(f.stores.insights.summary('a').guardrails?.questionsRefused).toBe(1)
      expect(f.stores.insights.summary('b').guardrails?.questionsRefused).toBe(0)
    } finally {
      f.close()
    }
  })
}
