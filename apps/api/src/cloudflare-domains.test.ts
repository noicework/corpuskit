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
  expect(portalHostnameForSlug('research-portal')).toBe('research-portal.corpuskit.org')
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
    expect(portalHostnameForSlug(slug)).toBeNull()
  }
})

Deno.test('createCloudflareDomainProvisioner requires both Worker secrets', () => {
  expect(createCloudflareDomainProvisioner({})).toBeNull()
  expect(createCloudflareDomainProvisioner({ CLOUDFLARE_ACCOUNT_ID: 'account-id' })).toBeNull()
  expect(createCloudflareDomainProvisioner({
    CLOUDFLARE_DOMAINS_TOKEN: 'token',
  })).toBeNull()
})

Deno.test('attach is an idempotent no-op when the domain already belongs to CorpusKit', async () => {
  const existing = domain('new-portal.corpuskit.org')
  const { provisioner, requests } = harness([response([existing])])

  await expect(provisioner.attach(existing.hostname)).resolves.toEqual({
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
  expect(requests[1]?.method).toBe('PUT')
  expect(requests[1]?.headers.get('authorization')).toBe('Bearer domain-token')
  expect(await requests[1]!.json()).toEqual({
    hostname,
    service: 'corpuskit',
    zone_name: 'corpuskit.org',
  })
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
