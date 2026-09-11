import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch } from '@astral/astral'
import { RESOURCE_ONE } from './support/double-provider.ts'
import { startTestServer, type TestServer } from './support/test-server.ts'

let browser: Browser
let server: TestServer
let screenshots: string

beforeAll(async () => {
  server = startTestServer()
  browser = await launch()
  screenshots = await Deno.makeTempDir({ prefix: 'corpuskit-inline-citations-' })
  console.log(`Inline citation screenshots: ${screenshots}`)
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

// Real Ask/Search components and their SSE/HTTP path; only retrieval is the existing double.
// Inline links are exempt from WCAG 2.5.8's minimum target box: reserving a square here
// distorts the prose. Preserve semantic links, explicit names and visible keyboard focus.
describe('compact inline citations', () => {
  for (const surface of ['ask', 'search']) {
    for (const scheme of ['light', 'dark']) {
      for (const width of [1440, 390]) {
        it(`${surface}, ${scheme}, ${width}px, 22px root: natural inline sizing and working links`, async () => {
          const page = await browser.newPage(`${server.url}/t/marine`)
          try {
            await page.setViewportSize({ width, height: width === 390 ? 1100 : 1000 })
            await page.evaluate((choice) => {
              localStorage.setItem('rp-scheme', choice)
              localStorage.removeItem('rp-chat-marine')
            }, { args: [scheme] })
            await page.goto(
              `${server.url}/t/marine/${surface}${surface === 'search' ? '?q=abalone' : ''}`,
            )
            await page.waitForSelector('h1', { timeout: 15_000 })
            if (surface === 'ask') {
              await page.waitForSelector('#ask-composer', { timeout: 15_000 })
              await page.evaluate(() => {
                const input = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
                  input,
                  'What affects abalone populations?',
                )
                input.dispatchEvent(new Event('input', { bubbles: true }))
              })
              await page.waitForFunction(() =>
                !document.querySelector<HTMLTextAreaElement>('#ask-composer')?.closest('form')
                  ?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
              )
              await page.evaluate(() =>
                document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
              )
            }
            await page.waitForSelector('sup a', { timeout: 15_000 })
            await page.evaluate(async () => {
              await document.fonts.ready
              document.documentElement.style.fontSize = '22px'
              document.querySelector('sup a')!.scrollIntoView({ block: 'center' })
            })
            await page.waitForFunction(() => {
              let element: Element | null = document.querySelector('sup a')
              while (element) {
                if (Number(getComputedStyle(element).opacity) < 0.999) return false
                element = element.parentElement
              }
              return !document.querySelector('.rp-answer-checking')
            })
            const state = await page.evaluate(() => {
              const link = document.querySelector<HTMLAnchorElement>('sup a')!
              const style = getComputedStyle(link)
              const range = document.createRange()
              range.selectNodeContents(link)
              const rect = link.getBoundingClientRect()
              return {
                viewport: innerWidth,
                root: getComputedStyle(document.documentElement).fontSize,
                scheme: getComputedStyle(document.querySelector('.rp-tenant')!).colorScheme,
                overflow: document.documentElement.scrollWidth - innerWidth,
                display: style.display,
                minWidth: style.minWidth,
                width: rect.width,
                glyphWidth: range.getBoundingClientRect().width,
                padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
                left: rect.left,
                right: rect.right,
                name: link.getAttribute('aria-label'),
                href: link.getAttribute('href'),
                focusClass: link.classList.contains('rp-focus'),
              }
            })
            expect(state.viewport).toBe(width) // Real CSS viewport, never outer-window resizing.
            expect(state.root).toBe('22px')
            expect(state.scheme).toBe(scheme)
            expect(state.overflow).toBeLessThanOrEqual(1)
            expect(state.display).toBe('inline')
            expect(state.minWidth).toBe('0px')
            expect(state.width).toBeLessThanOrEqual(state.glyphWidth + state.padding + 1)
            expect(state.left).toBeGreaterThanOrEqual(0)
            expect(state.right).toBeLessThanOrEqual(width)
            expect(state.name).toBe(`Source 1, ${RESOURCE_ONE.title}`)
            expect(state.href).toContain(`/t/marine/library/${RESOURCE_ONE.id}`)
            expect(state.focusClass).toBe(true)
            await Deno.writeFile(
              `${screenshots}/${surface}-${scheme}-${width}.png`,
              await page.screenshot(),
            )
            console.log(`${surface}/${scheme}/${width}: ${JSON.stringify(state)}`)
            // Keyboard modality plus programmatic focus tests the real focus-visible style,
            // then Enter follows the same semantic link without a pointer click.
            await page.keyboard.press('Tab')
            await page.evaluate(() => document.querySelector<HTMLAnchorElement>('sup a')!.focus())
            expect(
              await page.evaluate(() => document.activeElement?.matches('sup a:focus-visible')),
            )
              .toBe(true)
            await page.keyboard.press('Enter')
            await page.waitForFunction(() => location.pathname.includes('/library/'))
            expect(await page.evaluate(() => location.pathname)).toBe(
              `/t/marine/library/${RESOURCE_ONE.id}`,
            )
          } finally {
            await page.close()
          }
        })
      }
    }
  }
})
