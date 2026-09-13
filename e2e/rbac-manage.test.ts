import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

// Only the external management service is doubled. Signed LocalIngress and the
// production declared counters/recent routes still enforce every request.
const management = new Proxy({}, {
  get: (_target, method) => {
    if (method === 'counters') {
      return () => Promise.resolve({ resources: 2, paragraphs: 14, sentences: 28, indexMb: 1 })
    }
    if (method === 'recentResources') {
      return () =>
        Promise.resolve([{
          id: 'res-2',
          title: 'Marine heatwave impacts on rock lobster',
          status: 'processed',
        }])
    }
    return () =>
      Promise.reject(new Error(`Management fixture method unavailable: ${String(method)}`))
  },
}) as NonNullable<BuildAppOptions['management']>

const stages = ['04-05-02', '04-06-01', '04-06-02', '04-07-01', '04-07-02', '04-07-03']
const stage = Deno.env.get('RBAC_MANAGE_STAGE')
const curatorTabs = [
  'overview',
  'insights',
  'content',
  'enrichments',
  'taxonomy',
  'graph',
  'extraction',
]
const administratorTabs = [
  ...curatorTabs,
  'appearance',
  'behaviour',
  'details',
  'connections',
  'access',
  'audit',
]

async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState(null, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [path] })
}

Deno.test('Manage stage convention rejects unknown stages and checks only the owning readiness boundary', async () => {
  if (stage !== undefined) expect(stages).toContain(stage)
  if (stage !== '04-05-02') return
  const source = await Deno.readTextFile('apps/web/src/pages/ManagePage.tsx')
  const map = source.match(/const MANAGE_PANEL_READY = \{([\s\S]*?)\}/)?.[1]
  expect(map).toBeDefined()
  const entries = [...map!.matchAll(/(\w+):\s*(true|false)/g)].map((match) => [match[1], match[2]])
  expect(entries).toEqual([
    'recentList',
    'statTiles',
    'addContent',
    'corpusHealth',
    'sources',
    'insights',
    'labelsets',
    'graph',
    'enrichments',
    'analyse',
    'interrogate',
    'behaviour',
    'extraction',
    'appearance',
    'rename',
  ].map((name) => [name, 'false']))
})

