// ---------------------------------------------------------------------------
// Browser E2E persona journeys - CI-runnable, no real ARAG account.
//
// Drives a real headless Chromium (via @astral/astral) against the built SPA
// served by the production Hono app (apps/api/src/app.ts), with only the
// RetrievalProvider swapped for a deterministic test double (see
// e2e/support/double-provider.ts). Everything else - routing, SSE streaming,
// tenant config, static file serving - is the real production code path.
//
// Journeys assert what docs/PERSONAS.md's persona gates require of the
// researcher journey: the CorpusKit front door, the explore page's topic rows, the
// search page's cited AI Answer panel (inline [n] markers, resources/cited
// header, Retrieved/Cited toggle), a citation marker's click-through to
// its source, the Self Assessment page's knowledge-area cards, and that the
// search journey stays usable at a 390px mobile viewport.
//
// Run with `deno task test:e2e` - NOT part of plain `deno task test` (the
// unit gate), since e2e/ sits outside the packages/ and apps/ roots that
// task scans, and downloading/driving a real browser is much slower than
// the unit suite.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch } from '@astral/astral'
import { RESOURCE_ONE } from './support/double-provider.ts'
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

describe('CorpusKit front door', () => {
  it('explains the product and presents the ways to take part', async () => {
    const page = await browser.newPage(`${server.url}/`)
    try {
      await page.waitForSelector('h1')
      const bodyText = await page.evaluate(() => document.body.innerText)
      const navigationText = await page.evaluate(() =>
        document.querySelector('.site-header')?.textContent ?? ''
      )
      expect(bodyText.replace(/\s+/g, ' ')).toContain('Put your organisation’s')
      expect(bodyText).toContain('Inside a CorpusKit portal')
      expect(bodyText).toContain('Run CorpusKit with your collection')
      expect(bodyText).toContain('Be a part of CorpusKit')
      expect(navigationText).not.toContain('Sign in')
    } finally {
      await page.close()
    }
  })

  it('keeps the marketing front door usable at a 390px viewport', async () => {
    const page = await browser.newPage(`${server.url}/`)
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForSelector('#contribute')
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '137.5%'
      })
      const state = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        heading: document.querySelector('h1')?.textContent?.trim(),
        headingOverflow: (() => {
          const heading = document.querySelector<HTMLElement>('.hero h1')
          return heading ? heading.scrollWidth - heading.clientWidth : 10_000
        })(),
        pageInset: document.querySelector<HTMLElement>('.hero')?.getBoundingClientRect().left ?? 0,
        heroThread: (() => {
          const thread = document.querySelector<SVGSVGElement>('#heroThread')
          const path = document.querySelector<SVGPathElement>('#heroThreadPath')
          return {
            display: thread ? getComputedStyle(thread).display : 'missing',
            length: path?.getTotalLength() ?? 0,
          }
        })(),
        closingThread: (() => {
          const thread = document.querySelector<SVGSVGElement>('#closingThread')
          const path = document.querySelector<SVGPathElement>('#closingThreadPath')
          const dot = document.querySelector<SVGCircleElement>('#closingThreadDot')
          const cards = document.querySelector<HTMLElement>('.next-steps')
          const threadBounds = thread?.getBoundingClientRect()
          const cardsBounds = cards?.getBoundingClientRect()
          const cardsCentre = threadBounds && cardsBounds
            ? (cardsBounds.left + cardsBounds.right) / 2 - threadBounds.left
            : 0
          return {
            display: thread ? getComputedStyle(thread).display : 'missing',
            length: path?.getTotalLength() ?? 0,
            targetOffset: Math.abs(Number(dot?.getAttribute('cx') ?? 10_000) - cardsCentre),
          }
        })(),
        evidenceFlow: (() => {
          const description = document.querySelector<HTMLElement>('.psig-head p')
          const steps = document.querySelector<HTMLElement>('.psig-steps')
          const answer = document.querySelector<HTMLElement>('.psig-answer')
          const source = document.querySelector<HTMLElement>('#psigSource')
          const thread = document.querySelector<SVGSVGElement>('#psigThread')
          const path = document.querySelector<SVGPathElement>('#psigThreadPath')
          return {
            descriptionBottom: description?.getBoundingClientRect().bottom ?? 0,
            stepsTop: steps?.getBoundingClientRect().top ?? 0,
            stepsBottom: steps?.getBoundingClientRect().bottom ?? 0,
            answerTop: answer?.getBoundingClientRect().top ?? 0,
            answerBottom: answer?.getBoundingClientRect().bottom ?? 0,
            sourceTop: source?.getBoundingClientRect().top ?? 0,
            threadDisplay: thread ? getComputedStyle(thread).display : 'missing',
            threadLength: path?.getTotalLength() ?? 0,
          }
        })(),
        portalInset: (() => {
          const frame = document.querySelector<HTMLElement>('.portal-frame')
          if (!frame) return { left: 0, right: 0 }
          const bounds = frame.getBoundingClientRect()
          return { left: bounds.left, right: innerWidth - bounds.right }
        })(),
        portalScreen: (() => {
          const frame = document.querySelector<HTMLElement>('.portal-frame')
          const main = document.querySelector<HTMLElement>('.portal-main')
          return {
            height: frame?.getBoundingClientRect().height ?? 0,
            contentHeight: main?.clientHeight ?? 0,
            scrollHeight: main?.scrollHeight ?? 0,
            overflowY: main ? getComputedStyle(main).overflowY : 'missing',
            touchAction: main ? getComputedStyle(main).touchAction : 'missing',
            pageSmootherActive: Boolean(
              (window as unknown as { ScrollSmoother?: { get: () => unknown } }).ScrollSmoother
                ?.get(),
            ),
          }
        })(),
        mobileTabs: {
          display:
            getComputedStyle(document.querySelector<HTMLElement>('.mobile-view-tabs')!).display,
          portalDisplay:
            getComputedStyle(document.querySelector<HTMLElement>('.portal-nav')!).display,
          portalTopDisplay:
            getComputedStyle(document.querySelector<HTMLElement>('.portal-top')!).display,
        },
        headerPosition:
          getComputedStyle(document.querySelector<HTMLElement>('.site-header')!).position,
        nextSteps: document.querySelectorAll('.next-step').length,
      }))
      expect(state.horizontalOverflow).toBeLessThanOrEqual(0)
      expect(state.heading).toContain('Put your organisation’s')
      expect(state.headingOverflow).toBeLessThanOrEqual(0)
      expect(state.pageInset).toBeGreaterThanOrEqual(24)
      expect(state.heroThread.display).toBe('block')
      expect(state.heroThread.length).toBeGreaterThan(0)
      expect(state.closingThread.display).toBe('block')
      expect(state.closingThread.length).toBeGreaterThan(0)
      expect(state.closingThread.targetOffset).toBeLessThanOrEqual(1)
      expect(state.evidenceFlow.descriptionBottom).toBeLessThan(state.evidenceFlow.stepsTop)
      expect(state.evidenceFlow.stepsBottom).toBeLessThan(state.evidenceFlow.answerTop)
      expect(state.evidenceFlow.answerBottom).toBeLessThan(state.evidenceFlow.sourceTop)
      expect(state.evidenceFlow.threadDisplay).toBe('block')
      expect(state.evidenceFlow.threadLength).toBeGreaterThan(0)
      expect(state.portalInset.left).toBeGreaterThanOrEqual(24)
      expect(state.portalInset.right).toBeGreaterThanOrEqual(24)
      expect(state.portalScreen.height).toBeLessThanOrEqual(844 * 0.78 + 1)
      expect(state.portalScreen.scrollHeight).toBeGreaterThan(state.portalScreen.contentHeight)
      expect(state.portalScreen.overflowY).toBe('auto')
      expect(state.portalScreen.touchAction).toBe('pan-y')
      expect(state.portalScreen.pageSmootherActive).toBe(false)
      expect(state.mobileTabs.display).toBe('grid')
      expect(state.mobileTabs.portalDisplay).toBe('none')
      expect(state.mobileTabs.portalTopDisplay).toBe('none')
      expect(state.headerPosition).toBe('absolute')
      expect(state.nextSteps).toBe(3)

      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('#mobile-tab-search')?.click()
      })
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 750)))
      const selectedFeature = await page.evaluate(() => ({
        tab: document.querySelector('.mobile-view-tab.active')?.textContent?.trim(),
        caption: document.getElementById('waysCaptionText')?.textContent,
        view: document.querySelector('.portal-view.active')?.id,
      }))
      expect(selectedFeature.tab).toBe('Search')
      expect(selectedFeature.caption).toContain('Search for words, topics or document kinds')
      expect(selectedFeature.view).toBe('view-search')

      const searchControls = await page.evaluate(() => ({
        direction:
          getComputedStyle(document.querySelector<HTMLElement>('#view-search .pv-controls')!)
            .flexDirection,
        modesDisplay:
          getComputedStyle(document.querySelector<HTMLElement>('#view-search .sr-modes')!).display,
        modesWidth:
          document.querySelector<HTMLElement>('#view-search .sr-modes')?.getBoundingClientRect()
            .width ?? 0,
        statusAlign:
          getComputedStyle(document.querySelector<HTMLElement>('#view-search .pv-meta')!).textAlign,
      }))
      expect(searchControls.direction).toBe('column')
      expect(searchControls.modesDisplay).toBe('grid')
      expect(searchControls.modesWidth).toBeGreaterThan(250)
      expect(searchControls.statusAlign).toBe('left')

      const internalScrollTop = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('.portal-main')
        if (!main) return 0
        main.scrollTop = 120
        return main.scrollTop
      })
      expect(internalScrollTop).toBeGreaterThan(0)

      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('#mobile-tab-map')?.click()
      })
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 750)))
      const mobileMap = await page.evaluate(() => ({
        view: document.querySelector('.portal-view.active')?.id,
        desktopDisplay:
          getComputedStyle(document.querySelector<SVGSVGElement>('.kg-desktop')!).display,
        mobileDisplay:
          getComputedStyle(document.querySelector<SVGSVGElement>('.kg-mobile')!).display,
        scrollTop: document.querySelector<HTMLElement>('.portal-main')?.scrollTop,
        label: document.querySelector<SVGSVGElement>('.kg-mobile')?.getAttribute('aria-label'),
      }))
      expect(mobileMap.view).toBe('view-map')
      expect(mobileMap.desktopDisplay).toBe('none')
      expect(mobileMap.mobileDisplay).toBe('block')
      expect(mobileMap.scrollTop).toBe(0)
      expect(mobileMap.label).toContain('mobile knowledge graph')

      const mapControls = await page.evaluate(() => ({
        direction: getComputedStyle(document.querySelector<HTMLElement>('#view-map .pv-controls')!)
          .flexDirection,
        statusAlign:
          getComputedStyle(document.querySelector<HTMLElement>('#view-map .pv-meta')!).textAlign,
      }))
      expect(mapControls.direction).toBe('column')
      expect(mapControls.statusAlign).toBe('left')

      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('#mobile-tab-library')?.click()
      })
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 750)))
      const libraryControls = await page.evaluate(() => ({
        direction:
          getComputedStyle(document.querySelector<HTMLElement>('#view-library .pv-controls')!)
            .flexDirection,
        statusAlign:
          getComputedStyle(document.querySelector<HTMLElement>('#view-library .pv-meta')!)
            .textAlign,
      }))
      expect(libraryControls.direction).toBe('column')
      expect(libraryControls.statusAlign).toBe('left')

      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('#mobile-tab-ask')?.click()
      })
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 750)))
      const confidence = await page.evaluate(() => {
        const confidence = document.querySelector<HTMLElement>('#view-ask .confidence')
        const label = confidence?.querySelector<HTMLElement>('strong')
        const detail = confidence?.querySelector<HTMLElement>('span')
        return {
          display: confidence ? getComputedStyle(confidence).display : 'missing',
          labelTop: label?.getBoundingClientRect().top ?? 0,
          detailTop: detail?.getBoundingClientRect().top ?? 0,
        }
      })
      expect(confidence.display).toBe('grid')
      expect(confidence.detailTop).toBeGreaterThan(confidence.labelTop)

      await page.evaluate(() => {
        const commands = [
          'git clone https://github.com/noicework/kb.git',
          'cd kb',
          'cp .env.example .env',
          'deno task provision',
          'deno task dev',
        ]
        document.querySelectorAll<HTMLElement>('.typed-command').forEach((command, index) => {
          command.textContent = commands[index] ?? ''
        })
        const comment = document.querySelector<HTMLElement>('.typed-comment')
        if (comment) comment.textContent = '   # knowledge service credentials'
      })
      const completedTerminal = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.code-card')
        const pre = card?.querySelector<HTMLElement>('pre')
        const bounds = card?.getBoundingClientRect()
        return {
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          left: bounds?.left ?? 0,
          rightInset: bounds ? innerWidth - bounds.right : 0,
          preOverflow: pre ? pre.scrollWidth - pre.clientWidth : 10_000,
          command: card?.querySelector('.terminal-line')?.textContent,
        }
      })
      expect(completedTerminal.horizontalOverflow).toBeLessThanOrEqual(0)
      expect(completedTerminal.left).toBeGreaterThanOrEqual(24)
      expect(completedTerminal.rightInset).toBeGreaterThanOrEqual(24)
      expect(completedTerminal.preOverflow).toBeLessThanOrEqual(0)
      expect(completedTerminal.command).toContain('https://github.com/noicework/kb.git')
    } finally {
      await page.close()
    }
  })

  it('uses explicit walkthrough controls and connectors at the tablet breakpoint', async () => {
    const page = await browser.newPage(`${server.url}/`)
    try {
      await page.setViewportSize({ width: 980, height: 1200 })
      await page.reload()
      await page.waitForSelector('#evidence-anatomy')
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise((resolve) => setTimeout(resolve, 150))
      })
      const state = await page.evaluate(() => {
        const display = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)
          return element ? getComputedStyle(element).display : 'missing'
        }
        const length = (selector: string) =>
          document.querySelector<SVGPathElement>(selector)?.getTotalLength() ?? 0
        const bounds = (selector: string) =>
          document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        const description = bounds('.psig-head p')
        const steps = bounds('.psig-steps')
        const answer = bounds('.psig-answer')
        const source = bounds('#psigSource')
        const evidenceSvg = document.querySelector<SVGSVGElement>('#psigThread')
        const evidenceDot = document.querySelector<SVGCircleElement>('#psigThreadDot')
        const citation = bounds('#psigCite')
        const svgBounds = evidenceSvg?.getBoundingClientRect()
        const citationX = citation && svgBounds
          ? (citation.left + citation.right) / 2 - svgBounds.left
          : 10_000
        const citationY = citation && svgBounds
          ? (citation.top + citation.bottom) / 2 - svgBounds.top
          : 10_000
        return {
          heroThreadDisplay: display('#heroThread'),
          heroThreadLength: length('#heroThreadPath'),
          closingThreadDisplay: display('#closingThread'),
          closingThreadLength: length('#closingThreadPath'),
          externalTabsDisplay: display('.mobile-view-tabs'),
          portalTabsDisplay: display('.portal-nav'),
          descriptionBottom: description?.bottom ?? 0,
          stepsTop: steps?.top ?? 0,
          stepsBottom: steps?.bottom ?? 0,
          answerTop: answer?.top ?? 0,
          answerBottom: answer?.bottom ?? 0,
          sourceTop: source?.top ?? 0,
          evidenceThreadDisplay: display('#psigThread'),
          evidenceThreadLength: length('#psigThreadPath'),
          evidenceTargetX: Number(evidenceDot?.getAttribute('cx') ?? 0),
          evidenceTargetY: Number(evidenceDot?.getAttribute('cy') ?? 0),
          citationX,
          citationY,
        }
      })
      expect(state.heroThreadDisplay).toBe('block')
      expect(state.heroThreadLength).toBeGreaterThan(0)
      expect(state.closingThreadDisplay).toBe('block')
      expect(state.closingThreadLength).toBeGreaterThan(0)
      expect(state.externalTabsDisplay).toBe('grid')
      expect(state.portalTabsDisplay).toBe('none')
      expect(state.descriptionBottom).toBeLessThan(state.stepsTop)
      expect(state.stepsBottom).toBeLessThan(state.answerTop)
      expect(state.answerBottom).toBeLessThan(state.sourceTop)
      expect(state.evidenceThreadDisplay).toBe('block')
      expect(state.evidenceThreadLength).toBeGreaterThan(0)
      expect(state.evidenceTargetX).toBeGreaterThan(state.citationX)
      expect(state.evidenceTargetY).toBeGreaterThan(state.citationY)
    } finally {
      await page.close()
    }
  })

  it('aligns the How it works link with the pinned walkthrough', async () => {
    const page = await browser.newPage(`${server.url}/`)
    try {
      await page.setViewportSize({ width: 2048, height: 914 })
      await page.reload()
      await page.waitForSelector('#workings')
      await page.evaluate(async () => await document.fonts.ready)
      const heroLines = await page.evaluate(() => {
        const heading = document.querySelector<HTMLElement>('.hero h1')
        if (!heading) return 0
        const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight)
        return Math.round(heading.getBoundingClientRect().height / lineHeight)
      })
      expect(heroLines).toBe(3)
      await page.evaluate(() => {
        document.querySelector<HTMLAnchorElement>('a[href="#workings"]')?.click()
      })
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 1_200)))

      const arrival = await page.evaluate(() => ({
        hash: location.hash,
        sectionTop: document.querySelector('#workings')?.getBoundingClientRect().top,
        headerTheme: document.querySelector('.site-header')?.className,
        activeFeature: document.querySelector('.view-tab.active')?.textContent?.trim(),
        laptopLayout: (() => {
          const heading = document.querySelector<HTMLElement>('.workings .section-head')
          const caption = document.querySelector<HTMLElement>('.workings .ways-caption')
          const frame = document.querySelector<HTMLElement>('.workings .portal-frame')
          const headingBounds = heading?.getBoundingClientRect()
          const captionBounds = caption?.getBoundingClientRect()
          const frameBounds = frame?.getBoundingClientRect()
          return {
            headingLeft: headingBounds?.left ?? 0,
            headingRight: headingBounds?.right ?? 0,
            captionLeft: captionBounds?.left ?? 0,
            captionBottom: captionBounds?.bottom ?? 0,
            frameLeft: frameBounds?.left ?? 0,
            frameTop: frameBounds?.top ?? 0,
            frameBottom: frameBounds?.bottom ?? 10_000,
            frameWidth: frameBounds?.width ?? 0,
          }
        })(),
      }))
      expect(arrival.hash).toBe('#workings')
      expect(Math.abs((arrival.sectionTop ?? 0) - 76)).toBeLessThanOrEqual(2)
      expect(arrival.headerTheme).toContain('nav-dark')
      expect(arrival.activeFeature).toBe('Ask')
      expect(Math.abs(arrival.laptopLayout.headingLeft - arrival.laptopLayout.captionLeft))
        .toBeLessThanOrEqual(1)
      expect(arrival.laptopLayout.frameLeft).toBeGreaterThan(arrival.laptopLayout.headingRight)
      expect(arrival.laptopLayout.frameTop).toBeGreaterThanOrEqual(76)
      expect(arrival.laptopLayout.frameBottom).toBeLessThanOrEqual(914)
      expect(arrival.laptopLayout.frameWidth).toBeGreaterThan(700)
      expect(arrival.laptopLayout.captionBottom)
        .toBeLessThanOrEqual(arrival.laptopLayout.frameBottom + 1)

      await page.evaluate(() => globalThis.scrollBy(0, 900))
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 800)))
      const activeFeature = await page.evaluate(() =>
        document.querySelector('.view-tab.active')?.textContent?.trim()
      )
      expect(activeFeature).toBe('Search')

      await page.evaluate(() => {
        document.querySelector('#evidence-anatomy')?.scrollIntoView()
        globalThis.scrollBy(0, 100)
      })
      await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 1_200)))
      const evidenceLayout = await page.evaluate(() => {
        const bounds = (selector: string) =>
          document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        const heading = bounds('.psig-head')
        const description = bounds('.psig-head p')
        const steps = bounds('.psig-steps')
        const answer = bounds('.psig-answer')
        const source = bounds('#psigSource')
        const quality = bounds('#psigConf')
        return {
          headingRight: heading?.right ?? 0,
          descriptionBottom: description?.bottom ?? 0,
          stepsTop: steps?.top ?? 0,
          answerLeft: answer?.left ?? 0,
          answerBottom: answer?.bottom ?? 0,
          sourceTop: source?.top ?? 0,
          sourceBottom: source?.bottom ?? 10_000,
          qualityTop: quality?.top ?? 0,
          qualityBottom: quality?.bottom ?? 10_000,
        }
      })
      expect(evidenceLayout.stepsTop).toBeGreaterThan(evidenceLayout.descriptionBottom)
      expect(evidenceLayout.answerLeft).toBeGreaterThan(evidenceLayout.headingRight)
      expect(evidenceLayout.sourceTop).toBeGreaterThan(evidenceLayout.answerBottom)
      expect(evidenceLayout.qualityTop).toBeGreaterThan(evidenceLayout.sourceBottom)
      expect(evidenceLayout.sourceBottom).toBeLessThanOrEqual(914)
      expect(evidenceLayout.qualityBottom).toBeLessThanOrEqual(914)
    } finally {
      await page.close()
    }
  })

  it('keeps the evidence walkthrough in editorial order on tall desktop screens', async () => {
    const page = await browser.newPage(`${server.url}/`)
    try {
      await page.setViewportSize({ width: 1920, height: 1400 })
      await page.reload()
      await page.waitForSelector('#evidence-anatomy')
      await page.evaluate(async () => await document.fonts.ready)
      const layout = await page.evaluate(() => {
        const bounds = (selector: string) =>
          document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        const heading = bounds('.psig-head')
        const description = bounds('.psig-head p')
        const steps = bounds('.psig-steps')
        const answer = bounds('.psig-answer')
        const source = bounds('#psigSource')
        const quality = bounds('#psigConf')
        return {
          headingRight: heading?.right ?? 0,
          descriptionBottom: description?.bottom ?? 0,
          stepsTop: steps?.top ?? 0,
          answerLeft: answer?.left ?? 0,
          answerBottom: answer?.bottom ?? 0,
          sourceTop: source?.top ?? 0,
          sourceBottom: source?.bottom ?? 0,
          qualityTop: quality?.top ?? 0,
        }
      })
      expect(layout.stepsTop).toBeGreaterThan(layout.descriptionBottom)
      expect(layout.answerLeft).toBeGreaterThan(layout.headingRight)
      expect(layout.sourceTop).toBeGreaterThan(layout.answerBottom)
      expect(layout.qualityTop).toBeGreaterThan(layout.sourceBottom)
    } finally {
      await page.close()
    }
  })
})

