import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'

const directory = '.planning/logs/04-13-01'
async function click(page: Page, label: string, selector = 'button') {
  await page.evaluate((label, selector) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) =>
      b.textContent?.trim() === label
    )
    if (!button) throw new Error(`Missing ${label}`)
    button.focus()
    button.click()
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
      const rect = document.querySelector(selector)!.getBoundingClientRect()
      return rect.top >= 0 && rect.top < innerHeight
    }, { args: [selector] }),
  ).toBe(true)
}
async function selectMode(page: Page, mode: string) {
  await page.evaluate(
    (mode) =>
      document.querySelector<HTMLInputElement>(`[data-access-mode] input[value="${mode}"]`)!
        .click(),
    { args: [mode] },
  )
  await click(page, 'Save access mode')
  await page.waitForSelector('dialog[open]')
}

Deno.test('portal groups use actual capability, scoped CRUD and disabled mapping removal', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  server.setGroupCapability(true)
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-assignment-section=groups] [data-assignment-editor]')
    await assertCurrentBuild(page)
    await click(page, 'Add group mapping')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLSelectElement>(
          '[data-assignment-section=groups] [data-assignment-role]',
        )!.value
      ),
    ).toBe('viewer')
    await input(
      page,
      '[data-assignment-section=groups] [data-assignment-subject]',
      'group-with-a-long-object-id-for-research-access-and-layout-verification',
    )
    await click(page, 'Add group mapping')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-section=groups] form') &&
      !!document.querySelector('[data-assignment-section=groups] [data-assignment-id]')
    )
    await click(page, 'Edit role', '[data-assignment-section=groups] button')
    await input(page, '[data-assignment-section=groups] [data-assignment-role]', 'analyst')
    await click(page, 'Save role')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-section=groups] form') &&
      document.querySelector('[data-assignment-section=groups]')?.textContent?.includes('Analyst')
    )
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/manage?tab=access`)
      await page.waitForSelector('[data-assignment-section=groups] [data-assignment-id]')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `groups-${scheme}-${width}`,
          width,
          '[data-assignment-section=groups] h3',
        )
      }
      await click(page, 'Add group mapping')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `group-form-${scheme}-${width}`,
          width,
          '[data-assignment-section=groups] form h3',
        )
      }
      await click(page, 'Keep mapping')
      for (const width of [1440, 390]) {
        await capture(page, `mode-${scheme}-${width}`, width, '[data-access-mode] h3')
        await capture(page, `mode-controls-${scheme}-${width}`, width, '[data-access-mode] button')
      }
      await selectMode(page, 'restricted')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Keep current mode',
      )
      for (const width of [1440, 390]) {
        await capture(page, `mode-confirm-${scheme}-${width}`, width, 'dialog h2')
      }
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Save access mode',
      )
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
      for (const width of [1440, 390]) {
        await capture(
          page,
          `disabled-groups-${scheme}-${width}`,
          width,
          '[data-assignment-section=groups] h3',
        )
        await capture(
          page,
          `inactive-row-${scheme}-${width}`,
          width,
          '[data-assignment-section=groups] [data-assignment-id] button',
        )
      }
      server.setGroupCapability(true)
      await page.evaluate(() => dispatchEvent(new Event('focus')))
      await page.waitForFunction(() =>
        document.querySelector('[data-assignment-section=groups]')?.textContent?.includes(
          'Add group mapping',
        )
      )
    }
    server.setGroupCapability(false)
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.querySelector('[data-assignment-section=groups]')?.textContent?.includes(
        'Inactive group mapping',
      )
    )
    await click(page, 'Remove mapping')
    await click(page, 'Remove mapping', 'dialog button')
    await page.waitForFunction(() =>
      document.querySelector('[data-assignment-section=groups]')?.textContent?.includes(
        'No group mappings',
      )
    )
    const calls = server.requests.filter((r) => r.path.includes('/groups') && r.method !== 'GET')
    expect(calls.map((r) => [r.method, r.status])).toEqual([['POST', 201], ['PATCH', 200], [
      'DELETE',
      200,
    ]])
    await page.evaluate(() => {
      const original = fetch
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (String(input).endsWith('/groups')) {
          await response.body?.cancel()
          return Response.json({ items: [], capability: 'unknown' })
        }
        return response
      }
      dispatchEvent(new Event('focus'))
    })
    await page.waitForSelector('[data-assignment-section=groups] [role=alert]')
    expect(await page.$('[data-assignment-section=groups] [data-assignment-editor]')).toBeNull()
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-assignment-section=groups]')?.textContent
      ),
    ).toContain('Group mappings are unavailable')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('member and behaviour permissions independently gate groups and mode controls', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    for (const removed of ['members.manage', 'behaviour.write']) {
      await page.goto(`${server.url}/t/marine/manage?tab=access`)
      await page.waitForSelector('[data-access-mode]')
      const before = server.requests.length
      await page.evaluate((removed) => {
        const original = fetch
        globalThis.fetch = async (input, init) => {
          const response = await original(input, init)
          if (!String(input).startsWith('/auth/me')) return response
          const snapshot = await response.json()
          snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter((
            p: string,
          ) => p !== removed)
          return Response.json(snapshot)
        }
        dispatchEvent(new Event('focus'))
      }, { args: [removed] })
      await page.waitForSelector('[data-access-panel]')
      if (removed === 'members.manage') {
        await page.waitForSelector('[data-access-mode]')
        expect(await page.$('[data-assignment-section]')).toBeNull()
        expect(server.requests.slice(before).filter((r) => /\/(members|groups)/.test(r.path)))
          .toHaveLength(0)
      } else {
        await page.waitForSelector('[data-assignment-section=groups]')
        expect(await page.$('[data-access-mode]')).toBeNull()
      }
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('mode changes wait for confirmation, refresh uncertain results, and clear protected state before denied recovery', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-access-mode]')
    await selectMode(page, 'authenticated')
    expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
    const patch = server.delayResponse('/api/admin/t/marine/access')
    await click(page, 'Change access mode', 'dialog button')
    await patch.entered
    expect(
      await page.evaluate(() => document.querySelector('[data-current-access-mode]')?.textContent),
    ).toBe('Current mode: Public')
    patch.release()
    await page.waitForFunction(() =>
      document.querySelector('[data-current-access-mode]')?.textContent ===
        'Current mode: Organisation sign-in'
    )
    server.setResponseStatus('/api/admin/t/marine/access', 500)
    const before = server.requests.length
    await selectMode(page, 'public')
    expect(await page.evaluate(() => document.querySelector('dialog')?.textContent)).toContain(
      'accessible without sign-in',
    )
    await click(page, 'Change access mode', 'dialog button')
    await page.waitForSelector('[data-access-mode] [role=alert]')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-access-mode] [role=alert]')?.textContent
      ),
    ).toContain('could not be confirmed')
    expect(
      await page.evaluate(() => document.querySelector('[data-current-access-mode]')?.textContent),
    ).toBe('Current mode: Public')
    expect(server.requests.slice(before).filter((r) => r.method === 'PATCH')).toHaveLength(1)
    expect(server.requests.slice(before).some((r) => r.path === '/api/t/marine/config')).toBe(true)
    server.setResponseStatus('/api/admin/t/marine/access', null)
    const delayed = server.delayResponse('/api/admin/t/marine/access')
    await selectMode(page, 'restricted')
    await click(page, 'Change access mode', 'dialog button')
    await delayed.entered
    server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-portal-admin', null)
    const refresh = server.delayResponse('/auth/me?portal=marine')
    delayed.release()
    await refresh.entered
    await page.waitForFunction(() => !document.querySelector('[data-access-panel]'))
    expect(await page.$('dialog')).toBeNull()
    expect(await page.$('[data-assignment-editor]')).toBeNull()
    refresh.release()
    await page.waitForSelector('[data-access-state=denied]')
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'pending@example.test',
    )
    expect(await page.$('[data-manage-shell]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
