import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary,
  sourcePath,
} from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

function managementFixture(options: { analysis?: boolean } = {}) {
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
        case 'listAgents':
        case 'agentConfigs':
        case 'labelsets':
          return Promise.resolve([])
        case 'listResources':
          return Promise.resolve(
            options.analysis
              ? [{
                id: 'res-2',
                title: 'Marine research',
                summary: 'Evidence for coastal fisheries',
                slug: 'marine-research',
              }]
              : [],
          )
        case 'listSearchConfigs':
          return Promise.resolve({})
        case 'createLabelset':
        case 'patchResourceClassifications':
          return Promise.resolve()
        case 'askStructured':
          return Promise.resolve({
            object: {
              suggestions: [],
              topics: [{ id: 'coastal', label: 'Coastal' }],
              kinds: [],
              assignments: [],
              suggestedQuestions: ['What supports coastal fisheries?'],
            },
          })
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

async function seedSuggestions(directory: string) {
  await Deno.mkdir(`${directory}/suggestions`, { recursive: true })
  await Deno.writeTextFile(
    `${directory}/suggestions/marine.json`,
    JSON.stringify([
      {
        id: 'taxonomy',
        kind: 'labelset',
        title: 'Research settings',
        detail: 'Group the research settings.',
        status: 'pending',
        createdAt: new Date().toISOString(),
        labelset: { id: 'setting', title: 'Setting', paragraphs: false, labels: ['Coastal'] },
      },
      {
        id: 'graph',
        kind: 'entity-type',
        title: 'Research organisation',
        detail: 'Identify research organisations.',
        status: 'pending',
        createdAt: new Date().toISOString(),
        entityType: { label: 'Organisation', description: 'Research organisation' },
      },
      {
        id: 'unknown',
        kind: 'future-kind',
        title: 'Unsupported suggestion',
        detail: 'A future variant must not be implemented.',
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ]),
  )
}

Deno.test('suggestions independently require their subpermission and unknown kinds never dispatch', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
    import { createRoot } from 'react-dom/client'
    import { MemoryRouter } from 'react-router-dom'
    import { AccessProvider, useAccess } from '${
      sourcePath('apps/web/src/components/AccessProvider.tsx')
    }'
    import { EmergencyAccessProvider } from '${
      sourcePath('apps/web/src/components/EmergencyAccess.tsx')
    }'
    import { InterrogatePanel } from '${
      sourcePath('apps/web/src/pages/admin/InterrogatePanel.tsx')
    }'
    const original = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      if (String(input).startsWith('/auth/me')) {
        const snapshot = await response.json()
        const drop = new URLSearchParams(location.search).get('drop')
        snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter(p => p !== drop)
        return Response.json(snapshot)
      }
      return response
    }
    function Fixture() { const { state } = useAccess(); return <EmergencyAccessProvider session={state.session}><h1>Suggestions</h1><InterrogatePanel slug='marine' /></EmergencyAccessProvider> }
    createRoot(document.getElementById('root')).render(<MemoryRouter><AccessProvider slug='marine'><Fixture /></AccessProvider></MemoryRouter>)
  `,
  })
  const browser = await launch()
  try {
    for (const drop of ['', 'taxonomy.write', 'graph.write', 'behaviour.write']) {
      const { management, calls } = managementFixture()
      const server = startTestServer({
        identity: { role: 'owner' },
        management,
        componentFixture: fixture,
      })
      await seedSuggestions(server.directory)
      const page = await browser.newPage(`${server.url}/__test/rbac-component?drop=${drop}`)
      try {
        if (drop === 'behaviour.write') {
          await page.waitForSelector('h1')
          await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
          expect(await page.$('[data-suggestions-read]')).toBeNull()
          expect(server.requests.some((r) => r.path.endsWith('/suggestions'))).toBe(false)
          continue
        }
        await page.waitForSelector('[data-suggestion=unknown]')
        expect(await page.$('[data-suggestion=unknown] [data-suggestion-implement]')).toBeNull()
        for (const id of ['taxonomy', 'graph']) {
          expect(!!await page.$(`[data-suggestion=${id}] [data-suggestion-implement]`)).toBe(
            drop !== `${id}.write`,
          )
        }
        const before = server.requests.filter((r) => r.method === 'POST').length
        if (drop) {
          await page.evaluate(
            (id) =>
              document.querySelector<HTMLButtonElement>(
                `[data-suggestion=${id}] [data-suggestion-implement]`,
              )?.click(),
            { args: [drop.split('.')[0]!] },
          )
          expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(before)
        } else {
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>(
              '[data-suggestion=taxonomy] [data-suggestion-implement]',
            )!.click()
          )
          await page.waitForFunction(() => document.body.textContent!.includes('Implemented'))
          expect(calls).toContain('createLabelset')
          expect(
            server.requests.some((r) =>
              r.path.endsWith('/suggestions/taxonomy/implement') && r.status === 200
            ),
          ).toBe(true)
        }
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>(
            '[data-suggestion=graph] [data-suggestion-ignore]',
          )!.click()
        )
        await page.waitForFunction(() => document.body.textContent!.includes('Ignored'))
        expect(
          server.requests.some((r) =>
            r.path.endsWith('/suggestions/graph/ignore') && r.status === 200
          ),
        ).toBe(true)
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
    await fixture.close()
  }
})

Deno.test('real Manage curator taxonomy has no behaviour traffic and owner can save behaviour and interrogate', async () => {
  const browser = await launch()
  try {
    for (const role of ['curator', 'owner'] as const) {
      const server = startTestServer({
        identity: { role },
        management: managementFixture({ analysis: true }).management,
      })
      const page = await browser.newPage(`${server.url}/t/marine/manage?tab=taxonomy`)
      try {
        await page.waitForSelector('#ls-topic-title')
        if (role === 'curator') {
          expect(await page.$('[data-suggestions-read]')).toBeNull()
          expect(
            server.requests.filter((r) =>
              /\/(suggestions|prompts|search-configs|routing)$/.test(r.path)
            ),
          ).toHaveLength(0)
        } else {
          await page.waitForSelector('[data-suggestions-read]')
          await click(page, 'Run analysis')
          await page.waitForFunction(() => document.body.innerText.includes('Analysis complete'))
          expect(server.requests.some((r) => r.path.endsWith('/analyse') && r.status === 200)).toBe(
            true,
          )
          await click(page, 'Run interrogation')
          await page.waitForFunction(() =>
            [...document.querySelectorAll('button')].some((b) =>
              b.textContent?.trim() === 'Run interrogation' && !b.disabled
            )
          )
          expect(server.requests.some((r) => r.path.endsWith('/interrogate') && r.status === 200))
            .toBe(true)
          await navigate(page, 'behaviour')
          await page.waitForSelector('[data-behaviour-prompt]:not(:disabled)')
          await page.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('[data-behaviour-prompt]')!
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
              input,
              'Keep answers grounded in citations.',
            )
            input.dispatchEvent(new Event('input', { bubbles: true }))
          })
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-behaviour-save]')!.click()
          )
          await page.waitForFunction(() =>
            document.body.innerText.includes('Saved - the new prompt applies')
          )
          expect(
            server.requests.some((r) =>
              r.path.endsWith('/prompts') && r.method === 'PUT' && r.status === 200
            ),
          ).toBe(true)
          const pending = server.delayResponse('/api/admin/t/marine/prompts')
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-behaviour-read=prompts]')!.click()
          )
          await pending.entered
          server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-owner', null)
          server.setIdentity(null)
          await page.evaluate(() => dispatchEvent(new Event('focus')))
          await page.waitForFunction(() => !document.querySelector('[data-behaviour-prompt]'))
          pending.release()
          await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
          expect(await page.$('[data-behaviour-save]')).toBeNull()
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

Deno.test('behaviour and suggestion controls render in light dark wide390 with22px tokens', async () => {
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
      await seedSuggestions(server.directory)
      const page = await browser.newPage(`${server.url}/t/marine/manage?tab=behaviour`)
      try {
        await page.waitForSelector('[data-behaviour-prompt]:not(:disabled)')
        await assertCurrentBuild(page)
        await page.evaluate(
          (dark) =>
            document.querySelector<HTMLButtonElement>(
              `button[aria-label="Switch to ${dark ? 'dark' : 'light'} mode"]`,
            )?.click(),
          { args: [dark] },
        )
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 960 })
          for (const tab of ['behaviour', 'taxonomy']) {
            await navigate(page, tab)
            const selector = tab === 'behaviour'
              ? '[data-behaviour-prompt]'
              : '[data-suggestion=taxonomy]'
            await page.waitForSelector(selector)
            await page.evaluate(async (selector) => {
              await Promise.all(
                document.getAnimations().filter((a) =>
                  Number.isFinite(a.effect?.getComputedTiming().endTime)
                ).map((a) => a.finished.catch(() => {})),
              )
              document.querySelector(selector)?.scrollIntoView({ block: 'center' })
            }, { args: [selector] })
            await captureBoundary(
              page,
              '.planning/logs/04-07-02/visual',
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
