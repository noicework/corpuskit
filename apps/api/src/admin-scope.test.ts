import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { authoriseNewPortalDomain, selectRequestAuthority } from './authorisation.ts'
import type { Suggestion } from './interrogate.ts'

const json = (method: string, body: unknown = {}) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('administrative IDs resolve inside the authorised portal before mutation', async () => {
  const calls: string[] = []
  const management = {
    listAgents: () => Promise.resolve([{ id: 'task-a' }]),
    deleteAgent: () => {
      calls.push('deleteAgent')
      return Promise.resolve()
    },
    setResourceHidden: () => {
      calls.push('setResourceHidden')
      return Promise.resolve()
    },
    resourceContent: () => {
      calls.push('resourceContent')
      return Promise.resolve(null)
    },
    updateLabelset: () => {
      calls.push('updateLabelset')
      return Promise.resolve()
    },
  } as unknown as AragProvider
  const fixture = createEnforcementFixture({ management })
  try {
    const source = fixture.stores.sources.add('b', 'https://example.test/foreign', true)
    const rows: [string, string, unknown][] = [
      ['PATCH', `sources/${source.id}`, { auto: false }],
      ['DELETE', `sources/${source.id}`, {}],
      ['POST', `sources/${source.id}/sync`, {}],
      ['POST', 'suggestions/foreign/implement', {}],
      ['POST', 'suggestions/foreign/ignore', {}],
      ['DELETE', 'agents/task-b', {}],
      ['POST', 'resources/foreign/hidden', { hidden: true }],
      ['POST', 'resources/foreign/enrich', {}],
      ['PUT', 'labelsets/foreign', {
        title: 'Topic',
        multiple: true,
        labels: [{ title: 'Research', text: '' }],
      }],
    ]
    for (const [method, path, body] of rows) {
      const response = await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        `/api/admin/t/a/${path}`,
        json(method, body),
      )
      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
      expect(calls).toEqual([])
      const events = fixture.rbac.audit.read({
        scope: { kind: 'portal', slug: 'a' },
        requestId: response.headers.get('x-request-id')!,
      })
      expect(events.filter((event) => event.action === 'request.denied')).toHaveLength(1)
    }
    expect(fixture.stores.sources.find('b', source.id)?.auto).toBe(true)
  } finally {
    fixture.close()
  }
})

Deno.test('appearance patches reject undeclared fields without partial writes', async () => {
  const fixture = createEnforcementFixture()
  try {
    const before = fixture.stores.tenants.get('a')
    for (const field of ['accessMode', 'scope', 'tenant', 'slug', 'hostname', 'prompts']) {
      const response = await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        '/api/admin/tenants/a',
        json('PATCH', { name: 'Must not persist', [field]: 'b' }),
      )
      expect(response.status, field).toBe(400)
      expect(fixture.stores.tenants.get('a')).toEqual(before)
    }
    fixture.failAudit()
    expect(
      (await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        '/api/admin/tenants/a',
        json('PATCH', { name: 'Must not persist', searchPlaceholder: 'New search prompt' }),
      )).status,
    ).toBe(500)
    expect(fixture.stores.tenants.get('a')).toEqual(before)
  } finally {
    fixture.close()
  }
})

Deno.test('unknown administrative object denial cannot bypass a failed required audit', async () => {
  const fixture = createEnforcementFixture()
  try {
    fixture.database.exec(
      "CREATE TRIGGER fail_denial BEFORE INSERT ON audit_events WHEN NEW.action = 'request.denied' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    const response = await fixture.requestAs(
      fixture.sessionFor('curator'),
      '/api/admin/t/a/sources/foreign',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'audit_write_failed' })
    fixture.assertNoProtectedDispatch()
  } finally {
    fixture.close()
  }
})

