import { expect } from '@std/expect'
import * as THREE from 'three'
import {
  findMapCaptionBox,
  KnowledgeMapEngine,
  legibleOpacity,
  observeMapAppearance,
} from './map3d-engine.ts'
import { clusterCentres3D } from '../lib/force3d.ts'

const plate = { x1: 6, y1: 6, x2: 384, y2: 584 }

Deno.test('category captions move away from neighbouring marks and previous captions', () => {
  const anchor = { x: 195, y: 220, r: 20 }
  const neighbour = { sx: 195, sy: 180, screenR: 12, opacity: 1, ok: true }
  const occupied = [{ x1: 130, y1: 246, x2: 260, y2: 270 }]
  const placed = findMapCaptionBox(120, 17, anchor, plate, occupied, [neighbour])
  expect(placed).not.toBeNull()
  if (!placed) return
  expect(placed.y2 <= neighbour.sy - neighbour.screenR || placed.y1 > neighbour.sy + 12)
    .toBe(true)
  expect(placed.y2 <= occupied[0]!.y1 || placed.y1 >= occupied[0]!.y2).toBe(true)
  expect(placed.x1).toBeGreaterThanOrEqual(plate.x1)
  expect(placed.x2).toBeLessThanOrEqual(plate.x2)
})

Deno.test('category captions clamp inward at the phone edge and reject a box with no safe space', () => {
  const placed = findMapCaptionBox(150, 17, { x: 10, y: 100, r: 12 }, plate, [], [])
  expect(placed?.x1).toBe(plate.x1)
  expect(placed?.y2).toBeLessThan(100 - 12)
  expect(findMapCaptionBox(400, 17, { x: 195, y: 100, r: 12 }, plate, [], []))
    .toBeNull()
  expect(findMapCaptionBox(150, 17, { x: 195, y: 100, r: 12 }, plate, [plate], []))
    .toBeNull()
})

Deno.test('a long entity label keeps its ends clear of a smaller neighbouring mark', () => {
  const mark = { sx: 240, sy: 170, screenR: 8, opacity: 1, ok: true }
  const placed = findMapCaptionBox(220, 20, { x: 150, y: 200, r: 10 }, plate, [], [mark])
  expect(placed).not.toBeNull()
  if (!placed) return
  expect(mark.sx < placed.x1 || mark.sx > placed.x2 || mark.sy < placed.y1 || mark.sy > placed.y2)
    .toBe(true)
})

Deno.test('map appearance follows its tenant scheme and ignores sibling tenants', () => {
  const tenant = {} as Element
  const sibling = {} as Element
  const body = {} as HTMLElement
  const root = {} as HTMLElement
  const observed = new Map<Node, MutationObserverInit>()
  let callback: MutationCallback | undefined
  const Observer = class {
    constructor(onChange: MutationCallback) {
      callback = onChange
    }
    observe(target: Node, options: MutationObserverInit) {
      observed.set(target, options)
    }
    disconnect() {}
    takeRecords() {
      return []
    }
  } as unknown as typeof MutationObserver
  const element = {
    closest: (selector: string) => selector === '.rp-tenant' ? tenant : null,
    ownerDocument: { body, documentElement: root },
  } as HTMLElement
  let refreshes = 0
  const observer = observeMapAppearance(element, () => refreshes++, Observer)
  const mutate = (target: Node, attributeName: string) => {
    if (!observed.get(target)?.attributeFilter?.includes(attributeName)) return
    callback?.([{ target, attributeName } as MutationRecord], observer)
  }
  mutate(tenant, 'data-colour-scheme')
  mutate(tenant, 'style')
  mutate(sibling, 'data-colour-scheme')
  expect(refreshes).toBe(2)
  expect(observed.has(tenant)).toBe(true)
  expect(observed.has(sibling)).toBe(false)
})

