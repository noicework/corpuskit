import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'

// ---------------------------------------------------------------------------
// The knowledge map canvas.
//
// One force engine, two layouts and an explicit visual grammar. Nothing on
// this canvas is decorative: every channel carries a fact about the graph.
//
//   position  the category territory a node belongs to (grouped layout), and
//             within it, who it is linked to
//   colour    the category (the six --rp-cat-* hues, assigned largest set
//             first so the biggest categories get the most separable hues)
//   size      how connected the node is - the number of extracted relations
//             in the entity lens, the number of resources in the concept lens
//   presence  a node with no relations yet is drawn small and quiet rather
//             than at full strength, because it carries no structure
//   edge width  the strength of the link (relation count / shared resources)
//   edge arrow  the direction the relation was extracted in
//
// A real 3,900-document corpus shaped this: 120 entities but only 126 relations
// spread over 27 components, 18 of them single unlinked entities. A plain
// centred force layout renders that as one undifferentiated ball; grouping by
// category and quietening the unlinked nodes makes the real structure - a
// 69-node backbone plus a scatter of fragments - the thing you actually see.
// ---------------------------------------------------------------------------

/** The simulation's own coordinate space. The canvas fits it to the viewport. */
const SIM_W = 960
const SIM_H = 640

/**
 * The interactive zoom extent - one pair of bounds shared by the wheel, the
 * zoom buttons and the pinch gesture, so the three can never disagree about
 * how far in or out the map goes. Framing the WHOLE map is capped separately
 * and more tightly (see computeFit): labels are drawn in simulation units and
 * so grow with the zoom, which is a problem when fitting everything on a
 * narrow canvas and not when a reader has deliberately zoomed in.
 */
const MIN_K = 0.35
const MAX_K = 4

/**
 * The band the focus move lands in.
 *
 * k = 1 is the floor because it is the scale the canvas type was drawn at - a
 * node label is 12px and a relation label 10.5px - and it clears the k >= 0.62
 * threshold below which relation labels are suppressed altogether. Under it
 * the selected node's edges stop reading as labelled relations, which is the
 * whole point of moving to the node.
 *
 * 1.8 is the ceiling because past it a 390px-wide phone holds fewer than 220
 * simulation units across, and a same-category link is 62 of them: three link
 * lengths is about the least that still reads as a neighbourhood rather than
 * as one node and some stubs.
 */
const FOCUS_MIN_K = 1
const FOCUS_MAX_K = 1.8

/**
 * How long the view takes to move to a selection. The panels enter on a 400ms
 * fade (.rp-anim-fade), so the map arrives fractionally before the panel
 * finishes and the two read as one motion rather than as two events.
 */
const FOCUS_MS = 380

export type MapNode = {
  id: string
  label: string
  group: string
  weight: number
}

export type MapEdge = {
  source: string
  target: string
  label: string
  weight: number
}

export type MapLayout = 'grouped' | 'free'
export type MapMeasure = 'links' | 'resources'

export type GroupStyle = {
  /** 0-5, the --rp-cat-N slot (and the id suffix of its gradient / marker). */
  slot: number
  /** Fill for marks. */
  colour: string
  /** The same hue darkened to clear 4.5:1 on the surface - safe for text. */
  ink: string
  /** Categories past the sixth reuse the hues as rings, so they stay distinct. */
  hollow: boolean
  count: number
}

type SimNode = MapNode & {
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
  index?: number
}

type SimLink = { source: string | SimNode; target: string | SimNode }

type Transform = { x: number; y: number; k: number }
type Size = { w: number; h: number; ready: boolean }
/**
 * How much of the canvas the floating panels are covering, in canvas pixels.
 * Measured from the panels themselves by the page (see GraphPage), never
 * assumed: the detail sheet's height follows its content, which runs from two
 * connections to a long list of the resources an entity is mentioned in.
 */
export type Insets = { left: number; right: number; top: number; bottom: number }
type Centre = { x: number; y: number; r: number }

/**
 * Hue order. The six tokens are used in this order rather than 1..6 so that a
 * map with only four or five categories never has to spend both of the two
 * warm yellows (cat-2 orange and cat-4 amber), which are the pair most easily
 * confused at dot size. Amber is held back for the sixth category.
 */
const PALETTE_ORDER = [0, 1, 2, 4, 5, 3]

/** Canvas label - long programme titles get an ellipsis; panels show the full name. */
export function shortLabel(label: string): string {
  return label.length > 34 ? `${label.slice(0, 32)}…` : label
}

/**
 * Stable style per group, assigned largest category first so the categories a
 * reader meets most often get the most separable hues. Past the sixth
 * category the hues repeat as rings rather than fills, so two categories are
 * never drawn identically.
 */
export function buildGroupStyles(nodes: MapNode[]): Map<string, GroupStyle> {
  const counts = new Map<string, number>()
  for (const node of nodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1)
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const styles = new Map<string, GroupStyle>()
  ordered.forEach(([group, count], i) => {
    const slot = PALETTE_ORDER[i % PALETTE_ORDER.length] ?? 0
    styles.set(group, {
      slot,
      colour: `var(--rp-cat-${slot + 1})`,
      ink: `var(--rp-cat-${slot + 1}-ink)`,
      hollow: i >= PALETTE_ORDER.length,
      count,
    })
  })
  return styles
}

/** Relations touching each node - the map's own measure of connectedness. */
export function buildDegrees(edges: MapEdge[]): Map<string, number> {
  const degrees = new Map<string, number>()
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1)
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1)
  }
  return degrees
}

/**
 * Node radius. The entity lens sizes by relations, because the map is about
 * how things connect; the concept lens sizes by resources on a log scale,
 * because those counts span 1 to several thousand.
 */
export function radiusFor(measure: MapMeasure, value: number): number {
  const safe = Math.max(0, value)
  return measure === 'links'
    ? Math.min(26, 5.5 + 3.6 * Math.sqrt(safe))
    : Math.max(7, Math.min(26, 6 + 5.2 * Math.log10(1 + safe)))
}

/** Edge weight -> stroke width. Log scaled: concept overlaps run into thousands. */
function edgeWidth(weight: number): number {
  return Math.max(1, Math.min(7, 0.9 + 1.5 * Math.log10(1 + Math.max(0, weight))))
}

/**
 * Points spaced evenly along the PERIMETER of an ellipse, not evenly in angle.
 * On a stretched ring, equal angles bunch the categories up at the flat ends
 * and leave the long sides empty; equal arc length keeps them apart. Sampled
 * once per layout change over a fixed 720 steps, so it costs nothing per frame.
 */
function ellipseAngles(n: number, sx: number, sy: number): number[] {
  const steps = 720
  const cumulative = new Float64Array(steps + 1)
  let prevX = sx
  let prevY = 0
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const x = Math.cos(t) * sx
    const y = Math.sin(t) * sy
    cumulative[i] = (cumulative[i - 1] ?? 0) + Math.hypot(x - prevX, y - prevY)
    prevX = x
    prevY = y
  }
  const total = cumulative[steps] ?? 1
  const angles: number[] = []
  let cursor = 0
  for (let k = 0; k < n; k++) {
    // The three-quarter-perimeter offset lands the first (largest) category at
    // the top of the ellipse - true for any aspect, by the ellipse's own
    // symmetry - so the map is read from its biggest category downwards.
    const target = ((k / n + 0.75) % 1) * total
    cursor = 0
    while (cursor < steps && (cumulative[cursor + 1] ?? total) < target) cursor++
    angles.push((cursor / steps) * Math.PI * 2)
  }
  return angles
}

