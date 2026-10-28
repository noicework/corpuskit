import { MapCameraControls } from './MapCameraControls.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type GroupStyle,
  type Insets,
  KnowledgeMap,
  type MapEdge,
  type MapLayout,
  type MapMeasure,
  type MapNode,
} from './KnowledgeMap.tsx'
import { type EngineData, KnowledgeMapEngine, webglAvailable } from './map3d-engine.ts'

// ---------------------------------------------------------------------------
// The knowledge map in three dimensions.
//
// This is the React shell around map3d-engine.ts: it filters the graph to
// what the legend and switches leave visible, hands the engine its data,
// emphasis and panel insets, and carries selections back out. The page
// around it (GraphPage) is unchanged - same navigator, same detail dock,
// same path tracing - because this component keeps the 2D map's exact
// contract. Where WebGL is unavailable the 2D canvas steps back in, so the
// map never renders as a black rectangle.
// ---------------------------------------------------------------------------

type FrameScheduler = (callback: FrameRequestCallback) => number

/**
 * Wait until a prepared scene has crossed a paint boundary before revealing it.
 * The first frame lets the engine render; the second reveals the retained canvas.
 */
export function scheduleMapReadyAfterPaint(
  onReady: () => void,
  scheduleFrame: FrameScheduler = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): () => void {
  let secondFrame: number | null = null
  const firstFrame = scheduleFrame(() => {
    secondFrame = scheduleFrame(() => onReady())
  })

  return () => {
    cancelFrame(firstFrame)
    if (secondFrame !== null) cancelFrame(secondFrame)
  }
}

