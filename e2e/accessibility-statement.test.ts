// ---------------------------------------------------------------------------
// Browser E2E for the accessibility statement: the route renders through the
// real app and the built SPA (see e2e/support/test-server.ts), names itself
// in the tab, leaves the contact section out until a portal configures one,
// renders a configured contact with working links, reflows at a phone width
// and is reachable from the footer of every portal. Run with
// `deno task test:e2e`.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch } from '@astral/astral'
import { startTestServer, type TestServer } from './support/test-server.ts'

let browser: Browser
let server: TestServer

beforeAll(async () => {
  server = startTestServer()
  // One showcase portal keeps the default statement; the other supplies a contact.
  server.tenants.patch('grains', {
    accessibility: {
      contact: {
        name: 'the portal team',
        email: 'access@example.org',
        phone: '1800 000 000',
        url: 'https://example.org/accessibility',
        note: 'We aim to reply within five working days.',
      },
    },
  })
  browser = await launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

const DEFAULT_HEADINGS = [
  'What has been tested',
  'How it is tested',
  'Where the portal depends on its documents',
]

describe('Accessibility statement', () => {
  it('renders the default statement with its own title and no contact section', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/accessibility`)
    try {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.waitForSelector('[data-testid="accessibility-statement"]')
      const state = await page.evaluate(() => ({
        title: document.title,
        h1s: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent?.trim()),
        headings: Array.from(document.querySelectorAll('main h2')).map((h) =>
          h.textContent?.trim()
        ),
        onThisPage: Array.from(
          document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="On this page"] a'),
        ).map((a) => a.getAttribute('href')),
        asideVisible:
          (document.querySelector('nav[aria-label="On this page"]')?.getBoundingClientRect()
            .width ?? 0) > 0,
        mailto: document.querySelector('a[href^="mailto:"]') !== null,
        text: document.querySelector('main')?.textContent ?? '',
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      }))
      expect(state.title).toBe('Accessibility | Southern Waters Research Portal')
      expect(state.h1s).toEqual(['Accessibility'])
      expect(state.headings).toEqual(DEFAULT_HEADINGS)
      expect(state.onThisPage).toEqual([
        '#section-what-has-been-tested',
        '#section-how-it-is-tested',
        '#section-where-the-portal-depends-on-its-documents',
      ])
      expect(state.asideVisible).toBe(true)
      expect(state.mailto).toBe(false)
      expect(state.text).not.toContain('Tell us about an access problem')
      expect(state.text).toContain('Web Content Accessibility Guidelines (WCAG) 2.2 at level AA')
      expect(state.text).not.toMatch(/conform/i)
      expect(state.horizontalOverflow).toBeLessThanOrEqual(0)
    } finally {
      await page.close()
    }
  })

  it('renders a configured contact and reflows at a phone width', async () => {
    const page = await browser.newPage(`${server.url}/t/grains/accessibility`)
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForSelector('#section-contact')
      const state = await page.evaluate(() => {
        const links = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('#section-contact a'),
        )
        return {
          headings: Array.from(document.querySelectorAll('main h2')).map((h) =>
            h.textContent?.trim()
          ),
          links: links.map((a) => a.getAttribute('href')),
          shortest: Math.min(...links.map((a) => a.getBoundingClientRect().height)),
          asideVisible:
            (document.querySelector('nav[aria-label="On this page"]')?.getBoundingClientRect()
              .width ?? 0) > 0,
          text: document.querySelector('#section-contact')?.textContent ?? '',
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
        }
      })
      expect(state.headings).toEqual([...DEFAULT_HEADINGS, 'Tell us about an access problem'])
      expect(state.links).toEqual([
        'mailto:access@example.org',
        'tel:1800000000',
        'https://example.org/accessibility',
      ])
      expect(state.shortest).toBeGreaterThanOrEqual(24)
      expect(state.asideVisible).toBe(false)
      expect(state.text).toContain('contact the portal team.')
      expect(state.text).toContain('We aim to reply within five working days.')
      expect(state.text).toContain('(opens external site)')
      expect(state.horizontalOverflow).toBeLessThanOrEqual(0)
      expect(state.mainWidth).toBeLessThanOrEqual(390)
    } finally {
      await page.close()
    }
  })

  it('is linked from the footer and reached by keyboard', async () => {
    const page = await browser.newPage(`${server.url}/t/marine`)
    try {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.waitForSelector('footer a[href="/t/marine/accessibility"]')
      const link = await page.evaluate(() => {
        const anchor = document.querySelector<HTMLAnchorElement>(
          'footer a[href="/t/marine/accessibility"]',
        )!
        anchor.scrollIntoView()
        anchor.focus()
        const rect = anchor.getBoundingClientRect()
        return {
          text: anchor.textContent?.trim(),
          focused: document.activeElement === anchor,
          height: rect.height,
          width: rect.width,
        }
      })
      expect(link.text).toBe('Accessibility')
      expect(link.focused).toBe(true)
      expect(link.height).toBeGreaterThanOrEqual(24)
      expect(link.width).toBeGreaterThanOrEqual(24)
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid="accessibility-statement"]')
      const landed = await page.evaluate(() => ({
        path: location.pathname,
        title: document.title,
      }))
      expect(landed.path).toBe('/t/marine/accessibility')
      expect(landed.title).toBe('Accessibility | Southern Waters Research Portal')
    } finally {
      await page.close()
    }
  })
})
