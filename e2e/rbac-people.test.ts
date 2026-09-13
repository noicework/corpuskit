import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { BrandingSchema } from '@research-portal/core'
import { googleFontsUrl, tenantThemeVars } from '../apps/web/src/lib/theme.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'

const directory = '.planning/logs/04-13-02'
async function click(page: Page, label: string, selector = 'button') {
  await page.evaluate((label, selector) => {
    const b = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) =>
      b.textContent?.trim() === label
    )
    if (!b) throw new Error(`Missing ${label}`)
    b.focus()
    b.click()
  }, { args: [label, selector] })
}
async function input(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const el = document.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(
      el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }, { args: [selector, value] })
}
async function rowAction(page: Page, subject: string, action: string) {
  await page.waitForFunction(
    (subject) =>
      [...document.querySelectorAll('[data-assignment-id]')].some((r) =>
        r.querySelector('p')?.textContent === subject
      ),
    { args: [subject] },
  )
  await page.evaluate((subject, action) => {
    const row = [...document.querySelectorAll('[data-assignment-id]')].find((r) =>
      r.querySelector('p')?.textContent === subject
    )!
    const button = [...row.querySelectorAll('button')].find((b) => b.textContent === action)!
    button.focus()
    button.click()
  }, { args: [subject, action] })
}
async function theme(page: Page, dark: boolean) {
  const branding = BrandingSchema.parse({
    productName: 'CorpusKit',
    organisation: 'Research platform',
    tagline: 'Research access',
    colours: { primary: '#193a50', accent: '#66b7d0', heroFrom: '#193a50', heroTo: '#193a50' },
    paletteId: dark ? 'observatory' : 'default',
    shape: dark ? 'soft' : 'square',
    density: 'comfortable',
    typography: 'lexend-zilla',
  })
  await page.evaluate((vars, url) => {
    document.body.classList.add('rp-tenant')
    for (const [key, value] of Object.entries(vars)) {
      document.body.style.setProperty(key === 'colorScheme' ? 'color-scheme' : key, String(value))
    }
    if (!document.querySelector('[data-people-test-font]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = url
      link.dataset.peopleTestFont = ''
      document.head.append(link)
    }
  }, { args: [tenantThemeVars(branding), googleFontsUrl('lexend-zilla')] })
}
async function capture(page: Page, name: string, width: number, selector: string) {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async (selector) => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
    document.querySelector(selector)!.scrollIntoView({ block: 'center' })
  }, { args: [selector] })
  await captureBoundary(page, directory, name, width)
  expect(
    await page.evaluate((selector) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return r.top >= 0 && r.top < innerHeight
    }, { args: [selector] }),
  ).toBe(true)
}
async function saved(page: Page, text: string) {
  await page.waitForFunction(
    (text) =>
      !!document.querySelector('[data-people]') &&
      !document.querySelector('[data-assignment-editor] form') &&
      !!document.querySelector('[data-people]')?.textContent?.includes(text),
    { args: [text] },
  )
}

