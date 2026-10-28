import { expect } from '@std/expect'
import { settle } from './support/settle.ts'
import { launch, type Page } from '@astral/astral'
import { aragPeerFetch } from './support/arag-peer-double.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { peerKeyName } from '../apps/api/src/bindings.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'

const review = '.review/embed-widget'

async function waitFor(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 20000
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(`Timed out: ${label}`)
}

/** Evaluate in the actual child document; parent and portal use different HTTPS origins. */
async function inFrame<T>(page: Page, expression: string): Promise<T> {
  const cdp = page.unsafelyGetCelestialBindings()
  const tree = await cdp.Page.getFrameTree()
  const frame = tree.frameTree.childFrames?.find((item) => item.frame.url.includes('/embed'))
  if (!frame) throw new Error('Widget frame missing')
  const world = await cdp.Page.createIsolatedWorld({
    frameId: frame.frame.id,
    worldName: 'embed-test',
  })
  const result = await cdp.Runtime.evaluate({
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value as T
}

async function focusQuestion(page: Page) {
  const frame = await page.evaluate(() => {
    const rect = document.querySelector('[data-corpuskit-widget]')!.shadowRoot!.querySelector(
      'iframe',
    )!.getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })
  const input = await inFrame<{ x: number; y: number }>(
    page,
    "(() => { const r = document.querySelector('#embed-question').getBoundingClientRect(); return { x: r.x, y: r.y } })()",
  )
  await page.mouse.click(frame.x + input.x + 12, frame.y + input.y + 12)
  // Focus enters a different origin. The shared access controller checks the session again.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await waitFor(
    async () =>
      await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
        false
      ),
    'question after focus check',
  )
  await inFrame(page, "document.querySelector('#embed-question').focus()")
}

async function shot(page: Page, name: string, width: number, scheme: string) {
  await page.bringToFront()
  await Deno.mkdir(review, { recursive: true })
  await Deno.writeFile(`${review}/${name}-${width}-${scheme}.png`, await page.screenshot())
}

async function assertFallbackSpacing(page: Page) {
  expect(
    await page.evaluate(() => {
      const root = document.querySelector('[data-corpuskit-widget]')!.shadowRoot!
      const frame = root.querySelector('iframe')!.getBoundingClientRect()
      const link = root.querySelector('a')!.getBoundingClientRect()
      return link.top - frame.bottom >= 8 && link.right <= innerWidth &&
        document.documentElement.scrollWidth <= innerWidth
    }),
  ).toBe(true)
}

