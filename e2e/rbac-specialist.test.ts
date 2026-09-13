import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

function managementFixture() {
  const calls: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => () => {
      calls.push(String(method))
      switch (method) {
        case 'invalidate':
          return undefined
        case 'counters':
          return Promise.resolve({ resources: 0, paragraphs: 0, sentences: 0, indexMb: 0 })
        case 'recentResources':
        case 'listResources':
        case 'listAgents':
        case 'agentConfigs':
          return Promise.resolve([])
        case 'graphStrategy':
          return Promise.resolve(null)
        case 'relationsGraph':
          return Promise.resolve({ nodes: [], edges: [] })
        default:
          return Promise.reject(new Error(`Unsupported specialist fixture: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  return { management, calls }
}
async function click(page: Page, text: string) {
  await page.waitForFunction(
    (text: string) =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.trim() === text && !b.disabled
      ),
    { args: [text] },
  )
  await page.evaluate(
    (text) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!.click(),
    { args: [text] },
  )
}
async function navigate(page: Page, tab: string) {
  await page.evaluate((tab) => {
    history.pushState(null, '', `/t/marine/manage?tab=${tab}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [tab] })
  await page.waitForSelector(`[data-manage-tab=${tab}][aria-current=true]`)
}

Deno.test('viewer graph never mounts administration and curator can run and export enrichments', async () => {
  const browser = await launch()
  try {
    for (const role of ['viewer', 'curator'] as const) {
      const server = startTestServer({
        identity: { role },
        management: managementFixture().management,
      })
      const page = await browser.newPage(
        `${server.url}/t/marine/${role === 'viewer' ? 'graph' : 'manage?tab=enrichments'}`,
      )
      try {
        if (role === 'viewer') {
          await page.waitForFunction(() =>
            document.body.innerText.includes('No knowledge graph yet')
          )
          await assertCurrentBuild(page)
          expect(server.requests.filter((r) => r.path.startsWith('/api/admin/'))).toHaveLength(0)
          expect(await page.$('[data-graph-read]')).toBeNull()
        } else {
          await page.waitForSelector('[data-enrichment-run]')
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-enrichment-scope=all]')!.click()
          )
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-enrichment-run]')!.click()
          )
          await page.waitForFunction(() =>
            document.body.innerText.includes('Every resource in scope is already enriched.')
          )
          await page.evaluate(() => {
            Object.assign(globalThis, { downloads: 0 })
            HTMLAnchorElement.prototype.click = function () {
              if (this.download) {
                Object.assign(globalThis, { downloads: Reflect.get(globalThis, 'downloads') + 1 })
              }
            }
          })
          await click(page, 'Export enrichment archive')
          await page.waitForFunction(() => Reflect.get(globalThis, 'downloads') === 1)
          expect(
            server.requests.some((r) => r.path.endsWith('/enrichments/run') && r.status === 200),
          ).toBe(true)
          expect(
            server.requests.some((r) => r.path.endsWith('/enrichments/export') && r.status === 200),
          ).toBe(true)
          server.setResponseStatus('/api/admin/t/marine/enrichments/export', 403)
          await click(page, 'Export enrichment archive')
          await page.waitForFunction(() => !document.querySelector('[data-enrichments-export]'))
          expect(await page.evaluate(() => Reflect.get(globalThis, 'downloads'))).toBe(1)
        }
      } catch (error) {
        console.error(
          role,
          server.requests.slice(-12),
          await page.evaluate(() => document.body.innerText),
        )
        throw error
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('owner graph and enrichment mounts retain permission gates and staged pending panels stay inert', async () => {
  const browser = await launch()
  const { management, calls } = managementFixture()
  const server = startTestServer({ identity: { role: 'owner' }, management })
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=graph`)
  try {
    await page.waitForSelector('[data-graph-read=strategy]')
    await click(page, 'Load current strategy')
    expect(calls).toContain('graphStrategy')
    await navigate(page, 'enrichments')
    await page.waitForSelector('[data-enrichments-export]')
    if (stage === '04-07-01' || stage === '04-07-02') {
      for (
        const tab of [
          'extraction',
          'appearance',
          'details',
          ...(stage === '04-07-01' ? ['behaviour'] : []),
        ]
      ) {
        const before = server.requests.length
        await navigate(page, tab)
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 80)))
        expect(server.requests.slice(before).filter((r) => r.path.startsWith('/api/admin/')))
          .toHaveLength(0)
      }
    }
    await navigate(page, 'enrichments')
    await page.waitForSelector('[data-enrichments-export]')
    await page.evaluate(() => {
      const original = globalThis.fetch.bind(globalThis)
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (String(input).startsWith('/auth/me')) {
          const snapshot = await response.json()
          snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter((
            p: string,
          ) => p !== 'enrichments.write')
          return Response.json(snapshot)
        }
        return response
      }
      dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(() => !document.querySelector('[data-enrichments-export]'))
    expect(await page.$('[data-manage-tab=enrichments]')).toBeNull()
  } finally {
    await page.close()
    await server.close()
    await browser.close()
  }
})

Deno.test('specialist graph and enrichments render with appearance tokens at wide and real390 light dark22px', async () => {
  const browser = await launch()
  try {
    for (const dark of [false, true]) {
      const server = startTestServer({
        identity: { role: 'owner' },
        management: managementFixture().management,
      })
      server.tenants.patchBranding('marine', {
        paletteId: dark ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      const page = await browser.newPage(`${server.url}/t/marine/manage?tab=graph`)
      try {
        await page.waitForSelector('[data-graph-read=strategy]')
        await assertCurrentBuild(page)
        await page.evaluate(
          (dark) =>
            document.querySelector<HTMLButtonElement>(
              `button[aria-label="Switch to ${dark ? 'dark' : 'light'} mode"]`,
            )?.click(),
          { args: [dark] },
        )
        for (const width of [1440, 390]) {
          for (const tab of ['graph', 'enrichments']) {
            await navigate(page, tab)
            await page.waitForSelector(
              tab === 'graph' ? '[data-graph-read=strategy]' : '[data-enrichments-export]',
            )
            await page.evaluate(async (tab) => {
              await Promise.all(
                document.getAnimations().filter((a) =>
                  Number.isFinite(a.effect?.getComputedTiming().endTime)
                ).map((a) => a.finished.catch(() => {})),
              )
              document.querySelector(
                tab === 'graph' ? '[data-graph-read=strategy]' : '[data-enrichments-export]',
              )?.scrollIntoView({ block: 'center' })
            }, { args: [tab] })
            await captureBoundary(
              page,
              '.planning/logs/04-07-01/visual',
              `${tab}-${dark ? 'dark' : 'light'}-${width}`,
              width,
            )
          }
        }
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

const stage = Deno.env.get('RBAC_MANAGE_STAGE')
const stages = ['04-05-02', '04-06-01', '04-06-02', '04-07-01', '04-07-02', '04-07-03']
Deno.test('specialist readiness stage is exact', async () => {
  if (stage !== undefined) expect(stages).toContain(stage)
  if (!stage?.startsWith('04-07-')) return
  const source = await Deno.readTextFile('apps/web/src/pages/ManagePage.tsx')
  if (stage === '04-07-03') {
    expect(source).not.toContain('MANAGE_PANEL_READY')
    return
  }
  const map = source.match(/const MANAGE_PANEL_READY = \{([\s\S]*?)\}/)![1]!
  const ready = [
    'recentList',
    'statTiles',
    'addContent',
    'corpusHealth',
    'sources',
    'insights',
    'labelsets',
    'graph',
    'enrichments',
    ...(stage === '04-07-02' ? ['analyse', 'interrogate', 'behaviour'] : []),
  ]
  const entries = [...map.matchAll(/(\w+):\s*(true|false)/g)]
  expect(entries).toHaveLength(15)
  expect(entries.filter((m) => m[2] === 'true').map((m) => m[1])).toEqual(ready)
})
