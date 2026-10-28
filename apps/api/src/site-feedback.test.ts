import { expect } from '@std/expect'
import { join } from 'node:path'
import { Hono } from 'hono'
import { tenantConfig } from './tenants.ts'
import { createEnforcementFixture, matrixManagement } from './enforcement-fixture.ts'
import {
  SITE_FEEDBACK_DAYS,
  SITE_FEEDBACK_KEEP,
  SITE_FEEDBACK_PER_ADDRESS,
  SITE_FEEDBACK_PER_PORTAL,
  type SiteFeedbackEmail,
  siteFeedbackEmailConfig,
  siteFeedbackEmailNotifier,
  siteFeedbackHandler,
  type SiteFeedbackNotifier,
  type SiteFeedbackRecord,
  type SiteFeedbackStoreApi,
  siteFeedbackWarning,
} from './site-feedback.ts'
import { SiteFeedbackStore, SourceStore } from './stores.ts'
import { DurableSiteFeedbackStore } from '../../cloudflare/src/state.ts'
import { EnrichmentStore } from './enrichments.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { openLocalRbac } from './rbac-local.ts'
import { MaintenanceError, runSystemMaintenance } from './scheduler.ts'

const DAY = 86_400_000
const ORIGIN = 'https://research.example.org'
const input = {
  message: '  Please add a download option.  ',
  email: 'reader@example.org',
  category: 'suggestion',
  pagePath: '/t/marine/library',
}