/**
 * Where each category sits. Categories are laid out on an ellipse whose aspect
 * follows the viewport, so a wide display is filled rather than letterboxed.
 * The ring is then grown until no two territories overlap - checked over every
 * pair rather than just neighbours, because stretching the ring can bring
 * non-adjacent categories closer than adjacent ones.
 */
export function clusterCentres(
  styles: Map<string, GroupStyle>,
  aspect: number,
): Map<string, Centre> {
  const groups = [...styles.entries()]
  const centres = new Map<string, Centre>()
  // Empirical: the blob a category settles into under the grouped forces, so
  // the ring can be sized before the simulation has run a single tick.
  const blobR = (count: number) => 30 * Math.sqrt(Math.max(1, count)) + 34
  if (groups.length === 0) return centres
  if (groups.length === 1) {
    const only = groups[0] as [string, GroupStyle]
    centres.set(only[0], { x: SIM_W / 2, y: SIM_H / 2, r: blobR(only[1].count) })
    return centres
  }
  const n = groups.length
  // The ellipse is stretched a little harder than the viewport so the fit pass
  // ends up close to width-bound rather than height-bound - a knowledge map
  // that leaves a third of a wide display empty is what this is meant to avoid.
  const stretch = Math.pow(Math.max(0.7, Math.min(2.2, aspect)), 0.85)
  const angles = ellipseAngles(n, stretch, 1 / stretch)
  const unit = angles.map((a) => ({ x: Math.cos(a) * stretch, y: Math.sin(a) / stretch }))
  let ring = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = unit[i]
      const b = unit[j]
      const ga = groups[i]
      const gb = groups[j]
      if (!a || !b || !ga || !gb) continue
      const gap = Math.hypot(a.x - b.x, a.y - b.y)
      if (gap <= 0) continue
      ring = Math.max(ring, (blobR(ga[1].count) + blobR(gb[1].count)) / gap)
    }
  }
  ring *= 1.04
  groups.forEach(([group, style], i) => {
    const point = unit[i] ?? { x: 0, y: 0 }
    centres.set(group, {
      x: SIM_W / 2 + point.x * ring,
      y: SIM_H / 2 + point.y * ring,
      r: blobR(style.count),
    })
  })
  return centres
}

// ---------------------------------------------------------------------------
// Edge geometry. Links are drawn as gentle arcs that stop at the node rim, so
// the arrowhead reads and dense neighbourhoods do not turn into a cross-hatch.
// Parallel relations between the same pair fan out instead of stacking.
// ---------------------------------------------------------------------------

type EdgeGeometry = { d: string; labelD: string; ex: number; ey: number }

function edgeGeometry(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r1: number,
  r2: number,
  curve: number,
): EdgeGeometry {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const gap = Math.min(r1 + r2 + 8, len - 2)
  const trim = gap / (r1 + r2 + 8 || 1)
  const sx = x1 + ux * r1 * trim
  const sy = y1 + uy * r1 * trim
  const ex = x2 - ux * (r2 * trim + 4)
  const ey = y2 - uy * (r2 * trim + 4)
  const off = curve * Math.min(44, len * 0.15)
  const cx = (sx + ex) / 2 - uy * off
  const cy = (sy + ey) / 2 + ux * off
  const d = `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${
    ex.toFixed(1)
  },${ey.toFixed(1)}`
  // textPath renders along the path direction, so a right-to-left arc would
  // set the relation label upside down. Mirror the path just for the label.
  const labelD = ex < sx
    ? `M${ex.toFixed(1)},${ey.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${sx.toFixed(1)},${
      sy.toFixed(1)
    }`
    : d
  return { d, labelD, ex, ey }
}

/** How far each edge bows, so parallel relations between a pair stay readable. */
function buildCurves(edges: MapEdge[]): number[] {
  const seen = new Map<string, number[]>()
  edges.forEach((edge, i) => {
    const key = edge.source < edge.target
      ? `${edge.source} ${edge.target}`
      : `${edge.target} ${edge.source}`
    const list = seen.get(key)
    if (list) list.push(i)
    else seen.set(key, [i])
  })
  const curves = new Array<number>(edges.length).fill(0.5)
  for (const list of seen.values()) {
    if (list.length === 1) continue
    list.forEach((edgeIndex, j) => {
      curves[edgeIndex] = (-1 + (2 * j) / (list.length - 1)) * 1.15
    })
  }
  return curves
}

// ---------------------------------------------------------------------------
// Live force simulation - positions live in a ref, a rAF loop repaints while
// the simulation is warm or a node is being dragged. React renders the
// structure; the loop only nudges coordinates.
// ---------------------------------------------------------------------------

function useLiveSimulation(
  nodes: MapNode[],
  edges: MapEdge[],
  layout: MapLayout,
  centres: Map<string, Centre>,
  radiusOf: (node: MapNode) => number,
) {
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]))
    const simNodes: SimNode[] = nodes.map((n) => {
      // Keep the position of nodes that survive a data change (expand).
      const existing = previous.get(n.id)
      return { ...n, x: existing?.x, y: existing?.y }
    })
    nodesRef.current = simNodes
    const simEdges: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target }))
    const centreOf = (node: SimNode) =>
      centres.get(node.group) ?? { x: SIM_W / 2, y: SIM_H / 2, r: 120 }
    const sameGroup = (link: SimLink) =>
      typeof link.source === 'object' && typeof link.target === 'object' &&
      link.source.group === link.target.group

    const simulation = forceSimulation<SimNode>(simNodes)
    if (layout === 'grouped') {
      simulation
        .force('charge', forceManyBody<SimNode>().strength(-165).distanceMax(300))
        .force(
          'link',
          forceLink<SimNode, SimLink>(simEdges)
            .id((d) => d.id)
            // A link that crosses categories is long and nearly slack, so the
            // territories hold their ground and the crossing link reads as the
            // exception it is; a link inside a category is short and firm, so
            // the local structure is what shapes the blob.
            .distance((l) => (sameGroup(l) ? 62 : 190))
            .strength((l) => (sameGroup(l) ? 0.5 : 0.015)),
        )
        // Deliberately gentle. A hard pull to the category's centre wins
        // against the links and packs each category into a hexagonal disc,
        // which is the original "ball of dots" problem five times over; this
        // is only strong enough to hold the territory while the links inside
        // it do the shaping.
        .force('x', forceX<SimNode>((d) => centreOf(d).x).strength(0.15))
        .force('y', forceY<SimNode>((d) => centreOf(d).y).strength(0.15))
    } else {
      simulation
        .force('charge', forceManyBody<SimNode>().strength(-150).distanceMax(520))
        .force(
          'link',
          forceLink<SimNode, SimLink>(simEdges).id((d) => d.id).distance(76).strength(0.6),
        )
        .force('center', forceCenter(SIM_W / 2, SIM_H / 2))
        // Without a positional pull, weakly connected and isolated entities
        // drift to the far edges and the map reads as scattered dust.
        .force('x', forceX<SimNode>(SIM_W / 2).strength(0.055))
        .force('y', forceY<SimNode>(SIM_H / 2).strength(0.055))
    }
    simulation.force(
      'collide',
      forceCollide<SimNode>().radius((d) => radiusOf(d) + 5).strength(0.9),
    )
    simRef.current = simulation

    // Settle the layout synchronously - instant, and immune to background-tab
    // rAF throttling. Live physics then only animates real interactions.
    simulation.stop()
    simulation.tick(300)
    setFrame((f) => f + 1)
    return () => {
      simulation.stop()
    }
  }, [nodes, edges, layout, centres, radiusOf])

  /** Wake the simulation (for a drag) and keep repainting until it cools. */
  const reheat = useCallback(() => {
    const simulation = simRef.current
    if (!simulation) return
    simulation.alphaTarget(0.25).restart()
    const loop = () => {
      setFrame((f) => f + 1)
      if ((simRef.current?.alpha() ?? 0) > 0.02) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }, [])

  const cool = useCallback(() => {
    simRef.current?.alphaTarget(0)
  }, [])

  return { nodesRef, frame, reheat, cool }
}

