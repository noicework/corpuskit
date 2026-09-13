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

const logs = Deno.env.get('RBAC_KEYS_LOG_ROOT') ?? '.planning/logs/04-15-01'

Deno.test('reader Tools supports public keyless MCP and exact permission links without key reads', async () => {
  const server = startTestServer()
  const browser = await launch(), page = await browser.newPage(`${server.url}/t/marine/tools`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-tools-page]')
    await assertCurrentBuild(page)
    expect(await page.$('[data-manage-keys-link]')).toBeNull()
    expect(await page.$('#extraction-lab-heading')).toBeNull()
    expect(
      await page.evaluate(() => document.querySelector('[data-mcp-configuration]')!.textContent),
    ).not.toContain('Authorization')
    const mcp = await page.evaluate(async () => {
      const response = await fetch('/api/t/marine/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      const body = await response.json()
      return { status: response.status, tools: body.result?.tools?.length }
    })
    expect(mcp.status).toBe(200)
    expect(mcp.tools).toBeGreaterThan(0)
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/tools`)
      await page.waitForSelector('[data-tools-page]')
      for (const width of [1440, 390]) {
        await capture(page, `tools-reader-${scheme}-${width}`, width, '#connector-heading')
      }
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.resolve() },
        })
      )
      await click(page, 'Copy connection details')
      await page.waitForFunction(() =>
        document.querySelector('[data-tools-page] [role=status]')?.textContent ===
          'Connection details copied.'
      )
    }
    expect(server.requests.some((r) => r.path.includes('/mcp/keys'))).toBe(false)
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.goto(`${server.url}/t/marine/tools`)
    await page.waitForSelector('[data-tools-page]')
    await page.evaluate(() => {
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (!String(input).startsWith('/auth/me')) return response
        const snapshot = await response.json()
        snapshot.user.isAdmin = true
        snapshot.coarseAdminEligible = true
        return Response.json(snapshot)
      }
      dispatchEvent(new Event('focus'))
    })
    await page.waitForSelector('[data-tools-page]')
    expect(await page.$('[data-manage-keys-link]')).toBeNull()
    expect(await page.$('#extraction-lab-heading')).toBeNull()
    server.setIdentity(fixtureSession({ oid: 'fixture-curator' }))
    await page.goto(`${server.url}/t/marine/tools`)
    await page.waitForSelector('#extraction-lab-heading')
    expect(await page.$('[data-manage-keys-link]')).toBeNull()
    for (const mode of ['authenticated', 'restricted'] as const) {
      server.setAccessMode('marine', mode)
      await page.goto(`${server.url}/t/marine/tools`)
      await page.waitForSelector('[data-tools-page]')
      expect(await page.evaluate(() => document.querySelector('[data-mcp-guidance]')!.textContent))
        .toContain('authorised session')
      expect(
        await page.evaluate(() => document.querySelector('[data-mcp-configuration]')!.textContent),
      ).toContain('YOUR_KEY')
    }
    expect(server.requests.some((r) => r.path.includes('/mcp/keys'))).toBe(false)
    server.setIdentity(fixtureSession({ oid: 'fixture-portal-admin' }))
    await page.goto(`${server.url}/t/marine/tools`)
    await page.waitForSelector('[data-manage-keys-link]')
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/tools`)
      await page.waitForSelector('[data-manage-keys-link]')
      for (const width of [1440, 390]) {
        await capture(page, `tools-manager-${scheme}-${width}`, width, '#connector-heading')
        await capture(page, `tools-actions-${scheme}-${width}`, width, '[data-manage-keys-link]')
        await capture(page, `tools-extraction-${scheme}-${width}`, width, '#extraction-lab-heading')
      }
    }
    expect(server.requests.some((r) => r.path.includes('/mcp/keys'))).toBe(false)
    await click(page, 'Manage portal keys', 'a')
    await page.waitForSelector('[data-keys-panel]')
    await page.waitForFunction(() => document.activeElement?.id === 'access-keys')
    expect(await page.evaluate(() => location.pathname + location.search + location.hash)).toBe(
      '/t/marine/manage?tab=access#access-keys',
    )
    expect(
      await page.evaluate(() => {
        const rect = document.getElementById('access-keys')!.getBoundingClientRect()
        return rect.top >= 0 && rect.top < innerHeight
      }),
    ).toBe(true)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
async function click(page: Page, text: string, selector = 'button') {
  await page.evaluate((text, selector) => {
    const button = [...document.querySelectorAll<HTMLElement>(selector)].find((b) =>
      b.textContent?.trim() === text
    )
    if (!button) throw new Error(`Missing button ${text}`)
    button.focus()
    button.click()
  }, { args: [text, selector] })
}
async function input(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const element = document.querySelector(selector) as HTMLInputElement
    const proto = element.tagName === 'SELECT'
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    )
  }, { args: [selector, value] })
}
async function capture(page: Page, name: string, width: number, selector: string) {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async (selector) => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
    document.querySelector(selector)!.scrollIntoView({ block: 'center' })
    const secret = document.querySelector<HTMLTextAreaElement>('[data-key-secret]')
    if (secret) {
      secret.style.visibility = 'hidden'
      secret.value = '[Redacted for visual verification]'
    }
  }, { args: [selector] })
  expect(
    await page.evaluate(() =>
      !document.querySelector<HTMLTextAreaElement>('[data-key-secret]') ||
      getComputedStyle(document.querySelector('[data-key-secret]')!).visibility === 'hidden'
    ),
  ).toBe(true)
  await captureBoundary(page, logs, name, width)
  if (name.startsWith('tools-')) {
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-tools-page] .rp-btn')].every((element) =>
          element.scrollHeight <= element.clientHeight + 1
        )
      ),
    ).toBe(true)
  }
  expect(
    await page.evaluate((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect()
      return rect.top >= 0 && rect.top < innerHeight
    }, { args: [selector] }),
  ).toBe(true)
}
async function fakeCreation(page: Page) {
  await page.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      if (String(input).endsWith('/mcp/keys') && init?.method === 'POST' && response.ok) {
        const body = await response.json()
        body.key = 'ck_' + 'z'.repeat(43)
        body.credential.prefix = body.key.slice(0, 15)
        return Response.json(body, { status: 201 })
      }
      return response
    }
  })
}
async function noPersistence(page: Page) {
  expect(
    await page.evaluate(() => {
      const secret = 'ck_' + 'z'.repeat(43)
      return !location.href.includes(secret) && !JSON.stringify(localStorage).includes(secret) &&
        !JSON.stringify(sessionStorage).includes(secret)
    }),
  ).toBe(true)
}

