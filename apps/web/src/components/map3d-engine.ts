import * as THREE from 'three'
import {
  type GroupStyle,
  type Insets,
  type MapEdge,
  type MapLayout,
  type MapMeasure,
  type MapNode,
  radiusFor,
  shortLabel,
} from './KnowledgeMap.tsx'
import { type Centre3D, clusterCentres3D, ForceSim3D, type SimNode3D } from '../lib/force3d.ts'

// ---------------------------------------------------------------------------
// The knowledge map's 3D engine.
//
// Everything imperative lives here - the three.js scene, the camera, the
// gestures, the force simulation and the DOM label overlay - so the React
// component above it (KnowledgeMap3D.tsx) stays a thin shell that pushes
// props in and receives selections back.
//
// The visual grammar is the 2D map's, carried into depth:
//
//   position   the category territory a node belongs to, and inside it, who
//              it is linked to - now an orbit around the corpus, not a plan
//   colour     the category (the six --rp-cat-* hues, resolved from the
//              tenant's appearance tokens at runtime)
//   size       how connected the node is
//   presence   unlinked nodes are small and quiet; dimmed ones recede
//   depth      distance fades into the paper via fog, so the third axis
//              reads as atmosphere rather than clutter
//
// The field stays the tenant's paper surface - light mode is the design
// target, not an afterthought - and every colour the WebGL side needs is
// resolved from the appearance tokens, so palettes (including dark ones)
// restyle the scene the same way they restyle the DOM.
// ---------------------------------------------------------------------------

/** Camera vertical field of view. Narrow enough to keep spheres round at the edges. */
const FOV = 40

/** Dolly bounds, as multiples of the fitted distance. */
const MIN_DIST_FACTOR = 0.22
const MAX_DIST_FACTOR = 3.2

/** How long the view takes to move to a selection - mirrors the 2D map. */
const FOCUS_MS = 380
const FIT_MS = 520

/**
 * The band a focus move lands in, in world units of camera distance. The
 * floor keeps a whole neighbourhood in frame; the ceiling stops a lone
 * entity pulling the camera into its surface.
 */
const FOCUS_MIN_DIST = 230
const FOCUS_MAX_DIST = 560

/**
 * Idle drift: a slow sway of +-IDLE_SWAY radians about the landing azimuth,
 * one full swing every IDLE_SWAY_PERIOD seconds, rather than an endless spin.
 * The cluster ring is an ellipse seen from the map's natural elevation, so a
 * full turn either walks clusters off the plate or needs a fit two to four
 * times further out; a sway keeps the chosen azimuth's framing and still
 * reads as alive.
 */
const IDLE_SWAY = 0.22
const IDLE_SWAY_PERIOD = 48

/** Polar clamp - the camera never goes underneath or straight overhead. */
const PHI_MIN = 0.35
const PHI_MAX = Math.PI - 0.55

const PALETTE_TOKENS = [
  '--rp-cat-1',
  '--rp-cat-2',
  '--rp-cat-3',
  '--rp-cat-4',
  '--rp-cat-5',
  '--rp-cat-6',
  '--rp-surface',
  '--rp-accent',
  // The inks follow the hues: WebGL cannot take a `var()`, and a cluster's
  // hub ring is drawn in its ink, so the six text-safe variants have to be
  // resolved here too rather than assumed.
  '--rp-cat-1-ink',
  '--rp-cat-2-ink',
  '--rp-cat-3-ink',
  '--rp-cat-4-ink',
  '--rp-cat-5-ink',
  '--rp-cat-6-ink',
] as const

type Palette3D = {
  cats: THREE.Color[]
  surface: THREE.Color
  accent: THREE.Color
  inks: THREE.Color[]
}

// ---------------------------------------------------------------------------
// Semantic zoom. A category cluster whose spread on screen falls below the
// collapse threshold folds into one hub mark; it unfolds again once it would
// be drawn wider than the expand threshold. The gap between the two is the
// hysteresis that keeps a wheel notch near the boundary from flickering.
// Thresholds are in CSS pixels of the cluster's radius, so the rule adapts
// itself: a narrow canvas folds more clusters than a wide one at the same
// fitted distance, which is exactly what a reader on a phone needs.
// ---------------------------------------------------------------------------

const COLLAPSE_PX = 68
const EXPAND_PX = 86
/** The collapse/expand choreography - eased both ways, no overshoot. */
const LOD_MS = 420
/** The camera flight into a clicked hub. */
const DIVE_MS = 560
/** A cluster this small has nothing to fold: one dot stays a dot. */
const HUB_MIN_MEMBERS = 2

/** Cluster caption box height in CSS px (the folded variant is the taller). */
const CAPTION_H = 17
/** Captions keep this far inside the plate edge. */
const PLATE_INSET = 6

/** Hub mark radius from the member count - area follows count, like the blobs. */
function hubRadius(count: number): number {
  return Math.min(88, 15 + 6.2 * Math.sqrt(count))
}

/**
 * How wide a cluster of the given world-space spread draws, in CSS pixels, at
 * a camera distance of `dist` on a canvas `height` pixels tall.
 */
export function clusterScreenPx(spread: number, height: number, dist: number): number {
  const halfTan = Math.tan((FOV / 2) * (Math.PI / 180))
  return (spread * (height / 2)) / (Math.max(1, dist) * halfTan)
}

/**
 * The fold a cluster should be heading for. Pure, so the rule that decides
 * what a reader sees is testable without a WebGL context.
 *
 * The two thresholds are deliberately apart: a cluster only folds below
 * COLLAPSE_PX and only unfolds above EXPAND_PX, so a camera sitting between
 * them keeps whatever state it already had and a wheel notch at the boundary
 * cannot flicker. A pinned cluster (it holds the selection or a traced path)
 * is always open; a dived one (the reader just clicked it open) is held open
 * against the collapse rule until a zoom or a fit releases it.
 */
export function nextFold(
  current: 0 | 1,
  px: number,
  options: { pinned?: boolean; dived?: boolean } = {},
): 0 | 1 {
  if (options.pinned) return 0
  if (current === 1) return px > EXPAND_PX ? 0 : 1
  return px < COLLAPSE_PX && !options.dived ? 1 : 0
}

/** Cubic in-out: the collapse gathers speed and settles, without a bounce. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Screen-space label box, pooled per frame so placement allocates nothing. */
type LabelBox = { x1: number; y1: number; x2: number; y2: number }

type ScreenDisc = {
  ok: boolean
  sx: number
  sy: number
  camDist: number
  screenR: number
  opacity: number
}

export type EngineData = {
  nodes: MapNode[]
  edges: MapEdge[]
  groupStyles: Map<string, GroupStyle>
  degrees: Map<string, number>
  measure: MapMeasure
  layout: MapLayout
  aspect: number
}

export type EngineEmphasis = {
  selectedId: string | null
  pathEdges: MapEdge[] | null
  pathFrom: string | null
}

type Fade = { current: number; target: number }

/**
 * What an edge needs of its endpoints: a rendered position, a radius and a
 * hue. Nodes satisfy it directly; a folded cluster's hub satisfies it through
 * a small anchor object, so aggregated relations run through the same tube
 * code as individual ones.
 */
type EdgeAnchor = {
  node: { id: string; group: string }
  /** Where the mark is drawn this frame (a folding node drifts off its sim position). */
  pos: THREE.Vector3
  r: number
  scale: Fade
  slot: number
}

type NodeVisual = EdgeAnchor & {
  node: MapNode
  sim: SimNode3D
  hollow: boolean
  unlinked: boolean
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  /** Outline shell: the hollow ring for reused hues, the halo on hover. */
  shell: THREE.Mesh
  shellMaterial: THREE.MeshBasicMaterial
  opacity: Fade
  shellOpacity: Fade
  /** 0..1 - how far the node has come forward towards the camera on hover. */
  lift: Fade
  /** Relations on the node, for the hover card. */
  degree: number
  /** Entrance stagger - the tick count before this node grows in. */
  bornAt: number
  label: HTMLDivElement
  /** Measured label width in CSS px, for collision placement. */
  labelW: number
  /** The cluster the node belongs to, for its fold state. */
  territory: TerritoryVisual | null
}

type EdgeVisual = {
  edge: MapEdge
  key: string
  from: EdgeAnchor
  to: EdgeAnchor
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  cone: THREE.Mesh
  coneMaterial: THREE.MeshBasicMaterial
  width: number
  crossing: boolean
  /** Parallel relations between one pair fan sideways by this much. */
  lateral: number
  opacity: Fade
  emphasised: boolean
  label: HTMLDivElement | null
  labelW: number
  /**
   * The clusters whose fold this relation follows. An individual relation
   * fades OUT as EITHER end folds; an aggregated one fades IN only once every
   * cluster it stands for has folded. Empty: unaffected by any fold.
   */
  folds: HubVisual[]
  aggregate: boolean
}

/**
 * The single mark a category folds into when the camera is too far out to
 * tell its members apart: one sphere in the category's hue sized by the
 * member count, ringed by a hairline in its ink, with the relations leaving
 * the cluster summed into one tube per counterpart.
 */
type HubVisual = {
  id: string
  group: string
  count: number
  members: NodeVisual[]
  anchor: EdgeAnchor
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  ring: THREE.Mesh
  ringMaterial: THREE.MeshBasicMaterial
  /** Relations this hub stands in for while folded. */
  flows: EdgeVisual[]
  /** Level of detail, 0 = dots, 1 = hub. Tweened, not approached. */
  lod: number
  lodTarget: number
  lodFrom: number
  /** performance.now() the tween began; -1 before the first evaluation, which snaps. */
  lodStarted: number
  /** Set by a click-to-open dive so the automatic rule cannot refold it mid-flight. */
  dived: boolean
  /** Presence under emphasis: dims like a node when something else has focus. */
  opacity: Fade
  /** Entrance grow-in, and a lift on hover. */
  scale: Fade
  bornAt: number
}

type TerritoryVisual = {
  group: string
  style: GroupStyle
  count: number
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  caption: HTMLDivElement
  captionFull: string
  captionShort: string
  /** Measured widths, CSS px: the open caption and its larger folded variant. */
  captionW: number
  captionShortW: number
  captionHubW: number
  captionShortHubW: number
  centre: THREE.Vector3
  /** Blob radius: the spread plus a margin, for the territory volume. */
  r: number
  /** Furthest member (plus its radius) from the centroid - the cluster's real extent. */
  spread: number
  /** Null for clusters too small to be worth folding. */
  hub: HubVisual | null
}

type View = {
  target: THREE.Vector3
  theta: number
  phi: number
  dist: number
}

type ViewTween = {
  from: View
  to: View
  started: number
  duration: number
}

type DragState = {
  id: string
  plane: THREE.Plane
  moved: boolean
}

type OrbitState = {
  mode: 'orbit' | 'pan'
  lastX: number
  lastY: number
  moved: number
  /** The hub the press landed on, if any - a click on it opens the cluster. */
  hub: string | null
}

type PinchState = {
  a: number
  b: number
  gap: number
  dist: number
  midX: number
  midY: number
}

/** Edge weight -> tube radius, log scaled like the 2D stroke width. */
function edgeRadius(weight: number): number {
  return Math.max(0.6, Math.min(5, 0.55 + 1.2 * Math.log10(1 + Math.max(0, weight))))
}