export function KnowledgeMap3D({
  nodes,
  edges,
  groupStyles,
  degrees,
  measure,
  layout,
  hiddenGroups,
  selectedId,
  pathEdges,
  pathFrom,
  onSelect,
  focusId,
  insets,
  hint,
  onReady,
  initiallyPlaying = true,
  onMotionChange,
  controlsTarget,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  groupStyles: Map<string, GroupStyle>
  degrees: Map<string, number>
  measure: MapMeasure
  layout: MapLayout
  hiddenGroups: Set<string>
  selectedId: string | null
  pathEdges: MapEdge[] | null
  pathFrom: string | null
  onSelect: (id: string | null) => void
  focusId: string | null
  /** Measured by the page from the floating panels - see GraphPage. */
  insets: Insets
  hint: string
  /** Called after the settled scene has rendered and crossed a paint boundary. */
  onReady?: () => void
  /** Retain the reader's pause choice when changing between the map and list. */
  initiallyPlaying?: boolean
  onMotionChange?: (playing: boolean) => void
  controlsTarget?: HTMLElement | null
}) {
  const { ui } = usePortalLocale()
  const [supported] = useState(webglAvailable)

  const visibleNodes = useMemo(
    () => nodes.filter((n) => !hiddenGroups.has(n.group)),
    [nodes, hiddenGroups],
  )
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds],
  )

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const labelsRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<KnowledgeMapEngine | null>(null)
  const [playing, setPlaying] = useState(false)
  const [reduced, setReduced] = useState(() =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const changed = () => setReduced(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  const onSelectRef = useRef(onSelect)
  const onReadyRef = useRef(onReady)
  const onMotionChangeRef = useRef(onMotionChange)
  const uiRef = useRef(ui)
  onSelectRef.current = onSelect
  onReadyRef.current = onReady
  onMotionChangeRef.current = onMotionChange
  uiRef.current = ui

  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      setSize((prev) =>
        prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const hasSize = size.w > 0 && size.h > 0

  // Coarse buckets follow the usable shape without rebuilding on every pixel.
  const aspect = size.w < 1 || size.h < 1 ? 1.5 : size.w / size.h
  const aspectBucket = aspect < 1
    ? Math.max(0.35, Math.round(aspect * 10) / 10)
    : aspect < 1.45
    ? 1.2
    : 1.9

  // A lost WebGL context leaves a frozen canvas; the 2D map takes over.
  const [contextLost, setContextLost] = useState(false)
  const usable = supported && !contextLost

  const [controlInset, setControlInset] = useState(64)
  useEffect(() => {
    const container = containerRef.current
    const controls = container?.querySelector('.rp-map-camera')
    if (!container || !controls) return
    const measure = () =>
      setControlInset(Math.ceil(
        controls.getBoundingClientRect().bottom - container.getBoundingClientRect().top + 12,
      ))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(controls)
    return () => observer.disconnect()
  }, [supported, contextLost])
  const mapInsets = useMemo(() => ({
    ...insets,
    top: controlsTarget ? insets.top : Math.max(insets.top, controlInset),
  }), [insets, controlInset, controlsTarget])

  // Mirrors the 2D map's fit signature: the view is re-framed when the
  // visible set or the layout changes shape, never merely because the
  // emphasis did.
  const fitSigRef = useRef('')

  // One engine for the component's life.
  useEffect(() => {
    if (!usable) return
    const canvas = canvasRef.current
    const labels = labelsRef.current
    if (!canvas || !labels) return
    // A fresh engine knows nothing, so the fit signature must forget too -
    // otherwise a remount (StrictMode, or recovery) skips the initial fit.
    fitSigRef.current = ''
    const engine = new KnowledgeMapEngine(
      canvas,
      labels,
      (id) => onSelectRef.current(id),
      () => setContextLost(true),
      uiRef.current,
      (playing) => {
        setPlaying(playing)
        onMotionChangeRef.current?.(playing)
      },
      initiallyPlaying,
    )
    engineRef.current = engine
    return () => {
      engineRef.current = null
      engine.dispose()
    }
  }, [usable])

  useEffect(() => {
    engineRef.current?.setUi(ui)
  }, [usable, ui])

  // Data - and the fit that frames it.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const data: EngineData = {
      nodes: visibleNodes,
      edges: visibleEdges,
      groupStyles,
      degrees,
      measure,
      layout,
      aspect: aspectBucket,
    }
    engine.setInsets(mapInsets)
    engine.setData(data)
    const sig = `${layout}|${aspectBucket}|${controlInset}|${
      visibleNodes.map((n) => n.id).join('|')
    }`
    if (sig !== fitSigRef.current) {
      fitSigRef.current = sig
      // Data changing under a selection is an expand: keep the reader at the
      // node they are on and reframe its (now larger) neighbourhood, rather
      // than yanking the camera out to the whole map.
      const held = selectedIdRef.current
      if (held && visibleNodes.some((n) => n.id === held)) {
        engine.focusOn(held, null, true)
      } else {
        engine.fit(false)
      }
    }

    // setData settles the force simulation synchronously. Keep the shell
    // hidden until that settled scene has made it through the renderer, so
    // the page never fades up an empty canvas or nodes still finding places.
    if (hasSize && visibleNodes.length > 0) {
      return scheduleMapReadyAfterPaint(() => onReadyRef.current?.())
    }
  }, [
    visibleNodes,
    visibleEdges,
    groupStyles,
    degrees,
    measure,
    layout,
    aspectBucket,
    controlInset,
    hasSize,
  ])

  // The SVG fallback owns its own synchronous force layout. Its child effects
  // commit the fitted scene before this two-frame reveal runs.
  useEffect(() => {
    if (usable || size.w < 1 || size.h < 1 || visibleNodes.length === 0) return
    return scheduleMapReadyAfterPaint(() => onReadyRef.current?.())
  }, [usable, size.w, size.h, visibleNodes, visibleEdges, layout])

  // Read by the data effect without re-running it on every selection.
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  useEffect(() => {
    engineRef.current?.setEmphasis({ selectedId, pathEdges, pathFrom })
  }, [selectedId, pathEdges, pathFrom])

  // An explicit request to bring a node into view - counted rather than read
  // directly, so asking twice for the same node moves the view twice.
  const [focusPulse, setFocusPulse] = useState(0)
  useEffect(() => {
    if (focusId) setFocusPulse((n) => n + 1)
  }, [focusId])

  const focusServicedRef = useRef<
    { id: string; pulse: number; box: Insets; dist: number | null } | null
  >(null)
  const lastInsetsRef = useRef<Insets | null>(null)

  // Bring the selection into the space the panels leave free, and hand the
  // space back when they go - the same protocol as the 2D map: the panels
  // are measured after they mount, so the first pass at a new selection can
  // run against a stale box and the second pass re-centres in the real one,
  // keeping the camera distance the first pass chose.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setInsets(mapInsets)
    const previous = lastInsetsRef.current
    lastInsetsRef.current = mapInsets
    const id = focusId ?? selectedId
    if (id) {
      const done = focusServicedRef.current
      const following = done !== null && done.id === id && done.pulse === focusPulse
      if (
        following && done.box.left === mapInsets.left && done.box.right === mapInsets.right &&
        done.box.top === mapInsets.top && done.box.bottom === mapInsets.bottom
      ) return
      const dist = engine.focusOn(id, following ? done.dist : null)
      focusServicedRef.current = { id, pulse: focusPulse, box: mapInsets, dist }
      return
    }
    focusServicedRef.current = null
    if (!previous || !engine.focusOwned) return
    const dx = ((mapInsets.left - previous.left) - (mapInsets.right - previous.right)) / 2
    const dy = ((mapInsets.top - previous.top) - (mapInsets.bottom - previous.bottom)) / 2
    engine.nudgeForInsets(dx, dy)
  }, [focusId, selectedId, focusPulse, mapInsets])

  if (!usable) {
    return (
      <div ref={containerRef} className='absolute inset-0'>
        <KnowledgeMap
          nodes={nodes}
          edges={edges}
          groupStyles={groupStyles}
          degrees={degrees}
          measure={measure}
          layout={layout}
          hiddenGroups={hiddenGroups}
          hideUnlinked={false}
          selectedId={selectedId}
          pathEdges={pathEdges}
          pathFrom={pathFrom}
          onSelect={onSelect}
          focusId={focusId}
          insets={mapInsets}
          hint={ui('Drag to pan · scroll to zoom · click a node to explore it')}
          controlsTarget={controlsTarget}
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className='rp-map3d absolute inset-0'>
      <canvas
        ref={canvasRef}
        role='application'
        aria-label={ui(
          'Knowledge map. Focus here to use arrows to rotate, Shift + arrows to pan, plus and minus to zoom, Home to fit and Enter to select. Tab leaves the map. Map controls provide buttons for each camera action. The list view provides all topics and relationships.',
        )}
        tabIndex={0}
        className='rp-focus block h-full w-full cursor-grab touch-none select-none'
      />
      {/* The vignette sits beneath the type, as it does on the 2D map. */}
      <div className='rp-map3d-vignette' aria-hidden='true' />
      <div ref={labelsRef} className='rp-map3d-labels' aria-hidden='true' />

      <p
        data-graph-overlay
        className='pointer-events-none absolute top-4 left-1/2 hidden -translate-x-1/2 text-xs text-ink-3 lg:block'
      >
        {hint}
      </p>

      <div>
        <MapCameraControls
          target={controlsTarget}
          zoom={(factor) => engineRef.current?.zoomBy(factor)}
          fit={() => engineRef.current?.fit(true)}
          pan={(x, y) => engineRef.current?.pan(x, y)}
          rotate={(x, y) => engineRef.current?.rotate(x, y)}
          motion={{ playing, reduced, toggle: () => engineRef.current?.setMotionPlaying(!playing) }}
        />
      </div>
    </div>
  )
}
