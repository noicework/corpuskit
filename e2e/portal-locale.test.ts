import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { DoubleProvider, RESOURCE_ONE, RESOURCE_TWO } from './support/double-provider.ts'

// These are authored values, including a known interface key and literal template syntax.
class AuthoredTitleProvider extends DoubleProvider {
  protected override resources = [
    { ...RESOURCE_ONE, title: 'Summary' },
    { ...RESOURCE_TWO, title: 'Original {count} and {name} research <study>' },
  ]
}

Deno.test('app locale retains explicit language across portal and platform without changing source titles', async () => {
  const server = startTestServer({
    identity: { role: 'owner' },
    provider: new AuthoredTitleProvider(),
  })
  const browser = await launch()
  const page = await browser.newPage(server.url)
  const config = server.tenants.get('marine')!
  server.tenants.patch('marine', {
    branding: { ...config.branding, colourScheme: 'viewer' },
    languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
  })
  const captures = '.planning/logs/japanese-locale-foundation'
  await Deno.mkdir(captures, { recursive: true })
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${server.url}/t/marine/library`)
    await page.waitForFunction(() => document.documentElement.lang === 'ja')
    await page.waitForSelector('button[aria-label="English"]')
    await (await page.waitForSelector('button[aria-label="English"]')).click()
    await page.waitForFunction(() => document.documentElement.lang === 'en-AU')
    expect(await page.evaluate(() => localStorage.getItem('corpuskit-ui-language-v1'))).toBe('en')
    await (await page.waitForSelector('button[aria-label="日本語"]')).click()
    await page.waitForFunction(() => document.documentElement.lang === 'ja')
    await page.goto(`${server.url}/admin`)
    await page.waitForFunction(() => document.documentElement.lang === 'ja')
    expect(await page.evaluate(() => localStorage.getItem('corpuskit-ui-language-v1'))).toBe('ja')

    for (const language of ['ja', 'en'] as const) {
      for (const scheme of ['light', 'dark']) {
        for (const width of [1440, 390]) {
          await page.evaluate((values: { language: string; scheme: string }) => {
            localStorage.setItem('corpuskit-ui-language-v1', values.language)
            localStorage.setItem('corpuskit-language-v1:marine', values.language)
            localStorage.setItem('rp-scheme', values.scheme)
          }, { args: [{ language, scheme }] })
          const preview = await browser.newPage('about:blank')
          await preview.setViewportSize({ width, height: 960 })
          await preview.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
          await preview.goto(`${server.url}/t/marine/library`)
          await preview.waitForFunction(
            (expected: string) => document.documentElement.lang === expected,
            { args: [language === 'ja' ? 'ja' : 'en-AU'] },
          )
          await preview.waitForFunction(() =>
            document.querySelector('a[href="/t/marine/library/res-2"] h3') !== null
          )
          await preview.evaluate(async () => {
            document.documentElement.style.fontSize = '22px'
            await document.fonts.ready
          })
          expect(
            await preview.evaluate(() =>
              [...document.querySelectorAll('a[href^="/t/marine/library/res-"] h3')]
                .map((heading) => heading.textContent?.trim())
            ),
          ).toEqual(['Summary', 'Original {count} and {name} research <study>'])
          expect(await preview.evaluate(() => innerWidth)).toBe(width)
          expect(await preview.evaluate(() => document.documentElement.scrollWidth - innerWidth))
            .toBeLessThanOrEqual(1)
          expect(await preview.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe(
            scheme,
          )
          expect(await preview.evaluate(() => document.querySelector('h1')?.textContent?.trim()))
            .toBe(language === 'ja' ? 'ライブラリ' : 'Library')
          expect(
            await preview.evaluate(() =>
              document.querySelector('[role="group"][aria-label="表示言語"]') !== null
            ),
          ).toBe(language === 'ja')
          await preview.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
          await Deno.writeFile(
            `${captures}/${language}-${scheme}-${width}.png`,
            await preview.screenshot(),
          )
          await preview.close()
        }
      }
    }
    // No configured Japanese default and no explicit saved choice retains ordinary English.
    server.tenants.patch('marine', {
      languagePolicy: { defaultLanguage: 'en', availableLanguages: ['en'] },
    })
    await page.evaluate(() => {
      localStorage.removeItem('corpuskit-ui-language-v1')
      localStorage.removeItem('corpuskit-language-v1:marine')
    })
    await page.goto(`${server.url}/t/marine/library`)
    await page.waitForFunction(() => document.documentElement.lang === 'en-AU')
    expect(await page.evaluate(() => document.querySelector('h1')?.textContent?.trim())).toBe(
      'Library',
    )
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
