import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { BrandingSchema, USAGE_COLUMNS } from '@research-portal/core'
import { InsightsStore } from '../apps/api/src/stores.ts'

// The monthly usage report in Manage > Insights: a portal administrator downloads a month's CSV
// and prints the report; a curator, who reads Insights, never sees or requests it.

/** Last month in UTC, the timezone the seeded portal counts in. */
const now = new Date()
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
const MONTH = lastMonth.toISOString().slice(0, 7)

/** The knowledge box behind Manage: two counters, and one document added in the month. */
const management = new Proxy({}, {
  get: (_target, method) => {
    if (method === 'counters') {
      return () => Promise.resolve({ resources: 2, paragraphs: 14, sentences: 28, indexMb: 1 })
    }
    if (method === 'thumbnailResponse') return () => Promise.resolve(null)
    if (method === 'recentResources') return () => Promise.resolve([])
    if (method === 'addedBetween') {
      return () => Promise.resolve({ created: [`${MONTH}-04T02:00:00.000Z`], readBackTo: null })
    }
    return () => Promise.reject(new Error(`Fixture service unavailable: ${String(method)}`))
  },
}) as NonNullable<BuildAppOptions['management']>

function seededInsights(): { insights: InsightsStore; directory: string } {
  const directory = Deno.makeTempDirSync({ prefix: 'usage-e2e-' })
  const insights = new InsightsStore(directory)
  const ask = (day: string, answered: boolean, groundedness: number | null) =>
    insights.record('marine', {
      ts: `${MONTH}-${day}T03:00:00.000Z`,
      answerId: `answer-${day}-${groundedness}`,
      citedResources: answered
        ? [{
          resourceId: 'res-1',
          rank: 1,
          topicIds: ['stock-assessment', 'marine-sustainability'],
        }]
        : [],
      ...(answered ? { inputTokens: 120, outputTokens: 30 } : {}),
      question: 'What did the 2019 abalone survey find?',
      answered,
      citations: answered ? 2 : 0,
      durationSec: 3,
      answerRelevance: answered ? 4 : null,
      groundedness,
      contextRelevance: answered ? 3 : null,
    })
  ask('03', true, 4)
  ask('03', true, 2)
  ask('04', false, null)
  // This month: a question the collection could not answer, for Insights' knowledge gaps.
  insights.record('marine', {
    ts: new Date().toISOString(),
    question: 'Which seagrass beds recovered after the 2022 floods?',
    answered: false,
    citations: 0,
    durationSec: null,
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
  })
  for (const ts of [`${MONTH}-03T03:00:00.000Z`, new Date().toISOString()]) {
    insights.record('marine', {
      kind: 'search',
      id: `search-${ts.slice(0, 7)}`,
      ts,
      durationSec: 0.8,
      resources: [{ resourceId: 'res-1', rank: 1 }],
    })
    insights.record('marine', {
      kind: 'open',
      source: 'search',
      sourceId: `search-${ts.slice(0, 7)}`,
      ts,
      resourceId: 'res-1',
      rank: 1,
    })
  }
  insights.record('marine', {
    ts: new Date().toISOString(),
    question: 'What does the coastal study find?',
    answered: true,
    citations: 1,
    durationSec: 3,
    answerRelevance: 4,
    groundedness: 4,
    contextRelevance: 4,
    answerId: 'answer-current',
    inputTokens: 120,
    outputTokens: 30,
    citedResources: [{
      resourceId: 'res-1',
      rank: 1,
      topicIds: ['stock-assessment', 'marine-sustainability'],
    }],
  })
  return { insights, directory }
}

async function click(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const button = document.querySelector<HTMLButtonElement>(selector)
    if (!button) throw new Error(`Missing ${selector}`)
    button.focus()
    button.click()
  }, { args: [selector] })
}

/** Capture downloads instead of saving them: each file's name and text. */
async function captureDownloads(page: Page) {
  await page.evaluate(() => {
    const files: { name: string; text: Promise<string> }[] = []
    const blobs = new Map<string, Blob>()
    Object.assign(globalThis, { usageFiles: files })
    const create = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      const url = create(blob as Blob)
      blobs.set(url, blob as Blob)
      return url
    }
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return click.call(this)
      files.push({ name: this.download, text: blobs.get(this.href)!.text() })
    }
  })
}

const files = (page: Page) =>
  page.evaluate(async () => {
    const files = (globalThis as unknown as {
      usageFiles: { name: string; text: Promise<string> }[]
    }).usageFiles
    return await Promise.all(
      files.map(async (file) => ({ name: file.name, text: await file.text })),
    )
  })