describe('explore page', () => {
  it('renders topic rows with resource cards', async () => {
    const page = await browser.newPage(`${server.url}/t/marine`)
    try {
      // Topic row heading for the current topic the double's resources are
      // filed against ("stock-assessment").
      await page.waitForSelector('h2', { timeout: 15_000 })
      const bodyText = await page.evaluate(() => document.body.innerText)
      expect(bodyText).toContain('Stock assessment')
      expect(bodyText).toContain(RESOURCE_ONE.title)
    } finally {
      await page.close()
    }
  })
})

describe('Ask and Tools navigation', () => {
  it('redirects an old Assistant bookmark to Ask and presents the renamed surface', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/assistant`)
    try {
      await page.waitForSelector('main[aria-label="Ask"]', { timeout: 15_000 })

      const state = await page.evaluate(() => ({
        pathname: location.pathname,
        title: document.title,
        text: document.body.innerText,
      }))
      expect(state.pathname).toBe('/t/marine/ask')
      expect(state.title).toBe('Ask | Southern Waters Research Portal')
      expect(state.text).toContain('Ask a question and get an answer grounded in this portal')
    } finally {
      await page.close()
    }
  })

  it('lists Tools as one navigation destination and renders its placeholder', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/tools`)
    try {
      await page.waitForSelector('h1', { timeout: 15_000 })

      const state = await page.evaluate(() => {
        const primaryLinks = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('header nav[aria-label="Primary"] a'),
        ).map((link) => ({ href: link.getAttribute('href'), label: link.textContent?.trim() }))
        return {
          title: document.title,
          heading: document.querySelector('h1')?.textContent?.trim(),
          text: document.body.innerText,
          primaryLinks,
        }
      })

      expect(state.title).toBe('Tools | Southern Waters Research Portal')
      expect(state.heading).toBe('Tools')
      // The Tools page now leads with the MCP connector rather than the
      // placeholder it shipped with. Assert on the tool itself, which is
      // described to every visitor; only provisioning is admin-gated, and the
      // E2E double has no admin session.
      expect(state.text).toContain('Knowledge box MCP connector')
      expect(state.primaryLinks).toContainEqual({ href: '/t/marine/ask', label: 'Ask' })
      expect(state.primaryLinks).toContainEqual({ href: '/t/marine/tools', label: 'Tools' })
      expect(state.primaryLinks.some((link) => link.href === '/t/marine/generate')).toBe(false)
    } finally {
      await page.close()
    }
  })
})

