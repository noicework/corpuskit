import { expect } from '@std/expect'
import type { KgProposal } from '@research-portal/core'
import type { DurableStores } from '../../cloudflare/src/state.ts'
import { createEnforcementFixture, type EnforcementFixture } from './enforcement-fixture.ts'
import { declarationFor, DECLARATIONS } from './permissions.ts'
import {
  ERASED_RECORD_KINDS,
  erasureAuditDetail,
  operatorDeleteAfterDays,
  operatorDeleteWarning,
} from './portal-erasure.ts'
import { emptyErasedCounts } from './erased-records.ts'
import type { AuditEvent } from './audit.ts'
import type { ResearchOwner } from './research-owner.ts'

const DAY = 86_400_000
const SLUG = 'erasure-probe'

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const proposal: KgProposal = {
  rationale: 'Describe the research corpus.',
  entityTypes: [{ label: 'Species', description: 'Animal' }],
  resourceLabels: [{ label: 'Research', description: 'Research' }],
  chunkLabels: [{ label: 'Finding', description: 'Finding' }],
  examples: [],
}

const detach = {
  attach: (hostname: string) => Promise.resolve({ hostname, created: true }),
  detach: (hostname: string) => Promise.resolve({ hostname, removed: true }),
}

function fixture(operatorDeleteAfterDays: number | null = 30) {
  return createEnforcementFixture({ operatorDeleteAfterDays, domainProvisioner: detach })
}

async function createPortal(f: EnforcementFixture, name = 'Erasure Probe'): Promise<string> {
  const response = await f.requestAs(f.sessionFor('owner'), '/api/admin/tenants', {
    ...json('POST', { name }),
  })
  expect(response.status).toBe(200)
  return (await response.json()).slug
}

/** Every row of every table, by table, in a stable order. */
function tables(f: EnforcementFixture): Map<string, string[]> {
  const names = f.database.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map((row) => row.name)
  return new Map(names.map((name) => [
    name,
    f.database.all<Record<string, unknown>>(`SELECT * FROM ${name}`).map((row) =>
      JSON.stringify(
        row,
        (_key, value) => value instanceof Uint8Array ? `bytes:${[...value].join(',')}` : value,
      )
    ).sort(),
  ]))
}

const researcher: ResearchOwner = { kind: 'user', tenantId: 'tenant-1', oid: 'researcher-1' }
const anonymous: ResearchOwner = { kind: 'anonymous', clientId: 'visitor-1' }

/**
 * Writes a record for the portal into every Durable Object store. Typed over every store the
 * Durable Object has, so a new store cannot be added without deciding how to populate it here,
 * and the erasure tests below then prove that erasure removes whatever it wrote.
 */