Deno.test('a portal administrator downloads the month as CSV and prints the report', async () => {
  const { insights, directory } = seededInsights()
  const server = startTestServer({ identity: { role: 'portal-admin' }, management, insights })
  const browser = await launch()
  const page = await browser.newPage('about:blank')
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${server.url}/t/marine/manage?tab=insights`)
    await page.bringToFront()
    await page.waitForSelector('[data-usage-report-panel]')
    await assertCurrentBuild(page)
    await captureDownloads(page)

    // A labelled month list, starting on the month just ended.
    const picker = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('[data-usage-report-panel] select')!
      return {
        label: document.querySelector(`label[for="${select.id}"]`)?.textContent,
        value: select.value,
        options: select.options.length,
      }
    })
    expect(picker).toEqual({ label: 'Month', value: MONTH, options: 24 })
    expect(server.requests.some((r) => r.path.includes('/insights/usage'))).toBe(false)

    await click(page, '[data-usage-download]')
    await page.waitForFunction(() =>
      document.querySelector('[data-usage-status]')?.textContent?.startsWith('Downloaded')
    )
    const [file] = await files(page)
    expect(file!.name).toBe(`usage-marine-${MONTH}.csv`)
    expect(file!.text.startsWith('# CorpusKit usage report\r\n# Portal: marine\r\n')).toBe(true)
    expect(file!.text).toContain(`"${MONTH}-03","2","2","0","1","1","2","3.0"`)
    expect(file!.text).toContain(`"${MONTH}-04","1","0","1","0","1","0","","0","0","1","0",`)
    expect(file!.text).toContain('"total","3","2","1","1","2","2","3.0"')
    // Counts only: the question never leaves in the file.
    expect(file!.text).not.toContain('abalone')
    expect(file!.text).not.toContain('res-1')
    expect(file!.text).not.toContain('answer-03')
    expect(file!.text).toContain('""questions"":2')
    expect(file!.text).toContain('""citedDocuments"":1')
    expect(file!.text).toContain('"input_tokens","output_tokens","topics"')

    await click(page, '[data-usage-view]')
    await page.waitForSelector('[data-usage-report]')
    const report = await page.evaluate(() => {
      const table = document.querySelector('[data-usage-report] table')!
      return {
        heading: document.querySelector('[data-usage-report] h3')?.textContent,
        columns: table.querySelectorAll('thead th[scope="col"]').length,
        rows: table.querySelectorAll('tbody th[scope="row"]').length,
        total: table.querySelector('tfoot th[scope="row"]')?.textContent,
        caption: table.querySelector('caption')?.textContent,
        text: document.querySelector('[data-usage-report]')!.textContent,
      }
    })
    const days = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0))
      .getUTCDate()
    expect(report.columns).toBe(
      USAGE_COLUMNS.filter((c) => c.key !== 'notes' && c.key !== 'topics' && !c.timing).length,
    )
    expect(report.rows).toBe(days)
    expect(report.total).toBe('Total')
    expect(report.caption).toContain('Usage by day for')
    expect(report.text).toContain('What each column counts')
    expect(report.text).not.toContain('abalone')

    // Every control is at least 44 by 44 pixels.
    const targets = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-usage-report-panel] select, [data-usage-report-panel] .rp-usage-control',
        ),
      ].map((element) => {
        const box = element.getBoundingClientRect()
        return Math.min(box.width, box.height)
      })
    )
    expect(targets.length).toBeGreaterThanOrEqual(4)
    for (const size of targets) expect(size).toBeGreaterThanOrEqual(44)

    // Print shows only the report: a copy outside the app while the dialog is open.
    await page.evaluate(() => {
      Object.assign(globalThis, { printed: 0 })
      globalThis.print = () => {
        ;(globalThis as unknown as { printed: number }).printed++
      }
    })
    await click(page, '[data-usage-print-button]')
    await page.waitForFunction(() => (globalThis as unknown as { printed: number }).printed === 1)
    const printing = await page.evaluate(() => ({
      root: document.documentElement.classList.contains('rp-printing-usage'),
      copy: document.querySelector('body > [data-usage-print] [data-usage-report]') !== null,
    }))
    expect(printing).toEqual({ root: true, copy: true })
    await page.evaluate(() => dispatchEvent(new Event('afterprint')))
    await page.waitForFunction(() => !document.querySelector('[data-usage-print]'))
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('rp-printing-usage')),
    ).toBe(false)

    // At 320 pixels the page reflows: only the table scrolls, inside its own region.
    await page.setViewportSize({ width: 320, height: 900 })
    await page.evaluate(() => document.fonts.ready)
    const reflow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      region: (() => {
        const region = document.querySelector<HTMLElement>('[data-usage-report] [role="region"]')!
        return {
          focusable: region.tabIndex === 0,
          scrolls: region.scrollWidth > region.clientWidth,
        }
      })(),
    }))
    expect(reflow.overflow).toBeLessThanOrEqual(1)
    expect(reflow.region).toEqual({ focusable: true, scrolls: true })
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('a curator reads Insights but is never offered or sent the usage report', async () => {
  const { insights, directory } = seededInsights()
  const server = startTestServer({ identity: { role: 'curator' }, management, insights })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=insights`)
  try {
    await page.waitForSelector('[data-admin-insights]')
    await page.waitForFunction(() => !document.querySelector('main .rp-shimmer'))
    expect(await page.$('[data-usage-report-panel]')).toBeNull()
    // Curators read this month's knowledge gaps in the portal.
    const gaps = await page.evaluate(() =>
      document.querySelector('[data-month-gaps]')?.textContent ?? ''
    )
    expect(gaps).toContain('Which seagrass beds recovered after the 2022 floods?')
    const snapshot = await page.evaluate(async () =>
      (await fetch('/api/admin/t/marine/insights')).json()
    )
    expect(Object.keys(snapshot.usage).sort()).toEqual(['month', 'totals'])
    expect(snapshot.usage.days).toBeUndefined()
    expect(snapshot.usage.generatedAt).toBeUndefined()
    expect(
      await page.evaluate(() => document.querySelector('[data-evidence-coverage]')?.textContent),
    ).toContain('Evidence coverage by topic')
    expect(server.requests.some((r) => r.path.includes('/insights/usage'))).toBe(false)
    const denied = await page.evaluate(
      async (month) => (await fetch(`/api/admin/t/marine/insights/usage?month=${month}`)).status,
      { args: [MONTH] },
    )
    expect(denied).toBe(403)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('Insights and the monthly report show topics, coverage, opens, tokens and search times across appearance settings', async () => {
  const { insights, directory } = seededInsights()
  const server = startTestServer({ identity: { role: 'portal-admin' }, management, insights })
  const browser = await launch()
  const page = await browser.newPage('about:blank')
  const review = Deno.env.get('USAGE_REVIEW') === '1'
  try {
    if (review) await Deno.mkdir('.review/usage-analytics', { recursive: true })
    for (const scheme of ['light', 'dark'] as const) {
      server.tenants.patchBranding(
        'marine',
        BrandingSchema.parse({
          ...server.tenants.get('marine')!.branding,
          paletteId: scheme === 'dark' ? 'observatory' : 'default',
          shape: 'soft',
          density: 'comfortable',
          typography: 'lexend-zilla',
        }),
      )
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
        await page.goto(`${server.url}/t/marine/manage?tab=insights`)
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [scheme],
        })
        await page.goto(`${server.url}/t/marine/manage?tab=insights`)
        await page.waitForSelector('[data-usage-analytics]')
        await assertCurrentBuild(page)
        await page.evaluate(() => document.fonts.ready)
        const cards = await page.evaluate(() => ({
          topics: document.querySelector('[data-top-topics]')?.textContent,
          coverage: document.querySelector('[data-evidence-coverage]')?.textContent,
          opens: document.querySelector('[data-usage-opens]')?.textContent,
          consumption: document.querySelector('[data-usage-consumption]')?.textContent,
          width: innerWidth,
          overflow: document.documentElement.scrollWidth - innerWidth,
          radius: getComputedStyle(document.querySelector('[data-top-topics]')!).borderRadius,
          token: getComputedStyle(document.querySelector('[data-top-topics]')!).getPropertyValue(
            '--rp-radius',
          ).trim(),
        }))
        expect(cards.width).toBe(width)
        expect(cards.overflow).toBeLessThanOrEqual(1)
        expect(cards.topics).toContain('Stock assessment')
        expect(cards.coverage).toContain('1 of 1 documents')
        expect(cards.coverage).toContain('not answer quality')
        expect(cards.opens).toContain('50%')
        expect(cards.consumption).toContain('120')
        expect(cards.consumption).toContain('0.8s / 0.8s / 0.8s')
        expect(parseFloat(cards.radius)).toBeGreaterThan(0)
        expect(cards.token.length).toBeGreaterThan(0)
        if (review) {
          await Deno.writeFile(
            `.review/usage-analytics/insights-full-${width}-${scheme}.png`,
            await page.screenshot({ captureBeyondViewport: true }),
          )
          await page.evaluate(() => {
            const card = document.querySelector('[data-usage-analytics]')!
            scrollTo(
              0,
              card.getBoundingClientRect().top + scrollY -
                (document.querySelector('header')!.getBoundingClientRect().height + 32),
            )
          })
          await Deno.writeFile(
            `.review/usage-analytics/insights-${width}-${scheme}.png`,
            await page.screenshot({ captureBeyondViewport: false }),
          )
          if (width === 390 && scheme === 'light') {
            await page.evaluate(() => {
              document.documentElement.style.fontSize = '200%'
              const card = document.querySelector('[data-usage-analytics]')!
              scrollTo(
                0,
                card.getBoundingClientRect().top + scrollY -
                  (document.querySelector('header')!.getBoundingClientRect().height + 32),
              )
            })
            expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
              .toBeLessThanOrEqual(1)
            await Deno.writeFile(
              '.review/usage-analytics/insights-text200-390-light.png',
              await page.screenshot({ captureBeyondViewport: false }),
            )
            await page.evaluate(() => document.documentElement.style.removeProperty('font-size'))
          }
        }
        await click(page, '[data-usage-view]')
        await page.waitForSelector('[data-usage-report] [data-usage-analytics]')
        expect(
          await page.evaluate(() =>
            document.querySelector('[data-usage-report] [data-top-topics]')?.textContent
          ),
        ).toContain('Stock assessment')
        if (review) {
          await Deno.writeFile(
            `.review/usage-analytics/usage-report-full-${width}-${scheme}.png`,
            await page.screenshot({ captureBeyondViewport: true }),
          )
          await page.evaluate(() => {
            const card = document.querySelector('[data-usage-report] [data-usage-analytics]')!
            scrollTo(
              0,
              card.getBoundingClientRect().top + scrollY -
                (document.querySelector('header')!.getBoundingClientRect().height + 32),
            )
          })
          await Deno.writeFile(
            `.review/usage-analytics/usage-report-${width}-${scheme}.png`,
            await page.screenshot({ captureBeyondViewport: false }),
          )
        }
        if (width === 390 && scheme === 'light') {
          await page.evaluate(async () => {
            document.documentElement.style.fontSize = '200%'
            await document.fonts.ready
            const card = document.querySelector('[data-usage-report] [data-usage-analytics]')!
            scrollTo(
              0,
              card.getBoundingClientRect().top + scrollY -
                (document.querySelector('header')!.getBoundingClientRect().height + 32),
            )
          })
          const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - innerWidth
          )
          expect(overflow).toBeLessThanOrEqual(1)
          if (review) {
            await Deno.writeFile(
              '.review/usage-analytics/usage-report-text200-390-light.png',
              await page.screenshot({ captureBeyondViewport: false }),
            )
          }
        }
      }
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('opening a search result sends a real beacon and updates Insights without exporting identifiers', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' }, management })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/search?q=abalone&answer=0`)
  try {
    await page.waitForSelector('#result-res-1 h3 a')
    await click(page, '#result-res-1 h3 a')
    await page.waitForFunction(() => location.pathname.endsWith('/library/res-1'))
    await page.goto(`${server.url}/t/marine/manage?tab=insights`)
    await page.waitForSelector('[data-usage-opens]')
    const text = await page.evaluate(() =>
      document.querySelector('[data-usage-opens]')!.textContent
    )
    expect(text).toContain('Opens1')
    expect(text).toContain('Mean rank opened1')
    const summary = await page.evaluate(async () =>
      (await fetch('/api/admin/t/marine/insights')).json()
    )
    expect(summary.usage.totals.opens).toBe(1)
    expect(summary.usage.totals.openRate).toBe(1 / summary.usage.totals.searches)
    expect(server.requests.some((r) => r.path === '/api/t/marine/events/open' && r.status === 204))
      .toBe(true)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('opening an answer citation sends its answer id and cited rank', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'usage-citation-e2e-' })
  const insights = new InsightsStore(directory)
  const server = startTestServer({ identity: { role: 'portal-admin' }, management, insights })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/search?q=abalone`)
  try {
    await page.waitForSelector('section[aria-label="AI answer"] sup a')
    await page.waitForFunction(() =>
      document.querySelector('section[aria-label="AI answer"]')?.textContent?.includes(
        'Answer complete',
      )
    )
    await click(page, 'section[aria-label="AI answer"] sup a')
    await page.waitForFunction(() => location.pathname.endsWith('/library/res-1'))
    // Awaiting a subsequent request ensures the asynchronous beacon has reached the server.
    await page.goto(`${server.url}/t/marine/manage?tab=insights`)
    await page.waitForSelector('[data-usage-opens]')
    const opened = insights.eventsBetween('marine', 0, Infinity).events.filter((e) =>
      e.kind === 'open'
    )
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ source: 'answer', resourceId: 'res-1', rank: 1 })
    const asks = insights.asksBetween('marine', 0, Infinity).asks
    expect(opened[0]!.sourceId).toBe(asks[0]!.answerId)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    Deno.removeSync(directory, { recursive: true })
  }
})
