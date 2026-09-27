import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { LocalIngress } from './local-ingress.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { buildApp } from './app.ts'
import { TenantStore } from './tenants.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import type { TrustedSessionFacts } from './principal.ts'

// Anonymous paid answers are limited per client address, per browser inside that address, and
// per portal across every anonymous caller. The address is the one the runtime reported; these
// tests rotate every address and browser header a caller can write and still reach the 429.

const ASK = JSON.stringify({ query: 'What is known about abalone stock health?' })
const post = (headers: Record<string, string> = {}, body = ASK): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
})
/** Headers a caller could use to pose as someone else, fresh on every request. */
const spoofed = (): Record<string, string> => ({
  'fly-client-ip': `203.0.113.${Math.floor(Math.random() * 250)}`,
  'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250)}, 10.0.0.1`,
  'cf-connecting-ip': `192.0.2.${Math.floor(Math.random() * 250)}`,
  'x-real-ip': `192.0.2.${Math.floor(Math.random() * 250)}`,
})
const browser = () => `browser-${crypto.randomUUID().slice(0, 12)}`
/** The status, with any answer stream released. */
const status = async (response: Promise<Response>) => {
  const answered = await response
  await answered.body?.cancel()
  return answered.status
}

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter}: rotating address and browser headers from one client still ends in 429`, async () => {
    const f = createEnforcementFixture(
      { rateLimitAskPerMin: 2, rateLimitAskPerMinPerIp: 4 },
      adapter,
    )
    try {
      const ask = (headers: Record<string, string>, from = '198.51.100.20') =>
        status(f.requestFrom(from, null, '/api/t/public-a/ask', post(headers)))
      // One browser id, every address header rotated: its bucket inside the address.
      const same = 'browser-aaaaaaaa'
      expect(await ask({ ...spoofed(), 'x-rp-client': same })).toBe(200)
      expect(await ask({ ...spoofed(), 'x-rp-client': same })).toBe(200)
      const limited = await f.requestFrom(
        '198.51.100.20',
        null,
        '/api/t/public-a/ask',
        post({ ...spoofed(), 'x-rp-client': same }),
      )
      expect(limited.status).toBe(429)
      expect(await limited.json()).toEqual({ error: 'rate_limited' })
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      // A new browser id for every request as well: the address's own bucket ends it.
      expect(await ask({ ...spoofed(), 'x-rp-client': browser() })).toBe(200)
      expect(await ask({ ...spoofed(), 'x-rp-client': browser() })).toBe(200)
      expect(await ask({ ...spoofed(), 'x-rp-client': browser() })).toBe(429)
      expect(await ask(spoofed())).toBe(429)
      // The same browser id from another address is another caller, not this one's bucket.
      expect(await ask({ 'x-rp-client': same }, '198.51.100.21')).toBe(200)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter}: anonymous asks on one portal stop at its ceiling, however many addresses`, async () => {
    const f = createEnforcementFixture({ rateLimitAnonPortalAskPerMin: 3 }, adapter)
    try {
      const askFrom = (
        address: string,
        slug = 'public-a',
        session: TrustedSessionFacts | null = null,
      ) => status(f.requestFrom(address, session, `/api/t/${slug}/ask`, post()))
      for (let i = 1; i <= 3; i++) expect(await askFrom(`198.51.100.${i}`)).toBe(200)
      expect(await askFrom('198.51.100.4')).toBe(429)
      // Other portals keep their own ceiling.
      expect(await askFrom('198.51.100.5', 'public-b')).toBe(200)
      // A signed-in reader is not an anonymous caller.
      expect(await askFrom('198.51.100.6', 'public-a', f.unassigned)).toBe(200)
      // A call that accompanies an ask is not an ask of its own.
      const routed = await f.requestFrom('198.51.100.7', null, '/api/t/public-a/route', post())
      expect(routed.status).not.toBe(429)
      await routed.body?.cancel()
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter}: one address takes no more than its share of a portal's anonymous asks`, async () => {
    const f = createEnforcementFixture(
      {
        rateLimitAskPerMin: 20,
        rateLimitAskPerMinPerIp: 100,
        rateLimitAnonPortalAskPerMin: 30,
        rateLimitAnonAddressAskPerMin: 10,
      },
      adapter,
    )
    try {
      const ask = (from: string, session: TrustedSessionFacts | null = null) =>
        status(
          f.requestFrom(from, session, '/api/t/public-a/ask', post({ 'x-rp-client': browser() })),
        )
      // A new browser id each time does not stretch one address past its share.
      for (let i = 0; i < 10; i++) expect(await ask('198.51.100.67')).toBe(200)
      expect(await ask('198.51.100.67')).toBe(429)
      // The rest of the portal's asks are still there for other readers.
      expect(await ask('203.0.113.10')).toBe(200)
      // A signed-in reader at the same address is not an anonymous caller.
      expect(await ask('198.51.100.67', f.unassigned)).toBe(200)
      // The share is per portal.
      expect(
        await status(f.requestFrom('198.51.100.67', null, '/api/t/public-b/ask', post())),
      ).toBe(200)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter}: refused asks give the portal its anonymous turn back`, async () => {
    const f = createEnforcementFixture(
      { rateLimitAskPerMin: 20, rateLimitAskPerMinPerIp: 100, rateLimitAnonPortalAskPerMin: 3 },
      adapter,
    )
    try {
      // Malformed asks from one address, each with a new browser id: every one is refused as
      // invalid, with no answer and no daily ask spent.
      for (let i = 0; i < 10; i++) {
        expect(
          await status(f.requestFrom(
            '198.51.100.66',
            null,
            '/api/t/public-a/ask',
            post({ 'x-rp-client': `browser-${String(i).padStart(8, '0')}` }, '{}'),
          )),
        ).toBe(400)
      }
      expect(f.stores.lifecycle.usage('public-a', 'UTC', f.now()).asksToday).toBe(0)
      // They took no reader's turn: the portal still has all three.
      for (let i = 1; i <= 3; i++) {
        expect(await status(f.requestFrom(`203.0.113.${i}`, null, '/api/t/public-a/ask', post())))
          .toBe(200)
      }
      expect(await status(f.requestFrom('203.0.113.4', null, '/api/t/public-a/ask', post())))
        .toBe(429)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter}: a cross-portal ask counts once on every portal it reaches`, async () => {
    const f = createEnforcementFixture(
      { rateLimitAskPerMin: 5, rateLimitEstatePerMin: 10 },
      adapter,
    )
    try {
      const estate = (from: string) => status(f.requestFrom(from, null, '/api/ask-estate', post()))
      const ask = (from: string) => status(f.requestFrom(from, null, '/api/t/public-a/ask', post()))
      // Four public portals (the seeded two and public-a and public-b): one cross-portal ask is
      // four of the address's five.
      expect(
        f.stores.tenants.list().filter((t) =>
          f.stores.tenants.get(t.slug)?.accessMode === 'public'
        ),
      ).toHaveLength(4)
      expect(await estate('198.51.100.30')).toBe(200)
      expect(await estate('198.51.100.30')).toBe(429)
      expect(await ask('198.51.100.30')).toBe(200)
      expect(await ask('198.51.100.30')).toBe(429)
    } finally {
      f.close()
    }
    const g = createEnforcementFixture(
      { rateLimitAnonPortalAskPerMin: 3, rateLimitEstatePerMin: 10 },
      adapter,
    )
    try {
      // Each cross-portal ask takes a turn on both portals, from whichever address it comes.
      for (let i = 1; i <= 3; i++) {
        expect(await status(g.requestFrom(`198.51.100.${40 + i}`, null, '/api/ask-estate', post())))
          .toBe(200)
      }
      expect(await status(g.requestFrom('198.51.100.44', null, '/api/ask-estate', post())))
        .toBe(429)
      expect(await status(g.requestFrom('198.51.100.45', null, '/api/t/public-b/ask', post())))
        .toBe(429)
      // A refused cross-portal ask costs no portal its daily quota.
      expect(g.stores.lifecycle.usage('public-a', 'UTC', g.now()).asksToday).toBe(3)
      expect(g.stores.lifecycle.usage('public-b', 'UTC', g.now()).asksToday).toBe(3)
    } finally {
      g.close()
    }
  })
}

