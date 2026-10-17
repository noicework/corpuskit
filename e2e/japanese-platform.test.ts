import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { DOC_PAGES } from '@research-portal/core'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

const captureRoot = '.planning/logs/japanese-platform'

async function prepareCapture(page: Page) {
  // Chromium pauses animation frames in hidden tabs, and activation does not
  // guarantee visibility after repeated captures. Fonts and synchronous layout
  // can be ready in a background page; CDP screenshots supply the paint boundary.
  await page.bringToFront()
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '22px'
  })
  await page.waitForFunction(() =>
    document.fonts.status === 'loaded' &&
    getComputedStyle(document.documentElement).fontSize === '22px'
  )
}

Deno.test('platform capture measures a backgrounded page and captures its activated layout without waiting for an animation frame', async () => {
  const browser = await launch()
  const page = await browser.newPage('about:blank', { waitUntil: 'load' })
  const foreground = await browser.newPage('about:blank', { waitUntil: 'load' })
  try {
    await page.setViewportSize({ width: 390, height: 240 })
    await page.evaluate(() => {
      document.body.style.cssText = 'margin:0;background:#121316;color:#f2f3f5'
      document.body.innerHTML = '<main>日本語 background capture</main>'
    })
    await foreground.bringToFront()
    await page.waitForFunction(() => document.visibilityState === 'hidden')
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')
    await prepareCapture(page)
    // Hidden pages have usable DOM/font layout; screenshot compositing needs
    // the activated target on this Chromium build.
    await foreground.bringToFront()
    await page.waitForFunction(() => document.visibilityState === 'hidden')
    expect(
      await page.evaluate(() => ({
        visibility: document.visibilityState,
        fonts: document.fonts.status,
        size: getComputedStyle(document.documentElement).fontSize,
      })),
    ).toEqual({ visibility: 'hidden', fonts: 'loaded', size: '22px' })
    await page.bringToFront()
    await page.waitForFunction(() => document.visibilityState === 'visible')
    const png = await page.screenshot({ captureBeyondViewport: false })
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png.length).toBeGreaterThan(100)
    await Deno.mkdir(captureRoot, { recursive: true })
    await Deno.writeFile(`${captureRoot}/background-layout-regression.png`, png)
  } finally {
    await foreground.close()
    await page.close()
    await browser.close()
  }
})

async function clickText(page: Page, text: string) {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('button,a')].some((element) =>
        element.textContent?.trim() === text
      ),
    { args: [text] },
  )
  await page.evaluate((text) => {
    const control = [...document.querySelectorAll<HTMLElement>('button,a')].find((element) =>
      element.textContent?.trim() === text
    )!
    control.focus()
    control.click()
  }, { args: [text] })
}

