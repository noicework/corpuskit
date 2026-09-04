import { expect } from '@std/expect'
import { describe, it } from '@std/testing/bdd'
import { clusterCentres3D, ForceSim3D, type SimLink3D } from './force3d.ts'

// ---------------------------------------------------------------------------
// Test fixtures. Small, deterministic node/link sets that exercise each force
// without needing hundreds of nodes to see the effect.
// ---------------------------------------------------------------------------

function dist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function freeNodes(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, group: 'a', radius: 8 }))
}

describe('ForceSim3D determinism', () => {
  it('produces bit-identical positions from identical input after 300 ticks', () => {
    const nodes = freeNodes(24)
    const links: SimLink3D[] = Array.from({ length: 20 }, (_, i) => ({
      source: `n${i % 24}`,
      target: `n${(i * 7 + 3) % 24}`,
    }))
    const build = () => new ForceSim3D({ nodes, links, layout: 'free', centres: new Map() })
    const simA = build()
    const simB = build()
    simA.tick(300)
    simB.tick(300)
    for (const node of simA.nodes) {
      const other = simB.byId(node.id)
      expect(other).toBeDefined()
      expect(other?.x).toBe(node.x)
      expect(other?.y).toBe(node.y)
      expect(other?.z).toBe(node.z)
    }
  })
})

