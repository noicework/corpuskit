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

const passage =
  'Surveys across the southern region recorded a sustained 12% decline in abalone populations since 2019, with marine heatwaves identified as the leading stressor.'
const question = 'How do marine heatwaves affect abalone populations?'
function readingManagement() {
  const calls: string[] = []
  const management = {
    rephrase: () => Promise.resolve(null),
    counters: () => Promise.resolve({ resources: 2, paragraphs: 2, sentences: 4, indexMb: 1 }),
    thumbnailResponse: () =>
      Promise.resolve(
        new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#ddd"/><text x="10" y="30">Marine research</text></svg>',
          { headers: { 'content-type': 'image/svg+xml' } },
        ),
      ),
    resourceContent: (_config: unknown, id: string) =>
      Promise.resolve({
        id,
        title: 'Abalone stock health',
        kind: 'pdf',
        texts: [{ fieldId: 'body', text: passage }],
        transcript: [],
        files: [{ group: 'file', fieldId: 'source', contentType: 'application/pdf' }],
      }),
    resourceExtraction: () =>
      Promise.resolve({ text: passage, chars: passage.length, paragraphs: 1 }),
    fileStream: () =>
      Promise.resolve(
        new Response(
          '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 48>>stream\nBT /F1 12 Tf 20 250 Td (Marine research) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
          { headers: { 'content-type': 'application/pdf' } },
        ),
      ),
    askStructured: (_config: unknown, schema: { name: string }) => {
      calls.push(schema.name)
      return Promise.resolve({
        object: { questions: [{ question, evidence: passage }] },
        sources: [],
      })
    },
    entityGroups: () => Promise.resolve([{ label: 'Species', entities: ['Abalone', 'Lobster'] }]),
    relationsGraph: () =>
      Promise.resolve({
        nodes: [{ id: 'Abalone', label: 'Species' }, { id: 'Lobster', label: 'Species' }],
        edges: [{ source: 'Abalone', target: 'Lobster', label: 'shares waters with' }],
      }),
    graphData: () =>
      Promise.resolve({
        primary: 'topic',
        secondary: 'kind',
        nodes: [
          { id: 'stock-assessment', label: 'Stock assessment', group: 'primary', weight: 1 },
          { id: 'pdf', label: 'PDF', group: 'secondary', weight: 1 },
        ],
        edges: [{ source: 'stock-assessment', target: 'pdf', weight: 1 }],
      }),
    listAgents: () => Promise.resolve([]),
  } as unknown as BuildAppOptions['management']
  return { management, calls }
}

async function reduceAsk(page: Page) {
  await page.evaluate(() => {
    const original = fetch
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      if (!String(input).includes('/auth/me')) return response
      const value = await response.json()
      value.portalAccess.permissions = value.portalAccess.permissions.filter((p: string) =>
        p !== 'portal.ask'
      )
      return Response.json(value)
    }
    dispatchEvent(new Event('focus'))
  })
  await page.waitForFunction(() => !document.body.textContent?.includes('Checking access'))
}

async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState({}, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [path] })
}