// ---------------------------------------------------------------------------
// Element measurement - the canvas is sized to whatever the viewport gives it,
// so the SVG viewBox is 1:1 with pixels and pointer maths stay exact at any
// size (no letterboxing).
// ---------------------------------------------------------------------------

function useElementSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size>({ w: SIM_W, h: SIM_H, ready: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      setSize((prev) =>
        prev.ready && prev.w === rect.width && prev.h === rect.height
          ? prev
          : { w: rect.width, h: rect.height, ready: true }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, size }
}

/** Frame the whole graph inside the part of the viewport the panels leave free. */
function computeFit(nodes: SimNode[], w: number, h: number, insets: Insets): Transform | null {
  const points = nodes.filter((n) => n.x !== undefined && n.y !== undefined)
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of points) {
    const x = node.x as number
    const y = node.y as number
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  // Territory captions and node labels sit above the marks, so the framed box
  // has to be a little taller than the points themselves.
  minY -= 46
  maxY += 14
  const boxW = Math.max(160, w - insets.left - insets.right)
  const boxH = Math.max(160, h - insets.bottom)
  const pad = Math.min(96, Math.max(40, Math.min(boxW, boxH) * 0.1))
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  // How far a fit may magnify. Node labels are drawn in the simulation's own
  // coordinates, so they grow with the zoom: a small graph in a tall, narrow
  // canvas fits on height long before its labels fit on width, and the concept
  // lens on a phone - eleven nodes carrying names like "International
  // Connections" - runs its labels straight off both edges at the old ceiling.
  // A canvas narrower than the simulation's own frame therefore stops framing
  // at 1:1, where the labels are the size they were designed at. Nothing wide
  // enough for the map's full layout is affected.
  const maxK = w >= 768 ? 1.75 : Math.max(1, (w / SIM_W) * 1.75)
  const k = Math.max(
    MIN_K,
    Math.min(maxK, Math.min((boxW - pad * 2) / spanX, (boxH - pad * 2) / spanY)),
  )
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return {
    x: insets.left + boxW / 2 - cx * k,
    y: boxH / 2 - cy * k,
    k,
  }
}

// ---------------------------------------------------------------------------
// Paint definitions. One soft territory wash and one arrowhead per hue, plus
// the accent used by the path trace - declared once, referenced by url().
// ---------------------------------------------------------------------------

const ALL_SLOTS = [0, 1, 2, 3, 4, 5]

function MapDefs() {
  return (
    <defs>
      <radialGradient id='rp-map-vignette' cx='50%' cy='42%' r='78%'>
        <stop offset='55%' stopColor='var(--rp-surface)' stopOpacity={0} />
        <stop offset='100%' stopColor='var(--rp-n-300)' stopOpacity={0.3} />
      </radialGradient>
      {ALL_SLOTS.map((slot) => (
        <Fragment key={slot}>
          <radialGradient id={`rp-map-wash-${slot}`}>
            <stop offset='0%' stopColor={`var(--rp-cat-${slot + 1})`} stopOpacity={0.13} />
            <stop offset='62%' stopColor={`var(--rp-cat-${slot + 1})`} stopOpacity={0.06} />
            <stop offset='100%' stopColor={`var(--rp-cat-${slot + 1})`} stopOpacity={0} />
          </radialGradient>
          <marker
            id={`rp-map-arrow-${slot}`}
            viewBox='0 0 10 10'
            refX='9'
            refY='5'
            markerWidth='4.5'
            markerHeight='4.5'
            orient='auto-start-reverse'
          >
            <path d='M0.5,1 L9,5 L0.5,9 Z' fill={`var(--rp-cat-${slot + 1})`} />
          </marker>
        </Fragment>
      ))}
      <marker
        id='rp-map-arrow-trace'
        viewBox='0 0 10 10'
        refX='9'
        refY='5'
        markerWidth='4.5'
        markerHeight='4.5'
        orient='auto-start-reverse'
      >
        <path d='M0.5,1 L9,5 L0.5,9 Z' fill='var(--rp-accent)' />
      </marker>
    </defs>
  )
}

// ---------------------------------------------------------------------------
// The canvas.
// ---------------------------------------------------------------------------

export function KnowledgeMap({
  nodes,
  edges,
  groupStyles,
  degrees,
  measure,
  layout,
  hiddenGroups,
  hideUnlinked,
  selectedId,
  pathEdges,
  pathFrom,
  onSelect,
  focusId,
  insets,
  hint,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  groupStyles: Map<string, GroupStyle>
  degrees: Map<string, number>
  measure: MapMeasure
  layout: MapLayout
  hiddenGroups: Set<string>
  hideUnlinked: boolean
  selectedId: string | null
  pathEdges: MapEdge[] | null
  pathFrom: string | null
  onSelect: (id: string | null) => void
  focusId: string | null
  /** Measured, not assumed - see the type. */
  insets: Insets
  hint: string
}) {
  const visibleNodes = useMemo(
    () =>
      nodes.filter((n) =>
        !hiddenGroups.has(n.group) && !(hideUnlinked && (degrees.get(n.id) ?? 0) === 0)
      ),
    [nodes, hiddenGroups, hideUnlinked, degrees],
  )
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds],
  )
  const curves = useMemo(() => buildCurves(visibleEdges), [visibleEdges])

  const { ref: sizeRef, size } = useElementSize()

  const radiusOf = useCallback(
    (node: MapNode) =>
      radiusFor(measure, measure === 'links' ? (degrees.get(node.id) ?? 0) : node.weight),
    [measure, degrees],
  )

  // Coarse buckets only: the territory ellipse follows the viewport shape, but
  // it must not re-run the layout on every pixel of a window drag.
  const aspectBucket = !size.ready || size.h < 1
    ? 1.5
    : size.w / size.h < 1
    ? 0.8
    : size.w / size.h < 1.45
    ? 1.2
    : 1.9
  const visibleStyles = useMemo(() => {
    const styles = new Map<string, GroupStyle>()
    const counts = new Map<string, number>()
    for (const node of visibleNodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1)
    for (const [group, style] of groupStyles) {
      const count = counts.get(group)
      if (count) styles.set(group, { ...style, count })
    }
    return styles
  }, [visibleNodes, groupStyles])
  const centres = useMemo(
    () => clusterCentres(visibleStyles, aspectBucket),
    [visibleStyles, aspectBucket],
  )

  const { nodesRef, frame, reheat, cool } = useLiveSimulation(
    visibleNodes,
    visibleEdges,
    layout,
    centres,
    radiusOf,
  )
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  // Two-finger gesture in flight: the identifiers of the two fingers being
  // tracked, how far apart and where they were when it started, and the graph
  // point that was under their midpoint - the point the zoom is anchored on.
  const pinchRef = useRef<
    { a: number; b: number; gap: number; k: number; gx: number; gy: number } | null
  >(null)
  // Set on pointer-up when a drag actually moved a node, so the click that
  // follows repositioning does not also fire a selection.
  const draggedRef = useRef(false)
  // Same idea for a pinch: the click some browsers synthesise when the last
  // finger leaves must not read as a tap on the background and clear the
  // selection the reader was just looking at.
  const gesturedRef = useRef(false)
  const fitSigRef = useRef<string>('')
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null)
  // Once a reader has panned or zoomed, the view is theirs and a resize must
  // not throw it away.
  const viewMovedRef = useRef(false)
  // True while the view is the one the focus move put there and the reader has
  // not touched it since. It is what lets the map give the space back when the
  // panel that caused the move goes away, without ever overriding a reader who
  // has moved on.
  const focusOwnsViewRef = useRef(false)
  // The transform the animation loop and the gesture handlers read. State
  // drives the render; this ref is the same value without making every
  // callback that reads it change identity on every frame.
  const transformRef = useRef(transform)
  transformRef.current = transform
  const animRef = useRef<number | null>(null)

  // One lookup table per paint instead of a linear scan per node and per edge:
  // at 120 nodes and 126 edges the scans were an O(n*e) pass on every frame of
  // a drag, which is exactly the budget the rAF loop does not have.
  const positions = useMemo(() => {
    void frame
    return new Map(nodesRef.current.map((n) => [n.id, n]))
  }, [nodesRef, frame, visibleNodes])

  const insetsRef = useRef(insets)
  insetsRef.current = insets

  const stopAnimation = useCallback(() => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current)
    animRef.current = null
  }, [])

  /**
   * Move the view to a transform over a short duration.
   *
   * The scale grows geometrically and the GRAPH point sitting under a fixed
   * screen anchor is what travels linearly - interpolating the translation
   * directly instead makes the map appear to swim sideways as the scale
   * changes under it. Both ends are exact, so the move always finishes on the
   * transform it was given.
   *
   * A reader who has asked for less motion gets the same destination without
   * the journey.
   */
  const animateTo = useCallback(
    (target: Transform, duration: number, anchor: { x: number; y: number }) => {
      stopAnimation()
      const from = transformRef.current
      if (
        Math.abs(target.x - from.x) < 0.5 && Math.abs(target.y - from.y) < 0.5 &&
        Math.abs(target.k - from.k) < 0.002
      ) return
      const reduced = typeof globalThis.matchMedia === 'function' &&
        globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced || duration <= 0) {
        setTransform(target)
        return
      }
      const g0x = (anchor.x - from.x) / from.k
      const g0y = (anchor.y - from.y) / from.k
      const g1x = (anchor.x - target.x) / target.k
      const g1y = (anchor.y - target.y) / target.k
      const ratio = target.k / from.k
      const started = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / duration)
        if (t >= 1) {
          animRef.current = null
          setTransform(target)
          return
        }
        // Ease out: the view leaves promptly and settles, which is what reads
        // as one motion with a panel arriving on the same curve.
        const e = 1 - Math.pow(1 - t, 3)
        const k = from.k * Math.pow(ratio, e)
        setTransform({
          x: anchor.x - (g0x + (g1x - g0x) * e) * k,
          y: anchor.y - (g0y + (g1y - g0y) * e) * k,
          k,
        })
        animRef.current = requestAnimationFrame(step)
      }
      animRef.current = requestAnimationFrame(step)
    },
    [stopAnimation],
  )

  useEffect(() => stopAnimation, [stopAnimation])

  /** Any deliberate gesture takes the view back off the focus move. */
  const claimView = useCallback(() => {
    stopAnimation()
    viewMovedRef.current = true
    focusOwnsViewRef.current = false
  }, [stopAnimation])

  const fitView = useCallback(() => {
    stopAnimation()
    focusOwnsViewRef.current = false
    const t = computeFit(nodesRef.current, size.w, size.h, insetsRef.current)
    if (t) setTransform(t)
    viewMovedRef.current = false
  }, [nodesRef, size.w, size.h, stopAnimation])

  // Frame the graph whenever the visible set or the layout changes shape (first
  // load, mode switch, group toggle, expand), and keep it framed when the
  // canvas itself changes size. That last part matters on a phone, where the
  // canvas is most of the screen: the strip's find field opening, an iOS URL
  // bar sliding away and back, or a rotation all resize the box under a
  // simulation whose coordinates do not move with it, and a map fitted to the
  // old box leaves nodes outside the new one. A reader who has panned or
  // zoomed keeps their own view - it is shifted by half the change instead, so
  // whatever they had centred stays centred. Opening a panel still keeps the
  // view either way: the insets are deliberately not a trigger here.
  useEffect(() => {
    if (!size.ready) return
    const previous = lastSizeRef.current
    lastSizeRef.current = { w: size.w, h: size.h }
    const sig = `${layout}|${aspectBucket}|${visibleNodes.map((n) => n.id).join('|')}`
    if (sig !== fitSigRef.current) {
      const t = computeFit(nodesRef.current, size.w, size.h, insetsRef.current)
      if (t) {
        setTransform(t)
        fitSigRef.current = sig
        viewMovedRef.current = false
      }
      return
    }
    if (!previous || (previous.w === size.w && previous.h === size.h)) return
    // A focus move already has the view in hand and is steering it to a point
    // it computed from the new box; a half-delta shift on top would fight it.
    if (animRef.current !== null) return
    if (!viewMovedRef.current) {
      const t = computeFit(nodesRef.current, size.w, size.h, insetsRef.current)
      if (t) setTransform(t)
      return
    }
    const dx = (size.w - previous.w) / 2
    const dy = (size.h - previous.h) / 2
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
    // nodesRef is a stable ref; positions are settled by useLiveSimulation's
    // effect, which runs before this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNodes, layout, aspectBucket, size.ready, size.w, size.h])

  const focus = selectedId ?? hoveredId
  const neighbourIds = useMemo(() => {
    if (!focus) return null
    const ids = new Set<string>([focus])
    for (const e of visibleEdges) {
      if (e.source === focus) ids.add(e.target)
      if (e.target === focus) ids.add(e.source)
    }
    return ids
  }, [focus, visibleEdges])

  const pathNodeIds = useMemo(() => {
    if (!pathEdges) return null
    const ids = new Set<string>()
    for (const e of pathEdges) {
      ids.add(e.source)
      ids.add(e.target)
    }
    return ids
  }, [pathEdges])

  const pathEdgeKeys = useMemo(
    () => pathEdges ? new Set(pathEdges.map((e) => `${e.source}|${e.label}|${e.target}`)) : null,
    [pathEdges],
  )

  /**
   * Move the view so the selected node sits in the middle of the space that is
   * actually left - the canvas minus whatever the panels are measured to be
   * covering - and zoom in far enough that the node and the relations leaving
   * it read. Returns the scale it settled on, or null if it decided the node
   * was already comfortably in view and left the reader alone.
   *
   * `keep` reuses the scale from an earlier pass at the same node, for the
   * follow-up that runs when a panel finishes measuring or grows with its
   * content: the move should re-centre without a second helping of zoom.
   */
  const focusOn = useCallback((id: string, keep: number | null): number | null => {
    const points = new Map(nodesRef.current.map((n) => [n.id, n]))
    const node = points.get(id)
    if (!node || node.x === undefined || node.y === undefined) return null
    const box = insetsRef.current
    const boxW = Math.max(1, size.w - box.left - box.right)
    const boxH = Math.max(1, size.h - box.bottom)
    const cx = box.left + boxW / 2
    const cy = boxH / 2
    const current = transformRef.current

    // Is it already where a reader would want it? A node in the middle of the
    // free box needs nothing done to it, and moving the map under someone who
    // can already see what they clicked is worse than doing nothing. A bottom
    // sheet is the exception: it covers the canvas rather than sitting beside
    // it, so a selection made under one is always re-framed.
    const marginX = Math.min(90, boxW * 0.18)
    const marginY = Math.min(90, boxH * 0.18)
    const screenX = current.x + node.x * current.k
    const screenY = current.y + node.y * current.k
    const settled = screenX > box.left + marginX && screenX < box.left + boxW - marginX &&
      screenY > marginY && screenY < boxH - marginY
    if (settled && box.bottom <= 0) return null

    let k = keep
    if (k === null) {
      // How much of the map the node's own neighbourhood needs. Measured as a
      // half-extent from the node, because the node is what ends up centred.
      let spanX = radiusOf(node) + 18
      let spanY = radiusOf(node) + 26
      for (const edge of visibleEdges) {
        const otherId = edge.source === id ? edge.target : edge.target === id ? edge.source : null
        if (otherId === null) continue
        const other = points.get(otherId)
        if (!other || other.x === undefined || other.y === undefined) continue
        spanX = Math.max(spanX, Math.abs(other.x - node.x) + radiusOf(other))
        spanY = Math.max(spanY, Math.abs(other.y - node.y) + radiusOf(other) + 18)
      }
      const fits = Math.min((boxW * 0.9) / (2 * spanX), (boxH * 0.9) / (2 * spanY))
      // A hub whose neighbours are scattered would need to zoom OUT to hold
      // them all, and a lone entity would let the zoom run away, so the fit is
      // only ever consulted inside the legible band - and never at the cost of
      // a zoom the reader chose for themselves.
      k = Math.max(current.k, Math.min(FOCUS_MAX_K, Math.max(FOCUS_MIN_K, fits)))
    }
    k = Math.min(MAX_K, Math.max(MIN_K, k))

    animateTo({ x: cx - node.x * k, y: cy - node.y * k, k }, FOCUS_MS, { x: cx, y: cy })
    // The view is no longer the fit, so a later resize preserves it rather
    // than re-framing the whole map over the top of it.
    viewMovedRef.current = true
    focusOwnsViewRef.current = true
    return k
  }, [nodesRef, size.w, size.h, visibleEdges, radiusOf, animateTo])

  // An explicit request to bring a node into view - the find field, or the
  // navigator picking the entity that is already selected. Counted rather than
  // read directly, so asking twice for the same node moves the view twice.
  const [focusPulse, setFocusPulse] = useState(0)
  useEffect(() => {
    if (focusId) setFocusPulse((n) => n + 1)
  }, [focusId])

  const focusServicedRef = useRef<
    { id: string; pulse: number; box: Insets; k: number | null } | null
  >(null)
  const lastInsetsRef = useRef<Insets | null>(null)

  // Bring the selection into the space the panels leave free, and hand the
  // space back when they go.
  useEffect(() => {
    if (!size.ready) return
    const previous = lastInsetsRef.current
    lastInsetsRef.current = insets
    const id = focusId ?? selectedId
    if (id) {
      const done = focusServicedRef.current
      // The panels are measured after they mount, so the first pass at a new
      // selection can run against a stale box; the second pass re-centres in
      // the real one, keeping the scale the first pass chose. Both animate
      // from wherever the view currently is, so the correction is a redirected
      // glide rather than a second move.
      const following = done !== null && done.id === id && done.pulse === focusPulse
      if (
        following && done.box.left === insets.left && done.box.right === insets.right &&
        done.box.bottom === insets.bottom
      ) return
      const k = focusOn(id, following ? done.k : null)
      focusServicedRef.current = { id, pulse: focusPulse, box: insets, k }
      return
    }
    focusServicedRef.current = null
    // Nothing is selected any more and the panel that was covering the canvas
    // has gone. Rather than snapping back to some earlier transform - which
    // would throw away the neighbourhood the reader just went to the trouble
    // of opening - the view slides by half the change, so whatever was centred
    // in the old free box is centred in the new one at the same scale. It is
    // the same rule the resize path uses, and "Fit to view" is one tap away
    // for a reader who wants the whole map back.
    if (!previous || !focusOwnsViewRef.current) return
    const dx = ((insets.left - previous.left) - (insets.right - previous.right)) / 2
    const dy = -(insets.bottom - previous.bottom) / 2
    if (dx === 0 && dy === 0) return
    const t = transformRef.current
    animateTo({ ...t, x: t.x + dx, y: t.y + dy }, FOCUS_MS, { x: size.w / 2, y: size.h / 2 })
  }, [focusId, selectedId, focusPulse, insets, size.ready, size.w, size.h, focusOn, animateTo])

  /** Client coordinates to canvas coordinates. The viewBox is 1:1 with the
   * element's own pixels, but the element may itself be scaled by CSS, so the
   * conversion goes through the measured rect rather than assuming it. */
  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: rect.width > 0 ? ((clientX - rect.left) / rect.width) * size.w : 0,
      y: rect.height > 0 ? ((clientY - rect.top) / rect.height) * size.h : 0,
    }
  }, [size.w, size.h])

  const toGraphPoint = (clientX: number, clientY: number) => {
    const point = toCanvasPoint(clientX, clientY)
    return { x: (point.x - transform.x) / transform.k, y: (point.y - transform.y) / transform.k }
  }

  const releaseDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    const node = nodesRef.current.find((n) => n.id === drag.id)
    if (node) {
      node.fx = null
      node.fy = null
    }
    draggedRef.current = drag.moved
    dragRef.current = null
    cool()
  }, [nodesRef, cool])

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    claimView()
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    const point = toCanvasPoint(event.clientX, event.clientY)
    setTransform((t) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, t.k * factor))
      if (k === t.k) return t
      // Zoom towards the cursor: keep the point under it stationary.
      return {
        x: point.x - ((point.x - t.x) / t.k) * k,
        y: point.y - ((point.y - t.y) / t.k) * k,
        k,
      }
    })
  }

  // ---------------------------------------------------------------------
  // Pinch to zoom.
  //
  // Bound natively rather than through React, because React attaches its
  // touch listeners passively at the root and a passive listener cannot call
  // preventDefault - which is what stops iOS Safari zooming the whole page
  // out from under a two-finger gesture on the canvas. The listeners are on
  // the SVG alone, as is the touch-action that suppresses scrolling, so
  // nothing outside this one element changes behaviour.
  //
  // The gesture extends the same transform the wheel and the buttons write.
  // The zoom is anchored on the midpoint between the fingers: the graph point
  // that was under the midpoint when the gesture began stays under it, which
  // also gives two-finger panning for nothing, because the midpoint moves
  // when both fingers do.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const track = (touches: TouchList, id: number): Touch | null => {
      for (let i = 0; i < touches.length; i++) {
        const touch = touches.item(i)
        if (touch && touch.identifier === id) return touch
      }
      return null
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length < 2) return
      const first = event.touches.item(0)
      const second = event.touches.item(1)
      if (!first || !second) return
      event.preventDefault()
      claimView()
      // A second finger ends whatever one finger had started.
      panRef.current = null
      releaseDrag()
      const t = transformRef.current
      const mid = toCanvasPoint(
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2,
      )
      pinchRef.current = {
        a: first.identifier,
        b: second.identifier,
        gap: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
        k: t.k,
        gx: (mid.x - t.x) / t.k,
        gy: (mid.y - t.y) / t.k,
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current
      if (!pinch) return
      const first = track(event.touches, pinch.a)
      const second = track(event.touches, pinch.b)
      if (!first || !second) return
      event.preventDefault()
      const gap = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
      if (gap <= 0 || pinch.gap <= 0) return
      const k = Math.min(MAX_K, Math.max(MIN_K, pinch.k * (gap / pinch.gap)))
      const mid = toCanvasPoint(
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2,
      )
      setTransform({ x: mid.x - pinch.gx * k, y: mid.y - pinch.gy * k, k })
    }

    const onTouchEnd = () => {
      if (!pinchRef.current) return
      pinchRef.current = null
      gesturedRef.current = true
    }

    svg.addEventListener('touchstart', onTouchStart, { passive: false })
    svg.addEventListener('touchmove', onTouchMove, { passive: false })
    svg.addEventListener('touchend', onTouchEnd)
    svg.addEventListener('touchcancel', onTouchEnd)
    return () => {
      svg.removeEventListener('touchstart', onTouchStart)
      svg.removeEventListener('touchmove', onTouchMove)
      svg.removeEventListener('touchend', onTouchEnd)
      svg.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [toCanvasPoint, claimView, releaseDrag])

  const onPointerDownBackground = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current || pinchRef.current) return
    stopAnimation()
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      ox: transform.x,
      oy: transform.y,
    }
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    // The pinch handler owns the transform while two fingers are down.
    if (pinchRef.current) return
    const drag = dragRef.current
    if (drag) {
      drag.moved = true
      const point = toGraphPoint(event.clientX, event.clientY)
      const node = positions.get(drag.id)
      if (node) {
        node.fx = point.x
        node.fy = point.y
      }
      return
    }
    const pan = panRef.current
    if (pan) {
      const svg = svgRef.current
      if (!svg) return
      claimView()
      const rect = svg.getBoundingClientRect()
      const dx = ((event.clientX - pan.startX) / rect.width) * size.w
      const dy = ((event.clientY - pan.startY) / rect.height) * size.h
      setTransform((t) => ({ ...t, x: pan.ox + dx, y: pan.oy + dy }))
    }
  }

  const endPointer = () => {
    releaseDrag()
    panRef.current = null
  }

  const startNodeDrag = (event: ReactPointerEvent, id: string) => {
    event.stopPropagation()
    if (pinchRef.current) return
    stopAnimation()
    dragRef.current = { id, moved: false }
    const point = toGraphPoint(event.clientX, event.clientY)
    const node = positions.get(id)
    if (node) {
      node.fx = point.x
      node.fy = point.y
    }
    reheat()
  }

  // Painted largest first so small marks stay clickable on top, which also
  // puts the hubs first in tab order.
  const paintOrder = useMemo(
    () => [...visibleNodes].sort((a, b) => radiusOf(b) - radiusOf(a)),
    [visibleNodes, radiusOf],
  )

  // Bucketed so a smooth zoom does not recompute the label layout on every
  // frame; a drag holds the previous result entirely.
  const zoomBucket = Math.round(Math.max(transform.k, 0.35) * 4) / 4
  const labelledIds = useMemo(() => {
    // Labels are placed greedily, most-connected first, and any label whose box
    // would collide with one already placed is dropped. Boxes are measured in
    // simulation units divided by the zoom, so a label occupies less of the
    // model the further you zoom in - which is what makes zooming reveal more
    // labels rather than piling them on top of each other.
    const k = zoomBucket
    const placed: { x1: number; y1: number; x2: number; y2: number }[] = []
    const kept = new Set<string>()
    const budget = Math.min(paintOrder.length, Math.round(24 * k))
    for (const node of paintOrder) {
      if (kept.size >= budget) break
      const sim = positions.get(node.id)
      if (sim?.x === undefined || sim.y === undefined) continue
      const text = shortLabel(node.label)
      const halfW = (text.length * 12 * 0.5) / 2 / k
      const h = 15 / k
      const r = radiusOf(node)
      const box = {
        x1: sim.x - halfW,
        x2: sim.x + halfW,
        y1: sim.y - r - 6 - h,
        y2: sim.y - r - 6,
      }
      const hits = placed.some((p) =>
        box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1
      )
      if (hits) continue
      placed.push(box)
      kept.add(node.id)
    }
    return kept
    // positions is rebuilt every frame; the label layout deliberately holds
    // its previous result through a drag rather than re-solving per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintOrder, zoomBucket, radiusOf])

  // Territory extents: one O(n) pass over the visible nodes, not a hull per
  // frame. Only the grouped layout draws them - in the free layout a category
  // has no territory to name.
  const territories = useMemo(() => {
    void frame
    if (layout !== 'grouped' || visibleStyles.size < 2) return []
    const acc = new Map<string, { x: number; y: number; n: number }>()
    for (const node of visibleNodes) {
      const sim = positions.get(node.id)
      if (sim?.x === undefined || sim.y === undefined) continue
      const bucket = acc.get(node.group)
      if (bucket) {
        bucket.x += sim.x
        bucket.y += sim.y
        bucket.n += 1
      } else acc.set(node.group, { x: sim.x, y: sim.y, n: 1 })
    }
    const out: { group: string; style: GroupStyle; x: number; y: number; r: number }[] = []
    for (const [group, bucket] of acc) {
      const style = visibleStyles.get(group)
      if (!style || bucket.n === 0) continue
      const cx = bucket.x / bucket.n
      const cy = bucket.y / bucket.n
      let spread = 0
      for (const node of visibleNodes) {
        if (node.group !== group) continue
        const sim = positions.get(node.id)
        if (sim?.x === undefined || sim.y === undefined) continue
        spread = Math.max(spread, Math.hypot(sim.x - cx, sim.y - cy) + radiusOf(node))
      }
      out.push({ group, style, x: cx, y: cy, r: spread + 24 })
    }
    return out
  }, [layout, visibleStyles, visibleNodes, positions, radiusOf, frame])

  const zoomBy = (factor: number) => {
    claimView()
    setTransform((t) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, t.k * factor))
      // About the middle of the space the panels leave free, so pressing + with
      // the detail sheet up magnifies what the reader can actually see.
      const cx = insets.left + (size.w - insets.left - insets.right) / 2
      const cy = (size.h - insets.bottom) / 2
      return { x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k, k }
    })
  }

  const focusStyle = focus ? groupStyles.get(positions.get(focus)?.group ?? '') : undefined

  return (
    <div ref={sizeRef} className='absolute inset-0'>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio='xMidYMid meet'
        role='application'
        aria-label='Knowledge map - drag to pan, pinch or scroll to zoom, select a node to explore it'
        tabIndex={0}
        className='rp-focus rp-map block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing'
        onWheel={onWheel}
        onPointerDown={onPointerDownBackground}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
        onClick={() => {
          // The click a browser synthesises at the end of a pinch is not a tap
          // on the background and must not clear the selection.
          if (gesturedRef.current) {
            gesturedRef.current = false
            return
          }
          onSelect(null)
        }}
      >
        <MapDefs />
        <rect
          x={0}
          y={0}
          width={size.w}
          height={size.h}
          fill='url(#rp-map-vignette)'
          style={{ pointerEvents: 'none' }}
        />
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {/* Category territories - the ground the marks sit on. */}
          <g style={{ pointerEvents: 'none' }} aria-hidden='true'>
            {territories.map((t) => (
              <circle
                key={t.group}
                cx={t.x}
                cy={t.y}
                r={t.r}
                fill={`url(#rp-map-wash-${t.style.slot})`}
              />
            ))}
          </g>

          <g>
            {visibleEdges.map((edge, i) => {
              const from = positions.get(edge.source)
              const to = positions.get(edge.target)
              if (
                !from || !to || from.x === undefined || from.y === undefined ||
                to.x === undefined || to.y === undefined
              ) return null
              const key = `${edge.source}|${edge.label}|${edge.target}`
              const onPath = pathEdgeKeys?.has(key) ?? false
              const touchesFocus = focus !== null &&
                (edge.source === focus || edge.target === focus)
              const dimmed = (pathEdgeKeys && !onPath) ||
                (focus !== null && !touchesFocus && !pathEdgeKeys)
              const emphasised = onPath || touchesFocus
              const showLabel = emphasised && transform.k >= 0.62 && Boolean(edge.label)
              const geo = edgeGeometry(
                from.x,
                from.y,
                to.x,
                to.y,
                radiusOf(from),
                radiusOf(to),
                curves[i] ?? 0.5,
              )
              // At rest a link is tinted with the category it leaves, so the
              // traffic between territories is legible as colour rather than
              // as a grey haze. The tint is thin and pale enough that it never
              // competes with the solid marks for the categorical read.
              const sourceStyle = groupStyles.get(from.group)
              const crossing = from.group !== to.group
              const stroke = onPath
                ? 'var(--rp-accent)'
                : touchesFocus
                ? (focusStyle?.colour ?? 'var(--rp-accent)')
                : (sourceStyle?.colour ?? 'var(--rp-ink-3)')
              const marker = onPath
                ? 'url(#rp-map-arrow-trace)'
                : touchesFocus
                ? `url(#rp-map-arrow-${focusStyle?.slot ?? 0})`
                : undefined
              return (
                <g key={`${key}-${i}`} className='rp-map-fade' opacity={dimmed ? 0.08 : 1}>
                  <path
                    id={showLabel ? `rp-map-edge-${i}` : undefined}
                    d={showLabel && geo.labelD !== geo.d ? geo.labelD : geo.d}
                    fill='none'
                    stroke={stroke}
                    strokeWidth={onPath
                      ? 3
                      : touchesFocus
                      ? 2.1
                      : edgeWidth(edge.weight) * (crossing ? 0.85 : 1)}
                    strokeOpacity={emphasised ? 0.92 : crossing ? 0.18 : 0.42}
                    strokeLinecap='round'
                    markerEnd={geo.labelD === geo.d || !showLabel ? marker : undefined}
                  />
                  {showLabel && geo.labelD !== geo.d
                    ? (
                      <path
                        d={geo.d}
                        fill='none'
                        stroke='none'
                        markerEnd={marker}
                        style={{ pointerEvents: 'none' }}
                      />
                    )
                    : null}
                  {showLabel
                    ? (
                      <text
                        className='rp-map-edge-label'
                        dy={-5}
                        fill='var(--rp-ink-2)'
                        stroke='var(--rp-surface)'
                        strokeWidth={4}
                        paintOrder='stroke'
                        style={{ pointerEvents: 'none' }}
                      >
                        <textPath href={`#rp-map-edge-${i}`} startOffset='50%' textAnchor='middle'>
                          {edge.label}
                        </textPath>
                      </text>
                    )
                    : null}
                </g>
              )
            })}
          </g>

          {/* Territory captions sit above the links, below the marks. */}
          {territories.length > 0
            ? (
              <g style={{ pointerEvents: 'none' }} aria-hidden='true'>
                {territories.map((t) => (
                  <text
                    key={t.group}
                    x={t.x}
                    y={t.y - t.r - 6}
                    textAnchor='middle'
                    className='rp-map-territory'
                    fill={t.style.ink}
                    stroke='var(--rp-surface)'
                    strokeWidth={5}
                    paintOrder='stroke'
                    opacity={focus ? 0.35 : 1}
                  >
                    {t.group.toUpperCase()} · {t.style.count}
                  </text>
                ))}
              </g>
            )
            : null}

          <g>
            {paintOrder.map((node) => {
              const sim = positions.get(node.id)
              if (!sim || sim.x === undefined || sim.y === undefined) return null
              const style = groupStyles.get(node.group)
              const colour = style?.colour ?? 'var(--rp-cat-1)'
              const degree = degrees.get(node.id) ?? 0
              const r = radiusOf(node)
              const isSelected = node.id === selectedId
              const isHovered = node.id === hoveredId
              const isPathStart = node.id === pathFrom
              const inNeighbourhood = neighbourIds?.has(node.id) ?? true
              const onPath = pathNodeIds?.has(node.id) ?? false
              const dimmed = (pathNodeIds && !onPath) || (!pathNodeIds && !inNeighbourhood)
              // An entity with no extracted relations carries no structure, so
              // it is drawn as a quiet marker rather than competing with the
              // hubs for the reader's eye.
              const unlinked = measure === 'links' && degree === 0
              const emphasised = isSelected || isHovered || isPathStart || onPath
              const showLabel = labelledIds.has(node.id) || emphasised ||
                (neighbourIds?.has(node.id) ?? false)
              return (
                <g
                  key={node.id}
                  role='button'
                  tabIndex={0}
                  aria-label={`${node.label} - ${node.group || 'entity'}, ${degree} ${
                    degree === 1 ? 'relation' : 'relations'
                  }`}
                  aria-pressed={isSelected}
                  className='rp-map-node rp-map-fade cursor-pointer'
                  opacity={dimmed ? 0.16 : unlinked && !emphasised ? 0.62 : 1}
                  onPointerDown={(event) => startNodeDrag(event, node.id)}
                  onPointerEnter={() => setHoveredId(node.id)}
                  onPointerLeave={() => setHoveredId((h) => (h === node.id ? null : h))}
                  onClick={(event) => {
                    event.stopPropagation()
                    // A drag that moved the node should not also select it.
                    if (draggedRef.current) {
                      draggedRef.current = false
                      return
                    }
                    onSelect(node.id)
                  }}
                  onKeyDown={(event: ReactKeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(node.id)
                    }
                  }}
                >
                  {/* Keyboard focus ring - shown by :focus-visible, see styles.css. */}
                  <circle
                    className='rp-map-ring'
                    cx={sim.x}
                    cy={sim.y}
                    r={r + 7}
                    fill='none'
                    stroke='var(--rp-ink)'
                    strokeWidth={2}
                    strokeDasharray='3 3'
                  />
                  {isSelected || isPathStart
                    ? (
                      <circle
                        cx={sim.x}
                        cy={sim.y}
                        r={r + 7}
                        fill='none'
                        stroke='var(--rp-accent)'
                        strokeWidth={2}
                        strokeOpacity={0.6}
                      />
                    )
                    : null}
                  {isHovered && !isSelected
                    ? (
                      <circle
                        cx={sim.x}
                        cy={sim.y}
                        r={r + 5}
                        fill='none'
                        stroke={colour}
                        strokeWidth={1.5}
                        strokeOpacity={0.5}
                      />
                    )
                    : null}
                  <circle
                    cx={sim.x}
                    cy={sim.y}
                    r={unlinked ? Math.max(3.5, r - 1.5) : r}
                    fill={style?.hollow ? 'var(--rp-surface)' : colour}
                    stroke={style?.hollow
                      ? colour
                      : isSelected || isPathStart
                      ? 'var(--rp-ink)'
                      : 'var(--rp-surface)'}
                    strokeWidth={style?.hollow ? 3 : isSelected || isPathStart ? 2.5 : 1.5}
                  />
                  {showLabel
                    ? (
                      <text
                        className='rp-map-label'
                        x={sim.x}
                        y={sim.y - r - 7}
                        textAnchor='middle'
                        fontWeight={emphasised ? 650 : 500}
                        fill={emphasised ? 'var(--rp-ink)' : 'var(--rp-ink-2)'}
                        stroke='var(--rp-surface)'
                        strokeWidth={4}
                        paintOrder='stroke'
                        style={{ pointerEvents: 'none' }}
                      >
                        {shortLabel(node.label)}
                      </text>
                    )
                    : null}
                </g>
              )
            })}
          </g>
        </g>
      </svg>

      <p className='pointer-events-none absolute bottom-4 left-1/2 hidden -translate-x-1/2 text-xs text-ink-3 lg:block'>
        {hint}
      </p>

      {
        /* Zoom controls. A panel that covers the bottom of the canvas would
          bury them, so they ride above it - and lie down into a row while they
          are there, because a 116px column would take half of the strip of map
          the sheet leaves visible. */
      }
      <div
        className={`absolute right-4 flex gap-1 ${
          insets.bottom > 0 ? 'flex-row-reverse' : 'flex-col'
        }`}
        style={{ bottom: insets.bottom + 16 }}
      >
        <button
          type='button'
          aria-label='Zoom in'
          onClick={() => zoomBy(1.3)}
          className='rp-btn rp-btn-outline rp-shadow-sm h-9 w-9 p-0 text-lg'
        >
          +
        </button>
        <button
          type='button'
          aria-label='Zoom out'
          onClick={() => zoomBy(1 / 1.3)}
          className='rp-btn rp-btn-outline rp-shadow-sm h-9 w-9 p-0 text-lg'
        >
          −
        </button>
        <button
          type='button'
          aria-label='Fit the whole map to view'
          title='Fit to view'
          onClick={fitView}
          className='rp-btn rp-btn-outline rp-shadow-sm h-9 w-9 p-0 text-sm'
        >
          ⤢
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading state - a pale constellation in the shape of the real thing, rather
// than a spinner on an empty rectangle. Deterministic, so it never flickers
// into a different arrangement between renders.
// ---------------------------------------------------------------------------

