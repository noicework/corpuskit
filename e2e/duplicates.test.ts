import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { tenantConfig } from '../apps/api/src/tenants.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'

async function click(page: Page, label: string, selector = 'button') {
  await page.evaluate((label, selector) => {
    const element = [...document.querySelectorAll<HTMLElement>(selector)].find((node) =>
      node.textContent?.trim() === label
    )
    if (!element) throw new Error(`Missing control: ${label}`)
    element.click()
  }, { args: [label, selector] })
}

Deno.test('curator reviews planted duplicates, remembers both decisions and retires only after confirmation', async () => {
  const provider = DoubleProvider.withDuplicates()
  const deleted: string[] = []
  const management = {
    counters: async () => ({
      resources: (await provider.listResources(tenantConfig('marine')!)).length,
      paragraphs: 0,
      indexMb: 0,
      sentences: 0,
    }),
    recentResources: async () => [],
    resourceCount: async () => (await provider.listResources(tenantConfig('marine')!)).length,
    deleteResource: async (_config: unknown, id: string) => {
      deleted.push(id)
      const resources = await provider.listResources(tenantConfig('marine')!)
      resources.splice(resources.findIndex((r) => r.id === id), 1)
    },
  } as unknown as BuildAppOptions['management']
  const server = startTestServer({ provider, management, identity: { role: 'curator' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=duplicates`)
  try {
    await page.waitForSelector('[data-duplicate-pair]')
    await assertCurrentBuild(page)
    expect(await page.evaluate(() => document.querySelectorAll('[data-duplicate-pair]').length))
      .toBe(2)
    expect(deleted).toEqual([])
    await click(page, 'Not a duplicate')
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-duplicate-pair]').length === 1
    )
    await click(page, 'Keep both')
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-duplicate-pair]').length === 0
    )
    await click(page, 'Refresh candidates')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Duplicate candidates refreshed.')
    )
    expect(await page.evaluate(() => document.querySelectorAll('[data-duplicate-pair]').length))
      .toBe(0)
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('[data-duplicates-panel] input[type=checkbox]')!
        .click()
    )
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-duplicate-pair]').length === 2
    )
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[data-delete-document="res-copy"]')!.focus()
    )
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog[open]')
    expect(await page.evaluate(() => document.querySelector('dialog[open]')?.textContent))
      .toContain('cannot be undone')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-delete-document')))
      .toBe('res-copy')
    expect(deleted).toEqual([])
    await page.keyboard.press('Enter')
    await click(page, 'Delete document')
    await page.waitForFunction(() => !document.querySelector('[data-delete-document="res-copy"]'))
    expect(deleted).toEqual(['res-copy'])
    expect(
      server.requests.filter((r) =>
        r.method === 'DELETE' && r.path.endsWith('/res-copy') && r.status === 200
      ),
    ).toHaveLength(1)
    expect(server.providerCalls).not.toContain('ask')

    for (const palette of ['corpuskit', 'observatory'] as const) {
      server.tenants.patchBranding('marine', {
        paletteId: palette,
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.goto(`${server.url}/t/marine/manage?tab=duplicates`)
      await page.waitForSelector('[data-duplicates-panel] input[type=checkbox]')
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('[data-duplicates-panel] input[type=checkbox]')!
          .click()
      )
      await page.waitForSelector('[data-duplicate-pair]')
      for (const width of [1440, 390, 320]) {
        await captureBoundary(
          page,
          '.planning/logs/duplicates',
          `review-${palette}-${width}`,
          width,
        )
        expect(
          await page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>('[data-duplicates-panel]')!
            const card = panel.querySelector<HTMLElement>('[data-duplicate-pair] .bg-surface-2')!
            return getComputedStyle(card).borderRadius ===
              getComputedStyle(panel).borderRadius
          }),
        ).toBe(true)
        await page.evaluate(() =>
          document.querySelector('[data-duplicate-pair]')!.scrollIntoView({ block: 'start' })
        )
        await Deno.writeFile(
          `.planning/logs/duplicates/review-pair-${palette}-${width}.png`,
          await page.screenshot(),
        )
        await page.evaluate(() => scrollTo(0, 0))
      }
      await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[data-duplicates-panel]')!
        panel.style.letterSpacing = '0.12em'
        panel.style.wordSpacing = '0.16em'
        panel.style.lineHeight = '1.5'
        for (const paragraph of panel.querySelectorAll('p')) paragraph.style.marginBottom = '2em'
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1)
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('platform administrator sees cross-collection examples and downloads the counted CSV', async () => {
  const server = startTestServer({
    provider: DoubleProvider.withDuplicates(),
    identity: { role: 'platform-admin' },
  })
  server.setResponseStatus('/api/admin/overlap', 200)
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/admin`)
  try {
    await page.waitForSelector('[data-overlap-panel] [role=alert]')
    expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe(
      'Knowledge boxes',
    )
    await captureBoundary(page, '.planning/logs/duplicates', 'overlap-malformed-390', 390)
    server.setResponseStatus('/api/admin/overlap', null)
    await click(page, 'Refresh overlap')
    await page.waitForSelector('[data-overlap-panel] details')
    await assertCurrentBuild(page)
    expect(await page.evaluate(() => document.querySelector('[data-overlap-panel]')?.textContent))
      .toContain('Shared title pairs')
    await click(page, 'Examples (5)', '[data-overlap-panel] summary')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLDetailsElement>('[data-overlap-panel] details')!.open
      ),
    ).toBe(true)
    await click(page, 'Download CSV')
    await page.waitForFunction(() => document.body.textContent?.includes('Overlap CSV downloaded.'))
    expect(
      server.requests.some((r) =>
        r.path.startsWith('/api/admin/overlap/export') && r.status === 200
      ),
    )
      .toBe(true)
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
      for (const width of [1440, 390, 320]) {
        await captureBoundary(
          page,
          '.planning/logs/duplicates',
          `overlap-${scheme}-${width}`,
          width,
        )
        await page.evaluate(() =>
          document.querySelector('[data-overlap-panel] details')!.scrollIntoView({
            block: 'center',
          })
        )
        await Deno.writeFile(
          `.planning/logs/duplicates/overlap-examples-${scheme}-${width}.png`,
          await page.screenshot(),
        )
        await page.evaluate(() => scrollTo(0, 0))
      }
      await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[data-overlap-panel]')!
        panel.style.letterSpacing = '0.12em'
        panel.style.wordSpacing = '0.16em'
        panel.style.lineHeight = '1.5'
        for (const paragraph of panel.querySelectorAll('p')) paragraph.style.marginBottom = '2em'
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1)
    }
    server.setAssignment({ kind: 'platform' }, 'e2e-platform-admin', null)
    server.setIdentity(null)
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('[data-overlap-panel]'))
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