Deno.test('mixed appearance and behaviour changes use one atomic local mutation', async () => {
  for (const fail of [false, true]) {
    const fixture = createEnforcementFixture()
    try {
      const before = fixture.stores.tenants.get('a')!
      if (fail) {
        fixture.database.exec(
          "CREATE TRIGGER fail_patch BEFORE INSERT ON audit_events WHEN NEW.action = 'local.mutation' AND NEW.detail_json LIKE '%tenants.patch%' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
        )
      }
      const response = await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        '/api/admin/tenants/a',
        json('PATCH', { name: 'Renamed', searchPlaceholder: 'Search research evidence' }),
      )
      expect(response.status).toBe(fail ? 500 : 200)
      const current = fixture.stores.tenants.get('a')!
      if (fail) expect(current).toEqual(before)
      else {
        expect(current.branding).toEqual({ ...before.branding, productName: 'Renamed' })
        expect(current.searchPlaceholder).toBe('Search research evidence')
        const events = fixture.rbac.audit.read({
          scope: { kind: 'portal', slug: 'a' },
          requestId: response.headers.get('x-request-id')!,
        })
        expect(events.filter((event) => event.action === 'local.mutation')).toHaveLength(1)
        for (const action of ['tenant.appearance.update', 'tenant.behaviour.update']) {
          expect(events.some((event) => event.action === action && event.outcome === 'success'))
            .toBe(true)
        }
      }
    } finally {
      fixture.close()
    }
  }
})

Deno.test('resource fields, binding and migration bodies cannot redirect the authorised portal', async () => {
  const calls: string[] = []
  const fixture = createEnforcementFixture({
    management: {
      resourceContent: () => Promise.resolve({ id: 'res-1', files: [{ fieldId: 'file-a' }] }),
      setResourceHidden: () => {
        calls.push('hidden')
        return Promise.resolve()
      },
      listResources: () => {
        calls.push('list')
        return Promise.resolve([])
      },
    } as unknown as AragProvider,
  })
  const fetchBefore = globalThis.fetch
  try {
    globalThis.fetch = (() => {
      calls.push('fetch')
      throw new Error('Unexpected network call')
    }) as typeof fetch
    const owner = fixture.sessionFor('owner')
    expect(
      (await fixture.requestAs(
        owner,
        '/api/admin/t/a/resources/res-1/hidden?fieldId=file-b',
        json('POST', { hidden: true }),
      )).status,
    ).toBe(404)
    expect(calls).toEqual([])
    expect(
      (await fixture.requestAs(
        owner,
        '/api/admin/t/a/resources/res-1/hidden?fieldId=file-a',
        json('POST', { hidden: true }),
      )).status,
    ).toBe(200)
    expect(calls.splice(0)).toEqual(['hidden'])
    for (
      const extra of [{ slug: 'b' }, { tenant: { slug: 'b' } }, {
        scope: { kind: 'portal', slug: 'b' },
      }]
    ) {
      expect(
        (await fixture.requestAs(
          owner,
          '/api/admin/t/a/knowledge-box',
          json('POST', {
            url: 'https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/fixture-knowledge-box',
            token: 'fixture-service-account-token',
            ...extra,
          }),
        )).status,
      ).toBe(400)
      expect(
        (await fixture.requestAs(
          owner,
          '/api/admin/migrate',
          json('POST', { from: 'a', to: 'b', ...extra }),
        )).status,
      ).toBe(400)
      expect(
        (await fixture.requestAs(
          owner,
          '/api/admin/tenants',
          json('POST', { name: 'New portal', ...extra }),
        )).status,
      ).toBe(400)
    }
    fixture.stores.tenants.setDisabled('b', true)
    expect(
      (await fixture.requestAs(owner, '/api/admin/migrate', json('POST', { from: 'a', to: 'b' })))
        .status,
    ).toBe(403)
    expect(calls).toEqual([])
  } finally {
    globalThis.fetch = fetchBefore
    fixture.close()
  }
})