Deno.test('signed Access keys create once, show safe status, revoke and contain focus across appearance variants', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' }, keyScenarios: true })
  const browser = await launch(),
    page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-key-id]')
    await assertCurrentBuild(page)
    const text = await page.evaluate(() => document.querySelector('[data-keys-panel]')!.textContent)
    expect(text).toContain('legacy, viewer, cannot be upgraded')
    expect(text).toContain('The creator must sign in again')
    expect(text).toContain('creator no longer has access')
    expect(text).toContain('Effective role: Analyst')
    expect(await page.$('[data-key-id="fixture-key-2"] button')).toBeNull()
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLSelectElement>('[data-key-role]')!.value
      ),
    ).toBe('viewer')
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/manage?tab=access`)
      await page.bringToFront()
      await page.waitForSelector('[data-key-id]')
      await fakeCreation(page)
      for (const width of [1440, 390]) {
        await capture(page, `keys-form-${scheme}-${width}`, width, '#access-keys')
        await capture(page, `keys-fields-${scheme}-${width}`, width, '[data-key-role]')
        await capture(
          page,
          `keys-status-${scheme}-${width}`,
          width,
          '[data-key-id="fixture-reason-0"]',
        )
      }
      await input(page, '[data-key-label]', `Desktop ${scheme}`)
      await input(page, '[data-key-expiry]', '2000-01-01T12:00')
      await click(page, 'Create key')
      await page.waitForSelector('[data-keys-panel] [role=alert]')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `expiry-error-${scheme}-${width}`,
          width,
          '[data-keys-panel] [role=alert]',
        )
      }
      await input(page, '[data-key-expiry]', '')
      await click(page, 'Create key')
      await page.waitForSelector('[data-one-time-key]')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Close key')
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error('unavailable')) },
        })
      )
      await click(page, 'Copy key')
      await page.waitForFunction(() =>
        document.querySelector('[data-one-time-key] [role=status]')?.textContent?.includes(
          'Select the key',
        )
      )
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.resolve() },
        })
      )
      await click(page, 'Copy key')
      await page.waitForFunction(() =>
        document.querySelector('[data-one-time-key] [role=status]')?.textContent === 'Key copied'
      )
      await noPersistence(page)
      for (const width of [1440, 390]) {
        await capture(page, `one-time-redacted-${scheme}-${width}`, width, '[data-one-time-key] h2')
      }
      await click(page, 'Close key')
      await page.waitForFunction(() => !document.querySelector('[data-one-time-key]'))
      await page.waitForFunction(() => document.activeElement !== document.body)
      expect(await page.evaluate(() => document.body.textContent?.includes('ck_' + 'z'.repeat(43))))
        .toBe(false)
      await click(page, 'Refresh key list')
      await page.waitForFunction(() => !document.querySelector('[data-one-time-key]'))
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>('[data-key-id="fixture-key-0"] button')!.click()
      )
      await page.waitForSelector('dialog')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Keep key')
      await page.keyboard.down('Shift')
      await page.keyboard.press('Tab')
      await page.keyboard.up('Shift')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Revoke key')
      for (const width of [1440, 390]) {
        await capture(page, `revoke-${scheme}-${width}`, width, 'dialog h2')
      }
      await page.keyboard.press('Escape')
    }
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[data-key-id="fixture-key-0"] button')!.click()
    )
    await click(page, 'Revoke key', 'dialog button')
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Key revoked.') &&
      !document.querySelector('[data-key-id="fixture-key-0"] button')
    )
    await page.waitForFunction(() => document.activeElement !== document.body)
    expect(server.requests.filter((r) => r.path.includes('/mcp/keys') && r.method === 'POST'))
      .toHaveLength(2)
    expect(server.requests.filter((r) => r.path.includes('/mcp/keys') && r.method === 'DELETE'))
      .toHaveLength(1)
    expect(
      server.requests.filter((r) => r.path.includes('/mcp/keys')).every((r) =>
        r.status === 200 || r.status === 201
      ),
    ).toBe(true)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

const componentSource = `
import {StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Link} from 'react-router-dom';import {useQueryClient} from '@tanstack/react-query';
import {AccessProvider,useAccess} from '${
  sourcePath('apps/web/src/components/AccessProvider.tsx')
}';import {KeysPanel} from '${sourcePath('apps/web/src/pages/admin/KeysPanel.tsx')}';
function Fixture(){const access=useAccess(),client=useQueryClient();globalThis.keyCacheSafe=()=>!JSON.stringify([client.getQueryCache().getAll().map(q=>q.state),client.getMutationCache().getAll().map(m=>m.state)]).includes('ck_'+'z'.repeat(43));return <main className='rp-tenant rp-shell'><h1>Key lifecycle fixture</h1><Link to='?next'>Change view</Link><button onClick={()=>access.refresh()}>Refresh access</button>{access.state.status==='ready'&&<KeysPanel slug='marine'/>}</main>};createRoot(document.getElementById('root')).render(<StrictMode><BrowserRouter><AccessProvider slug='marine'><Fixture/></AccessProvider></BrowserRouter></StrictMode>)`
Deno.test('one-time key never enters caches and late creation is discarded after navigation or identity loss', async () => {
  const fixture = await buildComponentFixture({ entrySource: componentSource })
  const server = startTestServer({ identity: { role: 'portal-admin' }, componentFixture: fixture })
  const browser = await launch(),
    page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-key-id]')
    await fakeCreation(page)
    await input(page, '[data-key-label]', 'Cache test')
    await click(page, 'Create key')
    await page.waitForSelector('[data-one-time-key]')
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { keyCacheSafe(): boolean }).keyCacheSafe()
      ),
    ).toBe(true)
    await noPersistence(page)
    await click(page, 'Close key')
    await input(page, '[data-key-label]', 'Late result')
    const delay = server.delayResponse('/api/t/marine/mcp/keys')
    await click(page, 'Create key')
    await delay.entered
    await click(page, 'Change view', 'a')
    delay.release()
    await page.waitForFunction(() =>
      !!document.querySelector('[data-key-id]') && !document.querySelector('fieldset:disabled')
    )
    expect(await page.$('[data-one-time-key]')).toBeNull()
    await input(page, '[data-key-label]', 'Access loss')
    await click(page, 'Create key')
    await page.waitForSelector('[data-one-time-key]')
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('[data-keys-panel]'))
    expect(await page.$('[data-one-time-key]')).toBeNull()
    await noPersistence(page)
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as { keyCacheSafe(): boolean }).keyCacheSafe()
      ),
    ).toBe(true)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('uncertain creation requires explicit list refresh and never retries automatically', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch(),
    page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-key-id]')
    await page.evaluate(() => {
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        return String(input).endsWith('/mcp/keys') && init?.method === 'POST'
          ? Response.json({ message: 'private error body' }, { status: 500 })
          : response
      }
    })
    await input(page, '[data-key-label]', 'Uncertain client')
    await click(page, 'Create key')
    await page.waitForSelector('[data-keys-panel] [role=alert]')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLFieldSetElement>('[data-key-form] fieldset')!.disabled
      ),
    ).toBe(true)
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('private error body')
    await click(page, 'Refresh key list')
    await page.waitForFunction(() =>
      !document.querySelector<HTMLFieldSetElement>('[data-key-form] fieldset')!.disabled
    )
    expect(server.requests.filter((r) => r.method === 'POST' && r.path.includes('/mcp/keys')))
      .toHaveLength(1)
    expect(await page.$('[data-one-time-key]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
