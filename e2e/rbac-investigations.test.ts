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
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === label
    )
    if (!button) throw new Error(`Missing button ${label}`)
    button.click()
  }, { args: [label] })
}
async function fill(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    const prototype = input.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [selector, value] })
}
async function seed(server: ReturnType<typeof startTestServer>) {
  const post = async (path: string, value: unknown) => {
    const response = await fetch(`${server.url}/api/t/marine/investigations${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
    expect(response.ok).toBe(true)
    return response.json()
  }
  const investigation = await post('', {
    name: 'Signed research',
    question: 'What supports stock recovery?',
  })
  await post(`/${investigation.id}/evidence`, {
    resourceId: 'res-1',
    resourceTitle: 'Abalone stock research',
    passage: 'Research evidence supports stock recovery.',
    verdict: 'supports',
    tags: ['recovery'],
    note: 'A saved evidence note',
  })
  return investigation.id as string
}

Deno.test('same-browser legacy viewer reads list, notebook, evidence and artefacts with no writes or export', async () => {
  const server = startTestServer()
  const directory = `${server.directory}/investigations/marine/legacy-browser`
  await Deno.mkdir(directory, { recursive: true })
  await Deno.writeTextFile(
    `${directory}/legacy.json`,
    JSON.stringify({
      id: 'legacy',
      name: 'Legacy research',
      question: 'Legacy question',
      notes: 'Legacy notebook',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      evidence: [{
        id: 'evidence',
        resourceId: 'res-1',
        resourceTitle: 'Legacy source',
        passage: 'Legacy evidence passage',
        verdict: 'supports',
        note: 'Legacy evidence note',
        tags: ['legacy-tag'],
        createdAt: new Date().toISOString(),
      }],
      artefacts: [{
        id: 'artefact',
        kind: 'briefing',
        title: 'Legacy briefing',
        createdAt: new Date().toISOString(),
        data: {},
      }],
    }),
  )
  const browser = await launch()
  const page = await browser.newPage(server.url)
  try {
    await page.evaluate(() => localStorage.setItem('rp-client-id', 'legacy-browser'))
    await page.goto(`${server.url}/t/marine/investigations`)
    await page.waitForSelector('a[aria-label="Legacy research"]')
    expect(await page.$('#investigation-name')).toBeNull()
    await page.goto(`${server.url}/t/marine/investigations/legacy`)
    await page.waitForFunction(() => document.body.textContent?.includes('Legacy notebook'))
    const text = await page.evaluate(() => document.body.textContent)
    for (
      const value of [
        'Legacy evidence passage',
        'Legacy evidence note',
        'legacy-tag',
        'Legacy briefing',
      ]
    ) expect(text).toContain(value)
    for (
      const value of [
        'Close investigation',
        'Make current',
        'Synthesise the evidence',
        'Export to Word',
        'Confirm delete',
      ]
    ) expect(text).not.toContain(value)
    expect(await page.$('textarea')).toBeNull()
    expect(server.requests.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)))
      .toEqual([])
    server.setIdentity(fixtureSession({ oid: 'fixture-analyst' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => document.body.textContent?.includes('does not exist'))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Legacy notebook')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('analyst creates and synthesises, exports independently and cancels notes and late synthesis on revocation', async () => {
  const management = {
    askStructured: () =>
      Promise.resolve({
        object: {
          summary: 'Synthesis result [1]',
          supported: ['Recovery [1]'],
          contested: [],
          gaps: [],
        },
      }),
  } as unknown as BuildAppOptions['management']
  const server = startTestServer({ identity: { role: 'analyst' }, management })
  const id = await seed(server)
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/investigations`)
  try {
    await page.waitForSelector('#investigation-name')
    await fill(page, '#investigation-name', 'Created in browser')
    await click(page, 'Start investigation')
    await page.waitForFunction(() => document.body.textContent?.includes('Notebook'))
    expect(
      server.requests.some((r) =>
        r.method === 'POST' && r.path === '/api/t/marine/investigations' && r.status === 200
      ),
    ).toBe(true)
    await page.goto(`${server.url}/t/marine/investigations/${id}`)
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Research evidence supports stock recovery.')
    )
    await page.evaluate(() => {
      const clicks: string[] = []
      Object.assign(globalThis, { researchDownloads: clicks })
      const original = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) clicks.push(this.download)
        else original.call(this)
      }
    })
    await click(page, 'Synthesise the evidence')
    await page.waitForFunction(() => document.body.textContent?.includes('Synthesis result'))
    expect(server.requests.some((r) => r.path.endsWith('/synthesise') && r.status === 200)).toBe(
      true,
    )
    await click(page, 'Export to Word')
    await page.waitForFunction(() => document.body.textContent?.includes('Saved investigation-'))
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { researchDownloads: string[] }).researchDownloads.length
      ),
    ).toBe(1)
    const itemDelay = server.delayResponse(`/api/t/marine/investigations/${id}/synthesise`)
    await click(page, 'Synthesise the evidence')
    await itemDelay.entered
    await fill(page, 'textarea', 'Old item pending note')
    const itemPatches = server.requests.filter((r) => r.method === 'PATCH').length
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('a[href="/t/marine/investigations"]')!.click()
    )
    await page.waitForSelector('a[aria-label="Created in browser"]')
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('a[aria-label="Created in browser"]')!.click()
    )
    await page.waitForFunction(() =>
      document.querySelector('h1')?.textContent === 'Created in browser'
    )
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Synthesis result')
    expect(server.requests.filter((r) => r.method === 'PATCH').length).toBe(itemPatches)
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('a[href="/t/marine/investigations"]')!.click()
    )
    await page.waitForSelector('a[aria-label="Signed research"]')
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('a[aria-label="Signed research"]')!.click()
    )
    await page.waitForFunction(() =>
      document.querySelector('h1')?.textContent === 'Signed research'
    )
    // The server already saved the artefact before delaying its response. A new
    // authorised read may show it, but the obsolete callback must not refetch A.
    const itemReads = server.requests.filter((r) =>
      r.method === 'GET' && r.path === `/api/t/marine/investigations/${id}`
    ).length
    itemDelay.release()
    await page.evaluate(() =>
      new Promise((resolve) => setTimeout(resolve, 1600))
    )
    expect(
      server.requests.filter((r) =>
        r.method === 'GET' && r.path === `/api/t/marine/investigations/${id}`
      ).length,
    ).toBe(itemReads)
    expect(server.requests.filter((r) => r.method === 'PATCH').length).toBe(itemPatches)
    expect(await page.evaluate(() => document.querySelector('textarea')?.value)).not.toBe(
      'Old item pending note',
    )
    // Reduce only export in the real snapshot. Editing must remain available.
    await page.evaluate(() => {
      const original = fetch.bind(globalThis)
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (String(input) === '/auth/me?portal=marine') {
          const snapshot = await response.json()
          snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter((
            p: string,
          ) => p !== 'portal.export')
          return Response.json(snapshot)
        }
        return response
      }
      dispatchEvent(new Event('focus'))
    })
    await page.waitForSelector('textarea')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Synthesise the evidence') &&
      !document.body.textContent?.includes('Export to Word')
    )
    const delayed = server.delayResponse(`/api/t/marine/investigations/${id}/synthesise`)
    await click(page, 'Synthesise the evidence')
    await delayed.entered
    await fill(page, 'textarea', 'Late notebook content')
    const patches = server.requests.filter((r) => r.method === 'PATCH').length
    server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-analyst', 'viewer')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Signed research') && !document.querySelector('textarea')
    )
    delayed.release()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1600)))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Late notebook content',
    )
    expect(server.requests.filter((r) => r.method === 'PATCH').length).toBe(patches)
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { researchDownloads: string[] }).researchDownloads.length
      ),
    ).toBe(1)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('export helper checks before producer and browser sinks, aborts late work and revokes object URLs', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserRouter} from 'react-router-dom';
    import {AccessProvider,useAccess} from '${
      sourcePath('apps/web/src/components/AccessProvider.tsx')
    }';
    import {exportResearchFile,researchExportAuthority} from '${
      sourcePath('apps/web/src/lib/research-export.ts')
    }';
    let finish; let signal; let starts=0; let blobs=0; let urls=0; let clicks=0; let revoked=0; let outcome=''; let local=new AbortController();
    const OriginalBlob=Blob; globalThis.Blob=class extends OriginalBlob{constructor(...args){super(...args);blobs++}};
    const create=URL.createObjectURL; URL.createObjectURL=(blob)=>{urls++;return create(blob)};
    const revoke=URL.revokeObjectURL; URL.revokeObjectURL=(url)=>{revoked++;revoke(url)};
    HTMLAnchorElement.prototype.click=function(){clicks++};
    function Probe(){const access=useAccess(); globalThis.cancelExport=()=>local.abort(); globalThis.startExport=()=>{outcome='';local=new AbortController();return exportResearchFile({...researchExportAuthority(access.controller,'marine'),signal:local.signal},s=>{starts++;signal=s;return new Promise(r=>finish=()=>r({parts:['private file'],type:'text/plain',filename:'research.txt'}))}).then(()=>outcome='saved',()=>outcome='blocked')};globalThis.finishExport=()=>finish?.();globalThis.exportState=()=>({starts,blobs,urls,clicks,revoked,outcome,aborted:signal?.aborted});return <h1 data-ready={access.state.status}>Export fixture</h1>}
    createRoot(document.getElementById('root')).render(<BrowserRouter><AccessProvider slug='marine'><Probe/></AccessProvider></BrowserRouter>);`,
  })
  const server = startTestServer({ identity: { role: 'analyst' }, componentFixture: fixture })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    await page.waitForSelector('[data-ready=ready]')
    await page.evaluate(() => {
      void (globalThis as unknown as { startExport: () => Promise<void> }).startExport()
    })
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-ready=ready]')
    await page.evaluate(() =>
      (globalThis as unknown as { finishExport: () => void }).finishExport()
    )
    await page.waitForFunction(() =>
      (globalThis as unknown as { exportState: () => { outcome: string } }).exportState()
        .outcome === 'blocked'
    )
    const state = () =>
      page.evaluate(() =>
        (globalThis as unknown as {
          exportState: () => {
            starts: number
            blobs: number
            urls: number
            clicks: number
            revoked: number
            aborted: boolean
          }
        }).exportState()
      )
    expect(await state()).toMatchObject({
      starts: 1,
      blobs: 0,
      urls: 0,
      clicks: 0,
      revoked: 0,
      aborted: true,
    })
    await page.evaluate(() =>
      (globalThis as unknown as { startExport: () => Promise<void> }).startExport()
    )
    expect((await state()).starts).toBe(1)
    server.setIdentity(fixtureSession({ oid: 'fixture-analyst' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-ready=ready]')
    await page.evaluate(() => {
      void (globalThis as unknown as { startExport: () => Promise<void> }).startExport()
      ;(globalThis as unknown as { finishExport: () => void }).finishExport()
    })
    await page.waitForFunction(() =>
      (globalThis as unknown as { exportState: () => { outcome: string } }).exportState()
        .outcome === 'saved'
    )
    expect(await state()).toMatchObject({ starts: 2, blobs: 1, urls: 1, clicks: 1, revoked: 1 })
    await page.evaluate(() => {
      void (globalThis as unknown as { startExport: () => Promise<void> }).startExport()
      ;(globalThis as unknown as { cancelExport: () => void }).cancelExport()
      ;(globalThis as unknown as { finishExport: () => void }).finishExport()
    })
    await page.waitForFunction(() =>
      (globalThis as unknown as { exportState: () => { outcome: string } }).exportState()
        .outcome === 'blocked'
    )
    expect(await state()).toMatchObject({
      starts: 3,
      blobs: 1,
      urls: 1,
      clicks: 1,
      revoked: 1,
      aborted: true,
    })
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('investigation reader and editor fit theme tokens light dark wide and actual 390px', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const id = await seed(server)
  const browser = await launch()
  try {
    for (const role of ['analyst', 'viewer'] as const) {
      server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-analyst', role)
      for (const dark of [false, true]) {
        server.tenants.patchBranding('marine', {
          paletteId: dark ? 'observatory' : 'default',
          shape: dark ? 'soft' : 'square',
          density: 'comfortable',
          typography: 'lexend-zilla',
        })
        const page = await browser.newPage(server.url)
        try {
          await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
            args: [dark ? 'dark' : 'light'],
          })
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 960 })
            await page.goto(`${server.url}/t/marine/investigations`)
            await page.waitForSelector('a[aria-label="Signed research"]')
            await assertCurrentBuild(page)
            await captureBoundary(
              page,
              '.planning/logs/04-09-02',
              `${role}-list-${dark ? 'dark' : 'light'}-${width}`,
              width,
            )
            await page.goto(`${server.url}/t/marine/investigations/${id}`)
            await page.waitForFunction(() =>
              document.body.textContent?.includes('Research evidence supports stock recovery.')
            )
            await captureBoundary(
              page,
              '.planning/logs/04-09-02',
              `${role}-detail-${dark ? 'dark' : 'light'}-${width}`,
              width,
            )
            await page.evaluate(() => document.getElementById('evidence-list')?.scrollIntoView())
            await captureBoundary(
              page,
              '.planning/logs/04-09-02',
              `${role}-evidence-${dark ? 'dark' : 'light'}-${width}`,
              width,
            )
          }
        } finally {
          await page.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('viewer investigation list has reads without creation controls', async () => {
  const server = startTestServer({ identity: { role: 'viewer' } })
  const browser = await launch()
  const page: Page = await browser.newPage(`${server.url}/t/marine/investigations`)
  try {
    await page.waitForSelector('h1')
    await page.waitForFunction(() => document.body.textContent?.includes('No investigations yet'))
    expect(await page.$('#investigation-name')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
