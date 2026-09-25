import { expect } from '@std/expect'
import {
  CloudflareDomainApiError,
  CloudflareDomainProvisioner,
  createCloudflareDomainProvisioner,
  portalHostnameForSlug,
} from './cloudflare-domains.ts'

const domain = (hostname: string, service = 'corpuskit') => ({
  id: `domain-${hostname}`,
  hostname,
  service,
  zone_id: 'zone-id',
  zone_name: 'corpuskit.org',
})

function response(result: unknown, status = 200): Response {
  return Response.json(
    status < 400
      ? { success: true, ...(result === undefined ? {} : { result }) }
      : { success: false, errors: [{ code: 1000, message: String(result) }] },
    { status },
  )
}

function harness(replies: Response[]) {
  const requests: Request[] = []
  const fetcher = (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init))
    const next = replies.shift()
    if (!next) throw new Error('Unexpected Cloudflare request')
    return Promise.resolve(next)
  }
  const provisioner = new CloudflareDomainProvisioner(
    { accountId: 'account-id', apiToken: 'domain-token' },
    fetcher as typeof fetch,
  )
  return { provisioner, requests }
}

Deno.test('portalHostnameForSlug accepts only safe non-reserved DNS labels', () => {
  expect(portalHostnameForSlug('research-portal', 'corpuskit.org')).toBe(
    'research-portal.corpuskit.org',
  )
  for (
    const slug of [
      '',
      '-leading',
      'trailing-',
      'has_underscore',
      'Uppercase',
      'xn--spoof',
      'a'.repeat(64),
      'www',
      'api',
      'admin',
      'mail',
      'app',
    ]
  ) {
    expect(portalHostnameForSlug(slug, 'corpuskit.org')).toBeNull()
  }
})

Deno.test('createCloudflareDomainProvisioner requires both Worker secrets', () => {
  expect(createCloudflareDomainProvisioner({})).toBeNull()
  expect(createCloudflareDomainProvisioner({ CLOUDFLARE_ACCOUNT_ID: 'account-id' })).toBeNull()
  expect(createCloudflareDomainProvisioner({
    CLOUDFLARE_DOMAINS_TOKEN: 'token',
  })).toBeNull()
})

Deno.test('hostname automation attaches a non-apex platform hostname to the configured Worker', async () => {
  const hostname = portalHostnameForSlug('research-portal', 'research.example.org')!
  expect(hostname).toBe('research-portal.research.example.org')
  const requests: Request[] = []
  const provisioner = createCloudflareDomainProvisioner({
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_DOMAINS_TOKEN: 'domain-token',
    PLATFORM_DOMAIN: 'research.example.org',
    WORKER_NAME: 'research-portals',
  }, (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return Promise.resolve(response(
      request.method === 'GET' ? [] : {
        ...domain(hostname, 'research-portals'),
        zone_name: 'example.org',
      },
    ))
  })!
  await expect(provisioner.attach(hostname)).resolves.toEqual({ hostname, created: true })
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/client/v4/accounts/account-id/workers/domains',
    '/client/v4/accounts/account-id/workers/domains',
  ])
  expect(new URL(requests[0]!.url).searchParams.has('zone_name')).toBe(false)
  // Cloudflare resolves the containing zone, so no zone lookup or extra token permission.
  expect(await requests[1]!.json()).toEqual({ hostname, service: 'research-portals' })
})

