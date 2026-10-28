import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { DoubleProvider, RESOURCE_ONE, RESOURCE_TWO } from './support/double-provider.ts'

// Titles long enough that their two-line clamp cuts them on a library card.
class LongTitleProvider extends DoubleProvider {
  protected override resources = [RESOURCE_ONE, RESOURCE_TWO].map((resource) => ({
    ...resource,
    title: `${resource.title}: a longer working title that runs well past two lines on a card`,
  }))
}

// The WCAG 1.4.12 values, applied as a reader's bookmarklet applies them.
const READER_SPACING = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; ' +
  'word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }'

Deno.test('clamped card text shows in full while the reader sets their own text spacing', async () => {
  const server = startTestServer({
    identity: { role: 'analyst' },
    provider: new LongTitleProvider(),
  })
  const browser = await launch()
  const page = await browser.newPage(server.url)
  const clamps = () =>
    page.evaluate(() => {
      const clamped = [...document.querySelectorAll<HTMLElement>('.rp-clamp-2, .rp-clamp-3')]
        .filter((element) => element.getClientRects().length > 0)
      return {
        spacing: document.documentElement.dataset.textSpacing ?? null,
        total: clamped.length,
        cut: clamped.filter((element) => element.scrollHeight > element.clientHeight + 1).length,
      }
    })
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${server.url}/t/marine/library`)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('h3.rp-clamp-2')].some((title) =>
        title.textContent?.includes('a longer working title')
      )
    )
    // At the portal's own spacing the design is unchanged: the titles are cut at two lines.
    const portal = await clamps()
    expect(portal.spacing).toBeNull()
    expect(portal.total).toBeGreaterThan(0)
    expect(portal.cut).toBe(portal.total)

    await page.evaluate((css: string) => {
      const style = document.createElement('style')
      style.id = 'reader-spacing'
      style.textContent = css
      document.head.append(style)
    }, { args: [READER_SPACING] })
    await page.waitForFunction(() => document.documentElement.dataset.textSpacing === 'custom')
    expect((await clamps()).cut).toBe(0)

    // Taking the reader's spacing away restores the clamps.
    await page.evaluate(() => document.getElementById('reader-spacing')?.remove())
    await page.waitForFunction(() => !document.documentElement.dataset.textSpacing)
    expect((await clamps()).cut).toBe(portal.total)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