/** Real line boxes and keyboard activation, in both the framed and standalone answer. */
async function assertCitationFlow(page: Page, framed: boolean) {
  const evaluate = async <T>(expression: string): Promise<T> => {
    if (framed) return await inFrame<T>(page, expression)
    const result = await page.unsafelyGetCelestialBindings().Runtime.evaluate({
      expression,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value as T
  }
  expect(await evaluate<number>('document.querySelectorAll("section sup a").length'))
    .toBeGreaterThan(0)
  expect(
    await evaluate<boolean>(`(() => {
      const links = [...document.querySelectorAll('section sup a')];
      return links.every(link => getComputedStyle(link).display === 'inline' &&
        link.getBoundingClientRect().height <= parseFloat(getComputedStyle(link.closest('p, li')).fontSize) * 1.5) &&
        ![...document.querySelectorAll('section p')].some(p => /^\\[\\d+\\]$/.test(p.textContent.trim())) &&
        document.documentElement.scrollWidth <= innerWidth;
    })()`),
  ).toBe(true)
  expect(
    await evaluate<boolean>(`[...document.querySelectorAll('section sup a')].every(link => {
      const preceding = link.parentElement.previousSibling;
      if (!preceding?.textContent?.trim()) return true;
      const range = document.createRange();
      range.selectNodeContents(preceding);
      const lines = [...range.getClientRects()];
      return link.getBoundingClientRect().top < lines.at(-1).bottom;
    })`),
  ).toBe(true)
  await evaluate("document.querySelector('section sup a').focus()")
  await page.keyboard.press('Enter')
  expect(
    await evaluate<boolean>(`(() => {
      const link = document.querySelector('section sup a');
      const card = document.querySelector(new URL(link.href).hash);
      return card?.matches('li') && document.activeElement === card;
    })()`),
  ).toBe(true)
}

Deno.test('embed widget: real HTTPS ancestors, both modes, cited asks, keyboard, Japanese and visual matrix', async () => {
  const peer = {
    zone: 'fixture-zone',
    kbId: 'fixture-soil',
    key: 'fixture-only-peer-key',
    documents: [{
      resourceId: 'soil-paper',
      title: 'Soil and coastal evidence',
      text: 'Healthy soils support coastal water quality.',
    }],
  }
  const peerFetch = aragPeerFetch([peer])
  // This portal has no retrieval agent, so the real composer searches its collection and peer.
  const provider = new Proxy(new DoubleProvider(), {
    get: (target, property, receiver) => {
      if (property === 'agentAsk') return undefined
      if (property === 'composeStream') {
        return (...args: Parameters<DoubleProvider['compose']>) =>
          (async function* () {
            yield await target.compose(...args)
            // The real composer removes this unsupported figure from done.text.
            yield '\n\nThe provisional total was 987654321 [999].'
          })()
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const server = startTestServer({ peerFetch, provider })
  const directory = await Deno.makeTempDir({ prefix: 'embed-widget-tls-' })
  let portal: Deno.HttpServer | undefined
  let host: Deno.HttpServer | undefined
  let blocked: Deno.HttpServer | undefined
  // Keep cross-site frames on this CDP target so the existing harness can inspect their DOM.
  // Origin checks, frame-ancestors and cookie policies remain enabled.
  const browser = await launch({
    args: ['--ignore-certificate-errors', '--disable-site-isolation-trials'],
  })
  const page = await browser.newPage('about:blank')
  try {
    const generated = await new Deno.Command('openssl', {
      args: [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${directory}/key.pem`,
        '-out',
        `${directory}/cert.pem`,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      stdout: 'null',
      stderr: 'null',
    }).output()
    expect(generated.success).toBe(true)
    const cert = await Deno.readTextFile(`${directory}/cert.pem`)
    const key = await Deno.readTextFile(`${directory}/key.pem`)
    const serve = (handler: Deno.ServeHandler) =>
      Deno.serve({ hostname: '127.0.0.1', port: 0, cert, key, onListen: () => {} }, handler)
    portal = serve(async (request) => {
      const url = new URL(request.url)
      try {
        const response = await fetch(
          new Request(`${server.url}${url.pathname}${url.search}`, request),
        )
        return new Response(response.body, { status: response.status, headers: response.headers })
      } catch (error) {
        if (request.signal.aborted) return new Response(null, { status: 499 })
        throw error
      }
    })
    const portalUrl = `https://127.0.0.1:${(portal.addr as Deno.NetAddr).port}`
    const hostPage = (request: Request) => {
      const params = new URL(request.url).searchParams
      return new Response(
        `<!doctype html><html lang="${
          params.get('lang') ?? 'en'
        }"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${portalUrl}/styles.css"></head><body class="bg-app text-ink p-3"><main><h1 class="rp-display text-2xl mb-4">Research website</h1><a href="#after" id="before">Before widget</a><script src="${portalUrl}/t/marine/embed.js" data-mode="${
          params.get('mode') === 'button' ? 'button' : 'inline'
        }" data-view="${
          params.get('view') === 'federated' ? 'federated' : 'own'
        }" data-height="700" ${
          params.get('widgetLang') === 'en' ? 'data-lang="en"' : ''
        } defer></script><a id="after" href="#before">After widget</a></main></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      )
    }
    host = serve(hostPage)
    blocked = serve(hostPage)
    const hostUrl = `https://localhost:${(host.addr as Deno.NetAddr).port}`
    const blockedUrl = `https://localhost:${(blocked.addr as Deno.NetAddr).port}`
    const seed = server.tenants.get('marine')!
    const embedding = { enabled: true, allowedOrigins: [hostUrl], defaultView: 'own' as const }
    server.tenants.patch('marine', {
      embedding,
      agentAsk: true,
      federation: {
        peers: [{
          id: 'soil-partner',
          label: 'Soil research hub',
          kind: 'arag-mcp',
          zone: peer.zone,
          kbId: peer.kbId,
        }],
      },
      branding: {
        ...seed.branding,
        productName: 'Research collection',
        organisation: 'Fisheries research',
        paletteId: 'canopy',
        shape: 'soft',
        density: 'comfortable',
        typography: 'fraunces-poppins',
        colourScheme: 'viewer',
      },
    })

    await server.bindings.set(peerKeyName('marine', 'soil-partner'), {
      baseUrl: `https://${peer.zone}.dp.progress.cloud/api/v1/kb/${peer.kbId}`,
      token: peer.key,
      kbId: peer.kbId,
    })
    const blockedStorage = await page.unsafelyGetCelestialBindings().Page
      .addScriptToEvaluateOnNewDocument({
        source:
          `Object.defineProperty(globalThis, 'localStorage', { get() { throw new DOMException('Blocked by fixture', 'SecurityError') } })`,
      })
    console.log('embed: allowed inline and own ask with third-party storage blocked')
    await page.goto(`${hostUrl}/?mode=inline`)
    await page.waitForSelector('[data-corpuskit-widget]')
    await waitFor(
      async () =>
        await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
          false
        ),
      'allowed frame ready',
    )
    expect(await inFrame(page, "document.querySelectorAll('header,footer,nav').length")).toBe(0)
    expect(await inFrame(page, "!!document.querySelector('[role=switch]')")).toBe(false)
    await focusQuestion(page)
    await page.keyboard.type('What affects abalone stock health?')
    expect(await inFrame<string>(page, "document.querySelector('#embed-question').value"))
      .toContain('abalone')
    await waitFor(
      async () =>
        await inFrame<boolean>(
          page,
          "!!document.querySelector('button[type=submit]:not([disabled])')",
        ).catch(() => false),
      'own submit enabled',
    )
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await waitFor(
      async () =>
        (await inFrame<string>(page, 'document.body.textContent')).includes('Answer ready.'),
      'own answer',
    )
    expect(
      await inFrame<number>(
        page,
        "document.querySelectorAll('section ol a[target=_blank]').length",
      ),
    ).toBeGreaterThan(0)
    expect(
      server.requests.some((item) => item.path === '/api/t/marine/ask' && item.method === 'POST'),
    ).toBe(true)
    const asked = server.requests.filter((item) => item.path.endsWith('/ask')).length

    console.log('embed: dialog keyboard flow')
    await page.goto(`${hostUrl}/?mode=button`)
    await page.waitForSelector('[data-corpuskit-widget]')
    await page.evaluate(() =>
      document.querySelector('[data-corpuskit-widget]')!.shadowRoot!.querySelector('button')!
        .focus()
    )
    await page.keyboard.press('Enter')
    await waitFor(
      async () =>
        await inFrame<boolean>(page, "document.activeElement?.id === 'embed-question'").catch(() =>
          false
        ),
      'dialog question focus',
    )
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() => ['before', 'after'].includes(document.activeElement?.id ?? '')),
      ).toBe(false)
    }
    await waitFor(
      async () =>
        await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
          false
        ),
      'input after tab cycle',
    )
    await inFrame(page, "document.querySelector('#embed-question').focus()")
    await new Promise((resolve) => setTimeout(resolve, 300))
    await waitFor(
      async () =>
        await inFrame<boolean>(page, "document.activeElement?.id === 'embed-question'").catch(() =>
          false
        ),
      'focus after access check',
    )
    await page.keyboard.press('Escape')
    expect(
      await page.evaluate(() => {
        const root = document.querySelector('[data-corpuskit-widget]')!.shadowRoot!
        return !root.querySelector('dialog')!.open &&
          root.activeElement === root.querySelector('button')
      }),
    ).toBe(true)
    expect(server.requests.filter((item) => item.path.endsWith('/ask')).length).toBe(asked)

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '62.5%'
    })
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-corpuskit-widget]')!.shadowRoot!.querySelector('button')!
          .getBoundingClientRect().height >= 44
      ),
    ).toBe(true)
    console.log('embed: disallowed ancestor')
    // A valid HTTPS host on a different port is refused by the browser's CSP enforcement.
    const violations: string[] = []
    const cdp = page.unsafelyGetCelestialBindings()
    cdp.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Log.entryAdded') violations.push(message.params.entry.text)
    })
    await cdp.Log.enable()
    await page.goto(`${blockedUrl}/?mode=inline`)
    await waitFor(
      async () => violations.some((text) => text.includes('frame-ancestors')),
      'CSP refusal',
    )
    expect(
      await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
        false
      ),
    ).toBe(false)

    server.tenants.patch('marine', {
      languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
    })
    await page.goto(`${hostUrl}/?mode=inline&lang=ja&widgetLang=en`)
    await waitFor(
      async () =>
        await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
          false
        ),
      'explicit English in a Japanese portal',
    )
    expect(await inFrame<string>(page, 'document.documentElement.lang')).toBe('en-AU')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-corpuskit-widget]')?.getAttribute('lang')
      ),
    ).toBe('en')
    server.tenants.patch('marine', {
      languagePolicy: { defaultLanguage: 'en', availableLanguages: ['ja', 'en'] },
    })
    await page.unsafelyGetCelestialBindings().Page.removeScriptToEvaluateOnNewDocument({
      identifier: blockedStorage.identifier,
    })
    server.setIdentity({
      verified: true,
      createdAt: Date.now(),
      tenantId: 'tenant-1',
      oid: 'fixture-owner-one',
      roles: ['CorpusKit.Owner'],
      groups: [],
      groupStatus: 'complete',
      claimIssuedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    })
    for (const scheme of ['light', 'dark']) {
      for (const width of [1440, 390, ...(scheme === 'light' ? [320] : [])]) {
        console.log(`embed: ${width} ${scheme}`)
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
        await page.unsafelyGetCelestialBindings().Emulation.setTouchEmulationEnabled({
          enabled: width < 768,
          maxTouchPoints: 1,
        })
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, {
          name: 'prefers-reduced-motion',
          value: 'reduce',
        }])
        const brand = server.tenants.get('marine')!.branding
        server.tenants.patch('marine', {
          branding: {
            ...brand,
            paletteId: scheme === 'dark' ? 'observatory' : 'canopy',
            defaultColourScheme: scheme as 'dark' | 'light',
          },
        })
        await page.goto(`${hostUrl}/?mode=inline&view=federated&lang=ja`)
        await waitFor(
          async () =>
            await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
              false
            ),
          'Japanese frame ready',
        )
        expect(await inFrame<string>(page, 'document.documentElement.lang')).toBe('ja')
        expect(await inFrame<string>(page, 'document.body.textContent')).toContain(
          '連携先のコレクションも検索',
        )
        // These are authored portal names; the surrounding interface is Japanese.
        expect(await inFrame<string>(page, "document.querySelector('h1').textContent"))
          .toBe('Research collection')
        expect(await inFrame<string>(page, "document.querySelector('.rp-eyebrow').textContent"))
          .toBe('Fisheries research')
        expect(await inFrame(page, 'document.documentElement.scrollWidth <= innerWidth')).toBe(true)
        expect(await page.evaluate(() => innerWidth)).toBe(width)
        expect(
          await inFrame<string>(
            page,
            "document.querySelector('[data-colour-scheme]').getAttribute('data-colour-scheme')",
          ),
        ).toBe(scheme)
        expect(
          await inFrame<boolean>(
            page,
            "(() => { const q = document.querySelector('#embed-question'); return getComputedStyle(q).borderRadius === getComputedStyle(q).getPropertyValue('--rp-radius-input').trim() })()",
          ),
        ).toBe(true)
        await assertFallbackSpacing(page)
        if (width !== 320) await shot(page, 'inline', width, scheme)
        if (width === 390 && scheme === 'light') {
          await page.evaluate(() => document.documentElement.style.fontSize = '200%')
          await inFrame(page, "document.documentElement.style.fontSize = '200%'")
          expect(await inFrame(page, 'document.documentElement.scrollWidth <= innerWidth')).toBe(
            true,
          )
          await assertFallbackSpacing(page)
          await shot(page, 'inline-text200', width, scheme)
          await inFrame(page, "document.documentElement.style.fontSize = ''")
          await page.evaluate(() => document.documentElement.style.fontSize = '')
        }
        await focusQuestion(page)
        await page.unsafelyGetCelestialBindings().Input.insertText({
          text: 'What affects abalone stock health?',
        })
        expect(await inFrame<string>(page, "document.querySelector('#embed-question').value"))
          .toContain('abalone')
        await waitFor(
          async () =>
            await inFrame<boolean>(
              page,
              "!!document.querySelector('button[type=submit]:not([disabled])')",
            ).catch(() => false),
          'federated submit enabled',
        )
        await page.keyboard.press('Tab')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')
        await waitFor(
          async () =>
            (await inFrame<string>(page, 'document.body.textContent')).includes(
              '回答ができました。',
            ),
          'federated answer',
        )
        expect(
          server.requests.some((item) =>
            item.path === '/api/t/marine/ask-agent' && item.method === 'POST'
          ),
        ).toBe(true)
        expect(await inFrame<number>(page, 'document.querySelectorAll("section ol li").length'))
          .toBeGreaterThan(0)
        expect(await inFrame<string>(page, 'document.body.textContent')).toContain(
          'Soil research hub',
        )
        expect(peerFetch.calls.some((call) => call.tool === 'search_documents')).toBe(true)
        expect(await inFrame<string>(page, "document.querySelector('section').textContent")).not
          .toContain('987654321')
        expect(
          await inFrame<boolean>(
            page,
            '!!document.querySelector(\'section ol a[href*="/library/"][target=_blank]\')',
          ),
        ).toBe(true)
        await assertCitationFlow(page, true)
        await assertFallbackSpacing(page)
        await inFrame(page, "document.querySelector('section').scrollIntoView()")
        if (width !== 320) await shot(page, 'federated-answer', width, scheme)
        if (width === 390 && scheme === 'light') {
          await page.evaluate(() => document.documentElement.style.fontSize = '200%')
          await inFrame(page, "document.documentElement.style.fontSize = '200%'")
          expect(await inFrame(page, 'document.documentElement.scrollWidth <= innerWidth')).toBe(
            true,
          )
          await assertCitationFlow(page, true)
          await assertFallbackSpacing(page)
          await inFrame(page, "document.querySelector('section').scrollIntoView()")
          await shot(page, 'federated-answer-text200', width, scheme)
        }
        await page.goto(`${portalUrl}/t/marine/embed?view=own`)
        await page.waitForSelector('#embed-question')
        if (width === 1440 && scheme === 'light') await assertCurrentBuild(page)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        if (width !== 320) await shot(page, 'embed', width, scheme)
        if (width === 390 && scheme === 'light') {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%'
          })
          await shot(page, 'embed-text200', width, scheme)
          await page.evaluate(() => {
            document.documentElement.style.fontSize = ''
          })
        }
        const box = await page.evaluate(() => {
          const r = document.getElementById('embed-question')!.getBoundingClientRect()
          return { x: r.x, y: r.y }
        })
        await page.mouse.click(box.x + 12, box.y + 12)
        await new Promise((resolve) => setTimeout(resolve, 300))
        await page.waitForSelector('#embed-question')
        await page.evaluate(() => document.getElementById('embed-question')!.focus())
        await page.unsafelyGetCelestialBindings().Input.insertText({
          text: 'What affects abalone stock health?',
        })
        expect(
          await page.evaluate(() =>
            (document.getElementById('embed-question') as HTMLTextAreaElement).value
          ),
        ).toContain('abalone')
        await page.waitForSelector('button[type=submit]:not([disabled])')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.body.textContent?.includes('Answer ready.'))
        const opens = () => server.requests.filter((item) => item.path.endsWith('/events/open'))
        const beforeJump = opens().length
        await assertCitationFlow(page, false)
        if (width === 1440 && scheme === 'light') {
          // Focusing a source is not a document open. Activate its real link separately,
          // cancelling navigation at the document so this browser keeps its fixture page.
          expect(opens().length).toBe(beforeJump)
          await page.evaluate(() => {
            document.addEventListener('click', (event) => event.preventDefault(), { once: true })
            document.querySelector<HTMLAnchorElement>('section ol a')!.click()
          })
          await waitFor(
            async () => opens().length > beforeJump && opens().at(-1)?.status === 204,
            'source link open recorded',
          )
          expect(opens().length).toBe(beforeJump + 1)
        }
        await page.evaluate(() => document.querySelector('section')!.scrollIntoView())
        if (width !== 320) await shot(page, 'own-answer', width, scheme)
        if (width === 320) {
          await page.evaluate(() => {
            const style = document.createElement('style')
            style.textContent =
              '.rp-embed * { line-height:1.5!important; letter-spacing:.12em!important; word-spacing:.16em!important } .rp-embed p { margin-bottom:2em!important }'
            document.head.append(style)
          })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true)
          await assertCitationFlow(page, false)
        }
        if (width === 390 && scheme === 'light') {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%'
          })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true)
          await assertCitationFlow(page, false)
          await page.evaluate(() => document.querySelector('section')!.scrollIntoView())
          await shot(page, 'own-answer-text200', width, scheme)
        }
        await page.goto(`${hostUrl}/?mode=button`)
        await page.waitForSelector('[data-corpuskit-widget]')
        await page.evaluate(() =>
          document.querySelector('[data-corpuskit-widget]')!.shadowRoot!.querySelector('button')!
            .click()
        )
        await waitFor(
          async () =>
            await inFrame<boolean>(page, "!!document.querySelector('#embed-question')").catch(() =>
              false
            ),
          'button frame',
        )
        if (width !== 320) await shot(page, 'button', width, scheme)
        if (width === 390 && scheme === 'light') {
          await inFrame(page, "document.documentElement.style.fontSize = '200%'")
          await shot(page, 'button-text200', width, scheme)
        }
        await page.goto(`${portalUrl}/t/marine/manage?tab=behaviour`)
        await page.waitForSelector('[data-embedding-settings]')
        if (width === 1440 && scheme === 'light') {
          const before = server.requests.filter((item) => item.method === 'PATCH').length
          await page.evaluate(() => {
            const field = document.getElementById('embedding-origins') as HTMLTextAreaElement
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
              field,
              'http://invalid.example',
            )
            field.dispatchEvent(new Event('input', { bubbles: true }))
          })
          await page.evaluate(() =>
            document.querySelector<HTMLFormElement>('[data-embedding-settings] form')!
              .requestSubmit()
          )
          await page.waitForFunction(() =>
            document.querySelector('[data-embedding-settings] [role=alert]')?.textContent?.includes(
              'HTTPS',
            )
          )
          expect(server.requests.filter((item) => item.method === 'PATCH').length).toBe(before)
          await page.evaluate((origin) => {
            const field = document.getElementById('embedding-origins') as HTMLTextAreaElement
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
              field,
              origin,
            )
            field.dispatchEvent(new Event('input', { bubbles: true }))
          }, { args: [hostUrl] })
          await page.evaluate(() =>
            document.querySelector<HTMLFormElement>('[data-embedding-settings] form')!
              .requestSubmit()
          )
          await page.waitForFunction(() =>
            document.querySelector('[data-embedding-settings] [role=status]')?.textContent
              ?.includes('Embedding settings saved.')
          )
          expect(server.tenants.get('marine')?.embedding?.allowedOrigins).toEqual([hostUrl])
        }
        await page.evaluate(() =>
          document.querySelector('[data-embedding-settings]')!.scrollIntoView()
        )
        if (width !== 320) await shot(page, 'behaviour', width, scheme)
        if (width === 390 && scheme === 'light') {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%'
          })
          await settle(page, '[data-embedding-settings]')
          await page.evaluate(() =>
            document.querySelector('[data-embedding-settings]')!.scrollIntoView()
          )
          await shot(page, 'behaviour-text200', width, scheme)
        }
        server.setAccessMode('marine', 'restricted')
        server.setIdentity(null)
        await page.goto(`${portalUrl}/t/marine/embed`)
        await page.waitForSelector('[data-embed-private]')
        expect(await page.evaluate(() => document.querySelector('#embed-question') === null)).toBe(
          true,
        )
        expect(
          await page.evaluate(() =>
            document.querySelector('[data-embed-open]')?.getAttribute('target')
          ),
        ).toBe('_blank')
        if (width === 1440 && scheme === 'light') {
          server.setIdentity(fixtureSession({ oid: 'embed-unassigned' }))
          await page.goto(`${portalUrl}/t/marine/embed`)
          await page.waitForSelector('[data-embed-private]')
          expect(await page.evaluate(() => document.body.textContent)).toContain(
            'You cannot open this portal with your current account.',
          )
          expect(await page.$('#embed-question')).toBeNull()
          server.setIdentity(null)
          const before = server.tenants.get('marine')!.branding
          server.tenants.patch('marine', {
            branding: { ...before, layout: { footer: { poweredBy: false } } },
          })
          await page.goto(`${portalUrl}/t/marine/embed`)
          await page.waitForSelector('[data-embed-private]')
          expect(
            await page.evaluate(() => document.body.textContent?.includes('Powered by CorpusKit')),
          ).toBe(false)
          server.tenants.patch('marine', { branding: before })
          await page.goto(`${portalUrl}/t/marine/embed`)
          await page.waitForSelector('[data-embed-private]')
        }
        if (width !== 320) await shot(page, 'private', width, scheme)
        if (width === 390 && scheme === 'light') {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%'
          })
          await shot(page, 'private-text200', width, scheme)
        }
        server.setAccessMode('marine', 'public')
        // The test server's explicit owner identity is restored through its trusted fixture.
        server.setIdentity({
          verified: true,
          createdAt: Date.now(),
          tenantId: 'tenant-1',
          oid: 'fixture-owner-one',
          roles: ['CorpusKit.Owner'],
          groups: [],
          groupStatus: 'complete',
          claimIssuedAt: Date.now(),
          expiresAt: Date.now() + 3600000,
        })
      }
    }
  } catch (error) {
    console.error('Widget requests', server.requests)
    console.error('Widget failure', error)
    throw error
  } finally {
    await page.close()
    await browser.close()
    await Promise.all([portal?.shutdown(), host?.shutdown(), blocked?.shutdown()])
    await server.close()
    await Deno.remove(directory, { recursive: true })
  }
})
