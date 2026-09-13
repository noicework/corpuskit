import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { captureBoundary } from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

const management = {
  thumbnailResponse: () => Promise.resolve(null),
  rephrase: () => Promise.resolve(null),
  resourceExtraction: () =>
    Promise.resolve({ text: 'Marine heatwaves affect abalone populations.' }),
  askStructured: () =>
    Promise.resolve({
      object: {
        title: 'Abalone research',
        entries: [{ question: 'What affects abalone?', answer: 'Marine heatwaves.' }],
        questions: [{
          question: 'What affects abalone?',
          options: ['Heatwaves', 'Nothing'],
          correct_index: 0,
          explanation: 'Marine heatwaves affect populations.',
          topic: 'Abalone',
          source_resource_id: 'res-1',
        }],
      },
      sources: [{
        id: 'res-1',
        title: 'Abalone stock health',
        slug: 'abalone-stock-health',
        topics: [],
      }],
    }),
} as unknown as BuildAppOptions['management']

async function click(page: Page, text: string) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === text
    )
    if (!button) throw new Error(`Missing ${text}`)
    button.click()
  }, { args: [text] })
}
async function fill(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    const prototype = input.tagName === 'INPUT'
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector, value] })
}
async function generate(page: Page) {
  await page.waitForSelector('#generate-query')
  await fill(page, '#generate-query', 'Abalone research')
  await page.waitForFunction(() =>
    !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
  )
  await page.evaluate(() =>
    document.querySelector('#generate-query')!.closest('form')!.requestSubmit()
  )
}

for (const removed of ['portal.export', 'portal.investigate']) {
  Deno.test(`generation independently obeys ${removed}`, async () => {
    const server = startTestServer({ identity: { role: 'analyst' }, management })
    const browser = await launch()
    const page = await browser.newPage(`${server.url}/t/marine/generate?kind=faq`)
    try {
      await page.waitForSelector('#generate-query')
      const reduce = async () => {
        await page.evaluate((removed) => {
          const original = fetch
          globalThis.fetch = async (input, init) => {
            const response = await original(input, init)
            if (!String(input).includes('/auth/me')) return response
            const value = await response.json()
            value.portalAccess.permissions = value.portalAccess.permissions.filter((p: string) =>
              p !== removed
            )
            return Response.json(value)
          }
          dispatchEvent(new Event('focus'))
        }, { args: [removed] })
      }
      await reduce()
      await generate(page)
      await page.waitForFunction(() => document.body.textContent?.includes('What affects abalone?'))
      const text = await page.evaluate(() => document.body.textContent ?? '')
      expect(text.includes('Export to Word')).toBe(removed !== 'portal.export')
      expect(text.includes('Export to PDF')).toBe(removed !== 'portal.export')
      expect(await page.$('button[aria-label="Save to investigation"]') !== null).toBe(
        removed !== 'portal.investigate',
      )
      expect(server.requests.some((r) => r.path.endsWith('/generate') && r.status === 200)).toBe(
        true,
      )
      for (const scheme of ['light', 'dark']) {
        server.tenants.patchBranding('marine', {
          paletteId: scheme === 'dark' ? 'observatory' : 'default',
          shape: scheme === 'dark' ? 'soft' : 'square',
          density: 'comfortable',
          typography: 'lexend-zilla',
        })
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [scheme],
        })
        await page.goto(`${server.url}/t/marine/generate?kind=faq`)
        await page.waitForSelector('#generate-query')
        await reduce()
        await generate(page)
        await page.waitForFunction(() =>
          document.body.textContent?.includes('What affects abalone?')
        )
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-11-01',
            `generate-${removed}-${scheme}-${width}`,
            width,
          )
          await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
          await captureBoundary(
            page,
            '.planning/logs/04-11-01',
            `generate-${removed}-${scheme}-${width}-output`,
            width,
          )
          await page.evaluate(() => scrollTo(0, 0))
        }
      }
    } finally {
      await page.close()
      await browser.close()
      await server.close()
    }
  })
}

