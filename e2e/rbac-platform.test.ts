import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { googleFontsUrl, tenantThemeVars } from '../apps/web/src/lib/theme.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

async function clickText(page: Page, text: string) {
  await page.evaluate((text) => {
    const buttons = [...document.querySelectorAll('button')]
    const button = buttons.find((button) => button.textContent?.trim() === text) ??
      buttons.find((button) =>
        [...button.querySelectorAll('span')].some((span) => span.textContent?.trim() === text)
      )
    if (!button) throw new Error(`Button unavailable: ${text}`)
    button.click()
  }, { args: [text] })
}

async function fill(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const input = document.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector, value] })
}

async function selectMigration(page: Page, from: string, to: string) {
  for (const [id, value] of [['migrate-from', from], ['migrate-to', to]]) {
    await page.evaluate((id, value) => {
      const select = document.getElementById(id) as HTMLSelectElement
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, { args: [id!, value!] })
  }
}

function migrationService() {
  const copied: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => {
      if (method === 'listResources') {
        return async () => [{ id: 'source', title: 'Verified migration resource' }]
      }
      if (method === 'resourceFull') {
        return async () => ({
          slug: 'source',
          title: 'Verified migration resource',
          texts: [{ body: 'Research text' }],
          topicIds: [],
          extraMetadata: {},
        })
      }
      if (method === 'hasSlug') {
        return async () => false
      }
      if (method === 'createText') {
        return async (tenant: { slug: string }) => {
          copied.push(tenant.slug)
          return { id: 'copied' }
        }
      }
      return async () => {
        throw new Error(`Unexpected management operation: ${String(method)}`)
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  return { copied, management }
}

Deno.test('owner migration needs both independent scopes and clears results on selection and access changes', async () => {
  const service = migrationService()
  const server = startTestServer({ identity: { role: 'owner' }, management: service.management })
  const destination = server.tenants.add({ name: 'Migration destination' }).slug
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await page.waitForSelector('[data-migrate-panel]')
    await clickText(page, 'Migrate resources')
    const delayed = server.delayResponse(`/auth/me?portal=${destination}`)
    await selectMigration(page, 'marine', destination)
    await delayed.entered
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.trim() === 'Run migration'
        )?.disabled
      ),
    ).toBe(true)
    expect(server.requests.some((r) => r.path === '/api/admin/migrate')).toBe(false)
    delayed.release()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.trim() === 'Run migration' && !b.disabled
      )
    )
    await clickText(page, 'Run migration')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Copied 1, skipped 0, 0 errors.')
    )
    expect(service.copied).toEqual([destination])
    expect(server.requests.some((r) => r.path === '/auth/me?portal=marine')).toBe(true)
    expect(server.requests.some((r) => r.path === `/auth/me?portal=${destination}`)).toBe(true)
    expect(server.requests.some((r) => r.path === '/api/admin/migrate' && r.status === 200)).toBe(
      true,
    )
    await selectMigration(page, destination, 'marine')
    expect(await page.evaluate(() => document.body.textContent?.includes('Copied 1,'))).toBe(false)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.trim() === 'Run migration' && !b.disabled
      )
    )
    const late = server.delayResponse('/api/admin/migrate')
    await clickText(page, 'Run migration')
    await late.entered
    await selectMigration(page, 'marine', destination)
    await selectMigration(page, destination, 'marine')
    late.release()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 120)))
    expect(await page.evaluate(() => document.body.textContent?.includes('Copied 1,'))).toBe(false)
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-admin-unavailable]')
    expect(await page.$('[data-migrate-panel]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('owner reduced or failed source and destination snapshots never permit migration or replace page authority', async () => {
  const browser = await launch()
  try {
    for (const blocked of ['marine', 'migration-destination']) {
      const service = migrationService()
      const server = startTestServer({
        identity: { role: 'owner' },
        management: service.management,
        breakGlass: true,
      })
      server.tenants.add({ name: 'Migration destination' })
      const page = await browser.newPage(`${server.url}/admin`)
      try {
        await page.waitForSelector('[data-migrate-panel]')
        await page.evaluate((blocked) => {
          const original = globalThis.fetch.bind(globalThis)
          globalThis.fetch = async (input, init) => {
            const response = await original(input, init)
            if (String(input) === `/auth/me?portal=${blocked}`) {
              const snapshot = await response.json()
              snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter((
                p: string,
              ) => p !== 'content.write')
              return Response.json(snapshot)
            }
            return response
          }
        }, { args: [blocked] })
        await clickText(page, 'Migrate resources')
        await selectMigration(page, 'marine', 'migration-destination')
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)))
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll('button')].some((b) =>
              b.textContent?.trim() === 'Run migration' && !b.disabled
            )
          ),
        ).toBe(false)
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll('button')].some((b) =>
              b.textContent?.trim() === 'Run migration'
            )
          ),
        ).toBe(false)
        expect(server.requests.some((r) => r.path === '/api/admin/migrate')).toBe(false)
        expect(await page.$('[role=dialog]')).toBeNull()
        expect(await page.$('[data-add-portal]')).not.toBeNull()
        expect(service.copied).toEqual([])
      } finally {
        await page.close()
        await server.close()
      }
    }
    const server = startTestServer({ identity: { role: 'owner' } })
    server.tenants.add({ name: 'Migration destination' })
    server.setResponseStatus('/auth/me?portal=migration-destination', 503)
    const page = await browser.newPage(`${server.url}/admin`)
    try {
      await page.waitForSelector('[data-migrate-panel]')
      await clickText(page, 'Migrate resources')
      await selectMigration(page, 'marine', 'migration-destination')
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)))
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('button')].some((b) =>
            b.textContent?.trim() === 'Run migration' && !b.disabled
          )
        ),
      ).toBe(false)
      expect(await page.$('[data-add-portal]')).not.toBeNull()
    } finally {
      await page.close()
      await server.close()
    }
  } finally {
    await browser.close()
  }
})