function post(body: unknown = input, headers: Record<string, string> = {}, slug = 'marine') {
  return new Request(`${ORIGIN}/api/t/${slug}/site-feedback`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The route alone, over a scratch local store, for one portal that has opted in. */
function harness(
  options: { fail?: boolean; optIn?: boolean; notifier?: boolean; now?: () => number } = {},
) {
  const directory = Deno.makeTempDirSync({ prefix: 'site-feedback-' })
  const store = new SiteFeedbackStore(directory)
  const delivered: SiteFeedbackRecord[] = []
  let address = '203.0.113.10'
  const notifier: SiteFeedbackNotifier = (portal, record) => {
    // Kept before it is sent, so a failed delivery never loses it.
    const kept = store.recent(portal.slug, SITE_FEEDBACK_KEEP).find((r) => r.id === record.id)
    expect(kept?.delivery).toBe('pending')
    if (options.fail) return Promise.reject(new Error('upstream detail that must stay private'))
    delivered.push(record)
    return Promise.resolve(`notification-${delivered.length}`)
  }
  const marine = { ...tenantConfig('marine')!, siteFeedback: options.optIn ?? true }
  const app = new Hono()
  app.post(
    '/api/t/:slug/site-feedback',
    siteFeedbackHandler({
      portal: (slug) => slug === 'marine' ? marine : undefined,
      store,
      notifier: options.notifier === false ? undefined : notifier,
      clientAddress: () => address,
      now: options.now,
    }),
  )
  return {
    store,
    delivered,
    send: (request: Request = post()) => app.fetch(request),
    from(next: string) {
      address = next
    },
    dispose: () => Deno.removeSync(directory, { recursive: true }),
  }
}

Deno.test('site feedback keeps a trimmed message, sends it, and records the acknowledgement', async () => {
  const h = harness()
  try {
    const response = await h.send()
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(h.delivered).toHaveLength(1)
    expect(h.store.recent('marine', 10)).toEqual([{
      id: body.id,
      slug: 'marine',
      createdAt: expect.any(String),
      category: 'suggestion',
      message: 'Please add a download option.',
      email: 'reader@example.org',
      pageUrl: `${ORIGIN}/t/marine/library`,
      delivery: 'sent',
      notificationId: 'notification-1',
    }])
  } finally {
    h.dispose()
  }
})

Deno.test('a failed delivery keeps the message and answers without upstream detail', async () => {
  const h = harness({ fail: true })
  try {
    const response = await h.send()
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error).toBe('site_feedback_failed')
    expect(JSON.stringify(body)).not.toContain('upstream')
    expect(h.store.recent('marine', 10).map((r) => [r.id, r.delivery])).toEqual([
      [body.id, 'failed'],
    ])
  } finally {
    h.dispose()
  }
})

Deno.test('a sent message answers 201 even when its status cannot be recorded', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'site-feedback-settle-' })
  try {
    const kept = new SiteFeedbackStore(directory)
    let saves = 0
    const marine = { ...tenantConfig('marine')!, siteFeedback: true }
    const app = (store: SiteFeedbackStoreApi, id: string) => {
      const hono = new Hono()
      hono.post(
        '/api/t/:slug/site-feedback',
        siteFeedbackHandler({
          portal: () => marine,
          store,
          notifier: () => Promise.resolve(id),
          clientAddress: () => '203.0.113.10',
        }),
      )
      return hono
    }
    // The second save, after delivery, fails: the message has gone, so the reader is told so.
    const flaky: SiteFeedbackStoreApi = {
      ...kept,
      recent: (slug, limit) => kept.recent(slug, limit),
      purgeExpired: () => kept.purgeExpired(),
      erase: (slug) => kept.erase(slug),
      save: (slug, record) => {
        if (++saves === 2) throw new Error('storage unavailable')
        kept.save(slug, record)
      },
    }
    expect((await app(flaky, 'provider-id').fetch(post())).status).toBe(201)
    expect(kept.recent('marine', 10).map((r) => r.delivery)).toEqual(['pending'])
    // A provider id past the stored bound is shortened, never left to make the record unreadable.
    expect((await app(kept, 'x'.repeat(2000)).fetch(post())).status).toBe(201)
    expect(kept.recent('marine', 10).find((r) => r.delivery === 'sent')?.notificationId)
      .toHaveLength(500)
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('site feedback answers 404 unless the portal opted in and the deployment can deliver', async () => {
  for (const options of [{ optIn: false }, { notifier: false }]) {
    const h = harness(options)
    try {
      // Refused before any other check, so the answer is that of a route that is not there.
      for (
        const request of [
          post(),
          post(input, { origin: 'https://elsewhere.example' }),
          post('{', { 'content-type': 'text/plain' }),
        ]
      ) {
        const response = await h.send(request)
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
      }
      expect(h.store.recent('marine', 10)).toEqual([])
    } finally {
      h.dispose()
    }
  }
  const h = harness()
  try {
    expect((await h.send(post(input, {}, 'elsewhere'))).status).toBe(404)
  } finally {
    h.dispose()
  }
})

Deno.test('site feedback refuses invalid data, recipient injection and query or foreign page URLs', async () => {
  const invalid: unknown[] = [
    { ...input, message: '   ' },
    { ...input, message: 'a'.repeat(4001) },
    { ...input, email: 'reader@example.org\r\nBcc: attacker@example.org' },
    { ...input, email: `${'x'.repeat(250)}@example.org` },
    { ...input, email: 'not an address' },
    { ...input, category: 'urgent' },
    { ...input, pagePath: 'https://attacker.example/steal' },
    { ...input, pagePath: '//attacker.example/steal' },
    { ...input, pagePath: '/t/marine/search?q=private' },
    { ...input, pagePath: '/t/marine/ask#private' },
    { ...input, pagePath: '/\\attacker.example' },
    { ...input, pagePath: '/t/marine/\u0007' },
    { ...input, to: 'attacker@example.org' },
    { message: 'No page' },
    [],
    null,
  ]
  for (const body of invalid) {
    // A fresh limiter for each, so this checks validation rather than throttling.
    const h = harness()
    try {
      expect([body, (await h.send(post(body))).status]).toEqual([body, 400])
      expect(h.delivered).toHaveLength(0)
      expect(h.store.recent('marine', 10)).toEqual([])
    } finally {
      h.dispose()
    }
  }
  const h = harness()
  try {
    const { email: _email, ...anonymous } = input
    expect((await h.send(post(anonymous))).status).toBe(201)
    expect(h.store.recent('marine', 10)[0]?.email).toBeUndefined()
  } finally {
    h.dispose()
  }
})

Deno.test("site feedback accepts only JSON from the portal's own pages", async () => {
  const h = harness()
  try {
    for (
      const headers of [
        { origin: 'https://attacker.example' },
        { origin: 'null' },
        { 'sec-fetch-site': 'cross-site' },
      ] as Record<string, string>[]
    ) expect((await h.send(post(input, headers))).status).toBe(403)
    const noOrigin = post()
    noOrigin.headers.delete('origin')
    expect((await h.send(noOrigin)).status).toBe(403)
    // A proxy that ends TLS forwards plain HTTP for the same host.
    const proxied = new Request(`http://research.example.org/api/t/marine/site-feedback`, post())
    expect((await h.send(proxied)).status).toBe(201)
    expect((await h.send(post(input, { 'content-type': 'text/plain' }))).status).toBe(415)
    expect(h.delivered).toHaveLength(1)
  } finally {
    h.dispose()
  }
})

Deno.test('site feedback bounds the bytes it reads and refuses malformed JSON', async () => {
  for (const headers of [{}, { 'content-length': '10' }] as Record<string, string>[]) {
    const h = harness()
    try {
      const oversized = post({ ...input, message: 'a'.repeat(25_000) }, headers)
      expect((await h.send(oversized)).status).toBe(413)
    } finally {
      h.dispose()
    }
  }
  const h = harness()
  try {
    expect((await h.send(post('{'))).status).toBe(400)
    expect((await h.send(post('\xff'))).status).toBe(400)
  } finally {
    h.dispose()
  }
})

Deno.test("the honeypot drops a bot's message without keeping or sending it", async () => {
  const h = harness()
  try {
    const response = await h.send(post({ ...input, website: 'https://spam.example' }))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true })
    expect(h.delivered).toHaveLength(0)
    expect(h.store.recent('marine', 10)).toEqual([])
  } finally {
    h.dispose()
  }
})