/** The local server's own stack: its ingress resolving each request's address, then the app. */
function localServer(env: Record<string, string>) {
  const db = new LocalRbacDatabase(':memory:')
  const directory = Deno.makeTempDirSync({ prefix: 'client-address-' })
  const rbac = new RbacState(db)
  rbac.migrate()
  const tenants = new TenantStore({
    TENANTS_PATH: `${directory}/tenants.json`,
    SHOWCASE_PORTALS: 'marine,grains',
  })
  const ingress = new LocalIngress({ rbac, tenants, env: { ENTRA_TENANT_ID: 'tenant-1', ...env } })
  const app = buildApp({
    provider: new DoubleProvider(),
    tenants,
    rbac,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
    rateLimitAskPerMin: 2,
    rateLimitAskPerMinPerIp: 2,
    rateLimitAnonPortalAskPerMin: 0,
  })
  const ask = (peer: string, headers: Record<string, string> = {}) =>
    status(ingress.handle(
      new Request('http://localhost/api/t/marine/ask', post(headers)),
      (request) => app.fetch(request),
      { remoteAddr: { transport: 'tcp', hostname: peer, port: 40000 } },
    ))
  return {
    ask,
    close: () => {
      db.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

Deno.test('the local server keys limits on the TCP peer, whatever forwarding headers say', async () => {
  const server = localServer({})
  try {
    expect(await server.ask('192.0.2.50', spoofed())).toBe(200)
    expect(await server.ask('192.0.2.50', spoofed())).toBe(200)
    expect(await server.ask('192.0.2.50', spoofed())).toBe(429)
    expect(await server.ask('192.0.2.51', spoofed())).toBe(200)
  } finally {
    server.close()
  }
})

Deno.test('behind a declared proxy the local server keys limits on the hop the proxy recorded', async () => {
  const server = localServer({ TRUST_PROXY_HOPS: '1' })
  const proxy = '10.0.0.1'
  try {
    // The proxy appends the address it saw; whatever the client wrote before it is not read.
    const via = (client: string) => ({ 'x-forwarded-for': `${crypto.randomUUID()}, ${client}` })
    expect(await server.ask(proxy, via('198.51.100.60'))).toBe(200)
    expect(await server.ask(proxy, via('198.51.100.60'))).toBe(200)
    expect(await server.ask(proxy, via('198.51.100.60'))).toBe(429)
    // Every other client behind the same proxy keeps its own budget.
    expect(await server.ask(proxy, via('198.51.100.61'))).toBe(200)
  } finally {
    server.close()
  }
})