Deno.test('new portal validation and server failures never refresh or retry and authority loss clears the form', async () => {
  const server = startTestServer({ identity: { role: 'platform-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await page.waitForSelector('[data-add-portal]')
    await clickText(page, 'Add a knowledge box')
    await fill(page, '#portal-name', '!!!')
    const before = server.requests.filter((r) => r.path === '/api/admin/overview').length
    await clickText(page, 'Add portal')
    await page.waitForSelector('[data-add-portal] [role=alert]')
    expect(server.requests.filter((r) => r.path === '/api/admin/tenants')).toHaveLength(1)
    expect(server.requests.filter((r) => r.path === '/api/admin/overview')).toHaveLength(before)
    expect(
      await page.evaluate(() => document.querySelector<HTMLInputElement>('#portal-name')?.value),
    ).toBe('!!!')
    server.setResponseStatus('/api/admin/tenants', 500)
    await fill(page, '#portal-name', 'Unconfirmed portal')
    await clickText(page, 'Add portal')
    await page.waitForSelector('[data-add-portal] [role=alert]')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.trim() === 'Add portal' && !b.disabled
      )
    )
    expect(server.requests.filter((r) => r.path === '/api/admin/overview')).toHaveLength(before)
    expect(server.requests.filter((r) => r.path === '/api/admin/tenants')).toHaveLength(2)
    expect(
      await page.evaluate(() => document.querySelector<HTMLInputElement>('#portal-name')?.value),
    ).toBe('Unconfirmed portal')
    server.setResponseStatus('/api/admin/tenants', null)
    const late = server.delayResponse('/api/admin/tenants')
    await fill(page, '#portal-name', 'Late creation')
    await clickText(page, 'Add portal')
    await late.entered
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-admin-unavailable]')
    late.release()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(await page.$('#portal-name')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent?.includes('Late creation'))).toBe(
      false,
    )
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('platform-admin creates a server-named portal without owner migration controls', async () => {
  const attached: string[] = []
  const server = startTestServer({
    identity: { role: 'platform-admin' },
    breakGlass: true,
    domainProvisioner: {
      attach: async (hostname) => {
        attached.push(hostname)
        return { hostname, created: true }
      },
      detach: async (hostname) => ({ hostname, removed: true }),
    },
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await page.waitForSelector('[data-admin-overview]')
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) =>
          b.textContent?.includes('Migrate resources')
        )
      ),
    ).toBe(false)
    await clickText(page, 'Add a knowledge box')
    await page.evaluate(() => document.querySelector<HTMLInputElement>('#portal-name')?.focus())
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('portal-org')
    await fill(page, '#portal-name', 'New research fixture')
    await fill(page, '#portal-org', 'Research organisation')
    await fill(page, '#portal-tagline', 'A useful research portal')
    await clickText(page, 'Add portal')
    await page.waitForSelector('[data-portal-row=new-research-fixture]')
    expect(server.tenants.get('new-research-fixture')?.branding.organisation).toBe(
      'Research organisation',
    )
    expect(attached).toEqual(['new-research-fixture.corpuskit.org'])
    expect(server.requests.some((r) => r.path === '/auth/me?portal=new-research-fixture')).toBe(
      false,
    )
    expect(server.requests.filter((r) => r.path === '/api/admin/tenants' && r.method === 'POST'))
      .toHaveLength(1)
    expect(await page.$('input[name=hostname]')).toBeNull()
    const denied = await page.evaluate(async () =>
      (await fetch('/api/admin/migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'marine', to: 'agriculture' }),
      })).status
    )
    expect(denied).toBe(403)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