Deno.test('generation retires pending output and closes owned print windows on revoke or tab change', async () => {
  const server = startTestServer({ identity: { role: 'analyst' }, management })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/generate?kind=faq`)
  try {
    await generate(page)
    await page.waitForFunction(() => document.body.textContent?.includes('Export to Word'))
    await page.evaluate(() => {
      const result = { clicks: 0, prints: 0, closes: 0, urls: 0, revokes: 0 }
      Object.assign(globalThis, { output: result })
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) result.clicks++
      }
      const create = URL.createObjectURL
      URL.createObjectURL = (blob) => {
        result.urls++
        return create(blob)
      }
      const revoke = URL.revokeObjectURL
      URL.revokeObjectURL = (url) => {
        result.revokes++
        revoke(url)
      }
      globalThis.open = (() => ({
        document: { write() {}, close() {}, fonts: { ready: Promise.resolve() } },
        addEventListener(_name: string, callback: () => void) {
          if (_name === 'afterprint') Object.assign(this, { after: callback })
        },
        focus() {},
        print() {
          result.prints++
          ;(this as unknown as { after: () => void }).after()
        },
        close() {
          result.closes++
        },
        closed: false,
      })) as unknown as typeof open
    })
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === 'Export to Word'
      )!.focus()
    )
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.body.textContent?.includes('Saved faq-'))
    await click(page, 'Export to PDF')
    await page.waitForFunction(() => document.body.textContent?.includes('Opened a print-ready'))
    expect(await page.evaluate(() => (globalThis as unknown as { output: unknown }).output))
      .toEqual({ clicks: 1, prints: 1, closes: 1, urls: 1, revokes: 1 })
    await page.evaluate(() => {
      globalThis.open = () => null
    })
    await click(page, 'Export to PDF')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Allow pop-ups to export as PDF.')
    )
    await page.evaluate(() => {
      const output =
        (globalThis as unknown as { output: { prints: number; closes: number } }).output
      globalThis.open = (() => ({
        document: {
          write() {},
          close() {},
          fonts: {
            ready: new Promise<void>((resolve) =>
              Object.assign(globalThis, { releasePrint: resolve })
            ),
          },
        },
        addEventListener(_name: string, callback: () => void) {
          if (_name === 'afterprint') Object.assign(this, { after: callback })
        },
        focus() {},
        print() {
          output.prints++
        },
        close() {
          output.closes++
        },
        closed: false,
      })) as unknown as typeof open
    })
    await click(page, 'Export to PDF')
    await page.waitForFunction(() => 'releasePrint' in globalThis)
    await click(page, 'Comparison')
    await page.evaluate(() =>
      (globalThis as unknown as { releasePrint: () => void }).releasePrint()
    )
    expect(await page.evaluate(() => (globalThis as unknown as { output: unknown }).output))
      .toEqual({ clicks: 1, prints: 1, closes: 2, urls: 1, revokes: 1 })
    const delayed = server.delayResponse('/api/t/marine/generate')
    await fill(page, '#generate-query', 'Abalone research')
    await click(page, 'Generate')
    await delayed.entered
    await click(page, 'FAQ')
    await click(page, 'Comparison')
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Export to Word')
    await click(page, 'FAQ')
    await generate(page)
    await page.waitForFunction(() => document.body.textContent?.includes('Export to Word'))
    await click(page, 'Export to PDF')
    await page.waitForFunction(() => 'releasePrint' in globalThis)
    server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-analyst', 'viewer')
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === 'Export to Word'
      )!.click()
      dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(() =>
      document.body.textContent?.includes('This page is unavailable')
    )
    expect(await page.evaluate(() => (globalThis as unknown as { output: unknown }).output))
      .toEqual({ clicks: 1, prints: 1, closes: 3, urls: 1, revokes: 1 })
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('assessment renders authorised questions and retires a changed topic', async () => {
  const server = startTestServer({ identity: { role: 'analyst' }, management })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/assessment`)
  try {
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/assessment`)
      await page.waitForSelector('#assessment-topic')
      await fill(page, '#assessment-topic', 'Abalone')
      await click(page, 'Build on this topic')
      await click(page, 'Generate assessment')
      await page.waitForFunction(() => document.body.textContent?.includes('What affects abalone?'))
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/04-11-01',
          `assessment-${scheme}-${width}`,
          width,
        )
      }
    }
    await click(page, 'Change topic')
    await fill(page, '#assessment-topic', 'Abalone')
    await click(page, 'Build on this topic')
    const delayed = server.delayResponse('/api/t/marine/generate')
    await click(page, 'Generate assessment')
    await delayed.entered
    await click(page, 'Change topic')
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'What affects abalone?',
    )
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

for (
  const route of [
    'generate?kind=assessment&query=abalone&autostart=1',
    'assessment?topic=abalone&autostart=1',
  ]
) {
  Deno.test(`viewer cannot mount generation at ${route}`, async () => {
    const server = startTestServer({ identity: { role: 'viewer' } })
    const browser = await launch()
    const page = await browser.newPage(`${server.url}/t/marine/${route}`)
    try {
      await page.waitForFunction(() => document.querySelector('main') !== null)
      await page.waitForFunction(() => !document.body.textContent?.includes('Checking access'))
      expect(await page.$('#generate-query')).toBeNull()
      expect(await page.$('#assessment-topic')).toBeNull()
      expect(await page.evaluate(() => document.body.textContent)).toContain(
        'This page is unavailable',
      )
      expect(server.requests.filter((r) => r.path.endsWith('/generate'))).toEqual([])
      for (const scheme of ['light', 'dark']) {
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [scheme],
        })
        await page.goto(`${server.url}/t/marine/${route}`)
        await page.waitForFunction(() =>
          document.body.textContent?.includes('This page is unavailable')
        )
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-11-01',
            `${route.split('?')[0]}-viewer-${scheme}-${width}`,
            width,
          )
        }
      }
    } finally {
      await page.close()
      await browser.close()
      await server.close()
    }
  })
}
