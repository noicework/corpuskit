import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'

Deno.test('portal creation attaches and persists a hostname under the runtime platform domain', async () => {
  const attached: string[] = []
  const f = createEnforcementFixture({
    platformDomain: 'research.example',
    domainProvisioner: {
      attach: (hostname) => {
        attached.push(hostname)
        return Promise.resolve({ hostname, created: true })
      },
      detach: (hostname) => Promise.resolve({ hostname, removed: true }),
    },
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