Deno.test('phone overview fits hub and caption extents without a large vertical blank band', () => {
  const width = 390
  const height = 590
  const centres = clusterCentres3D(
    new Map([
      ['Species', 9],
      ['Researcher', 8],
      ['Location', 7],
      ['Project', 7],
      ['Organisation', 5],
      ['Pathogen', 5],
    ]),
    width / height,
  )
  const territories = [...centres.values()].map((centre) => ({
    centre: new THREE.Vector3(centre.x, centre.y, centre.z),
    r: centre.r,
    captionW: 170,
    captionHubW: 185,
    hub: { anchor: { r: 15 + 6.2 * Math.sqrt(7) } },
  }))
  const worldCentre = territories.reduce(
    (sum, territory) => sum.add(territory.centre),
    new THREE.Vector3(),
  ).multiplyScalar(1 / territories.length)
  // Exercise the fit solver directly, without a browser or WebGL context.
  const engine = Object.assign(Object.create(KnowledgeMapEngine.prototype), {
    width,
    height,
    overviewFold: true,
    captionH: 17,
    captionHubH: 18,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    worldCentre,
    fitCentre: new THREE.Vector3(),
    fitVecE: new THREE.Vector3(),
    fitVecRight: new THREE.Vector3(),
    fitVecUp: new THREE.Vector3(),
    fitVecD: new THREE.Vector3(),
    edgeUp: new THREE.Vector3(0, 1, 0),
    nodeVisuals: new Map(),
    territories,
    camera: new THREE.PerspectiveCamera(40, width / height, 2, 9000),
    view: { theta: -0.5, phi: 0.95 },
  }) as { fitDistance: () => number; fitCentre: THREE.Vector3 }
  const distance = engine.fitDistance()
  const camera = new THREE.PerspectiveCamera(40, width / height, 2, 9000)
  camera.position.copy(engine.fitCentre).add(
    new THREE.Vector3(
      distance * Math.sin(0.95) * Math.sin(-0.5),
      distance * Math.cos(0.95),
      distance * Math.sin(0.95) * Math.cos(-0.5),
    ),
  )
  camera.lookAt(engine.fitCentre)
  camera.updateMatrixWorld()
  let top = height
  let bottom = 0
  for (const territory of territories) {
    const point = territory.centre.clone().project(camera)
    const x = (point.x + 1) * width / 2
    const y = (1 - point.y) * height / 2
    const radius = territory.hub.anchor.r * 1.3 * (height / 2) /
      (territory.centre.distanceTo(camera.position) * Math.tan(Math.PI / 9))
    expect(x - radius).toBeGreaterThan(0)
    expect(x + radius).toBeLessThan(width)
    expect(y - radius - 22).toBeGreaterThan(0)
    expect(y + radius).toBeLessThan(height)
    top = Math.min(top, y - radius - 22)
    bottom = Math.max(bottom, y + radius)
  }
  expect(top).toBeLessThan(height * 0.15)
  expect(height - bottom).toBeLessThan(height * 0.15)
})

Deno.test('a fading label stops where its ink would fall under 4.5:1 on the paper', () => {
  const hex = (h: string) =>
    [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
  const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
  const contrast = (a: number[], b: number[]) =>
    (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  const pairs: [string, string][] = [
    ['#5b5851', '#ffffff'], // the house secondary ink on white
    ['#cfd2d8', '#1a1c20'], // the dark suite
  ]
  for (const [ink, ground] of pairs) {
    const i = hex(ink)
    const g = hex(ground)
    const floor = legibleOpacity(i, g)
    const at = (a: number) => i.map((c, k) => c * a + g[k]! * (1 - a))
    expect(contrast(at(floor), g)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(at(floor - 0.03), g)).toBeLessThan(4.5)
    // The fade it replaces bottomed out at 0.35, around 2:1.
    expect(contrast(at(0.35), g)).toBeLessThan(3)
  }
  // An ink that cannot reach the ratio is never faded at all.
  expect(legibleOpacity(hex('#bbbbbb'), hex('#ffffff'))).toBe(1)
})
