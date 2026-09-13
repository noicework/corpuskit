import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { googleFontsUrl, tenantThemeVars } from '../apps/web/src/lib/theme.ts'

async function clickText(page: Page, text: string) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.trim() === text
    )
    if (!button) throw new Error(`Button unavailable: ${text}`)
    button.click()
  }, { args: [text] })
}

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
