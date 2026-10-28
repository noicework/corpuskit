import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, buildComponentFixture, sourcePath } from './support/rbac-fixture.ts'

const directory = '.planning/graph-a11y-2'
const axePath = Deno.env.get('AXE_PATH')
const axeSource = axePath ? await Deno.readTextFile(axePath) : null
const groups = ['Topic', 'Material', 'Experiment', 'Project', 'Location', 'Species']
const nodes = Array.from({ length: 72 }, (_, index) => ({
  id: `Study ${String(index + 1).padStart(2, '0')}`,
  group: groups[index % groups.length]!,
  weight: index % 9 + 1,
}))
const edges = nodes.flatMap((node, index) =>
  [1, 6].map((offset) => ({
    source: node.id,
    target: nodes[(index + offset) % nodes.length]!.id,
    label: 'examines',
  }))
)

function fixture() {
  const management = new Proxy({}, {
    get: (_target, method) => () => {
      if (method === 'relationsGraph') return Promise.resolve({ nodes, edges })
      if (['entityGroups', 'labelsets', 'listAgents'].includes(String(method))) {
        return Promise.resolve([])
      }
      throw new Error(`Unexpected fixture operation: ${String(method)}`)
    },
  }) as NonNullable<BuildAppOptions['management']>
  return startTestServer({ management })
}

async function click(page: Page, label: string) {
  await page.evaluate((label) => {
    const control = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.getAttribute('aria-label') || button.textContent?.trim()) === label &&
      button.getBoundingClientRect().width > 0
    )
    if (!control) throw new Error(`Missing graph control: ${label}`)
    control.click()
  }, { args: [label] })
}

async function paint(page: Page) {
  await page.evaluate(() =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  )
}

/** Read the actual WebGL drawing buffer, excluding DOM overlays and browser chrome. */
async function pixels(page: Page, save = false) {
  return await page.evaluate((save) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.rp-map3d canvas')!
    const gl = canvas.getContext('webgl2')!
    const bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
    gl.readPixels(
      0,
      0,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    )
    if (save) Reflect.set(globalThis, 'pausedMapPixels', bytes)
    const previous = Reflect.get(globalThis, 'pausedMapPixels') as Uint8Array
    let changed = 0
    let nonUniform = 0
    for (let index = 0; index < bytes.length; index += 4) {
      if (
        bytes.subarray(index, index + 4).some((value, offset) => value !== previous[index + offset])
      ) {
        changed++
      }
      if (bytes.subarray(index, index + 3).some((value, offset) => value !== bytes[offset])) {
        nonUniform++
      }
    }
    return { changed, nonUniform, width: canvas.width, height: canvas.height }
  }, { args: [save] })
}