Deno.test('suggestions validate stored kinds and scoped payloads before declared sub-actions', async () => {
  const calls: string[] = []
  const example = {
    text: 'Abalone live in southern waters.',
    entities: [{ name: 'Abalone', label: 'Species' }, { name: 'southern waters', label: 'Region' }],
    relations: [{ source: 'Abalone', target: 'southern waters', label: 'inhabits' }],
  }
  const fixture = createEnforcementFixture({
    management: {
      labelsets: () =>
        Promise.resolve([{ id: 'topic', title: 'Topic', labels: ['Research'], multiple: true }]),
      createLabelset: () => {
        calls.push('taxonomy')
        return Promise.resolve()
      },
      graphStrategy: () =>
        Promise.resolve({
          entityDefs: [{ label: 'Species' }, { label: 'Region' }],
          examples: Array.from({ length: 6 }, () => example),
        }),
      augmentationModel: () => Promise.resolve('fixture-model'),
      listAgents: () => Promise.resolve([]),
      startAgent: () => {
        calls.push('graph')
        return Promise.resolve()
      },
    } as unknown as AragProvider,
  })
  try {
    const base = {
      id: 'suggestion',
      title: 'Improve taxonomy',
      detail: 'Research',
      status: 'pending' as const,
      createdAt: '2026-09-12T00:00:00Z',
    }
    const variants: Suggestion[] = [
      {
        ...base,
        kind: 'labelset',
        labelset: { id: 'species', title: 'Species', paragraphs: false, labels: ['Abalone'] },
      },
      { ...base, kind: 'label-addition', labels: { labelsetId: 'topic', labels: ['Research'] } },
      { ...base, kind: 'entity-type', entityType: { label: 'Animal', description: 'Species' } },
      { ...base, kind: 'graph-example', example },
    ]
    for (const suggestion of variants) {
      fixture.stores.suggestions.replacePending('a', [suggestion])
      const response = await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        '/api/admin/t/a/suggestions/suggestion/implement',
        json('POST'),
      )
      expect(response.status).toBe(200)
      const kind = suggestion.kind.startsWith('label') ? 'taxonomy' : 'graph'
      expect(calls.splice(0)).toEqual([kind])
      const events = fixture.rbac.audit.read({
        scope: { kind: 'portal', slug: 'a' },
        requestId: response.headers.get('x-request-id')!,
      })
      expect(
        events.some((event) =>
          event.action === `suggestion.${kind}.write` && event.outcome === 'success'
        ),
      ).toBe(true)
      expect(fixture.stores.suggestions.list('a').find((item) => item.id === 'suggestion')?.status)
        .toBe('implemented')
    }
    for (
      const payload of [{ ...base, kind: 'unknown' }, { ...base, kind: 'labelset' }, {
        ...variants[0],
        labelset: { ...variants[0]!.labelset, scope: { slug: 'b' } },
      }, {
        ...base,
        kind: 'label-addition',
        labels: { labelsetId: 'foreign', labels: ['Research'] },
      }]
    ) {
      fixture.stores.suggestions.replacePending('a', [payload as Suggestion])
      expect(
        (await fixture.requestAs(
          fixture.sessionFor('portal-admin'),
          '/api/admin/t/a/suggestions/suggestion/implement',
          json('POST'),
        )).status,
      ).toBe(404)
      expect(calls).toEqual([])
    }
    fixture.stores.suggestions.replacePending('a', [variants[0]!])
    expect(
      (await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        '/api/admin/t/a/suggestions/suggestion/implement',
        json('POST', { payload: { slug: 'b' } }),
      )).status,
    ).toBe(400)
    expect(calls).toEqual([])
    fixture.database.exec(
      "CREATE TRIGGER fail_subaction BEFORE INSERT ON audit_events WHEN NEW.action = 'suggestion.taxonomy.write' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect(
      (await fixture.requestAs(
        fixture.sessionFor('portal-admin'),
        '/api/admin/t/a/suggestions/suggestion/implement',
        json('POST'),
      )).status,
    ).toBe(500)
    expect(calls).toEqual([])
  } finally {
    fixture.close()
  }
})