/** How far each edge in a parallel bundle bows sideways - ported from buildCurves. */
function buildLaterals(edges: MapEdge[]): number[] {
  const seen = new Map<string, number[]>()
  edges.forEach((edge, i) => {
    const key = edge.source < edge.target
      ? `${edge.source} ${edge.target}`
      : `${edge.target} ${edge.source}`
    const list = seen.get(key)
    if (list) list.push(i)
    else seen.set(key, [i])
  })
  const laterals = new Array<number>(edges.length).fill(0)
  for (const list of seen.values()) {
    if (list.length === 1) continue
    list.forEach((edgeIndex, j) => {
      laterals[edgeIndex] = -1 + (2 * j) / (list.length - 1)
    })
  }
  return laterals
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Resolve the appearance tokens the WebGL side needs into concrete colours.
 * Tokens can hold anything CSS can (hex, color-mix, oklch), so each one is
 * read back through a probe element's computed colour, which the browser has
 * already resolved to rgb().
 */
function resolvePalette(probe: HTMLElement): Palette3D {
  const read = (token: string): THREE.Color => {
    probe.style.color = `var(${token})`
    const resolved = getComputedStyle(probe).color
    const colour = new THREE.Color()
    // A token built with color-mix() computes to `color(srgb r g b)`, which
    // three.js cannot parse - it warns and leaves the colour black. The ink
    // tokens are all color-mix, and a tenant is free to write one for any
    // token, so the srgb form is unpacked here rather than assumed away.
    const srgb = /^color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(resolved)
    if (srgb) {
      colour.setRGB(Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), THREE.SRGBColorSpace)
      return colour
    }
    colour.setStyle(resolved)
    return colour
  }
  const values = PALETTE_TOKENS.map(read)
  return {
    cats: values.slice(0, 6),
    surface: values[6] ?? new THREE.Color('#ffffff'),
    accent: values[7] ?? new THREE.Color('#2a78d6'),
    inks: values.slice(8, 14),
  }
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export class KnowledgeMapEngine {
  private canvas: HTMLCanvasElement
  private labelLayer: HTMLDivElement
  private onSelect: (id: string | null) => void

  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private nodeGroup = new THREE.Group()
  private edgeGroup = new THREE.Group()
  private territoryGroup = new THREE.Group()
  private hubGroup = new THREE.Group()
  private hemi: THREE.HemisphereLight
  private key: THREE.DirectionalLight
  private fill: THREE.DirectionalLight
  private fog: THREE.Fog

  private sphereGeo = new THREE.SphereGeometry(1, 40, 24)
  private shellGeo = new THREE.SphereGeometry(1, 32, 18)
  private tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true)
  private coneGeo = new THREE.ConeGeometry(1, 1, 10)
  private ringGeo = new THREE.RingGeometry(1.18, 1.32, 48)
  private territoryGeo = new THREE.SphereGeometry(1, 28, 18)
  /** The hub's hairline: an engraved ring, not a badge. */
  private haloGeo = new THREE.RingGeometry(1, 1.045, 64)

  private selectionRing: THREE.Mesh
  private selectionRingMaterial: THREE.MeshBasicMaterial
  private traceRing: THREE.Mesh
  private traceRingMaterial: THREE.MeshBasicMaterial

  private palette: Palette3D
  private paletteObserver: MutationObserver
  private probe: HTMLSpanElement
  private popup: HTMLDivElement
  private popupName: HTMLDivElement
  private popupMeta: HTMLDivElement
  private popupCounts: HTMLDivElement
  private popupHint: HTMLDivElement
  /** Boxes claimed this frame, and the pool they are drawn from. */
  private placedLabelBoxes: LabelBox[] = []
  private boxPool: LabelBox[] = []
  /** Screen discs of every mark this frame, pooled - see projectLabels. */
  private discs: ScreenDisc[] = []
  private discCount = 0
  private measureCtx: CanvasRenderingContext2D | null = null
  private labelFont = ''
  private captionFont = ''
  private captionSpacing = 0

  private data: EngineData | null = null
  private sim: ForceSim3D | null = null
  private centres: Map<string, Centre3D> = new Map()
  private nodeVisuals = new Map<string, NodeVisual>()
  private edgeVisuals: EdgeVisual[] = []
  /** The aggregated relations folded clusters stand in for. */
  private flowVisuals: EdgeVisual[] = []
  private territories: TerritoryVisual[] = []
  private hubs = new Map<string, HubVisual>()
  private paintRank: NodeVisual[] = []
  /** Territories largest first - captions claim their space in that order. */
  private captionRank: TerritoryVisual[] = []
  private worldCentre = new THREE.Vector3()
  private worldRadius = 320

  private emphasis: EngineEmphasis = { selectedId: null, pathEdges: null, pathFrom: null }
  private hoveredId: string | null = null
  private hoveredHub: string | null = null
  /** The last pick's results - a node or a hub, never both. */
  private pickedNode: NodeVisual | null = null
  private pickedHub: HubVisual | null = null
  private neighbourIds: Set<string> | null = null
  private pathNodeIds: Set<string> | null = null
  private pathEdgeKeys: Set<string> | null = null

  private insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 }

  private view: View
  private distGoal: number
  private tween: ViewTween | null = null
  private idleSpin: boolean
  private reduced: boolean
  private reducedQuery: MediaQueryList | null = null
  private onContextLost: ((event: Event) => void) | null = null

  private onReducedChange = (event: MediaQueryListEvent) => {
    this.reduced = event.matches
    if (event.matches) this.idleSpin = false
  }
  private viewOwnedFlag = false
  private focusOwnedFlag = false
  private fitDist = 420
  /** The azimuth the idle sway swings about, and how far through a swing it is. */
  private idleAnchor = -0.5
  private idlePhase = 0
  /**
   * The point the fit frames: the scene's balance point, not its centroid,
   * so both sides of the plate bind. Solved in fitDistance.
   */
  private fitCentre = new THREE.Vector3()
  private fitMidR = 0
  private fitMidU = 0

  private pointers = new Map<number, { x: number; y: number }>()
  private orbit: OrbitState | null = null
  private pinch: PinchState | null = null
  private drag: DragState | null = null
  private gestured = false
  private hoverPos: { x: number; y: number } | null = null
  private hoverDirty = false

  private raycaster = new THREE.Raycaster()
  private frameHandle: number | null = null
  private lastFrame = performance.now()
  private frameCount = 0
  private renderDirty = true
  private resizeObserver: ResizeObserver
  private disposed = false
  private width = 1
  private height = 1

  constructor(
    canvas: HTMLCanvasElement,
    labelLayer: HTMLDivElement,
    onSelect: (id: string | null) => void,
    onContextLost?: () => void,
  ) {
    this.canvas = canvas
    this.labelLayer = labelLayer
    this.onSelect = onSelect
    // A lost context would otherwise freeze the canvas with no way back;
    // the shell swaps in the 2D map instead.
    if (onContextLost) {
      this.onContextLost = (event: Event) => {
        event.preventDefault()
        onContextLost()
      }
      canvas.addEventListener('webglcontextlost', this.onContextLost)
    }
    // Live, not a snapshot: a reader who turns reduced motion on mid-session
    // gets it honoured immediately, not at the next remount.
    this.reducedQuery = typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    this.reduced = this.reducedQuery?.matches ?? false
    this.idleSpin = !this.reduced
    this.reducedQuery?.addEventListener('change', this.onReducedChange)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))

    // The hover card - one pooled element, filled per node. DOM in the label
    // layer idiom: inert to the pointer, styled by the appearance tokens.
    this.popup = document.createElement('div')
    this.popup.className = 'rp-map3d-popup'
    this.popup.style.display = 'none'
    this.popupName = document.createElement('div')
    this.popupName.className = 'rp-map3d-popup-name'
    this.popupMeta = document.createElement('div')
    this.popupMeta.className = 'rp-map3d-popup-meta'
    this.popupCounts = document.createElement('div')
    this.popupCounts.className = 'rp-map3d-popup-counts'
    this.popupHint = document.createElement('div')
    this.popupHint.className = 'rp-map3d-popup-hint'
    this.popupHint.textContent = 'Click to explore'
    this.popup.append(this.popupName, this.popupMeta, this.popupCounts, this.popupHint)
    labelLayer.appendChild(this.popup)

    this.probe = document.createElement('span')
    this.probe.style.display = 'none'
    labelLayer.appendChild(this.probe)
    this.palette = resolvePalette(this.probe)

    this.camera = new THREE.PerspectiveCamera(FOV, 1.5, 2, 9000)
    this.fog = new THREE.Fog(this.palette.surface.clone(), 600, 2400)
    this.scene.fog = this.fog
    this.scene.add(this.territoryGroup)
    this.scene.add(this.edgeGroup)
    this.scene.add(this.nodeGroup)
    this.scene.add(this.hubGroup)

    // Light-mode-first lighting: a bright hemisphere for the airy paper feel
    // and a soft key so the spheres read as satin objects, not flat dots. All
    // three derive from the surface token, so dark palettes relight themselves.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.95)
    this.key = new THREE.DirectionalLight(0xffffff, 1.15)
    this.key.position.set(0.55, 1, 0.4)
    this.fill = new THREE.DirectionalLight(0xffffff, 0.3)
    this.fill.position.set(-0.6, -0.35, -0.7)
    this.scene.add(this.hemi, this.key, this.fill)

    this.selectionRingMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.selectionRing = new THREE.Mesh(this.ringGeo, this.selectionRingMaterial)
    this.selectionRing.visible = false
    this.scene.add(this.selectionRing)
    this.traceRingMaterial = this.selectionRingMaterial.clone()
    this.traceRing = new THREE.Mesh(this.ringGeo, this.traceRingMaterial)
    this.traceRing.visible = false
    this.scene.add(this.traceRing)

    this.applyPaletteToScene()

    // Start from a raised three-quarter view: high enough that the cluster
    // ring reads as a ring rather than clusters stacked behind one another,
    // low enough that depth still shows.
    this.view = {
      target: new THREE.Vector3(),
      theta: -0.5,
      phi: 0.95,
      dist: 640,
    }
    this.distGoal = this.view.dist
    this.idleAnchor = this.view.theta

    // Appearance changes rewrite CSS custom properties on the tenant wrapper
    // and the body; when they do, the resolved WebGL colours must follow.
    this.paletteObserver = new MutationObserver(() => this.refreshPalette())
    this.paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    this.paletteObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(canvas.parentElement ?? canvas)
    this.handleResize()

    this.bindPointerHandlers()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  // -------------------------------------------------------------------
  // Palette.
  // -------------------------------------------------------------------

  refreshPalette() {
    if (this.disposed) return
    this.palette = resolvePalette(this.probe)
    this.applyPaletteToScene()
    for (const visual of this.nodeVisuals.values()) this.applyNodeColour(visual)
    for (const visual of this.edgeVisuals) this.applyEdgeColour(visual)
    for (const visual of this.flowVisuals) this.applyEdgeColour(visual)
    for (const territory of this.territories) {
      const cat = this.palette.cats[territory.style.slot]
      if (cat) territory.material.color.copy(cat)
      const hub = territory.hub
      if (hub) this.applyHubColour(hub, territory.style.slot)
    }
    this.renderDirty = true
  }

  /**
   * A hub wears its category's hue, ringed in a hairline of the same hue
   * pushed away from the surface. The `-ink` token is the hue DARKENED to
   * clear contrast on a light surface, so on a dark tenant palette it sinks
   * into the ground and the ring disappears; the ring lightens instead there,
   * the way the hemisphere light already flips off the surface token.
   */
  private applyHubColour(hub: HubVisual, slot: number) {
    const cat = this.catColour(slot)
    hub.material.color.copy(cat)
    hub.material.emissive.copy(cat).multiplyScalar(0.16)
    const surface = this.palette.surface
    const lightSurface = surface.r * 0.2126 + surface.g * 0.7152 + surface.b * 0.0722 > 0.5
    hub.ringMaterial.color.copy(
      lightSurface
        ? this.palette.inks[slot] ?? cat
        : cat.clone().lerp(new THREE.Color(0xffffff), 0.45),
    )
  }

  private applyPaletteToScene() {
    const surface = this.palette.surface
    this.renderer.setClearColor(surface, 1)
    this.fog.color.copy(surface)
    // Sky drifts towards white above the surface, ground sits below it, so
    // the shading direction survives both light and dark palettes.
    this.hemi.color.copy(surface.clone().lerp(new THREE.Color(0xffffff), 0.72))
    this.hemi.groundColor.copy(surface.clone().multiplyScalar(0.55))
    this.selectionRingMaterial.color.copy(this.palette.accent)
    this.traceRingMaterial.color.copy(this.palette.accent)
  }

  private catColour(slot: number): THREE.Color {
    return this.palette.cats[slot] ?? this.palette.accent
  }

  private applyNodeColour(visual: NodeVisual) {
    const cat = this.catColour(visual.slot)
    if (visual.hollow) {
      visual.material.color.copy(this.palette.surface)
      visual.material.emissive.set(0x000000)
      visual.shellMaterial.color.copy(cat)
    } else {
      visual.material.color.copy(cat)
      // A whisper of self-illumination keeps the hue saturated inside the
      // shadowed half of the sphere, which is where flat dots go muddy.
      visual.material.emissive.copy(cat).multiplyScalar(0.16)
      visual.shellMaterial.color.copy(cat)
    }
  }

  private applyEdgeColour(visual: EdgeVisual) {
    const onPath = this.pathEdgeKeys?.has(visual.key) ?? false
    const focus = this.emphasis.selectedId ?? this.hoveredId
    const touchesFocus = focus !== null &&
      (visual.edge.source === focus || visual.edge.target === focus)
    if (onPath) {
      visual.material.color.copy(this.palette.accent)
      visual.coneMaterial.color.copy(this.palette.accent)
      return
    }
    if (touchesFocus) {
      const focusVisual = focus ? this.nodeVisuals.get(focus) : undefined
      const colour = focusVisual ? this.catColour(focusVisual.slot) : this.palette.accent
      visual.material.color.copy(colour)
      visual.coneMaterial.color.copy(colour)
      return
    }
    const colour = this.catColour(visual.from.slot)
    visual.material.color.copy(colour)
    visual.coneMaterial.color.copy(colour)
  }

  // -------------------------------------------------------------------
  // Data - build the simulation and the scene.
  // -------------------------------------------------------------------

  setData(data: EngineData) {
    this.data = data
    const previous = new Map<string, { x: number; y: number; z: number }>()
    for (const [id, visual] of this.nodeVisuals) {
      previous.set(id, { x: visual.sim.x, y: visual.sim.y, z: visual.sim.z })
    }
    const firstBuild = this.nodeVisuals.size === 0
    // A rebuild (a filter, an expand) carries fold state over: a cluster the
    // reader had open must not slam shut because the data was re-fetched.
    const previousLod = new Map<
      string,
      { lod: number; lodTarget: number; lodFrom: number; lodStarted: number; dived: boolean }
    >()
    for (const [group, hub] of this.hubs) {
      previousLod.set(group, {
        lod: hub.lod,
        lodTarget: hub.lodTarget,
        lodFrom: hub.lodFrom,
        lodStarted: hub.lodStarted,
        dived: hub.dived,
      })
    }

    const counts = new Map<string, number>()
    for (const node of data.nodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1)
    const ordered = new Map(
      [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    )
    const centres: Map<string, Centre3D> = clusterCentres3D(ordered, data.aspect)
    this.centres = centres
    // The landing angle is chosen, not fixed: looking straight down the ring
    // stacks one cluster behind another, so before the first fit the camera
    // walks the circle and keeps the azimuth that spreads the cluster
    // centres furthest apart on screen. A reader who has taken the view
    // keeps it.
    if (!this.viewOwnedFlag && centres.size > 2) {
      this.view.theta = this.bestTheta(centres)
      this.idleAnchor = this.view.theta
      this.idlePhase = 0
    }

    const radiusOf = (node: MapNode) =>
      radiusFor(
        data.measure,
        data.measure === 'links' ? (data.degrees.get(node.id) ?? 0) : node.weight,
      )

    // A node arriving on an expand grows OUT of the node it connects to,
    // seeded on a widening spiral shell around the surviving anchor - left
    // unseeded it would start at its group's centre and the whole expansion
    // would land as a clump somewhere else entirely.
    const anchorSeed = new Map<string, { x: number; y: number; z: number }>()
    if (previous.size > 0) {
      let placed = 0
      for (const node of data.nodes) {
        if (previous.has(node.id)) continue
        const edge = data.edges.find((e) =>
          (e.source === node.id && previous.has(e.target)) ||
          (e.target === node.id && previous.has(e.source))
        )
        const anchor = edge
          ? previous.get(edge.source === node.id ? edge.target : edge.source)
          : undefined
        if (!anchor) continue
        const golden = Math.PI * (3 - Math.sqrt(5))
        const theta = placed * golden
        const zu = 1 - (2 * ((placed % 24) + 0.5)) / 24
        const ring = Math.sqrt(Math.max(0, 1 - zu * zu))
        const rho = 55 + 6 * Math.sqrt(placed)
        anchorSeed.set(node.id, {
          x: anchor.x + rho * ring * Math.cos(theta),
          y: anchor.y + rho * zu,
          z: anchor.z + rho * ring * Math.sin(theta),
        })
        placed += 1
      }
    }
    this.sim = new ForceSim3D({
      nodes: data.nodes.map((node) => {
        const kept = previous.get(node.id) ?? anchorSeed.get(node.id)
        return {
          id: node.id,
          group: node.group,
          radius: radiusOf(node),
          ...(kept ? { x: kept.x, y: kept.y, z: kept.z } : {}),
        }
      }),
      links: data.edges.map((edge) => ({ source: edge.source, target: edge.target })),
      layout: data.layout,
      centres,
    })
    // Settle synchronously, like the 2D map - instant, and immune to
    // background-tab rAF throttling. Live physics then only animates drags.
    this.sim.tick(300)

    this.clearScene()

    data.nodes.forEach((node, index) => {
      const sim = this.sim?.byId(node.id)
      if (!sim) return
      const style = data.groupStyles.get(node.group)
      const slot = style?.slot ?? 0
      const hollow = style?.hollow ?? false
      const degree = data.degrees.get(node.id) ?? 0
      const unlinked = data.measure === 'links' && degree === 0
      const r = radiusOf(node)

      const material = new THREE.MeshStandardMaterial({
        roughness: 0.42,
        metalness: 0.04,
        transparent: true,
        opacity: 1,
      })
      const mesh = new THREE.Mesh(this.sphereGeo, material)
      mesh.userData.nodeId = node.id
      const shellMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: hollow ? 0.95 : 0,
        side: THREE.BackSide,
        depthWrite: false,
      })
      const shell = new THREE.Mesh(this.shellGeo, shellMaterial)
      shell.raycast = () => undefined
      mesh.add(shell)
      shell.scale.setScalar(hollow ? 1.22 : 1.14)
      this.nodeGroup.add(mesh)

      const label = document.createElement('div')
      label.className = 'rp-map3d-label'
      label.textContent = shortLabel(node.label)
      label.style.display = 'none'
      this.labelLayer.appendChild(label)

      const visual: NodeVisual = {
        node,
        sim,
        pos: new THREE.Vector3(sim.x, sim.y, sim.z),
        r: unlinked ? Math.max(3.5, r - 1.5) : r,
        slot,
        hollow,
        unlinked,
        mesh,
        material,
        shell,
        shellMaterial,
        opacity: { current: 1, target: 1 },
        shellOpacity: { current: hollow ? 0.95 : 0, target: hollow ? 0.95 : 0 },
        scale: {
          current: firstBuild && !this.reduced ? 0.001 : 1,
          target: 1,
        },
        lift: { current: 0, target: 0 },
        degree,
        bornAt: firstBuild && !this.reduced ? performance.now() + Math.min(index * 9, 900) : 0,
        label,
        labelW: 0,
        territory: null,
      }
      this.applyNodeColour(visual)
      this.nodeVisuals.set(node.id, visual)
    })

    const laterals = buildLaterals(data.edges)
    this.edgeVisuals = []
    data.edges.forEach((edge, index) => {
      const from = this.nodeVisuals.get(edge.source)
      const to = this.nodeVisuals.get(edge.target)
      if (!from || !to) return
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.tubeGeo, material)
      mesh.raycast = () => undefined
      const coneMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      const cone = new THREE.Mesh(this.coneGeo, coneMaterial)
      cone.raycast = () => undefined
      cone.visible = false
      this.edgeGroup.add(mesh, cone)
      const crossing = from.node.group !== to.node.group
      const visual: EdgeVisual = {
        edge,
        key: `${edge.source}|${edge.label}|${edge.target}`,
        from,
        to,
        mesh,
        material,
        cone,
        coneMaterial,
        width: edgeRadius(edge.weight),
        crossing,
        lateral: laterals[index] ?? 0,
        opacity: { current: 0, target: crossing ? 0.16 : 0.4 },
        emphasised: false,
        label: null,
        labelW: 0,
        folds: [],
        aggregate: false,
      }
      this.applyEdgeColour(visual)
      this.edgeVisuals.push(visual)
    })

    // Territories only exist in the grouped layout, and only when there is
    // more than one category to tell apart. Every territory with enough
    // members also gets its hub: the one mark it folds into when the camera
    // is too far out to tell its members apart.
    this.territories = []
    if (data.layout === 'grouped' && ordered.size > 1) {
      const now = performance.now()
      let hubIndex = 0
      for (const [group] of ordered) {
        const style = data.groupStyles.get(group)
        if (!style) continue
        const members: NodeVisual[] = []
        for (const visual of this.nodeVisuals.values()) {
          if (visual.node.group === group) members.push(visual)
        }
        const count = members.length
        const material = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.055,
          depthWrite: false,
        })
        const cat = this.palette.cats[style.slot]
        if (cat) material.color.copy(cat)
        const mesh = new THREE.Mesh(this.territoryGeo, material)
        mesh.raycast = () => undefined
        mesh.renderOrder = -2
        this.territoryGroup.add(mesh)
        const caption = document.createElement('div')
        caption.className = 'rp-map3d-territory'
        caption.style.color = `var(--rp-cat-${style.slot + 1}-ink)`
        const captionFull = `${group.toUpperCase()} · ${count}`
        caption.textContent = captionFull
        caption.style.display = 'none'
        this.labelLayer.appendChild(caption)
        const territory: TerritoryVisual = {
          group,
          style,
          count,
          mesh,
          material,
          caption,
          captionFull,
          captionShort: group.toUpperCase(),
          captionW: 0,
          captionShortW: 0,
          captionHubW: 0,
          captionShortHubW: 0,
          centre: new THREE.Vector3(),
          r: 0,
          spread: 0,
          hub: null,
        }
        for (const member of members) member.territory = territory
        this.territories.push(territory)

        if (count < HUB_MIN_MEMBERS) continue

        const hubMaterial = new THREE.MeshStandardMaterial({
          roughness: 0.42,
          metalness: 0.04,
          transparent: true,
          opacity: 0,
        })
        const hubMesh = new THREE.Mesh(this.sphereGeo, hubMaterial)
        // Hubs are picked analytically, like nodes - see pick().
        hubMesh.raycast = () => undefined
        hubMesh.visible = false
        const ringMaterial = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(this.haloGeo, ringMaterial)
        ring.raycast = () => undefined
        ring.visible = false
        this.hubGroup.add(hubMesh, ring)
        const kept = previousLod.get(group)
        const hub: HubVisual = {
          id: `hub:${group}`,
          group,
          count,
          members,
          // The anchor shares the territory's centre vector, so the hub and
          // its relations follow the centroid wherever the simulation takes it.
          anchor: {
            node: { id: `hub:${group}`, group },
            pos: territory.centre,
            r: hubRadius(count),
            scale: { current: 1, target: 1 },
            slot: style.slot,
          },
          mesh: hubMesh,
          material: hubMaterial,
          ring,
          ringMaterial,
          flows: [],
          lod: kept?.lod ?? 0,
          lodTarget: kept?.lodTarget ?? 0,
          lodFrom: kept?.lodFrom ?? 0,
          lodStarted: kept?.lodStarted ?? -1,
          dived: kept?.dived ?? false,
          opacity: { current: 1, target: 1 },
          scale: { current: firstBuild && !this.reduced ? 0.001 : 1, target: 1 },
          bornAt: firstBuild && !this.reduced ? now + 240 + Math.min(hubIndex * 45, 600) : 0,
        }
        this.applyHubColour(hub, style.slot)
        hubIndex += 1
        territory.hub = hub
        this.hubs.set(group, hub)
      }
      this.buildAggregateEdges()
    }

    this.paintRank = [...this.nodeVisuals.values()].sort((a, b) => b.r - a.r)
    this.captionRank = [...this.territories].sort((a, b) => b.count - a.count)
    this.measureLabels()
    this.updateWorldBounds()
    // Seed the territory volumes now rather than waiting for the first
    // rendered frame - captions must never paint at a stale origin.
    this.updateTerritories()
    this.updateEmphasisSets()
    this.renderDirty = true
  }

  /**
   * The relations a folded cluster stands in for.
   *
   * Unlike a bipartite money graph, either end of a relation here can fold,
   * so an aggregate is keyed by its EFFECTIVE endpoints - the hub id where
   * that end's cluster has a hub, the node id where it does not. Every
   * relation whose two ends resolve to different effective endpoints
   * contributes to exactly one aggregate; a relation whose ends collapse to
   * the same mark (both inside one folding cluster) has nothing to stand for
   * and simply fades out with its cluster.
   *
   * An aggregate belongs to the hubs at whichever of its ends actually fold,
   * and is drawn only once ALL of them have - otherwise a half-folded pair
   * would show the summary and the detail at the same time.
   */
  private buildAggregateEdges() {
    type Aggregate = {
      from: EdgeAnchor
      to: EdgeAnchor
      hubs: HubVisual[]
      weight: number
      relations: number
    }
    const aggregates = new Map<string, Aggregate>()
    for (const edgeVisual of this.edgeVisuals) {
      const from = this.nodeVisuals.get(edgeVisual.edge.source)
      const to = this.nodeVisuals.get(edgeVisual.edge.target)
      if (!from || !to) continue
      const fromHub = from.territory?.hub ?? null
      const toHub = to.territory?.hub ?? null
      // The fold this individual relation fades out with: either end folding
      // is enough, because the dot at that end is on its way into a hub.
      edgeVisual.folds = fromHub && toHub && fromHub !== toHub
        ? [fromHub, toHub]
        : fromHub
        ? [fromHub]
        : toHub
        ? [toHub]
        : []
      const fromAnchor: EdgeAnchor = fromHub ? fromHub.anchor : from
      const toAnchor: EdgeAnchor = toHub ? toHub.anchor : to
      if (fromAnchor === toAnchor) continue
      if (!fromHub && !toHub) continue
      const key = `${fromAnchor.node.id}|${toAnchor.node.id}`
      const existing = aggregates.get(key)
      if (existing) {
        existing.weight += edgeVisual.edge.weight
        existing.relations += 1
        continue
      }
      const hubs: HubVisual[] = []
      if (fromHub) hubs.push(fromHub)
      if (toHub && toHub !== fromHub) hubs.push(toHub)
      aggregates.set(key, {
        from: fromAnchor,
        to: toAnchor,
        hubs,
        weight: edgeVisual.edge.weight,
        relations: 1,
      })
    }

    for (const [key, agg] of aggregates) {
      const label = agg.relations === 1 ? '1 relation' : `${agg.relations} relations`
      const synthetic: MapEdge = {
        source: agg.from.node.id,
        target: agg.to.node.id,
        label,
        weight: agg.weight,
      }
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      const mesh = new THREE.Mesh(this.tubeGeo, material)
      mesh.raycast = () => undefined
      mesh.visible = false
      const coneMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      const cone = new THREE.Mesh(this.coneGeo, coneMaterial)
      cone.raycast = () => undefined
      cone.visible = false
      this.edgeGroup.add(mesh, cone)
      const flow: EdgeVisual = {
        edge: synthetic,
        key: `agg:${key}`,
        from: agg.from,
        to: agg.to,
        mesh,
        material,
        cone,
        coneMaterial,
        width: edgeRadius(agg.weight),
        crossing: agg.from.node.group !== agg.to.node.group,
        lateral: 0,
        opacity: { current: 0, target: 0.34 },
        emphasised: false,
        label: null,
        labelW: 0,
        folds: agg.hubs,
        aggregate: true,
      }
      this.applyEdgeColour(flow)
      for (const hub of agg.hubs) hub.flows.push(flow)
      this.flowVisuals.push(flow)
    }
  }

  /**
   * Label and caption widths for collision placement, measured once per build
   * with a 2D context set to the elements' own computed fonts - a tenant that
   * restyles them (a different display face, a larger text scale) stays
   * collision-free. A display:none element still resolves its font, so
   * nothing is laid out to read it.
   */
  private measureLabels() {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d')
    }
    const ctx = this.measureCtx
    const fontOf = (element: HTMLElement | undefined): { font: string; spacing: number } => {
      if (!element || typeof getComputedStyle !== 'function') return { font: '', spacing: 0 }
      const cs = getComputedStyle(element)
      const spacing = parseFloat(cs.letterSpacing)
      return {
        font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
        spacing: Number.isFinite(spacing) ? spacing : 0,
      }
    }
    const label = fontOf(this.paintRank[0]?.label)
    const probe = this.territories[0]?.caption
    const caption = fontOf(probe)
    // The folded variant is a step larger: resolve it through the attribute
    // that styles it, so the two widths are both exact.
    probe?.setAttribute('data-hub', '')
    const hubCaption = fontOf(probe)
    probe?.removeAttribute('data-hub')
    this.labelFont = label.font
    this.captionFont = caption.font
    this.captionSpacing = caption.spacing
    const measure = (text: string, font: string, spacing: number, fallback: number): number => {
      if (!ctx || !font) return text.length * fallback
      ctx.font = font
      return ctx.measureText(text).width + spacing * text.length
    }
    for (const visual of this.paintRank) {
      visual.labelW = measure(visual.label.textContent ?? '', this.labelFont, 0, 6.2)
    }
    for (const territory of this.territories) {
      territory.captionW = measure(
        territory.captionFull,
        this.captionFont,
        this.captionSpacing,
        7.4,
      )
      territory.captionShortW = measure(
        territory.captionShort,
        this.captionFont,
        this.captionSpacing,
        7.4,
      )
      territory.captionHubW = measure(
        territory.captionFull,
        hubCaption.font,
        hubCaption.spacing,
        8.2,
      )
      territory.captionShortHubW = measure(
        territory.captionShort,
        hubCaption.font,
        hubCaption.spacing,
        8.2,
      )
    }
  }

  private clearScene() {
    for (const visual of this.nodeVisuals.values()) {
      visual.material.dispose()
      visual.shellMaterial.dispose()
      visual.label.remove()
    }
    for (const visual of [...this.edgeVisuals, ...this.flowVisuals]) {
      visual.material.dispose()
      visual.coneMaterial.dispose()
      visual.label?.remove()
    }
    for (const territory of this.territories) {
      territory.material.dispose()
      territory.caption.remove()
      const hub = territory.hub
      if (hub) {
        hub.material.dispose()
        hub.ringMaterial.dispose()
      }
    }
    this.nodeGroup.clear()
    this.edgeGroup.clear()
    this.territoryGroup.clear()
    this.hubGroup.clear()
    this.nodeVisuals.clear()
    this.edgeVisuals = []
    this.flowVisuals = []
    this.territories = []
    this.captionRank = []
    this.hubs.clear()
    this.hoveredHub = null
    this.pickedNode = null
    this.pickedHub = null
  }

  private updateWorldBounds() {
    const centre = new THREE.Vector3()
    let count = 0
    for (const visual of this.nodeVisuals.values()) {
      centre.x += visual.sim.x
      centre.y += visual.sim.y
      centre.z += visual.sim.z
      count += 1
    }
    if (count === 0) return
    centre.multiplyScalar(1 / count)
    let radius = 120
    for (const visual of this.nodeVisuals.values()) {
      const d = Math.hypot(
        visual.sim.x - centre.x,
        visual.sim.y - centre.y,
        visual.sim.z - centre.z,
      ) + visual.r
      if (d > radius) radius = d
    }
    this.worldCentre.copy(centre)
    this.worldRadius = radius
  }

  // -------------------------------------------------------------------
  // Emphasis - selection, hover, path.
  // -------------------------------------------------------------------

  setEmphasis(emphasis: EngineEmphasis) {
    this.emphasis = emphasis
    this.updateEmphasisSets()
  }

  private setHovered(id: string | null) {
    this.setHover(id, null)
  }

  private setHoveredHub(group: string | null) {
    this.setHover(null, group)
  }

  private setHover(id: string | null, hub: string | null) {
    if (this.hoveredId === id && this.hoveredHub === hub) return
    this.hoveredId = id
    this.hoveredHub = hub
    this.updatePopup()
    this.canvas.style.cursor = id !== null || hub !== null ? 'pointer' : 'grab'
    this.updateEmphasisSets()
  }

  private updateEmphasisSets() {
    const { selectedId, pathEdges, pathFrom } = this.emphasis
    const focus = selectedId ?? this.hoveredId
    if (focus) {
      const ids = new Set<string>([focus])
      for (const visual of this.edgeVisuals) {
        if (visual.edge.source === focus) ids.add(visual.edge.target)
        if (visual.edge.target === focus) ids.add(visual.edge.source)
      }
      this.neighbourIds = ids
    } else {
      this.neighbourIds = null
    }
    if (pathEdges) {
      const ids = new Set<string>()
      for (const edge of pathEdges) {
        ids.add(edge.source)
        ids.add(edge.target)
      }
      this.pathNodeIds = ids
      this.pathEdgeKeys = new Set(pathEdges.map((e) => `${e.source}|${e.label}|${e.target}`))
    } else {
      this.pathNodeIds = null
      this.pathEdgeKeys = null
    }

    for (const visual of this.nodeVisuals.values()) {
      const id = visual.node.id
      const isSelected = id === selectedId
      const isHovered = id === this.hoveredId
      const isPathStart = id === pathFrom
      const inNeighbourhood = this.neighbourIds?.has(id) ?? true
      const onPath = this.pathNodeIds?.has(id) ?? false
      const dimmed = (this.pathNodeIds && !onPath) || (!this.pathNodeIds && !inNeighbourhood)
      const emphasised = isSelected || isHovered || isPathStart || onPath
      // Dimmed marks recede but stay clearly there - they still carry the
      // shape of the map, and the depth fog is already quietening the far
      // side, so a hard fade here would wash the back of the scene out.
      visual.opacity.target = dimmed ? 0.3 : visual.unlinked && !emphasised ? 0.6 : 1
      visual.shellOpacity.target = visual.hollow
        ? (dimmed ? 0.2 : 0.95)
        : isHovered && !isSelected
        ? 0.4
        : 0
      // The hovered node comes forward decisively; the selected one holds a
      // quieter, steadier presence under its ring.
      visual.scale.target = isHovered && !isSelected
        ? 1.24
        : isSelected
        ? 1.14
        : emphasised
        ? 1.08
        : 1
      visual.lift.target = isHovered && !isSelected ? 1 : 0
    }

    for (const visual of this.edgeVisuals) {
      const onPath = this.pathEdgeKeys?.has(visual.key) ?? false
      const touchesFocus = focus !== null &&
        (visual.edge.source === focus || visual.edge.target === focus)
      const dimmed = (this.pathEdgeKeys && !onPath) ||
        (focus !== null && !touchesFocus && !this.pathEdgeKeys)
      const emphasised = onPath || touchesFocus
      visual.emphasised = emphasised
      visual.opacity.target = dimmed ? 0.06 : emphasised ? 0.92 : visual.crossing ? 0.16 : 0.4
      this.applyEdgeColour(visual)
    }

    // An aggregate carries no relation of its own to trace, so it only ever
    // dims: it recedes when something else has focus and returns when the
    // focus goes, exactly like the individual relations it stands for.
    for (const visual of this.flowVisuals) {
      const touchesHovered = this.hoveredHub !== null &&
        visual.folds.some((hub) => hub.group === this.hoveredHub)
      visual.emphasised = touchesHovered
      visual.opacity.target = touchesHovered
        ? 0.92
        : focus !== null || this.pathEdgeKeys
        ? 0.06
        : 0.34
      this.applyEdgeColour(visual)
    }

    for (const hub of this.hubs.values()) {
      const hovered = hub.group === this.hoveredHub
      // A hub holding the focus stays lit; the rest recede with the nodes,
      // so folding never smuggles a category back to full strength.
      const holdsFocus = focus !== null && this.nodeVisuals.get(focus)?.node.group === hub.group
      hub.opacity.target = focus !== null && !holdsFocus && !hovered ? 0.3 : 1
      hub.scale.target = hovered ? 1.1 : 1
    }

    this.updatePopup()
    this.renderDirty = true
  }

  /**
   * Fill and show the hover card for the hovered node, or hide it. The card
   * is for scouting - the dock already tells the selected node's story, so a
   * hovered node that is also selected shows nothing.
   */
  private updatePopup() {
    const visual = this.hoveredId ? this.nodeVisuals.get(this.hoveredId) : undefined
    const hub = !visual && this.hoveredHub !== null ? this.hubs.get(this.hoveredHub) : undefined
    if ((!visual && !hub) || (visual && visual.node.id === this.emphasis.selectedId)) {
      this.popup.style.display = 'none'
      return
    }
    this.popupMeta.replaceChildren()
    const dot = document.createElement('span')
    dot.className = 'rp-map3d-popup-dot'
    const category = document.createElement('span')
    if (hub) {
      this.popupName.textContent = hub.group || 'Entity'
      dot.style.background = `var(--rp-cat-${hub.anchor.slot + 1})`
      category.textContent = 'category'
      category.style.color = `var(--rp-cat-${hub.anchor.slot + 1}-ink)`
      const entities = hub.count === 1 ? '1 entity' : `${hub.count} entities`
      const links = hub.flows.length === 1 ? '1 link out' : `${hub.flows.length} links out`
      this.popupCounts.textContent = `${entities} · ${links}`
      this.popupHint.textContent = 'Click to open the category'
    } else if (visual) {
      this.popupName.textContent = visual.node.label
      if (visual.hollow) {
        dot.style.background = 'transparent'
        dot.style.boxShadow = `inset 0 0 0 2px var(--rp-cat-${visual.slot + 1})`
      } else {
        dot.style.background = `var(--rp-cat-${visual.slot + 1})`
      }
      category.textContent = visual.node.group || 'Entity'
      category.style.color = `var(--rp-cat-${visual.slot + 1}-ink)`
      const relations = visual.degree === 1 ? '1 relation' : `${visual.degree} relations`
      const mentions = visual.node.weight === 1 ? '1 mention' : `${visual.node.weight} mentions`
      this.popupCounts.textContent = `${relations} · ${mentions}`
      this.popupHint.textContent = 'Click to explore'
    }
    this.popupMeta.append(dot, category)
    // Kept as the layer's last child so it rides above every label.
    this.labelLayer.appendChild(this.popup)
    this.popup.style.display = 'block'
    this.positionPopup()
  }

  /** Pin the card beside the hovered mark, flipped inside the canvas edges. */
  private positionPopup() {
    if (this.popup.style.display === 'none') return
    const visual = this.hoveredId ? this.nodeVisuals.get(this.hoveredId) : undefined
    const hub = !visual && this.hoveredHub !== null ? this.hubs.get(this.hoveredHub) : undefined
    const anchor: EdgeAnchor | undefined = visual ?? hub?.anchor
    if (!anchor) {
      this.popup.style.display = 'none'
      return
    }
    this.labelVec.copy(anchor.pos).project(this.camera)
    if (this.labelVec.z > 1 || this.labelVec.z < -1) {
      this.popup.style.display = 'none'
      return
    }
    const sx = (this.labelVec.x * 0.5 + 0.5) * this.width
    const sy = (-this.labelVec.y * 0.5 + 0.5) * this.height
    const camDist = anchor.pos.distanceTo(this.camera.position)
    const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
    const lift = visual ? visual.lift.current : 0
    const screenR = ((anchor.r * anchor.scale.current * (this.height / 2)) /
      (Math.max(1, camDist) * halfTan)) * (1 + lift * 0.15)
    const w = this.popup.offsetWidth
    const h = this.popup.offsetHeight
    let x = sx + screenR + 16
    if (x + w > this.width - 8) x = sx - screenR - 16 - w
    const y = Math.max(8, Math.min(this.height - h - 8, sy - h / 2))
    this.popup.style.transform = `translate(${Math.max(8, x).toFixed(1)}px, ${y.toFixed(1)}px)`
  }

  // -------------------------------------------------------------------
  // View - fit, focus, zoom, insets.
  // -------------------------------------------------------------------

  setInsets(insets: Insets) {
    this.insets = insets
  }

  get viewOwned(): boolean {
    return this.viewOwnedFlag
  }

  /**
   * True while the view is the one a focus move put there and the reader has
   * not touched it since - what lets the map give the space back when the
   * panel that caused the move goes away, without overriding a reader who
   * has moved on.
   */
  get focusOwned(): boolean {
    return this.focusOwnedFlag
  }

  private claimView() {
    this.tween = null
    this.viewOwnedFlag = true
    this.focusOwnedFlag = false
    this.idleSpin = false
  }

  /**
   * A dolly by the reader (wheel, pinch, the zoom buttons) or a fit hands
   * every opened cluster back to the automatic rule. Orbiting does not: a
   * reader turning a just-opened cluster around must not watch it refold.
   */
  private releaseDives() {
    for (const hub of this.hubs.values()) hub.dived = false
  }

  /** The part of the canvas the floating panels leave free, in pixels. */
  private freeBox() {
    const w = Math.max(1, this.width - this.insets.left - this.insets.right)
    const h = Math.max(1, this.height - this.insets.top - this.insets.bottom)
    return {
      w,
      h,
      cx: this.insets.left + w / 2,
      cy: this.insets.top + h / 2,
    }
  }

  /**
   * The camera distance at which a sphere of the given radius fits the free
   * box, and the world-space offset that shifts the camera target so the
   * subject lands in the box's centre rather than the canvas's.
   */
  private frameFor(radius: number) {
    const box = this.freeBox()
    const vHalf = THREE.MathUtils.degToRad(FOV / 2)
    const heightShare = Math.max(0.2, box.h / this.height)
    const widthShare = Math.max(0.2, box.w / this.width)
    const vLimit = Math.atan(Math.tan(vHalf) * heightShare * 0.9)
    const hLimit = Math.atan(Math.tan(vHalf) * this.camera.aspect * widthShare * 0.9)
    const dist = radius / Math.tan(Math.min(vLimit, hLimit))
    return { box, dist }
  }

  /** World units per screen pixel at the given camera distance. */
  private worldPerPixel(dist: number): number {
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / this.height
  }

  /** Shift a target so `point` projects at the free box's centre. */
  private offsetTarget(point: THREE.Vector3, dist: number): THREE.Vector3 {
    const box = this.freeBox()
    const wpp = this.worldPerPixel(dist)
    const ox = box.cx - this.width / 2
    const oy = box.cy - this.height / 2
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    const forward = new THREE.Vector3()
    this.camera.matrixWorld.extractBasis(right, up, forward)
    return point.clone()
      .addScaledVector(right, -ox * wpp)
      .addScaledVector(up, oy * wpp)
  }

  fit(animate = true) {
    this.tween = null
    this.viewOwnedFlag = false
    this.focusOwnedFlag = false
    this.releaseDives()
    if (this.nodeVisuals.size === 0) return
    this.updateWorldBounds()
    this.updateCamera()
    const dist = this.fitDistance()
    this.fitDist = dist
    const target = this.offsetTarget(this.fitCentre, dist)
    const to: View = {
      target,
      theta: this.view.theta,
      phi: this.view.phi,
      dist,
    }
    this.moveView(to, animate ? FIT_MS : 0)
  }

  /**
   * The azimuth from which the cluster ring reads best: the candidate that
   * maximises the worst pairwise on-screen separation of the territory
   * centres, each distance normalised by the pair's blob radii so a large
   * pair is allowed to sit closer than two small ones.
   */
  private bestTheta(centres: Map<string, Centre3D>): number {
    const phi = this.view.phi
    const list = [...centres.values()]
    let best = this.view.theta
    let bestScore = -Infinity
    for (let step = 0; step < 36; step++) {
      const theta = (step / 36) * Math.PI * 2
      // Screen-plane basis at this azimuth: right in the ground plane, up
      // tilted by the elevation.
      const rx = Math.cos(theta)
      const rz = -Math.sin(theta)
      const upScale = Math.cos(phi)
      let score = Infinity
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]
          const b = list[j]
          if (!a || !b) continue
          const dx = (a.x - b.x) * rx + (a.z - b.z) * rz
          const du = (a.y - b.y) * Math.sin(phi) -
            ((a.x - b.x) * -rz + (a.z - b.z) * rx) * upScale
          const separation = Math.hypot(dx, du) / (a.r + b.r)
          if (separation < score) score = separation
        }
      }
      if (score > bestScore) {
        bestScore = score
        best = theta
      }
    }
    return best
  }

  /**
   * The distance at which every node fits the free box at the CURRENT
   * orientation. A 3D bounding sphere is rotation-proof but wasteful: seen
   * from the map's natural elevation the cluster ring is far wider than it
   * is deep on screen, and a sphere fit strands half the canvas. Each node
   * instead constrains the camera along its own line of sight -
   * dist >= lateral / tan(halfAngle) + depth.
   */
  private fitDistance(): number {
    const { theta, phi } = this.view
    this.fitCentre.copy(this.worldCentre)
    this.fitDistanceAt(theta, phi, true)
    this.fitCentre
      .addScaledVector(this.fitVecRight, this.fitMidR)
      .addScaledVector(this.fitVecUp, this.fitMidU)
    return this.fitDistanceAt(theta, phi, false)
  }

  private fitVecE = new THREE.Vector3()
  private fitVecRight = new THREE.Vector3()
  private fitVecUp = new THREE.Vector3()
  private fitVecD = new THREE.Vector3()

  /**
   * Each node constrains the camera along its own line of sight -
   * dist >= lateral / tan(halfAngle) + depth. A caption is set in screen
   * pixels, so its extent GROWS with the distance (px * worldPerPixel(dist));
   * the same inequality with that term solves in closed form to
   * dist >= (lateral / tan + depth) / (1 - px * k / tan), k being world units
   * per pixel per unit of distance - so a caption at the ring's edge has room
   * inside the plate rather than being clipped or suppressed.
   *
   * With `measure`, the shift of the frame centre that BALANCES the two sides
   * is recorded as fitMidR and fitMidU in this orientation's screen basis.
   * Each side's binding quantity is extent + tan * depth, not the bare
   * extent, so the balance point is half the difference of the two one-sided
   * maxima of that; framing it rather than the centroid makes both sides of
   * the plate bind, which is what stops a fit stranding half a wide monitor.
   */
  private fitDistanceAt(theta: number, phi: number, measure: boolean): number {
    // The basis the view will have, from the same spherical coordinates
    // updateCamera uses; e points from the target towards the camera.
    const e = this.fitVecE.set(
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.cos(theta),
    )
    const right = this.fitVecRight.crossVectors(this.edgeUp, e)
    if (right.lengthSq() < 0.001) right.set(1, 0, 0)
    right.normalize()
    const up = this.fitVecUp.crossVectors(e, right)
    const box = this.freeBox()
    const vHalf = THREE.MathUtils.degToRad(FOV / 2)
    const tanH = Math.tan(vHalf) * this.camera.aspect * Math.max(0.2, box.w / this.width) * 0.92
    const tanV = Math.tan(vHalf) * Math.max(0.2, box.h / this.height) * 0.92
    const k = (2 * Math.tan(vHalf)) / this.height
    const centre = this.fitCentre
    const d = this.fitVecD
    let dist = 240
    // One-sided maxima of extent + tan * depth, per screen axis.
    let plusR = -Infinity
    let minusR = -Infinity
    let plusU = -Infinity
    let minusU = -Infinity
    for (const visual of this.nodeVisuals.values()) {
      d.set(visual.sim.x, visual.sim.y, visual.sim.z).sub(centre)
      const depth = d.dot(e)
      const pr = d.dot(right)
      const pu = d.dot(up)
      const lx = Math.abs(pr) + visual.r
      // Headroom for the labels above the marks - above only, so the frame
      // reserves no phantom room below the near side.
      const ly = Math.max(pu + visual.r + 26, -pu + visual.r)
      dist = Math.max(dist, lx / tanH + depth, ly / tanV + depth)
      if (measure) {
        const dh = tanH * depth
        const dv = tanV * depth
        if (pr + visual.r + dh > plusR) plusR = pr + visual.r + dh
        if (-pr + visual.r + dh > minusR) minusR = -pr + visual.r + dh
        if (pu + visual.r + 26 + dv > plusU) plusU = pu + visual.r + 26 + dv
        if (-pu + visual.r + dv > minusU) minusU = -pu + visual.r + dv
      }
    }
    // Captions: centred on the cluster, half a caption wide to either side,
    // and a caption tall above the territory's rim (above, where the
    // placement pass puts it first; the nodes already hold the side below).
    const tall = CAPTION_H + 5 + PLATE_INSET
    const fracV = (tall * k) / tanV
    for (const territory of this.territories) {
      d.copy(territory.centre).sub(centre)
      const depth = d.dot(e)
      const halfW = Math.max(territory.captionW, territory.captionHubW) / 2 + 4 + PLATE_INSET
      const fracH = (halfW * k) / tanH
      if (fracH < 0.9) {
        dist = Math.max(dist, (Math.abs(d.dot(right)) / tanH + depth) / (1 - fracH))
      }
      const top = d.dot(up) + territory.r
      if (fracV < 0.9 && top > 0) {
        dist = Math.max(dist, (top / tanV + depth) / (1 - fracV))
      }
    }
    if (measure) {
      // The captions' extents are only known once the distance is.
      for (const territory of this.territories) {
        d.copy(territory.centre).sub(centre)
        const depth = d.dot(e)
        const pr = d.dot(right)
        const pu = d.dot(up)
        const halfW = (Math.max(territory.captionW, territory.captionHubW) / 2 + 4 + PLATE_INSET) *
          k * dist
        const dh = tanH * depth
        if (pr + halfW + dh > plusR) plusR = pr + halfW + dh
        if (-pr + halfW + dh > minusR) minusR = -pr + halfW + dh
        const top = pu + territory.r + tall * k * dist + tanV * depth
        if (top > plusU) plusU = top
      }
      this.fitMidR = Number.isFinite(plusR) && Number.isFinite(minusR) ? (plusR - minusR) / 2 : 0
      this.fitMidU = Number.isFinite(plusU) && Number.isFinite(minusU) ? (plusU - minusU) / 2 : 0
    }
    return dist
  }

  /**
   * Move the view so a node sits in the middle of the space the panels leave
   * free, close enough that its neighbourhood reads. Returns the distance it
   * settled on (for the follow-up pass when a panel finishes measuring), or
   * null when the node is already comfortably in view - moving the map under
   * someone who can see what they clicked is worse than doing nothing.
   */
  /** `force` reframes even a comfortably-in-view node - an expand changes
   * the neighbourhood underneath a selection that has not moved. */
  focusOn(id: string, keepDist: number | null, force = false): number | null {
    const visual = this.nodeVisuals.get(id)
    if (!visual) return null
    this.updateCamera()
    const point = new THREE.Vector3(visual.sim.x, visual.sim.y, visual.sim.z)
    const box = this.freeBox()

    const projected = point.clone().project(this.camera)
    const sx = (projected.x * 0.5 + 0.5) * this.width
    const sy = (-projected.y * 0.5 + 0.5) * this.height
    const marginX = Math.min(90, box.w * 0.18)
    const marginY = Math.min(90, box.h * 0.18)
    const settled = projected.z < 1 &&
      sx > this.insets.left + marginX && sx < this.insets.left + box.w - marginX &&
      sy > marginY && sy < box.h - marginY
    if (settled && this.insets.bottom <= 0 && !force) return null

    let dist = keepDist
    if (dist === null) {
      let span = visual.r + 30
      for (const edgeVisual of this.edgeVisuals) {
        const otherId = edgeVisual.edge.source === id
          ? edgeVisual.edge.target
          : edgeVisual.edge.target === id
          ? edgeVisual.edge.source
          : null
        if (otherId === null) continue
        const other = this.nodeVisuals.get(otherId)
        if (!other) continue
        const d = Math.hypot(
          other.sim.x - visual.sim.x,
          other.sim.y - visual.sim.y,
          other.sim.z - visual.sim.z,
        ) + other.r
        if (d > span) span = d
      }
      const { dist: fits } = this.frameFor(span * 1.12)
      // Never zoom OUT past the reader's own zoom, mirroring the 2D rule.
      dist = Math.min(
        this.view.dist,
        Math.max(FOCUS_MIN_DIST, Math.min(FOCUS_MAX_DIST, fits)),
      )
    }
    dist = Math.max(this.minDist(), Math.min(this.maxDist(), dist))

    const target = this.offsetTarget(point, dist)
    this.moveView(
      { target, theta: this.view.theta, phi: this.view.phi, dist },
      FOCUS_MS,
    )
    this.viewOwnedFlag = true
    this.focusOwnedFlag = true
    this.idleSpin = false
    return dist
  }

  /**
   * A panel came or went with nothing selected: slide the view by half the
   * change so whatever was centred stays centred, rather than snapping back.
   */
  nudgeForInsets(dxPx: number, dyPx: number) {
    if (dxPx === 0 && dyPx === 0) return
    const wpp = this.worldPerPixel(this.view.dist)
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    const forward = new THREE.Vector3()
    this.camera.matrixWorld.extractBasis(right, up, forward)
    const target = this.view.target.clone()
      .addScaledVector(right, -dxPx * wpp)
      .addScaledVector(up, dyPx * wpp)
    this.moveView({ ...this.view, target }, FOCUS_MS)
  }

  zoomBy(factor: number) {
    this.claimView()
    this.releaseDives()
    this.distGoal = Math.max(this.minDist(), Math.min(this.maxDist(), this.distGoal / factor))
  }

  private minDist(): number {
    return Math.max(60, this.fitDist * MIN_DIST_FACTOR)
  }

  private maxDist(): number {
    return this.fitDist * MAX_DIST_FACTOR
  }

  private moveView(to: View, duration: number) {
    if (this.reduced || duration <= 0) {
      this.view = { ...to, target: to.target.clone() }
      this.distGoal = to.dist
      this.tween = null
      this.renderDirty = true
      return
    }
    this.tween = {
      from: { ...this.view, target: this.view.target.clone() },
      to: { ...to, target: to.target.clone() },
      started: performance.now(),
      duration,
    }
    this.distGoal = to.dist
  }

  // -------------------------------------------------------------------
  // Pointer input - orbit, pan, pinch, node drag, hover, click.
  // -------------------------------------------------------------------

  private bindPointerHandlers() {
    const canvas = this.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    canvas.addEventListener('keydown', this.onKeyDown)
  }

  private unbindPointerHandlers() {
    const canvas = this.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('pointerleave', this.onPointerLeave)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('contextmenu', this.onContextMenu)
    canvas.removeEventListener('keydown', this.onKeyDown)
  }

  private localPoint(event: PointerEvent | WheelEvent) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /**
   * Pointer capture can throw (NotFoundError) for a pointer the browser no
   * longer considers active - synthetic events, or a touch that ended while
   * the handler ran. Losing capture is cosmetic; aborting the handler and
   * stranding half-initialised gesture state is not, so both calls are
   * fenced.
   */
  private capturePointer(pointerId: number) {
    try {
      this.canvas.setPointerCapture?.(pointerId)
    } catch {
      // Capture is best-effort.
    }
  }

  private releasePointer(pointerId: number) {
    try {
      this.canvas.releasePointerCapture?.(pointerId)
    } catch {
      // Already released.
    }
  }

  private raycastVec = new THREE.Vector3()

  /**
   * What is under the pointer, as a node or a hub. Tested analytically
   * against the marks' spheres rather than through a mesh raycast: a folding
   * node's mesh shrinks and goes invisible while it is still notionally
   * there, and a hub's mesh is not in the pickable group at all, so the
   * scene graph is the wrong source of truth for what the reader can hit.
   * A folded cluster offers its hub; an open one offers its members.
   */
  private pick(x: number, y: number) {
    // The camera may not have been placed yet this frame (or ever, in a
    // throttled tab) - derive it from the view before casting.
    this.updateCamera()
    this.raycaster.setFromCamera(
      new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1),
      this.camera,
    )
    const origin = this.raycaster.ray.origin
    const dir = this.raycaster.ray.direction
    const toCentre = this.raycastVec
    let bestNode: NodeVisual | null = null
    let bestHub: HubVisual | null = null
    let bestAlong = Infinity
    const test = (pos: THREE.Vector3, r: number): number | null => {
      toCentre.copy(pos).sub(origin)
      const along = toCentre.dot(dir)
      if (along < 0) return null
      const missSq = toCentre.lengthSq() - along * along
      if (missSq > r * r) return null
      // Rank by where the ray ENTERS the sphere, so a small mark in front
      // beats the big one behind it - the same order a mesh raycast reports.
      const entry = along - Math.sqrt(r * r - missSq)
      if (entry < this.camera.near || entry >= bestAlong) return null
      return entry
    }
    // Dimmed marks stay clickable, exactly as in 2D - the trace flow asks
    // the reader to pick a second entity while everything else is dimmed.
    for (const visual of this.nodeVisuals.values()) {
      const hub = visual.territory?.hub
      if (hub && hub.lod >= 0.5) continue
      // The resting radius, not the animated scale: mid-entrance nodes are
      // visually small but should be pickable at full size.
      const entry = test(visual.pos, visual.r)
      if (entry === null) continue
      bestNode = visual
      bestHub = null
      bestAlong = entry
    }
    for (const hub of this.hubs.values()) {
      if (hub.lod < 0.5) continue
      const entry = test(hub.anchor.pos, hub.anchor.r * hub.anchor.scale.current)
      if (entry === null) continue
      bestHub = hub
      bestNode = null
      bestAlong = entry
    }
    this.pickedNode = bestNode
    this.pickedHub = bestHub
  }

  private raycastNode(x: number, y: number): NodeVisual | null {
    this.pick(x, y)
    return this.pickedNode
  }

  private onPointerDown = (event: PointerEvent) => {
    const point = this.localPoint(event)
    this.pointers.set(event.pointerId, point)
    this.capturePointer(event.pointerId)

    if (this.pointers.size === 2) {
      // A second finger ends whatever one finger had started.
      this.orbit = null
      this.releaseDrag()
      const [a, b] = [...this.pointers.entries()]
      if (a && b) {
        this.claimView()
        this.pinch = {
          a: a[0],
          b: b[0],
          gap: Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y),
          dist: this.view.dist,
          midX: (a[1].x + b[1].x) / 2,
          midY: (a[1].y + b[1].y) / 2,
        }
      }
      return
    }
    if (this.pointers.size > 2 || this.pinch) return
    // A press means the reader is acting, not scouting - the hover card and
    // lift depart before the gesture starts.
    this.setHovered(null)

    if (event.button === 0) this.pick(point.x, point.y)
    else {
      this.pickedNode = null
      this.pickedHub = null
    }
    const hit = this.pickedNode
    // A hub is not a node: it cannot be dragged (there is no single sim body
    // behind it), so the press falls through to the orbit branch and its
    // click is resolved on pointerup.
    const hubHit = this.pickedHub
    if (hit && this.sim) {
      // Drag the node on a camera-facing plane through it, so the motion
      // follows the pointer exactly at any orbit angle.
      const forward = new THREE.Vector3()
      this.camera.getWorldDirection(forward)
      const origin = new THREE.Vector3(hit.sim.x, hit.sim.y, hit.sim.z)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, origin)
      this.drag = { id: hit.node.id, plane, moved: false }
      // A drag plane fixed at pointerdown under a still-drifting camera makes
      // the held node crawl away from the pointer - the drift stops here,
      // without claiming the whole view the way a pan or zoom does.
      this.idleSpin = false
      this.sim.reheat()
      return
    }
    this.orbit = {
      mode: event.button === 2 || event.button === 1 || event.shiftKey ? 'pan' : 'orbit',
      lastX: point.x,
      lastY: point.y,
      moved: 0,
      hub: hubHit ? hubHit.group : null,
    }
    this.canvas.style.cursor = 'grabbing'
  }

  private onPointerMove = (event: PointerEvent) => {
    const point = this.localPoint(event)
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, point)

    const pinch = this.pinch
    if (pinch) {
      const a = this.pointers.get(pinch.a)
      const b = this.pointers.get(pinch.b)
      if (!a || !b) return
      const gap = Math.hypot(a.x - b.x, a.y - b.y)
      if (gap > 0 && pinch.gap > 0) {
        const next = Math.max(
          this.minDist(),
          Math.min(this.maxDist(), pinch.dist * (pinch.gap / gap)),
        )
        this.view.dist = next
        this.distGoal = next
        this.releaseDives()
      }
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      this.panBy(midX - pinch.midX, midY - pinch.midY)
      pinch.midX = midX
      pinch.midY = midY
      this.renderDirty = true
      return
    }

    const drag = this.drag
    if (drag && this.sim) {
      drag.moved = true
      this.raycaster.setFromCamera(
        new THREE.Vector2((point.x / this.width) * 2 - 1, -(point.y / this.height) * 2 + 1),
        this.camera,
      )
      const hitPoint = new THREE.Vector3()
      if (this.raycaster.ray.intersectPlane(drag.plane, hitPoint)) {
        this.sim.pin(drag.id, hitPoint.x, hitPoint.y, hitPoint.z)
      }
      return
    }

    const orbit = this.orbit
    if (orbit) {
      const dx = point.x - orbit.lastX
      const dy = point.y - orbit.lastY
      orbit.moved += Math.abs(dx) + Math.abs(dy)
      orbit.lastX = point.x
      orbit.lastY = point.y
      if (orbit.moved > 3) this.claimView()
      if (orbit.mode === 'pan') this.panBy(dx, dy)
      else {
        this.view.theta -= dx * 0.005
        this.view.phi = Math.max(PHI_MIN, Math.min(PHI_MAX, this.view.phi - dy * 0.005))
      }
      this.renderDirty = true
      return
    }

    this.hoverPos = point
    this.hoverDirty = true
  }

  private panBy(dxPx: number, dyPx: number) {
    const wpp = this.worldPerPixel(this.view.dist)
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    const forward = new THREE.Vector3()
    this.camera.matrixWorld.extractBasis(right, up, forward)
    this.view.target.addScaledVector(right, -dxPx * wpp).addScaledVector(up, dyPx * wpp)
  }

  private releaseDrag() {
    const drag = this.drag
    if (!drag) return
    this.sim?.unpin(drag.id)
    this.sim?.cool()
    // No gesture guard here: a drag's own pointerup is consumed inside the
    // drag branch, so flagging it would swallow the reader's NEXT click.
    // Only a pinch leaves a browser-synthesised click behind to guard against.
    this.drag = null
  }

  private onPointerUp = (event: PointerEvent) => {
    const point = this.localPoint(event)
    this.pointers.delete(event.pointerId)
    this.releasePointer(event.pointerId)

    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null
        this.gestured = true
      }
      return
    }

    const drag = this.drag
    if (drag) {
      const moved = drag.moved
      this.releaseDrag()
      if (!moved) {
        // A press on a node that never moved is a selection.
        this.onSelect(drag.id)
      }
      return
    }

    const orbit = this.orbit
    this.orbit = null
    this.canvas.style.cursor = 'grab'
    if (orbit && orbit.moved <= 3) {
      // The pointer went down and came back up in place: a click. The click
      // some browsers synthesise after a pinch must not clear the selection.
      if (this.gestured) {
        this.gestured = false
        return
      }
      if (orbit.hub !== null) {
        this.diveInto(orbit.hub)
        return
      }
      this.pick(point.x, point.y)
      if (this.pickedNode) {
        this.onSelect(this.pickedNode.node.id)
      } else if (this.pickedHub) {
        this.diveInto(this.pickedHub.group)
      } else if (
        this.emphasis.selectedId === null && this.emphasis.pathEdges === null &&
        this.view.dist < this.fitDist * 0.9
      ) {
        // Nothing to clear and the view is inside a cluster: empty space is
        // the way back out, and the clusters refold on the way.
        this.fit(true)
      } else {
        this.onSelect(null)
      }
    }
    this.gestured = false
  }

  private onPointerLeave = () => {
    this.hoverPos = null
    this.setHovered(null)
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault()
    this.claimView()
    this.releaseDives()
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    this.distGoal = Math.max(this.minDist(), Math.min(this.maxDist(), this.distGoal / factor))
  }

  private onContextMenu = (event: Event) => {
    event.preventDefault()
  }

  /**
   * The entity closest to the middle of the free box - what Enter selects.
   * Orbiting with the arrows re-aims it, so the keyboard can reach anything
   * visible; the navigator rail and the find field cover the rest by name.
   */
  private centremost() {
    const box = this.freeBox()
    let bestD = Infinity
    const v = this.labelVec
    this.pickedNode = null
    this.pickedHub = null
    const consider = (pos: THREE.Vector3): boolean => {
      v.copy(pos).project(this.camera)
      if (v.z > 1 || v.z < -1) return false
      const sx = (v.x * 0.5 + 0.5) * this.width
      const sy = (-v.y * 0.5 + 0.5) * this.height
      if (sx < 0 || sx > this.width || sy < 0 || sy > this.height) return false
      const d = Math.hypot(sx - box.cx, sy - box.cy)
      if (d >= bestD) return false
      bestD = d
      return true
    }
    for (const visual of this.nodeVisuals.values()) {
      const hub = visual.territory?.hub
      if (hub && hub.lod >= 0.5) continue
      if (consider(visual.pos)) {
        this.pickedNode = visual
        this.pickedHub = null
      }
    }
    for (const hub of this.hubs.values()) {
      if (hub.lod < 0.5) continue
      if (consider(hub.anchor.pos)) {
        this.pickedHub = hub
        this.pickedNode = null
      }
    }
  }

  /** Keyboard access: arrows orbit, plus and minus zoom, Enter selects. */
  private onKeyDown = (event: KeyboardEvent) => {
    const step = 0.15
    switch (event.key) {
      case 'Enter':
      case ' ': {
        this.centremost()
        if (this.pickedHub) this.diveInto(this.pickedHub.group)
        else if (this.pickedNode) this.onSelect(this.pickedNode.node.id)
        break
      }
      case 'ArrowLeft':
        this.claimView()
        this.view.theta += step
        break
      case 'ArrowRight':
        this.claimView()
        this.view.theta -= step
        break
      case 'ArrowUp':
        this.claimView()
        this.view.phi = Math.max(PHI_MIN, this.view.phi - step)
        break
      case 'ArrowDown':
        this.claimView()
        this.view.phi = Math.min(PHI_MAX, this.view.phi + step)
        break
      case '+':
      case '=':
        this.zoomBy(1.3)
        break
      case '-':
        this.zoomBy(1 / 1.3)
        break
      default:
        return
    }
    event.preventDefault()
    this.renderDirty = true
  }

  // -------------------------------------------------------------------
  // Frame loop.
  // -------------------------------------------------------------------

  private handleResize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    this.width = rect.width
    this.height = rect.height
    this.renderer.setSize(rect.width, rect.height, false)
    this.camera.aspect = rect.width / rect.height
    this.camera.updateProjectionMatrix()
    if (!this.viewOwnedFlag && this.nodeVisuals.size > 0) this.fit(false)
    this.renderDirty = true
  }

  private stepFades(dt: number): boolean {
    // Exponential approach: reads as the same cross-fade the 2D map does with
    // its 180ms opacity transition.
    const rate = this.reduced ? 1 : 1 - Math.exp(-dt / 110)
    let active = false
    const step = (fade: Fade): number => {
      const delta = fade.target - fade.current
      if (Math.abs(delta) < 0.004) {
        fade.current = fade.target
        return fade.current
      }
      active = true
      fade.current += delta * rate
      return fade.current
    }
    const now = performance.now()
    for (const visual of this.nodeVisuals.values()) {
      if (visual.bornAt > 0 && now < visual.bornAt) {
        active = true
      } else {
        visual.bornAt = 0
        step(visual.scale)
      }
      step(visual.opacity)
      step(visual.shellOpacity)
      step(visual.lift)
    }
    for (const visual of this.edgeVisuals) step(visual.opacity)
    for (const visual of this.flowVisuals) step(visual.opacity)
    for (const hub of this.hubs.values()) {
      if (hub.bornAt > 0 && now < hub.bornAt) {
        active = true
      } else {
        hub.bornAt = 0
        step(hub.scale)
      }
      step(hub.opacity)
    }
    return active
  }

  private frame = (now: number) => {
    if (this.disposed) return
    this.frameHandle = requestAnimationFrame(this.frame)
    const dt = Math.min(64, now - this.lastFrame)
    this.lastFrame = now
    this.frameCount += 1

    const simWarm = this.sim !== null && (this.sim.alpha() > 0.02 || this.drag !== null)
    if (simWarm) {
      this.sim?.tick(1)
      this.renderDirty = true
    }

    // Camera motion: the focus tween, the smoothed dolly and the idle drift.
    const tween = this.tween
    if (tween) {
      const t = Math.min(1, (now - tween.started) / tween.duration)
      const e = 1 - Math.pow(1 - t, 3)
      this.view.target.lerpVectors(tween.from.target, tween.to.target, e)
      this.view.theta = tween.from.theta + (tween.to.theta - tween.from.theta) * e
      this.view.phi = tween.from.phi + (tween.to.phi - tween.from.phi) * e
      this.view.dist = tween.from.dist * Math.pow(tween.to.dist / tween.from.dist, e)
      if (t >= 1) this.tween = null
      this.renderDirty = true
    } else {
      const distDelta = this.distGoal - this.view.dist
      if (Math.abs(distDelta) > 0.5) {
        this.view.dist += distDelta * (this.reduced ? 1 : Math.min(1, dt / 90))
        this.renderDirty = true
      }
      if (this.idleSpin && this.nodeVisuals.size > 0) {
        this.idlePhase += dt / 1000
        this.view.theta = this.idleAnchor +
          IDLE_SWAY * Math.sin((this.idlePhase / IDLE_SWAY_PERIOD) * Math.PI * 2)
        // The fit holds for one orientation, so the sway re-fits as it turns:
        // the framing stays tight and nothing walks off the plate or under a
        // panel. The change is a few percent over a whole swing.
        if (!this.viewOwnedFlag) {
          this.updateCamera()
          const dist = this.fitDistance()
          this.fitDist = dist
          this.view.dist = dist
          this.distGoal = dist
          this.view.target.copy(this.offsetTarget(this.fitCentre, dist))
        }
        this.renderDirty = true
      }
    }

    if (this.stepFades(dt)) this.renderDirty = true
    const lodActive = this.updateLod(now)
    if (lodActive) this.renderDirty = true

    // A fold in flight changes what is under a still pointer, so the hover
    // test reruns while one is active.
    if ((this.hoverDirty || lodActive) && !this.drag && !this.orbit && !this.pinch) {
      this.hoverDirty = false
      if (this.hoverPos) {
        this.pick(this.hoverPos.x, this.hoverPos.y)
        this.setHover(
          this.pickedNode ? this.pickedNode.node.id : null,
          this.pickedHub ? this.pickedHub.group : null,
        )
      }
    }

    if (!this.renderDirty) return

    this.renderDirty = false
    this.updateCamera()
    // Territories first: the hubs and the folding nodes are placed relative
    // to the cluster centroids, which the simulation has just moved.
    if (simWarm) this.updateTerritories()
    this.updateNodeMeshes()
    this.updateHubMeshes()
    this.updateEdgeMeshes()
    this.updateRings()
    this.renderer.render(this.scene, this.camera)
    this.projectLabels()
    if (simWarm || this.tween || lodActive) this.renderDirty = true
  }

  private updateCamera() {
    const { target, theta, phi, dist } = this.view
    const sinPhi = Math.sin(phi)
    this.camera.position.set(
      target.x + dist * sinPhi * Math.sin(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * sinPhi * Math.cos(theta),
    )
    this.camera.lookAt(target)
    this.camera.updateMatrixWorld()
    // Fog rides the camera so depth always fades at the same visual rate:
    // the far side of the map melts into the paper at any zoom.
    // Gentle: the far side of the map softens into the paper but every mark
    // stays clearly readable at the fitted view - depth is a cue, not a veil.
    this.fog.near = dist + this.worldRadius * 0.35
    this.fog.far = dist + this.worldRadius * 4.4
  }

  private nodeLiftDir = new THREE.Vector3()

  private updateNodeMeshes() {
    for (const visual of this.nodeVisuals.values()) {
      const hub = visual.territory?.hub ?? null
      const lod = hub ? hub.lod : 0
      const pos = visual.pos
      pos.set(visual.sim.x, visual.sim.y, visual.sim.z)
      // The fold: each dot drifts to the centroid, thins and fades while the
      // hub grows over it; unfolding runs the same path backwards.
      if (hub && lod > 0) pos.lerp(hub.anchor.pos, lod)
      const open = 1 - lod
      const scale = Math.max(0.001, visual.r * visual.scale.current * (0.55 + 0.45 * open))
      visual.mesh.position.copy(pos)
      if (visual.lift.current > 0.001) {
        // The lift runs along the view axis, so the node comes towards the
        // reader without sliding off its own edges on screen.
        this.nodeLiftDir.copy(this.camera.position).sub(visual.mesh.position).normalize()
        visual.mesh.position.addScaledVector(
          this.nodeLiftDir,
          visual.lift.current * (visual.r * 0.6 + 10),
        )
      }
      visual.mesh.scale.setScalar(scale)
      // Squared, so a dot is well out of the way before the hub is solid -
      // the two never read as two marks for the same thing.
      const opacity = visual.opacity.current * open * open
      visual.mesh.visible = opacity > 0.005
      visual.material.opacity = opacity
      visual.material.depthWrite = opacity > 0.5
      visual.shellMaterial.opacity = visual.shellOpacity.current * open
      visual.shell.visible = visual.shellMaterial.opacity > 0.01
    }
  }

  private updateHubMeshes() {
    for (const territory of this.territories) {
      const hub = territory.hub
      if (!hub) continue
      const lod = hub.lod
      // The territory volume gives way to the hub as the cluster folds.
      territory.material.opacity = 0.055 * (1 - lod)
      territory.mesh.visible = lod < 0.98
      const grow = 0.55 + 0.45 * lod
      const scale = hub.scale.current * grow
      hub.anchor.scale.current = scale
      if (lod <= 0.001) {
        hub.mesh.visible = false
        hub.ring.visible = false
        continue
      }
      const r = Math.max(0.001, hub.anchor.r * scale)
      const opacity = hub.opacity.current * lod
      hub.mesh.visible = opacity > 0.005
      hub.mesh.position.copy(hub.anchor.pos)
      hub.mesh.scale.setScalar(r)
      hub.material.opacity = opacity
      hub.material.depthWrite = opacity > 0.5
      // The hairline sits just off the sphere, facing the camera, in the ink.
      const ringT = Math.max(0, (lod - 0.25) / 0.75)
      hub.ring.visible = ringT > 0.01
      hub.ring.position.copy(hub.anchor.pos)
      hub.ring.scale.setScalar(r * 1.24)
      hub.ring.quaternion.copy(this.camera.quaternion)
      hub.ringMaterial.opacity = 0.75 * hub.opacity.current * ringT
    }
  }

  private edgeUp = new THREE.Vector3(0, 1, 0)
  private edgeTmpDir = new THREE.Vector3()
  private edgeTmpSide = new THREE.Vector3()
  private edgeTmpMid = new THREE.Vector3()
  private edgeTmpQuat = new THREE.Quaternion()

  /**
   * How much of a relation its clusters' folds leave visible. An individual
   * relation is drawn while BOTH ends are still dots; an aggregate is drawn
   * only once every cluster it stands for has folded, so the summary and the
   * detail cross-fade rather than overlap.
   */
  private edgeFold(visual: EdgeVisual): number {
    if (visual.folds.length === 0) return 1
    let fold = 1
    for (const hub of visual.folds) fold *= visual.aggregate ? hub.lod : 1 - hub.lod
    return fold
  }

  private updateEdgeMeshes() {
    for (const visual of this.edgeVisuals) this.layoutEdge(visual)
    for (const visual of this.flowVisuals) this.layoutEdge(visual)
  }

  private layoutEdge(visual: EdgeVisual) {
    const dir = this.edgeTmpDir
    const side = this.edgeTmpSide
    const mid = this.edgeTmpMid
    const { from, to } = visual
    // Endpoints are the RENDERED positions, so a relation follows its node
    // into the hub as the cluster folds instead of pointing at an empty spot.
    const fold = this.edgeFold(visual)
    const opacity = visual.opacity.current * fold
    dir.copy(to.pos).sub(from.pos)
    const len = dir.length()
    if (len < 1 || opacity <= 0.01) {
      visual.mesh.visible = false
      visual.cone.visible = false
      return
    }
    dir.multiplyScalar(1 / len)
    const rFrom = from.r * from.scale.current
    const rTo = to.r * to.scale.current
    const arrow = visual.emphasised ? Math.max(4.5, visual.width * 3.2) : 0
    // The tube runs rim to rim, not midpoint out: a hub-leaf pair centred
    // on the geometric midpoint leaves a floating gap at the small end.
    const startOffset = rFrom + 1
    const endOffset = rTo + arrow + 1
    const span = Math.max(1, len - startOffset - endOffset)

    // A stable sideways direction for parallel relations to fan along.
    side.set(dir.z, 0, -dir.x)
    if (side.lengthSq() < 0.01) side.set(1, 0, 0)
    side.normalize()
    const bow = visual.lateral * Math.min(12, len * 0.1)

    const along = startOffset + span / 2
    mid.copy(from.pos).addScaledVector(dir, along).addScaledVector(side, bow)
    const width = visual.emphasised ? Math.max(visual.width, 1.5) : visual.width
    visual.mesh.visible = true
    visual.mesh.position.copy(mid)
    visual.mesh.quaternion.copy(this.edgeTmpQuat.setFromUnitVectors(this.edgeUp, dir))
    visual.mesh.scale.set(width, span, width)
    visual.material.opacity = opacity

    if (visual.emphasised) {
      visual.cone.visible = true
      visual.cone.position.copy(to.pos).addScaledVector(dir, -(rTo + arrow / 2 + 1))
      visual.cone.quaternion.copy(this.edgeTmpQuat)
      const coneW = Math.max(2.2, width * 2.1)
      visual.cone.scale.set(coneW, arrow, coneW)
      visual.coneMaterial.opacity = Math.min(1, opacity + 0.05)
    } else {
      visual.cone.visible = false
    }
  }

  private updateTerritories() {
    for (const territory of this.territories) {
      let x = 0
      let y = 0
      let z = 0
      let n = 0
      for (const visual of this.nodeVisuals.values()) {
        if (visual.node.group !== territory.group) continue
        x += visual.sim.x
        y += visual.sim.y
        z += visual.sim.z
        n += 1
      }
      if (n === 0) {
        territory.mesh.visible = false
        territory.caption.style.display = 'none'
        continue
      }
      x /= n
      y /= n
      z /= n
      let spread = 0
      for (const visual of this.nodeVisuals.values()) {
        if (visual.node.group !== territory.group) continue
        const d = Math.hypot(visual.sim.x - x, visual.sim.y - y, visual.sim.z - z) + visual.r
        if (d > spread) spread = d
      }
      territory.centre.set(x, y, z)
      // The spread is the cluster's real extent; the volume adds a margin.
      // Semantic zoom measures the former, so the fold threshold is about
      // the marks themselves rather than the blob drawn around them.
      territory.spread = spread
      territory.r = spread + 22
      territory.mesh.visible = true
      territory.mesh.position.set(x, y, z)
      territory.mesh.scale.setScalar(territory.r)
    }
  }

  // -------------------------------------------------------------------
  // Semantic zoom - the fold state of each cluster.
  // -------------------------------------------------------------------

  /**
   * Retarget a hub's fold. The tween restarts from wherever the current value
   * is, so a reversal mid-flight turns back smoothly instead of jumping to
   * either end.
   */
  private setLod(hub: HubVisual, target: number, now: number) {
    if (hub.lodTarget === target && hub.lodStarted >= 0) return
    hub.lodTarget = target
    hub.lodFrom = hub.lod
    hub.lodStarted = now
    this.renderDirty = true
  }

  /** The distance the camera is heading for, so a fold anticipates a wheel or a flight. */
  private goalDist(): number {
    return this.tween ? this.tween.to.dist : this.distGoal
  }

  /**
   * Decide and advance every cluster's fold. A cluster folds once its spread
   * would draw narrower than COLLAPSE_PX on screen and unfolds past
   * EXPAND_PX; the gap is the hysteresis, so a wheel notch at the boundary
   * never flickers. Clusters holding the selection or a traced path, and a
   * just-opened one, never fold. Returns true while any fold is mid-flight.
   */
  private updateLod(now: number): boolean {
    if (this.hubs.size === 0) return false
    // The camera may not have been placed since the last view change.
    this.updateCamera()
    // Judged at the orbit distance the camera is heading for, not each
    // cluster's own depth: the smoothed dolly lags the wheel, so the fold
    // begins as the reader turns it, and clusters fold in size order rather
    // than the far side of the ring folding while the near side stays open.
    const dist = Math.max(1, this.goalDist())
    const pinnedGroups = this.pinnedGroups()
    let active = false
    for (const territory of this.territories) {
      const hub = territory.hub
      if (!hub) continue
      const px = clusterScreenPx(territory.spread, this.height, dist)
      const want = nextFold(hub.lodTarget === 1 ? 1 : 0, px, {
        pinned: pinnedGroups !== null && pinnedGroups.has(hub.group),
        dived: hub.dived,
      })
      if (hub.lodStarted < 0) {
        // First evaluation: land in the resolved state without a show.
        hub.lodTarget = want
        hub.lod = want
        hub.lodFrom = want
        hub.lodStarted = now
        this.renderDirty = true
        continue
      }
      if (want !== hub.lodTarget) this.setLod(hub, want, now)
      if (hub.lod !== hub.lodTarget) {
        if (this.reduced) {
          hub.lod = hub.lodTarget
        } else {
          const t = Math.min(1, (now - hub.lodStarted) / LOD_MS)
          hub.lod = hub.lodFrom + (hub.lodTarget - hub.lodFrom) * easeInOut(t)
          if (t >= 1) hub.lod = hub.lodTarget
        }
        active = true
      }
    }
    return active
  }

  /** Groups that must stay unfolded: those holding the selection or a traced path. */
  private pinnedGroups(): Set<string> | null {
    const { selectedId, pathEdges, pathFrom } = this.emphasis
    if (selectedId === null && pathEdges === null && pathFrom === null) return null
    const groups = new Set<string>()
    const add = (id: string | null) => {
      if (id === null) return
      const visual = this.nodeVisuals.get(id)
      if (visual) groups.add(visual.node.group)
    }
    add(selectedId)
    add(pathFrom)
    if (pathEdges) {
      for (const edge of pathEdges) {
        add(edge.source)
        add(edge.target)
      }
    }
    return groups
  }

  /**
   * Open a folded cluster: fly the camera to frame it and unfold it on the
   * way. The dive flag keeps the automatic rule from refolding it while the
   * camera is still far out; the reader's next zoom or a fit releases it.
   */
  diveInto(group: string) {
    const territory = this.territories.find((t) => t.group === group)
    const hub = territory?.hub
    if (!territory || !hub) return
    this.updateCamera()
    // Frame the cluster with room around it: its neighbours stay in view, so
    // the reader keeps their bearings.
    const { dist: fits } = this.frameFor(territory.spread * 1.55 + 40)
    const dist = Math.max(this.minDist(), Math.min(this.maxDist(), fits))
    const target = this.offsetTarget(territory.centre, dist)
    this.moveView({ target, theta: this.view.theta, phi: this.view.phi, dist }, DIVE_MS)
    hub.dived = true
    this.setLod(hub, 0, performance.now())
    this.viewOwnedFlag = true
    this.focusOwnedFlag = true
    this.idleSpin = false
    this.setHoveredHub(null)
  }

  /** Every foldable cluster's fold state, by group - for the shell and its tests. */
  get folded(): ReadonlyMap<string, boolean> {
    const out = new Map<string, boolean>()
    for (const [group, hub] of this.hubs) out.set(group, hub.lodTarget === 1)
    return out
  }

  private updateRings() {
    const place = (ring: THREE.Mesh, material: THREE.MeshBasicMaterial, id: string | null) => {
      const visual = id ? this.nodeVisuals.get(id) : undefined
      if (!visual) {
        ring.visible = false
        return
      }
      ring.visible = true
      ring.position.copy(visual.pos)
      ring.scale.setScalar(visual.r * visual.scale.current)
      ring.quaternion.copy(this.camera.quaternion)
      material.opacity = 0.85
    }
    place(this.selectionRing, this.selectionRingMaterial, this.emphasis.selectedId)
    place(
      this.traceRing,
      this.traceRingMaterial,
      this.emphasis.pathFrom !== this.emphasis.selectedId ? this.emphasis.pathFrom : null,
    )
  }

  // -------------------------------------------------------------------
  // Labels - DOM, projected. Real type set in the tenant's own tokens, which
  // WebGL text never quite matches.
  // -------------------------------------------------------------------

  private labelVec = new THREE.Vector3()

  /** Claim a screen box unless it collides with one already claimed. */
  private placeBox(x1: number, y1: number, x2: number, y2: number, force = false): boolean {
    const placed = this.placedLabelBoxes
    if (!force) {
      for (const p of placed) {
        if (x1 < p.x2 && x2 > p.x1 && y1 < p.y2 && y2 > p.y1) return false
      }
    }
    let box = this.boxPool[placed.length]
    if (!box) {
      box = { x1, y1, x2, y2 }
      this.boxPool.push(box)
    } else {
      box.x1 = x1
      box.y1 = y1
      box.x2 = x2
      box.y2 = y2
    }
    placed.push(box)
    return true
  }

  /** The last successful caption placement - fields, so the pass allocates nothing. */
  private capText = ''
  private capBaseline = 0
  private capX = 0

  /**
   * Find room for a cluster caption of width `w` around a mark at (sx, sy)
   * with screen radius `screenR`: above the mark, below it, then each again
   * shifted sideways just far enough to stay inside the plate. The plate is
   * the canvas less the panels' insets, and it is a hard edge - a caption is
   * never drawn cut off, nor under a panel. Sets capText, capX and
   * capBaseline on success.
   */
  private placeCaption(text: string, w: number, sx: number, sy: number, screenR: number): boolean {
    const half = w / 2 + 4
    const plateL = this.insets.left + PLATE_INSET
    const plateR = this.width - this.insets.right - PLATE_INSET
    const plateT = this.insets.top + PLATE_INSET
    const plateB = this.height - this.insets.bottom - PLATE_INSET
    if (half * 2 > plateR - plateL) return false
    for (let pass = 0; pass < 2; pass++) {
      for (let side = 0; side < 2; side++) {
        const y1 = side === 0 ? sy - screenR - 5 - CAPTION_H : sy + screenR + 5
        const y2 = y1 + CAPTION_H
        if (y1 < plateT || y2 > plateB) continue
        let x1 = sx - half
        let x2 = sx + half
        if (x1 < plateL || x2 > plateR) {
          if (pass === 0) continue
          const shift = x1 < plateL ? plateL - x1 : plateR - x2
          x1 += shift
          x2 += shift
        }
        if (!this.placeBox(x1, y1, x2, y2)) continue
        this.capText = text
        this.capBaseline = y2
        this.capX = (x1 + x2) / 2
        return true
      }
    }
    return false
  }

  /** Record a mark's screen disc in the pooled list; returns it. */
  private pushDisc(pos: THREE.Vector3, r: number, opacity: number, halfTan: number): ScreenDisc {
    let disc = this.discs[this.discCount]
    if (!disc) {
      disc = { ok: false, sx: 0, sy: 0, camDist: 0, screenR: 0, opacity: 0 }
      this.discs.push(disc)
    }
    this.discCount += 1
    this.labelVec.copy(pos).project(this.camera)
    disc.ok = this.labelVec.z <= 1 && this.labelVec.z >= -1
    disc.sx = (this.labelVec.x * 0.5 + 0.5) * this.width
    disc.sy = (-this.labelVec.y * 0.5 + 0.5) * this.height
    disc.camDist = pos.distanceTo(this.camera.position)
    disc.screenR = (r * (this.height / 2)) / (Math.max(1, disc.camDist) * halfTan)
    disc.opacity = opacity
    return disc
  }

  /**
   * Labels, in three tiers so no two ever sit on top of each other:
   *
   *   1. the emphasised few (selection, hover, a traced path) - always shown,
   *      and everything after them keeps clear of them;
   *   2. cluster captions, largest cluster first - above the mark, else below
   *      it, then each shifted to stay inside the plate, else the name
   *      without its count, else nothing;
   *   3. the rest by size - a focused view names only the neighbourhood, a
   *      free view names the biggest within a budget that grows as the camera
   *      comes closer, each new name fading in rather than popping.
   *
   * Every label is also kept off the face of a nearer readable sphere (node
   * or hub), so a name never reads as the caption of the wrong mark.
   */
  private projectLabels() {
    const cam = this.camera
    const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
    const focus = this.emphasis.selectedId ?? this.hoveredId
    const { selectedId, pathFrom } = this.emphasis
    this.placedLabelBoxes.length = 0
    this.discCount = 0

    // Every node's screen disc first, so a label can be tested against ALL
    // nearer spheres - not just the ones that happen to have labels of their
    // own. Inside a dense cluster a label anchored above a low sphere
    // otherwise lands on the FACE of the taller sphere behind its anchor and
    // reads as that sphere's caption.
    for (const visual of this.paintRank) {
      // A lifted (hovered) node is nearer the camera than its position says,
      // so its apparent radius grows a touch beyond this figure.
      this.pushDisc(
        visual.pos,
        visual.r * visual.scale.current * (1 + visual.lift.current * 0.15),
        visual.material.opacity,
        halfTan,
      )
    }
    const nodeDiscs = this.discCount
    for (const hub of this.hubs.values()) {
      if (hub.lod > 0.5) {
        this.pushDisc(
          hub.anchor.pos,
          hub.anchor.r * hub.anchor.scale.current,
          hub.material.opacity,
          halfTan,
        )
      }
    }
    const discs = this.discs
    const discCount = this.discCount

    const isEmphasised = (id: string) =>
      id === focus || id === this.hoveredId || id === pathFrom ||
      (this.pathNodeIds?.has(id) ?? false)
    const show = (visual: NodeVisual, sx: number, y: number, opacity: number) => {
      const label = visual.label
      label.style.display = 'block'
      label.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${
        y.toFixed(1)
      }px)`
      label.style.opacity = opacity.toFixed(2)
    }

    // 1. The emphasised few - the selection and its path are always named,
    // and everything after them, captions included, keeps clear of them.
    for (let rank = 0; rank < this.paintRank.length; rank++) {
      const visual = this.paintRank[rank]
      const disc = discs[rank]
      if (!visual || !disc) continue
      const id = visual.node.id
      if (!isEmphasised(id)) continue
      const label = visual.label
      if (!disc.ok) {
        label.style.display = 'none'
        continue
      }
      const { sx, sy, screenR } = disc
      const half = visual.labelW * (id === selectedId ? 1.2 : 1.1) / 2 + 4
      this.placeBox(sx - half, sy - screenR - 25, sx + half, sy - screenR - 3, true)
      show(visual, sx, sy - screenR - 4, 1)
      label.setAttribute('data-emphasised', '')
      if (id === selectedId) label.setAttribute('data-selected', '')
      else label.removeAttribute('data-selected')
    }

    // 2. Captions, largest cluster first.
    for (const territory of this.captionRank) {
      const caption = territory.caption
      const hub = territory.hub
      const lod = hub ? hub.lod : 0
      if (!territory.mesh.visible && lod < 0.02) {
        caption.style.display = 'none'
        continue
      }
      this.labelVec.copy(territory.centre).project(cam)
      if (this.labelVec.z > 1 || this.labelVec.z < -1) {
        caption.style.display = 'none'
        continue
      }
      const sx = (this.labelVec.x * 0.5 + 0.5) * this.width
      const sy = (-this.labelVec.y * 0.5 + 0.5) * this.height
      if (sx < -60 || sx > this.width + 60 || sy < -40 || sy > this.height + 40) {
        caption.style.display = 'none'
        continue
      }
      const camDist = territory.centre.distanceTo(cam.position)
      // The caption rides the territory's rim, then the hub's as it folds.
      const worldR = hub
        ? territory.r + (hub.anchor.r * hub.anchor.scale.current * 1.3 - territory.r) * lod
        : territory.r
      const screenR = (worldR * (this.height / 2)) / (Math.max(1, camDist) * halfTan)
      const isHub = lod > 0.5
      if (
        !this.placeCaption(
          territory.captionFull,
          isHub ? territory.captionHubW : territory.captionW,
          sx,
          sy,
          screenR,
        ) &&
        !this.placeCaption(
          territory.captionShort,
          isHub ? territory.captionShortHubW : territory.captionShortW,
          sx,
          sy,
          screenR,
        )
      ) {
        caption.style.display = 'none'
        continue
      }
      if (caption.textContent !== this.capText) caption.textContent = this.capText
      caption.style.display = 'block'
      caption.style.transform = `translate(-50%, -100%) translate(${this.capX.toFixed(1)}px, ${
        this.capBaseline.toFixed(1)
      }px)`
      // A folded cluster's caption is its name: it dims with the hub, never
      // to the whisper an open territory's caption drops to under focus.
      const opacity = isHub
        ? 0.95 * (0.35 + 0.65 * (hub ? hub.opacity.current : 1))
        : focus
        ? 0.3
        : 0.9
      caption.style.opacity = opacity.toFixed(2)
      if (isHub) caption.setAttribute('data-hub', '')
      else caption.removeAttribute('data-hub')
    }

    // 3. The rest. The budget grows as the camera comes closer, like the 2D
    // zoom; it is continuous so the last name in fades rather than pops.
    const budget = Math.max(10, Math.min(48, 24 * (this.fitDist / Math.max(1, this.view.dist))))
    let kept = 0
    for (let rank = 0; rank < this.paintRank.length; rank++) {
      const visual = this.paintRank[rank]
      const disc = discs[rank]
      if (!visual || !disc) continue
      const id = visual.node.id
      if (isEmphasised(id)) continue
      const label = visual.label
      label.removeAttribute('data-emphasised')
      label.removeAttribute('data-selected')
      const hub = visual.territory?.hub
      const lod = hub ? hub.lod : 0
      const inNeighbourhood = this.neighbourIds?.has(id) ?? false
      if (
        lod > 0.35 || !disc.ok || disc.opacity < 0.2 ||
        (focus !== null && !inNeighbourhood) ||
        (!inNeighbourhood && kept >= budget)
      ) {
        label.style.display = 'none'
        continue
      }
      const { sx, sy, camDist, screenR } = disc
      // A name that would be cut by the plate edge, or sit under a panel, is
      // not drawn at all.
      const half = visual.labelW / 2 + 4
      if (
        sx - half < this.insets.left + PLATE_INSET ||
        sx + half > this.width - this.insets.right - PLATE_INSET ||
        sy - screenR - 23 < this.insets.top + PLATE_INSET ||
        sy - screenR - 3 > this.height - this.insets.bottom - PLATE_INSET
      ) {
        label.style.display = 'none'
        continue
      }
      // The label's anchor must not sit on the face of a nearer, clearly
      // visible sphere of readable size - see the discs note.
      const ax = sx
      const ay = sy - screenR - 13
      let covered = false
      for (let j = 0; j < discCount; j++) {
        if (j === rank) continue
        const p = discs[j]
        if (!p || !p.ok || p.opacity <= 0.2 || p.screenR <= 13 || p.camDist >= camDist - 1) continue
        // A hub disc covers generously: a name over a hub reads as the hub's.
        const reach = j >= nodeDiscs ? 1.15 : 0.92
        if (Math.hypot(ax - p.sx, ay - p.sy) < p.screenR * reach) {
          covered = true
          break
        }
      }
      if (covered) {
        label.style.display = 'none'
        continue
      }
      if (!this.placeBox(sx - half, sy - screenR - 23, sx + half, sy - screenR - 3)) {
        label.style.display = 'none'
        continue
      }
      let fadeIn = 1
      if (!inNeighbourhood) {
        fadeIn = Math.max(0, Math.min(1, budget - kept))
        kept += 1
      }
      // Distance fade matches the scene fog, so a label never floats at full
      // strength over a mark that has already melted into the paper.
      const fogT = Math.max(
        0,
        Math.min(1, (camDist - this.fog.near) / Math.max(1, this.fog.far - this.fog.near)),
      )
      const opacity = Math.max(0.35, (1 - fogT * 0.5) * Math.min(1, visual.opacity.current + 0.1)) *
        fadeIn * (1 - lod / 0.35)
      show(visual, sx, sy - screenR - 4, opacity)
    }
    this.positionPopup()
    this.projectEdgeLabels()
  }

  /** Relation labels ride emphasised edges only, like the 2D map's textPath. */
  private projectEdgeLabels() {
    for (const visual of this.edgeVisuals) this.projectEdgeLabel(visual)
    for (const visual of this.flowVisuals) this.projectEdgeLabel(visual)
  }

  private projectEdgeLabel(visual: EdgeVisual) {
    const wanted = visual.emphasised && Boolean(visual.edge.label) &&
      this.view.dist < this.fitDist * 1.15 && this.edgeFold(visual) > 0.5
    if (!wanted) {
      if (visual.label) visual.label.style.display = 'none'
      return
    }
    if (!visual.label) {
      const el = document.createElement('div')
      el.className = 'rp-map3d-edge-label'
      el.textContent = visual.edge.label
      this.labelLayer.appendChild(el)
      visual.label = el
      visual.labelW = visual.edge.label.length * 5.4
    }
    this.labelVec.copy(visual.from.pos).add(visual.to.pos).multiplyScalar(0.5).project(this.camera)
    if (this.labelVec.z > 1 || this.labelVec.z < -1) {
      visual.label.style.display = 'none'
      return
    }
    const sx = (this.labelVec.x * 0.5 + 0.5) * this.width
    const sy = (-this.labelVec.y * 0.5 + 0.5) * this.height
    // Relation labels give way to node labels: an italic riding an edge that
    // mushes into an entity name reads as neither.
    const halfW = visual.labelW * 0.5
    if (!this.placeBox(sx - halfW, sy - 21, sx + halfW, sy - 5)) {
      visual.label.style.display = 'none'
      return
    }
    visual.label.style.display = 'block'
    visual.label.style.transform = `translate(-50%, -140%) translate(${sx.toFixed(1)}px, ${
      sy.toFixed(1)
    }px)`
  }

  // -------------------------------------------------------------------
  // Teardown.
  // -------------------------------------------------------------------

  dispose() {
    this.disposed = true
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    this.unbindPointerHandlers()
    if (this.onContextLost) this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.reducedQuery?.removeEventListener('change', this.onReducedChange)
    this.paletteObserver.disconnect()
    this.resizeObserver.disconnect()
    this.clearScene()
    this.popup.remove()
    this.sphereGeo.dispose()
    this.shellGeo.dispose()
    this.tubeGeo.dispose()
    this.coneGeo.dispose()
    this.ringGeo.dispose()
    this.territoryGeo.dispose()
    this.haloGeo.dispose()
    this.selectionRingMaterial.dispose()
    this.traceRingMaterial.dispose()
    this.probe.remove()
    this.renderer.dispose()
  }
}
