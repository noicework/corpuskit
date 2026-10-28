import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import { startTestServer, type TestServer } from './support/test-server.ts'
import type { SiteFeedbackRecord } from '../apps/api/src/site-feedback.ts'

let browser: Browser
let server: TestServer
const delivered: SiteFeedbackRecord[] = []
let failing = false

beforeAll(async () => {
  server = startTestServer({
    siteFeedbackNotifier: (_portal, record) => {
      if (failing) return Promise.reject(new Error('provider unavailable'))
      delivered.push(record)
      return Promise.resolve(`notification-${delivered.length}`)
    },
  })
  server.tenants.patch('marine', { siteFeedback: true })
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

const TRIGGER = 'header button[aria-label="Send feedback"]'

async function openFromHeader(page: Page): Promise<void> {
  await page.waitForSelector(TRIGGER)
  await page.evaluate((selector) => {
    const trigger = document.querySelector<HTMLButtonElement>(selector)!
    trigger.focus()
    trigger.click()
  }, { args: [TRIGGER] })
  await settle(
    page,
    () => document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open') === true,
    'the dialog',
  )
}

const dialogHoldsFocus = () =>
  document.querySelector('dialog[data-site-feedback]')?.contains(document.activeElement) === true

describe('reader feedback', () => {
  it('is offered only where the portal opted in and the deployment can deliver', async () => {
    // The same portal on a deployment with no notifier: the setting alone shows nothing.
    const undeliverable = startTestServer()
    undeliverable.tenants.patch('marine', { siteFeedback: true })
    try {
      for (
        const [url, offered] of [
          [`${server.url}/t/marine/library`, true],
          [`${server.url}/t/grains/library`, false],
          [`${undeliverable.url}/t/marine/library`, false],
        ] as const
      ) {
        const page = await browser.newPage(url)
        try {
          await page.waitForSelector('header')
          await page.waitForSelector('nav[aria-label=Primary]')
          expect([
            url,
            await page.evaluate(() => ({
              trigger: document.querySelector('header button[aria-label="Send feedback"]') !==
                null,
              dialog: document.querySelector('dialog[data-site-feedback]') !== null,
            })),
          ]).toEqual([url, { trigger: offered, dialog: offered }])
        } finally {
          await page.close()
        }
      }
      const refused = await fetch(`${undeliverable.url}/api/t/marine/site-feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: undeliverable.url },
        body: JSON.stringify({ message: 'Hello', category: 'general', pagePath: '/t/marine' }),
      })
      expect(refused.status).toBe(404)
      await refused.body?.cancel()
    } finally {
      await undeliverable.close()
    }
  })

  it('holds focus, labels every field, announces errors and success, and returns focus', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/library?q=private#fragment`)
    try {
      await openFromHeader(page)
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
      // Every field has a visible label that names it.
      expect(
        await page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              'dialog[data-site-feedback] :is(textarea, select, input)',
            ),
          ).filter((field) => field.getClientRects().length > 0).map((field) => {
            const label = document.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`)
            return {
              tag: field.tagName,
              label: label?.textContent?.trim(),
              shown: (label?.getBoundingClientRect().height ?? 0) > 0,
            }
          })
        ),
      ).toEqual([
        { tag: 'TEXTAREA', label: 'Your message (required)', shown: true },
        { tag: 'SELECT', label: 'This is about', shown: true },
        { tag: 'INPUT', label: 'Email (optional)', shown: true },
      ])

      // An empty message is named on the field and takes the focus, without a request.
      await page.evaluate(() =>
        document.querySelector<HTMLFormElement>('dialog[data-site-feedback] form')!.requestSubmit()
      )
      expect(
        await page.evaluate(() => {
          const field = document.activeElement as HTMLTextAreaElement
          const described = (field.getAttribute('aria-describedby') ?? '').split(' ')
            .map((id) => document.getElementById(id)?.textContent?.trim())
          return { tag: field.tagName, invalid: field.getAttribute('aria-invalid'), described }
        }),
      ).toEqual({
        tag: 'TEXTAREA',
        invalid: 'true',
        described: [
          'Add a message before you send it.',
          'Up to 4,000 characters. The address of this page is sent with it.',
        ],
      })
      expect(delivered).toHaveLength(0)

      await page.keyboard.type('Please make source dates easier to find.')
      // A failed delivery keeps the draft and says so in an alert.
      failing = true
      await page.evaluate(() =>
        document.querySelector<HTMLFormElement>('dialog[data-site-feedback] form')!.requestSubmit()
      )
      await settle(
        page,
        () => document.querySelector('dialog [role="alert"]') !== null,
        'the alert',
      )
      expect(
        await page.evaluate(() => ({
          alert: document.querySelector('dialog [role="alert"]')?.textContent,
          draft: document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value,
          button: document.querySelector('dialog button[type="submit"]')?.textContent,
        })),
      ).toEqual({
        alert: 'Your feedback could not be sent. Your message is still here - try again.',
        draft: 'Please make source dates easier to find.',
        button: 'Try again',
      })

      // Tab and Shift+Tab never leave the dialog.
      for (let index = 0; index < 7; index++) {
        await page.keyboard.press('Tab')
        expect(await page.evaluate(dialogHoldsFocus)).toBe(true)
      }
      await page.keyboard.down('Shift')
      for (let index = 0; index < 7; index++) {
        await page.keyboard.press('Tab')
        expect(await page.evaluate(dialogHoldsFocus)).toBe(true)
      }
      await page.keyboard.up('Shift')

      // Escape closes; the focus goes back to the button that opened it, and the draft stays.
      await page.keyboard.press('Escape')
      await settle(
        page,
        () => !document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open'),
        'closing',
      )
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        'Send feedback',
      )
      expect(await page.evaluate(() => document.body.style.overflow)).toBe('')
      await openFromHeader(page)
      expect(
        await page.evaluate(() =>
          document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value
        ),
      ).toBe(
        'Please make source dates easier to find.',
      )

      failing = false
      await page.evaluate(() =>
        document.querySelector<HTMLFormElement>('dialog[data-site-feedback] form')!.requestSubmit()
      )
      await settle(
        page,
        () =>
          document.querySelector('dialog [role="status"]')?.textContent?.includes(
            'has been sent',
          ) === true,
        'the confirmation',
      )
      expect(
        await page.evaluate(() => ({
          status: document.querySelector('dialog [role="status"]')?.textContent,
          focus: document.activeElement?.textContent,
        })),
      ).toEqual({
        status: 'Thank you - your feedback has been sent.The portal team has been notified.',
        focus: 'Done',
      })
      // Only the page path goes: not the query or the fragment.
      expect(delivered.at(-1)).toMatchObject({
        message: 'Please make source dates easier to find.',
        pageUrl: `${server.url}/t/marine/library`,
        delivery: 'pending',
      })
      await page.keyboard.press('Enter')
      await settle(
        page,
        () => !document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open'),
        'closing',
      )
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        'Send feedback',
      )
      // Once it has gone, the next message starts on an empty form.
      await openFromHeader(page)
      expect(
        await page.evaluate(() =>
          document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value
        ),
      ).toBe('')
    } finally {
      await page.close()
    }
  })

  it('stays open when reopened before the last closing has finished', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/library`)
    try {
      await openFromHeader(page)
      // Close, let React commit, and reopen, all in one task: the closing's own event arrives
      // after the reopening.
      await page.evaluate(async (selector) => {
        document.querySelector<HTMLButtonElement>(
          'dialog[data-site-feedback] button[aria-label="Close"]',
        )!.click()
        for (let tick = 0; tick < 3; tick++) await Promise.resolve()
        const closed = !document.querySelector('dialog[data-site-feedback]')!.hasAttribute('open')
        document.querySelector<HTMLButtonElement>(selector)!.click()
        return closed
      }, { args: [TRIGGER] }).then((closed) => expect(closed).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(
        await page.evaluate(() =>
          document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open')
        ),
      ).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('opens from the phone menu, which it closes first, and gives focus back to the menu button', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/library`)
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForSelector('button.rp-navtoggle')
      // The header keeps its circle for wider screens; on a phone the menu carries it.
      expect(
        await page.evaluate(
          (selector) => document.querySelector(selector)?.getClientRects().length,
          { args: [TRIGGER] },
        ),
      ).toBe(0)
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>('button.rp-navtoggle')!
          .click()
      )
      await settle(page, () => document.querySelector('#mobile-nav-sheet') !== null, 'the menu')
      await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('#mobile-nav-sheet button'))
          .find((button) => button.textContent?.trim() === 'Send feedback')!.click()
      )
      await settle(
        page,
        () => document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open') === true,
        'the dialog',
      )
      await settle(
        page,
        () => document.querySelector('#mobile-nav-sheet') === null,
        'the menu closing',
      )
      expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press('Tab')
        expect(await page.evaluate(dialogHoldsFocus)).toBe(true)
      }
      await page.keyboard.press('Escape')
      await settle(
        page,
        () => !document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open'),
        'closing',
      )
      expect(
        await page.evaluate(() => ({
          overflow: document.body.style.overflow,
          // The toggle names the sheet in aria-controls only while it is mounted.
          focus: document.activeElement?.classList.contains('rp-navtoggle'),
          expanded: document.querySelector('button.rp-navtoggle')
            ?.getAttribute('aria-expanded'),
        })),
      ).toEqual({ overflow: '', focus: true, expanded: 'false' })
    } finally {
      await page.close()
    }
  })

  it('fits 320px at a large text size in both schemes, with 24px targets and reduced motion', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/library`)
    try {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        for (const scheme of ['light', 'dark']) {
          await page.evaluate((next) => {
            localStorage.setItem('rp-scheme', next)
            document.documentElement.style.fontSize = '22px'
          }, { args: [scheme] })
          await page.reload()
          await page.evaluate(() => document.documentElement.style.fontSize = '22px')
          if (width < 640) {
            await page.waitForSelector('button.rp-navtoggle')
            await page.evaluate(() =>
              document.querySelector<HTMLButtonElement>('button.rp-navtoggle')!
                .click()
            )
            await settle(
              page,
              () => document.querySelector('#mobile-nav-sheet') !== null,
              'the menu',
            )
            await page.evaluate(() =>
              Array.from(document.querySelectorAll<HTMLButtonElement>('#mobile-nav-sheet button'))
                .find((button) => button.textContent?.trim() === 'Send feedback')!.click()
            )
            await settle(
              page,
              () =>
                document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open') === true,
              'the dialog',
            )
          } else {
            await openFromHeader(page)
          }
          const layout = await page.evaluate(() => {
            const dialog = document.querySelector<HTMLDialogElement>('dialog[data-site-feedback]')!
            const rect = dialog.getBoundingClientRect()
            const targets = Array.from(
              dialog.querySelectorAll<HTMLElement>(
                'button, select, input:not([tabindex="-1"]), textarea',
              ),
            ).filter((element) => element.getClientRects().length > 0)
              .map((element) => element.getBoundingClientRect())
            const style = getComputedStyle(dialog)
            return {
              width: innerWidth,
              pageOverflow: document.documentElement.scrollWidth - innerWidth,
              dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
              inside: rect.left >= 0 && rect.right <= innerWidth,
              smallest: Math.min(...targets.map((target) => Math.min(target.width, target.height))),
              surface: style.backgroundColor,
              token: style.getPropertyValue('--rp-surface').trim(),
              animation: style.animationDuration,
            }
          })
          expect([width, scheme, layout.width]).toEqual([width, scheme, width])
          expect(layout.pageOverflow).toBeLessThanOrEqual(0)
          expect(layout.dialogOverflow).toBeLessThanOrEqual(0)
          expect(layout.inside).toBe(true)
          expect(layout.smallest).toBeGreaterThanOrEqual(24)
          expect(layout.surface).not.toBe('rgba(0, 0, 0, 0)')
          expect(layout.token).not.toBe('')
          expect(['0s', '0.001s', '1e-03s']).toContain(layout.animation)
          // A keyboard focus shows the theme's ring on a field.
          await page.keyboard.press('Tab')
          await page.keyboard.down('Shift')
          await page.keyboard.press('Tab')
          await page.keyboard.up('Shift')
          expect(
            await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow),
          ).not.toBe('none')
          await page.keyboard.press('Escape')
          await settle(
            page,
            () => !document.querySelector('dialog[data-site-feedback]')?.hasAttribute('open'),
            'closing',
          )
        }
      }
    } finally {
      await page.evaluate(() => localStorage.removeItem('rp-scheme')).catch(() => {})
      await page.close()
    }
  })
})
