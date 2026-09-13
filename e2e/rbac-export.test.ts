import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { captureBoundary } from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

async function completedAsk(page: Page) {
  await page.waitForSelector('#ask-composer')
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      'What affects abalone populations?',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForFunction(() =>
    !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
  )
  await page.evaluate(() =>
    document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
  )
  await page.waitForFunction(() => document.body.textContent?.includes('Answer complete'))
  await page.waitForSelector('sup a')
}

async function sinks(page: Page) {
  await page.evaluate(() => {
    const counts = { blobs: 0, urls: 0, clicks: 0, revoked: 0 }
    Object.assign(globalThis, { outputCounts: counts })
    const OriginalBlob = Blob
    globalThis.Blob = class extends OriginalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        counts.blobs++
      }
    }
    const create = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      counts.urls++
      return create(blob)
    }
    const revoke = URL.revokeObjectURL
    URL.revokeObjectURL = (url) => {
      counts.revoked++
      revoke(url)
    }
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) counts.clicks++
      else click.call(this)
    }
  })
}
const counts = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as {
      outputCounts: { blobs: number; urls: number; clicks: number; revoked: number }
    }).outputCounts
  )

Deno.test('Search summary checks generation and discards a closed or revoked completion', async () => {
  const management = {
    summarize: () => Promise.resolve('Confirmed source summary'),
    thumbnailResponse: () => Promise.resolve(null),
  } as unknown as BuildAppOptions['management']
  const server = startTestServer({ identity: { role: 'analyst' }, management })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/search?q=abalone&answer=0`)
  try {
    await page.waitForSelector('#result-res-1')
    const clickSummary = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.trim() === 'Summarise these results'
        )!.click()
      )
    await clickSummary()
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Confirmed source summary')
    )
    await page.keyboard.press('Escape')
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/search?q=abalone&answer=0`)
      await page.waitForSelector('#result-res-1')
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/04-10-02',
          `analyst-search-${scheme}-${width}`,
          width,
        )
      }
      await clickSummary()
      await page.waitForFunction(() =>
        document.body.textContent?.includes('Confirmed source summary')
      )
      await page.waitForFunction(() => {
        const overlay = document.querySelector('[role="dialog"]')?.parentElement
        return overlay && Number(getComputedStyle(overlay).opacity) >= 0.999
      })
      for (const width of [1440, 390]) {
        await captureBoundary(page, '.planning/logs/04-10-02', `summary-${scheme}-${width}`, width)
      }
      await page.keyboard.press('Escape')
    }
    const delayed = server.delayResponse('/api/t/marine/summarize')
    await clickSummary()
    await delayed.entered
    await page.keyboard.press('Escape')
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.$('[role="dialog"]')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Confirmed source summary',
    )
    const revoked = server.delayResponse('/api/t/marine/summarize')
    await clickSummary()
    await revoked.entered
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      !document.body.textContent?.includes('Summarise these results')
    )
    revoked.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Confirmed source summary',
    )
    expect(await page.$('[role="dialog"]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

for (const removed of ['portal.watch', 'portal.export', 'portal.generate'] as const) {
  Deno.test(`Ask independently removes ${removed} from the real analyst snapshot`, async () => {
    const server = startTestServer({ identity: { role: 'analyst' } })
    const browser = await launch()
    const page = await browser.newPage(`${server.url}/t/marine/ask`)
    try {
      await page.waitForSelector('#ask-composer')
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
      await page.waitForSelector('#ask-composer')
      await completedAsk(page)
      await sinks(page)
      expect(await page.$('button[aria-label="Add to Watches"]') !== null).toBe(
        removed !== 'portal.watch',
      )
      const hasExport = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Export')
      )
      expect(hasExport).toBe(removed !== 'portal.export')
      if (hasExport) {
        await page.evaluate(() =>
          [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Export')!
            .focus()
        )
        await page.keyboard.press('Enter')
        await page.waitForFunction(() =>
          document.body.textContent?.includes('Saved what-affects-abalone')
        )
        expect(await counts(page)).toEqual({ blobs: 1, urls: 1, clicks: 1, revoked: 1 })
      } else expect(await counts(page)).toEqual({ blobs: 0, urls: 0, clicks: 0, revoked: 0 })
      if (removed === 'portal.watch') {
        expect(server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/watches')))
          .toEqual([])
      }
      if (removed === 'portal.generate') {
        expect(server.requests.filter((r) => /\/(followups|verdicts|subqueries)$/.test(r.path)))
          .toEqual([])
      }
      for (const width of [1440, 390]) {
        await captureBoundary(page, '.planning/logs/04-10-02', `${removed}-${width}`, width)
      }
      await page.evaluate(() => {
        history.pushState({}, '', '/t/marine/search?q=abalone')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForSelector('#result-res-1')
      const text = await page.evaluate(() => document.body.textContent ?? '')
      expect(text.includes('Summarise these results')).toBe(removed !== 'portal.generate')
      expect(text.includes('Add to Watches')).toBe(removed !== 'portal.watch')
    } finally {
      await page.close()
      await browser.close()
      await server.close()
    }
  })
}

Deno.test('Ask cancels pending local export before browser sinks and never announces stale success', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await completedAsk(page)
    await sinks(page)
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Export')!
        .click()
      dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(() => !document.body.textContent?.includes('Deep research'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await counts(page)).toEqual({ blobs: 0, urls: 0, clicks: 0, revoked: 0 })
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Saved what-affects')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('saved watches remain readable for a viewer without create, seen or delete writes', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const response = await fetch(`${server.url}/api/t/marine/watches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'abalone' }),
  })
  expect(response.ok).toBe(true)
  await response.json()
  server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-analyst', 'viewer')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/search`)
  try {
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'abalone')
    )
    const before = server.requests.length
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'abalone')!
        .click()
    )
    await page.waitForSelector('#result-res-1')
    expect(await page.$('button[aria-label^="Remove saved search"]')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Add to Watches')
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Summarise these results',
    )
    expect(
      server.requests.slice(before).filter((r) =>
        r.path.includes('/watches') && r.method !== 'GET'
      ),
    ).toEqual([])
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/search?q=abalone`)
      await page.waitForSelector('#result-res-1')
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/04-10-02',
          `viewer-search-${scheme}-${width}`,
          width,
        )
      }
    }
    // Original source reading is portal.read, independently of research export.
    await page.goto(`${server.url}/t/marine/library/res-1`)
    await page.waitForFunction(() =>
      document.querySelector('h1')?.textContent?.includes('Abalone stock health')
    )
    expect(
      server.requests.some((r) => r.path === '/api/t/marine/resources/res-1' && r.status === 200),
    ).toBe(true)
    expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('Ask hides empty export, blocks streaming keyboard export and retires saved notices with the session', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const delayed = server.delayResponse('/api/t/marine/ask')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await page.waitForSelector('#ask-composer')
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Export')
      ),
    ).toBe(false)
    await sinks(page)
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'What affects abalone populations?',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForFunction(() =>
      !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
    )
    await page.evaluate(() =>
      document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
    )
    await delayed.entered
    const disabled = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === 'Export'
      )!
      button.focus()
      button.click()
      return button.disabled
    })
    await page.keyboard.press('Enter')
    expect(disabled).toBe(true)
    expect(await counts(page)).toEqual({ blobs: 0, urls: 0, clicks: 0, revoked: 0 })
    delayed.release()
    await page.waitForFunction(() => document.body.textContent?.includes('Answer complete'))
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Export')!
        .click()
    )
    await page.waitForFunction(() => document.body.textContent?.includes('Saved what-affects'))
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === '+ New session'
      )!.click()
    )
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Saved what-affects')
  } finally {
    delayed.release()
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('analyst creates, runs and deletes watches with exact server permissions', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/search?q=abalone`)
  try {
    await page.waitForSelector('#result-res-1')
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === 'Add to Watches'
      )!.click()
    )
    await page.waitForSelector('button[aria-label^="Remove saved search"]')
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'abalone')!
        .click()
    )
    await page.waitForFunction(() => !document.body.textContent?.includes('Adding…'))
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label^="Remove saved search"]')!
        .click()
    )
    await page.waitForFunction(() =>
      !document.querySelector('button[aria-label^="Remove saved search"]')
    )
    for (
      const [method, suffix] of [['POST', '/watches'], ['POST', '/seen'], ['DELETE', '']] as const
    ) {
      expect(
        server.requests.some((r) =>
          r.path.includes('/watches') && r.path.endsWith(suffix) && r.method === method &&
          r.status === 200
        ),
      ).toBe(true)
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('Ask watch completion cannot announce success on another session', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await completedAsk(page)
    const delayed = server.delayResponse('/api/t/marine/watches')
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Add to Watches"]')!.click()
    )
    await delayed.entered
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === '+ New session'
      )!.click()
    )
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('In your Watches')
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Could not add it to Watches',
    )
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
