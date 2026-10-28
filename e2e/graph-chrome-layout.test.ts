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
      viewSwitch: rect(document.querySelector('[data-graph-view-switch]')!),
      stage: rect(stage),
      canvas: rect(canvas),
      scheme: document.querySelector('[data-colour-scheme]')?.getAttribute('data-colour-scheme'),
    }
  })
}

Deno.test('graph fits below compact chrome and recovers mobile navigation only after scrolling past the map', async () => {
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
        const protocolErrors: unknown[] = []
        page.unsafelyGetCelestialBindings().ws.addEventListener('message', (event) => {
          const response = JSON.parse(event.data)
          // Astral 0.5.6 resolves CDP errors as undefined. Retain the actual
          // protocol fault so a failed native gesture is diagnosable in CI.
          if (response.error) {
            protocolErrors.push(response.error)
            console.error(`[graph-chrome] ${scene} protocol error`, response.error)
          }
        })
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
          // Reduced motion starts in the complete list; these journeys exercise the map.
          await page.waitForSelector('[data-graph-view-choice=map]')
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-graph-view-choice=map]')!.click()
          )
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
              await page.evaluate(() => document.querySelectorAll('[data-graph-back-top]').length),
            ).toBe(0)
            expect(before.header.position).toBe('sticky')
            expect(before.masthead.height).toBeLessThanOrEqual(8 * 22)
            expect(before.stage.height).toBeGreaterThan(
              0.55 * before.viewport.height - before.viewSwitch.height,
            )
            expect(before.documentHeight).toBeLessThanOrEqual(before.viewport.height + 1)
            await page.evaluate(() => scrollTo(0, 300))
            const after = await geometry(page)
            expect(after.scroll).toBe(0)
            expect(after.header.top).toBe(before.header.top)
            expect(after.masthead.top).toBe(before.masthead.top)
          } else {
            expect(before.header.position).toBe('relative')
            expect(before.masthead.height).toBeLessThanOrEqual(7 * 22)
            // The map fills the remaining viewport, with a usable minimum
            // when enlarged controls need document scrolling.
            expect(Math.abs(before.stage.top - before.masthead.bottom - before.viewSwitch.height))
              .toBeLessThanOrEqual(1)
            const expectedHeight = Math.max(
              20 * 22,
              before.viewport.height - before.header.height - before.masthead.height -
                before.viewSwitch.height,
            )
            expect(Math.abs(
              before.stage.height - expectedHeight,
            )).toBeLessThanOrEqual(1)
            expect(before.canvas.height).toBe(before.stage.height)
            expect(before.documentHeight).toBeLessThanOrEqual(
              Math.max(before.viewport.height, before.stage.bottom) + 1,
            )
            expect(
              await page.evaluate(() => document.querySelectorAll('[data-graph-back-top]').length),
            ).toBe(0)
            // Supply surrounding scrollable content to exercise the recovery
            // contract independently of the new viewport-fitting page layout.
            // First stop at the map's top, where return must still be absent.
            await page.evaluate((height) => {
              const tail = document.createElement('div')
              tail.id = 'graph-scroll-fixture'
              tail.style.height = `${height}px`
              document.querySelector('.rp-tenant')!.append(tail)
            }, { args: [before.stage.top] })
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
            await page.evaluate(async () => {
              scrollTo(0, 0)
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              )
            })
            // The menu changed the scroll lock and the document was reset.
            // Commit a frame before native input: Chromium's hit-test data
            // can lag the DOM, especially beside the touch-none canvas.
            await Deno.writeFile(`${directory}/${scene}-gesture-ready.png`, await page.screenshot())
            const gesture = await page.evaluate(() => {
              const masthead = [...document.querySelectorAll('[data-graph-masthead]')]
                .find((element) => element.getBoundingClientRect().height > 0)!
              const viewSwitch = document.querySelector('[data-graph-view-switch]')!
              const chrome = [masthead, viewSwitch]
              const bounds = viewSwitch.getBoundingClientRect()
              const x = 10, y = bounds.bottom - 32
              const hit = document.elementFromPoint(x, y)!
              const actions: string[] = []
              for (let element: Element | null = hit; element; element = element.parentElement) {
                actions.push(getComputedStyle(element).touchAction)
              }
              const touches: unknown[] = []
              Reflect.set(globalThis, '__graphChromeTouches', touches)
              for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
                // Window bubble listeners see cancellation after app listeners.
                addEventListener(type, (event) => {
                  const target = event.target as Element
                  const touch = (event as TouchEvent).changedTouches[0]
                  touches.push({
                    type: event.type,
                    trusted: event.isTrusted,
                    tag: target.tagName,
                    inChrome: chrome.some((element) => element.contains(target)),
                    inStage: !!target.closest('[data-graph-stage]'),
                    scroll: scrollY,
                    cancelable: event.cancelable,
                    defaultPrevented: event.defaultPrevented,
                    x: touch?.clientX,
                    y: touch?.clientY,
                    time: performance.now(),
                  })
                }, { passive: true })
              }
              return {
                x,
                y,
                scroll: scrollY,
                inChrome: chrome.some((element) => element.contains(hit)),
                inStage: !!hit.closest('[data-graph-stage]'),
                actions,
                roots: [document.scrollingElement!, document.body].map((element) => ({
                  tag: element.tagName,
                  scrollHeight: element.scrollHeight,
                  clientHeight: element.clientHeight,
                  overflowY: getComputedStyle(element).overflowY,
                })),
              }
            })
            console.log(`[graph-chrome] ${scene} gesture-ready`, JSON.stringify(gesture))
            expect(gesture.scroll).toBe(0)
            expect(gesture.inChrome).toBe(true)
            expect(gesture.inStage).toBe(false)
            expect(gesture.actions.every((action) => action === 'auto')).toBe(true)
            // Use the supported direct-touch driver. Chrome 125's experimental
            // synthesized scroll follows different Aura/Mac gesture paths.
            // Keep the physical finger inside the viewport: a deliberate fast
            // 1,000px/s flick ending at 20px, then let Chromium's native fling settle.
            const endY = 20, speed = 1000
            const distance = endY - gesture.y
            const duration = Math.abs(distance) / speed * 1000
            const steps = Math.ceil(duration / (1000 / 60))
            await page.touchscreen.touchStart(gesture.x, gesture.y)
            const started = performance.now()
            for (let step = 1; step <= steps; step++) {
              const due = started + duration * step / steps
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, due - performance.now()))
              )
              await page.touchscreen.touchMove(gesture.x, gesture.y + distance * step / steps)
            }
            await page.touchscreen.touchEnd()
            const trajectory = {
              start: { x: gesture.x, y: gesture.y },
              end: { x: gesture.x, y: endY },
              speed,
              steps,
              durationMs: duration,
              actualDurationMs: performance.now() - started,
            }
            console.log(
              `[graph-chrome] ${scene} touch-input-ended`,
              JSON.stringify({
                trajectory,
                geometry: await geometry(page),
                touches: await page.evaluate(() => Reflect.get(globalThis, '__graphChromeTouches')),
              }),
            )
            // Native fling distance varies with browser scheduling. It must
            // clear the navigation chrome without showing the return control.
            await page.waitForFunction(() => {
              const masthead = [...document.querySelectorAll('[data-graph-masthead]')]
                .find((element) => element.getBoundingClientRect().height > 0)!
              return masthead.getBoundingClientRect().bottom <= 1
            })
            const after = await geometry(page)
            const touches = await page.evaluate(() =>
              Reflect.get(globalThis, '__graphChromeTouches') as {
                type: string
                trusted: boolean
                inChrome: boolean
                inStage: boolean
              }[]
            )
            console.log(
              `[graph-chrome] ${scene} native-swipe`,
              JSON.stringify({ after, touches, protocolErrors }),
            )
            expect(protocolErrors).toEqual([])
            expect(
              touches.some((touch) =>
                touch.type === 'touchstart' && touch.trusted && touch.inChrome && !touch.inStage
              ),
            )
              .toBe(true)
            expect(touches.some((touch) => touch.type === 'touchmove' && touch.trusted)).toBe(true)
            expect(after.scroll).toBeGreaterThan(before.header.height)
            expect(after.header.bottom).toBeLessThanOrEqual(0)
            expect(after.masthead.bottom).toBeLessThanOrEqual(1)
            expect(after.stage.top).toBeLessThanOrEqual(before.viewSwitch.height + 1)
            expect(after.stage.height).toBe(before.stage.height)
            expect(after.canvas.height).toBe(before.canvas.height)
            await Deno.writeFile(`${directory}/${scene}-scrolled.png`, await page.screenshot())
            evidence.push({ scene, scrolled: after, menu, gesture, trajectory, touches })
            // Scrolling only the chrome away must not show return while
            // the map remains visible. It appears after the entire map.
            expect(
              await page.evaluate(() => document.querySelectorAll('[data-graph-back-top]').length),
            ).toBe(0)
            await page.evaluate(() => {
              document.querySelector<HTMLElement>('#graph-scroll-fixture')!.style.height = `${
                innerHeight * 2
              }px`
              const stage = document.querySelector('[data-graph-stage]')!
              scrollTo(0, Math.ceil(scrollY + stage.getBoundingClientRect().bottom))
            })
            await page.waitForSelector('[data-graph-back-top]')
            expect((await geometry(page)).stage.bottom).toBeLessThanOrEqual(0)
            // A native tap on the return control recovers visible navigation
            // and restores keyboard focus to the header.
            const back = await page.evaluate((browseLabel) => {
              const button = document.querySelector('[data-graph-back-top]')!
              const rect = button.getBoundingClientRect()
              const browse = [...document.querySelectorAll('[data-graph-stage] button')]
                .find((element) => element.getAttribute('aria-label') === browseLabel)!
                .getBoundingClientRect()
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                browseRight: browse.right,
                browseBottom: browse.bottom,
              }
            }, { args: [ui('Browse')] })
            // Return now appears after Browse has scrolled off-screen.
            // Preserve the non-overlap guarantee in both dimensions.
            expect(back.left > back.browseRight || back.top >= back.browseBottom).toBe(true)
            expect(back.right).toBeLessThanOrEqual(width)
            await page.touchscreen.tap(back.x, back.y)
            await page.waitForFunction(() => scrollY === 0)
            await page.waitForFunction(() => !document.querySelector('[data-graph-back-top]'))
            await page.evaluate(() => document.querySelector('#graph-scroll-fixture')!.remove())
            await Deno.writeFile(`${directory}/${scene}-returned.png`, await page.screenshot())
            // The native gesture must recover the actual navigation targets,
            // including after the returned frame has been composited.
            const returned = await page.evaluate(() => {
              const home = document.querySelector('.rp-tenant > header a[href]')!
                .getBoundingClientRect()
              const menu = document.querySelector('button.rp-navtoggle')!
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
              await page.waitForFunction(() => {
                const stage = document.querySelector('[data-graph-stage]')!.getBoundingClientRect()
                const minimum = 20 *
                  Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
                return stage.width === innerWidth &&
                  Math.abs(stage.height - Math.max(minimum, innerHeight - stage.top)) <= 1
              })
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
        } catch (error) {
          // Deno prints an assertion's stack only after the complete browser
          // suite. Publish the exact scene and geometry at the failure now.
          console.error(`[graph-chrome] ${scene} failed`, error)
          console.error(
            `[graph-chrome] ${scene} final geometry`,
            await geometry(page).catch(() => ({ unavailable: true })),
          )
          throw error
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
