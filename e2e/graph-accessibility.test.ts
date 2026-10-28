import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'

// As in design-shots.ts, AXE_PATH points at a local axe-core distribution.
// The fixture never fetches an audit script or calls a retrieval service.
const axePath = Deno.env.get('AXE_PATH')
const axeSource = axePath ? await Deno.readTextFile(axePath) : null
const directory = '.planning/graph-a11y'
const nodes = Array.from({ length: 12 }, (_, i) => ({
  id: i === 0
    ? 'Agriculture'
    : i === 11
    ? `Research identifier ${'x'.repeat(120)}`
    : `Research item ${i}`,
  group: ['Topic', 'Material', 'Experiment'][i % 3]!,
  weight: i + 1,
}))
const edges = nodes.slice(1).map((node) => ({
  source: nodes[0]!.id,
  target: node.id,
  label: 'examines',
}))
const concepts = {
  nodes: [
    { id: 'topic:stock-assessment', label: 'Stock assessment', group: 'primary', weight: 4 },
    { id: 'kind:report', label: 'Report', group: 'secondary', weight: 3 },
  ],
  edges: [{ source: 'topic:stock-assessment', target: 'kind:report', weight: 2 }],
}

function fixture() {
  const management = new Proxy({}, {
    get: (_target, method) => () => {
      if (method === 'relationsGraph') return Promise.resolve({ nodes, edges })
      if (method === 'graphData') return Promise.resolve(concepts)
      if (method === 'thumbnailResponse') {
        return Promise.resolve(new Response(null, { status: 404 }))
      }
      if (['labelsets', 'entityGroups', 'listAgents'].includes(String(method))) {
        return Promise.resolve([])
      }
      throw new Error(`Unexpected fixture operation: ${String(method)}`)
    },
  }) as NonNullable<BuildAppOptions['management']>
  return startTestServer({ management })
}

async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.getAttribute('aria-label') || button.textContent?.trim()) === label &&
      button.getBoundingClientRect().width > 0
    )
    if (!button) throw new Error(`Missing graph control: ${label}`)
    button.click()
  }, { args: [label] })
}

async function settled(page: Page) {
  await page.waitForSelector('[data-graph-stage][aria-busy=false]')
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
}

async function marks(page: Page) {
  return await page.evaluate(() => {
    const svg = document.querySelector('svg.rp-map > g')
    if (svg) return svg.getAttribute('transform')!
    return [...document.querySelectorAll<HTMLElement>('.rp-map3d-label, .rp-map3d-territory')]
      .filter((node) => node.style.display !== 'none')
      .map((node) => node.style.transform).join('|')
  })
}

async function audit(page: Page, scene: string) {
  if (!axeSource) return
  await page.evaluate(`${axeSource};void 0`)
  const violations = await page.evaluate(async () => {
    // deno-lint-ignore no-explicit-any
    const { violations } = await (globalThis as any).axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'],
      },
    })
    // deno-lint-ignore no-explicit-any
    return violations.map((v: any) => ({
      id: v.id,
      nodes: v.nodes.map((n: { target: string[]; failureSummary: string }) => ({
        target: n.target,
        failure: n.failureSummary,
      })),
    }))
  })
  expect(violations, scene).toEqual([])
}