const POPULATE: Record<keyof DurableStores, (f: EnforcementFixture, slug: string) => unknown> = {
  lifecycle: (f, slug) => {
    f.stores.lifecycle.set(slug, { status: 'suspended', limits: { asksPerDay: 5 } }, f.now())
    f.stores.lifecycle.consumeAsk(slug, 'UTC', f.now())
    f.stores.lifecycle.reserveAdd(slug, { observed: 0, bytes: 10 })
    f.stores.lifecycle.touch(slug, f.now())
  },
  // Request scaffolding and access control: populated through the routes below.
  localMutations: () => undefined,
  erasureTransaction: () => undefined,
  rbac: () => undefined,
  audit: () => undefined,
  assignments: (f, slug) => {
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    for (
      const input of [
        { subjectKind: 'pending-email', subjectId: 'reader@first-customer.example' },
        { subjectKind: 'group', subjectId: 'first-customer-readers' },
        { subjectKind: 'active-oid', subjectId: 'researcher-1' },
      ] as const
    ) {
      const created = service.create(
        { ...input, scope: { kind: 'portal', slug }, role: 'viewer' },
        {
          requestId: 'fixture-member',
          actor: { kind: 'system' },
        },
      )
      if (!created.ok) throw new Error('Fixture member failed')
    }
    // A member recorded under an earlier directory tenant, which deletion does not revoke.
    const earlier = f.rbac.assignmentService('earlier-tenant', f.audience).create({
      subjectKind: 'active-oid',
      subjectId: 'earlier-member',
      scope: { kind: 'portal', slug },
      role: 'viewer',
    }, { requestId: 'fixture-member', actor: { kind: 'system' } })
    if (!earlier.ok) throw new Error('Fixture member failed')
    // A paged audit query of the portal whose filter names a member.
    f.database.exec(
      'INSERT INTO audit_query_snapshots (id,watermark,scope_json,filters_json,created_at,expires_at) VALUES (?,?,?,?,?,?)',
      crypto.randomUUID(),
      0,
      JSON.stringify({ kind: 'portal', slug }),
      JSON.stringify({ actorId: 'researcher-1' }),
      f.now(),
      f.now() + 15 * 60_000,
    )
  },
  locks: () => undefined, // Break-glass lockouts are kept per client address, not per portal.
  bindings: (f, slug) =>
    f.stores.bindings.set(slug, {
      baseUrl: 'https://example.test/kb/probe',
      token: 'probe-service-account-token',
      kbId: 'probe',
    }),
  tenants: (f, slug) => {
    f.stores.tenants.patch(slug, { searchPlaceholder: 'Search the probe' })
    f.stores.tenants.setAlias(slug, 'research.first-customer.example', true, 5)
  },
  insights: (f, slug) =>
    f.stores.insights.record(slug, {
      ts: new Date(f.now()).toISOString(),
      question: 'What did reader@first-customer.example ask?',
      answered: true,
      citations: 1,
      durationSec: 1,
      answerRelevance: 4,
      groundedness: 4,
      contextRelevance: 4,
    }),
  sessions: (f, slug) => {
    for (const owner of [researcher, anonymous]) {
      f.stores.sessions.put(slug, owner, {
        id: 'session-1',
        title: 'Private history',
        updatedAt: '2026-09-12',
        messages: [{ role: 'user', text: 'private question' }],
      })
    }
    // A record from before owner-scoped storage.
    f.state.put(`session:${slug}:visitor-1:legacy-1`, {
      id: 'legacy-1',
      title: 'Old history',
      updatedAt: '2026-01-01',
      messages: [],
    })
  },
  watches: (f, slug) => {
    f.stores.watches.add(slug, researcher, 'abalone decline')
    f.state.put(`watches:${slug}`, [])
  },
  sources: (f, slug) => f.stores.sources.add(slug, 'https://first-customer.example/news', true),
  investigations: (f, slug) => {
    const investigation = f.stores.investigations.create(slug, researcher, { name: 'Private' })
    f.stores.investigations.addEvidence(slug, researcher, investigation.id, {
      resourceId: 'res-1',
      resourceTitle: 'Evidence',
      passage: 'A saved passage',
      score: null,
      question: '',
      verdict: null,
      aiRelevance: null,
      note: 'reader@first-customer.example',
      tags: [],
    })
    f.state.put(`investigation:${slug}:visitor-1:legacy-2`, { id: 'legacy-2' })
  },
  suggestions: (f, slug) =>
    f.stores.suggestions.replacePending(slug, [{
      id: 'suggestion-1',
      kind: 'labelset',
      title: 'Species',
      detail: 'Research taxonomy',
      status: 'pending',
      createdAt: new Date(f.now()).toISOString(),
      labelset: { id: 'species', title: 'Species', paragraphs: false, labels: ['Abalone'] },
    }]),
  enrichments: (f, slug) => {
    f.stores.enrichments.put(slug, 'res-1', {
      schemaId: 'suggested-questions',
      generatedAt: new Date(f.now()).toISOString(),
      data: { questions: ['Private question?'] },
    })
    // A record from before the enrichment table.
    f.state.put(`enrichments:${slug}`, { research: {} })
  },
  kgProposals: (f, slug) => f.stores.kgProposals.set(slug, proposal),
  branding: (f, slug) => {
    for (const kind of ['logo', 'font-body'] as const) {
      f.stores.branding.put(slug, kind, {
        bytes: new TextEncoder().encode(`${kind} bytes`),
        contentType: kind === 'logo' ? 'image/png' : 'font/woff2',
        version: 'v1',
      })
    }
  },
  mcpKeys: () => undefined, // Issued through the route below, as a portal administrator does.
  routing: (f, slug) =>
    f.stores.routing.record(slug, {
      ts: new Date(f.now()).toISOString(),
      questionHash: 'abcd1234',
      questionLength: 12,
      intent: 'general',
      stage: 'rule',
      confidence: 1,
      rationale: 'fixture',
      configuration: 'portal-ask',
      latencyMs: 1,
    }),
}