Deno.test('future domain authority is limited to selected platform create authority and exact new slug', async () => {
  const fixture = createEnforcementFixture()
  try {
    for (const role of ['owner', 'platform-admin', 'portal-admin', 'curator'] as const) {
      const request = new Request('http://localhost/api/admin/tenants', { method: 'POST' })
      const authority = await selectRequestAuthority(
        request,
        await fixture.contextFor(fixture.sessionFor(role)),
        fixture.authorityDependencies(),
      )
      if (role === 'owner' || role === 'platform-admin') {
        expect(authoriseNewPortalDomain(authority, 'new-portal')).toBe(true)
      } else expect(() => authoriseNewPortalDomain(authority, 'new-portal')).toThrow()
    }
    for (
      const [method, path, slug] of [
        ['GET', '/api/admin/tenants', 'new'],
        ['POST', '/api/admin/migrate', 'new'],
        ['POST', '/api/admin/tenants', 'a'],
        ['POST', '/api/admin/tenants', '../b'],
      ]
    ) {
      const authority = await selectRequestAuthority(
        new Request(`http://localhost${path}`, { method }),
        await fixture.contextFor(fixture.sessionFor('owner')),
        fixture.authorityDependencies(),
      )
      expect(() => authoriseNewPortalDomain(authority, slug)).toThrow()
    }
    expect(fixture.stores.tenants.get('new-portal')).toBeUndefined()
  } finally {
    fixture.close()
  }
})

Deno.test('domain and binding delete bodies cannot redirect targets; detach failures never remove the portal', async () => {
  for (const mode of ['body', 'audit', 'remote'] as const) {
    const calls: string[] = []
    const fixture = createEnforcementFixture({
      domainProvisioner: {
        attach: (hostname) => Promise.resolve({ hostname, created: true }),
        detach: () => {
          calls.push('detach')
          return Promise.reject(new Error('Uncertain detach'))
        },
      },
    })
    try {
      const owner = fixture.sessionFor('owner')
      if (mode === 'body') {
        for (const path of ['/api/admin/tenants/a', '/api/admin/t/a/knowledge-box']) {
          expect(
            (await fixture.requestAs(owner, path, json('DELETE', { tenant: { slug: 'b' } })))
              .status,
          ).toBe(400)
        }
        expect(calls).toEqual([])
      } else {
        if (mode === 'audit') {
          fixture.database.exec(
            "CREATE TRIGGER fail_detach BEFORE INSERT ON audit_events WHEN NEW.action = 'tenant.domain.detach' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
          )
        }
        const response = await fixture.requestAs(owner, '/api/admin/tenants/a', {
          method: 'DELETE',
        })
        expect(response.status).toBe(mode === 'audit' ? 500 : 502)
        expect(calls).toEqual(mode === 'audit' ? [] : ['detach'])
        if (mode === 'remote') {
          expect(
            fixture.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } }).some((event) =>
              event.action === 'tenant.domain.detach' && event.outcome === 'uncertain'
            ),
          ).toBe(true)
        }
      }
      expect(fixture.stores.tenants.get('a')).toBeDefined()
      expect(fixture.stores.tenants.get('b')).toBeDefined()
    } finally {
      fixture.close()
    }
  }
})

Deno.test('domain creation allocates the final suffixed slug before attaching', async () => {
  const calls: string[] = []
  const fixture = createEnforcementFixture({
    domainProvisioner: {
      attach: (hostname) => {
        calls.push(hostname)
        return Promise.resolve({ hostname, created: true })
      },
      detach: (hostname) => Promise.resolve({ hostname, removed: true }),
    },
  })
  try {
    const response = await fixture.requestAs(
      fixture.sessionFor('platform-admin'),
      '/api/admin/tenants',
      json('POST', { name: 'A' + ' ' }),
    )
    expect(response.status).toBe(200)
    expect((await response.json()).slug).toBe('a-2')
    expect(calls).toEqual(['a-2.corpuskit.org'])
    expect(
      fixture.rbac.audit.read({ scope: { kind: 'portal', slug: 'a-2' } }).some((event) =>
        event.action === 'tenant.domain.attach' && event.outcome === 'success'
      ),
    ).toBe(true)
  } finally {
    fixture.close()
  }
})

