import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

Deno.test('Ask preserves a readable answer and contained composer beside large text rails', async () => {
  const management = {
    rephrase: () => Promise.resolve(null),
    resourceExtraction: () =>
      Promise.resolve({
        text:
          'Surveys across the southern region recorded a sustained 12% decline in abalone populations since 2019, with marine heatwaves identified as the leading stressor.',
        chars: 156,
        paragraphs: 1,
      }),
  } as unknown as BuildAppOptions['management']
  const server = startTestServer({ identity: { role: 'analyst' }, management })
  const browser = await launch(), page = await browser.newPage(server.url)
  const directory = '.planning/logs/04-19-ask-layout'
  await Deno.mkdir(directory, { recursive: true })
  try {
    for (const scheme of ['light', 'dark']) {
      for (const width of [1440, 390]) {
        server.tenants.patchBranding('marine', {
          ...server.tenants.get('marine')!.branding,
          paletteId: scheme === 'dark' ? 'observatory' : 'default',
          shape: scheme === 'dark' ? 'soft' : 'square',
          density: scheme === 'dark' ? 'spacious' : 'comfortable',
          typography: 'lexend-zilla',
        })
        await page.setViewportSize({ width, height: 960 })
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
        await page.goto(`${server.url}/t/marine/ask`)
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [scheme],
        })
        await page.goto(`${server.url}/t/marine/ask`)
        await page.waitForSelector('#ask-composer')
        await page.evaluate(async () => {
          document.documentElement.style.fontSize = '22px'
          await document.fonts.ready
        })
        await (await page.waitForSelector('#ask-composer')).click()
        await page.keyboard.type('What affects abalone populations?')
        await page.keyboard.press('Enter')
        await page.waitForSelector('button[aria-label="Copy the answer"]')
        await page.evaluate(async () => {
          await new Promise((resolve) => setTimeout(resolve, 500))
          document.querySelector('button[aria-label="Copy the answer"]')!
            .scrollIntoView({ block: 'center', behavior: 'instant' })
        })
        const metrics = await page.evaluate(() => {
          const field = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
          const form = field.closest('form')!
          const centre = document.querySelector('main[aria-label="Ask"] > div.flex')!
          const send = form.querySelector('button[type="submit"]')!
          const rect = form.getBoundingClientRect(), control = send.getBoundingClientRect()
          const copy = document.querySelector('button[aria-label="Copy the answer"]')!
          const bounds = centre.getBoundingClientRect(), copyBounds = copy.getBoundingClientRect()
          return {
            width: innerWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
            centreWidth: centre.getBoundingClientRect().width,
            composerWidth: field.getBoundingClientRect().width,
            sendContained: control.left >= rect.left && control.right <= rect.right + 1,
            toolbarContained: copyBounds.left >= bounds.left && copyBounds.right <= bounds.right,
            railWidths: ['Chat sessions', 'Sources for the latest answer'].map((label) =>
              document.querySelector(`aside[aria-label="${label}"]`)?.getBoundingClientRect()
                .width ?? 0
            ),
          }
        })
        await Deno.writeTextFile(
          `${directory}/${scheme}-${width}-22.json`,
          JSON.stringify(metrics, null, 2),
        )
        await Deno.writeFile(`${directory}/${scheme}-${width}-22.png`, await page.screenshot())
        expect(metrics.overflow).toBeLessThanOrEqual(1)
        expect(metrics.centreWidth).toBeGreaterThanOrEqual(width === 1440 ? 480 : 320)
        expect(metrics.composerWidth).toBeGreaterThanOrEqual(100)
        expect(metrics.sendContained).toBe(true)
        expect(metrics.toolbarContained).toBe(true)
        if (width === 1440) {
          for (const railWidth of metrics.railWidths) expect(railWidth).toBeGreaterThan(0)
        }
      }
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
