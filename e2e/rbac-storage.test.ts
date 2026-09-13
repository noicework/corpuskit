import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary,
  sourcePath,
} from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(label) || b.getAttribute('aria-label') === label
    )
    if (!button) throw new Error(`Missing button ${label}`)
    button.click()
  }, { args: [label] })
}

Deno.test('Ask legacy anonymous history never enters signed identities, portal switches or delayed saves', async () => {
  const server = startTestServer()
  const browser = await launch()
  const page = await browser.newPage(server.url)
  try {
    await page.evaluate(() => {
      localStorage.setItem('rp-client-id', 'legacy-browser')
      localStorage.setItem(
        'rp-chat-marine',
        JSON.stringify([{
          id: 'legacy',
          title: 'Legacy anonymous trail',
          createdAt: 1,
          updatedAt: 1,
          messages: [{
            id: 'answer',
            author: 'AGENT',
            text: 'Legacy anonymous answer',
            sources: [],
            citations: [],
          }],
        }]),
      )
      localStorage.setItem(
        'rp-current-investigation-marine',
        JSON.stringify({ id: 'legacy', name: 'Legacy investigation name' }),
      )
    })
    await page.goto(`${server.url}/t/marine/ask`)
    await page.waitForFunction(() => document.body.textContent?.includes('Legacy anonymous trail'))
    await click(page, 'Legacy anonymous trail')
    await page.waitForFunction(() => document.body.textContent?.includes('Legacy anonymous answer'))
    await assertCurrentBuild(page)
    server.setIdentity(fixtureSession({ oid: 'fixture-analyst' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('textarea')
    await page.waitForFunction(() => !document.body.textContent?.includes('Legacy anonymous trail'))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Legacy anonymous answer',
    )
    await page.evaluate(() => {
      const input = document.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Signed transient question',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(page, 'Send')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Signed transient question')
    )
    const delayed = server.delayResponse('/api/t/marine/sessions')
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await delayed.entered
    server.setIdentity(fixtureSession({ oid: 'fixture-analyst' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    delayed.release()
    await page.waitForSelector('textarea')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1600)))
    expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain(
      'Signed transient question',
    )
    expect(server.requests.filter((r) => r.method === 'PUT' && r.path.includes('/sessions/')))
      .toEqual([])
    expect(
      await page.evaluate(() =>
        Object.values(localStorage).filter((s) => s.includes('Legacy anonymous')).length
      ),
    ).toBe(1)
    const other = server.tenants.add({ name: 'Other research' }).slug
    await page.goto(`${server.url}/t/${other}/ask`)
    await page.waitForSelector('textarea')
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('Legacy anonymous')
    server.setIdentity(null)
    await page.goto(`${server.url}/t/marine/ask`)
    await page.waitForFunction(() => document.body.textContent?.includes('Legacy anonymous trail'))
    expect(await page.evaluate(() => localStorage.getItem('rp-client-id'))).toBe('legacy-browser')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('shared save controls gate mutations, clear late saves and preserve identity-scoped selection reads', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
    import { BrowserRouter } from 'react-router-dom'; import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AccessProvider, useAccess } from '${
      sourcePath('apps/web/src/components/AccessProvider.tsx')
    }';
    import { SaveEvidenceButton, MakeCurrentToggle, useCurrentInvestigation } from '${
      sourcePath('apps/web/src/components/SaveEvidence.tsx')
    }';
    function Probe(){ const access=useAccess(); const current=useCurrentInvestigation('marine'); return <main><h1>Research selection</h1><p data-current>{current?.name ?? 'No selection'}</p><p data-ready>{access.state.status}</p><MakeCurrentToggle slug="marine" investigation={{id:'test',name:'Signed selection'}}/><SaveEvidenceButton slug="marine" evidence={{resourceId:'res-1',text:'Evidence text',title:'Evidence'}}/></main> }
    createRoot(document.getElementById('root')).render(<BrowserRouter><AccessProvider slug="marine"><Probe/></AccessProvider></BrowserRouter>);`,
  })
  const server = startTestServer({ componentFixture: fixture })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    await page.waitForFunction(() =>
      document.querySelector('[data-ready]')?.textContent === 'ready'
    )
    await page.evaluate(() => {
      localStorage.setItem(
        'rp-current-investigation-marine',
        JSON.stringify({ id: 'legacy', name: 'Legacy private selection' }),
      )
      dispatchEvent(new Event('storage'))
    })
    await page.waitForFunction(() =>
      document.querySelector('[data-current]')?.textContent === 'Legacy private selection'
    )
    expect(await page.$('button')).toBeNull()
    server.setIdentity(fixtureSession({ oid: 'fixture-analyst' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('button')
    expect(await page.evaluate(() => document.querySelector('[data-current]')?.textContent)).toBe(
      'No selection',
    )
    await click(page, 'Make current')
    await page.waitForFunction(() =>
      document.querySelector('[data-current]')?.textContent === 'Signed selection'
    )
    expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain(
      'Signed selection',
    )
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.querySelector('[data-current]')?.textContent === 'No selection'
    )
    expect(await page.$('button')).toBeNull()
    server.setIdentity(fixtureSession({ oid: 'fixture-analyst' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('button')
    await click(page, 'Save')
    await page.waitForSelector('input')
    await page.evaluate(() => {
      const input = document.querySelector('input')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Delayed private name',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const delayed = server.delayResponse('/api/t/marine/investigations')
    await click(page, 'Create')
    await delayed.entered
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.querySelector('[data-ready]')?.textContent === 'ready' &&
      !document.querySelector('button')
    )
    delayed.release()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)))
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'Delayed private name',
    )
    expect(server.requests.filter((r) => r.path.endsWith('/evidence'))).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('Ask signed research renders within theme tokens at wide and actual 390px', async () => {
  const server = startTestServer({ identity: { role: 'analyst' } })
  const browser = await launch()
  try {
    for (const dark of [false, true]) {
      server.tenants.patchBranding('marine', {
        paletteId: dark ? 'observatory' : 'default',
        shape: dark ? 'soft' : 'square',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      const page = await browser.newPage(`${server.url}/t/marine/ask`)
      try {
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [dark ? 'dark' : 'light'],
        })
        await page.goto(`${server.url}/t/marine/ask`)
        await page.waitForSelector('textarea')
        await assertCurrentBuild(page)
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-09-01',
            `ask-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
          await page.goto(`${server.url}/t/marine/library/res-1`)
          await page.waitForSelector('button[aria-label="Save to investigation"]')
          await click(page, 'Save to investigation')
          await page.waitForSelector('[role="dialog"]')
          await captureBoundary(
            page,
            '.planning/logs/04-09-01',
            `save-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
          await page.goto(`${server.url}/t/marine/ask`)
          await page.waitForSelector('textarea')
        }
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})
