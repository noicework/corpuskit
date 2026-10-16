import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { createPortalLocale } from '../apps/web/src/lib/portal-locale.tsx'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'

const directory = '.planning/logs/compact-graph-header'
const nodes = [
  { id: 'EX-M20-032', group: 'Experiment', weight: 2 },
  { id: 'AP-M0', group: 'Material', weight: 1 },
  { id: 'Summary {count}', group: 'Research topic', weight: 1 },
]
const edges = [
  { source: 'EX-M20-032', target: 'AP-M0', label: 'uses material' },
  { source: 'EX-M20-032', target: 'Summary {count}', label: 'examines' },
]

async function geometry(page: Page) {
  return await page.evaluate(() => {
    const rect = (element: Element) => {
      const { top, bottom, width, height } = element.getBoundingClientRect()
      return { top, bottom, width, height }
    }
    const header = document.querySelector('.rp-tenant > header')!
    const masthead = [...document.querySelectorAll('[data-graph-masthead]')]
      .find((element) => element.getBoundingClientRect().height > 0)!
    const stage = document.querySelector('[data-graph-stage]')!
    const canvas = stage.querySelector('canvas')!
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scroll: scrollY,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      header: { ...rect(header), position: getComputedStyle(header).position },
      measuredHeader: document.documentElement.style.getPropertyValue('--rp-header-h'),
      masthead: rect(masthead),
      stage: rect(stage),
      canvas: rect(canvas),
      scheme: document.querySelector('[data-colour-scheme]')?.getAttribute('data-colour-scheme'),
    }
  })
}