Deno.test('People manages local platform members, confirms Owner and preserves last active owner', async () => {
  const server = startTestServer()
  server.setIdentity(fixtureSession({ oid: 'fixture-owner-one' }))
  server.setAssignment({ kind: 'platform' }, 'fixture-owner-two', null)
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin/people`)
  try {
    await page.bringToFront()
    await page.waitForSelector('main h1')
    expect(await page.evaluate(() => document.querySelector('main h1')?.textContent)).toBe('People')
    await page.waitForSelector('[data-people] [data-assignment-editor]')
    await assertCurrentBuild(page)
    expect(server.requests.some((r) => r.path === '/api/admin/overview')).toBe(false)
    for (const dark of [false, true]) {
      await theme(page, dark)
      const scheme = dark ? 'dark' : 'light'
      for (const width of [1440, 390]) {
        await capture(page, `people-${scheme}-${width}`, width, 'main h1')
      }
      await rowAction(page, 'fixture-owner-one', 'Edit role')
      await input(page, '[data-assignment-role]', 'platform-admin')
      expect(
        await page.evaluate(() => document.querySelector('[data-platform-role-help]')?.textContent),
      ).toBe('Platform administrator access applies to all present and future portals.')
      await click(page, 'Save role')
      await page.waitForSelector('[data-assignment-editor] form [role=alert]')
      expect(await page.evaluate(() => document.querySelector('[role=alert]')?.textContent))
        .toContain('final active owner')
      expect(await page.evaluate(() => document.querySelector('[data-assignment-id]')?.textContent))
        .toContain('Owner')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `last-owner-${scheme}-${width}`,
          width,
          '[data-assignment-editor] form h3',
        )
      }
      await click(page, 'Keep current role')
      await click(page, 'Add platform member')
      expect(
        await page.evaluate(() =>
          document.querySelector<HTMLSelectElement>('[data-assignment-role]')!.value
        ),
      ).toBe('platform-admin')
      await input(
        page,
        '[data-assignment-subject]',
        'pending-platform-person-with-research-responsibilities@organisation.example.test',
      )
      for (const width of [1440, 390]) {
        await capture(
          page,
          `platform-form-${scheme}-${width}`,
          width,
          '[data-assignment-editor] form h3',
        )
      }
      for (const width of [1440, 390]) {
        await capture(page, `role-help-${scheme}-${width}`, width, '[data-platform-role-help]')
      }
      await input(page, '[data-assignment-role]', 'owner')
      const before = server.requests.length
      await click(page, 'Add platform member')
      await page.waitForSelector('dialog[open]')
      expect(server.requests.slice(before).filter((r) => r.method === 'POST')).toHaveLength(0)
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Keep current role',
      )
      for (const width of [1440, 390]) {
        await capture(page, `owner-confirm-${scheme}-${width}`, width, 'dialog h2')
      }
      await page.keyboard.press('Escape')
      await click(page, 'Close member form')
    }
    await click(page, 'Add platform member')
    await input(page, '[data-assignment-subject]', 'pending-owner@example.test')
    await input(page, '[data-assignment-role]', 'owner')
    await click(page, 'Add platform member')
    await click(page, 'Grant Owner', 'dialog button')
    await saved(page, 'pending-owner@example.test')
    expect(await page.evaluate(() => document.querySelector('[data-people]')?.textContent))
      .toContain('Pending sign-in')
    await rowAction(page, 'fixture-owner-one', 'Remove member')
    await click(page, 'Remove member', 'dialog button')
    await page.waitForSelector('dialog [role=alert]')
    expect(await page.evaluate(() => document.querySelector('dialog [role=alert]')?.textContent))
      .toContain('final active owner')
    await click(page, 'Keep member', 'dialog button')
    await click(page, 'Add platform member')
    await input(page, '[data-assignment-section=members] form select', 'active-oid')
    await input(page, '[data-assignment-subject]', 'new-active-owner')
    await input(page, '[data-assignment-role]', 'owner')
    await click(page, 'Add platform member')
    await click(page, 'Grant Owner', 'dialog button')
    await saved(page, 'new-active-owner')
    await rowAction(page, 'pending-owner@example.test', 'Remove member')
    await click(page, 'Remove member', 'dialog button')
    await page.waitForFunction(() =>
      !!document.querySelector('[data-people]') &&
      !document.body.textContent?.includes('pending-owner@example.test')
    )
    await rowAction(page, 'fixture-owner-one', 'Edit role')
    await input(page, '[data-assignment-role]', 'platform-admin')
    await click(page, 'Save role')
    await page.waitForSelector('[data-people-unavailable]')
    expect(await page.$('[data-assignment-editor]')).toBeNull()
    expect(await page.$('a[href="/admin/people"]')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('new-active-owner')
    expect(server.requests.filter((r) => r.status === 409)).toHaveLength(3)
    expect(
      server.requests.filter((r) => r.method === 'POST' && r.path === '/api/admin/people').map((
        r,
      ) => r.status),
    ).toEqual([201, 201])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('platform groups share exact role, capability and cross-scope contracts', async () => {
  const server = startTestServer({ identity: { role: 'owner' } })
  server.setGroupCapability(true)
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin/people`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-assignment-section=groups] [data-assignment-editor]')
    await click(page, 'Add group mapping')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLSelectElement>(
          '[data-assignment-section=groups] [data-assignment-role]',
        )!.value
      ),
    ).toBe('platform-admin')
    await input(
      page,
      '[data-assignment-section=groups] [data-assignment-subject]',
      'platform-group-with-a-long-object-id-for-layout-and-scope-verification',
    )
    await click(page, 'Add group mapping')
    await saved(page, 'platform-group-with-a-long')
    await click(page, 'Edit role', '[data-assignment-section=groups] button')
    await input(page, '[data-assignment-section=groups] [data-assignment-role]', 'owner')
    await click(page, 'Save role')
    await click(page, 'Grant Owner', 'dialog button')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-section=groups] form') &&
      document.querySelector('[data-assignment-section=groups]')?.textContent?.includes('Owner')
    )
    const statuses = await page.evaluate(async () => {
      const members = await (await fetch('/api/admin/t/marine/members')).json()
      const people = await (await fetch('/api/admin/people')).json()
      const groups = await (await fetch('/api/admin/groups')).json()
      const paths = [
        `/api/admin/people/${members.items[0].id}`,
        `/api/admin/t/marine/members/${people.items[0].id}`,
        `/api/admin/people/${groups.items[0].id}`,
      ]
      return await Promise.all(paths.map(async (path) => {
        const r = await fetch(path, { method: 'DELETE' })
        await r.text()
        return r.status
      }))
    })
    expect(statuses).toEqual([404, 404, 404])
    server.setGroupCapability(false)
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.querySelector('[data-assignment-section=groups]')?.textContent?.includes(
        'Inactive group mapping',
      )
    )
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-assignment-section=groups] button')].map((b) =>
          b.textContent
        )
      ),
    ).toEqual(['Remove mapping'])
    for (const dark of [false, true]) {
      await theme(page, dark)
      for (const width of [1440, 390]) {
        await capture(
          page,
          `platform-groups-${dark ? 'dark' : 'light'}-${width}`,
          width,
          '[data-assignment-section=groups] [data-assignment-id]',
        )
      }
      await click(page, 'Remove mapping')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `mapping-remove-${dark ? 'dark' : 'light'}-${width}`,
          width,
          'dialog h2',
        )
      }
      await click(page, 'Keep mapping', 'dialog button')
    }
    await click(page, 'Remove mapping')
    await click(page, 'Remove mapping', 'dialog button')
    await page.waitForFunction(() =>
      document.querySelector('[data-assignment-section=groups]')?.textContent?.includes(
        'No group mappings',
      )
    )
    expect(
      server.requests.filter((r) => r.path.startsWith('/api/admin/groups') && r.method !== 'GET')
        .map((r) => [r.method, r.status]),
    ).toEqual([['POST', 201], ['PATCH', 200], ['DELETE', 200]])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('platform administrator and portal administrator cannot see or load People', async () => {
  const server = startTestServer({ identity: { role: 'platform-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-admin-overview]')
    expect(await page.$('a[href="/admin/people"]')).toBeNull()
    for (const roles of [['CorpusKit.PlatformAdmin'], []]) {
      server.setIdentity(
        fixtureSession({ oid: roles.length ? 'platform-admin' : 'fixture-portal-admin', roles }),
      )
      const before = server.requests.length
      await page.goto(`${server.url}/admin/people`)
      await page.waitForSelector('[data-people-unavailable]')
      expect(await page.$('[data-assignment-editor]')).toBeNull()
      expect(
        server.requests.slice(before).some((r) =>
          r.path === '/api/admin/people' || r.path === '/api/admin/groups'
        ),
      ).toBe(false)
      for (const dark of [false, true]) {
        await theme(page, dark)
        for (const width of [1440, 390]) {
          await capture(
            page,
            `denied-${roles.length ? 'platform' : 'portal'}-${dark ? 'dark' : 'light'}-${width}`,
            width,
            'main h1',
          )
        }
      }
    }
    server.setIdentity(fixtureSession({ roles: ['CorpusKit.Owner'] }))
    await page.goto(`${server.url}/admin`)
    await page.waitForSelector('a[href="/admin/people"]')
    for (const dark of [false, true]) {
      await theme(page, dark)
      for (const width of [1440, 390]) {
        await capture(
          page,
          `admin-nav-${dark ? 'dark' : 'light'}-${width}`,
          width,
          'nav[aria-label="Platform administration"]',
        )
      }
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