describe('ForceSim3D initial placement', () => {
  it('keeps a node constructed with explicit x/y/z exactly, before any tick', () => {
    const sim = new ForceSim3D({
      nodes: [
        { id: 'placed', group: 'a', radius: 8, x: 12.5, y: -4.25, z: 100 },
        { id: 'unplaced', group: 'a', radius: 8 },
      ],
      links: [],
      layout: 'free',
      centres: new Map(),
    })
    const placed = sim.byId('placed')
    expect(placed?.x).toBe(12.5)
    expect(placed?.y).toBe(-4.25)
    expect(placed?.z).toBe(100)
  })

  it('gives unplaced nodes distinct deterministic starting points', () => {
    const sim = new ForceSim3D({
      nodes: freeNodes(12),
      links: [],
      layout: 'free',
      centres: new Map(),
    })
    const seen = new Set<string>()
    for (const node of sim.nodes) {
      const key = `${node.x.toFixed(6)},${node.y.toFixed(6)},${node.z.toFixed(6)}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

describe('ForceSim3D links (free layout)', () => {
  it('pulls linked pairs much closer than unlinked pairs after 300 ticks', () => {
    const nodes = freeNodes(16)
    // A handful of links forming three disjoint pairs/chains, so "linked"
    // and "unlinked" pair sets are both large enough to average meaningfully.
    const links: SimLink3D[] = [
      { source: 'n0', target: 'n1' },
      { source: 'n2', target: 'n3' },
      { source: 'n4', target: 'n5' },
      { source: 'n6', target: 'n7' },
      { source: 'n8', target: 'n9' },
    ]
    const sim = new ForceSim3D({ nodes, links, layout: 'free', centres: new Map() })
    sim.tick(300)

    const linkedKey = new Set(links.map((l) => [l.source, l.target].sort().join('|')))
    let linkedTotal = 0
    let linkedCount = 0
    let unlinkedTotal = 0
    let unlinkedCount = 0
    for (let i = 0; i < sim.nodes.length; i++) {
      for (let j = i + 1; j < sim.nodes.length; j++) {
        const a = sim.nodes[i]
        const b = sim.nodes[j]
        if (!a || !b) continue
        const key = [a.id, b.id].sort().join('|')
        const d = dist(a, b)
        if (linkedKey.has(key)) {
          linkedTotal += d
          linkedCount++
        } else {
          unlinkedTotal += d
          unlinkedCount++
        }
      }
    }
    const meanLinked = linkedTotal / linkedCount
    const meanUnlinked = unlinkedTotal / unlinkedCount
    expect(meanLinked).toBeLessThan(meanUnlinked * 0.5)
  })
})

describe('ForceSim3D grouped layout', () => {
  it('holds nodes near their group centre and keeps two groups clearly separated', () => {
    const groupCounts = new Map([
      ['alpha', 10],
      ['beta', 8],
    ])
    const centres = clusterCentres3D(groupCounts, 1.4)
    const nodes = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, group: 'alpha', radius: 8 })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, group: 'beta', radius: 8 })),
    ]
    const links: SimLink3D[] = Array.from({ length: 8 }, (_, i) => ({
      source: `a${i % 10}`,
      target: `a${(i + 1) % 10}`,
    }))
    const sim = new ForceSim3D({ nodes, links, layout: 'grouped', centres })
    sim.tick(300)

    for (const node of sim.nodes) {
      const centre = centres.get(node.group)
      expect(centre).toBeDefined()
      if (!centre) continue
      // A sane multiple of the blob radius the centre was sized for - the
      // links and charge force perturb nodes around it, but they should
      // never drift away to somewhere near the other group's territory.
      expect(dist(node, centre)).toBeLessThan(centre.r * 3)
    }

    const centroidOf = (group: string) => {
      const members = sim.nodes.filter((n) => n.group === group)
      const sum = members.reduce(
        (acc, n) => ({ x: acc.x + n.x, y: acc.y + n.y, z: acc.z + n.z }),
        { x: 0, y: 0, z: 0 },
      )
      return { x: sum.x / members.length, y: sum.y / members.length, z: sum.z / members.length }
    }
    const alphaCentre = centres.get('alpha')
    const betaCentre = centres.get('beta')
    expect(alphaCentre).toBeDefined()
    expect(betaCentre).toBeDefined()
    if (!alphaCentre || !betaCentre) return
    const centroidGap = dist(centroidOf('alpha'), centroidOf('beta'))
    expect(centroidGap).toBeGreaterThan((alphaCentre.r + betaCentre.r) * 0.5)
  })
})

describe('ForceSim3D collide', () => {
  it('keeps unlinked, variably-sized nodes from materially overlapping after 300 ticks', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      group: 'a',
      radius: 6 + (i % 5) * 3,
    }))
    const sim = new ForceSim3D({ nodes, links: [], layout: 'free', centres: new Map() })
    sim.tick(300)

    const tolerance = 2
    for (let i = 0; i < sim.nodes.length; i++) {
      for (let j = i + 1; j < sim.nodes.length; j++) {
        const a = sim.nodes[i]
        const b = sim.nodes[j]
        if (!a || !b) continue
        const minGap = a.radius + 5 + (b.radius + 5)
        expect(dist(a, b)).toBeGreaterThanOrEqual(minGap - tolerance)
      }
    }
  })
})

describe('ForceSim3D pin/unpin', () => {
  it('holds a pinned node exactly through ticks while others move, then frees it on unpin', () => {
    const sim = new ForceSim3D({
      nodes: freeNodes(10),
      links: [
        { source: 'n0', target: 'n1' },
        { source: 'n1', target: 'n2' },
      ],
      layout: 'free',
      centres: new Map(),
    })
    sim.tick(20)
    const others = sim.nodes.filter((n) => n.id !== 'n0').map((n) => ({ ...n }))

    sim.pin('n0', 40, -15, 8)
    sim.tick(1)
    const pinnedFirst = sim.byId('n0')
    expect(pinnedFirst?.x).toBe(40)
    expect(pinnedFirst?.y).toBe(-15)
    expect(pinnedFirst?.z).toBe(8)

    sim.tick(30)
    const pinnedAfter = sim.byId('n0')
    expect(pinnedAfter?.x).toBe(40)
    expect(pinnedAfter?.y).toBe(-15)
    expect(pinnedAfter?.z).toBe(8)

    const moved = others.some((before) => {
      const after = sim.byId(before.id)
      return after && dist(before, after) > 1e-4
    })
    expect(moved).toBe(true)

    sim.unpin('n0')
    sim.tick(30)
    const freed = sim.byId('n0')
    expect(freed).toBeDefined()
    if (!freed) return
    expect(dist(freed, { x: 40, y: -15, z: 8 })).toBeGreaterThan(0.5)
  })

  it('is a no-op for an unknown id', () => {
    const sim = new ForceSim3D({
      nodes: freeNodes(3),
      links: [],
      layout: 'free',
      centres: new Map(),
    })
    sim.pin('ghost', 1, 2, 3)
    sim.unpin('ghost')
    expect(sim.byId('ghost')).toBeUndefined()
  })
})

describe('ForceSim3D reheat/cool', () => {
  it('reheat raises a settled alpha to at least 0.25, and cool lets it decay again', () => {
    const sim = new ForceSim3D({
      nodes: freeNodes(10),
      links: [],
      layout: 'free',
      centres: new Map(),
    })
    sim.tick(300)
    expect(sim.alpha()).toBeLessThan(0.05)

    sim.reheat()
    expect(sim.alpha()).toBeGreaterThanOrEqual(0.25)

    sim.cool()
    sim.tick(150)
    expect(sim.alpha()).toBeLessThan(0.05)
  })
})

describe('clusterCentres3D', () => {
  it('places a single group at the origin', () => {
    const centres = clusterCentres3D(new Map([['solo', 12]]), 1)
    const centre = centres.get('solo')
    expect(centre).toBeDefined()
    expect(centre?.x).toBe(0)
    expect(centre?.y).toBe(0)
    expect(centre?.z).toBe(0)
  })

  it('keeps multiple groups pairwise non-overlapping, in the order given', () => {
    const groups = new Map([
      ['big', 30],
      ['mid', 12],
      ['small', 4],
    ])
    const centres = clusterCentres3D(groups, 1.3)
    expect([...centres.keys()]).toEqual(['big', 'mid', 'small'])
    const entries = [...centres.entries()]
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]
        const b = entries[j]
        if (!a || !b) continue
        const [, ca] = a
        const [, cb] = b
        const gap = Math.hypot(ca.x - cb.x, ca.y - cb.y, ca.z - cb.z)
        expect(gap).toBeGreaterThanOrEqual(ca.r + cb.r)
      }
    }
  })

  it('alternates the Y offset sign by index', () => {
    const groups = new Map([
      ['g0', 5],
      ['g1', 5],
      ['g2', 5],
      ['g3', 5],
    ])
    const centres = clusterCentres3D(groups, 1.2)
    const ys = [...centres.values()].map((c) => c.y)
    expect(ys[0]).toBeGreaterThan(0)
    expect(ys[1]).toBeLessThan(0)
    expect(ys[2]).toBeGreaterThan(0)
    expect(ys[3]).toBeLessThan(0)
  })

  it('stretches x further than z as the aspect ratio widens', () => {
    const groups = new Map([
      ['g0', 6],
      ['g1', 6],
      ['g2', 6],
    ])
    const wide = [...clusterCentres3D(groups, 2.2).values()]
    const narrow = [...clusterCentres3D(groups, 0.7).values()]
    const spread = (centres: { x: number; z: number }[], axis: 'x' | 'z') =>
      Math.max(...centres.map((c) => Math.abs(c[axis])))
    expect(spread(wide, 'x')).toBeGreaterThan(spread(narrow, 'x'))
    expect(spread(wide, 'z')).toBeLessThan(spread(narrow, 'z'))
  })
})

describe('ForceSim3D free-layout stability', () => {
  it('keeps equal-sized groups bounded and finite - the coincident-spiral regression', () => {
    // Two groups of equal size share the origin spiral in the free layout; a
    // per-group index would start their i-th nodes at identical coordinates
    // and the charge force would fling the layout to ~1e8 units.
    const nodes = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, group: 'alpha', radius: 8 })),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, group: 'beta', radius: 8 })),
    ]
    const sim = new ForceSim3D({ nodes, links: [], layout: 'free', centres: new Map() })
    sim.tick(300)
    for (const node of sim.nodes) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
      expect(Number.isFinite(node.z)).toBe(true)
      expect(Math.hypot(node.x, node.y, node.z)).toBeLessThan(2000)
    }
  })

  it('separates two nodes pinned onto the same point instead of detonating', () => {
    const sim = new ForceSim3D({
      nodes: [
        { id: 'a', group: 'g', radius: 8, x: 5, y: 5, z: 5 },
        { id: 'b', group: 'g', radius: 8, x: 5, y: 5, z: 5 },
      ],
      links: [],
      layout: 'free',
      centres: new Map(),
    })
    sim.tick(300)
    const a = sim.byId('a')
    const b = sim.byId('b')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (!a || !b) return
    const gap = dist(a, b)
    expect(gap).toBeGreaterThan(1)
    expect(Math.hypot(a.x, a.y, a.z)).toBeLessThan(2000)
    expect(Math.hypot(b.x, b.y, b.z)).toBeLessThan(2000)
  })
})
