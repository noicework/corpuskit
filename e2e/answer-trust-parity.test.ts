import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type Browser, launch, type Page } from '@astral/astral'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { startTestServer, type TestServer } from './support/test-server.ts'

// Ask and Search both answer from the real `/ask` route, which binds and audits the double's
// answer against this extracted text: "12%" and "2019" are found beside their claim, and any
// year the question adds to the answer is not.
const EXTRACTED =
  'Surveys across the southern region recorded a sustained 12% decline in abalone ' +
  'populations since 2019, with marine heatwaves identified as the leading stressor.'

let browser: Browser
let server: TestServer

beforeAll(async () => {
  server = startTestServer({
    management: {
      rephrase: () => Promise.resolve(null),
      resourceExtraction: () =>
        Promise.resolve({ text: EXTRACTED, chars: EXTRACTED.length, paragraphs: 1 }),
      askStructured: () => Promise.resolve({ object: { verdicts: [], questions: [] } }),
      thumbnailResponse: () => Promise.resolve(new Response(null, { status: 404 })),
    } as unknown as BuildAppOptions['management'],
  })
  browser = await launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

interface TrustSignals {
  confidence: string | null
  marks: string[]
  badge: string | null
  badgeTitle: string | null
}

/** What the answer's own trust controls say, read from the rendered page. */
function readSignals(page: Page, root: string): Promise<TrustSignals> {
  return page.evaluate((root) => {
    const answer = document.querySelector(root)!
    const badge = answer.querySelector('[data-audit-badge]')
    return {
      confidence: answer.querySelector('[data-confidence]')?.getAttribute('data-confidence') ??
        null,
      marks: [...answer.querySelectorAll('mark')].map((mark) => mark.textContent ?? ''),
      badge: badge?.textContent ?? null,
      badgeTitle: badge?.getAttribute('title') ?? null,
    }
  }, { args: [root] })
}

async function askSignals(question: string): Promise<TrustSignals> {
  const page = await browser.newPage(`${server.url}/t/marine`)
  try {
    await page.evaluate(() => localStorage.removeItem('rp-chat-marine'))
    await page.goto(`${server.url}/t/marine/ask`)
    await page.waitForSelector('#ask-composer', { timeout: 15_000 })
    await page.evaluate((question) => {
      const input = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        question,
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, { args: [question] })
    await page.waitForFunction(() =>
      !document.querySelector('#ask-composer')?.closest('form')
        ?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
    )
    await page.evaluate(() =>
      document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
    )
    // The quality control lands on the actions row once `done` has replaced the streamed text.
    await page.waitForSelector('main [data-confidence]', { timeout: 30_000 })
    return await readSignals(page, 'main')
  } finally {
    await page.close()
  }
}

async function searchSignals(question: string): Promise<TrustSignals> {
  const page = await browser.newPage(
    `${server.url}/t/marine/search?q=${encodeURIComponent(question)}`,
  )
  try {
    await page.waitForSelector('section[aria-label="AI answer"] [data-confidence]', {
      timeout: 30_000,
    })
    return await readSignals(page, 'section[aria-label="AI answer"]')
  } finally {
    await page.close()
  }
}

describe('one answer, the same trust signals on Ask and Search', () => {
  it('marks the year the cited passages do not carry, and reads Low on both pages', async () => {
    const question = 'abalone decline since 1987 in Tasmania'
    const ask = await askSignals(question)
    const search = await searchSignals(question)
    console.log(`ask: ${JSON.stringify(ask)}\nsearch: ${JSON.stringify(search)}`)
    expect(ask.confidence).toBe('low')
    expect(ask.marks.length).toBeGreaterThan(0)
    expect(new Set(ask.marks)).toEqual(new Set(['1987']))
    expect(ask.badgeTitle).toContain('Years the cited resources do not carry: 1987.')
    expect(search).toEqual(ask)
  })

  it('reaches High on both pages when the audit verified every figure', async () => {
    // The platform scores both answers 4.5 for groundedness; only the audit can make it High.
    const question = 'abalone decline'
    const ask = await askSignals(question)
    const search = await searchSignals(question)
    expect(ask.confidence).toBe('high')
    expect(ask.marks).toEqual([])
    expect(ask.badge).toBe('1 figure checked')
    expect(search).toEqual(ask)
  })
})