Deno.test('site feedback limits each address, then the portal, by the address the runtime reported', async () => {
  let clock = Date.UTC(2026, 9, 28)
  const h = harness({ now: () => clock })
  try {
    for (let index = 0; index < SITE_FEEDBACK_PER_ADDRESS; index++) {
      expect((await h.send()).status).toBe(201)
    }
    // Headers a caller writes choose no bucket of their own.
    const limited = await h.send(post(input, {
      'x-forwarded-for': '198.51.100.9',
      'cf-connecting-ip': '198.51.100.9',
      'x-rp-client': 'another-browser-id',
    }))
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Invalid requests and the honeypot give the portal its turn back, but not the address.
    h.from('203.0.113.20')
    for (let index = 0; index < SITE_FEEDBACK_PER_ADDRESS; index++) {
      expect((await h.send(post({ ...input, website: 'bot' }))).status).toBe(202)
    }
    expect((await h.send()).status).toBe(429)
    // Spread over addresses, the portal still takes only its hourly ceiling.
    let sent = SITE_FEEDBACK_PER_ADDRESS
    for (let address = 30; sent < SITE_FEEDBACK_PER_PORTAL; address++) {
      h.from(`203.0.113.${address}`)
      expect((await h.send()).status).toBe(201)
      sent++
    }
    h.from('192.0.2.200')
    expect((await h.send()).status).toBe(429)
    expect(h.delivered).toHaveLength(SITE_FEEDBACK_PER_PORTAL)
    clock += 60 * 60_000 + 1
    expect((await h.send()).status).toBe(201)
  } finally {
    h.dispose()
  }
})

const record = (index: number, createdAt: number, slug = 'marine'): SiteFeedbackRecord => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  slug,
  createdAt: new Date(createdAt).toISOString(),
  category: 'general',
  message: `Reader message ${index}`,
  pageUrl: `${ORIGIN}/t/${slug}`,
  delivery: 'pending',
})