async function assertMapContrast(page: Page) {
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>('.rp-map-camera button[aria-controls]')!.focus()
  )
  await page.keyboard.press('Tab')
  const measured = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d')!
    const luminance = (colour: string) => {
      context.fillStyle = colour
      context.fillRect(0, 0, 1, 1)
      const rgb = context.getImageData(0, 0, 1, 1).data.slice(0, 3)
      const linear = [...rgb].map((value) => {
        const v = value / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
    }
    const contrast = (first: string, second: string) => {
      const a = luminance(first), b = luminance(second)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const labels = [
      ...document.querySelectorAll<HTMLElement>('.rp-map3d-label, .rp-map3d-territory'),
    ]
      .filter((label) => label.style.display !== 'none')
    const fit = document.querySelector<HTMLButtonElement>(
      '[aria-label="Fit the whole map to view"]',
    )!
    fit.focus()
    const style = getComputedStyle(fit)
    const surface = getComputedStyle(document.querySelector('[data-graph-stage]')!).backgroundColor
    return {
      labels: labels.map((label) => {
        const style = getComputedStyle(label)
        return { ratio: contrast(style.color, style.backgroundColor), opacity: style.opacity }
      }).concat(
        [...document.querySelectorAll<SVGTextElement>(
          'svg.rp-map text.rp-map-label, svg.rp-map text.rp-map-territory, svg.rp-map text.rp-map-edge-label',
        )].map((label) => {
          const style = getComputedStyle(label)
          return { ratio: contrast(style.fill, style.stroke), opacity: style.opacity }
        }),
      ),
      ring: contrast(style.outlineColor, surface),
      outline: style.outlineStyle,
      targets: [...document.querySelectorAll<HTMLElement>('.rp-map-camera button')].map(
        (button) => {
          const box = button.getBoundingClientRect()
          return Math.min(box.width, box.height)
        },
      ),
      floor: innerWidth < 1024 || matchMedia('(pointer: coarse)').matches ? 44 : 24,
    }
  })
  for (const label of measured.labels) {
    expect(label.ratio).toBeGreaterThanOrEqual(4.5)
    expect(label.opacity).toBe('1')
  }
  expect(measured.ring).toBeGreaterThanOrEqual(3)
  expect(measured.outline).toBe('solid')
  for (const target of measured.targets) expect(target).toBeGreaterThanOrEqual(measured.floor)
}

