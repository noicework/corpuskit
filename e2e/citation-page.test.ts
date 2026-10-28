import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import {
  CITED_PAGE,
  DoubleProvider,
  MATCHED_PASSAGE,
  RESOURCE_ONE,
} from './support/double-provider.ts'
import { startTestServer, type TestServer } from './support/test-server.ts'

// A citation opens the stored PDF at the page the answer cited, with the cited
// passage highlighted, the page announced and focus on the page itself. Real
// Ask and document pages, the real pdf.js reader and a real PDF; only retrieval
// and the stored file are fixtures.

const PAGES = 5
/** A highlight painted over the cited passage on the rendered page. */
const HIGHLIGHT = '.rp-library-pdf-reader [data-pdf-highlight]'

/** Wraps text at word boundaries so a passage spans several text runs, as real PDFs do. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

/** A five-page, text-bearing PDF that carries the cited passage on `CITED_PAGE` only. */
function citedPdf(): Uint8Array {
  const filler = (n: number) => [
    `Section ${n}: survey sites and methods for the monitoring program.`,
    'Divers counted juvenile abalone along fixed transects each autumn.',
    'Temperature loggers recorded water temperature every 30 minutes.',
  ]
  const pages = Array.from({ length: PAGES }, (_, i) => i + 1).map((n) => ({
    heading: n === 1 ? RESOURCE_ONE.title : `Part ${n}`,
    lines: n === CITED_PAGE
      ? ['Findings', '', ...wrap(MATCHED_PASSAGE, 64), '', ...filler(n)]
      : filler(n),
  }))
  const escape = (value: string) => value.replace(/[\\()]/g, '\\$&')
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${PAGES} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, page] of pages.entries()) {
    const stream = [
      `BT /F1 18 Tf 50 780 Td (${escape(page.heading)}) Tj ET`,
      'BT /F2 11 Tf 16 TL 50 744 Td',
      ...page.lines.map((line, i) => `${i ? 'T* ' : ''}(${escape(line)}) Tj`),
      'ET',
      `BT /F2 10 Tf 50 48 Td (Page ${index + 1} of ${PAGES}) Tj ET`,
    ].join('\n')
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    )
  }
  // All content is ASCII, so string offsets are also byte offsets in the xref.
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

const PDF_BYTES = citedPdf()
/** The document's extracted text: the passage the audit checks the answer against. */
const EXTRACTED = `${MATCHED_PASSAGE}\n\nDivers counted juvenile abalone along fixed transects.`

/**
 * The management surface the document page and the answer audit read, as a proxy so an
 * operation this journey does not model answers an empty list rather than failing the page.
 */
function pdfManagement(): NonNullable<BuildAppOptions['management']> {
  const content = (id: string) =>
    id === RESOURCE_ONE.id
      ? {
        id,
        title: RESOURCE_ONE.title,
        kind: 'pdf',
        summary: RESOURCE_ONE.summary,
        texts: [{ fieldId: 'body', text: EXTRACTED }],
        transcript: [],
        files: [{ group: 'file', fieldId: 'report', contentType: 'application/pdf' }],
      }
      : null
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    resourceContent: (_config, id) => Promise.resolve(content(String(id))),
    resourceFull: (_config, id) => Promise.resolve(content(String(id))),
    resourceExtraction: () =>
      Promise.resolve({ status: 'PROCESSED', text: EXTRACTED, chars: EXTRACTED.length }),
    fileStream: (_config, id, fieldId) =>
      Promise.resolve(
        id === RESOURCE_ONE.id && fieldId === 'report'
          ? new Response(PDF_BYTES.slice(), {
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(PDF_BYTES.length),
            },
          })
          : new Response(null, { status: 404 }),
      ),
    thumbnailResponse: () => Promise.resolve(new Response(null, { status: 404 })),
    askStructured: () => Promise.resolve({ object: { questions: [] }, sources: [] }),
    rephrase: () => Promise.resolve(null),
    summarize: () => Promise.resolve(null),
    counters: () => Promise.resolve({ resources: 2, paragraphs: 2, sentences: 4, indexMb: 1 }),
    invalidate: () => undefined,
  }
  return new Proxy({}, {
    get: (_target, property) => {
      // Never thenable: only named operations answer.
      if (typeof property !== 'string' || property === 'then') return undefined
      return (...args: unknown[]) => handlers[property]?.(...args) ?? Promise.resolve([])
    },
  }) as NonNullable<BuildAppOptions['management']>
}

/** The answer's source names no page, so a page in the citation's link can only be its own. */
class CitedPageProvider extends DoubleProvider {
  override async *ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    for await (const event of super.ask(tenant, query)) {
      yield event.type === 'sources'
        ? { ...event, resources: event.resources.map(({ matchedPage: _page, ...rest }) => rest) }
        : event
    }
  }
}