Deno.test('Japanese platform help and access preserve source identities across desktop/mobile light/dark at 22px', async () => {
  const server = startTestServer({ identity: { role: 'owner' }, breakGlass: true })
  server.setGroupCapability(true)
  let browser = await launch()
  let page = await browser.newPage(server.url + '/admin/people')
  // Readiness follows the actual app element below, rather than unrelated third-party
  // network idle events. Marking the old document prevents stale selector matches.
  const visit = async (path: string) => {
    console.info(`[platform-ja] visit ${path}`)
    await page.evaluate(() => document.documentElement.setAttribute('data-qa-old-document', ''))
    await page.goto(server.url + path, { waitUntil: 'load' })
    await page.waitForFunction(
      (path) =>
        location.pathname === path &&
        !document.documentElement.hasAttribute('data-qa-old-document'),
      { args: [path] },
    )
  }
  const evidence: Record<string, unknown>[] = []
  const owner = fixtureSession({ oid: 'e2e-owner', roles: ['CorpusKit.Owner'] })
  await Deno.mkdir(captureRoot, { recursive: true })
  try {
    await page.waitForSelector('main h1')
    await assertCurrentBuild(page)
    for (const language of ['en', 'ja'] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const width of [1440, 390]) {
          const selected = Deno.env.get('JA_PLATFORM_VARIANT')
          if (selected && selected !== `${language}-${scheme}-${width}`) continue
          await page.setViewportSize({ width, height: 960 })
          await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
          await page.evaluate((language, scheme) => {
            localStorage.setItem('corpuskit-ui-language-v1', language)
            localStorage.setItem('rp-scheme', scheme)
          }, { args: [language, scheme] })
          const capture = async (name: string, target?: string) => {
            console.info(`[platform-ja] capture ${language}/${scheme}/${width}/${name}`)
            await prepareCapture(page)
            if (target) {
              await page.evaluate((target) => {
                document.querySelector(target)?.scrollIntoView({
                  block: 'start',
                  behavior: 'instant',
                })
                scrollBy(0, -24)
              }, { args: [target] })
            }
            const metrics = await page.evaluate(() => ({
              width: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              font: getComputedStyle(document.documentElement).fontSize,
              language: document.documentElement.lang,
              fontStatus: document.fonts.status,
              visibility: document.visibilityState,
              colorScheme:
                getComputedStyle(document.querySelector('main') ?? document.body).colorScheme,
              background:
                getComputedStyle(document.querySelector('main') ?? document.body).backgroundColor,
              ink: getComputedStyle(document.querySelector('main') ?? document.body).color,
              dialog: !!document.querySelector('[role=dialog],dialog[open]'),
            }))
            console.info(`[platform-ja] metrics ${JSON.stringify(metrics)}`)
            expect(metrics.width).toBe(width)
            expect(metrics.scrollWidth).toBeLessThanOrEqual(width + 1)
            expect(metrics.font).toBe('22px')
            expect(metrics.fontStatus).toBe('loaded')
            expect(metrics.language).toBe(language === 'ja' ? 'ja' : 'en-AU')
            expect(metrics.colorScheme).toBe(scheme)
            if (name === 'member-form') {
              const channels = metrics.background.match(/\d+/g)!.slice(0, 3).map(Number)
              expect(channels.every((value) => scheme === 'dark' ? value < 100 : value > 180)).toBe(
                true,
              )
            }
            const path = `${captureRoot}/${language}-${scheme}-${width}-${name}.png`
            await Deno.writeFile(path, await page.screenshot({ captureBeyondViewport: false }))
            evidence.push({ name, language, scheme, width, metrics, path })
          }
          await visit('/admin/people')
          await page.waitForFunction((text) => document.querySelector('h1')?.textContent === text, {
            args: [language === 'ja' ? 'メンバー' : 'People'],
          })
          await clickText(
            page,
            language === 'ja' ? 'プラットフォームのメンバーを追加' : 'Add platform member',
          )
          await page.waitForSelector('[data-assignment-editor] form')
          expect(
            await page.evaluate(() =>
              document.querySelector<HTMLSelectElement>('[data-assignment-role]')?.value
            ),
          ).toBe('platform-admin')
          await capture('member-form', '[data-assignment-editor] form')
          await clickText(page, language === 'ja' ? 'メンバーの入力を閉じる' : 'Close member form')
          await clickText(
            page,
            language === 'ja' ? 'グループの権限設定を追加' : 'Add group mapping',
          )
          await page.waitForSelector('[data-assignment-editor] form')
          await capture('group-form', '[data-assignment-editor] form')
          await visit('/t/marine/help/getting-started')
          await page.waitForSelector('article')
          expect(
            await page.evaluate(() =>
              document.querySelector('article')?.textContent?.includes('Cmd/Ctrl+K')
            ),
          ).toBe(true)
          // The documentation page owns its h1; the selected guide is the
          // article's h2 so the page keeps one ordered heading hierarchy.
          expect(await page.evaluate(() => document.querySelectorAll('main h1').length)).toBe(1)
          expect(
            await page.evaluate(() =>
              document.querySelector('article header h2')?.textContent?.trim()
            ),
          ).toBe(language === 'ja' ? 'はじめに' : 'Getting started')
          await capture('help-body', 'article')
          await visit('/t/marine/how-it-works')
          await page.waitForSelector('[data-testid=how-it-works-flow]')
          expect(
            await page.evaluate(
              (text) => document.querySelector('main')?.textContent?.includes(text),
              {
                args: [
                  language === 'ja' ? 'ポータルの運営者が' : 'The portal reads one collection',
                ],
              },
            ),
          ).toBe(true)
          await capture('flow-guide', '[data-testid=how-it-works-flow]')
          if (width === 390) {
            await page.evaluate(() =>
              document.querySelector<HTMLButtonElement>(
                'button[aria-label="Open menu"],button[aria-label="メニューを開く"]',
              )!.click()
            )
            await page.waitForSelector('#mobile-nav-sheet')
          }
          await page.evaluate((width) => {
            const prefix = width === 390 ? '#mobile-nav-sheet ' : 'header '
            document.querySelector<HTMLButtonElement>(prefix + 'button[id^="account-trigger-"]')!
              .focus()
          }, { args: [width] })
          await page.keyboard.press('ArrowDown')
          await page.waitForSelector('[role=menu]')
          await page.waitForFunction(() =>
            document.activeElement?.getAttribute('role') === 'menuitem'
          )
          await page.keyboard.press('End')
          await page.waitForFunction(
            (label) => document.activeElement?.textContent?.trim() === label,
            { args: [language === 'ja' ? 'プロフィール' : 'Profile'] },
          )
          await page.keyboard.press('Enter')
          await page.waitForSelector('dialog[open]')
          expect(
            await page.evaluate(() => {
              const dialog = document.querySelector('dialog[open]')!
              return document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent
                ?.trim()
            }),
          ).toBe(language === 'ja' ? 'プロフィール' : 'Profile')
          await capture('profile')
          await page.keyboard.press('Escape')
          await visit('/t/marine/library/res-1')
          await page.waitForSelector('[data-delete-document]')
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-delete-document]')!.click()
          )
          await page.waitForSelector('dialog[open]')
          expect(await page.evaluate(() => document.querySelector('dialog[open]')?.textContent))
            .toContain('Abalone stock health in southern waters')
          await capture('delete-confirmation')
          await page.keyboard.press('Escape')
          await page.waitForFunction(() => !document.querySelector('dialog[open]'))
          await visit('/t/marine/not-a-real-page')
          await page.waitForFunction(
            (text) => document.querySelector('main')?.textContent?.includes(text),
            { args: [language === 'ja' ? 'ページが見つかりません' : 'Page not found'] },
          )
          await capture('not-found')
          server.setResponseStatus('/api/t/marine/config', 503)
          await visit('/t/marine/library')
          // Document load can precede app startup and its access check. Wait
          // for the first config response before timing the transient retries.
          await page.waitForFunction(() =>
            performance.getEntriesByName(`${location.origin}/api/t/marine/config`, 'resource')
              .length > 0
          )
          await page.waitForSelector('[data-access-state=failed]')
          await capture('failed-gate')
          server.setResponseStatus('/api/t/marine/config', null)
          server.setAccessMode('marine', 'authenticated')
          server.setIdentity(null)
          await visit('/t/marine/library')
          await page.waitForSelector('[data-access-state=denied]')
          expect(await page.evaluate(() => document.querySelector('h1')?.textContent?.trim()))
            .toContain(language === 'ja' ? 'サインイン' : 'Sign in')
          await capture('sign-in-gate')
          server.setIdentity(owner)
          server.setAccessMode('marine', 'public')
          await page.close()
          // Each visual variant gets an isolated browser compositor. Reusing
          // one Chromium across the matrix can leave a later target hidden
          // despite activation, with DOM ready but no screenshot frame.
          await browser.close()
          browser = await launch()
          page = await browser.newPage(server.url + '/admin/people')
          await page.waitForSelector('main h1')
        }
      }
    }
    // Every app-owned help body, not just the first guide, renders Japanese.
    await page.evaluate(() => localStorage.setItem('corpuskit-ui-language-v1', 'ja'))
    for (const doc of DOC_PAGES) {
      await visit(`/t/marine/help/${doc.id}`)
      await page.waitForSelector('article')
      const body = await page.evaluate(() => document.querySelector('article')?.textContent ?? '')
      expect(body).toMatch(/[ぁ-んァ-ン一-龯]/u)
      expect(body).not.toContain(doc.summary)
    }
    expect(
      server.requests.filter((request) =>
        /\/(ask|askJSON|generate)(\?|$)/.test(request.path) && request.method === 'POST'
      ),
    ).toEqual([])
    await Deno.writeTextFile(`${captureRoot}/manifest.json`, JSON.stringify(evidence, null, 2))
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