Deno.test('dense map pause freezes every canvas pixel for six seconds and resumes', async () => {
  const server = fixture()
  const browser = await launch(), page = await browser.newPage('about:blank')
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 1280, height: 960 })
    // Preserve the drawing buffer only in this test so readPixels measures real rendered pixels.
    await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
      source: `
const original = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(kind, options) {
  return original.call(this, kind, /webgl/.test(kind)
    ? {...options, preserveDrawingBuffer:true} : options);
};`,
    })
    await page.goto(`${server.url}/t/marine/graph`)
    await page.waitForSelector('[data-graph-stage][aria-busy=false] canvas')
    // Pause while the dense scene's entrance animations may still be running.
    await click(page, 'Pause map motion')
    await paint(page)
    const before = await pixels(page, true)
    expect(before.nonUniform).toBeGreaterThan(100)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 6000)))
    const paused = await pixels(page)
    console.log('dense paused canvas', paused)
    expect(paused.changed).toBe(0)
    await click(page, 'Play map motion')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 750)))
    expect((await pixels(page)).changed).toBeGreaterThan(0)
    await click(page, 'Pause map motion')
    await paint(page)
    await pixels(page, true)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 6000)))
    expect((await pixels(page)).changed).toBe(0)
    await assertCurrentBuild(page)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('dense graph names categories in every navigator row and the complete list', async () => {
  const server = fixture()
  const browser = await launch(), page = await browser.newPage('about:blank')
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 1280, height: 960 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${server.url}/t/marine/graph`)
    await page.waitForSelector('[data-graph-items]')
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('[data-graph-items] > li')].map((item) => ({
        name: item.querySelector('h3 a')?.textContent,
        text: item.textContent,
      }))
    )
    expect(items.length).toBe(72)
    for (const node of nodes) {
      expect(items.find((item) => item.name === node.id)?.text).toContain(`Category: ${node.group}`)
    }
    await click(page, 'Map')
    await page.waitForSelector('[data-graph-stage][aria-busy=false] canvas')
    await click(page, 'Show all 72 entities')
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Map navigator"] li button')]
        .map((button) => button.textContent)
    )
    console.log('dense navigator first row', rows[0])
    expect(rows.length).toBe(72)
    for (const node of nodes) {
      expect(rows.find((row) => row?.includes(node.id))).toContain(node.group)
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('dense maps show whole legible labels in both themes at desktop and phone widths', async () => {
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
          defaultColourScheme: dark ? 'dark' : 'light',
          colourScheme: 'viewer',
        },
      })
      for (const width of [1280, 320]) {
        const page = await browser.newPage('about:blank')
        try {
          await page.bringToFront()
          await page.setViewportSize({ width, height: 960 })
          await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
          await page.goto(`${server.url}/t/marine/graph`)
          await page.waitForSelector('[data-graph-items]')
          await click(page, 'Map')
          await page.waitForSelector('[data-graph-stage][aria-busy=false] canvas')
          if (width < 768) await click(page, 'Browse')
          await click(page, 'Hide navigator')
          await click(page, 'Free')
          await click(page, 'Map controls')
          await click(page, 'Zoom out')
          await click(page, 'Zoom out')
          await paint(page)
          const measured = await page.evaluate(() => {
            const context = document.createElement('canvas').getContext('2d')!
            const luminance = (colour: string) => {
              context.fillStyle = colour
              context.fillRect(0, 0, 1, 1)
              const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
                .map((value) => {
                  const channel = value / 255
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
                })
              return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
            }
            const labels = [...document.querySelectorAll<HTMLElement>('.rp-map3d-label')]
              .filter((label) => label.style.display !== 'none')
            return {
              width: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              scheme: getComputedStyle(document.body).colorScheme,
              labels: labels.map((label) => {
                const style = getComputedStyle(label)
                const ink = luminance(style.color), ground = luminance(style.backgroundColor)
                return {
                  ratio: (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05),
                  opacity: style.opacity,
                }
              }),
            }
          })
          console.log('dense label contrast', { dark, ...measured })
          expect(measured.width).toBe(width)
          expect(measured.scrollWidth).toBeLessThanOrEqual(width + 1)
          expect(measured.scheme).toBe(dark ? 'dark' : 'light')
          expect(measured.labels.length).toBeGreaterThan(0)
          expect(measured.labels.length).toBeLessThanOrEqual(48)
          for (const label of measured.labels) {
            expect(label.opacity).toBe('1')
            expect(label.ratio).toBeGreaterThanOrEqual(4.5)
          }
          if (axeSource) {
            await page.evaluate(`${axeSource};void 0`)
            const violations = await page.evaluate(async () => {
              // deno-lint-ignore no-explicit-any
              const result = await (globalThis as any).axe.run(document, {
                runOnly: {
                  type: 'tag',
                  values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'],
                },
              })
              return result.violations
            })
            expect(violations).toEqual([])
          }
          await Deno.writeFile(
            `${directory}/dense-${dark ? 'dark' : 'light'}-${width}.png`,
            await page.screenshot(),
          )
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

Deno.test('landscape graph has compact chrome and a usable stage with row camera controls', async () => {
  const server = fixture()
  const browser = await launch(), page = await browser.newPage('about:blank')
  await Deno.mkdir(directory, { recursive: true })
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 844, height: 390 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.goto(`${server.url}/t/marine/graph`)
    await page.waitForSelector('[data-graph-items]')
    await click(page, 'Map')
    await page.waitForSelector('[data-graph-stage][aria-busy=false] canvas')
    await page.evaluate(() => document.documentElement.style.fontSize = '22px')
    await paint(page)
    const geometry = await page.evaluate(() => {
      const stage = document.querySelector('[data-graph-stage]')!.getBoundingClientRect()
      const masthead = [...document.querySelectorAll('[data-graph-masthead]')]
        .map((el) => el.getBoundingClientRect()).find((rect) => rect.height > 0)!
      return { stageHeight: stage.height, mastheadHeight: masthead.height, width: innerWidth }
    })
    console.log('landscape graph', geometry)
    await Deno.writeFile(`${directory}/landscape-before-controls.png`, await page.screenshot())
    expect(geometry.width).toBe(844)
    expect(geometry.stageHeight).toBeGreaterThanOrEqual(28 * 22)
    expect(geometry.mastheadHeight).toBeLessThanOrEqual(5 * 22)
    await click(page, 'Map controls')
    expect(
      await page.evaluate(() =>
        document.querySelector('.rp-map-camera-panel')?.hasAttribute('data-row')
      ),
    ).toBe(true)
    await Deno.writeFile(`${directory}/landscape-controls.png`, await page.screenshot())
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('camera controls use rows when an embedded map stage is too short for a column', async () => {
  const component = await buildComponentFixture({
    entrySource: `
import { createRoot } from 'react-dom/client'
import { MapCameraControls } from '${sourcePath('apps/web/src/components/MapCameraControls.tsx')}'
createRoot(document.getElementById('root')).render(
  <div style={{position:'relative',width:800,height:100}}>
    <MapCameraControls zoom={()=>{}} fit={()=>{}} pan={()=>{}} rotate={()=>{}}/>
  </div>
);
`,
  })
  const server = startTestServer({ componentFixture: component })
  const browser = await launch(), page = await browser.newPage('about:blank')
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 844, height: 390 })
    await page.goto(`${server.url}/__test/rbac-component`)
    await click(page, 'Map controls')
    await paint(page)
    expect(
      await page.evaluate(() =>
        document.querySelector('.rp-map-camera-panel')?.hasAttribute('data-row')
      ),
    ).toBe(true)
    const row = await page.evaluate(() => {
      const box = (label: string) =>
        document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect()
      const rotate = box('Rotate left'), pan = box('Pan left'), zoom = box('Zoom in')
      return {
        horizontal: rotate.left < pan.left && pan.left < zoom.left,
        aligned: Math.abs(rotate.bottom - zoom.bottom) < 1,
        targets: [rotate, pan, zoom].map((rect) => Math.min(rect.width, rect.height)),
      }
    })
    expect(row.horizontal).toBe(true)
    expect(row.aligned).toBe(true)
    for (const target of row.targets) expect(target).toBeGreaterThanOrEqual(44)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await component.close()
  }
})
