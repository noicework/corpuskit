import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import type { PortalLimits } from '../packages/core/src/lifecycle.ts'
import { startTestServer, type TestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'

async function policy(
  server: TestServer,
  status: 'active' | 'read_only' | 'suspended',
  limits: PortalLimits | null = null,
) {
  server.setIdentity(fixtureSession({ oid: 'fixture-owner-one', roles: ['CorpusKit.Owner'] }))
  const response = await fetch(`${server.url}/api/admin/t/marine/lifecycle`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, limits }),
  })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  server.setIdentity(fixtureSession({ oid: 'fixture-curator' }))
}

async function click(page: Page, label: string) {
  await page.waitForFunction(
    (label: string) =>
      [...document.querySelectorAll('button')].some((button) =>
        button.textContent?.trim().replace(/^[▸▾]\s*/, '') === label && !button.disabled
      ),
    { args: [label] },
  )
  await page.evaluate((label) => {
    ;[...document.querySelectorAll('button')].find((button) =>
      button.textContent?.trim().replace(/^[▸▾]\s*/, '') === label
    )!.click()
  }, { args: [label] })
}

async function fill(page: Page, selector: string, value: string) {
  await page.evaluate(({ selector, value }) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [{ selector, value }] })
}

function management() {
  const calls: string[] = []
  const api = new Proxy({}, {
    get: (_target, method) => () => {
      calls.push(String(method))
      switch (method) {
        case 'counters':
          return Promise.resolve({ resources: 2, paragraphs: 14, sentences: 28, indexMb: 1 })
        case 'resourceCount':
          return Promise.resolve(2)
        case 'listResources':
          return Promise.resolve([{ id: 'res-1' }, { id: 'res-2' }])
        case 'recentResources':
        case 'corpusHealth':
        case 'agentConfigs':
          return Promise.resolve([])
        case 'createLink':
        case 'createText':
        case 'uploadFile':
          return Promise.resolve({ id: 'new-resource' })
        default:
          return Promise.reject(new Error(`Unsupported hosting fixture: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  return { api, calls }
}

Deno.test('signed-in read-only portals show a responsive banner while public browsing stays available', async () => {
  const server = startTestServer({ identity: { role: 'owner' } })
  await policy(server, 'read_only')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/library`)
  try {
    await page.waitForSelector('[data-portal-read-only]')
    await assertCurrentBuild(page)
    expect(await page.evaluate(() => document.body.innerText)).toContain(
      'You can browse, search and ask questions.',
    )
    expect(
      server.requests.some((entry) =>
        entry.path.startsWith('/api/t/marine/catalog') && entry.status === 200
      ),
    ).toBe(true)
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/hosting-lifecycle',
          `read-only-${scheme}-${width}`,
          width,
        )
      }
    }
    server.setIdentity(null)
    await page.goto(`${server.url}/t/marine/library`)
    await page.waitForSelector('main h1')
    expect(await page.$('[data-portal-read-only]')).toBeNull()
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('is paused')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('disabled agent starts show an actionable message without losing the signed-in page', async () => {
  const { api, calls } = management()
  const server = startTestServer({ identity: { role: 'owner' }, management: api })
  await policy(server, 'active', { agentsEnabled: false })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=enrichments`)
  try {
    await click(page, 'Generate missing')
    await page.waitForFunction(() =>
      document.querySelector('[role=alert]')?.textContent?.includes('Agents are disabled')
    )
    expect(await page.$('[data-access-state=failed]')).toBeNull()
    expect(await page.evaluate(() => document.body.innerText)).toContain('portal administrator')
    expect(
      server.requests.filter((entry) =>
        entry.path === '/api/admin/t/marine/enrichments/run' && entry.status === 403
      ),
    ).toHaveLength(1)
    expect(calls).not.toContain('askStructured')
  } catch (error) {
    console.log(await page.evaluate(() => document.body.innerText))
    console.log(server.requests)
    throw error
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('suspended portals show only the paused view to signed-in and anonymous visitors', async () => {
  const server = startTestServer({ identity: { role: 'owner' } })
  server.tenants.patchBranding('marine', { tagline: 'Protected research marker' })
  await policy(server, 'suspended')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await page.waitForSelector('[data-access-state=paused][data-safe-metadata=ready]')
    expect(await page.$('#ask-composer')).toBeNull()
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      'Protected research marker',
    )
    expect(await page.evaluate(() => document.body.innerText)).toContain('portal administrator')
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/hosting-lifecycle',
          `paused-${scheme}-${width}`,
          width,
        )
      }
    }
    server.setIdentity(null)
    server.setAccessMode('marine', 'restricted')
    await page.goto(`${server.url}/t/marine`)
    await page.waitForSelector('[data-access-state=paused][data-safe-metadata=ready]')
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      'Sign in with Microsoft',
    )
    expect(await page.$('#ask-composer')).toBeNull()
    expect(server.providerCalls).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('upload, link and text additions explain resource limits and retain entered content', async () => {
  const { api, calls } = management()
  const server = startTestServer({ identity: { role: 'owner' }, management: api })
  await policy(server, 'active', { maxResources: 2 })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  try {
    await click(page, 'Add content')
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type=file]')!
      const transfer = new DataTransfer()
      transfer.items.add(new File(['Research'], 'research.txt', { type: 'text/plain' }))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(() =>
      document.querySelector('[role=alert]')?.textContent?.includes('resource limit')
    )
    await click(page, 'Add link')
    await fill(page, '#link-url-marine', 'https://example.test/report')
    await page.evaluate(() =>
      document.querySelector('#link-url-marine')!.closest('form')!.requestSubmit()
    )
    await page.waitForFunction(() =>
      document.querySelector('[role=alert]')?.textContent?.includes('resource limit')
    )
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('#link-url-marine')!.value
      ),
    )
      .toBe('https://example.test/report')
    await click(page, 'Paste text')
    await fill(page, '#text-title-marine', 'New report')
    await fill(page, '#text-body-marine', 'Research evidence')
    await page.evaluate(() =>
      document.querySelector('#text-body-marine')!.closest('form')!.requestSubmit()
    )
    await page.waitForFunction(() =>
      document.querySelector('[role=alert]')?.textContent?.includes('resource limit')
    )
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLTextAreaElement>('#text-body-marine')!.value
      ),
    )
      .toBe('Research evidence')
    expect(calls.filter((call) => ['createLink', 'createText', 'uploadFile'].includes(call)))
      .toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('daily ask quotas show the reset message without scheduling a burst retry', async () => {
  const server = startTestServer({ identity: { role: 'owner' } })
  await policy(server, 'active', { asksPerDay: 0 })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/ask`)
  try {
    await page.waitForSelector('#ask-composer')
    await fill(page, '#ask-composer', 'What affects abalone populations?')
    await page.waitForFunction(() =>
      !document.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled
    )
    await page.evaluate(() =>
      document.querySelector('#ask-composer')!.closest('form')!.requestSubmit()
    )
    await page.waitForFunction(() => document.body.innerText.includes('daily question limit'))
    const text = await page.evaluate(() => document.body.innerText)
    expect(text).toContain('Try again after')
    expect(text).not.toContain('Retrying in')
    expect(text).not.toContain('The portal is busy')
    expect(
      server.requests.filter((entry) => entry.path === '/api/t/marine/ask' && entry.status === 429),
    )
      .toHaveLength(1)
    expect(server.providerCalls).not.toContain('ask')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
