import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer as startServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import type { Source, SourceStoreApi } from '../apps/api/src/stores.ts'
import { PortalLifecycleError } from '../apps/api/src/lifecycle-error.ts'

/** Isolate fixture storage while exercising the real HTTP handlers and declarations. */
function startTestServer(options: Parameters<typeof startServer>[0] = {}) {
  const portals = new Map<string, Source[]>()
  const sources: SourceStoreApi = {
    list: (slug) => structuredClone(portals.get(slug) ?? []),
    summaries: (slug) =>
      sources.list(slug).map(({ synced, ...source }) => ({
        ...source,
        itemCount: source.itemCount ?? synced?.length ?? 0,
      })),
    find: (slug, id) => sources.list(slug).find((source) => source.id === id),
    findByUrl: (slug, url) => sources.list(slug).find((source) => source.url === url),
    slugs: () => [...portals.keys()],
    add: (slug, url, auto, maxPages) => {
      const source = {
        id: crypto.randomUUID(),
        url,
        auto,
        maxPages,
        addedAt: new Date().toISOString(),
        lastSync: null,
        lastAdded: 0,
        synced: [],
        itemCount: 0,
      }
      portals.set(slug, [...sources.list(slug), source])
      return structuredClone(source)
    },
    update: (slug, id, patch) => {
      portals.set(
        slug,
        sources.list(slug).map((source) => source.id === id ? { ...source, ...patch } : source),
      )
    },
    remove: (slug, id) => {
      portals.set(slug, sources.list(slug).filter((source) => source.id !== id))
    },
    erase: (slug) => Number(portals.delete(slug)),
  }
  return startServer({
    ...options,
    sources,
    insights: {
      record: () => {
        throw new Error('Unsupported content fixture: record insight')
      },
      summary: () => ({
        totalAsks: 0,
        answered: 0,
        unanswered: 0,
        avgGroundedness: null,
        avgAnswerRelevance: null,
        topQuestions: [],
        gaps: [],
        recent: [],
      }),
      erase: () => 0,
    },
  })
}

function contentManagement() {
  let hidden = false
  const calls: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      calls.push(String(method))
      switch (method) {
        case 'counters':
          return Promise.resolve({ resources: 2, paragraphs: 14, sentences: 28, indexMb: 1 })
        case 'recentResources':
          return Promise.resolve([{
            id: 'res-2',
            title: 'Marine research',
            status: 'processed',
            hidden,
          }])
        case 'corpusHealth':
          return Promise.resolve([{
            id: 'res-2',
            title: 'Marine research',
            status: 'thin',
            words: 4,
            hidden,
          }])
        case 'setResourceHidden':
          hidden = args[2] as boolean
          return Promise.resolve()
        case 'createLink':
        case 'createText':
        case 'uploadFile':
          return Promise.resolve({ id: 'res-2' })
        case 'createLabelset':
        case 'updateLabelset':
          return Promise.resolve()
        case 'agentConfigs':
          return Promise.resolve([])
        default:
          return Promise.reject(new Error(`Unsupported management fixture: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  return { management, calls }
}

const stage = Deno.env.get('RBAC_MANAGE_STAGE')
const stages = ['04-05-02', '04-06-01', '04-06-02', '04-07-01', '04-07-02', '04-07-03']
async function navigate(page: Page, tab: string) {
  await page.evaluate((tab) => {
    history.pushState(null, '', `/t/marine/manage?tab=${tab}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [tab] })
  await page.waitForSelector(`[data-manage-tab=${tab}][aria-current=true]`)
}
async function click(page: Page, text: string) {
  await page.waitForFunction(
    (text: string) =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent?.trim().replace(/^[▸▾]\s*/, '') === text && !b.disabled
      ),
    { args: [text] },
  )
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.trim().replace(/^[▸▾]\s*/, '') === text
    )
    if (!button) throw new Error(`Missing button: ${text}`)
    button.click()
  }, { args: [text] })
}
async function fill(page: Page, selector: string, value: string) {
  await page.evaluate(({ selector, value }) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, { args: [{ selector, value }] })
}
async function textShown(page: Page, text: string) {
  try {
    await page.waitForFunction((text: string) => document.body.innerText.includes(text), {
      args: [text],
    })
  } catch (error) {
    console.error('Missing text', text, await page.evaluate(() => document.body.innerText))
    throw error
  }
}
/** An upload row for `name` that the portal accepted: processing, or already ready. */
async function uploadShown(page: Page, name: string) {
  try {
    await page.waitForFunction(
      (name: string) =>
        [...document.querySelectorAll('[data-upload-row]')].some((row) =>
          row.textContent?.includes(name) &&
          ['processing', 'ready'].includes(row.getAttribute('data-upload-status') ?? '')
        ),
      { args: [name] },
    )
  } catch (error) {
    console.error('Missing upload', name, await page.evaluate(() => document.body.innerText))
    throw error
  }
}
async function upload(page: Page) {
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Marine research evidence'], 'marine.txt', { type: 'text/plain' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

Deno.test('content readiness stage is exact and invalid names fail', async () => {
  if (stage !== undefined) expect(stages).toContain(stage)
  if (stage !== '04-06-01' && stage !== '04-06-02') return
  const source = await Deno.readTextFile('apps/web/src/pages/ManagePage.tsx')
  const map = source.match(/const MANAGE_PANEL_READY = \{([\s\S]*?)\}/)![1]!
  const ready = [
    'recentList',
    'statTiles',
    'addContent',
    'corpusHealth',
    ...(stage === '04-06-02' ? ['sources', 'insights', 'labelsets'] : []),
  ]
  const entries = [...map.matchAll(/(\w+):\s*(true|false)/g)]
  expect(entries).toHaveLength(15)
  expect(entries.filter((m) => m[2] === 'true').map((m) => m[1])).toEqual(ready)
})

/** Double only the external website; browser API traffic uses signed LocalIngress. */
function sourceWebsite() {
  const original = globalThis.fetch
  const origin = 'https://content.example.test'
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin) return original(input, init)
    const content = url.pathname === '/sitemap.xml'
      ? `<urlset><url><loc>${origin}/report</loc></url></urlset>`
      : `<html><head><title>Marine research report</title></head><body><main><h1>Marine research report</h1><p>${
        'Marine research evidence supports better fisheries decisions. '.repeat(80)
      }</p></main></body></html>`
    return Promise.resolve(
      new Response(content, {
        headers: {
          'content-type': url.pathname.endsWith('.xml') ? 'application/xml' : 'text/html',
        },
      }),
    )
  }
  return {
    url: `${origin}/sitemap.xml`,
    close: () => {
      globalThis.fetch = original
    },
  }
}

