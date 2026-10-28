import { IntentSchema } from '@research-portal/core'
import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import { settle } from './support/settle.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

const management = new Proxy({}, {
  get: (_target, method) => {
    if (method === 'counters') {
      return () => Promise.resolve({ resources: 2, paragraphs: 14, sentences: 28, indexMb: 1 })
    }
    if (method === 'recentResources') {
      return () =>
        Promise.resolve([{
          id: 'res-1',
          title: 'Summary {name}',
          status: 'processed',
          created: '2026-10-16T00:00:00Z',
        }])
    }
    return () => Promise.reject(new Error(`Fixture service unavailable: ${String(method)}`))
  },
}) as NonNullable<BuildAppOptions['management']>
const tabs = [
  'overview',
  'insights',
  'content',
  'duplicates',
  'enrichments',
  'taxonomy',
  'graph',
  'appearance',
  'evaluations',
  'behaviour',
  'extraction',
  'details',
  'connections',
  'access',
  'audit',
]
const captures = '.planning/logs/japanese-manage'
// These are authored fixture values, font/product names and file-format identifiers.
// Audit record bodies are separately excluded below; their raw evidence is not interface copy.
const retainedEnglish = new Set([
  'Summary',
  'Summary {name}',
  'Original {name}',
  'Library',
  'Southern Waters Research Institute',
  'Aa',
  'Albert Sans',
  'Archivo',
  'Bebas Neue',
  'Corben',
  'CorpusKit',
  'Fraunces',
  'Inter',
  'Lexend',
  'WOFF2、WOFF、TTF、OTF',
  'Expired fixture',
  'Legacy fixture',
  'Revoked fixture',
  'fixture-analyst',
  'fixture-curator',
  'fixture-portal-admin',
  'fixture-viewer',
  'marine',
  // The extraction sandbox's technical slug is authored fixture data, not UI copy.
  '(marine-lab)',
  'pending@example.test',
  ...[0, 1, 2].flatMap((index) => [`fixture-key-${index}`, `fixture_key_${index}`]),
])

async function assertButtonBounds(page: Page) {
  const clipped = await page.evaluate(() => {
    const failures: string[] = []
    for (const button of document.querySelectorAll<HTMLButtonElement>('.rp-btn')) {
      const box = button.getBoundingClientRect()
      if (!button.getClientRects().length || !box.height) continue
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only')) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
          if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1) {
            failures.push(button.textContent?.trim() ?? '')
          }
        }
      }
    }
    return failures
  })
  expect(clipped).toEqual([])
}

async function assertButtonDensity(page: Page) {
  const metrics = await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;width:180px'
    document.body.append(fixture)
    try {
      return [0.93, 1, 1.06, 1.12].map((density) => {
        fixture.style.setProperty('--rp-density-ctl', String(density))
        fixture.replaceChildren()
        const controls = ['Save', '+', 'レビュー済みの付加情報アーカイブをインポート'].map(
          (label) => {
            const button = document.createElement('button')
            button.className = 'rp-btn'
            button.textContent = label
            fixture.append(button)
            return button
          },
        )
        return {
          density,
          minimum: 2.25 * 22 * density,
          heights: controls.map((button) => button.getBoundingClientRect().height),
        }
      })
    } finally {
      fixture.remove()
    }
  })
  for (const { heights, minimum } of metrics) {
    // A short label and icon retain the previous density-aware height; only wrapping grows.
    expect(Math.abs(heights[0]! - minimum)).toBeLessThan(1)
    expect(Math.abs(heights[1]! - minimum)).toBeLessThan(1)
    expect(heights[2]!).toBeGreaterThan(minimum)
  }
}