const SEED_GROUPS = [
  { cx: 0.3, cy: 0.34, r: 0.15, n: 9, slot: 0 },
  { cx: 0.66, cy: 0.28, r: 0.13, n: 7, slot: 1 },
  { cx: 0.74, cy: 0.68, r: 0.14, n: 8, slot: 2 },
  { cx: 0.34, cy: 0.72, r: 0.12, n: 6, slot: 4 },
]

/**
 * The pale constellation shared by the loading, empty and error states, so
 * the map's own furniture is what a reader waits on - not a blank rectangle.
 */
export function MapConstellation({ still = false }: { still?: boolean }) {
  const marks = useMemo(() => {
    const out: { x: number; y: number; r: number; slot: number; delay: number }[] = []
    let seed = 7
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (const group of SEED_GROUPS) {
      for (let i = 0; i < group.n; i++) {
        const angle = rand() * Math.PI * 2
        const dist = Math.sqrt(rand()) * group.r
        out.push({
          x: (group.cx + Math.cos(angle) * dist) * 100,
          y: (group.cy + Math.sin(angle) * dist * 1.4) * 100,
          r: 0.9 + rand() * 1.6,
          slot: group.slot,
          delay: out.length * 60,
        })
      }
    }
    return out
  }, [])

  return (
    <svg
      viewBox='0 0 100 100'
      preserveAspectRatio='xMidYMid slice'
      className='pointer-events-none absolute inset-0 h-full w-full'
      aria-hidden='true'
    >
      {marks.map((mark, i) => {
        const next = marks[(i + 3) % marks.length]
        return next && i % 3 === 0
          ? (
            <line
              key={`l-${i}`}
              x1={mark.x}
              y1={mark.y}
              x2={next.x}
              y2={next.y}
              stroke='var(--rp-line)'
              strokeWidth={0.2}
            />
          )
          : null
      })}
      {marks.map((mark, i) => (
        <circle
          key={i}
          className={still ? undefined : 'rp-map-seed'}
          cx={mark.x}
          cy={mark.y}
          r={mark.r}
          fill={`var(--rp-cat-${mark.slot + 1})`}
          opacity={still ? 0.28 : undefined}
          style={still ? undefined : { animationDelay: `${mark.delay}ms` }}
        />
      ))}
    </svg>
  )
}