for (
  const [name, open] of [
    ['local server', (now: () => number) => {
      const directory = Deno.makeTempDirSync({ prefix: 'site-feedback-store-' })
      return {
        store: new SiteFeedbackStore(directory, now) as SiteFeedbackStoreApi,
        reopen: () => new SiteFeedbackStore(directory, now) as SiteFeedbackStoreApi,
        tear: (slug: string) => {
          const file = join(directory, 'site-feedback', `${slug}.json`)
          const rows = JSON.parse(Deno.readTextFileSync(file))
          Deno.writeTextFileSync(file, JSON.stringify([...rows, { id: 'torn' }]))
        },
        close: () => Deno.removeSync(directory, { recursive: true }),
      }
    }],
    ['Durable Object', (now: () => number) => {
      const f = createEnforcementFixture()
      return {
        store: new DurableSiteFeedbackStore(f.state, now) as SiteFeedbackStoreApi,
        reopen: () => new DurableSiteFeedbackStore(f.state, now) as SiteFeedbackStoreApi,
        tear: (slug: string) =>
          f.database.exec(
            'INSERT INTO site_feedback (tenant_slug, id, record, created_at) VALUES (?, ?, ?, ?)',
            slug,
            'torn',
            '{"id":',
            now(),
          ),
        close: () => f.close(),
      }
    }],
  ] as const
) {
  Deno.test(`each portal keeps its newest messages for the window, then none (${name})`, () => {
    let clock = Date.UTC(2026, 9, 28)
    const { store, reopen, tear, close } = open(() => clock)
    try {
      const first = record(0, clock)
      store.save('marine', first)
      store.save('marine', { ...first, delivery: 'sent', notificationId: 'sent-1' })
      // A new adapter reads storage, so this is stored state rather than memory.
      expect(reopen().recent('marine', 10)).toEqual([
        { ...first, delivery: 'sent', notificationId: 'sent-1' },
      ])
      store.save('marine', record(1, clock - (SITE_FEEDBACK_DAYS * DAY + 60_000)))
      expect(store.recent('marine', 10).map((r) => r.id)).toEqual([first.id])
      for (let index = 1; index <= SITE_FEEDBACK_KEEP; index++) {
        store.save('marine', record(index, clock + index))
      }
      const kept = store.recent('marine', SITE_FEEDBACK_KEEP + 10)
      expect(kept).toHaveLength(SITE_FEEDBACK_KEEP)
      expect(kept[0]?.message).toBe(`Reader message ${SITE_FEEDBACK_KEEP}`)
      expect(kept.some((r) => r.id === first.id)).toBe(false)
      expect(store.recent('marine', 2).map((r) => r.message)).toEqual([
        `Reader message ${SITE_FEEDBACK_KEEP}`,
        `Reader message ${SITE_FEEDBACK_KEEP - 1}`,
      ])
      // One portal's messages never count against another's.
      store.save('grains', record(9999, clock, 'grains'))
      expect(store.recent('grains', 10)).toHaveLength(1)
      expect(store.recent('marine', 1000)).toHaveLength(SITE_FEEDBACK_KEEP)
      // A torn or hand-edited row is passed over, never served.
      tear('grains')
      expect(store.recent('grains', 10).map((r) => r.slug)).toEqual(['grains'])

      // The daily pass removes what aged out even where no one writes again.
      clock += (SITE_FEEDBACK_DAYS + 1) * DAY
      expect(store.purgeExpired()).toBeGreaterThanOrEqual(SITE_FEEDBACK_KEEP + 1)
      expect(store.recent('marine', 10)).toEqual([])
      expect(store.recent('grains', 10)).toEqual([])

      store.save('marine', record(1, clock))
      expect(store.erase('marine')).toBe(1)
      expect(store.erase('marine')).toBe(0)
      expect(store.recent('marine', 10)).toEqual([])
    } finally {
      close()
    }
  })
}

