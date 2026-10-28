import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import { startTestServer, type TestServer } from './support/test-server.ts'

let browser: Browser
let server: TestServer

beforeAll(async () => {
  server = startTestServer()
  // Two portals: one offers the tour, one opens it by itself on the home page.
  server.tenants.patch('grains', { demoTour: 'request' })
  server.tenants.patch('marine', { demoTour: 'auto' })
  browser = await launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function settle(page: Page, probe: () => boolean, what = 'the page'): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await page.evaluate(probe)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${what} did not settle in time`)
}

const TRIGGER = '[data-demo-tour-entry] button'

const dialogOpen = () =>
  document.querySelector('dialog[data-demo-tour]')?.hasAttribute('open') === true
const dialogGone = () => document.querySelector('dialog[data-demo-tour]') === null

async function openFromBand(page: Page): Promise<void> {
  await page.waitForSelector(TRIGGER)
  await page.evaluate((selector) => {
    const trigger = document.querySelector<HTMLButtonElement>(selector)!
    trigger.focus()
    trigger.click()
  }, { args: [TRIGGER] })
  await settle(page, dialogOpen, 'the dialog')
}

describe('the guided tour', () => {
  it('is offered only where the portal opts in, and opens by itself only on auto, once', async () => {
    const page = await browser.newPage(`${server.url}/t/grains`)
    try {
      await page.waitForSelector(TRIGGER)
      expect(await page.evaluate(dialogGone)).toBe(true)

      // Auto: open on the first arrival at the home page, remembered once closed.
      await page.goto(`${server.url}/t/marine`)
      await settle(page, dialogOpen, 'the automatic tour')
      await page.keyboard.press('Escape')
      await settle(page, dialogGone, 'closing')
      await page.reload()
      await page.waitForSelector(TRIGGER)
      expect(await page.evaluate(dialogGone)).toBe(true)
      expect(await page.evaluate(() => localStorage.getItem('rp_demo_tour_done'))).toBe('1')

      // A link can still force it, and the parameter leaves the address.
      await page.goto(`${server.url}/t/marine?tour=1`)
      await settle(page, dialogOpen, 'the forced tour')
      expect(await page.evaluate(() => location.search)).toBe('')
      await page.keyboard.press('Escape')
      await settle(page, dialogGone, 'closing')

      // Never over another page: Ask shows no tour, however the portal is set.
      await page.evaluate(() => localStorage.removeItem('rp_demo_tour_done'))
      await page.goto(`${server.url}/t/marine/ask`)
      await page.waitForSelector('main')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await page.evaluate(dialogGone)).toBe(true)
    } finally {
      await page.evaluate(() => localStorage.removeItem('rp_demo_tour_done')).catch(() => {})
      await page.close()
    }
  })

  it('walks the scenes with focus held inside, announces each step, and gives focus back', async () => {
    const page = await browser.newPage(`${server.url}/t/grains`)
    try {
      await openFromBand(page)
      const state = () =>
        page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>('dialog[data-demo-tour]')!
          return {
            modal: dialog.matches(':modal'),
            heading: dialog.querySelector('h2')?.textContent?.trim(),
            focusedHeading: document.activeElement === dialog.querySelector('h2'),
            status: dialog.querySelector('[role="status"]')?.textContent?.trim(),
            stageHidden:
              dialog.querySelector('.rp-tour-stage')?.getAttribute('aria-hidden') === 'true' &&
              dialog.querySelector('.rp-tour-stage')?.hasAttribute('inert') === true,
            tryIt: dialog.querySelector<HTMLAnchorElement>('a.rp-btn-primary')?.getAttribute(
              'href',
            ),
          }
        })
      // The band already said what this is, so the tour opens on its first step.
      let now = await state()
      expect(now.modal).toBe(true)
      expect(now.heading).toBe('Find answers and sources')
      expect(now.focusedHeading).toBe(true)
      expect(now.status).toBe('Step 1 of 4: Find answers and sources')
      expect(now.stageHidden).toBe(true)
      expect(now.tryIt?.startsWith('/t/grains/ask?ask=')).toBe(true)

      // Tab stays inside the dialog, whichever way it goes.
      for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() =>
          document.querySelector('dialog[data-demo-tour]')!.contains(document.activeElement)
        ),
      ).toBe(true)
      await page.keyboard.down('Shift')
      await page.keyboard.press('Tab')
      await page.keyboard.up('Shift')
      expect(
        await page.evaluate(() =>
          document.querySelector('dialog[data-demo-tour]')!.contains(document.activeElement)
        ),
      ).toBe(true)

      // Arrow keys step; each scene has its one click.
      await page.keyboard.press('ArrowRight')
      await settle(
        page,
        () =>
          document.querySelector('dialog[data-demo-tour] h2')?.textContent?.trim() ===
            'Follow the evidence',
        'the second scene',
      )
      now = await state()
      expect(now.status).toBe('Step 2 of 4: Follow the evidence')
      expect(now.focusedHeading).toBe(true)
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await settle(
        page,
        () =>
          document.querySelector('dialog[data-demo-tour] a.rp-btn-primary')?.getAttribute(
            'href',
          ) === '/t/grains/tools',
        'the MCP scene',
      )
      expect((await state()).status).toBe('Step 4 of 4: Bring your own tools')
      await page.keyboard.press('ArrowLeft')
      await settle(
        page,
        () =>
          document.querySelector('dialog[data-demo-tour] a.rp-btn-primary')?.getAttribute(
            'href',
          ) === '/t/grains/graph',
        'the Graph scene',
      )

      // Escape closes it and focus goes back to the control that opened it.
      await page.keyboard.press('Escape')
      await settle(page, dialogGone, 'closing')
      expect(
        await page.evaluate(
          (selector) => document.activeElement === document.querySelector(selector),
          {
            args: [TRIGGER],
          },
        ),
      ).toBe(true)
    } finally {
      await page.evaluate(() => localStorage.removeItem('rp_demo_tour_done')).catch(() => {})
      await page.close()
    }
  })

  it("'Try it' closes the tour and sends the question to Ask", async () => {
    const page = await browser.newPage(`${server.url}/t/grains`)
    try {
      await openFromBand(page)
      await settle(
        page,
        () => document.querySelector('dialog[data-demo-tour] a.rp-btn-primary') !== null,
        'the first scene',
      )
      await page.evaluate(() =>
        document.querySelector<HTMLAnchorElement>('dialog[data-demo-tour] a.rp-btn-primary')!
          .click()
      )
      await settle(page, () => location.pathname.endsWith('/ask'), 'Ask')
      expect(await page.evaluate(dialogGone)).toBe(true)
      // The question went with it: the thread shows it as the first message.
      await settle(
        page,
        () => document.querySelector('.rp-answer-question') !== null,
        'the question',
      )
    } finally {
      await page.evaluate(() => localStorage.removeItem('rp_demo_tour_done')).catch(() => {})
      await page.close()
    }
  })

  it('fits 320px at a large text size in both schemes, with 24px targets and reduced motion', async () => {
    const page = await browser.newPage(`${server.url}/t/grains`)
    try {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        for (const scheme of ['light', 'dark']) {
          await page.evaluate((next) => localStorage.setItem('rp-scheme', next), { args: [scheme] })
          await page.reload()
          await page.evaluate(() => document.documentElement.style.fontSize = '22px')
          await openFromBand(page)
          await settle(
            page,
            () => document.querySelector('dialog[data-demo-tour] a.rp-btn-primary') !== null,
            'the first scene',
          )
          const layout = await page.evaluate(() => {
            const dialog = document.querySelector<HTMLDialogElement>('dialog[data-demo-tour]')!
            const rect = dialog.getBoundingClientRect()
            const targets = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href]'))
              .filter((element) =>
                element.getClientRects().length > 0 && !element.closest('.rp-tour-stage')
              )
              .map((element) => element.getBoundingClientRect())
            const style = getComputedStyle(dialog)
            const animated = Array.from(dialog.querySelectorAll<HTMLElement>('*')).filter((el) => {
              const duration = getComputedStyle(el).animationDuration
              return !['0s', '0.001s', '1e-03s'].includes(duration) &&
                getComputedStyle(el).animationName !== 'none'
            }).length
            return {
              width: innerWidth,
              pageOverflow: document.documentElement.scrollWidth - innerWidth,
              dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
              inside: rect.left >= 0 && rect.right <= innerWidth,
              smallest: Math.min(...targets.map((target) => Math.min(target.width, target.height))),
              surface: style.backgroundColor,
              token: style.getPropertyValue('--rp-surface').trim(),
              animated,
            }
          })
          expect([width, scheme, layout.width]).toEqual([width, scheme, width])
          expect(layout.pageOverflow).toBeLessThanOrEqual(0)
          expect(layout.dialogOverflow).toBeLessThanOrEqual(0)
          expect(layout.inside).toBe(true)
          expect(layout.smallest).toBeGreaterThanOrEqual(24)
          expect(layout.surface).not.toBe('rgba(0, 0, 0, 0)')
          expect(layout.token).not.toBe('')
          expect(layout.animated).toBe(0)
          await page.keyboard.press('Escape')
          await settle(page, dialogGone, 'closing')
        }
      }
    } finally {
      await page.evaluate(() => {
        localStorage.removeItem('rp-scheme')
        localStorage.removeItem('rp_demo_tour_done')
      }).catch(() => {})
      await page.close()
    }
  })
})
