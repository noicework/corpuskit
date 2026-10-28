import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { SearchResultsSchema } from '@research-portal/core'
import { startAgentStub } from './support/agent-stub-server.ts'

const query = 'How is warming changing research? #peer-unauthorised'
const searchPath = `/t/marine/search?q=${encodeURIComponent(query)}&answer=0`
const sharedPath = `${searchPath}&federated=1`

async function ready(page: Page) {
  await page.waitForFunction(() =>
    document.querySelector('main [role="status"]')?.textContent?.includes('results shown') === true
  )
}

Deno.test('shared search over HTTP returns both partners, partial failures and only allowed origin links', async () => {
  const server = await startAgentStub({ speed: 0, apiOnly: true })
  try {
    const get = async (text: string) => {
      const response = await fetch(
        `${server.url}/api/t/marine/search?federated=1&q=${encodeURIComponent(text)}`,
      )
      expect(response.status).toBe(200)
      return SearchResultsSchema.parse(await response.json())
    }
    const all = await get('warming')
    expect(all.failedSources).toEqual([])
    expect(all.resources.slice(0, 3).map((r) => r.source?.id)).toEqual([
      'marine',
      'peer:soil-partner',
      'peer:water-partner',
    ])
    expect(all.resources.some((r) => r.peerUrl)).toBe(false)
    const failed = await get(query)
    expect(failed.failedSources).toMatchObject([{
      id: 'peer:water-partner',
      reason: 'unauthorised',
    }])
    expect(failed.resources.some((r) => r.source?.id === 'peer:soil-partner')).toBe(true)
    const timeout = await get('warming #peer-timeout')
    expect(timeout.failedSources).toMatchObject([{ id: 'peer:soil-partner', reason: 'timeout' }])
    expect(timeout.resources.some((r) => r.source?.id === 'peer:water-partner')).toBe(true)
    const config = server.tenants.get('marine')!
    server.tenants.patch('marine', {
      federation: {
        peers: config.federation!.peers!.map((peer) => ({ ...peer, linkOrigins: true })),
      },
    })
    const linked = await get('warming')
    expect(linked.resources.find((r) => r.peerUrl)?.peerUrl).toBe(
      'https://partner.example.org/soil/soil-01.pdf',
    )
    expect(JSON.stringify(linked)).not.toContain('stub-peer-key')
    expect(JSON.stringify(linked)).not.toContain('stub-box')
  } finally {
    await server.close()
  }
})