Deno.test('graph chrome is compact and fixed on desktop, while mobile chrome scrolls away above a full map', async () => {
  const calls: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => () => {
      calls.push(String(method))
      switch (method) {
        case 'relationsGraph':
          return Promise.resolve({ nodes, edges })
        case 'entityGroups':
        case 'labelsets':
        case 'listAgents':
          return Promise.resolve([])
        default:
          return Promise.reject(new Error(`Unexpected fixture operation: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  const server = startTestServer({ identity: { role: 'owner' }, management })
  const seed = server.tenants.get('marine')!
  const evidence: unknown[] = []
  await Deno.mkdir(directory, { recursive: true })
  try {
    for (const dark of [false, true]) {
      server.tenants.patch('marine', {
        branding: {
          ...seed.branding,
          paletteId: dark ? 'observatory' : 'default',
          shape: 'soft',
          density: 'comfortable',
          typography: 'fraunces-poppins',
          colourScheme: 'viewer',
          defaultColourScheme: dark ? 'dark' : 'light',
        },
        languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
      })
      for (const width of dark ? [1440, 390] : [1440, 390, 320]) {
        const mobile = width < 768
        const scene = `${dark ? 'dark' : 'light'}-${width}`
        console.log(`[graph-chrome] ${scene}`)
        const browser = await launch(), page = await browser.newPage('about:blank')
        try {
          await page.bringToFront()
          await page.setViewportSize({ width, height: mobile ? 844 : 960 })
          await page.emulateMediaFeatures([
            { name: 'prefers-reduced-motion', value: 'reduce' },
            { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
          ])
          await page.unsafelyGetCelestialBindings().Emulation.setTouchEmulationEnabled({
            enabled: mobile,
            maxTouchPoints: 5,
          })
          await page.goto(`${server.url}/t/marine/graph`)
          await page.waitForSelector('[data-graph-stage][aria-busy=false] canvas')
          await assertCurrentBuild(page)
          await page.evaluate(async () => {
            document.documentElement.style.fontSize = '22px'
            await document.fonts.ready
          })
          await page.waitForFunction(() =>
            getComputedStyle(document.documentElement).fontSize === '22px' &&
            Math.abs(
                Number.parseFloat(
                  document.documentElement.style.getPropertyValue('--rp-header-h'),
                ) - document.querySelector('.rp-tenant > header')!.getBoundingClientRect().height,
              ) <= 1
          )
          const before = await geometry(page)
          console.log('[graph-chrome] geometry', JSON.stringify(before))
          await Deno.writeFile(`${directory}/${scene}-initial.png`, await page.screenshot())
          expect(before.viewport.width).toBe(width)
          expect(before.rootFont).toBe('22px')
          expect(before.scheme).toBe(dark ? 'dark' : 'light')
          expect(before.documentWidth).toBeLessThanOrEqual(width + 1)
          expect(before.canvas.width).toBeGreaterThan(width - 2)
          if (width === 1440) {
            expect(
              await page.evaluate(() =>
                document.querySelector('[data-graph-back-top]')!.getBoundingClientRect().height
              ),
            ).toBe(0)
            expect(before.header.position).toBe('sticky')
            expect(before.masthead.height).toBeLessThanOrEqual(8 * 22)
            expect(before.stage.height).toBeGreaterThan(0.55 * before.viewport.height)
            expect(before.documentHeight).toBeLessThanOrEqual(before.viewport.height + 1)
            await page.evaluate(() => scrollTo(0, 300))
            const after = await geometry(page)
            expect(after.scroll).toBe(0)
            expect(after.header.top).toBe(before.header.top)
            expect(after.masthead.top).toBe(before.masthead.top)
          } else {
            expect(before.header.position).toBe('relative')
            expect(before.masthead.height).toBeLessThanOrEqual(7 * 22)
            expect(Math.abs(before.stage.height - before.viewport.height)).toBeLessThanOrEqual(1)
            expect(before.documentHeight).toBeGreaterThan(before.viewport.height)
            // Open the menu while its trigger is still visible but the header
            // is partly scrolled away. Its fixed layers must meet that edge.
            await page.evaluate(() => scrollTo(0, 12))
            const { ui } = createPortalLocale('ja')
            await page.evaluate((label) => {
              document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()
            }, { args: [ui('Open menu')] })
            await page.waitForSelector('#mobile-nav-sheet')
            const menu = await page.evaluate(() => ({
              top: document.querySelector('#mobile-nav-sheet')!.getBoundingClientRect().top,
              headerBottom: document.querySelector('.rp-tenant > header')!
                .getBoundingClientRect().bottom,
              locked: document.body.style.overflow,
              focused: document.activeElement?.closest('#mobile-nav-sheet') !== null,
            }))
            expect(Math.abs(menu.top - menu.headerBottom)).toBeLessThanOrEqual(1)
            expect(menu.locked).toBe('hidden')
            expect(menu.focused).toBe(true)
            await page.keyboard.press('Escape')
            await page.waitForFunction(() => !document.querySelector('#mobile-nav-sheet'))
            expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
            expect(
              await page.evaluate(
                (label) => document.activeElement?.getAttribute('aria-label') === label,
                {
                  args: [ui('Open menu')],
                },
              ),
            ).toBe(true)
            await page.evaluate(() => scrollTo(0, 0))
            // A real Chromium touch gesture scrolls the document, rather than
            // relying only on programmatic window scrolling for this contract.
            await page.unsafelyGetCelestialBindings().Input.synthesizeScrollGesture({
              x: 10,
              y: before.stage.top - 10,
              yDistance: -before.stage.top - 100,
              gestureSourceType: 'touch',
              speed: 600,
              preventFling: true,
            })
            const after = await geometry(page)
            expect(after.scroll).toBeGreaterThan(before.header.height)
            expect(after.header.bottom).toBeLessThanOrEqual(0)
            expect(after.masthead.bottom).toBeLessThanOrEqual(1)
            expect(Math.abs(after.stage.top)).toBeLessThanOrEqual(1)
            expect(after.stage.height).toBe(before.stage.height)
            expect(after.canvas.height).toBe(before.canvas.height)
            await Deno.writeFile(`${directory}/${scene}-scrolled.png`, await page.screenshot())
            evidence.push({ scene, scrolled: after, menu })
            // Canvas touch gestures still belong to the graph. A native tap
            // on its visible return control must always recover navigation.
            const back = await page.evaluate((browseLabel) => {
              const button = document.querySelector('[data-graph-back-top]')!
              const rect = button.getBoundingClientRect()
              const browse = [...document.querySelectorAll('[data-graph-stage] button')]
                .find((element) => element.textContent?.trim() === browseLabel)!
                .getBoundingClientRect()
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                left: rect.left,
                right: rect.right,
                browseRight: browse.right,
              }
            }, { args: [ui('Browse')] })
            expect(back.left).toBeGreaterThan(back.browseRight)
            expect(back.right).toBeLessThanOrEqual(width)
            await page.touchscreen.tap(back.x, back.y)
            await page.waitForFunction(() => scrollY === 0)
            await Deno.writeFile(`${directory}/${scene}-returned.png`, await page.screenshot())
            // The native gesture must recover the actual navigation targets,
            // including after the returned frame has been composited.
            const returned = await page.evaluate(() => {
              const home = document.querySelector('.rp-tenant > header a[href]')!
                .getBoundingClientRect()
              const menu = document.querySelector('[aria-controls=mobile-nav-sheet]')!
                .getBoundingClientRect()
              return {
                homeTop: home.top,
                homeBottom: home.bottom,
                menuTop: menu.top,
                menuBottom: menu.bottom,
              }
            })
            expect(returned.homeTop).toBeGreaterThanOrEqual(0)
            expect(returned.menuTop).toBeGreaterThanOrEqual(0)
            expect(returned.homeBottom).toBeLessThanOrEqual(844)
            expect(returned.menuBottom).toBeLessThanOrEqual(844)
            expect(
              await page.evaluate(() =>
                document.activeElement?.closest('.rp-tenant > header') !== null
              ),
            ).toBe(true)
            if (!dark) {
              await page.evaluate((label) => {
                document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()
              }, { args: [ui('Open menu')] })
              await page.waitForSelector('#mobile-nav-sheet')
              await page.setViewportSize({ width: 1440, height: 960 })
              await page.waitForFunction(() => !document.querySelector('#mobile-nav-sheet'))
              expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
              expect((await geometry(page)).header.position).toBe('sticky')
              await page.setViewportSize({ width, height: 844 })
              await page.waitForFunction(() =>
                document.querySelector('[data-graph-stage]')!.getBoundingClientRect().height ===
                  innerHeight
              )
            }
          }
          // Both language choices retain the compact controls. The existing
          // graph display suite covers raw identities, trace and expansion.
          await page.evaluate(() => {
            document.querySelector<HTMLButtonElement>('button[lang=en]')!.click()
          })
          await page.waitForFunction(() => document.documentElement.lang === 'en-AU')
          expect(await page.evaluate(() => document.body.innerText)).toContain('Knowledge map')
          expect((await geometry(page)).documentWidth).toBeLessThanOrEqual(width + 1)
          await page.evaluate(() => {
            document.querySelector<HTMLButtonElement>('button[lang=ja]')!.click()
          })
          await page.waitForFunction(() => document.documentElement.lang === 'ja')
          await Deno.writeFile(`${directory}/${scene}.png`, await page.screenshot())
          evidence.push({ scene, before, final: await geometry(page) })
        } finally {
          await page.close()
          await browser.close()
        }
      }
    }
    expect(calls.some((call) => /ask|generate|startAgent/i.test(call))).toBe(false)
    expect(server.providerCalls.some((call) => /ask|generate/i.test(call))).toBe(false)
    await Deno.writeTextFile(`${directory}/geometry.json`, JSON.stringify(evidence, null, 2))
  } finally {
    await server.close()
  }
})