describe('search - AI answer panel and citations', () => {
  it('shows the AI Answer panel with an inline citation marker, the resources/cited header and the toggle', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/search?q=abalone`)
    try {
      await page.waitForSelector('[aria-label="AI answer"]', { timeout: 15_000 })

      // Inline `[1]` citation marker rendered as a superscript link.
      await page.waitForSelector('sup a', { timeout: 15_000 })
      const markerText = await (await page.$('sup a'))?.innerText()
      expect(markerText).toBe('[1]')

      // The resources/cited count header - waits for the answer's citation
      // to have been reported up to the results list ("1 cited").
      await page.waitForFunction(() => document.body.innerText.includes('1 cited'))

      // Retrieved/Cited toggle (role=radiogroup, aria-label="Results view").
      const bodyText = await page.evaluate(() => document.body.innerText)
      expect(bodyText).toMatch(/Retrieved \(\d+\)/)
      expect(bodyText).toMatch(/Cited \(\d+\)/)
    } finally {
      await page.close()
    }
  })

  it('a citation marker click targets the right source', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/search?q=abalone`)
    try {
      const marker = await page.waitForSelector('sup a', { timeout: 15_000 })
      await marker.click()
      // A citation marker is a react-router <Link> - a client-side route
      // change (history.pushState), not a full navigation - so this waits
      // for the URL to change rather than for a load/network event.
      await page.waitForFunction(() => location.pathname.includes('/library/'))
      await page.waitForSelector('h1', { timeout: 15_000 })

      // astral's `page.url` only updates on a full Page.frameNavigated event,
      // which a react-router client-side route change never fires - read the
      // live location from the page itself instead.
      const pathname = await page.evaluate(() => location.pathname)
      expect(pathname).toBe(`/t/marine/library/${RESOURCE_ONE.id}`)
      const heading = await (await page.$('h1'))?.innerText()
      expect(heading).toContain(RESOURCE_ONE.title)
    } finally {
      await page.close()
    }
  })
})

