import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startAgentStub } from './support/agent-stub-server.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'

const review = '.review/mcp-federated'
const rpc = (method: string, params: unknown, key: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})
async function click(page: Page, text: string) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((element) => element.textContent?.trim() === text)
    if (!button) throw new Error(`Missing button ${text}`)
    button.click()
  }, { args: [text] })
}
async function capture(page: Page, name: string, width: number, scheme: string, textSize = 100) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.evaluate(async (name, textSize, width) => {
    document.documentElement.style.fontSize = `${16 * textSize / 100}px`
    await document.fonts.ready
    const anchor = name === 'keys-coverage'
      ? '[data-estate-review-row]'
      : width === 390 || textSize === 200
      ? '[data-key-form] fieldset fieldset legend'
      : '#access-keys'
    const top = document.querySelector(anchor)!.getBoundingClientRect().top + scrollY
    const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 80
    scrollTo({ top: top - header - 24, behavior: 'instant' })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }, { args: [name, textSize, width] })
  expect(await page.evaluate(() => innerWidth)).toBe(width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1)
  const suffix = textSize === 100 ? '' : '-200-text'
  await Deno.mkdir(review, { recursive: true })
  await Deno.writeFile(`${review}/${name}${suffix}-${width}-${scheme}.png`, await page.screenshot())
}

