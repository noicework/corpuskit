import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'

Deno.test('portal default stays light on a dark system while the toggle and saved choices work', async () => {
  const server = startTestServer()
  const browser = await launch()
  const page = await browser.newPage(server.url)
  const initial = server.tenants.get('marine')!.branding
  const branding = { ...initial, paletteId: 'default' as const, colourScheme: 'viewer' as const }
  const captures = '.planning/logs/operator-portal-config-theme'
  await Deno.mkdir(captures, { recursive: true })
  try {
    server.tenants.patch('marine', { branding: { ...branding, defaultColourScheme: 'light' } })
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await page.goto(`${server.url}/t/marine`)
    await page.evaluate(() => localStorage.removeItem('rp-scheme'))
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await page.evaluate(() => localStorage.removeItem('rp-scheme'))
      await page.goto(`${server.url}/t/marine`)
      await page.waitForSelector('button[aria-label="Switch to dark mode"]')
      await page.evaluate(async () => {
        document.documentElement.style.fontSize = '22px'
        await document.fonts.ready
      })
      expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('light')
      expect(await page.evaluate(() => innerWidth)).toBe(width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1)
      await Deno.writeFile(`${captures}/light-${width}.png`, await page.screenshot())
      if (width === 390) {
        await (await page.waitForSelector('button[aria-label="Open menu"]')).click()
        await (await page.waitForSelector('#mobile-nav-sheet button[aria-pressed="false"]')).click()
        await page.waitForSelector('#mobile-nav-sheet button[aria-pressed="true"]')
        await (await page.waitForSelector('button[aria-label="Close menu"]')).click()
      } else {
        await (await page.waitForSelector('button[aria-label="Switch to dark mode"]')).click()
      }
      await page.waitForSelector('button[aria-label="Switch to light mode"]')
      expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('dark')
      expect(await page.evaluate(() => localStorage.getItem('rp-scheme'))).toBe('dark')
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
      await Deno.writeFile(`${captures}/dark-${width}.png`, await page.screenshot())
      await page.goto(`${server.url}/t/marine`)
      await page.waitForSelector('button[aria-label="Switch to light mode"]')
      expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('dark')
    }
    // A saved light choice wins over a dark tenant default too.
    server.tenants.patch('marine', { branding: { ...branding, defaultColourScheme: 'dark' } })
    await page.evaluate(() => localStorage.setItem('rp-scheme', 'light'))
    await page.goto(`${server.url}/t/marine`)
    await page.waitForSelector('button[aria-label="Switch to dark mode"]')
    expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('light')
    // Existing forced light policy still hides the toggle.
    server.tenants.patch('marine', { branding: { ...branding, colourScheme: 'light' } })
    await page.goto(`${server.url}/t/marine`)
    await page.waitForSelector('.rp-tenant')
    expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('light')
    expect(await page.evaluate(() => document.querySelector('button[aria-label*="mode"]') === null))
      .toBe(true)
    // With no default and no stored choice, the existing system fallback remains.
    server.tenants.patch('marine', { branding })
    await page.evaluate(() => localStorage.removeItem('rp-scheme'))
    await page.goto(`${server.url}/t/marine`)
    await page.waitForSelector('button[aria-label="Switch to light mode"]')
    expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('dark')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