Deno.test('the daily maintenance pass removes expired messages on both runtimes', async () => {
  const now = Date.now()
  const f = createEnforcementFixture()
  const directory = Deno.makeTempDirSync({ prefix: 'site-feedback-purge-' })
  const env = { DATA_DIR: directory, TENANTS_PATH: join(directory, 'tenants.json') }
  const { database, rbac } = openLocalRbac(env)
  try {
    const local = new SiteFeedbackStore(directory)
    for (const store of [f.stores.siteFeedback, local] as SiteFeedbackStoreApi[]) {
      store.save('a', record(1, now - DAY, 'a'))
      store.save('a', record(2, now - (SITE_FEEDBACK_DAYS + 1) * DAY, 'a'))
    }
    // The stores the Worker's maintenance pass is given.
    await runSystemMaintenance(matrixManagement([]), f.stores, undefined, [])
    const owned = localOwnedStores(directory, database, rbac.audit, env)
    await runSystemMaintenance(
      matrixManagement([]),
      {
        rbac,
        tenants: owned.tenants!,
        sources: new SourceStore(directory),
        watches: owned.watches,
        enrichments: new EnrichmentStore(directory),
        siteFeedback: local,
      },
      undefined,
      [],
    )
    for (const store of [f.stores.siteFeedback, local] as SiteFeedbackStoreApi[]) {
      expect(store.recent('a', 10).map((r) => r.message)).toEqual(['Reader message 1'])
    }
    // A failed purge is reported with the pass, after the answer feedback purge still ran.
    let answerPurges = 0
    const error = await runSystemMaintenance(
      matrixManagement([]),
      {
        ...f.stores,
        feedback: { purgeExpired: () => answerPurges++ },
        siteFeedback: {
          purgeExpired: () => {
            throw new Error('storage unavailable')
          },
        },
      },
      undefined,
      [],
    ).catch((caught: unknown) => caught)
    expect(answerPurges).toBe(1)
    expect(error).toBeInstanceOf(MaintenanceError)
    expect((error as MaintenanceError).failures).toEqual([
      { job: 'retention', target: 'site-feedback' },
    ])
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
    f.close()
  }
})