Deno.test('Manage issues an estate key, an external agent uses federated tools, and revocation ends access', async () => {
  const server = await startAgentStub({ speed: 0, identity: { role: 'portal-admin' } })
  const creator = fixtureSession({ oid: 'e2e-portal-admin', roles: [] })
  server.setAssignment({ kind: 'portal', slug: 'grains' }, creator.oid, 'portal-admin')
  const browser = await launch(), page = await browser.newPage()
  try {
    await page.goto(`${server.url}/t/marine/manage?tab=access#access-keys`)
    await page.waitForSelector('[data-key-portal="grains"]')
    await assertCurrentBuild(page)
    expect(await page.$$('[data-key-portal]')).toHaveLength(1)
    // The third stub portal is public, but this administrator cannot manage it.
    expect(await page.$(`[data-key-portal="${server.portals[2]!.slug}"]`)).toBeNull()
    await page.evaluate(() =>
      document.querySelector<HTMLInputElement>('[data-key-portal="grains"]')!.focus()
    )
    await page.keyboard.press('Space')
    await page.waitForFunction(() =>
      document.querySelector<HTMLInputElement>('[data-key-portal="grains"]')!.checked
    )
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not
      .toBe('none')
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: 'soft',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/manage?tab=access&review=form-${scheme}#access-keys`)
      await page.waitForSelector('[data-key-portal="grains"]')
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('[data-key-portal="grains"]')!.click()
      )
      for (const width of [1440, 390]) await capture(page, 'keys-form', width, scheme)
      if (scheme === 'dark') {
        await capture(page, 'keys-form', 390, scheme, 200)
        await capture(page, 'keys-form', 1440, scheme, 200)
        await page.setViewportSize({ width: 320, height: 844 })
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '16px'
          const panel = document.querySelector<HTMLElement>('[data-keys-panel]')!
          panel.style.lineHeight = '1.5'
          panel.style.letterSpacing = '0.12em'
          panel.style.wordSpacing = '0.16em'
        })
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
          .toBeLessThanOrEqual(1)
        await page.evaluate(() =>
          document.querySelector<HTMLElement>('[data-keys-panel]')!.removeAttribute('style')
        )
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '16px'
      const label = document.querySelector<HTMLInputElement>('[data-key-label]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        label,
        'Federated estate agent',
      )
      label.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(page, 'Create key')
    await page.waitForSelector('[data-key-secret]')
    const key = await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>('[data-key-secret]')!.value
    )
    expect(key).toMatch(/^ck_[A-Za-z0-9_-]{43}$/)
    await click(page, 'Close key')
    await page.waitForFunction(() => !document.querySelector('[data-one-time-key]'))
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-key-id]')].some((row) =>
        row.textContent?.includes('Federated estate agent')
      )
    )
    const id = await page.evaluate(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-key-id]')]
        .find((row) => row.textContent?.includes('Federated estate agent'))!
      row.setAttribute('data-estate-review-row', '')
      return row.dataset.keyId!
    })
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-estate-review-row] [data-key-coverage]')!.textContent
      ),
    ).toContain('marine, grains')
    expect(
      await page.evaluate((key) =>
        !JSON.stringify([localStorage, sessionStorage]).includes(key) &&
        !document.body.textContent?.includes(key), { args: [key] }),
    ).toBe(true)

    // The agent has only the issued bearer, with no browser session.
    server.setIdentity(null)
    const endpoint = `${server.url}/api/t/marine/mcp`
    const list = await fetch(endpoint, rpc('tools/list', undefined, key))
    expect(list.status).toBe(200)
    const tools = (await list.json()).result.tools.map((tool: { name: string }) => tool.name)
    expect(tools).toContain('ask_federated')
    expect(tools).toContain('search_federated')
    for (const name of ['search_federated', 'ask_federated']) {
      const query = 'How is warming changing pests? #compose'
      const response = await fetch(
        endpoint,
        rpc('tools/call', {
          name,
          arguments: name === 'ask_federated' ? { question: query } : { query },
        }, key),
      )
      expect(response.status).toBe(200)
      const result = (await response.json()).result
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent.failed_sources).toEqual([])
      const entries = result.structuredContent.citations ?? result.structuredContent.results
      expect(new Set(entries.map((entry: { source: { id: string } }) => entry.source.id)))
        .toEqual(new Set(['marine', 'peer:soil-partner', 'peer:water-partner']))
      if (name === 'ask_federated') {
        expect(result.structuredContent.answer.length).toBeGreaterThan(0)
      }
    }
    const estate = await fetch(
      `${server.url}/api/estate/mcp`,
      rpc('tools/call', {
        name: 'search_estate',
        arguments: { query: 'Warming pests' },
      }, key),
    )
    expect(estate.status).toBe(200)
    expect(
      (await estate.json()).result.structuredContent.portals.map((p: { portal: string }) =>
        p.portal
      ).sort(),
    ).toEqual(['grains', 'marine'])
    const partial = await fetch(
      endpoint,
      rpc('tools/call', {
        name: 'ask_federated',
        arguments: { question: 'Warming pests #compose #peer-unauthorised' },
      }, key),
    )
    expect((await partial.json()).result.structuredContent.failed_sources).toMatchObject([
      { id: 'peer:water-partner', reason: 'unauthorised' },
    ])

    server.setIdentity(creator)
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(
        `${server.url}/t/marine/manage?tab=access&review=coverage-${scheme}#access-keys`,
      )
      await page.waitForSelector(`[data-key-id="${id}"]`)
      await page.evaluate(
        (id) =>
          document.querySelector(`[data-key-id="${id}"]`)!.setAttribute(
            'data-estate-review-row',
            '',
          ),
        { args: [id] },
      )
      for (const width of [1440, 390]) await capture(page, 'keys-coverage', width, scheme)
    }
    await page.evaluate(
      (id) => document.querySelector<HTMLButtonElement>(`[data-key-id="${id}"] button`)!.click(),
      { args: [id] },
    )
    await page.waitForSelector('dialog')
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) =>
        b.textContent?.trim() === 'Revoke key'
      )!.click()
    )
    await page.waitForFunction(() => !document.querySelector('dialog'))
    await page.waitForFunction(
      (id) => document.querySelector(`[data-key-id="${id}"]`)!.textContent?.includes('Revoked'),
      { args: [id] },
    )
    server.setIdentity(null)
    for (const url of [endpoint, `${server.url}/api/estate/mcp`]) {
      const revoked = await fetch(url, rpc('tools/list', undefined, key))
      expect(revoked.status).toBe(401)
      await revoked.body?.cancel()
    }
    server.setIdentity(creator)
    server.tenants.patch('marine', {
      languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
    })
    await page.goto(`${server.url}/t/marine/manage?tab=access&review=japanese#access-keys`)
    await page.waitForSelector('[data-key-portal="grains"]')
    expect(await page.evaluate(() => document.querySelector('[data-key-form] legend')!.textContent))
      .toBe('対象ポータル')
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
