import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary as captureSnapshot } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

async function click(page: Page, selector: string) {
  await (await page.waitForSelector(selector)).click()
}

async function captureBoundary(page: Page, directory: string, name: string, width: number) {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '22px'
  })
  await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 450)))
  if (name.startsWith('account-') && width === 390) {
    await page.evaluate(() =>
      document.querySelector('[role=menu]')?.scrollIntoView({ block: 'end' })
    )
  }
  await captureSnapshot(page, directory, name, width)
}

async function openAccount(page: Page, menu: boolean) {
  await page.waitForSelector('button[title="My account"]')
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>('button[title="My account"]')!.focus()
  )
  await page.keyboard.press(menu ? 'ArrowDown' : 'Enter')
  await page.waitForSelector(menu ? '[role=menu]' : '[role=dialog]')
}

Deno.test('navigation and direct generation links use permissions for every role', async () => {
  const browser = await launch()
  try {
    for (
      const role of [
        'viewer',
        'analyst',
        'curator',
        'portal-admin',
        'platform-admin',
        'owner',
      ] as const
    ) {
      const server = startTestServer({ identity: { role } })
      try {
        const page = await browser.newPage(`${server.url}/t/marine/library`)
        try {
          await page.waitForSelector('nav[aria-label=Primary]')
          const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('nav[aria-label=Primary] a')).map((a) =>
              a.textContent?.trim()
            )
          )
          expect(links.includes('Generate')).toBe(role !== 'viewer')
          expect(links).toContain('Investigations')
          await page.evaluate(() => {
            dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
          })
          await page.waitForSelector('[role=combobox]')
          const commands = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[role=option]')).map((a) => a.textContent?.trim())
          )
          expect(commands.includes('Generate')).toBe(role !== 'viewer')
          expect(commands.includes('People')).toBe(role === 'owner')
          expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
          await page.keyboard.press('Escape')
          await page.setViewportSize({ width: 390, height: 960 })
          await click(page, 'button[aria-label="Open menu"]')
          const mobileLinks = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#mobile-nav-sheet li a')).map((a) =>
              a.textContent?.replace('→', '').trim()
            )
          )
          expect(mobileLinks).toEqual(links)
          await page.keyboard.press('Escape')
          if (role === 'viewer' || role === 'analyst') {
            const before = server.requests.length
            await page.evaluate(() => {
              history.pushState(null, '', '/t/marine/manage?tab=appearance')
              dispatchEvent(new PopStateEvent('popstate'))
            })
            await page.waitForSelector('[data-route-unavailable]')
            expect(server.requests.slice(before).filter((r) => r.path.startsWith('/api/admin/')))
              .toEqual([])
          }
        } finally {
          await page.close()
        }
        const direct = await browser.newPage(`${server.url}/t/marine/generate`)
        try {
          await direct.waitForSelector(role === 'viewer' ? '[data-route-unavailable]' : 'main')
          if (role === 'viewer') {
            expect(
              server.requests.filter((r) =>
                r.path.startsWith('/api/') && r.path.includes('/generate')
              ),
            ).toEqual([])
          }
        } finally {
          await direct.close()
        }
      } finally {
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('switcher discards prior catalogues and checks the destination scope', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  try {
    for (const slug of ['marine', 'grains']) server.setAccessMode(slug, 'restricted')
    server.setAssignment({ kind: 'portal', slug: 'grains' }, 'e2e-portal-admin', 'viewer')
    server.tenants.patchBranding('grains', { productName: 'Grains private catalogue' })
    const page = await browser.newPage(`${server.url}/t/marine/library`)
    try {
      await click(page, 'button[title="Switch portal"]')
      await page.waitForSelector('[role=menu] button[role=menuitem]')
      expect(await page.evaluate(() => document.querySelector('[role=menu]')!.textContent))
        .toContain('Grains private catalogue')
      expect(await page.evaluate(() => document.querySelector('[role=menu]')!.textContent)).not
        .toContain('Add a portal')
      await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[role=menu] button')).find((b) =>
          b.textContent?.includes('Grains private catalogue')
        )!.click()
      )
      await page.waitForSelector('a[href="/t/grains/library"]')
      await openAccount(page, false)
      expect(await page.evaluate(() => document.querySelector('[role=dialog]')!.textContent))
        .toContain('Viewer')
      expect(await page.evaluate(() => document.querySelector('[role=dialog]')!.textContent)).not
        .toContain('Portal administrator')
      await page.keyboard.press('Escape')
      await page.evaluate(() => {
        history.pushState(null, '', '/t/marine/library')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForSelector('a[href="/t/marine/library"]')
      await click(page, 'button[title="Switch portal"]')
      // Let the open switcher finish its status probes under the current identity
      // before the identity changes; a probe still in flight at the flip would be
      // evaluated as the new identity and recorded as a denial.
      await page.waitForSelector('[role=menu] button[role=menuitem]')
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
      const delayed = server.delayResponse('/auth/me?portal=marine')
      server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
      await page.evaluate(() => dispatchEvent(new Event('focus')))
      await delayed.entered
      await page.waitForSelector('[data-access-state=loading]')
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Grains private catalogue',
      )
      delayed.release()
      await click(page, 'button[title="Switch portal"]')
      await page.waitForSelector('[role=menu] button[role=menuitem]')
      expect(await page.evaluate(() => document.querySelector('[role=menu]')!.textContent)).not
        .toContain('Grains private catalogue')
      expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('navigation commands and switcher remain readable in both token schemes', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const browser = await launch()
  try {
    for (const scheme of ['light', 'dark'] as const) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      for (const width of [1440, 390]) {
        const page = await browser.newPage(`${server.url}/t/marine/library`)
        try {
          await page.setViewportSize({ width, height: 960 })
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
          await page.waitForSelector('a[href="/t/marine/library/res-1"]')
          await assertCurrentBuild(page)
          if (width === 390) await click(page, 'button[aria-label="Open menu"]')
          await captureBoundary(page, '.planning/logs/04-04-03', `nav-${scheme}-${width}`, width)
          if (width === 390) await page.keyboard.press('Escape')
          await click(page, 'button[title="Switch portal"]')
          await captureBoundary(
            page,
            '.planning/logs/04-04-03',
            `switcher-${scheme}-${width}`,
            width,
          )
          await page.keyboard.press('Escape')
          await page.evaluate(() =>
            dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
          )
          await page.waitForSelector('[role=combobox]')
          await page.keyboard.type('Generate')
          await captureBoundary(
            page,
            '.planning/logs/04-04-03',
            `commands-${scheme}-${width}`,
            width,
          )
        } finally {
          await page.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('signed accounts display selected roles and preserve profile keyboard access', async () => {
  const server = startTestServer()
  const browser = await launch()
  try {
    server.setAccessMode('marine', 'restricted')
    server.setAccessMode('grains', 'restricted')
    for (const role of ['viewer', 'portal-admin', 'platform-admin', 'owner'] as const) {
      server.setIdentity(
        fixtureSession({
          oid: `fixture-${role}`,
          roles: role === 'owner'
            ? ['CorpusKit.Owner']
            : role === 'platform-admin'
            ? ['CorpusKit.PlatformAdmin']
            : [],
        }),
      )
      const page = await browser.newPage(`${server.url}/t/marine/library`)
      try {
        await page.setViewportSize({ width: 1440, height: 960 })
        await openAccount(page, role !== 'viewer')
        await assertCurrentBuild(page)
        if (role !== 'viewer') {
          const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[role=menu] a')).map((a) =>
              a.getAttribute('href')
            )
          )
          expect(links.includes('/admin/people')).toBe(role === 'owner')
          expect(links).toContain('/t/marine/manage')
          await page.waitForSelector('[role=menu] [role=menuitem]')
          await page.keyboard.press('End')
          expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
            'Profile',
          )
          await page.keyboard.press('Enter')
          await page.waitForSelector('[role=dialog]')
        }
        const text = await page.evaluate(() => document.querySelector('[role=dialog]')!.textContent)
        expect(text).toContain(role === 'viewer' ? 'Viewer' : 'Portal administrator')
        expect(text).toContain(
          role === 'viewer' || role === 'portal-admin' ? 'Local assignment' : 'Entra app role',
        )
        expect(text).not.toContain('grains')
        expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
          'Close',
        )
        await page.keyboard.down('Shift')
        await page.keyboard.press('Tab')
        await page.keyboard.up('Shift')
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
          'Sign out',
        )
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
          'Close',
        )
        await page.keyboard.press('Escape')
        expect(await page.evaluate(() => document.querySelector('[role=dialog]'))).toBe(null)
      } finally {
        await page.close()
      }
    }
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    const denied = await browser.newPage(`${server.url}/t/grains/library`)
    try {
      await denied.waitForSelector('[data-access-state=denied]')
      await denied.evaluate(() =>
        Array.from(document.querySelectorAll('button')).find((b) =>
          b.textContent?.trim() === 'Profile'
        )!.focus()
      )
      await denied.keyboard.press('Enter')
      await denied.waitForSelector('section[aria-label=Profile]')
      expect(await denied.evaluate(() => !!document.querySelector('a[href="/auth/logout"]'))).toBe(
        true,
      )
      expect(
        server.requests.filter((r) =>
          r.path.startsWith('/api/t/grains/') && r.path !== '/api/t/grains/config'
        ),
      ).toEqual([])
    } finally {
      await denied.close()
    }
    for (const status of [200, 503]) {
      server.setResponseStatus('/auth/me?portal=marine', status)
      const failed = await browser.newPage(`${server.url}/t/marine/library`)
      try {
        await failed.waitForSelector('[data-access-state=failed]')
        expect(await failed.evaluate(() => document.body.innerText)).not.toContain('Viewer')
        expect(await failed.evaluate(() => document.querySelector('[role=menu]'))).toBe(null)
      } finally {
        await failed.close()
      }
      server.setResponseStatus('/auth/me?portal=marine', null)
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('account profile follows tenant tokens at wide and real mobile viewports', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  try {
    for (const scheme of ['light', 'dark'] as const) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      for (const width of [1440, 390]) {
        const page = await browser.newPage(`${server.url}/t/marine/library`)
        try {
          await page.setViewportSize({ width, height: 960 })
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
          await page.waitForSelector('button[title="My account"]')
          if (width === 390) {
            await (await page.waitForSelector('button[aria-label="Open menu"]')).click()
            await page.waitForSelector('#mobile-nav-sheet button[title="My account"]')
            await (await page.waitForSelector('#mobile-nav-sheet button[title="My account"]'))
              .click()
          } else await openAccount(page, true)
          await page.waitForSelector('[role=menu]')
          await captureBoundary(
            page,
            '.planning/logs/04-04-02',
            `account-${scheme}-${width}`,
            width,
          )
          await page.keyboard.press('End')
          await page.keyboard.press('Enter')
          await page.waitForSelector('[role=dialog]')
          await captureBoundary(
            page,
            '.planning/logs/04-04-02',
            `profile-${scheme}-${width}`,
            width,
          )
          const tokens = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('[role=dialog]')!
            const style = getComputedStyle(el)
            return {
              radius: style.borderRadius,
              expectedRadius: style.getPropertyValue('--rp-radius').trim(),
              height: el.getBoundingClientRect().height,
              viewport: innerHeight,
            }
          })
          expect(tokens.radius).toBe(tokens.expectedRadius)
          expect(tokens.height).toBeLessThan(tokens.viewport)
        } finally {
          await page.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})
