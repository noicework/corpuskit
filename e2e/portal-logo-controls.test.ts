import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

Deno.test('logo width and hidden switcher preserve the home link without enlarged-text overflow', async () => {
  const server = startTestServer()
  const browser = await launch()
  const page = await browser.newPage(server.url)
  const source = server.tenants.get('marine')!.branding
  const logo = `data:image/svg+xml,${
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="100"><rect width="1000" height="100" fill="#367a98"/><text x="20" y="70" font-size="60" fill="white">SYNTHETIC LOGO</text></svg>',
    )
  }`
  const branding = {
    ...source,
    paletteId: 'default' as const,
    logoUrl: logo,
    logoDarkUrl: logo,
    colourScheme: 'viewer' as const,
  }
  const captures = '.planning/logs/portal-logo-controls'
  await Deno.mkdir(captures, { recursive: true })
  try {
    // The redesigned logo slot scales with the reader's font. A smaller tenant
    // cap must still win, including on phones and at an enlarged root size.
    for (const logoMaxWidth of [640, 120]) {
      server.tenants.patch('marine', {
        branding: { ...branding, logoMaxWidth, showPortalSwitcher: false },
      })
      for (const scheme of ['light', 'dark']) {
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 960 })
          await page.goto(`${server.url}/t/marine/library`)
          await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
            args: [scheme],
          })
          await page.goto(`${server.url}/t/marine/library`)
          await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>('header img')
            return image?.complete && image.naturalWidth > 0
          })
          await page.evaluate(async () => {
            document.documentElement.style.fontSize = '22px'
            await document.fonts.ready
            await new Promise((resolve) => setTimeout(resolve, 300))
          })
          const metrics = await page.evaluate(() => {
            const image = document.querySelector<HTMLImageElement>('header img')!
            const rect = image.getBoundingClientRect()
            const search = document.querySelector('header form[role="search"]')
              ?.getBoundingClientRect()
            const menu = document.querySelector('button[aria-label="Open menu"]')
              ?.getBoundingClientRect()
            const neighbour = innerWidth < 640 ? menu : search
            return {
              width: innerWidth,
              logoWidth: rect.width,
              logoHeight: rect.height,
              rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
              home: image.closest('a')?.getAttribute('href'),
              switcher: !!document.querySelector(
                'button[aria-label^="Switch portal - currently "]',
              ),
              overflow: document.documentElement.scrollWidth - innerWidth,
              overlaps: !!neighbour?.width && rect.right > neighbour.left + 1,
              src: image.getAttribute('src'),
            }
          })
          expect(metrics.width).toBe(width)
          expect(metrics.rootSize).toBe(22)
          expect(metrics.logoWidth).toBeGreaterThan(0)
          expect(metrics.logoWidth).toBeLessThanOrEqual(logoMaxWidth)
          expect(metrics.logoWidth).toBeLessThanOrEqual(
            (width === 390 ? 8.5 : 20) * metrics.rootSize,
          )
          expect(metrics.logoHeight).toBeLessThanOrEqual(
            (width === 390 ? 2.5 : 4) * metrics.rootSize,
          )
          expect(metrics.home).toBe('/t/marine')
          expect(metrics.switcher).toBe(false)
          expect(metrics.overflow).toBeLessThanOrEqual(1)
          expect(metrics.overlaps).toBe(false)
          expect(metrics.src).toBe(logo)
          await Deno.writeFile(
            `${captures}/${scheme}-${width}-${logoMaxWidth}.png`,
            await page.screenshot(),
          )
        }
      }
    }
    // Both omitted and explicit true retain the existing switcher and image styling. The switcher
    // is drawn only with another portal to go to, so a reader of both portals is signed in.
    server.setAssignment({ kind: 'portal', slug: 'grains' }, 'fixture-viewer', 'viewer')
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    for (const showPortalSwitcher of [undefined, true]) {
      server.tenants.patch('marine', { branding: { ...branding, showPortalSwitcher } })
      await page.goto(`${server.url}/t/marine/library`)
      await page.waitForSelector('button[aria-label^="Switch portal - currently "]')
      expect(
        await page.evaluate(() =>
          document.querySelector<HTMLImageElement>('header img')?.style.maxWidth
        ),
      ).toBe('')
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