Deno.test('an all-failed shared search names every unavailable collection and avoids claiming there were no matches', async () => {
  const server = await startAgentStub({ speed: 0 })
  const browser = await launch()
  const shots = Deno.env.get('FEDERATED_SEARCH_SHOTS')
  server.provider.search = async () => {
    throw new Error('Synthetic host search failure')
  }
  const path = `/t/marine/search?federated=1&answer=0&q=${
    encodeURIComponent(`${query} #peer-timeout`)
  }`
  try {
    if (shots) await Deno.mkdir(shots, { recursive: true })
    const page = await browser.newPage(server.url)
    const branding = server.tenants.get('marine')!.branding
    for (const scheme of ['light', 'dark'] as const) {
      server.tenants.patchBranding('marine', {
        ...branding,
        paletteId: scheme === 'dark' ? 'observatory' : 'corpuskit',
        colourScheme: 'viewer',
        shape: 'soft',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      for (const width of [1440, 390]) {
        await page.unsafelyGetCelestialBindings().Emulation.setDeviceMetricsOverride({
          width,
          height: width === 1440 ? 900 : 844,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await page.goto(`${server.url}${path}`)
        await ready(page)
        const state = await page.evaluate(() => ({
          status: document.querySelector('main [role="status"]')?.textContent,
          text: document.querySelector('main')?.textContent,
          cards: document.querySelectorAll('article').length,
          scroll: document.documentElement.scrollWidth,
        }))
        expect(state.status).toContain('Southern Waters Research Portal could not be searched')
        expect(state.status).toContain('Soil partner collection could not be searched')
        expect(state.status).toContain('Water partner collection could not be searched')
        expect(state.text).toContain('No resources returned from these collections')
        expect(state.text).not.toContain('No resources matched that search')
        expect(state.cards).toBe(0)
        expect(state.scroll).toBeLessThanOrEqual(width)
        if (shots) {
          await Deno.writeFile(
            `${shots}/search-unavailable-${width}-${scheme}.png`,
            await page.screenshot({ captureBeyondViewport: false }),
          )
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('shared search switch, attribution, source filter and failure status work by keyboard without generating an answer', async () => {
  const server = await startAgentStub({ speed: 0 })
  const browser = await launch()
  try {
    const page = await browser.newPage(`${server.url}${searchPath}`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('button[role="switch"]')
    expect(
      await page.evaluate(() =>
        document.querySelector('[role="switch"]')?.getAttribute('aria-checked')
      ),
    ).toBe('false')
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[role="switch"]')!.focus())
    await page.keyboard.press('Space')
    await ready(page)
    const state = await page.evaluate(() => ({
      checked: document.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
      url: location.search,
      badges: [...document.querySelectorAll('article .rp-badge')].map((el) => el.textContent),
      status: document.querySelector('main [role="status"]')?.textContent,
      live: document.querySelector('main [role="status"]')?.getAttribute('aria-live'),
    }))
    expect(state.checked).toBe('true')
    expect(state.url).toContain('federated=1')
    expect(state.url).toContain('answer=0')
    expect(state.badges.some((badge) => badge?.includes('Soil partner collection'))).toBe(true)
    expect(state.badges.some((badge) => badge?.includes('Southern Waters'))).toBe(true)
    expect(state.status).toContain('Water partner collection could not be searched')
    expect(state.live).toBe('polite')
    const peerCard = await page.evaluate(() => {
      const card = [...document.querySelectorAll('article')].find((el) =>
        el.textContent?.includes('Soil moisture after warm winters')
      )!
      return {
        links: card.querySelectorAll('a').length,
        passage: card.querySelector('blockquote')?.textContent,
      }
    })
    expect(peerCard.links).toBe(0)
    expect(peerCard.passage).toContain('Warm, dry winters')
    const ax = await page.unsafelyGetCelestialBindings().Accessibility.getFullAXTree({})
    expect(
      ax.nodes.some((node) =>
        node.role?.value === 'switch' && node.name?.value === 'Include partner collections'
      ),
    ).toBe(true)
    expect(ax.nodes.some((node) => node.role?.value === 'status')).toBe(true)
    const searchesBefore = server.requests.filter((r) => r.path.includes('/search')).length
    await page.evaluate(() => document.querySelector<HTMLSelectElement>('#search-source')!.focus())
    await page.keyboard.type('Soil')
    await page.keyboard.press('Tab')
    await page.waitForFunction(() =>
      new URLSearchParams(location.search).get('source') === 'peer:soil-partner'
    )
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('article')].every((el) =>
          el.textContent?.includes('Soil partner collection')
        )
      ),
    ).toBe(true)
    expect(await page.evaluate(() => document.querySelector('main [role="status"]')?.textContent))
      .toContain('2 results shown')
    expect(server.requests.filter((r) => r.path.includes('/search')).length).toBe(searchesBefore)
    await page.goto(`${server.url}${sharedPath}&source=peer%3Asoil-partner`)
    await ready(page)
    expect(
      await page.evaluate(() => document.querySelector<HTMLSelectElement>('#search-source')?.value),
    ).toBe('peer:soil-partner')
    expect(server.requests.some((r) => /\/(ask|ask-agent|generate|summarize)$/.test(r.path))).toBe(
      false,
    )
    expect(searchesBefore).toBeGreaterThan(0)
    await page.goto(`${server.url}${sharedPath}&source=peer%3Awater-partner`)
    await ready(page)
    await page.waitForFunction(() => document.querySelectorAll('article').length === 0)
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.trim() === 'Clear filters'
      )!.focus()
    )
    await page.keyboard.press('Enter')
    await page.waitForFunction(() =>
      !new URLSearchParams(location.search).has('source') &&
      document.querySelectorAll('article').length > 0
    )
    const config = server.tenants.get('marine')!
    server.tenants.patch('marine', {
      federation: {
        peers: config.federation!.peers!.map((peer) => ({ ...peer, linkOrigins: true })),
      },
    })
    await page.goto(`${server.url}${sharedPath}`)
    await ready(page)
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('article a')].some((a) =>
          a.href === 'https://partner.example.org/soil/soil-01.pdf'
        )
      ),
    ).toBe(true)
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLAnchorElement>(
          'article a[href^="https://partner.example.org/"]',
        )!.getBoundingClientRect().height
      ),
    ).toBeGreaterThanOrEqual(44)
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[role="switch"]')!.focus())
    await page.keyboard.press('Space')
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('federated'))
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('answer'))).toBe('0')
    server.tenants.patch('marine', { agentAsk: false })
    await page.goto(`${server.url}${searchPath}`)
    await page.waitForSelector('#search-query')
    expect(await page.evaluate(() => document.querySelector('[role="switch"]'))).toBeNull()
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('shared search reflows at 320px, uses appearance tokens and saves the review matrix', async () => {
  const server = await startAgentStub({ speed: 0 })
  const browser = await launch()
  const shots = Deno.env.get('FEDERATED_SEARCH_SHOTS')
  try {
    if (shots) await Deno.mkdir(shots, { recursive: true })
    const page = await browser.newPage(server.url)
    const branding = server.tenants.get('marine')!.branding
    for (const scheme of ['light', 'dark'] as const) {
      server.tenants.patchBranding('marine', {
        ...branding,
        paletteId: scheme === 'dark' ? 'observatory' : 'corpuskit',
        shape: 'soft',
        density: 'comfortable',
        typography: 'lexend-zilla',
        colourScheme: 'viewer',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      for (const width of [1440, 390, 320]) {
        await page.unsafelyGetCelestialBindings().Emulation.setDeviceMetricsOverride({
          width,
          height: width === 1440 ? 900 : 844,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
        await page.goto(`${server.url}${sharedPath}`)
        await ready(page)
        const metrics = await page.evaluate(() => {
          const control = document.querySelector<HTMLElement>('[role="switch"]')!
          control.focus()
          const style = getComputedStyle(control)
          return {
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
            height: control.getBoundingClientRect().height,
            radius: style.borderRadius,
            token: style.getPropertyValue('--rp-radius-btn'),
            focus: style.boxShadow,
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          }
        })
        expect(metrics.width).toBe(width)
        expect(metrics.scroll).toBeLessThanOrEqual(width)
        expect(metrics.height).toBeGreaterThanOrEqual(44)
        expect(metrics.radius).toBe(metrics.token.trim())
        expect(metrics.focus).not.toBe('none')
        expect(metrics.reduced).toBe(true)
        if (shots && width !== 320) {
          await Deno.writeFile(
            `${shots}/search-${width}-${scheme}.png`,
            await page.screenshot({ captureBeyondViewport: false }),
          )
        }
      }
    }
    await page.unsafelyGetCelestialBindings().Emulation.setDeviceMetricsOverride({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await page.goto(`${server.url}${sharedPath}`)
    await ready(page)
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px'
      const style = document.createElement('style')
      style.textContent =
        '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
      document.head.append(style)
    })
    await page.waitForFunction(() => document.documentElement.dataset.textSpacing === 'custom')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    if (shots) {
      await Deno.writeFile(
        `${shots}/search-text200-390-dark.png`,
        await page.screenshot({ captureBeyondViewport: false }),
      )
    }
    // Inspect the changed cards at the enlarged text size as well as the toolbar.
    await page.evaluate(() => document.querySelector('article')!.scrollIntoView())
    if (shots) {
      await Deno.writeFile(
        `${shots}/search-results-text200-390-dark.png`,
        await page.screenshot({ captureBeyondViewport: false }),
      )
    }
    // The source facet is collapsed on phones until the reader opens Filters.
    await page.goto(`${server.url}${sharedPath}`)
    await ready(page)
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.trim() === 'Filters'
      )!.focus()
    )
    await page.keyboard.press('Enter')
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('#search-source')!.getBoundingClientRect().height > 0
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    if (shots) {
      await Deno.writeFile(
        `${shots}/search-filters-390-dark.png`,
        await page.screenshot({ captureBeyondViewport: false }),
      )
    }
    await page.setViewportSize({ width: 320, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('#search-source')!.getBoundingClientRect().height
      ),
    ).toBeGreaterThanOrEqual(44)
  } finally {
    await browser.close()
    await server.close()
  }
})