async function openRow(page: Page, slug: string) {
  await page.waitForSelector(`[data-portal-row="${slug}"]`)
  await page.evaluate(
    (slug) =>
      document.querySelector<HTMLButtonElement>(`[data-portal-row="${slug}"] > button`)!.click(),
    { args: [slug] },
  )
  await page.waitForSelector(`[data-portal-actions="${slug}"]`)
}

Deno.test('platform overview does not grant deletion and disabled recovery has only narrow enable', async () => {
  const browser = await launch()
  try {
    for (const role of ['platform-admin', 'owner'] as const) {
      const server = startTestServer({ identity: { role } })
      const custom = server.tenants.add({ name: 'Lifecycle fixture' })
      server.tenants.setDisabled('marine', true)
      const page = await browser.newPage(`${server.url}/admin`)
      try {
        await assertCurrentBuild(page)
        await openRow(page, custom.slug)
        await page.waitForSelector('[data-portal-connections]')
        expect(await page.$('[data-portal-remove]') !== null).toBe(role === 'owner')
        await openRow(page, 'marine')
        await page.waitForSelector('[data-portal-enable]')
        expect(await page.$('[data-portal-connections]')).toBeNull()
        expect(await page.$('[data-portal-remove]')).toBeNull()
        expect(await page.$('[data-portal-actions] a')).toBeNull()
        expect((await fetch(`${server.url}/api/t/marine/resources`)).status).toBe(403)
        await clickText(page, 'Enable')
        await page.waitForFunction(() => {
          const row = document.querySelector('[data-portal-row=marine]')
          return !!row && !row.textContent?.includes('Hidden') &&
            !row.querySelector('[data-portal-enable]')
        })
        await openRow(page, 'marine')
        await page.waitForSelector('[data-portal-disable]')
        expect(server.tenants.isDisabled('marine')).toBe(false)
        expect(
          server.requests.some((r) => r.path === '/api/admin/t/marine/enable' && r.status === 200),
        ).toBe(true)
        expect(server.requests.some((r) => r.path === '/auth/me?portal=marine')).toBe(true)
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('scoped portal admin connections work without estate overview and clear on access loss', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  server.bindings.set('marine', {
    baseUrl: 'https://fixture.invalid/api/v1/kb/one',
    token: 'fixture-only',
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=connections`)
  try {
    await page.waitForSelector('[data-portal-connections]')
    await clickText(page, 'Revert to demo box')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Reverted to the demo knowledge box.')
    )
    expect(
      server.requests.some((r) =>
        r.path === '/api/admin/t/marine/knowledge-box' && r.method === 'DELETE' && r.status === 200
      ),
    ).toBe(true)
    await (await page.waitForSelector('#kb-id-marine')).type(
      'https://fixture.invalid/api/v1/kb/one',
    )
    await (await page.waitForSelector('#kb-token-marine')).type('test-form-secret')
    expect(server.requests.some((r) => r.path === '/api/admin/overview')).toBe(false)
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-route-unavailable]')
    expect(await page.$('[data-portal-connections]')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent?.includes('test-form-secret'))).toBe(
      false,
    )
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('owner deletion detaches only with current portal domain permission', async () => {
  const detached: string[] = []
  const server = startTestServer({
    identity: { role: 'owner' },
    domainProvisioner: {
      attach: async (hostname) => ({ hostname, created: true }),
      detach: async (hostname) => {
        detached.push(hostname)
        return { hostname, removed: true }
      },
    },
  })
  const custom = server.tenants.add({ name: 'Remove fixture' })
  server.tenants.patch(custom.slug, { hostname: 'remove-fixture.corpuskit.org' })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await openRow(page, custom.slug)
    await page.waitForSelector('[data-portal-remove]')
    await page.evaluate(() => {
      globalThis.confirm = () => false
    })
    await clickText(page, 'Remove')
    expect(detached).toEqual([])
    await page.evaluate(() => {
      globalThis.confirm = () => true
    })
    await clickText(page, 'Remove')
    await page.waitForFunction(() => !document.querySelector('[data-portal-row=remove-fixture]'))
    expect(detached).toEqual(['remove-fixture.corpuskit.org'])
    expect(server.tenants.get(custom.slug)).toBeUndefined()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('row scopes fail closed independently and collapse discards connection credentials and late results', async () => {
  const server = startTestServer({ identity: { role: 'owner' } })
  server.bindings.set('marine', {
    baseUrl: 'https://fixture.invalid/api/v1/kb/one',
    token: 'fixture-only',
  })
  const custom = server.tenants.add({ name: 'Scoped fixture' })
  server.tenants.patch(custom.slug, { hostname: 'scoped-fixture.corpuskit.org' })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await openRow(page, 'marine')
    await page.waitForSelector('[data-portal-connections]')
    await (await page.waitForSelector('#kb-token-marine')).type('discard-me')
    const delay = server.delayResponse('/api/admin/t/marine/knowledge-box')
    await clickText(page, 'Revert to demo box')
    await delay.entered
    await openRow(page, custom.slug)
    delay.release()
    await page.waitForSelector('[data-portal-connections]')
    expect(await page.evaluate(() => document.body.textContent?.includes('Reverted to'))).toBe(
      false,
    )
    await openRow(page, 'marine')
    await page.waitForSelector('#kb-token-marine')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('#kb-token-marine')?.value
      ),
    ).toBe('')
    await page.evaluate(() => {
      const original = globalThis.fetch.bind(globalThis)
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (String(input).startsWith('/auth/me?portal=')) {
          const snapshot = await response.json()
          snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter((
            p: string,
          ) =>
            !['bindings.write', 'domains.write', 'appearance.write', 'behaviour.write'].includes(p)
          )
          return Response.json(snapshot)
        }
        return response
      }
      dispatchEvent(new Event('focus'))
    })
    await page.waitForSelector('[data-admin-overview]')
    await openRow(page, custom.slug)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(await page.$('[data-portal-connections]')).toBeNull()
    expect(await page.$('[data-portal-remove]')).toBeNull()
    expect(await page.$('[data-portal-disable]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('platform connections and disabled row fit light dark wide and actual390 at22px', async () => {
  const browser = await launch()
  try {
    for (const dark of [false, true]) {
      const server = startTestServer({ identity: { role: 'owner' } })
      server.tenants.setDisabled('marine', true)
      const custom = server.tenants.add({ name: 'Visual connections' })
      const page = await browser.newPage(`${server.url}/admin`)
      try {
        await openRow(page, custom.slug)
        await page.waitForSelector('[data-portal-connections]')
        const branding = {
          ...server.tenants.get(custom.slug)!.branding,
          paletteId: dark ? 'observatory' as const : 'default' as const,
          shape: 'soft' as const,
          density: 'spacious' as const,
          typography: 'lexend-zilla' as const,
        }
        await page.evaluate((vars, font) => {
          document.body.classList.add('rp-tenant')
          Object.assign(document.body.style, vars)
          for (const [key, value] of Object.entries(vars)) {
            document.body.style.setProperty(key, String(value))
          }
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = font
          document.head.append(link)
        }, { args: [tenantThemeVars(branding), googleFontsUrl('lexend-zilla')] })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 960 })
          await page.evaluate(() =>
            document.querySelector('[data-portal-actions]')?.scrollIntoView()
          )
          await captureBoundary(
            page,
            '.planning/logs/04-08-01',
            `connections-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
          await page.evaluate(() =>
            document.querySelector('[data-portal-connections]')?.scrollIntoView()
          )
          await captureBoundary(
            page,
            '.planning/logs/04-08-01',
            `form-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
        }
        await openRow(page, 'marine')
        await page.waitForSelector('[data-portal-enable]')
        for (const width of [1440, 390]) {
          await page.evaluate(() =>
            document.querySelector('[data-portal-actions]')?.scrollIntoView()
          )
          await captureBoundary(
            page,
            '.planning/logs/04-08-01',
            `disabled-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
        }
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('portal creation and migration results fit inherited appearance at wide and actual390 light dark22px', async () => {
  const browser = await launch()
  try {
    for (const dark of [false, true]) {
      const service = migrationService()
      const server = startTestServer({
        identity: { role: 'owner' },
        management: service.management,
      })
      const destination = server.tenants.add({ name: 'Migration destination' }).slug
      const page = await browser.newPage(`${server.url}/admin`)
      try {
        await page.waitForSelector('[data-add-portal]')
        await assertCurrentBuild(page)
        const branding = {
          ...server.tenants.get(destination)!.branding,
          paletteId: dark ? 'observatory' as const : 'default' as const,
          shape: 'soft' as const,
          density: 'spacious' as const,
          typography: 'lexend-zilla' as const,
        }
        await page.evaluate((vars, font) => {
          document.body.classList.add('rp-tenant')
          Object.assign(document.body.style, vars)
          for (const [key, value] of Object.entries(vars)) {
            document.body.style.setProperty(key, String(value))
          }
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = font
          document.head.append(link)
        }, { args: [tenantThemeVars(branding), googleFontsUrl('lexend-zilla')] })
        await clickText(page, 'Add a knowledge box')
        await fill(page, '#portal-name', 'New research portal')
        await fill(page, '#portal-org', 'Research organisation')
        await fill(page, '#portal-tagline', 'Research for a resilient future')
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 960 })
          await page.evaluate(() => document.querySelector('[data-add-portal]')?.scrollIntoView())
          await captureBoundary(
            page,
            '.planning/logs/04-08-02',
            `creation-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
        }
        await clickText(page, 'Migrate resources')
        await selectMigration(page, 'marine', destination)
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some((b) =>
            b.textContent?.trim() === 'Run migration' && !b.disabled
          )
        )
        await clickText(page, 'Run migration')
        await page.waitForFunction(() =>
          document.body.textContent?.includes('Copied 1, skipped 0, 0 errors.')
        )
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 960 })
          await page.evaluate(() =>
            document.querySelector('[data-migrate-panel]')?.scrollIntoView()
          )
          await captureBoundary(
            page,
            '.planning/logs/04-08-02',
            `migration-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
        }
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})