async function navigate(page: Page, tab: string) {
  await page.evaluate((tab) => {
    history.pushState(null, '', `/t/marine/manage?tab=${tab}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [tab] })
  await page.waitForSelector(`[data-manage-tab="${tab}"][aria-current="true"]`)
  await page.evaluate(() => document.fonts.ready)
}
async function language(page: Page, value: 'ja' | 'en') {
  if (
    await page.evaluate(() => document.documentElement.lang) === (value === 'ja' ? 'ja' : 'en-AU')
  ) return
  const button = `button[aria-label="${value === 'ja' ? '日本語' : 'English'}"]`
  await page.evaluate(() => scrollTo(0, 0))
  await settle(page, button)
  await (await page.waitForSelector(button)).click()
  await page.waitForFunction((value) => document.documentElement.lang === value, {
    args: [value === 'ja' ? 'ja' : 'en-AU'],
  })
}
async function pickArchive(page: Page, text: string) {
  await page.evaluate((text) => {
    const input = document.querySelector<HTMLInputElement>('[data-enrichments-import-file]')!
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'Summary {name}.json', { type: 'application/json' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, { args: [text] })
}

Deno.test('Japanese Manage covers every panel, retains source values and switches retained import results', async () => {
  const server = startTestServer({ identity: { role: 'owner' }, management })
  const config = server.tenants.get('marine')!
  // Topic labels are portal-authored catalogue data, retained unless the portal translates them.
  const portalAuthoredEnglish = new Set([...retainedEnglish, ...config.topics.map((t) => t.label)])
  server.tenants.patch('marine', {
    branding: {
      ...config.branding,
      productName: 'Summary',
      tagline: 'Original {name}',
      colourScheme: 'viewer',
    },
    languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
    intents: [
      IntentSchema.parse({
        id: 'authored-intent',
        label: 'Library',
        description: 'Summary {name}',
        retrieval: { features: ['semantic'], topK: 3, reranker: 'noop' },
        answer: { surfaces: ['ask'], strategy: 'none', promptVariant: 'default' },
      }),
    ],
  })
  const browser = await launch()
  const page = await browser.newPage('about:blank')
  const inventory: { tab: string; english: string[] }[] = []
  const evidence: Record<string, unknown>[] = []
  await Deno.mkdir(captures, { recursive: true })
  try {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'light' },
    ])
    await page.goto(`${server.url}/t/marine/manage`)
    await page.waitForSelector('[data-manage-shell]')
    await assertCurrentBuild(page)
    await page.waitForFunction(() => document.documentElement.lang === 'ja')
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '22px'
    })
    await assertButtonDensity(page)
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-manage-tab]')].map((node) =>
          node.getAttribute('data-manage-tab')
        )
      ),
    ).toEqual(tabs)
    for (const tab of tabs) {
      await navigate(page, tab)
      await page.waitForFunction(() => !document.querySelector('main .rp-shimmer'))
      if (tab === 'extraction') {
        // This asynchronous card has no shimmer. Inspect its resolved state so
        // an early inventory cannot silently miss the sandbox's technical ID.
        await page.waitForFunction(() =>
          [...document.querySelectorAll('main .rp-badge')].some((badge) =>
            badge.textContent?.trim() === 'サンドボックス利用不可' &&
            badge.closest('.rp-card')?.textContent?.includes('(marine-lab)')
          )
        )
        const card = await page.evaluate(() =>
          [...document.querySelectorAll('main .rp-badge')]
            .find((badge) => badge.textContent?.trim() === 'サンドボックス利用不可')
            ?.closest('.rp-card')?.textContent ?? ''
        )
        expect(card).toContain('サンドボックスの抽出方法')
        expect(card).toContain('(marine-lab)')
        expect(card).toContain('抽出用サンドボックスを利用できません。')
      }
      expect(await page.evaluate(() => innerWidth)).toBe(1440)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1)
      const english = await page.evaluate(() => {
        const root = document.querySelector('[data-manage-shell]')!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const candidates = new Set<string>()
        while (walker.nextNode()) {
          const node = walker.currentNode, parent = node.parentElement
          const text = node.textContent?.trim() ?? ''
          if (
            !parent || parent.closest('pre,code,script,style,.font-mono,[data-audit-event]') ||
            !parent.getClientRects().length
          ) continue
          if (/[A-Za-z]{2,}/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) {
            candidates.add(text)
          }
        }
        return [...candidates].sort()
      })
      inventory.push({ tab, english })
      expect(english.filter((text) => !portalAuthoredEnglish.has(text))).toEqual([])
      await assertButtonBounds(page)
      if (tab === 'behaviour') {
        expect(
          await page.evaluate(() =>
            document.querySelector('main tbody td:first-child span')?.textContent
          ),
        ).toBe('Library')
        expect(
          await page.evaluate(() =>
            document.querySelector('main tbody td:first-child span:nth-child(2)')?.textContent
          ),
        ).toBe('Summary {name}')
      }
    }
    await Deno.writeTextFile(
      `${captures}/visible-english-candidates.json`,
      JSON.stringify(inventory, null, 2),
    )

    await navigate(page, 'enrichments')
    await page.waitForSelector('[data-enrichments-import]')
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.querySelector('[data-enrichments-import-file]')!).position
      ),
    ).toBe('absolute')
    await pickArchive(page, '{}')
    await (await page.waitForSelector('[data-enrichments-import-review]')).click()
    await page.waitForFunction(() =>
      document.querySelector('[data-enrichments-import] [role=alert]')?.textContent?.includes(
        '付加情報レコード',
      ) === true
    )
    await language(page, 'en')
    await page.waitForFunction(() =>
      document.querySelector('[data-enrichments-import] [role=alert]')?.textContent?.includes(
        'Choose an archive containing at least one enrichment record.',
      ) === true
    )
    await language(page, 'ja')
    expect(
      server.requests.filter((request) =>
        request.method === 'POST' && request.path.includes('/enrichments/import')
      ),
    ).toHaveLength(0)
    await pickArchive(
      page,
      JSON.stringify({
        'research-summary': {
          'res-1': {
            schemaId: 'research-summary',
            generatedAt: '2026-10-16T00:00:00Z',
            data: { title: 'Summary', summary: 'Original {name} <study>' },
          },
        },
      }),
    )
    await (await page.waitForSelector('[data-enrichments-import-review]')).click()
    await page.waitForSelector('[data-enrichments-import-preview]')
    await page.setViewportSize({ width: 390, height: 960 })
    await page.evaluate(() =>
      document.querySelector('[data-enrichments-import-preview]')?.scrollIntoView({
        block: 'center',
      })
    )
    await assertButtonBounds(page)
    await Deno.writeFile(`${captures}/ja-light-390-import-review.png`, await page.screenshot())
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-enrichments-import-preview] p')?.textContent
      ),
    ).toBe('Summary {name}.json')
    await (await page.waitForSelector('[data-enrichments-import-confirm]')).click()
    await page.waitForFunction(() =>
      document.querySelector('[data-enrichments-import] [role=status]')?.textContent?.includes(
        'インポートし',
      ) === true
    )
    await language(page, 'en')
    await page.waitForFunction(() =>
      document.querySelector('[data-enrichments-import] [role=status]')?.textContent?.includes(
        'Imported 1 record. Kept 0 existing records unchanged.',
      ) === true
    )
    await language(page, 'ja')
    await page.waitForFunction(() =>
      document.querySelector('[data-enrichments-import] [role=status]')?.textContent?.includes(
        'インポートし',
      ) === true
    )
    expect(
      server.requests.filter((request) =>
        request.method === 'POST' && request.path.includes('/enrichments/import')
      ),
    ).toEqual([{
      path: '/api/admin/t/marine/enrichments/import?collision=skip',
      method: 'POST',
      status: 200,
    }])

    for (const locale of ['ja', 'en'] as const) {
      await language(page, locale)
      for (const scheme of ['light', 'dark']) {
        await page.evaluate((scheme) => {
          localStorage.setItem('rp-scheme', scheme)
        }, { args: [scheme] })
        for (const width of [1440, 390]) {
          const preview = await browser.newPage('about:blank')
          try {
            await preview.setViewportSize({ width, height: 960 })
            await preview.emulateMediaFeatures([{
              name: 'prefers-reduced-motion',
              value: 'reduce',
            }])
            await preview.goto(`${server.url}/t/marine/manage?tab=enrichments`)
            await preview.waitForSelector('[data-enrichments-import]')
            await preview.evaluate(() => {
              document.documentElement.style.fontSize = '22px'
            })
            for (const tab of ['enrichments', 'appearance', 'content', 'access', 'audit']) {
              await navigate(preview, tab)
              expect(await preview.evaluate(() => innerWidth)).toBe(width)
              expect(
                await preview.evaluate(() => document.documentElement.scrollWidth - innerWidth),
              ).toBeLessThanOrEqual(1)
              const metrics = await preview.evaluate(() => {
                const body = getComputedStyle(document.body)
                return {
                  width: innerWidth,
                  scrollWidth: document.documentElement.scrollWidth,
                  font: getComputedStyle(document.documentElement).fontSize,
                  colorScheme: body.colorScheme,
                  background: body.backgroundColor,
                  ink: body.color,
                }
              })
              expect(metrics.font).toBe('22px')
              expect(metrics.colorScheme).toBe(scheme)
              const channels = metrics.background.match(/\d+/g)!.slice(0, 3).map(Number)
              expect(channels.every((value) => scheme === 'dark' ? value < 100 : value > 180))
                .toBe(true)
              await assertButtonBounds(preview)
              await preview.evaluate(() =>
                document.querySelector('[data-manage-tab][aria-current=true]')?.scrollIntoView({
                  block: 'center',
                })
              )
              await Deno.writeFile(
                `${captures}/${locale}-${scheme}-${width}-${tab}.png`,
                await preview.screenshot(),
              )
              evidence.push({ locale, scheme, width, tab, metrics })
            }
          } finally {
            await preview.close()
          }
        }
      }
    }
    expect(
      server.requests.filter((request) =>
        request.method !== 'GET' && !request.path.includes('/enrichments/import')
      ),
    ).toEqual([])
    await Deno.writeTextFile(`${captures}/metrics.json`, JSON.stringify(evidence, null, 2))
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
