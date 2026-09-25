import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import type { PortalDomainProvisioner } from './cloudflare-domains.ts'

function recordingProvisioner(attached: string[], created = true): PortalDomainProvisioner {
  return {
    attach: (hostname) => {
      attached.push(hostname)
      return Promise.resolve({ hostname, created })
    },
    detach: (hostname) => Promise.resolve({ hostname, removed: true }),
  }
}

Deno.test('portal creation attaches and persists a hostname under the runtime platform domain', async () => {
  const attached: string[] = []
  const f = createEnforcementFixture({
    platformDomain: 'research.example',
    domainProvisioner: recordingProvisioner(attached),
  })
  try {
    const response = await f.requestAs(f.sessionFor('owner'), '/api/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Research team' }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).domain.hostname).toBe('research-team.research.example')
    expect(attached).toEqual(['research-team.research.example'])
    expect(f.stores.tenants.get('research-team')?.hostname).toBe('research-team.research.example')
  } finally {
    f.close()
  }
})

Deno.test('a showcase slug on another platform domain attaches its own hostname', async () => {
  const attached: string[] = []
  const f = createEnforcementFixture({
    platformDomain: 'research.example',
    domainProvisioner: recordingProvisioner(attached),
  })
  try {
    const response = await f.requestAs(f.sessionFor('owner'), '/api/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'OPAX' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      slug: 'opax',
      domain: { status: 'active', hostname: 'opax.research.example', created: true },
    })
    expect(attached).toEqual(['opax.research.example'])
    expect(f.stores.tenants.get('opax')?.hostname).toBe('opax.research.example')

    // Seeded portals carry no showcase hostname on this deployment, so no link leaves it.
    for (const slug of ['marine', 'grains']) {
      expect(f.stores.tenants.get(slug)?.hostname).toBeUndefined()
    }
    const hostnames = f.stores.tenants.list(true).map((tenant) => tenant.hostname)
    expect(hostnames.filter((hostname) => hostname?.endsWith('corpuskit.org'))).toEqual([])
    const listed = await f.requestAs(f.sessionFor('owner'), '/api/tenants')
    expect(listed.status).toBe(200)
    expect(await listed.text()).not.toContain('corpuskit.org')
  } finally {
    f.close()
  }
})

Deno.test('a showcase slug on the showcase domain still verifies its domain attachment', async () => {
  const attached: string[] = []
  const f = createEnforcementFixture({
    platformDomain: 'corpuskit.org',
    domainProvisioner: recordingProvisioner(attached, false),
  })
  try {
    const response = await f.requestAs(f.sessionFor('owner'), '/api/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'OPAX' }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).domain).toEqual({
      status: 'active',
      hostname: 'opax.corpuskit.org',
      created: false,
    })
    expect(attached).toEqual(['opax.corpuskit.org'])
    expect(f.stores.tenants.get('marine')?.hostname).toBe('marine.corpuskit.org')
  } finally {
    f.close()
  }
})
