// ---------------------------------------------------------------------------
// Browser E2E for the How-this-works page: the route renders through the
// real app and the built SPA (see e2e/support/test-server.ts), the flow
// diagram stacks at a phone viewport, the page degrades cleanly when the
// counters endpoint is unavailable (the test server has no management
// client, so /counters answers 503), and the page is reachable from the
// header help menu and the phone menu. Run with `deno task test:e2e`.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import { startTestServer, type TestServer } from './support/test-server.ts'

let browser: Browser
let server: TestServer

beforeAll(async () => {
  server = startTestServer()
  browser = await launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

/** Polls the page until `probe` returns true or the deadline passes. */
async function settle(page: Page, probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.evaluate(probe)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the page did not settle in time')
}

describe('How this works', () => {
  it('renders every section, the flow diagram and no stuck figures', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/how-it-works`)
    try {
      // A desktop viewport, set explicitly: the runner's default window is
      // narrower than the `lg` breakpoint, where the column diagram shows.
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.waitForSelector('[data-testid="how-it-works-flow"]')
      // The counters request has failed (503) and the figures strip is gone.
      await settle(
        page,
        () =>
          document.querySelector('[data-testid="how-it-works-figures"]') === null &&
          document.querySelectorAll('.rp-shimmer').length === 0,
      )
      const state = await page.evaluate(() => {
        const visibleSvgs = Array.from(
          document.querySelectorAll<SVGSVGElement>('[data-testid="how-it-works-flow"] svg'),
        ).filter((svg) => getComputedStyle(svg).display !== 'none')
        return {
          heading: document.querySelector('h1')?.textContent?.trim(),
          sections: Array.from(document.querySelectorAll('main h2')).map((h) =>
            h.textContent?.trim()
          ),
          visibleOrientation: visibleSvgs.map((svg) => svg.dataset.orientation),
          platformMentions: (document.body.innerText.match(/Progress Agentic RAG/g) ?? []).length,
          toolLinks: Array.from(document.querySelectorAll<HTMLAnchorElement>('#tools a')).map(
            (a) => a.getAttribute('href'),
          ),
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        }
      })
      expect(state.heading).toBe('How this works')
      expect(state.sections).toEqual([
        'Where the content comes from',
        'What happens when a document is added',
        'How a question is answered',
        'How the answer is checked before you see it',
        'What you can do with it',
        'What it deliberately does not do',
        'Under the hood',
      ])
      expect(state.visibleOrientation).toEqual(['row'])
      expect(state.platformMentions).toBe(1)
      for (
        const path of ['/t/marine/search', '/t/marine/ask', '/t/marine/library', '/t/marine/graph']
      ) {
        expect(state.toolLinks).toContain(path)
      }
      expect(state.horizontalOverflow).toBeLessThanOrEqual(0)
    } finally {
      await page.close()
    }
  })

  it('stacks the diagram at a 390px viewport with a scaled-up root font', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/how-it-works`)
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForSelector('[data-testid="how-it-works-flow"]')
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '22px'
      })
      const state = await page.evaluate(() => {
        const visibleSvgs = Array.from(
          document.querySelectorAll<SVGSVGElement>('[data-testid="how-it-works-flow"] svg'),
        ).filter((svg) => getComputedStyle(svg).display !== 'none')
        const svg = visibleSvgs[0]
        const rect = svg?.getBoundingClientRect()
        return {
          visibleOrientation: visibleSvgs.map((s) => s.dataset.orientation),
          svgWidth: rect?.width ?? 0,
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          bodyOverflow: document.body.scrollWidth - innerWidth,
        }
      })
      expect(state.visibleOrientation).toEqual(['column'])
      expect(state.svgWidth).toBeGreaterThan(260)
      expect(state.svgWidth).toBeLessThanOrEqual(390)
      expect(state.horizontalOverflow).toBeLessThanOrEqual(0)
      expect(state.bodyOverflow).toBeLessThanOrEqual(0)
    } finally {
      await page.close()
    }
  })

  it('is reachable from the header help menu and from the phone menu', async () => {
    const page = await browser.newPage(`${server.url}/t/marine`)
    try {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.waitForSelector('button[aria-haspopup="menu"][aria-label="Help"]')
      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"][aria-label="Help"]')
          ?.click()
      })
      await settle(
        page,
        () =>
          document.querySelector('button[aria-haspopup="menu"][aria-label="Help"]')
            ?.getAttribute('aria-expanded') === 'true',
      )
      const desktop = await page.evaluate(() => {
        const trigger = document.querySelector<HTMLButtonElement>(
          'button[aria-haspopup="menu"][aria-label="Help"]',
        )
        const menu = document.getElementById(trigger?.getAttribute('aria-controls') ?? '')
        return {
          expanded: trigger?.getAttribute('aria-expanded'),
          items: Array.from(menu?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? [])
            .map((a) => ({ href: a.getAttribute('href'), label: a.textContent?.trim() })),
        }
      })
      expect(desktop.expanded).toBe('true')
      expect(desktop.items).toEqual([
        { href: '/t/marine/help', label: 'Help and documentation' },
        { href: '/t/marine/how-it-works', label: 'How this works' },
      ])

      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForSelector('button[aria-controls="mobile-nav-sheet"]')
      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('button[aria-controls="mobile-nav-sheet"]')
          ?.click()
      })
      await settle(page, () => document.getElementById('mobile-nav-sheet') !== null)
      const phone = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLAnchorElement>('#mobile-nav-sheet a[href]'),
        ).map((a) => a.getAttribute('href'))
      )
      expect(phone).toContain('/t/marine/help')
      expect(phone).toContain('/t/marine/how-it-works')
    } finally {
      await page.close()
    }
  })
})