Deno.test('read-only snapshots hide embedded Ask without removing source or help reading', async () => {
  const { management, calls } = readingManagement()
  const server = startTestServer({ identity: { role: 'viewer' }, management })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/help`)
  try {
    await page.waitForSelector('#docs-ask')
    await assertCurrentBuild(page)
    await reduceAsk(page)
    await page.waitForSelector('article')
    expect(await page.$('#docs-ask')).toBeNull()
    expect(await page.$('a[aria-label="Ask a question"]')).toBeNull()
    const before = server.requests.length
    await navigate(page, '/t/marine/search?q=abalone')
    await page.waitForSelector('#result-res-1')
    expect(await page.$('[aria-label="AI answer"]')).toBeNull()
    expect(
      server.requests.slice(before).filter((r) =>
        /\/(ask|generate|summarize|followups|verdicts)$/.test(r.path)
      ),
    ).toEqual([])
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Summarise these results',
    )
    await navigate(page, '/t/marine/library/res-1')
    await page.waitForFunction(() =>
      document.querySelector('h1')?.textContent?.includes('Abalone stock health')
    )
    await page.waitForFunction((question) => document.body.textContent?.includes(question), {
      args: [question],
    })
    expect(await page.$('#ask-document')).toBeNull()
    expect(calls.length).toBe(1)
    expect(await page.$('a[aria-label="Ask a question"]')).toBeNull()
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/library/res-1`)
      await page.waitForSelector('#ask-document')
      await reduceAsk(page)
      await page.waitForSelector('[aria-label="Questions about this document"]')
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 })
        await page.evaluate(async () => {
          document.documentElement.style.fontSize = '22px'
          await document.fonts.ready
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          document.querySelector('[aria-label="Questions about this document"]')!
            .scrollIntoView({ block: 'center' })
        })
        await captureBoundary(
          page,
          '.planning/logs/04-11-02',
          `document-questions-${scheme}-${width}`,
          width,
        )
        await page.evaluate(async () => {
          await new Promise((resolve) => setTimeout(resolve, 400))
          document.querySelector('[aria-label="Questions about this document"]')!
            .scrollIntoView({ block: 'center', behavior: 'instant' })
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        })
        const headingBounds = await page.evaluate(() => {
          const heading = document.querySelector('[aria-label="Questions about this document"] h2')!
          const bounds = heading.getBoundingClientRect()
          return { top: bounds.top, bottom: bounds.bottom }
        })
        expect(headingBounds.top).toBeGreaterThan(150)
        expect(headingBounds.bottom).toBeLessThan(960)
        await Deno.writeFile(
          `.planning/logs/04-11-02/document-questions-${scheme}-${width}.png`,
          await page.screenshot(),
        )
      }
    }
    expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('viewer reads Explore Search original PDF cold questions Entity Graph and Docs with no advisory generation', async () => {
  const { management, calls } = readingManagement()
  const server = startTestServer({ identity: { role: 'viewer' }, management })
  const browser = await launch()
  const delayed = server.delayResponse('/auth/me')
  const page = await browser.newPage(`${server.url}/t/marine`)
  try {
    await delayed.entered
    expect(
      server.requests.filter((r) =>
        r.path.startsWith('/api/t/marine/') && !r.path.endsWith('/config')
      ),
    ).toEqual([])
    delayed.release()
    await page.waitForFunction(() => document.body.textContent?.includes('Abalone stock health'))
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      for (
        const route of ['', 'search?q=abalone', 'library/res-1', 'entity/Abalone', 'graph', 'help']
      ) {
        await page.goto(`${server.url}/t/marine/${route}`)
        await page.bringToFront()
        if (route.startsWith('search')) {
          await page.waitForFunction(() => document.body.textContent?.includes('Answer complete'))
        } else if (route === 'library/res-1') {
          await page.waitForSelector('#ask-document')
          await page.waitForFunction((question) => document.body.textContent?.includes(question), {
            args: [question],
          })
          const file = await page.evaluate(async () => {
            const response = await fetch('/api/t/marine/resources/res-1/file/source')
            return {
              status: response.status,
              type: response.headers.get('content-type'),
              bytes: (await response.text()).slice(0, 8),
            }
          })
          expect(file).toEqual({ status: 200, type: 'application/pdf', bytes: '%PDF-1.4' })
        } else if (route === 'help') {
          await askDocs(page, 'How can I read sources?')
          await page.waitForFunction(() => document.body.textContent?.includes('Answer ready'))
        } else if (route.startsWith('entity')) {
          await page.waitForFunction(() =>
            document.querySelector('h1')?.textContent?.includes('Abalone')
          )
        } else if (route === 'graph') await page.waitForSelector('canvas')
        else {await page.waitForFunction(() =>
            document.body.textContent?.includes('Abalone stock health')
          )}
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-11-02',
            `${route.split(/[/?]/)[0] || 'explore'}-${scheme}-${width}`,
            width,
          )
        }
      }
    }
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((name) => name === 'suggested_questions')).toBe(true)
    expect(
      server.requests.filter((r) =>
        /\/(generate|summarize|followups|verdicts|subqueries)$/.test(r.path)
      ),
    ).toEqual([])
    for (
      const suffix of [
        '/catalog',
        '/search',
        '/resources/res-1',
        '/resources/res-1/content',
        '/resources/res-1/thumbnail',
        '/resources/res-1/questions',
        '/resources/res-1/file/source',
        '/entity',
        '/graph/relations',
        '/docs/ask',
      ]
    ) {
      expect(
        server.requests.some((r) => r.path.split('?')[0]?.endsWith(suffix) && r.status === 200),
        suffix,
      ).toBe(true)
    }
    expect(
      server.requests.filter((r) => r.status === 401 || r.status === 403 || (r.status ?? 0) >= 500),
    ).toEqual([])
  } finally {
    delayed.release()
    await page.close()
    await browser.close()
    await server.close()
  }
})

async function askDocs(page: Page, text: string) {
  await page.waitForSelector('#docs-ask')
  await page.evaluate((text) => {
    const input = document.querySelector<HTMLInputElement>('#docs-ask')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [text] })
  await page.waitForFunction(() =>
    !document.querySelector<HTMLButtonElement>('#docs-ask + button')?.disabled
  )
  await page.evaluate(() => document.querySelector('#docs-ask')!.closest('form')!.requestSubmit())
}

