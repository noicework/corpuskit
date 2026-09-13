import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'

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
          await click(page, 'Add content')
          await upload(page)
          await textShown(page, 'Uploaded "marine.txt"')
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
        await click(page, 'Add content')
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
          /Uploaded|Marine research|words extracted|Add content/,
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
          await click(page, 'Add content')
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
            await click(page, 'Add content')
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