/** Fill every store for the portal, directly and through the routes its members use. */
async function populate(f: EnforcementFixture, slug: string): Promise<void> {
  for (const write of Object.values(POPULATE)) await write(f, slug)
  const owner = f.sessionFor('owner')
  const member = await f.requestAs(
    owner,
    `/api/admin/t/${slug}/members`,
    json('POST', {
      subjectKind: 'pending-email',
      subjectId: 'departed-admin@first-customer.example',
      role: 'portal-admin',
    }),
  )
  expect(member.status).toBe(201)
  const key = await f.requestAs(
    owner,
    `/api/t/${slug}/mcp/keys`,
    json('POST', { label: 'First customer client', role: 'viewer' }),
  )
  expect(key.status).toBe(201)
}

/** State that erasure must leave exactly as it was, keyed by table. */
function withoutAudit(snapshot: Map<string, string[]>): Map<string, string[]> {
  const kept = new Map(snapshot)
  for (const table of ['audit_events', 'audit_event_order', 'sqlite_sequence', 'state']) {
    kept.delete(table)
  }
  return kept
}

/**
 * The state rows by key. A shared container left empty (`bindings`, `kg-proposals`) holds nothing
 * and counts as absent.
 */
function stateRows(snapshot: Map<string, string[]>): Map<string, unknown> {
  return new Map(
    snapshot.get('state')!.map((row) => {
      const { key, value } = JSON.parse(row) as { key: string; value: string }
      return [key, JSON.parse(value)] as const
    }).filter(([, value]) => JSON.stringify(value) !== '{}'),
  )
}