Deno.test('Manage uses scoped reads and rejects forbidden and stale tab destinations', async () => {
  const browser = await launch()
  try {
    for (const role of ['viewer', 'analyst', 'curator', 'portal-admin', 'owner'] as const) {
      const server = startTestServer({ identity: { role }, management })
      try {
        const page = await browser.newPage(`${server.url}/t/marine/manage?tab=appearance`)
        try {
          await assertCurrentBuild(page)
          const allowed = role !== 'viewer' && role !== 'analyst'
          await page.waitForSelector(allowed ? '[data-manage-shell]' : '[data-route-unavailable]')
          if (allowed) {
            const expected = role === 'curator' ? curatorTabs : administratorTabs
            const tabs = await page.evaluate(() =>
              [...document.querySelectorAll('[data-manage-tab]')].map((node) =>
                node.getAttribute('data-manage-tab')
              )
            )
            expect(tabs.sort()).toEqual([...expected].sort())
            expect(
              await page.evaluate(() =>
                document.querySelector('[data-manage-tab][aria-current=true]')?.getAttribute(
                  'data-manage-tab',
                )
              ),
            ).toBe(role === 'curator' ? 'overview' : 'appearance')
            await navigate(page, '/t/marine/manage?tab=obsolete')
            await page.waitForSelector('[data-manage-tab=overview][aria-current=true]')
            await page.waitForSelector('[data-manage-counts]')
            expect(
              await page.evaluate(() =>
                document.querySelector('[data-manage-counts]')?.textContent
              ),
            ).toContain('2')
            expect(
              await page.evaluate(() =>
                document.querySelector('[data-manage-recent]')?.textContent
              ),
            ).toContain('Marine')
            for (const tab of expected) {
              await navigate(page, `/t/marine/manage?tab=${tab}`)
              await page.waitForSelector(`[data-manage-tab=${tab}][aria-current=true]`)
            }
            expect(
              await page.evaluate(() =>
                [...document.querySelectorAll('button')].some((button) =>
                  button.textContent?.trim() === 'Remove'
                )
              ),
            ).toBe(false)
            expect(await page.evaluate(() => !!document.querySelector('a[href="/admin"]'))).toBe(
              role === 'owner',
            )
          }
          expect(server.requests.some((request) => request.path === '/api/admin/overview')).toBe(
            false,
          )
          expect(
            server.requests.filter((request) => request.status === 401 || request.status === 403),
          ).toEqual([])
          if (!allowed) {
            expect(server.requests.filter((request) => request.path.startsWith('/api/admin/')))
              .toEqual([])
          }
          if (stage === '04-05-02' && allowed) {
            expect(
              server.requests.filter((request) =>
                request.path.startsWith('/api/admin/') &&
                !['/api/admin/t/marine/counters', '/api/admin/t/marine/recent'].includes(
                  request.path,
                )
              ),
            ).toEqual([])
          }
        } finally {
          await page.close()
        }
      } finally {
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('Manage drops pending scoped reads after identity or permission changes', async () => {
  const server = startTestServer({ identity: { role: 'curator' }, management })
  const delay = server.delayResponse('/api/admin/t/marine/counters')
  const browser = await launch()
  try {
    const page = await browser.newPage(`${server.url}/t/marine/manage`)
    try {
      await delay.entered
      server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
      await page.evaluate(() => dispatchEvent(new Event('focus')))
      await page.waitForSelector('[data-route-unavailable]')
      delay.release()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await page.evaluate(() => document.querySelector('[data-manage-counts]'))).toBe(null)
      expect(await page.evaluate(() => document.querySelector('[data-manage-shell]'))).toBe(null)
    } finally {
      await page.close()
    }
  } finally {
    delay.release()
    await browser.close()
    await server.close()
  }
})

Deno.test('Manage shell and scoped connections fit both themes and actual390 at22px', async () => {
  const browser = await launch()
  const directory = '.planning/logs/04-05-02-visual'
  try {
    for (const role of ['curator', 'portal-admin'] as const) {
      for (const dark of [false, true]) {
        const server = startTestServer({ identity: { role }, management })
        try {
          server.tenants.patchBranding('marine', {
            paletteId: dark ? 'observatory' : 'default',
            shape: 'soft',
            density: 'spacious',
            typography: 'lexend-zilla',
          })
          const page = await browser.newPage(
            `${server.url}/t/marine/manage?tab=${role === 'curator' ? 'overview' : 'connections'}`,
          )
          try {
            await page.waitForSelector(
              role === 'curator' ? '[data-manage-counts]' : '[data-portal-connections]',
            )
            // A host dark preference must not turn the light capture dark.
            await page.evaluate(() => {
              document.querySelector<HTMLButtonElement>('button[aria-label="Switch to light mode"]')
                ?.click()
            })
            await page.waitForFunction(
              (dark: boolean) =>
                getComputedStyle(document.body).colorScheme === (dark ? 'dark' : 'light'),
              { args: [dark] },
            )
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)))
            for (const width of [1440, 390]) {
              await captureBoundary(
                page,
                directory,
                `${role}-${dark ? 'dark' : 'light'}-${width}`,
                width,
              )
              if (role === 'portal-admin') {
                await page.evaluate(() =>
                  document.querySelector('[data-portal-connections]')?.scrollIntoView()
                )
                await captureBoundary(
                  page,
                  directory,
                  `connections-${dark ? 'dark' : 'light'}-${width}`,
                  width,
                )
                await page.evaluate(() => scrollTo(0, 0))
              }
            }
          } finally {
            await page.close()
          }
        } finally {
          await server.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
})