let browser: Browser
let server: TestServer
let screenshots: string

beforeAll(async () => {
  // Citations are part of public Ask, with no analyst grant.
  server = startTestServer({ management: pdfManagement(), provider: new CitedPageProvider() })
  browser = await launch()
  screenshots = '.planning/logs/citation-page'
  await Deno.mkdir(screenshots, { recursive: true })
  console.log(`Citation page screenshots: ${screenshots}`)
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function openPortal(page: Page, scheme: string, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 1100 : 1000 })
  await page.evaluate((choice) => {
    localStorage.setItem('rp-scheme', choice)
    localStorage.removeItem('rp-chat-marine')
  }, { args: [scheme] })
}

/** Waits (at most three seconds) for the window to stop scrolling, then reports where the reader sits. */
function readerTopOnceSettled(page: Page) {
  return page.evaluate(async () => {
    const deadline = performance.now() + 3000
    let last = -1
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      if (scrollY === last) break
      last = scrollY
    }
    return document.querySelector('.rp-library-pdf-reader')!.getBoundingClientRect().top
  })
}

/** WCAG contrast ratio of two computed `rgb()` colours. */
function contrast(a: string, b: string): number {
  const luminance = (colour: string) => {
    const [r, g, bl] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** The reader's state, read from what a reader and a screen reader get. */
function readerState(page: Page) {
  return page.evaluate(() => {
    const reader = document.querySelector('.rp-library-pdf-reader')
    const stage = reader?.querySelector<HTMLElement>('[role="group"][tabindex="0"]')
    return {
      pageInput: reader?.querySelector<HTMLInputElement>('.rp-library-pdf-page')?.value,
      stageLabel: stage?.getAttribute('aria-label'),
      announced: reader?.querySelector('.sr-only[role="status"]')?.textContent,
      highlights: reader?.querySelectorAll('[data-pdf-highlight]').length ?? 0,
      focusOnStage: stage !== null && stage !== undefined && document.activeElement === stage,
      ringVisible: stage?.matches(':focus-visible') === true &&
        getComputedStyle(stage).boxShadow.includes('inset'),
      // The ring's two bands, then the pane the page sits in: what the focus band is seen against.
      ringColours: [...(stage ? getComputedStyle(stage).boxShadow : '').matchAll(/rgba?\([^)]*\)/g)]
        .map((m) => m[0]),
      paneColour: getComputedStyle(reader!.querySelector('.rp-library-pdf-scroll')!)
        .backgroundColor,
      menuControls: reader?.querySelector('[aria-haspopup="menu"]')?.getAttribute('aria-controls'),
      overflow: document.documentElement.scrollWidth - innerWidth,
      search: location.search,
    }
  })
}

describe('a citation opens the PDF at the cited page', () => {
  for (const [scheme, width] of [['light', 1440], ['dark', 390]] as const) {
    it(`${scheme}, ${width}px: Ask citation, keyboard activation, page ${CITED_PAGE} opens highlighted`, async () => {
      const page = await browser.newPage(`${server.url}/t/marine`)
      try {
        await openPortal(page, scheme, width)
        await page.goto(`${server.url}/t/marine/ask`)
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
        await page.waitForSelector('sup a', { timeout: 15_000 })
        await page.waitForFunction(() => !document.querySelector('.rp-answer-checking'))
        const href = await page.evaluate(() =>
          document.querySelector<HTMLAnchorElement>('sup a')!.getAttribute('href')
        )
        // The marker carries the cited paragraph and its page.
        expect(href).toContain(`/t/marine/library/${RESOURCE_ONE.id}?passage=`)
        expect(href).toContain(`&page=${CITED_PAGE}`)

        // Keyboard: focus the marker and follow it with Enter.
        await page.keyboard.press('Tab')
        await page.evaluate(() => document.querySelector<HTMLAnchorElement>('sup a')!.focus())
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => location.pathname.includes('/library/'))
        await page.waitForSelector(HIGHLIGHT, { timeout: 30_000 })
        const arrived = await readerState(page)
        console.log(`${scheme}/${width} arrived: ${JSON.stringify(arrived)}`)
        expect(arrived.search).toContain(`page=${CITED_PAGE}`)
        expect(arrived.pageInput).toBe(String(CITED_PAGE))
        expect(arrived.stageLabel).toBe(
          `${RESOURCE_ONE.title} - PDF page ${CITED_PAGE} of ${PAGES}`,
        )
        expect(arrived.announced).toBe(`Cited passage highlighted on page ${CITED_PAGE}`)
        expect(arrived.focusOnStage).toBe(true)
        // The ring is drawn inside the page, where its scroll pane cannot clip it.
        expect(arrived.ringVisible).toBe(true)
        // WCAG 2.4.7 and 1.4.11: the focus band reads at 3:1 against both of its neighbours.
        const [halo, ring] = arrived.ringColours
        expect(contrast(ring!, halo!)).toBeGreaterThanOrEqual(3)
        expect(contrast(ring!, arrived.paneColour)).toBeGreaterThanOrEqual(3)
        // The closed menu names no element it does not show (WCAG 4.1.2).
        expect(arrived.menuControls).toBeNull()
        expect(arrived.overflow).toBeLessThanOrEqual(1)
        // The window brings the reader to the top of the screen, under the header.
        const top = await readerTopOnceSettled(page)
        expect(top).toBeGreaterThanOrEqual(0)
        expect(top).toBeLessThan(width === 390 ? 1100 / 2 : 1000 / 2)
        // The quoted passage above the reader names the same page.
        expect(
          await page.evaluate(
            (label) => [...document.querySelectorAll('p')].some((p) => p.textContent === label),
            { args: [`From page ${CITED_PAGE}`] },
          ),
        ).toBe(true)
        await Deno.writeFile(
          `${screenshots}/arrived-${scheme}-${width}.png`,
          await page.screenshot(),
        )

        // The arrow keys page on from the cited page, and each page is announced.
        await page.keyboard.press('ArrowRight')
        await page.waitForFunction(
          (n) => document.querySelector<HTMLInputElement>('.rp-library-pdf-page')?.value === n,
          { args: [String(CITED_PAGE + 1)] },
        )
        const next = await readerState(page)
        expect(next.announced).toBe(`Page ${CITED_PAGE + 1} of ${PAGES}`)
        expect(next.highlights).toBe(0)
        expect(next.focusOnStage).toBe(true)
        await page.keyboard.press('ArrowLeft')
        await page.waitForSelector(HIGHLIGHT, { timeout: 15_000 })
        const back = await readerState(page)
        expect(back.pageInput).toBe(String(CITED_PAGE))
        expect(back.focusOnStage).toBe(true)
      } finally {
        await page.close()
      }
    })
  }

  it('document chat: a citation that names its page opens the PDF there, not the text', async () => {
    const page = await browser.newPage(`${server.url}/t/marine`)
    try {
      await openPortal(page, 'light', 1440)
      await page.goto(`${server.url}/t/marine/library/${RESOURCE_ONE.id}`)
      await page.waitForSelector('#ask-document', { timeout: 15_000 })
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('#ask-document')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'What happened to abalone numbers?',
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await page.evaluate(() =>
        document.querySelector('#ask-document')!.closest('form')!.requestSubmit()
      )
      const marker = 'section[aria-labelledby="chat-heading"] sup a'
      await page.waitForSelector(marker, { timeout: 15_000 })
      expect(
        await page.evaluate((m) => document.querySelector(m)!.getAttribute('href'), {
          args: [marker],
        }),
      ).toContain(`&page=${CITED_PAGE}`)
      await page.evaluate((m) => document.querySelector<HTMLAnchorElement>(m)!.focus(), {
        args: [marker],
      })
      await page.keyboard.press('Enter')
      await page.waitForSelector(HIGHLIGHT, { timeout: 30_000 })
      const opened = await readerState(page)
      expect(opened.search).toContain(`page=${CITED_PAGE}`)
      expect(opened.pageInput).toBe(String(CITED_PAGE))
      expect(opened.announced).toBe(`Cited passage highlighted on page ${CITED_PAGE}`)
      expect(opened.focusOnStage).toBe(true)
      // The jump went to the PDF: the extracted text stays folded away.
      expect(
        await page.evaluate(() =>
          document.querySelector<HTMLElement>('[data-extracted-text-region]')?.hidden
        ),
      ).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('a cited passage with no page is found in the text layer and opened there', async () => {
    const page = await browser.newPage(`${server.url}/t/marine`)
    try {
      await openPortal(page, 'light', 1440)
      await page.goto(
        `${server.url}/t/marine/library/${RESOURCE_ONE.id}?passage=${
          encodeURIComponent(MATCHED_PASSAGE.slice(0, 300))
        }`,
      )
      await page.waitForSelector(HIGHLIGHT, { timeout: 30_000 })
      const found = await readerState(page)
      console.log(`text-layer fallback: ${JSON.stringify(found)}`)
      expect(found.pageInput).toBe(String(CITED_PAGE))
      expect(found.announced).toBe(`Cited passage highlighted on page ${CITED_PAGE}`)
      expect(found.focusOnStage).toBe(true)
    } finally {
      await page.close()
    }
  })
})