Deno.test('graph pause, camera keys and shortcut scoping, with a complete linked list', async () => {
  const server = fixture()
  const browser = await launch()
  const page = await browser.newPage('about:blank')
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 1280, height: 960 })
    await page.goto(`${server.url}/t/marine/graph`)
    await settled(page)
    await assertCurrentBuild(page)
    expect(await page.evaluate(() => !!document.querySelector('canvas'))).toBe(true)
    // Sample beyond five seconds, the original unpausable motion failure.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 5500)))
    const moving = await marks(page)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
    expect(await marks(page)).not.toBe(moving)
    await click(page, 'Pause map motion')
    const paused = await marks(page)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
    expect(await marks(page)).toBe(paused)
    await click(page, 'Play map motion')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
    expect(await marks(page)).not.toBe(paused)
    await click(page, 'Pause map motion')

    // Real keyboard events reach only the focused map. Text fields keep their keys.
    const input = await page.waitForSelector('input[aria-label="Find an entity in the map"]')
    await input.focus()
    const outside = await marks(page)
    for (
      const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Home'] as const
    ) {
      await page.keyboard.press(key)
    }
    expect(await marks(page)).toBe(outside)
    await page.evaluate(() => document.querySelector<HTMLCanvasElement>('canvas')!.focus())
    for (
      const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Home'] as const
    ) {
      const before = await marks(page)
      await page.keyboard.press(key)
      await settled(page)
      expect(await marks(page), key).not.toBe(before)
    }
    await page.keyboard.down('Shift')
    const beforePan = await marks(page)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
    await settled(page)
    expect(await marks(page)).not.toBe(beforePan)
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('CANVAS')

    await click(page, 'Map controls')
    for (
      const action of [
        'Rotate left',
        'Rotate right',
        'Rotate up',
        'Rotate down',
        'Pan left',
        'Pan right',
        'Pan up',
        'Pan down',
        'Zoom in',
        'Zoom out',
        'Fit the whole map to view',
      ]
    ) {
      const before = await marks(page)
      await click(page, action)
      await settled(page)
      expect(await marks(page), action).not.toBe(before)
    }
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Fit the whole map to view"]')!.focus()
    )
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
      'Map controls',
    )
    await page.evaluate(() => {
      ;[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Map navigator"] button')]
        .find((button) => button.textContent?.includes('Agriculture'))!.click()
    })
    await page.waitForSelector('[aria-label="Selection details"]')
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('.rp-map-camera button')].every(
          (button) => {
            const box = button.getBoundingClientRect()
            return button.contains(
              document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
            )
          },
        )
      ),
    ).toBe(true)
    await click(page, 'Map controls')
    await assertMapContrast(page)
    await audit(page, 'entity selection details and camera controls')
    await page.keyboard.press('Escape')
    await click(page, 'Close details')
    await click(page, 'List')
    expect(
      await page.evaluate(() => document.querySelectorAll('[data-graph-items] > li').length),
    ).toBe(nodes.length)
    const text = await page.evaluate(() => document.querySelector('[data-graph-list]')!.textContent)
    for (const node of nodes) expect(text).toContain(node.id)
    expect(text).toContain('Category: Topic')
    expect(text).toContain('Topic: 4')
    expect(text).toContain('Mentions: 1')
    expect(text).toContain('Relationships: 11')
    expect(text).toContain('Agriculture · examines · Research item 1')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-graph-list] a')!.getAttribute('href')
      ),
    ).toBe('/t/marine/library?q=Agriculture')
    await click(page, 'Concept map')
    await settled(page)
    expect(await page.evaluate(() => document.querySelector('[data-graph-list]')!.textContent))
      .toContain('together on 2 resources')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-graph-list] a')!.getAttribute('href')
      ),
    ).toBe('/t/marine/library?topic=stock-assessment')
    await click(page, 'Map')
    await settled(page)
    expect(await page.evaluate(() => !!document.querySelector('[aria-label="Play map motion"]')))
      .toBe(true)
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.waitForSelector('[data-graph-list]')
    expect(await page.evaluate(() => !!document.querySelector('canvas'))).toBe(false)
    await click(page, 'Map')
    await settled(page)
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Motion off"]')!.disabled
      ),
    ).toBe(true)
    await click(page, 'List')
    await click(page, 'Entity graph')
    await settled(page)
    await (await page.waitForSelector('[data-graph-list] a')).focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('a[href="/t/marine/library/res-1"]')
    expect(
      await page.evaluate(() => document.querySelector<HTMLInputElement>('#library-search')!.value),
    ).toBe('Agriculture')
    expect(server.requests.some((request) =>
      request.path.startsWith('/api/t/marine/catalog?') &&
      new URL(request.path, server.url).searchParams.get('q') === 'Agriculture'
    )).toBe(true)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('graph accessibility matrix in both themes, lenses and renderers', async () => {
  const server = fixture()
  const browser = await launch()
  await Deno.mkdir(directory, { recursive: true })
  if (!axeSource) console.log('Set AXE_PATH to a local axe-core script to include the WCAG audit.')
  try {
    for (const fallback of [false, true]) {
      for (const dark of [false, true]) {
        const seed = server.tenants.get('marine')!
        server.tenants.patch('marine', {
          branding: {
            ...seed.branding,
            paletteId: dark ? 'observatory' : 'default',
            colourScheme: 'viewer',
            defaultColourScheme: dark ? 'dark' : 'light',
          },
        })
        for (const width of [1280, 320]) {
          const page = await browser.newPage('about:blank')
          try {
            await page.bringToFront()
            await page.setViewportSize({ width, height: 960 })
            await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
            if (fallback) {
              await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
                source: `
                const original = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
                  return /webgl/.test(kind) ? null : original.call(this, kind, ...args);
                };
              `,
              })
            }
            await page.goto(`${server.url}/t/marine/graph`)
            await settled(page)
            expect(
              await page.evaluate(() =>
                document.querySelector('[data-colour-scheme]')!.getAttribute('data-colour-scheme')
              ),
            ).toBe(dark ? 'dark' : 'light')
            expect(await page.evaluate(() => !!document.querySelector('[data-graph-list]'))).toBe(
              true,
            )
            for (const lens of ['Entity graph', 'Concept map']) {
              await click(page, lens)
              await settled(page)
              const expected = lens === 'Entity graph' ? nodes.length : concepts.nodes.length
              expect(
                await page.evaluate(() =>
                  document.querySelectorAll('[data-graph-items] > li').length
                ),
              ).toBe(expected)
              for (const view of ['List', 'Map']) {
                await click(page, view)
                await settled(page)
                const scene = `${fallback ? '2d' : '3d'}-${
                  dark ? 'dark' : 'light'
                }-${width}-${lens}-${view}`
                console.log(scene)
                expect(await page.evaluate(() => innerWidth)).toBe(width)
                expect(await page.evaluate(() => document.documentElement.scrollWidth))
                  .toBeLessThanOrEqual(width + 1)
                if (view === 'Map') {
                  expect(await page.evaluate(() => !!document.querySelector('svg.rp-map'))).toBe(
                    fallback,
                  )
                  if (!fallback) {
                    const before = await marks(page)
                    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
                    expect(await marks(page)).toBe(before)
                    expect(
                      await page.evaluate(() =>
                        document.querySelector<HTMLButtonElement>('[aria-label="Motion off"]')!
                          .disabled
                      ),
                    ).toBe(true)
                  }
                  await click(page, 'Map controls')
                  await assertMapContrast(page)
                  if (fallback) {
                    await page.evaluate(() =>
                      document.querySelector<SVGSVGElement>('svg.rp-map')!.focus()
                    )
                    const before = await marks(page)
                    await page.keyboard.press('ArrowLeft')
                    await settled(page)
                    expect(await marks(page)).not.toBe(before)
                    const panned = await marks(page)
                    await click(page, 'Map controls')
                    await click(page, 'Pan right')
                    await settled(page)
                    expect(await marks(page)).not.toBe(panned)
                  }
                }
                await audit(page, scene)
                await Deno.writeFile(`${directory}/${scene}.png`, await page.screenshot())
              }
              await click(page, 'List')
            }
          } finally {
            await page.close()
          }
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('graph reflows with enlarged text and text spacing in portrait and landscape', async () => {
  const server = fixture()
  const browser = await launch()
  await Deno.mkdir(directory, { recursive: true })
  try {
    for (const dark of [false, true]) {
      const seed = server.tenants.get('marine')!
      server.tenants.patch('marine', {
        branding: {
          ...seed.branding,
          paletteId: dark ? 'observatory' : 'default',
          shape: 'soft',
          density: 'spacious',
          typography: 'fraunces-poppins',
          colourScheme: 'viewer',
          defaultColourScheme: dark ? 'dark' : 'light',
        },
      })
      for (const [width, height] of [[1280, 960], [390, 844], [320, 844], [844, 390]]) {
        const page = await browser.newPage('about:blank')
        try {
          await page.bringToFront()
          await page.setViewportSize({ width: width!, height: height! })
          await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
          await page.goto(`${server.url}/t/marine/graph`)
          await settled(page)
          await page.evaluate(async () => {
            document.documentElement.style.fontSize = '22px'
            const style = document.createElement('style')
            style.textContent =
              '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
            document.head.append(style)
            await document.fonts.ready
          })
          for (const view of ['List', 'Map']) {
            await click(page, view)
            await settled(page)
            const scene = `spacing-${dark ? 'dark' : 'light'}-${width}-${height}-${view}`
            expect(await page.evaluate(() => document.documentElement.scrollWidth), scene)
              .toBeLessThanOrEqual(width! + 1)
            if (view === 'List') {
              expect(
                await page.evaluate(() =>
                  document.querySelectorAll('[data-graph-items] > li').length
                ),
              ).toBe(nodes.length)
            } else {
              await click(page, 'Map controls')
              const fit = await page.waitForSelector('[aria-label="Fit the whole map to view"]')
              await fit.focus()
              const inside = await page.evaluate(() => {
                const fit = document.querySelector('[aria-label="Fit the whole map to view"]')!
                  .getBoundingClientRect()
                const panel = document.querySelector('.rp-map-camera-panel')!
                  .getBoundingClientRect()
                const stage = document.querySelector('[data-graph-stage]')!.getBoundingClientRect()
                return {
                  fit: fit.toJSON(),
                  panel: panel.toJSON(),
                  stage: stage.toJSON(),
                  viewportHeight: innerHeight,
                }
              })
              expect(inside.fit.bottom, scene).toBeLessThanOrEqual(inside.viewportHeight + 1)
              expect(inside.fit.top, scene).toBeGreaterThanOrEqual(
                Math.max(0, inside.panel.top) - 1,
              )
              await click(page, 'Fit the whole map to view')
            }
            await Deno.writeFile(`${directory}/${scene}.png`, await page.screenshot())
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