Deno.test('erasing a deleted portal removes every record it left and keeps only the tombstone', async () => {
  const f = fixture()
  try {
    expect(await createPortal(f)).toBe(SLUG)
    const before = tables(f)
    await populate(f, SLUG)

    const owner = f.sessionFor('owner')
    const deleted = await f.requestAs(owner, `/api/admin/tenants/${SLUG}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    // Records an older release could have left after deletion, so every kind is exercised.
    const raw = f.state.get<Record<string, unknown>>('tenants', {})
    f.state.put('tenants', {
      ...raw,
      overrides: { ...raw.overrides as object, [SLUG]: { searchPlaceholder: 'Left over' } },
      disabled: [...raw.disabled as string[], SLUG],
      aliases: [{
        slug: SLUG,
        hostname: 'left-over.first-customer.example',
        primary: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    await f.stores.bindings.set(SLUG, {
      baseUrl: 'https://example.test/kb/left-over',
      token: 'left-over-token',
      kbId: 'left-over',
    })
    f.stores.lifecycle.set(SLUG, { status: 'suspended', limits: null }, f.now())

    const platform = f.sessionFor('platform-admin')
    const erased = await f.requestAs(platform, `/api/admin/tenants/${SLUG}/erase`, {
      method: 'POST',
    })
    expect(erased.status).toBe(200)
    expect(erased.headers.get('cache-control')).toBe('private, no-store')
    const body = await erased.json()
    expect(body.ok).toBe(true)
    expect(body.slug).toBe(SLUG)
    expect(Object.keys(body.erased)).toEqual([...ERASED_RECORD_KINDS])
    for (const kind of ERASED_RECORD_KINDS) {
      expect(body.erased[kind], kind).toBeGreaterThan(0)
    }
    expect(body.total).toBe(
      ERASED_RECORD_KINDS.reduce((sum, kind) => sum + body.erased[kind], 0),
    )

    const after = tables(f)
    // Every table but the audit log and the registry row is exactly as before the portal held data.
    expect(withoutAudit(after)).toEqual(withoutAudit(before))
    const beforeState = stateRows(before)
    const afterState = stateRows(after)
    const registry = structuredClone(beforeState.get('tenants')) as {
      custom: Record<string, unknown>
      overrides: Record<string, unknown>
      retired?: string[]
    }
    // The portal's record and its hostname override go; its slug is retired.
    delete registry.custom[SLUG]
    delete registry.overrides[SLUG]
    registry.retired = [...registry.retired ?? [], SLUG]
    expect(afterState.get('tenants')).toEqual(registry)
    beforeState.delete('tenants')
    afterState.delete('tenants')
    expect(afterState).toEqual(beforeState)

    // The audit log keeps only the erasure request's own records for the portal.
    const requestId = erased.headers.get('x-request-id')!
    const keyed = f.database.all<AuditEvent>(
      `SELECT * FROM audit_events WHERE (scope_kind = 'portal' AND scope_slug = ?)
        OR (scope_kind = 'platform' AND target_id = ?)`,
      SLUG,
      SLUG,
    )
    expect(keyed.length).toBeGreaterThan(0)
    expect(keyed.every((event) => event.request_id === requestId)).toBe(true)
    expect(JSON.stringify(keyed)).not.toContain('first-customer.example')
    const line = keyed.find((event) => event.action === 'portal.erase')!
    expect(line).toMatchObject({
      actor_kind: 'user',
      actor_id: platform.oid,
      scope_kind: 'platform',
      target_kind: 'portal',
      target_id: SLUG,
      outcome: 'success',
    })
    expect(JSON.parse(line.detail_json)).toEqual(
      erasureAuditDetail(body.erased, body.total),
    )
    // No ordering row outlives its event, and every event keeps its ordering row.
    expect(
      f.database.all(
        'SELECT event_id FROM audit_event_order WHERE event_id NOT IN (SELECT id FROM audit_events)',
      ),
    ).toEqual([])
    expect(
      f.database.all(
        'SELECT id FROM audit_events WHERE id NOT IN (SELECT event_id FROM audit_event_order)',
      ),
    ).toEqual([])
    expect(f.rbac.audit.read({ scope: { kind: 'portal', slug: SLUG }, limit: 1000 })).toEqual([])

    // The in-memory binding cache let go of the record too.
    expect(f.stores.bindings.status(SLUG).status).toBe('none')
    // The tombstone: the slug stays retired and is never given to a new portal.
    expect(f.stores.tenants.isRetired(SLUG)).toBe(true)
    expect(await createPortal(f)).toBe(`${SLUG}-2`)
  } finally {
    f.close()
  }
})

Deno.test('erasure is idempotent: a repeat erases nothing more and records its own line', async () => {
  const f = fixture()
  try {
    await createPortal(f)
    await populate(f, SLUG)
    const owner = f.sessionFor('owner')
    expect((await f.requestAs(owner, `/api/admin/tenants/${SLUG}`, { method: 'DELETE' })).status)
      .toBe(200)
    const platform = f.sessionFor('platform-admin')
    const first = await f.requestAs(platform, `/api/admin/tenants/${SLUG}/erase`, json('POST', {}))
    expect(first.status).toBe(200)
    expect((await first.json()).total).toBeGreaterThan(0)
    const settled = withoutAudit(tables(f))
    const settledState = stateRows(tables(f))

    const again = await f.requestAs(owner, `/api/admin/tenants/${SLUG}/erase`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({
      ok: true,
      slug: SLUG,
      erased: emptyErasedCounts(),
      total: 0,
    })
    expect(withoutAudit(tables(f))).toEqual(settled)
    expect(stateRows(tables(f))).toEqual(settledState)
    // Both erasures stay on record; nothing else about the portal does.
    const lines = f.database.all<AuditEvent>(
      "SELECT * FROM audit_events WHERE action = 'portal.erase' AND target_id = ?",
      SLUG,
    )
    expect(lines.map((event) => event.request_id).sort()).toEqual(
      [first.headers.get('x-request-id'), again.headers.get('x-request-id')].sort(),
    )
    expect(
      f.database.all<AuditEvent>(
        `SELECT * FROM audit_events WHERE ((scope_kind = 'portal' AND scope_slug = ?)
          OR (scope_kind = 'platform' AND target_id = ?)) AND request_id NOT IN (?, ?)`,
        SLUG,
        SLUG,
        first.headers.get('x-request-id')!,
        again.headers.get('x-request-id')!,
      ),
    ).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('erasure refuses a live portal, a seeded portal and a slug that never held a portal', async () => {
  const f = fixture()
  try {
    await createPortal(f)
    await populate(f, SLUG)
    const platform = f.sessionFor('platform-admin')
    const before = withoutAudit(tables(f))
    const beforeState = stateRows(tables(f))
    for (
      const [path, init, status, error] of [
        [`/api/admin/tenants/${SLUG}/erase`, { method: 'POST' }, 409, 'portal_active'],
        ['/api/admin/tenants/a/erase', { method: 'POST' }, 409, 'portal_active'],
        ['/api/admin/tenants/marine/erase', { method: 'POST' }, 409, 'portal_active'],
        ['/api/admin/tenants/never-a-portal/erase', { method: 'POST' }, 404, 'unknown_tenant'],
        ['/api/admin/tenants/not%20a%20slug/erase', { method: 'POST' }, 404, 'unknown_tenant'],
        [`/api/admin/tenants/${SLUG}/erase`, json('POST', { all: true }), 400, 'invalid_request'],
      ] as const
    ) {
      const response = await f.requestAs(platform, path, init)
      expect([path, response.status]).toEqual([path, status])
      expect(await response.json()).toEqual({ error })
      const refusal = f.rbac.audit.read({
        scope: { kind: 'platform' },
        requestId: response.headers.get('x-request-id')!,
        action: 'portal.erase',
      })
      expect(refusal).toHaveLength(1)
      expect(refusal[0]!.outcome).toBe('denied')
      expect(JSON.parse(refusal[0]!.detail_json)).toEqual({
        permission: 'portal.create',
        code: error,
      })
    }
    expect(withoutAudit(tables(f))).toEqual(before)
    expect(stateRows(tables(f))).toEqual(beforeState)
    // A portal role cannot erase, even a portal it once administered.
    const portalAdmin = f.sessionFor('portal-admin', 'a')
    const denied = await f.requestAs(portalAdmin, '/api/admin/tenants/a/erase', { method: 'POST' })
    expect(denied.status).toBe(403)
  } finally {
    f.close()
  }
})

Deno.test('operator deletion is off unless OPERATOR_DELETE_AFTER_DAYS is set', async () => {
  const f = fixture(null)
  try {
    await createPortal(f)
    f.stores.lifecycle.set(SLUG, { status: 'suspended', limits: null }, f.now() - 400 * DAY)
    const response = await f.requestAs(
      f.sessionFor('platform-admin'),
      `/api/admin/tenants/${SLUG}/delete-suspended`,
      { method: 'POST' },
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'operator_delete_disabled' })
    expect(f.stores.tenants.get(SLUG)).toBeDefined()
    const refusal = f.rbac.audit.read({
      scope: { kind: 'platform' },
      requestId: response.headers.get('x-request-id')!,
      action: 'portal.delete.suspended',
    })
    expect(refusal.map((event) => [event.outcome, JSON.parse(event.detail_json)])).toEqual([[
      'denied',
      { permission: 'portal.create', code: 'operator_delete_disabled', eraseRequested: false },
    ]])
  } finally {
    f.close()
  }
})

Deno.test('the operator delete waits for OPERATOR_DELETE_AFTER_DAYS of unbroken suspension', async () => {
  const f = fixture(30)
  try {
    await createPortal(f)
    const platform = f.sessionFor('platform-admin')
    const now = f.now()
    const iso = (time: number) => new Date(time).toISOString()
    const set = (status: 'active' | 'read_only' | 'suspended', at: number, limits = null) =>
      f.stores.lifecycle.set(SLUG, { status, limits }, at)
    const attempt = () =>
      f.requestAs(platform, `/api/admin/tenants/${SLUG}/delete-suspended`, { method: 'POST' })
    const refused = async (expected: Record<string, unknown>) => {
      const response = await attempt()
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'not_suspended_long_enough', ...expected })
      expect(f.stores.tenants.get(SLUG)).toBeDefined()
    }

    await refused({ status: 'active', suspendedSince: null, eligibleAt: null })
    set('read_only', now - 60 * DAY)
    await refused({ status: 'read_only', suspendedSince: null, eligibleAt: null })

    // Suspended long ago, then restored: the clock starts again at the latest suspension.
    set('suspended', now - 50 * DAY)
    set('active', now - 40 * DAY)
    set('suspended', now - 20 * DAY)
    // Changing the limits of a suspended portal keeps the time its suspension began.
    f.stores.lifecycle.set(SLUG, { status: 'suspended', limits: { asksPerDay: 0 } }, now - DAY)
    await refused({
      status: 'suspended',
      suspendedSince: iso(now - 20 * DAY),
      eligibleAt: iso(now + 10 * DAY),
    })
    const read = await f.requestAs(platform, `/api/admin/t/${SLUG}/lifecycle`)
    expect(await read.json()).toMatchObject({
      status: 'suspended',
      limits: { asksPerDay: 0 },
      suspendedSince: iso(now - 20 * DAY),
    })

    // One millisecond short of thirty days is refused; thirty days exactly is enough.
    set('active', now - 31 * DAY)
    set('suspended', now - 30 * DAY + 1)
    await refused({
      status: 'suspended',
      suspendedSince: iso(now - 30 * DAY + 1),
      eligibleAt: iso(now + 1),
    })
    const refusals = f.rbac.audit.read({
      scope: { kind: 'platform' },
      action: 'portal.delete.suspended',
      limit: 1000,
    })
    expect(refusals.map((event) => JSON.parse(event.detail_json))).toContainEqual({
      permission: 'portal.create',
      code: 'not_suspended_long_enough',
      lifecycleStatus: 'suspended',
      suspendedDays: 29,
      operatorDeleteAfterDays: 30,
      eraseRequested: false,
    })
    set('active', now - 31 * DAY)
    set('suspended', now - 30 * DAY)
    const deleted = await attempt()
    expect(deleted.status).toBe(200)
    expect(deleted.headers.get('cache-control')).toBe('private, no-store')
    expect(await deleted.json()).toEqual({
      ok: true,
      domain: { status: 'removed', hostname: `${SLUG}.corpuskit.org` },
    })
    expect(f.stores.tenants.get(SLUG)).toBeUndefined()
    expect(f.stores.tenants.isRetired(SLUG)).toBe(true)
    expect(f.stores.lifecycle.suspendedSince(SLUG)).toBeNull()
    const success = f.rbac.audit.read({
      scope: { kind: 'platform' },
      requestId: deleted.headers.get('x-request-id')!,
      action: 'portal.delete.suspended',
    })
    expect(success.map((event) => [event.outcome, JSON.parse(event.detail_json)])).toEqual([[
      'success',
      {
        permission: 'portal.create',
        lifecycleStatus: 'suspended',
        suspendedDays: 30,
        operatorDeleteAfterDays: 30,
        eraseRequested: false,
      },
    ]])
    // A second call finds no portal.
    const gone = await attempt()
    expect(gone.status).toBe(404)
    expect(await gone.json()).toEqual({ error: 'unknown_tenant' })
  } finally {
    f.close()
  }
})

Deno.test('the lifecycle routes report when a suspension began', async () => {
  const f = fixture(30)
  try {
    await createPortal(f)
    const platform = f.sessionFor('platform-admin')
    const put = (body: unknown) =>
      f.requestAs(platform, `/api/admin/t/${SLUG}/lifecycle`, json('PUT', body))
    const since = new Date(f.now()).toISOString()
    const suspended = await put({ status: 'suspended', limits: null })
    expect((await suspended.json()).lifecycle).toEqual({
      status: 'suspended',
      limits: null,
      updatedAt: since,
      suspendedSince: since,
    })
    f.advance(1000)
    const limited = await put({ status: 'suspended', limits: { asksPerDay: 1 } })
    expect((await limited.json()).lifecycle.suspendedSince).toBe(since)
    const restored = await put({ status: 'active', limits: null })
    expect((await restored.json()).lifecycle.suspendedSince).toBeNull()
    const read = await f.requestAs(platform, `/api/admin/t/${SLUG}/lifecycle`)
    expect((await read.json()).suspendedSince).toBeNull()
  } finally {
    f.close()
  }
})

Deno.test('the operator delete does what an owner delete does and can erase in the same call', async () => {
  const f = fixture(30)
  try {
    await createPortal(f)
    // Suspended first, so populating (which suspends it again) keeps the earlier start.
    f.stores.lifecycle.set(SLUG, { status: 'suspended', limits: null }, f.now() - 31 * DAY)
    await populate(f, SLUG)
    const platform = f.sessionFor('platform-admin')
    const response = await f.requestAs(
      platform,
      `/api/admin/tenants/${SLUG}/delete-suspended?erase=true`,
      { method: 'POST' },
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.domain).toEqual({ status: 'removed', hostname: `${SLUG}.corpuskit.org` })
    expect(body.erasure.slug).toBe(SLUG)
    expect(body.erasure.total).toBeGreaterThan(0)
    expect(f.stores.tenants.isRetired(SLUG)).toBe(true)
    expect(
      f.rbac.assignments.list(f.tenantId).some((row) =>
        row.scope.kind === 'portal' && row.scope.slug === SLUG
      ),
    ).toBe(false)
    expect(f.stores.mcpKeys.list(SLUG)).toEqual([])
    expect(f.stores.sessions.list(SLUG, researcher)).toEqual([])
    expect(f.stores.branding.get(SLUG, 'logo')).toBeNull()
    // Only this request's own records about the portal remain.
    const requestId = response.headers.get('x-request-id')!
    const keyed = f.database.all<AuditEvent>(
      `SELECT * FROM audit_events WHERE (scope_kind = 'portal' AND scope_slug = ?)
        OR (scope_kind = 'platform' AND target_id = ?)`,
      SLUG,
      SLUG,
    )
    expect(keyed.every((event) => event.request_id === requestId)).toBe(true)
    expect(keyed.map((event) => event.action)).toContain('portal.delete.suspended')
    expect(keyed.map((event) => event.action)).toContain('portal.erase')
    expect(
      keyed.some((event) =>
        event.action === 'local.mutation' &&
        JSON.parse(event.detail_json).mutation === 'erasure.erase'
      ),
    ).toBe(true)
    expect(JSON.stringify(keyed)).not.toContain('first-customer.example')
  } finally {
    f.close()
  }
})

Deno.test('the operator delete refuses bad input, seeded portals and unknown slugs', async () => {
  const f = fixture(30)
  try {
    await createPortal(f)
    f.stores.lifecycle.set(SLUG, { status: 'suspended', limits: null }, f.now() - 31 * DAY)
    f.stores.lifecycle.set('marine', { status: 'suspended', limits: null }, f.now() - 31 * DAY)
    const platform = f.sessionFor('platform-admin')
    for (
      const [path, init, status, error] of [
        [
          `/api/admin/tenants/${SLUG}/delete-suspended?erase=yes`,
          { method: 'POST' },
          400,
          'invalid_request',
        ],
        [
          `/api/admin/tenants/${SLUG}/delete-suspended`,
          json('POST', { force: true }),
          400,
          'invalid_request',
        ],
        ['/api/admin/tenants/marine/delete-suspended', { method: 'POST' }, 400, 'not_removable'],
        [
          '/api/admin/tenants/never-a-portal/delete-suspended',
          { method: 'POST' },
          404,
          'unknown_tenant',
        ],
      ] as const
    ) {
      const response = await f.requestAs(platform, path, init)
      expect([path, response.status]).toEqual([path, status])
      expect(await response.json()).toEqual({ error })
    }
    expect(f.stores.tenants.get(SLUG)).toBeDefined()
    // A portal role cannot use it, and the owner's own delete is untouched.
    const portalAdmin = f.sessionFor('portal-admin', 'a')
    f.stores.lifecycle.set('a', { status: 'suspended', limits: null }, f.now() - 31 * DAY)
    const denied = await f.requestAs(portalAdmin, '/api/admin/tenants/a/delete-suspended', {
      method: 'POST',
    })
    expect(denied.status).toBe(403)
    expect((await f.requestAs(platform, `/api/admin/tenants/${SLUG}`, { method: 'DELETE' })).status)
      .toBe(403)
    const deleted = await f.requestAs(
      platform,
      `/api/admin/tenants/${SLUG}/delete-suspended?erase=false`,
      { method: 'POST' },
    )
    expect(deleted.status).toBe(200)
    expect((await deleted.json()).erasure).toBeUndefined()
  } finally {
    f.close()
  }
})

Deno.test('retention routes are platform-admin, operator-enabled, and deletion stays owner-only', () => {
  for (
    const path of ['/api/admin/tenants/:slug/erase', '/api/admin/tenants/:slug/delete-suspended']
  ) {
    const declaration = declarationFor('POST', path)
    expect(declaration.permission).toBe('portal.create')
    expect(declaration.scope).toBe('platform')
    expect(declaration.operator).toBe(true)
  }
  expect(declarationFor('POST', '/api/admin/tenants/:slug/delete-suspended').subActions).toEqual([
    { action: 'tenant.domain.detach', permission: 'domains.write', scope: 'portal' },
  ])
  const owner = declarationFor('DELETE', '/api/admin/tenants/:slug')
  expect(owner.permission).toBe('portal.delete')
  expect(owner.operator).toBeUndefined()
  for (const path of ['erasure.erase', 'lifecycle.erase', 'tenants.erase']) {
    const local = DECLARATIONS.find((item) => item.kind === 'local' && item.path === path)
    expect([path, local?.permission, local?.scope]).toEqual([path, 'portal.create', 'platform'])
  }
})

Deno.test('the portal.erase audit line allows exactly the erasure counts', () => {
  const erased = emptyErasedCounts()
  ERASED_RECORD_KINDS.forEach((kind, index) => erased[kind] = index + 1)
  const detail = erasureAuditDetail(erased, 153)
  // Every kind maps to its own count field, so none is silently dropped by the audit allowlist.
  expect(Object.keys(detail)).toHaveLength(ERASED_RECORD_KINDS.length + 2)
  expect(new Set(Object.values(detail).slice(2))).toEqual(
    new Set(ERASED_RECORD_KINDS.map((_kind, index) => index + 1)),
  )
})

Deno.test('OPERATOR_DELETE_AFTER_DAYS accepts whole days from 1 to 36500 and nothing else', () => {
  for (const value of [undefined, '', ' ', '0', '-1', '1.5', '30d', 'abc', '36501', '1e3']) {
    expect([value, operatorDeleteAfterDays(value)]).toEqual([value, null])
  }
  for (const [value, days] of [['1', 1], [' 30 ', 30], ['36500', 36500], ['007', 7]] as const) {
    expect(operatorDeleteAfterDays(value)).toBe(days)
  }
  expect(operatorDeleteWarning({})).toBeNull()
  expect(operatorDeleteWarning({ OPERATOR_DELETE_AFTER_DAYS: '' })).toBeNull()
  expect(operatorDeleteWarning({ OPERATOR_DELETE_AFTER_DAYS: '30' })).toBeNull()
  const warning = operatorDeleteWarning({ OPERATOR_DELETE_AFTER_DAYS: 'secret-looking-0' })
  expect(warning).toContain('OPERATOR_DELETE_AFTER_DAYS')
  expect(warning).not.toContain('secret-looking-0')
})

/**
 * Every table in the Durable Object's database, and why erasure does or does not touch it. A new
 * table fails this test until it is classified here and, when it holds portal records, erased.
 */
const DURABLE_TABLES: Record<string, string> = {
  state: 'erased: each store removes its own keys (see POPULATE and the erasure diff)',
  branding_assets: 'erased: DurableBrandingStore.erase',
  enrichment_records: 'erased: DurableEnrichmentStore.erase',
  routing_records: 'erased: DurableRoutingLog.erase',
  audit_events: 'erased: RbacState.erasePortalRecords, keeping the erasure records',
  audit_event_order: 'erased: with the audit events it orders',
  audit_query_snapshots: 'erased: open paged queries of the portal',
  role_assignments: 'erased: RbacState.erasePortalRecords',
  rbac_migrations: 'no portal records: schema migration markers',
  rbac_owner_evidence: 'no portal records: owner sign-in evidence per identity',
  rbac_group_capabilities: 'no portal records: group support per deployment audience',
  break_glass_attempts: 'no portal records: attempts per client address',
  break_glass_locks: 'no portal records: lockouts per client address',
  rbac_unknown_roles: 'no portal records: hashes of unrecognised role claims',
  external_login_replays: 'no portal records: consumed assertion keys, expiring',
  sqlite_sequence: 'no portal records: SQLite autoincrement counters',
}

Deno.test('every Durable Object table is classified for erasure', () => {
  const f = fixture()
  try {
    const names = f.database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name)
    for (const name of names) {
      expect([name, Object.hasOwn(DURABLE_TABLES, name)]).toEqual([name, true])
    }
  } finally {
    f.close()
  }
})

Deno.test('every Durable Object store is populated by the erasure inventory', () => {
  const f = fixture()
  try {
    // POPULATE is typed over DurableStores; this also catches a store added at runtime only.
    expect(Object.keys(f.stores).sort()).toEqual(Object.keys(POPULATE).sort())
  } finally {
    f.close()
  }
})