Deno.test('domain attach, detach and compensation retain required portal audit and fail closed', async () => {
  for (
    const mode of [
      'success',
      'denied',
      'intent-failure',
      'completion-failure',
      'remote-failure',
      'compensation',
    ] as const
  ) {
    const calls: string[] = []
    const fixture = createEnforcementFixture({
      domainProvisioner: {
        attach: (hostname) => {
          calls.push(`attach:${hostname}`)
          return mode === 'remote-failure'
            ? Promise.reject(new Error('Remote outcome unknown'))
            : Promise.resolve({ hostname, created: true })
        },
        detach: (hostname) => {
          calls.push(`detach:${hostname}`)
          return Promise.resolve({ hostname, removed: true })
        },
      },
    })
    try {
      if (mode === 'intent-failure' || mode === 'completion-failure') {
        fixture.database.exec(
          `CREATE TRIGGER fail_domain BEFORE INSERT ON audit_events WHEN NEW.action = 'tenant.domain.attach' AND NEW.outcome = '${
            mode === 'intent-failure' ? 'intent' : 'success'
          }' BEGIN SELECT RAISE(ABORT, 'fixture'); END`,
        )
      }
      if (mode === 'compensation') {
        fixture.database.exec(
          "CREATE TRIGGER fail_hostname BEFORE INSERT ON audit_events WHEN NEW.action = 'local.mutation' AND NEW.detail_json LIKE '%tenants.patch%' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
        )
      }
      const response = await fixture.requestAs(
        fixture.sessionFor(mode === 'denied' ? 'portal-admin' : 'platform-admin'),
        '/api/admin/tenants',
        json('POST', { name: 'New domain' }),
      )
      expect(response.status).toBe(
        mode === 'denied'
          ? 403
          : ['intent-failure', 'completion-failure', 'compensation'].includes(mode)
          ? 500
          : 200,
      )
      if (mode === 'denied' || mode === 'intent-failure') expect(calls).toEqual([])
      else expect(calls[0]).toBe('attach:new-domain.corpuskit.org')
      const events = fixture.rbac.audit.read({
        scope: { kind: 'portal', slug: 'new-domain' },
        limit: 1000,
      })
      if (mode === 'success') {
        expect(fixture.stores.tenants.get('new-domain')?.hostname).toBe('new-domain.corpuskit.org')
        expect(
          events.filter((event) => event.action === 'tenant.domain.attach').map((event) =>
            event.outcome
          ).sort(),
        ).toEqual(['intent', 'success'])
        const deniedDelete = await fixture.requestAs(
          fixture.sessionFor('platform-admin'),
          '/api/admin/tenants/new-domain',
          { method: 'DELETE' },
        )
        expect(deniedDelete.status).toBe(403)
        expect(calls).toHaveLength(1)
        expect(
          (await fixture.requestAs(fixture.sessionFor('owner'), '/api/admin/tenants/new-domain', {
            method: 'DELETE',
          })).status,
        ).toBe(200)
        expect(calls[1]).toBe('detach:new-domain.corpuskit.org')
        expect(fixture.stores.tenants.get('new-domain')).toBeUndefined()
        expect(
          fixture.rbac.audit.read({ scope: { kind: 'portal', slug: 'new-domain' } }).some((event) =>
            event.action === 'tenant.domain.detach' && event.outcome === 'success'
          ),
        ).toBe(true)
      }
      if (mode === 'remote-failure') {
        expect((await response.json()).domain.status).toBe('failed')
        expect(
          events.some((event) =>
            event.action === 'tenant.domain.attach' && event.outcome === 'uncertain'
          ),
        ).toBe(true)
      }
      if (mode === 'compensation') {
        expect(calls).toEqual([
          'attach:new-domain.corpuskit.org',
          'detach:new-domain.corpuskit.org',
        ])
        expect(fixture.stores.tenants.get('new-domain')?.hostname).toBeUndefined()
        expect(
          events.some((event) =>
            event.action === 'tenant.domain.detach' && event.outcome === 'success'
          ),
        ).toBe(true)
      }
    } finally {
      fixture.close()
    }
  }
})
