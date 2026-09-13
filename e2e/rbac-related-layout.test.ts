import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'

Deno.test('related resource titles remain readable at large text in the narrow reader rail', async () => {
  const server = startTestServer({ identity: { role: 'viewer' } })
  const browser = await launch(), page = await browser.newPage(server.url)
  try {
    for (const scheme of ['light', 'dark']) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 })
        await page.goto(`${server.url}/t/marine/library/res-1`)
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [scheme],
        })
        await page.goto(`${server.url}/t/marine/library/res-1`)
        await page.waitForSelector('aside a[href="/t/marine/library/res-2"]')
        await page.evaluate(async () => {
          document.documentElement.style.fontSize = '22px'
          await document.fonts.ready
          document.querySelector('aside a[href="/t/marine/library/res-2"]')!
            .scrollIntoView({ block: 'center', behavior: 'instant' })
        })
        const metrics = await page.evaluate(() => {
          const link = document.querySelector('aside a[href="/t/marine/library/res-2"]')!
          const title = link.querySelector('p')!, topic = link.querySelector('.rp-badge span')!
          const t = title.getBoundingClientRect(), r = link.getBoundingClientRect()
          return {
            width: innerWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
            title: title.textContent,
            titleHeight: title.clientHeight,
            titleScrollHeight: title.scrollHeight,
            topicWidth: topic.clientWidth,
            topicScrollWidth: topic.scrollWidth,
            contained: t.left >= r.left && t.right <= r.right && t.bottom <= r.bottom,
          }
        })
        const directory = '.planning/logs/04-19-related-fix'
        await Deno.mkdir(directory, { recursive: true })
        await Deno.writeFile(`${directory}/${scheme}-${width}-22.png`, await page.screenshot())
        await Deno.writeTextFile(
          `${directory}/${scheme}-${width}-22.json`,
          JSON.stringify(metrics, null, 2),
        )
        expect(metrics.width).toBe(width)
        expect(metrics.overflow).toBeLessThanOrEqual(1)
        expect(metrics.titleHeight).toBeGreaterThanOrEqual(metrics.titleScrollHeight)
        expect(metrics.topicScrollWidth).toBeLessThanOrEqual(metrics.topicWidth + 1)
        expect(metrics.contained).toBe(true)
      }
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