describe('assessment page', () => {
  it('renders its knowledge-area cards', async () => {
    const page = await browser.newPage(`${server.url}/t/marine/assessment`)
    try {
      await page.waitForSelector('h1', { timeout: 15_000 })
      const heading = await (await page.$('h1'))?.innerText()
      expect(heading).toContain('Industry Knowledge Areas')

      const bodyText = await page.evaluate(() => document.body.innerText)
      // One card per configured marine topic.
      expect(bodyText).toContain('Stock assessment')
      expect(bodyText).toContain('Aquaculture biosecurity')
      expect(bodyText).toContain('Build an assessment')
    } finally {
      await page.close()
    }
  })
})

describe('390px mobile viewport', () => {
  it('keeps the search journey usable - no horizontal body scroll, tap targets reachable', async () => {
    const page = await browser.newPage()
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${server.url}/t/marine/search?q=abalone`, { waitUntil: 'load' })
      await page.waitForSelector('[aria-label="AI answer"]', { timeout: 15_000 })
      await page.waitForSelector('sup a', { timeout: 15_000 })

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)

      // The page-level search input stays within the viewport and remains a
      // reachable tap target. On mobile, the keyboard Search action submits
      // this form; the desktop header's submit button is intentionally hidden.
      const field = await page.evaluate(() => {
        const input = document.getElementById('search-query') as HTMLInputElement | null
        const rectOf = (el: Element | null | undefined) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x, right: r.right, width: r.width, height: r.height }
        }
        return { rect: rectOf(input), enterKeyHint: input?.enterKeyHint }
      })

      expect(field.rect).not.toBeNull()
      expect(field.rect!.x).toBeGreaterThanOrEqual(0)
      expect(field.rect!.right).toBeLessThanOrEqual(390)
      expect(field.rect!.width).toBeGreaterThan(0)
      expect(field.rect!.height).toBeGreaterThan(0)
      expect(field.enterKeyHint).toBe('search')

      // The citation marker link is likewise on-screen and clickable.
      const markerRect = await page.evaluate(() => {
        const marker = document.querySelector('sup a')
        if (!marker) return null
        const r = marker.getBoundingClientRect()
        return { x: r.x, right: r.right, width: r.width, height: r.height }
      })
      expect(markerRect).not.toBeNull()
      expect(markerRect!.right).toBeLessThanOrEqual(390)
      expect(markerRect!.width).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })
})