Deno.test('public taxonomy remains readable while only signed curators can create and edit categories', async () => {
  const browser = await launch()
  try {
    for (const role of [null, 'viewer', 'curator'] as const) {
      const { management, calls } = contentManagement()
      const server = startTestServer({ ...(role ? { identity: { role } } : {}), management })
      try {
        const page = await browser.newPage(`${server.url}/t/marine/taxonomy`)
        try {
          await page.waitForSelector('h1')
          await textShown(page, 'Categories used to classify resources')
          await textShown(page, 'Topic')
          if (role !== 'curator') {
            expect(await page.evaluate(() => !!document.querySelector('#taxonomy-name'))).toBe(
              false,
            )
            expect(server.requests.filter((r) => r.path.startsWith('/api/admin/'))).toEqual([])
            continue
          }
          await page.waitForSelector('#taxonomy-name')
          await fill(page, '#taxonomy-name', 'Region')
          await fill(page, '#taxonomy-seed', 'North, South')
          await click(page, 'Add category')
          await textShown(page, 'Added "Region"')
          await navigate(page, 'taxonomy')
          await page.waitForSelector('#ls-topic-title')
          await fill(page, '#ls-topic-title', 'Research topic')
          await click(page, 'Save')
          await textShown(page, 'Saved "Research topic"')
          await click(page, 'New label set')
          await fill(page, '#ls-new-title', 'Habitat')
          await fill(page, '#ls-new-label-0', 'Reef')
          await click(page, 'Create label set')
          await textShown(page, 'Created "Habitat"')
          expect(calls).toEqual(
            expect.arrayContaining(['createLabelset', 'updateLabelset', 'agentConfigs']),
          )
          expect(
            server.requests.filter((r) =>
              r.path.match(/analyse|interrogate|suggestions|kb-agents/)
            ),
          ).toEqual([])
          expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
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

Deno.test('signed source add edit sync remove and insights use real declared routes', async () => {
  const website = sourceWebsite()
  const server = startTestServer({
    identity: { role: 'curator' },
    management: contentManagement().management,
  })
  const browser = await launch()
  try {
    const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
    try {
      await assertCurrentBuild(page)
      await page.waitForSelector('#source-url-marine')
      await fill(page, '#source-url-marine', website.url)
      await click(page, 'Add source')
      await textShown(page, 'Source added. Found 1 page')
      await page.waitForSelector('select[id^=source-cap-]:not(#source-cap-marine)')
      await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>(
          'select[id^=source-cap-]:not(#source-cap-marine)',
        )!
        select.value = '5'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await page.waitForFunction(() =>
        !document.querySelector<HTMLSelectElement>(
          'select[id^=source-cap-]:not(#source-cap-marine)',
        )?.disabled
      )
      await click(page, 'Sync now')
      await textShown(page, 'Synced - 1 page added.')
      await click(page, 'Refresh sources')
      await click(page, 'Remove')
      await textShown(page, 'No sources registered yet.')
      await navigate(page, 'insights')
      await textShown(page, 'No questions asked yet')
      await click(page, 'Refresh insights')
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
        expect(
          server.requests.some((r) =>
            r.path.includes('/sources') && r.method === method && r.status === 200
          ),
        ).toBe(true)
      }
      expect(server.requests.some((r) => r.path.endsWith('/sync') && r.status === 200)).toBe(true)
      expect(server.requests.some((r) => r.path.endsWith('/insights') && r.status === 200)).toBe(
        true,
      )
      expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
    website.close()
  }
})

Deno.test('source streams and forged old editor callbacks cannot publish or dispatch after revocation', async () => {
  const website = sourceWebsite()
  const browser = await launch()
  try {
    for (const tab of ['content', 'taxonomy']) {
      const base = contentManagement().management
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const management = new Proxy(base, {
        get: (target, key) =>
          key === 'createText'
            ? async () => {
              entered.resolve()
              await held.promise
              return { id: 'res-2' }
            }
            : Reflect.get(target, key),
      })
      const server = startTestServer({ identity: { role: 'curator' }, management })
      const page = await browser.newPage(`${server.url}/t/marine/manage?tab=${tab}`)
      try {
        if (tab === 'content') {
          await page.waitForSelector('#source-url-marine')
          await fill(page, '#source-url-marine', website.url)
          await click(page, 'Add source')
          await click(page, 'Sync now')
          const timeout = setTimeout(
            () => entered.reject(new Error('Source ingestion did not start')),
            10_000,
          )
          try {
            await entered.promise
          } finally {
            clearTimeout(timeout)
          }
        } else {
          await page.waitForSelector('#ls-topic-title')
          await fill(page, '#ls-topic-title', 'Private draft')
          await textShown(page, 'Save')
        }
        // Save the real React callback, then invoke it after its authority is obsolete.
        await page.evaluate((tab) => {
          const element = tab === 'content'
            ? document.querySelector('#source-url-marine')!.closest('form')!
            : [...document.querySelectorAll('button')].find((b) =>
              b.textContent?.trim() === 'Save'
            )!
          const props = Object.keys(element).find((key) => key.startsWith('__reactProps'))!
          const callback =
            (element as unknown as Record<string, Record<string, () => unknown>>)[props]![
              tab === 'content' ? 'onSubmit' : 'onClick'
            ]!
          ;(globalThis as unknown as { oldCallback: typeof callback }).oldCallback = callback
        }, { args: [tab] })
        server.setAssignment({ kind: 'portal', slug: 'marine' }, 'e2e-curator', 'viewer')
        await page.evaluate(() => dispatchEvent(new Event('focus')))
        await page.waitForSelector('[data-route-unavailable]')
        const before = server.requests.filter((r) => r.path.startsWith('/api/admin/')).length
        await page.evaluate(() => {
          const callback = (globalThis as unknown as {
            oldCallback: (event: { preventDefault(): void }) => unknown
          }).oldCallback
          callback({ preventDefault() {} })
        })
        held.resolve()
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
        expect(server.requests.filter((r) => r.path.startsWith('/api/admin/')).length).toBe(before)
        expect(await page.evaluate(() => document.body.innerText)).not.toMatch(
          /Synced -|Finished -|Private draft|Saved/,
        )
      } finally {
        held.resolve()
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
    website.close()
  }
})

Deno.test('sources insights and taxonomy obey light dark wide390 and22px appearance tokens', async () => {
  const browser = await launch()
  const website = sourceWebsite()
  try {
    for (const dark of [false, true]) {
      const server = startTestServer({
        identity: { role: 'curator' },
        management: contentManagement().management,
      })
      server.tenants.patchBranding('marine', {
        paletteId: dark ? 'observatory' : 'default',
        shape: 'soft',
        density: 'spacious',
        typography: 'lexend-zilla',
      })
      const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
      try {
        await page.waitForSelector('#source-url-marine')
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Switch to light mode"]')
            ?.click()
        )
        await page.waitForFunction(
          (dark: boolean) =>
            getComputedStyle(document.body).colorScheme === (dark ? 'dark' : 'light'),
          { args: [dark] },
        )
        await fill(page, '#source-url-marine', website.url)
        await click(page, 'Add source')
        await click(page, 'Sync now')
        await textShown(page, 'Synced - 1 page added.')
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 960 })
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '22px'
          })
          for (const tab of ['content', 'insights', 'taxonomy']) {
            await navigate(page, tab)
            const target = tab === 'content'
              ? '#source-url-marine'
              : tab === 'insights'
              ? '[data-admin-insights]'
              : '#ls-topic-title'
            await page.waitForSelector(target)
            await page.evaluate(async () => {
              await Promise.all(
                document.getAnimations().filter((animation) =>
                  Number.isFinite(animation.effect?.getComputedTiming().endTime)
                ).map((animation) => animation.finished.catch(() => {})),
              )
            })
            await page.evaluate(
              (target) => document.querySelector(target)?.scrollIntoView({ block: 'center' }),
              { args: [target] },
            )
            await captureBoundary(
              page,
              '.planning/logs/04-06-02-visual',
              `${tab}-${dark ? 'dark' : 'light'}-${width}`,
              width,
            )
            if (tab === 'content') {
              await page.evaluate(() =>
                document.querySelector('select[id^=source-cap-]:not(#source-cap-marine)')?.closest(
                  'li',
                )?.scrollIntoView({ block: 'center' })
              )
              await captureBoundary(
                page,
                '.planning/logs/04-06-02-visual',
                `source-row-${dark ? 'dark' : 'light'}-${width}`,
                width,
              )
            }
          }
          await page.evaluate(() => {
            history.pushState(null, '', '/t/marine/taxonomy')
            dispatchEvent(new PopStateEvent('popstate'))
          })
          await page.waitForSelector('#taxonomy-name')
          await page.evaluate(async () => {
            await Promise.all(
              document.getAnimations().filter((animation) =>
                Number.isFinite(animation.effect?.getComputedTiming().endTime)
              ).map((animation) => animation.finished.catch(() => {})),
            )
          })
          await page.evaluate(() =>
            document.querySelector('#taxonomy-name')?.scrollIntoView({ block: 'center' })
          )
          await captureBoundary(
            page,
            '.planning/logs/04-06-02-visual',
            `public-taxonomy-${dark ? 'dark' : 'light'}-${width}`,
            width,
          )
        }
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
    website.close()
  }
})

Deno.test('signed viewers emit no content administration requests; curator completes real Manage content operations', async () => {
  const browser = await launch()
  try {
    for (const role of ['viewer', 'curator'] as const) {
      const { management, calls } = contentManagement()
      const server = startTestServer({ identity: { role }, management })
      try {
        const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
        try {
          await assertCurrentBuild(page)
          if (role === 'viewer') {
            await page.waitForSelector('[data-route-unavailable]')
            expect(server.requests.filter((r) => r.path.startsWith('/api/admin/'))).toEqual([])
            expect(calls).toEqual([])
            continue
          }
          await upload(page)
          await uploadShown(page, 'marine.txt')
          await click(page, 'Paste text')
          await fill(page, '#text-title-marine', 'Marine text')
          await fill(page, '#text-body-marine', 'Verified marine evidence')
          await click(page, 'Add text')
          await textShown(page, 'Text added -')
          await click(page, 'Add link')
          await fill(page, '#link-url-marine', `${server.url}/build.json`)
          await page.evaluate(() =>
            document.querySelector<HTMLFormElement>('#link-url-marine')!.closest('form')!
              .requestSubmit()
          )
          await textShown(page, 'Link added -')
          await click(page, 'Hide')
          await click(page, 'Publish')
          await click(page, 'Scan corpus')
          await textShown(page, '4 words extracted')
          await click(page, 'Refresh recent additions')
          await navigate(page, 'overview')
          await click(page, 'Refresh metrics')
          await textShown(page, '28')
          expect(calls).toEqual(
            expect.arrayContaining([
              'createText',
              'createLink',
              'uploadFile',
              'setResourceHidden',
              'corpusHealth',
              'counters',
              'recentResources',
            ]),
          )
          expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
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

/**
 * Choose a file the way a person does through a native picker: activating the input blurs the
 * window, and choosing a file returns focus to it just before the input fires `change`.
 */
async function pickFile(page: Page, name: string) {
  await page.evaluate((name) => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    dispatchEvent(new Event('blur'))
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Marine research evidence'], name, { type: 'text/plain' }))
    input.files = transfer.files
    dispatchEvent(new Event('focus'))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, { args: [name] })
}

Deno.test('a file chosen through the native picker uploads while an ordinary return still withdraws access', async () => {
  const browser = await launch()
  const { management, calls } = contentManagement()
  const server = startTestServer({ identity: { role: 'curator' }, management })
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  const checks = () => server.requests.filter((r) => r.path === '/auth/me?portal=marine').length
  const uploads = () =>
    server.requests.filter((r) =>
      r.method === 'POST' && r.path === '/api/admin/t/marine/resources/upload' && r.status === 200
    ).length
  try {
    await assertCurrentBuild(page)
    for (const name of ['first.txt', 'second.txt']) {
      await page.waitForSelector('input[type=file]')
      const before = checks()
      await pickFile(page, name)
      await uploadShown(page, name)
      // The picker's return is still checked against the server, without withdrawing access:
      // once that check has answered, the panel that chose the file is still mounted.
      const deadline = Date.now() + 5000
      while (checks() <= before) {
        if (Date.now() > deadline) throw new Error('The picker return was not checked')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)))
      expect(await page.evaluate(() => !!document.querySelector('input[type=file]'))).toBe(true)
      await uploadShown(page, name)
      // A later ordinary return withdraws access until the session is read again, which
      // remounts the page: the panel that chose the file is replaced.
      await page.evaluate(() => {
        document.querySelector('input[type=file]')!.setAttribute('data-before-return', '')
        dispatchEvent(new Event('focus'))
      })
      await page.waitForFunction(() => !document.querySelector('[data-before-return]'))
    }
    expect(uploads()).toBe(2)
    expect(calls.filter((call) => call === 'uploadFile')).toHaveLength(2)
    expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
  } catch (error) {
    console.error(server.requests.slice(-12), await page.evaluate(() => document.body.innerText))
    throw error
  } finally {
    await page.close()
    await server.close()
    await browser.close()
  }
})

Deno.test('an upload running when the person comes back finishes once and survives the check', async () => {
  const browser = await launch()
  const { management, calls } = contentManagement()
  const server = startTestServer({ identity: { role: 'curator' }, management })
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  let delay: ReturnType<typeof server.delayResponse> | undefined
  const posts = () =>
    server.requests.filter((r) =>
      r.method === 'POST' && r.path === '/api/admin/t/marine/resources/upload'
    )
  try {
    await assertCurrentBuild(page)
    await page.waitForSelector('input[type=file]')
    delay = server.delayResponse('/api/admin/t/marine/resources/upload')
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type=file]')!
      const transfer = new DataTransfer()
      transfer.items.add(new File(['Marine research evidence'], 'inflight.txt'))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await delay.entered
    // The person switches away and back mid-upload: the page is withdrawn and access checked.
    await page.evaluate(() => {
      document.querySelector('input[type=file]')!.setAttribute('data-before-return', '')
      dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(() => !document.querySelector('[data-before-return]'))
    await page.waitForSelector('[data-upload-row][data-upload-status=uploading]')
    // The write was never cut off, so it lands once and its row carries on in the new page.
    delay.release()
    await uploadShown(page, 'inflight.txt')
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.status).toBe(200)
    expect(calls.filter((call) => call === 'uploadFile')).toHaveLength(1)
    expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
  } catch (error) {
    console.error(server.requests.slice(-12), await page.evaluate(() => document.body.innerText))
    throw error
  } finally {
    delay?.release()
    await page.close()
    await server.close()
    await browser.close()
  }
})

Deno.test('pending uploads and refreshes cannot publish after revocation', async () => {
  const browser = await launch()
  try {
    for (const path of ['resources/upload', 'recent', 'corpus-health']) {
      const server = startTestServer({
        identity: { role: 'curator' },
        management: contentManagement().management,
      })
      const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
      let delay: ReturnType<typeof server.delayResponse> | undefined
      try {
        await page.waitForSelector('input[type=file]')
        delay = server.delayResponse(`/api/admin/t/marine/${path}`)
        if (path === 'resources/upload') await upload(page)
        else await click(page, path === 'recent' ? 'Refresh recent additions' : 'Scan corpus')
        await delay.entered
        server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
        await page.evaluate(() => dispatchEvent(new Event('focus')))
        await page.waitForSelector('[data-route-unavailable]')
        delay.release()
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
        expect(await page.evaluate(() => document.body.innerText)).not.toMatch(
          /Uploaded|Processing|Ready|Marine research|words extracted|Add documents/,
        )
      } finally {
        delay?.release()
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('owner cannot mount pending Manage panels at the owning content stage', async () => {
  if (stage !== '04-06-01' && stage !== '04-06-02') return
  const server = startTestServer({
    identity: { role: 'owner' },
    management: contentManagement().management,
  })
  const browser = await launch()
  try {
    const page = await browser.newPage(`${server.url}/t/marine/manage`)
    await page.waitForSelector('[data-admin-metrics]')
    for (
      const tab of [
        'content',
        'insights',
        'taxonomy',
        'graph',
        'enrichments',
        'behaviour',
        'extraction',
        'appearance',
        'details',
      ]
    ) {
      await navigate(page, tab)
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 40)))
    }
    const allowed = [
      '/counters',
      '/recent',
      ...(stage === '04-06-02' ? ['/sources', '/insights'] : []),
    ]
    expect(
      server.requests.filter((r) =>
        r.path.startsWith('/api/admin/') && !allowed.some((end) => r.path.endsWith(end))
      ),
    ).toEqual([])
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('Rename')
    await page.close()
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('content controls fit light and Observatory at wide and390 with22px and tenant tokens', async () => {
  const browser = await launch()
  try {
    for (const dark of [false, true]) {
      const server = startTestServer({
        identity: { role: 'curator' },
        management: contentManagement().management,
      })
      try {
        server.tenants.patchBranding('marine', {
          paletteId: dark ? 'observatory' : 'default',
          shape: 'soft',
          density: 'spacious',
          typography: 'lexend-zilla',
        })
        const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
        try {
          await page.waitForSelector('input[type=file]')
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('button[aria-label="Switch to light mode"]')
              ?.click()
          )
          await page.waitForFunction(
            (dark: boolean) =>
              getComputedStyle(document.body).colorScheme === (dark ? 'dark' : 'light'),
            { args: [dark] },
          )
          await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)))
          for (const width of [1440, 390]) {
            await click(page, 'Scan corpus')
            await textShown(page, '4 words extracted')
            const dir = '.planning/logs/04-06-01-visual'
            await captureBoundary(page, dir, `content-${dark ? 'dark' : 'light'}-${width}`, width)
            await page.evaluate(() =>
              document.querySelector('input[type=file]')?.closest('label')?.scrollIntoView({
                block: 'center',
              })
            )
            await captureBoundary(page, dir, `upload-${dark ? 'dark' : 'light'}-${width}`, width)
            await page.evaluate(() =>
              document.querySelector('[data-admin-health]')?.scrollIntoView()
            )
            await captureBoundary(page, dir, `health-${dark ? 'dark' : 'light'}-${width}`, width)
            await navigate(page, 'overview')
            await page.waitForSelector('[data-admin-metrics]')
            await page.evaluate(() =>
              document.querySelector('[data-admin-metrics]')?.scrollIntoView()
            )
            await captureBoundary(page, dir, `metrics-${dark ? 'dark' : 'light'}-${width}`, width)
            await navigate(page, 'content')
            await page.waitForSelector('input[type=file]')
            await page.evaluate(() => scrollTo(0, 0))
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

/** Wait, up to `ms`, for a condition evaluated in the page. */
async function until(page: Page, condition: () => boolean | undefined, ms: number) {
  const deadline = Date.now() + ms
  while (!(await page.evaluate(condition))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${condition}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * A knowledge box that processes uploads: each upload is pending for its first reads of the
 * newest additions and processed after that, a file named "scanned" fails processing, and one
 * named "over-limit" is refused by the portal's storage limit.
 */
function processingManagement() {
  const items: { id: string; title: string; reads: number; bad: boolean }[] = []
  const calls: string[] = []
  const limits: unknown[] = []
  const processed = () => items.filter((item) => item.reads >= 2 && !item.bad).length
  const management = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      calls.push(String(method))
      switch (method) {
        case 'counters':
          return Promise.resolve({
            resources: processed(),
            paragraphs: processed() * 14,
            sentences: processed() * 28,
            indexMb: processed(),
          })
        case 'resourceCount':
          return Promise.resolve(processed())
        case 'recentResources':
          limits.push(args[1])
          return Promise.resolve(
            items.slice().reverse().map((item) => {
              item.reads += 1
              return {
                id: item.id,
                title: item.title,
                status: item.reads < 2 ? 'pending' : item.bad ? 'error' : 'processed',
                created: '2026-09-26T00:00:00.000Z',
                hidden: false,
              }
            }),
          )
        case 'uploadFile': {
          const { filename } = args[1] as { filename: string }
          if (filename.includes('over-limit')) {
            throw new PortalLifecycleError(413, { error: 'limit_exceeded', limit: 'maxBytes' })
          }
          const id = `upload-${items.length + 1}`
          items.push({ id, title: filename, reads: 0, bad: filename.includes('scanned') })
          return Promise.resolve({ id })
        }
        case 'corpusHealth':
        case 'agentConfigs':
          return Promise.resolve([])
        default:
          return Promise.reject(new Error(`Unsupported processing fixture: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  return { management, calls, limits }
}

Deno.test('the recent additions list takes a bounded limit for following an upload batch', async () => {
  const { management, limits } = processingManagement()
  const server = startTestServer({ identity: { role: 'curator' }, management, apiOnly: true })
  try {
    for (const limit of ['0', '101', '2.5', 'many']) {
      const response = await fetch(`${server.url}/api/admin/t/marine/recent?limit=${limit}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    for (const query of ['?limit=40', '']) {
      const response = await fetch(`${server.url}/api/admin/t/marine/recent${query}`)
      expect(response.status).toBe(200)
      await response.json()
    }
    expect(limits).toEqual([40, undefined])
  } finally {
    await server.close()
  }
})

Deno.test('adding documents is one click from the library, the overview and any empty collection', async () => {
  const browser = await launch()
  try {
    for (const role of ['curator', 'viewer'] as const) {
      const server = startTestServer({
        identity: { role },
        management: processingManagement().management,
        emptyCollection: true,
      })
      const page = await browser.newPage(`${server.url}/t/marine/library`)
      try {
        await textShown(page, 'No documents yet')
        if (role === 'viewer') {
          await textShown(page, 'Documents appear here once they have been added')
          expect(
            await page.evaluate(() => document.querySelectorAll('[data-add-documents]').length),
          )
            .toBe(0)
          await page.goto(`${server.url}/t/marine`)
          await textShown(page, 'Nothing to browse yet')
          expect(
            await page.evaluate(() => document.querySelectorAll('[data-add-documents]').length),
          )
            .toBe(0)
          continue
        }
        // One action on an empty library: the prompt carries it, the header does not repeat it.
        expect(await page.evaluate(() => document.querySelectorAll('[data-add-documents]').length))
          .toBe(1)
        await page.evaluate(() =>
          document.querySelector<HTMLAnchorElement>('[data-add-documents]')!.click()
        )
        await page.waitForSelector('[data-add-documents-panel] [data-drop-zone]')
        expect(await page.evaluate(() => `${location.pathname}${location.search}${location.hash}`))
          .toBe('/t/marine/manage?tab=content#add-documents')
        await page.waitForFunction(() => document.activeElement?.id === 'add-documents')
        expect(
          await page.evaluate(() =>
            document.querySelector('[role=tab][aria-selected=true]')?.textContent
          ),
        ).toBe('Upload files')
        // The tabs are a tab list: arrow keys, Home and End move the selection and focus.
        const key = (key: string) =>
          page.evaluate((key) => {
            document.activeElement!.dispatchEvent(
              new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
            )
          }, { args: [key] })
        const selected = () =>
          page.evaluate(() => [
            document.querySelector('[role=tab][aria-selected=true]')?.textContent,
            document.activeElement?.textContent,
          ])
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')!.focus()
        )
        await key('ArrowRight')
        expect(await selected()).toEqual(['Add link', 'Add link'])
        await key('End')
        expect(await selected()).toEqual(['Crawl site', 'Crawl site'])
        await key('ArrowRight')
        expect(await selected()).toEqual(['Upload files', 'Upload files'])
        await key('ArrowLeft')
        expect(await selected()).toEqual(['Crawl site', 'Crawl site'])
        await key('Home')
        expect(await selected()).toEqual(['Upload files', 'Upload files'])
        expect(
          await page.evaluate(() =>
            document.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby') ===
              document.querySelector('[role=tab][aria-selected=true]')?.id
          ),
        ).toBe(true)
        // The overview leads with the empty collection and its action.
        await navigate(page, 'overview')
        await page.waitForSelector('[data-overview-add-documents][data-collection-empty=true]')
        await page.evaluate(() =>
          document.querySelector<HTMLAnchorElement>(
            '[data-overview-add-documents] [data-add-documents]',
          )!.click()
        )
        await page.waitForSelector('[data-add-documents-panel] [data-drop-zone]')
        // The portal home offers it too while there is nothing to browse.
        await page.goto(`${server.url}/t/marine`)
        await textShown(page, 'Nothing to browse yet')
        await page.waitForSelector('[data-add-documents]')
      } finally {
        await page.close()
        await server.close()
      }
    }
  } finally {
    await browser.close()
  }
})

Deno.test('dropped files upload one row each: progress, processing, ready or the exact reason, then fresh counts', async () => {
  const { management, calls } = processingManagement()
  const server = startTestServer({
    identity: { role: 'curator' },
    management,
    emptyCollection: true,
  })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=content`)
  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-upload-row]')].map((row) => ({
        name: row.querySelector('span')?.textContent,
        status: row.getAttribute('data-upload-status'),
        error: row.querySelector('[data-upload-error]')?.textContent ?? null,
      }))
    )
  try {
    await assertCurrentBuild(page)
    await page.waitForSelector('[data-drop-zone]')
    await page.waitForFunction(() =>
      document.querySelector('[data-manage-counts]')?.textContent?.includes('0 documents')
    )
    // Slow the upload so its progress is visible.
    const cdp = page.unsafelyGetCelestialBindings()
    await cdp.Network.enable({})
    await cdp.Network.emulateNetworkConditions({
      offline: false,
      latency: 10,
      downloadThroughput: -1,
      uploadThroughput: 256 * 1024,
    })
    await page.evaluate(() => {
      const zone = document.querySelector('[data-drop-zone]')!
      const transfer = new DataTransfer()
      const file = (name: string, size: number) =>
        new File([new Uint8Array(size).fill(65)], name, { type: 'application/pdf' })
      transfer.items.add(file('survey.pdf', 1_200_000))
      transfer.items.add(file('over-limit.pdf', 2_000))
      transfer.items.add(file('scanned.pdf', 2_000))
      transfer.items.add(file('notes.pdf', 2_000))
      transfer.items.add(new File([], 'empty.txt', { type: 'text/plain' }))
      Object.assign(globalThis, { dropped: transfer })
      for (const type of ['dragenter', 'dragover']) {
        zone.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        )
      }
    })
    // Dragging files over the zone marks it as the drop target.
    await page.waitForSelector('[data-drop-zone][data-drop-active=true]')
    await page.evaluate(() => {
      const transfer = (globalThis as unknown as { dropped: DataTransfer }).dropped
      document.querySelector('[data-drop-zone]')!.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    })
    // Every file has its row at once; the empty one is refused before anything is sent.
    await page.waitForFunction(() => document.querySelectorAll('[data-upload-row]').length === 5)
    expect((await rows()).find((row) => row.name === 'empty.txt')).toEqual({
      name: 'empty.txt',
      status: 'failed',
      error: 'That file is empty - choose another file.',
    })
    await until(page, () => {
      const bar = document.querySelector('[data-upload-row] [role=progressbar]')
      const value = Number(bar?.getAttribute('aria-valuenow'))
      return value > 0 && value < 100
    }, 20_000)
    await cdp.Network.emulateNetworkConditions({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await until(
      page,
      () =>
        [...document.querySelectorAll('[data-upload-row]')].every((row) =>
          ['ready', 'failed'].includes(row.getAttribute('data-upload-status') ?? '')
        ),
      30_000,
    )
    expect(await rows()).toEqual([
      { name: 'survey.pdf', status: 'ready', error: null },
      {
        name: 'over-limit.pdf',
        status: 'failed',
        error:
          'This content would exceed the portal storage limit. Choose a smaller file, remove existing content or contact your portal administrator.',
      },
      {
        name: 'scanned.pdf',
        status: 'failed',
        error:
          'The file was uploaded but could not be processed. Check that it opens, or try another format.',
      },
      { name: 'notes.pdf', status: 'ready', error: null },
      { name: 'empty.txt', status: 'failed', error: 'That file is empty - choose another file.' },
    ])
    expect(calls.filter((call) => call === 'uploadFile')).toHaveLength(4)
    // The document count follows without a reload.
    await until(
      page,
      () => document.querySelector('[data-manage-counts]')?.textContent?.includes('2 documents'),
      20_000,
    )
    expect(
      await page.evaluate(() => document.querySelector('[data-upload-queue] h4')?.textContent),
    ).toBe('5 files: 2 ready, 3 failed')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-upload-files] [role=status][aria-live=polite]')
          ?.textContent
      ),
    ).toMatch(/is ready\.|failed\./)
    // A refused file can be tried again; clearing leaves only work still in progress.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-upload-row][data-upload-status=failed]')].map((row) =>
          !!row.querySelector('button')
        )
      ),
    ).toEqual([true, false, false])
    await click(page, 'Clear finished')
    await page.waitForFunction(() => !document.querySelector('[data-upload-queue]'))
    expect(server.requests.filter((r) => r.status === 401 || r.status === 403)).toEqual([])
  } catch (error) {
    console.error(await rows(), server.requests.slice(-12))
    throw error
  } finally {
    await page.close()
    await server.close()
    await browser.close()
  }
})
