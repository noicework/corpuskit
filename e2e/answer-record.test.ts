import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

async function ask(page: Page, selector = '#ask-composer') {
  await page.waitForSelector(selector)
  await page.evaluate((selector) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    Object.getOwnPropertyDescriptor(
      input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, 'What affects abalone populations?')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector] })
  await page.waitForFunction(
    (selector) =>
      !document.querySelector(selector)!.closest('form')!.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!.disabled,
    { args: [selector] },
  )
  await page.evaluate(
    (selector) => document.querySelector(selector)!.closest('form')!.requestSubmit(),
    { args: [selector] },
  )
}
async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === label
    )
    if (!button) throw new Error(`Missing ${label}`)
    button.click()
  }, { args: [label] })
}

Deno.test('curator opens a persisted answer record, exports JSON and CSV, and reflows in both themes', async () => {
  const server = startTestServer({ identity: { role: 'curator' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await ask(page)
    const selector = 'a[href^="/t/marine/answer-records/"]'
    await page.waitForSelector(selector)
    const href = await page.evaluate(
      (selector) => document.querySelector<HTMLAnchorElement>(selector)!.getAttribute('href')!,
      { args: [selector] },
    )
    await page.evaluate(
      (selector) => document.querySelector<HTMLAnchorElement>(selector)!.focus(),
      { args: [selector] },
    )
    await page.keyboard.press('Enter')
    await page.waitForSelector('#record-question')
    await assertCurrentBuild(page)
    expect(await page.evaluate(() => document.body.innerText)).toContain(
      'What affects abalone populations?',
    )
    expect(await page.evaluate(() => document.body.innerText)).toContain('Passages retrieved')
    expect(await page.evaluate(() => document.body.innerText)).toContain('Passages cited')
    expect(await page.evaluate(() => document.body.innerText)).toContain('Stores and peers called')
    // Inspect the actual exported bytes through the browser download boundary.
    await page.evaluate(() => {
      const blobs: Blob[] = [], names: string[] = []
      Object.assign(globalThis, { recordDownloads: { blobs, names } })
      const create = URL.createObjectURL
      URL.createObjectURL = (blob) => {
        blobs.push(blob as Blob)
        return create(blob)
      }
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          names.push(this.download)
          return
        }
        click.call(this)
      }
    })
    for (const format of ['JSON', 'CSV']) {
      await click(page, `Export record ${format}`)
      await page.waitForFunction(
        (format) =>
          (globalThis as unknown as { recordDownloads: { names: string[] } }).recordDownloads.names
            .some((n) => n.endsWith(`.${format.toLowerCase()}`)),
        { args: [format] },
      )
    }
    const bytes = await page.evaluate(async () =>
      Promise.all(
        (globalThis as unknown as { recordDownloads: { blobs: Blob[] } }).recordDownloads.blobs.map(
          (b) => b.text(),
        ),
      )
    )
    const exported = JSON.parse(bytes[0]!)
    expect(exported).toHaveLength(1)
    expect(exported[0].retrieved.length).toBeGreaterThan(0)
    expect(exported[0].calls.some((call: { operation: string }) => call.operation === 'ask')).toBe(
      true,
    )
    expect(bytes[1]).toContain('"retrievalQueries"')
    expect(bytes[1]).toContain('What affects abalone populations?')
    const date = exported[0].at.slice(0, 10)
    await page.evaluate((date) => {
      for (const input of document.querySelectorAll<HTMLInputElement>('input[type="date"]')) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, date)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, { args: [date] })
    const previousDate = new Date(Date.parse(exported[0].at) - 86_400_000).toISOString().slice(
      0,
      10,
    )
    await page.evaluate((value) => {
      const input = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1]!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, { args: [previousDate] })
    await page.waitForSelector('#answer-record-range-error')
    expect(
      await page.evaluate(() =>
        document.querySelector('#answer-record-range-error')!.getAttribute('role')
      ),
    ).toBe('alert')
    await page.evaluate((value) => {
      const input = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1]!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, { args: [date] })
    await click(page, 'Export range JSON')
    await page.waitForFunction(() =>
      (globalThis as unknown as { recordDownloads: { names: string[] } }).recordDownloads.names
        .length === 3
    )
    expect(
      server.requests.some((r) => r.path.includes('/answer-records/export') && r.status === 200),
    ).toBe(true)
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
        organisation: 'Fisheries research',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      await page.goto(`${server.url}${href}`)
      await page.waitForSelector('#record-question')
      for (const width of [1440, 390, 320]) {
        await captureBoundary(page, '.planning/logs/evidence-record', `${scheme}-${width}`, width)
        await page.evaluate(() => {
          document.querySelector('[aria-label="Passages retrieved"]')!.scrollIntoView()
          scrollBy(0, -220)
        })
        await Deno.writeFile(
          `.planning/logs/evidence-record/${scheme}-${width}-passages.png`,
          await page.screenshot(),
        )
        await page.evaluate(() => document.querySelector('#range-export')!.scrollIntoView())
        await Deno.writeFile(
          `.planning/logs/evidence-record/${scheme}-${width}-lower.png`,
          await page.screenshot(),
        )
        await page.evaluate(() => scrollTo(0, 0))
      }
    }
    // Revocation retires the sensitive view and prevents another record read.
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('#record-question'))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(exported[0].question)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('document chat exposes the curator record link and administrators can change retention', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/library/res-1`)
  try {
    await ask(page, '#ask-document')
    const selector = 'a[href^="/t/marine/answer-records/"]'
    await page.waitForSelector(selector)
    await page.evaluate(
      (selector) => document.querySelector<HTMLAnchorElement>(selector)!.click(),
      { args: [selector] },
    )
    await page.waitForSelector('#record-question')
    expect(await page.evaluate(() => document.body.innerText)).toContain('document')
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="number"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '45')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(
      await page.evaluate(() =>
        document.querySelector('#record-retention')!.parentElement!.textContent
      ),
    ).toContain('Records expire after 90')
    await click(page, 'Save retention')
    await page.waitForFunction(() => document.body.innerText.includes('Retention saved.'))
    expect(
      server.requests.some((r) =>
        r.method === 'PUT' && r.path.endsWith('/answer-records/retention') && r.status === 200
      ),
    ).toBe(true)
    const recordPath = await page.evaluate(() => location.pathname)
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}${recordPath}`)
      await page.waitForSelector('#record-question')
      await captureBoundary(page, '.planning/logs/evidence-record', `admin-${scheme}-320`, 320)
      await page.evaluate(() => {
        document.querySelector('#record-retention')!.scrollIntoView()
        scrollBy(0, -220)
      })
      await Deno.writeFile(
        `.planning/logs/evidence-record/admin-${scheme}-320-retention.png`,
        await page.screenshot(),
      )
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('viewer answers carry no Answer record link', async () => {
  const server = startTestServer({ identity: { role: 'viewer' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await ask(page)
    await page.waitForFunction(() => document.body.innerText.includes('Answer complete'))
    expect(await page.$('a[href*="/answer-records/"]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
