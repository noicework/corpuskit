import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { AskEventSchema, type SearchResults, type TenantConfig } from '@research-portal/core'
import type { SearchOptions } from '../packages/retrieval/src/provider.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import { DoubleProvider, RESOURCE_ONE, RESOURCE_TWO } from './support/double-provider.ts'
import {
  AcceptanceCollection,
  ORIGINAL_TEXT,
  UPDATED_TEXT,
} from './support/acceptance-collection.ts'

async function fill(page: Page, selector: string, value: string) {
  await page.waitForSelector(selector)
  await page.evaluate((selector, value) => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    const prototype = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector, value] })
}

async function click(page: Page, label: string) {
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.trim() === label && !b.disabled
      ),
    { args: [label] },
  )
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === label && !b.disabled
    )!
    button.click()
  }, { args: [label] })
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('AT4: portal admin adds, updates and re-indexes, then retires a document through Manage', async () => {
  const collection = new AcceptanceCollection()
  const server = startTestServer({
    identity: { role: 'portal-admin' },
    provider: collection,
    management: collection.management(),
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  const list = async () => (await fetch(`${server.url}/api/t/marine/resources`)).json()
  try {
    await assertCurrentBuild(page)
    await click(page, 'Paste text')
    await fill(page, '#text-title-marine', 'Sheltered nursery survey')
    await fill(page, '#text-body-marine', ORIGINAL_TEXT)
    await click(page, 'Add text')
    await page.waitForSelector('[data-update-document="document-1"]')
    expect(JSON.stringify(await list())).toContain(ORIGINAL_TEXT)

    // Keyboard activation opens the editor and gives its labelled field focus.
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[data-update-document="document-1"] button')!
        .focus()
    )
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
    await fill(page, '[data-update-document] textarea', 'Too little content')
    await click(page, 'Replace text and re-index')
    await page.waitForSelector('[data-update-document] [role=alert]')
    expect(collection.writes.map((w) => w.method)).toEqual(['createText'])
    expect(JSON.stringify(await list())).toContain(ORIGINAL_TEXT)
    await fill(page, '[data-update-document] textarea', UPDATED_TEXT)
    await click(page, 'Replace text and re-index')
    await page.waitForSelector('[data-update-document="document-2"]')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role=status]')].some((node) =>
        node.textContent?.includes('requested indexing')
      )
    )
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Recent additions')
    expect(collection.writes.map((w) => w.method)).toEqual([
      'createText',
      'createText',
      'deleteResource',
    ])
    expect(collection.writes[1]?.text).toContain('Revised nursery observations')
    const updated = await list()
    expect(updated).toHaveLength(1)
    expect(updated[0].id).toBe('document-2')
    expect(updated[0].summary).toContain('Revised nursery observations')
    expect((await fetch(`${server.url}/api/t/marine/resources/document-1`)).status).toBe(404)

    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[data-delete-document="document-2"]')!.focus()
    )
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog[open]')
    await click(page, 'Delete document')
    await page.waitForFunction(() => !document.querySelector('[data-update-document]'))
    expect(await list()).toEqual([])
    expect(collection.writes.every((w) => w.slug === 'marine')).toBe(true)
    expect(
      server.requests.filter((r) =>
        r.method === 'POST' && r.path === '/api/admin/t/marine/reingest'
      ).map((r) => r.status),
    ).toEqual([422, 200])
    const audit = await (await fetch(`${server.url}/api/admin/t/marine/audit`)).json()
    const recorded = JSON.stringify(audit)
    expect(recorded).toContain('resource.delete')
    expect(recorded).toContain('/api/admin/t/:slug/reingest')
    expect(recorded).not.toContain(ORIGINAL_TEXT)
    expect(recorded).not.toContain(UPDATED_TEXT)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('AT4: viewer cannot manage, add, update, re-index or retire documents', async () => {
  const collection = new AcceptanceCollection()
  collection.plant('marine', 'original', 'Nursery survey', ORIGINAL_TEXT)
  const server = startTestServer({
    identity: { role: 'viewer' },
    provider: collection,
    management: collection.management(),
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.waitForSelector('[data-route-unavailable]')
    expect(await page.$('[data-update-document]')).toBeNull()
    expect(await page.$('[data-add-documents]')).toBeNull()
    for (
      const [path, init] of [
        ['resources/text', json({ title: 'Not allowed', body: ORIGINAL_TEXT })],
        ['reingest', json({ resourceId: 'original', html: `<p>${UPDATED_TEXT}</p>` })],
        ['resources/original/hidden', json({ hidden: true })],
        ['resources/original', { method: 'DELETE' }],
      ] as const
    ) {
      const response = await fetch(`${server.url}/api/admin/t/marine/${path}`, init)
      expect(response.status, path).toBe(403)
      await response.body?.cancel()
    }
    expect(collection.writes).toEqual([])
    expect(server.providerCalls).not.toContain('resource')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('AT15: insufficient evidence returns nearest sources and a refusal without generating an answer', async () => {
  class UnanswerableCollection extends DoubleProvider {
    override async search(
      tenant: TenantConfig,
      query: string,
      options?: SearchOptions,
    ): Promise<SearchResults> {
      const result = await super.search(tenant, query)
      // Hybrid retrieval is too weak to permit generation. Semantic retrieval still identifies
      // nearby reading, which must be labelled as unused rather than treated as supporting evidence.
      return {
        ...result,
        resources: result.resources.map((r) => ({
          ...r,
          relevance: options?.mode === 'semantic' ? 0.55 : 0.2,
        })),
      }
    }
    override ask(): never {
      throw new Error('AT15 must decline before generation')
    }
  }
  const server = startTestServer({ apiOnly: true, provider: new UnanswerableCollection() })
  try {
    const response = await fetch(
      `${server.url}/api/t/marine/ask`,
      json({ query: 'What is the abalone harvest quota on a distant moon?' }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: '))
      .map((line) => AskEventSchema.parse(JSON.parse(line.slice(6))))
    const done = events.filter((e) => e.type === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ refused: true })
    const text = done[0]?.type === 'done' ? done[0].text : ''
    expect(text).toContain('no answer has been generated')
    expect(text).toContain('listed below but not used')
    expect(text).toContain(RESOURCE_ONE.title)
    const sources = events.filter((e) => e.type === 'sources').at(-1)
    expect(sources?.type === 'sources' ? sources.resources.map((r) => r.id) : [])
      .toEqual([RESOURCE_ONE.id, RESOURCE_TWO.id])
    expect(events.filter((e) => e.type === 'citation')).toEqual([])
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe(text)
    expect(server.providerCalls).not.toContain('ask')
  } finally {
    await server.close()
  }
})

Deno.test('AT10: planted portal markers stay out of the other portal catalogue, search, topics and document views', async () => {
  const collection = new AcceptanceCollection()
  const markers = [
    { slug: 'marine', id: 'nursery-marker', marker: 'NURSERY-ONLY-CANARY' },
    { slug: 'grains', id: 'soil-marker', marker: 'SOIL-ONLY-CANARY' },
  ]
  for (const { slug, id, marker } of markers) collection.plant(slug, id, marker, marker)
  const server = startTestServer({ apiOnly: true, provider: collection })
  try {
    for (const own of markers) {
      const other = markers.find((m) => m.slug !== own.slug)!
      for (
        const suffix of [
          '/resources',
          `/resources/${own.id}`,
          `/search?q=${other.marker}`,
          '/catalog',
          '/topics/stock-assessment/resources',
        ]
      ) {
        const response = await fetch(`${server.url}/api/t/${own.slug}${suffix}`)
        expect(response.status, suffix).toBe(200)
        const result = await response.json()
        // Search echoes the question. Its result view must exclude the foreign marker.
        const body = JSON.stringify(suffix.startsWith('/search') ? result.resources : result)
        expect(body, suffix).toContain(own.marker)
        expect(body, suffix).not.toContain(other.marker)
      }
      const foreign = await fetch(`${server.url}/api/t/${own.slug}/resources/${other.id}`)
      expect(foreign.status).toBe(404)
      expect(await foreign.text()).not.toContain(other.marker)
    }
  } finally {
    await server.close()
  }
})

Deno.test('AT4: update form reflows with tenant tokens, large text, keyboard focus and announced errors', async () => {
  const collection = new AcceptanceCollection()
  collection.plant('marine', 'nursery-marker', 'Nursery survey', ORIGINAL_TEXT)
  const server = startTestServer({
    identity: { role: 'portal-admin' },
    provider: collection,
    management: collection.management(),
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.waitForSelector('[data-update-document] button')
    await click(page, 'Update and re-index')
    const directory = '.planning/logs/acceptance-suite'
    await Deno.mkdir(directory, { recursive: true })
    for (const paletteId of ['corpuskit', 'observatory'] as const) {
      server.tenants.patchBranding('marine', {
        paletteId,
        shape: 'soft',
        density: 'comfortable',
        typography: 'fraunces-poppins',
      })
      await page.goto(`${server.url}/t/marine/manage?tab=content`)
      await page.waitForSelector('[data-update-document] button')
      await click(page, 'Update and re-index')
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(async () => {
          document.documentElement.style.fontSize = '22px'
          await document.fonts.ready
          document.querySelector('[data-update-document]')!.scrollIntoView({ block: 'center' })
        })
        const metrics = await page.evaluate(() => {
          const field = document.querySelector<HTMLTextAreaElement>(
            '[data-update-document] textarea',
          )!
          const style = getComputedStyle(field)
          return {
            width: innerWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
            label: document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent,
            radius: style.borderRadius,
            token: style.getPropertyValue('--rp-radius-input').trim(),
            targets: [...document.querySelectorAll('[data-update-document] button')].map((b) =>
              b.getBoundingClientRect().height
            ),
          }
        })
        expect(metrics.width).toBe(width)
        expect(metrics.overflow).toBeLessThanOrEqual(1)
        expect(metrics.label).toBe('Updated content')
        expect(metrics.radius).toBe(metrics.token)
        expect(metrics.targets.every((height) => height >= 44)).toBe(true)
        if (width !== 320) {
          await Deno.writeFile(`${directory}/${paletteId}-${width}.png`, await page.screenshot())
        }
      }
    }
    await fill(page, '[data-update-document] textarea', 'Too little content')
    await click(page, 'Replace text and re-index')
    await page.waitForSelector('[data-update-document] [role=alert]')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-update-document] [role=alert]')?.textContent
      ),
    ).toContain('No meaningful body content')
    // Cancelling returns focus to the disclosure trigger, without a mutation.
    await click(page, 'Cancel update')
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim()))
      .toBe('Update and re-index')
    expect(collection.writes).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
