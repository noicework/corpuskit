import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { AragProvider } from '@research-portal/retrieval'
import type { TenantConfig } from '@research-portal/core'
import { startTestServer, type TestServer } from './support/test-server.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import { settle } from './support/settle.ts'

class LabelDouble extends DoubleProvider {
  async counters() {
    return { resources: this.resources.length, paragraphs: 4, fields: 2, sentences: 8 }
  }
  async recentResources() {
    return this.resources.map(({ id, title }) => ({ id, title, status: 'processed' as const }))
  }

  async setResourceFederationExcluded(_config: TenantConfig, id: string, excluded: boolean) {
    this.resources = this.resources.map((resource) => {
      if (resource.id !== id) return resource
      const { federationExcluded: _excluded, ...rest } = resource
      return { ...rest, ...(excluded ? { federationExcluded: true as const } : {}) }
    })
    return true
  }
}
function server(role: 'viewer' | 'curator' | 'portal-admin') {
  const provider = new LabelDouble()
  return startTestServer({
    identity: { role, slug: 'marine' },
    provider,
    management: provider as unknown as AragProvider,
  })
}
async function input(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
    Object.getOwnPropertyDescriptor(
      el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }, { args: [selector, value] })
}
async function click(page: Page, text: string) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) =>
      el.textContent?.trim() === text && el.getBoundingClientRect().width > 0 && !el.disabled
    )
    if (!button) throw new Error(`Missing enabled button: ${text}`)
    button.scrollIntoView({ block: 'center' })
    button.focus()
  }, { args: [text] })
  await page.keyboard.press('Enter')
}
async function expectFocus(page: Page, label: string) {
  try {
    await page.waitForFunction((label) => {
      const active = document.activeElement
      return (active?.getAttribute('aria-label') ?? active?.textContent?.trim()) === label
    }, { args: [label] })
  } catch (error) {
    const actual = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
      text: document.activeElement?.textContent?.trim().slice(0, 80),
      editor: !!document.querySelector('[data-peer-editor]'),
    }))
    throw new Error(`Expected focus on ${label}: ${JSON.stringify(actual)}`, { cause: error })
  }
}
async function saved(page: Page, message: string) {
  await page.waitForFunction(
    (message) =>
      document.querySelector('[data-federation-panel] [role=status]')?.textContent === message,
    { args: [message] },
  )
}
async function screenshot(
  page: Page,
  name: string,
  width: number,
  scheme: string,
  target = '[data-federation-panel]',
) {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
  await page.evaluate(
    (target) => document.querySelector(target)?.scrollIntoView({ block: 'start' }),
    { args: [target] },
  )
  await settle(page, target)
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }))
  expect(metrics.width).toBe(width)
  expect(metrics.overflow).toBeLessThanOrEqual(1)
  await Deno.mkdir('.review/manage-federation', { recursive: true })
  await Deno.writeFile(
    `.review/manage-federation/${name}-${width}-${scheme}.png`,
    await page.screenshot({ captureBeyondViewport: false }),
  )
}
async function visuals(page: Page, testServer: TestServer) {
  for (const scheme of ['light', 'dark']) {
    testServer.tenants.patchBranding('marine', {
      paletteId: scheme === 'dark' ? 'observatory' : 'default',
      shape: 'soft',
      density: 'spacious',
      typography: 'lexend-zilla',
    })
    await page.goto(`${testServer.url}/t/marine/manage?tab=federation`)
    await page.waitForSelector('[data-federation-history]')
    await page.waitForFunction(() =>
      document.querySelector('[data-peer-key-status]')?.textContent === 'Key saved'
    )
    for (const width of [1440, 390]) {
      await screenshot(page, 'federation', width, scheme)
      await screenshot(page, 'partners', width, scheme, '[data-federation-peer]')
      await screenshot(page, 'exclusions', width, scheme, '[data-federation-exclusions]')
      await screenshot(page, 'history', width, scheme, '[data-federation-history]')
      await click(page, 'Add partner')
      await screenshot(page, 'partner-form', width, scheme, '[data-peer-editor]')
      await click(page, 'Cancel')
      await expectFocus(page, 'Add partner')
      await click(page, 'Edit')
      await expectFocus(page, 'Collection name')
      await screenshot(page, 'partner-edit', width, scheme, '[data-peer-editor]')
      await click(page, 'Cancel')
      await expectFocus(page, 'Add partner')
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-federation-panel]')!
    panel.style.lineHeight = '1.5'
    panel.style.letterSpacing = '0.12em'
    panel.style.wordSpacing = '0.16em'
    for (const paragraph of panel.querySelectorAll('p')) paragraph.style.marginBottom = '2em'
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1)
  await page.evaluate(() => {
    document.querySelector('[data-federation-panel]')!.removeAttribute('style')
    for (const paragraph of document.querySelectorAll('[data-federation-panel] p')) {
      paragraph.removeAttribute('style')
    }
    document.documentElement.style.fontSize = '200%'
  })
  await screenshot(page, 'federation-text200', 1440, 'dark')
  await screenshot(page, 'partners-text200', 1440, 'dark', '[data-federation-peer]')
  await screenshot(page, 'exclusions-text200', 1440, 'dark', '[data-federation-exclusions]')
  await page.evaluate(() => {
    document.documentElement.style.fontSize = ''
  })
  await page.setViewportSize({ width: 320, height: 844 })
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll('*')].map((node) => ({
      tag: node.tagName,
      class: node.className,
      text: node.textContent?.slice(0, 70),
      right: node.getBoundingClientRect().right,
      width: node.getBoundingClientRect().width,
    })).filter((node) => node.right > innerWidth + 1 && node.width > 0).slice(0, 30),
  }))
  await Deno.writeTextFile(
    '.review/manage-federation/reflow.json',
    JSON.stringify(overflow, null, 2) + '\n',
  )
  expect(overflow.scroll - overflow.width).toBeLessThanOrEqual(1)
}
Deno.test('Manage federation: participation audit, peers, write-only key, document labels and responsive themes', async () => {
  const testServer = server('portal-admin')
  const browser = await launch()
  const page = await browser.newPage(`${testServer.url}/t/marine/manage?tab=federation`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-federation-history]')
    await assertCurrentBuild(page)
    expect(await page.$('[data-manage-tab=federation][aria-current=true]')).not.toBeNull()
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('[data-federation-participates]')!.focus()
    )
    expect(
      await page.evaluate(() =>
        getComputedStyle(
          document.querySelector('[data-federation-participates]')!.closest('label')!,
        ).boxShadow
      ),
    ).not.toBe('none')
    await page.keyboard.press('Space')
    await saved(page, 'Participation updated.')
    expect(testServer.tenants.get('marine')!.federation?.participates).toBe(false)
    expect(
      await page.evaluate(() => document.querySelector('[data-federation-history]')!.textContent),
    ).toContain('Participation: On to Off')
    const audit = await page.evaluate(async () =>
      (await fetch('/api/admin/t/marine/audit?action=tenant.behaviour.update&outcome=success'))
        .json()
    )
    const row = audit.items.find((row: { detail_json: string }) =>
      JSON.parse(row.detail_json).participates === false
    )
    expect(row.actor_id).toBe('e2e-portal-admin')
    expect(Number.isFinite(Date.parse(row.at))).toBe(true)
    expect(JSON.parse(row.detail_json)).toMatchObject({
      previousParticipates: true,
      participates: false,
    })
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('[data-federation-agent-ask]')!.focus()
    )
    await page.keyboard.press('Space')
    await saved(page, 'Agent ask updated.')
    expect(testServer.tenants.get('marine')!.agentAsk).toBe(true)
    await click(page, 'Add partner')
    await input(page, '[aria-label="Partner ID"]', 'soil-hub')
    await input(page, '[aria-label="Collection name"]', 'Soil Research Hub')
    await input(page, '[aria-label="Zone"]', 'test-zone')
    await input(page, '[aria-label="Knowledge box ID"]', 'soil-box')
    const supportedKinds = await page.evaluate(async () =>
      (await (await fetch('/api/admin/t/marine/federation')).json()).supportedKinds
    )
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLOptionElement>('[aria-label="Connection kind"] option')]
          .map((option) => option.value)
      ),
    ).toEqual(supportedKinds)
    await click(page, 'Save partner')
    await saved(page, 'Partner saved.')
    await expectFocus(page, 'Add partner')
    expect(await page.evaluate(() => document.querySelector('[data-peer-key-status]')!.textContent))
      .toBe('No key')
    const token = 'synthetic-partner-key-never-display-0000000'
    await input(page, 'input[name=token]', token)
    await click(page, 'Set key')
    await saved(page, 'Partner key saved.')
    expect(await page.evaluate(() => document.querySelector('[data-peer-key-status]')!.textContent))
      .toBe('Key saved')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('input[name=token]')!.value
      ),
    ).toBe('')
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(token)
    const snapshot = await page.evaluate(async () =>
      (await fetch('/api/admin/t/marine/federation')).text()
    )
    expect(snapshot).not.toContain(token)
    await input(page, '[aria-label="Document to exclude"]', 'res-1')
    await click(page, 'Exclude document')
    await saved(page, 'Document excluded.')
    await page.waitForSelector('[data-federation-excluded=res-1]')
    await visuals(page, testServer)
    await click(page, 'Remove exclusion')
    await saved(page, 'Document exclusion removed.')
    await expectFocus(page, 'Document to exclude')
    expect(await page.$('[data-federation-excluded]')).toBeNull()
    await click(page, 'Edit')
    await expectFocus(page, 'Collection name')
    await input(page, '[aria-label="Collection name"]', 'Soil Research Library')
    await click(page, 'Save partner')
    await saved(page, 'Partner saved.')
    expect(testServer.tenants.get('marine')!.federation!.peers![0]!.label).toBe(
      'Soil Research Library',
    )
    await click(page, 'Remove')
    await saved(page, 'Partner removed.')
    await expectFocus(page, 'Add partner')
    expect(testServer.tenants.get('marine')!.federation!.peers).toEqual([])
    expect(testServer.bindings.get('marine#peer:soil-hub')).toBeUndefined()
    const removedAudit = await page.evaluate(async () =>
      (await (await fetch(
        '/api/admin/t/marine/audit?action=tenant.behaviour.update&outcome=success',
      ))
        .json()).items
    )
    expect(
      removedAudit.some((row: { actor_id: string; detail_json: string }) =>
        row.actor_id === 'e2e-portal-admin' &&
        JSON.parse(row.detail_json).removedPeerIds === 'soil-hub'
      ),
    ).toBe(true)
    // Reusing the id through Manage must never restore the removed credential.
    await click(page, 'Add partner')
    await input(page, '[aria-label="Partner ID"]', 'soil-hub')
    await input(page, '[aria-label="Collection name"]', 'Soil Research Hub')
    await input(page, '[aria-label="Zone"]', 'test-zone')
    await input(page, '[aria-label="Knowledge box ID"]', 'soil-box')
    await click(page, 'Save partner')
    await saved(page, 'Partner saved.')
    expect(await page.evaluate(() => document.querySelector('[data-peer-key-status]')!.textContent))
      .toBe('No key')
    await input(page, 'input[name=token]', token)
    await click(page, 'Set key')
    await saved(page, 'Partner key saved.')
    // API clients use the same deletion path as Manage.
    const peer = testServer.tenants.get('marine')!.federation!.peers![0]!
    const results = await page.evaluate(async (peer) => {
      const patch = (peers: unknown[]) =>
        fetch('/api/admin/tenants/marine', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ federation: { peers } }),
        })
      return [(await patch([])).status, (await patch([peer])).status]
    }, { args: [peer] })
    expect(results).toEqual([200, 200])
    expect(testServer.bindings.get('marine#peer:soil-hub')).toBeUndefined()
    expect(Deno.readTextFileSync(`${testServer.directory}/bindings.json`))
      .not.toContain('marine#peer:soil-hub')
    await page.goto(`${testServer.url}/t/marine/manage?tab=federation`)
    await page.waitForFunction(() =>
      document.querySelector('[data-peer-key-status]')?.textContent === 'No key'
    )
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(token)
  } finally {
    await page.close()
    await browser.close()
    await testServer.close()
  }
})
Deno.test('Manage federation role matrix: viewer hidden, curator labels only, administrator controls', async () => {
  const browser = await launch()
  try {
    for (const role of ['viewer', 'curator', 'portal-admin'] as const) {
      const testServer = server(role)
      const page = await browser.newPage(`${testServer.url}/t/marine/manage?tab=federation`)
      try {
        await page.bringToFront()
        if (role === 'viewer') {
          await page.waitForFunction(() =>
            document.querySelector('[data-route-unavailable]') !== null
          )
          expect(await page.$('[data-manage-tab=federation]')).toBeNull()
          expect(testServer.requests.some((request) => request.path.includes('/federation'))).toBe(
            false,
          )
        } else {
          await page.waitForSelector('[data-federation-panel]')
          await page.waitForSelector('[aria-label="Document to exclude"]')
          expect(await page.$('[data-federation-participates]') !== null).toBe(
            role === 'portal-admin',
          )
          expect(await page.$('[data-federation-agent-ask]') !== null).toBe(role === 'portal-admin')
          expect(await page.$('[data-federation-history]') !== null).toBe(role === 'portal-admin')
          if (role === 'curator') {
            expect(await page.evaluate(() => document.body.textContent)).not.toContain(
              'Add partner',
            )
            expect(
              testServer.requests.some((request) =>
                request.path === '/api/admin/t/marine/federation'
              ),
            ).toBe(false)
            await input(page, '[aria-label="Document to exclude"]', 'res-1')
            await click(page, 'Exclude document')
            await saved(page, 'Document excluded.')
          }
        }
        const statuses = await page.evaluate(async () => ({
          read: (await fetch('/api/admin/t/marine/federation')).status,
          key: (await fetch('/api/admin/t/marine/federation/peers/absent/key', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'fixture-only' }),
          })).status,
          patch: (await fetch('/api/admin/tenants/marine', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ federation: { participates: true } }),
          })).status,
        }))
        expect(statuses.read).toBe(role === 'portal-admin' ? 200 : 403)
        expect(statuses.patch).toBe(role === 'portal-admin' ? 200 : 403)
        expect(statuses.key).toBe(role === 'portal-admin' ? 404 : 403)
      } finally {
        await page.close()
        await testServer.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('Manage federation discards keys and late settings when portal authority changes', async () => {
  const testServer = server('portal-admin')
  testServer.tenants.patch('marine', {
    federation: {
      peers: [{
        id: 'soil-hub',
        label: 'Soil Research Hub',
        kind: 'arag-kb',
        zone: 'test-zone',
        kbId: 'soil-box',
      }],
    },
  })
  const browser = await launch()
  const page = await browser.newPage(`${testServer.url}/t/marine/manage?tab=federation`)
  let held: ReturnType<TestServer['delayResponse']> | undefined
  try {
    await page.bringToFront()
    await page.waitForSelector('input[name=token]')
    await input(page, 'input[name=token]', 'synthetic-unsaved-key-must-be-cleared')
    testServer.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-portal-admin', 'curator')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() =>
      document.querySelector('[data-federation-panel]') !== null &&
      document.querySelector('input[name=token]') === null
    )
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(
      'synthetic-unsaved-key-must-be-cleared',
    )
    testServer.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-portal-admin', 'portal-admin')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('input[name=token]')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('input[name=token]')!.value
      ),
    ).toBe('')
    held = testServer.delayResponse('/api/admin/t/marine/federation')
    await page.goto(`${testServer.url}/t/marine/manage?tab=federation`)
    await held.entered
    testServer.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-portal-admin', 'viewer')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-route-unavailable]')
    held.release()
    await settle(page, '[data-route-unavailable]')
    expect(await page.$('[data-federation-peer]')).toBeNull()
    expect(await page.$('input[name=token]')).toBeNull()
  } finally {
    held?.release()
    await page.close()
    await browser.close()
    await testServer.close()
  }
})
