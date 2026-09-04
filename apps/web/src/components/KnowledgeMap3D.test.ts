import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { scheduleMapReadyAfterPaint } from './KnowledgeMap3D.tsx'
import { clusterScreenPx, nextFold } from './map3d-engine.ts'

const [graphPage, mapSource] = await Promise.all([
  Deno.readTextFile(new URL('../pages/GraphPage.tsx', import.meta.url)),
  Deno.readTextFile(new URL('./KnowledgeMap.tsx', import.meta.url)),
])

function frameHarness() {
  let nextId = 1
  let pending = new Map<number, FrameRequestCallback>()

  return {
    schedule(callback: FrameRequestCallback) {
      const id = nextId++
      pending.set(id, callback)
      return id
    },
    cancel(id: number) {
      pending.delete(id)
    },
    flush() {
      const frame = pending
      pending = new Map()
      for (const callback of frame.values()) callback(0)
    },
    get pendingCount() {
      return pending.size
    },
  }
}

describe('KnowledgeMap3D readiness', () => {
  it('reveals only after the settled scene has crossed a paint boundary', () => {
    const frames = frameHarness()
    let ready = false

    scheduleMapReadyAfterPaint(
      () => ready = true,
      (callback) => frames.schedule(callback),
      (id) => frames.cancel(id),
    )

    expect(frames.pendingCount).toBe(1)
    frames.flush()
    expect(ready).toBe(false)
    expect(frames.pendingCount).toBe(1)
    frames.flush()
    expect(ready).toBe(true)
  })

  it('cancels a stale reveal when the scene changes or unmounts', () => {
    const frames = frameHarness()
    let calls = 0
    const cancel = scheduleMapReadyAfterPaint(
      () => calls += 1,
      (callback) => frames.schedule(callback),
      (id) => frames.cancel(id),
    )

    frames.flush()
    cancel()
    frames.flush()

    expect(calls).toBe(0)
  })
})

describe('semantic zoom - when a category folds into one mark', () => {
  // Below the collapse threshold, above the expand threshold, and the gap
  // between them where the answer depends on where the reader came from.
  const TIGHT = 40
  const WIDE = 120
  const BETWEEN = 76

  it('folds a cluster that has become too small to tell apart', () => {
    expect(nextFold(0, TIGHT)).toBe(1)
  })

  it('unfolds one that has grown big enough to read', () => {
    expect(nextFold(1, WIDE)).toBe(0)
  })

  it('holds its state in the hysteresis band, so a notch at the boundary cannot flicker', () => {
    // The same width resolves both ways: whichever state the cluster is
    // already in survives, which is the whole point of the gap.
    expect(nextFold(0, BETWEEN)).toBe(0)
    expect(nextFold(1, BETWEEN)).toBe(1)
  })

  it('keeps a cluster holding the selection open however far out the camera goes', () => {
    expect(nextFold(0, TIGHT, { pinned: true })).toBe(0)
    expect(nextFold(1, TIGHT, { pinned: true })).toBe(0)
  })

  it('holds a just-opened cluster open against the collapse rule', () => {
    expect(nextFold(0, TIGHT, { dived: true })).toBe(0)
    // ... but a dive never blocks the unfold half of the rule.
    expect(nextFold(1, WIDE, { dived: true })).toBe(0)
  })

  it('measures the fold in screen pixels, so pulling back folds and coming in unfolds', () => {
    const spread = 180
    const height = 800
    const near = clusterScreenPx(spread, height, 300)
    const far = clusterScreenPx(spread, height, 3000)
    expect(near).toBeGreaterThan(far)
    expect(nextFold(0, far)).toBe(1)
    expect(nextFold(1, near)).toBe(0)
  })

  it('folds the smaller of two clusters first as the reader zooms out', () => {
    const height = 800
    // A distance at which the big cluster still reads and the small one does not.
    const dist = 2000
    const big = clusterScreenPx(260, height, dist)
    const small = clusterScreenPx(90, height, dist)
    expect(small).toBeLessThan(big)
    expect(nextFold(0, small)).toBe(1)
    expect(nextFold(0, big)).toBe(0)
  })

  it('folds more on a short canvas than a tall one at the same distance', () => {
    // The rule is in pixels, not world units, so a phone folds sooner than a
    // desktop without a second threshold to keep in step.
    const phone = clusterScreenPx(180, 640, 1200)
    const desktop = clusterScreenPx(180, 1400, 1200)
    expect(phone).toBeLessThan(desktop)
  })
})

describe('knowledge map loading state', () => {
  it('keeps loading accessible without restoring the visible loader', () => {
    expect(graphPage).toContain('aria-busy={mapBusy}')
    expect(graphPage).toContain("mapBusy ? 'Loading knowledge map.'")
    expect(graphPage).toContain("hasGraph ? 'Knowledge map ready.'")
    expect(graphPage).not.toContain('Building the map')
    expect(mapSource).not.toContain('function MapSkeleton')
  })
})
