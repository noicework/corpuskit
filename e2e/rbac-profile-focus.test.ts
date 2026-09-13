import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'

Deno.test('Profile Escape restores the visible account or mobile menu launcher', async () => {
  const server = startTestServer({ identity: { role: 'owner' } })
  const browser = await launch(), page = await browser.newPage(server.url)
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await page.goto(`${server.url}/t/marine/library`)
      if (width === 390) {
        await (await page.waitForSelector('button[aria-label="Open menu"]')).click()
      }
      const selector = width === 390
        ? '#mobile-nav-sheet button[title="My account"]'
        : 'header button[title="My account"]'
      await (await page.waitForSelector(selector)).click()
      await page.waitForSelector('[role=menu]')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[role=dialog]')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[role=dialog]'))
      const focused = await page.evaluate(() => ({
        title: document.activeElement?.getAttribute('title'),
        label: document.activeElement?.getAttribute('aria-label'),
        visible: (document.activeElement as HTMLElement)?.offsetWidth > 0,
      }))
      expect(width === 390 ? focused.label : focused.title).toBe(
        width === 390 ? 'Open menu' : 'My account',
      )
      expect(focused.visible).toBe(true)
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