Deno.test('hostname automation rejects malformed domains and hostnames before calling Cloudflare', async () => {
  expect(() => portalHostnameForSlug('marine', 'example.org/path')).toThrow(
    'Invalid PLATFORM_DOMAIN',
  )
  expect(() =>
    createCloudflareDomainProvisioner({
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_DOMAINS_TOKEN: 'domain-token',
      PLATFORM_DOMAIN: 'example.org; Domain=other.test',
    }, () => {
      throw new Error('Network must not be called')
    })
  ).toThrow('Invalid PLATFORM_DOMAIN')
  const longDomain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}`
  expect(portalHostnameForSlug('marine', longDomain)).toBeNull()
  const { provisioner, requests } = harness([])
  for (const hostname of ['marine.example.org/path', 'marine.example.org?zone_name=x', '']) {
    await expect(provisioner.attach(hostname)).rejects.toBeInstanceOf(CloudflareDomainApiError)
    await expect(provisioner.detach(hostname)).rejects.toBeInstanceOf(CloudflareDomainApiError)
  }
  expect(requests).toHaveLength(0)
})

Deno.test('attach rejects a result in a zone that does not contain the hostname', async () => {
  const hostname = 'marine.research.example.org'
  for (
    const zoneName of ['other.example.org', 'ample.org', 'marine.research.example.org.evil', '']
  ) {
    const { provisioner } = harness([
      response([]),
      response({ ...domain(hostname), zone_name: zoneName }),
    ])
    await expect(provisioner.attach(hostname)).rejects.toThrow(
      'Cloudflare attached an unexpected zone',
    )
  }
})

Deno.test('an explicit zone hint is sent on lookup and attach and must match the result', async () => {
  const hostname = 'marine.research.example.org'
  const requests: Request[] = []
  let attachedZone = 'example.org'
  const provisioner = new CloudflareDomainProvisioner({
    accountId: 'account-id',
    apiToken: 'test-only-token',
    zoneName: 'Example.org',
  }, (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return Promise.resolve(response(
      request.method === 'GET' ? [] : { ...domain(hostname), zone_name: attachedZone },
    ))
  })
  await expect(provisioner.attach(hostname)).resolves.toEqual({ hostname, created: true })
  expect(new URL(requests[0]!.url).searchParams.get('zone_name')).toBe('example.org')
  expect(await requests[1]!.json()).toEqual({
    hostname,
    service: 'corpuskit',
    zone_name: 'example.org',
  })
  attachedZone = 'research.example.org'
  await expect(provisioner.attach(hostname)).rejects.toThrow(
    'Cloudflare attached an unexpected zone',
  )
})

Deno.test('attach is an idempotent no-op when the domain already belongs to CorpusKit', async () => {
  const existing = domain('new-portal.corpuskit.org')
  const { provisioner, requests } = harness([response([existing])])

  await expect(provisioner.attach(existing.hostname.toUpperCase())).resolves.toEqual({
    hostname: existing.hostname,
    created: false,
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.method).toBe('GET')
  expect(new URL(requests[0]!.url).searchParams.get('hostname')).toBe(existing.hostname)
})

Deno.test('attach uses the current Workers custom-domain request shape', async () => {
  const hostname = 'new-portal.corpuskit.org'
  const created = domain(hostname)
  const { provisioner, requests } = harness([response([]), response(created)])

  await expect(provisioner.attach(hostname)).resolves.toEqual({ hostname, created: true })
  const attach = requests.at(-1)!
  expect(attach.method).toBe('PUT')
  expect(attach.headers.get('authorization')).toBe('Bearer domain-token')
  expect(new URL(attach.url).pathname).toBe('/client/v4/accounts/account-id/workers/domains')
  expect(await attach.json()).toEqual({ hostname, service: 'corpuskit' })
})

Deno.test('attach refuses to take over a domain owned by another Worker', async () => {
  const hostname = 'new-portal.corpuskit.org'
  const { provisioner, requests } = harness([response([domain(hostname, 'another-worker')])])

  await expect(provisioner.attach(hostname)).rejects.toBeInstanceOf(CloudflareDomainApiError)
  expect(requests).toHaveLength(1)
})

Deno.test('detach removes an owned domain by immutable id and is idempotent when absent', async () => {
  const hostname = 'new-portal.corpuskit.org'
  const existing = domain(hostname)
  const active = harness([response([existing]), response(undefined)])

  await expect(active.provisioner.detach(hostname)).resolves.toEqual({ hostname, removed: true })
  expect(active.requests[1]?.method).toBe('DELETE')
  expect(new URL(active.requests[1]!.url).pathname).toContain(`/workers/domains/${existing.id}`)

  const absent = harness([response([])])
  await expect(absent.provisioner.detach(hostname)).resolves.toEqual({
    hostname,
    removed: false,
  })
  expect(absent.requests).toHaveLength(1)
})

Deno.test('Cloudflare failures never include the API token in their message', async () => {
  const { provisioner } = harness([response('permission denied', 403)])

  try {
    await provisioner.attach('new-portal.corpuskit.org')
    throw new Error('Expected attach to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(CloudflareDomainApiError)
    expect(String(error)).toContain('permission denied')
    expect(String(error)).not.toContain('domain-token')
  }
})

Deno.test('every Worker configuration attaches portal hostnames to its own script', async () => {
  for (const file of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
    const config = JSON.parse(
      await Deno.readTextFile(new URL(`../../../${file}`, import.meta.url)),
    ) as { name: string; vars: { WORKER_NAME?: string } }
    expect(config.vars.WORKER_NAME).toBe(config.name)
  }
})

Deno.test('hostname automation calls fetch unbound, as the Workers runtime requires', async () => {
  const calls: string[] = []
  // Mirrors the Workers fetch: called with any receiver other than undefined or globalThis, it throws.
  const workersFetch = function (this: unknown, input: string | URL | Request, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
    }
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    if ((init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json({ success: true, result: [] }))
    }
    const hostname = JSON.parse(String(init?.body)).hostname
    return Promise.resolve(Response.json({
      success: true,
      result: {
        id: 'd1',
        hostname,
        service: 'corpuskit',
        zone_name: 'corpuskit.org',
        environment: 'production',
      },
    }))
  } as typeof fetch
  const provisioner = new CloudflareDomainProvisioner(
    { accountId: 'acct', apiToken: 'token' },
    workersFetch,
  )
  const attached = await provisioner.attach('acme.corpuskit.org')
  expect(attached.hostname).toBe('acme.corpuskit.org')
  expect(calls.length).toBe(2)
})