Deno.test('document Ask answers for viewers and retires A-to-B-to-A and revoked streams', async () => {
  const { management } = readingManagement()
  const server = startTestServer({ identity: { role: 'viewer' }, management })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/library/res-1`)
  const ask = async () => {
    await page.waitForFunction(
      (question) =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === question),
      { args: [question] },
    )
    await page.evaluate(
      (question) =>
        [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === question)!
          .click(),
      { args: [question] },
    )
  }
  try {
    const delayed = server.delayResponse('/api/t/marine/ask')
    await ask()
    await delayed.entered
    await navigate(page, '/t/marine/library/res-2')
    await page.waitForFunction(() =>
      document.querySelector('h1')?.textContent?.includes('Marine heatwave impacts')
    )
    await navigate(page, '/t/marine/library/res-1')
    await page.waitForSelector('#ask-document')
    delayed.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.$('sup a')).toBeNull()
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/library/res-1`)
      await ask()
      await page.waitForSelector('sup a')
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 })
        await page.evaluate(() => document.querySelector('#chat-heading')!.scrollIntoView())
        await captureBoundary(
          page,
          '.planning/logs/04-11-02',
          `document-answer-${scheme}-${width}`,
          width,
        )
      }
    }
    const revoked = server.delayResponse('/api/t/marine/ask')
    await page.goto(`${server.url}/t/marine/library/res-1`)
    await ask()
    await revoked.entered
    await reduceAsk(page)
    await page.waitForFunction(() => !document.querySelector('#ask-document'))
    revoked.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await page.$('sup a')).toBeNull()
    expect(server.requests.filter((r) => /\/(generate|followups|verdicts)$/.test(r.path))).toEqual(
      [],
    )
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('standalone ChatFab and ContextJourney obey exact Ask authority', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AccessProvider, useAccess } from '${
      sourcePath('apps/web/src/components/AccessProvider.tsx')
    }'
import { PortalAccessGate } from '${sourcePath('apps/web/src/components/PortalAccessGate.tsx')}'
import { ChatFab } from '${sourcePath('apps/web/src/components/ChatFab.tsx')}'
import { ContextJourney } from '${sourcePath('apps/web/src/components/AnswerStream.tsx')}'
import { getTenantConfig } from '${sourcePath('apps/web/src/api/client.ts')}'
import { tenantThemeVars, useBodyTheme, useViewerScheme } from '${
      sourcePath('apps/web/src/lib/theme.ts')
    }'
function Surface({ config }) {
 const access = useAccess(), { scheme } = useViewerScheme()
 useBodyTheme(config.branding, scheme)
 return <main className='rp-tenant rp-shell py-10' style={tenantThemeVars(config.branding, scheme)}>
 <h1 className='rp-display text-2xl'>Research source controls</h1>
 <p className='my-4'>Abalone stock health in southern waters</p>
 <button className='rp-btn rp-btn-outline' onClick={() => access.controller.setSession({...access.state.session, portalAccess: {...access.state.session.portalAccess, permissions: access.state.session.portalAccess.permissions.filter(p => p !== 'portal.ask')}}, 'marine')}>Remove Ask</button>
 <ContextJourney slug='marine' query='abalone' sources={[{id:'res-1',title:'Abalone stock health',relevance:1,citedCount:1,topicIds:[],summary:'Marine heatwaves affect populations.'}]} />
 <ChatFab slug='marine' />
 </main>
}
function Panel() { const { data } = useQuery({queryKey:['config','marine'],queryFn:()=>getTenantConfig('marine')}); return data ? <Surface config={data}/> : null }
createRoot(document.getElementById('root')).render(<StrictMode><BrowserRouter><AccessProvider slug='marine'><PortalAccessGate><Panel/></PortalAccessGate></AccessProvider></BrowserRouter></StrictMode>)
`,
  })
  const server = startTestServer({ identity: { role: 'portal-admin' }, componentFixture: fixture })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/__test/rbac-component`)
      await page.waitForSelector('a[aria-label="Ask a question"]')
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/04-11-02',
          `embedded-controls-${scheme}-${width}`,
          width,
        )
      }
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.trim() === 'Remove Ask'
        )!.click()
      )
      await page.waitForSelector('h1')
      expect(await page.$('a[aria-label="Ask a question"]')).toBeNull()
      expect(await page.evaluate(() => document.body.textContent)).not.toContain(
        'Journey through the context',
      )
      for (const width of [1440, 390]) {
        await captureBoundary(
          page,
          '.planning/logs/04-11-02',
          `embedded-denied-${scheme}-${width}`,
          width,
        )
      }
    }
    expect(server.requests.filter((r) => /\/(ask|generate)$/.test(r.path))).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('Help cancels stopped, unmounted and revoked answers without stale finalisers', async () => {
  const server = startTestServer({ identity: { role: 'viewer' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/help`)
  try {
    for (const action of ['stop', 'unmount', 'revoke']) {
      await page.waitForSelector('#docs-ask')
      const delayed = server.delayResponse('/api/t/marine/docs/ask')
      await askDocs(page, `Retired ${action} answer`)
      await delayed.entered
      if (action === 'stop') {
        await page.evaluate(() =>
          [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Stop')!
            .click()
        )
      } else if (action === 'unmount') {
        await navigate(page, '/t/marine/library')
        await page.waitForSelector('#library-search')
        await navigate(page, '/t/marine/help')
        await page.waitForSelector('#docs-ask')
      } else {
        await reduceAsk(page)
        await page.waitForSelector('article')
      }
      delayed.release()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await page.evaluate(() => document.body.textContent)).not.toContain(
        `Retired ${action} answer`,
      )
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