Deno.test("site feedback email comes from the deployment's addresses and escapes the reader's text", async () => {
  const sent: SiteFeedbackEmail[] = []
  const notify = siteFeedbackEmailNotifier(
    {
      send(message) {
        sent.push(message)
        return Promise.resolve({ messageId: 'provider-id' })
      },
    },
    { from: 'feedback@portal.example.org', to: 'team@portal.example.org' },
  )
  const portal = tenantConfig('marine')!
  const message = {
    ...record(1, Date.UTC(2026, 9, 28)),
    category: 'problem' as const,
    message: '<img src=x onerror=alert(1)> & "quoted"',
    email: 'reader@example.org',
  }
  expect(
    await notify(
      { ...portal, branding: { ...portal.branding, productName: 'Marine\r\nBcc: x@example.org' } },
      message,
    ),
  ).toBe('provider-id')
  expect(sent[0]).toMatchObject({
    to: 'team@portal.example.org',
    from: { email: 'feedback@portal.example.org', name: 'Marine Bcc: x@example.org feedback' },
    replyTo: 'reader@example.org',
    subject: 'Marine Bcc: x@example.org feedback: A problem with the portal',
  })
  expect(sent[0]!.text).toContain(message.message)
  expect(sent[0]!.text).toContain(message.pageUrl)
  expect(sent[0]!.html).not.toContain('<img')
  expect(sent[0]!.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;')
  // Without a reply address there is no reply-to, and an unacknowledged send is a failure.
  const { email: _email, ...unsigned } = message
  await notify(portal, unsigned)
  expect(sent[1]!.replyTo).toBeUndefined()
  const silent = siteFeedbackEmailNotifier(
    { send: () => Promise.resolve({ messageId: '' }) },
    { from: 'feedback@portal.example.org', to: 'team@portal.example.org' },
  )
  await expect(silent(portal, unsigned)).rejects.toThrow()
})

Deno.test('the email settings need both addresses, and a partial set warns without its values', () => {
  const complete = {
    SITE_FEEDBACK_FROM: 'feedback@portal.example.org',
    SITE_FEEDBACK_TO: 'team@portal.example.org',
  }
  expect(siteFeedbackEmailConfig(complete)).toEqual({
    binding: 'SITE_FEEDBACK_EMAIL',
    from: 'feedback@portal.example.org',
    to: 'team@portal.example.org',
  })
  expect(siteFeedbackEmailConfig({ ...complete, SITE_FEEDBACK_EMAIL_BINDING: 'MAIL' })?.binding)
    .toBe('MAIL')
  for (
    const env of [
      {},
      { SITE_FEEDBACK_FROM: complete.SITE_FEEDBACK_FROM },
      { ...complete, SITE_FEEDBACK_TO: 'team' },
      { ...complete, SITE_FEEDBACK_EMAIL_BINDING: 'not a binding' },
    ]
  ) expect(siteFeedbackEmailConfig(env)).toBeNull()

  const present = () => true
  expect(siteFeedbackWarning({}, present)).toBeNull()
  expect(siteFeedbackWarning(complete, present)).toBeNull()
  for (
    const [env, hasBinding] of [
      [{ SITE_FEEDBACK_TO: 'secret-recipient@example.org' }, present],
      [complete, () => false],
    ] as const
  ) {
    const warning = siteFeedbackWarning(env, hasBinding)
    expect(warning).toContain('Reader feedback is off')
    expect(warning).not.toContain('example.org')
  }
})

Deno.test('the setting is opt-in, readers see it only with a notifier, and history is for curators', async () => {
  const delivered: string[] = []
  const notifier: SiteFeedbackNotifier = (_portal, record) => {
    delivered.push(record.id)
    return Promise.resolve('fixture-notification')
  }
  for (const withNotifier of [false, true]) {
    const f = createEnforcementFixture(withNotifier ? { siteFeedbackNotifier: notifier } : {})
    try {
      const admin = f.sessionFor('portal-admin')
      const viewer = f.sessionFor('viewer')
      const patch = (body: unknown) =>
        f.requestAs(admin, '/api/admin/tenants/a', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const config = async () => await (await f.requestAs(viewer, '/api/t/a/config')).json()
      const send = () =>
        f.requestAs(viewer, '/api/t/a/site-feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost' },
          body: JSON.stringify({ ...input, pagePath: '/t/a/library' }),
        })

      expect((await config()).siteFeedback).toBeUndefined()
      expect((await send()).status).toBe(404)
      expect((await patch({ siteFeedback: 'yes' })).status).toBe(400)
      expect((await patch({ siteFeedback: true })).status).toBe(200)
      expect(f.stores.tenants.get('a')?.siteFeedback).toBe(true)
      expect((await config()).siteFeedback).toBe(withNotifier ? true : undefined)
      const response = await send()
      expect(response.status).toBe(withNotifier ? 201 : 404)
      // What the reader wrote never reaches the audit log.
      const audit = JSON.stringify(
        f.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 }),
      )
      // The setting change is in it; the message is not.
      expect(audit).toContain('siteFeedback')
      expect(audit).not.toContain('reader@example.org')
      expect(audit).not.toContain('download option')

      const history = '/api/admin/t/a/site-feedback'
      expect((await f.requestAs(viewer, history)).status).toBe(403)
      const listed = await f.requestAs(f.sessionFor('curator'), history)
      expect(listed.status).toBe(200)
      expect(listed.headers.get('cache-control')).toBe('no-store')
      expect((await listed.json()).feedback).toEqual(f.stores.siteFeedback.recent('a', 50))

      expect((await patch({ siteFeedback: false })).status).toBe(200)
      expect((await config()).siteFeedback).toBeUndefined()
      expect((await send()).status).toBe(404)
      // What was kept stays readable until it ages out or the portal is erased.
      expect(
        (await (await f.requestAs(f.sessionFor('curator'), history)).json()).feedback,
      ).toHaveLength(withNotifier ? 1 : 0)
    } finally {
      f.close()
    }
  }
  expect(delivered).toHaveLength(1)
})
