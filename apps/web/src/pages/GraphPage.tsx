import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import {
  getGraph,
  getLabelsets,
  getRelationsGraph,
  type RelationsGraph,
  searchTenantFull,
} from '../api/client.ts'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { EmptyState, ErrorCard } from '../components/ui.tsx'
import {
  buildDegrees,
  buildGroupStyles,
  type GroupStyle,
  type Insets,
  MapConstellation,
  type MapEdge,
  type MapLayout,
  type MapNode,
} from '../components/KnowledgeMap.tsx'
import { KnowledgeMap3D } from '../components/KnowledgeMap3D.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// The knowledge map: a live, explorable graph of how the corpus connects.
//
// Two lenses share one canvas engine - the entity graph (relations the
// knowledge-graph agent extracted) and the concept map (how taxonomy
// categories co-occur) - and two layouts share both. The canvas is full-bleed:
// it fills the viewport below the header, a floating navigator rail lets you
// browse by name, and selecting a node docks an evidence panel. A path mode
// answers "how are these two things connected?".
//
// The canvas itself, its visual grammar and its layouts live in
// components/KnowledgeMap.tsx; this file is the page around it.
// ---------------------------------------------------------------------------

type Mode = 'entity' | 'concept'

// ---------------------------------------------------------------------------
// Icons. There is no icon library here, so the map's glyphs are drawn inline
// in the house idiom - stroked, never filled, rounded caps, on a 20-unit grid.
// They stand in for the spelled-out control labels on a phone, where the words
// cost more height than the map can spare; every one of them still carries the
// label as an aria-label and a title.
// ---------------------------------------------------------------------------

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.8}
      strokeLinecap='round'
      strokeLinejoin='round'
      className='h-[17px] w-[17px]'
      aria-hidden='true'
    >
      {children}
    </svg>
  )
}

/** Entity lens: nodes joined by relations. */
function EntityGlyph() {
  return (
    <Glyph>
      <path d='M7.1 6.6 12.9 7.4' />
      <path d='M6 8.4 8.5 13.1' />
      <circle cx='5' cy='6.5' r='2.1' />
      <circle cx='15' cy='7.5' r='2.1' />
      <circle cx='9.5' cy='15' r='2.1' />
    </Glyph>
  )
}

/** Concept lens: two categories sharing resources - the overlap is the point. */
function ConceptGlyph() {
  return (
    <Glyph>
      <circle cx='7.6' cy='10' r='4.7' />
      <circle cx='12.4' cy='10' r='4.7' />
    </Glyph>
  )
}

/** Grouped layout: each category gathered into its own territory. */
function GroupedGlyph() {
  return (
    <Glyph>
      <rect x='3.4' y='3.4' width='5.6' height='5.6' rx='1.4' />
      <rect x='11' y='3.4' width='5.6' height='5.6' rx='1.4' />
      <rect x='3.4' y='11' width='5.6' height='5.6' rx='1.4' />
      <rect x='11' y='11' width='5.6' height='5.6' rx='1.4' />
    </Glyph>
  )
}

/** Free layout: one open field, nothing gathered. */
function FreeGlyph() {
  return (
    <Glyph>
      <circle cx='5.2' cy='6.4' r='1.45' />
      <circle cx='11.2' cy='4.6' r='1.45' />
      <circle cx='15.4' cy='9.6' r='1.45' />
      <circle cx='6.8' cy='13.4' r='1.45' />
      <circle cx='13.2' cy='15.2' r='1.45' />
    </Glyph>
  )
}

function SearchGlyph() {
  return (
    <Glyph>
      <circle cx='9' cy='9' r='5.5' />
      <path d='M13.5 13.5 17 17' />
    </Glyph>
  )
}

// ---------------------------------------------------------------------------
// How much of the canvas the floating panels are actually covering.
//
// The map needs this to know where the space it can still use is - to frame
// the graph in it, and to move a selected node into it. It has to be MEASURED:
// the detail sheet's height follows its content, which runs from an entity
// with two connections to one with a long "mentioned in" list, and the same
// panel is a bottom sheet on a phone and a side rail on a desktop.
//
// Which edge a panel eats is read from its own geometry rather than from a
// breakpoint: a panel spanning nearly the whole stage is a sheet and takes
// height off the bottom, anything narrower is a rail and takes width off the
// side it sits on. Measuring down to the stage's bottom edge rather than
// taking the panel's height also means a sheet held clear of an iOS home
// indicator by a safe-area inset counts that strip as unusable too, which it
// is.
// ---------------------------------------------------------------------------

const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 }

function usePanelInsets(
  stage: HTMLElement | null,
  rail: HTMLElement | null,
  dock: HTMLElement | null,
): Insets {
  const [insets, setInsets] = useState<Insets>(NO_INSETS)
  useEffect(() => {
    if (!stage) {
      setInsets((prev) => (prev === NO_INSETS ? prev : NO_INSETS))
      return
    }
    const measure = () => {
      const box = stage.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) return
      const next = { left: 0, right: 0, top: 0, bottom: 0 }
      for (const panel of [rail, dock]) {
        if (!panel) continue
        const rect = panel.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) continue
        if (rect.width >= box.width * 0.8) {
          // A full-width panel takes the edge it is nearer to, so a sheet
          // docked at the top does not read as covering the bottom.
          if (rect.top + rect.height / 2 < box.top + box.height / 2) {
            next.top = Math.max(next.top, Math.round(rect.bottom - box.top))
          } else {
            next.bottom = Math.max(next.bottom, Math.round(box.bottom - rect.top))
          }
        } else if (rect.left + rect.width / 2 < box.left + box.width / 2) {
          next.left = Math.max(next.left, Math.round(rect.right - box.left))
        } else {
          next.right = Math.max(next.right, Math.round(box.right - rect.left))
        }
      }
      setInsets((prev) =>
        prev.left === next.left && prev.right === next.right && prev.top === next.top &&
          prev.bottom === next.bottom
          ? prev
          : next
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    if (rail) observer.observe(rail)
    if (dock) observer.observe(dock)
    return () => observer.disconnect()
  }, [stage, rail, dock])
  return insets
}

// ---------------------------------------------------------------------------
// Path finding - breadth-first over the loaded edges (undirected), so "how
// are these two connected?" answers instantly from what is on screen.
// ---------------------------------------------------------------------------

function shortestPath(edges: MapEdge[], from: string, to: string): MapEdge[] | null {
  if (from === to) return []
  const adjacency = new Map<string, MapEdge[]>()
  for (const edge of edges) {
    for (const end of [edge.source, edge.target]) {
      const list = adjacency.get(end)
      if (list) list.push(edge)
      else adjacency.set(end, [edge])
    }
  }
  const cameFrom = new Map<string, MapEdge>()
  const queue = [from]
  const seen = new Set([from])
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of adjacency.get(current) ?? []) {
      const next = edge.source === current ? edge.target : edge.source
      if (seen.has(next)) continue
      seen.add(next)
      cameFrom.set(next, edge)
      if (next === to) {
        const path: MapEdge[] = []
        let cursor = to
        while (cursor !== from) {
          const step = cameFrom.get(cursor) as MapEdge
          path.unshift(step)
          cursor = step.source === cursor ? step.target : step.source
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Node search - type to find an entity, click to focus it.
// ---------------------------------------------------------------------------

function NodeSearch({
  nodes,
  groupStyles,
  onPick,
  autoFocus = false,
  onDismiss,
  className = 'h-[calc(2.75rem*var(--rp-density-ctl,1))]',
}: {
  nodes: MapNode[]
  groupStyles: Map<string, GroupStyle>
  onPick: (id: string) => void
  /** The phone strip opens the field on demand, so it takes the caret with it. */
  autoFocus?: boolean
  onDismiss?: () => void
  className?: string
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 8)
  }, [query, nodes])

  return (
    <div className='relative w-full sm:w-80'>
      <span
        aria-hidden='true'
        className='pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3'
      >
        <svg
          viewBox='0 0 20 20'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.7'
          className='h-4 w-4'
        >
          <circle cx='9' cy='9' r='5.5' />
          <path d='M13.5 13.5 17 17' strokeLinecap='round' />
        </svg>
      </span>
      <input
        ref={inputRef}
        type='text'
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && onDismiss) {
            event.stopPropagation()
            onDismiss()
          }
        }}
        placeholder='Find in the map…'
        aria-label='Find an entity in the map'
        className={`rp-input rp-input-icon w-full text-sm ${className}`}
      />
      {matches.length > 0
        ? (
          <ul className='absolute z-40 mt-1 w-full overflow-hidden rounded-[calc(var(--rp-radius)+2px)] border border-line bg-surface rp-shadow-lg'>
            {matches.map((node) => (
              <li key={node.id}>
                <button
                  type='button'
                  onClick={() => {
                    onPick(node.id)
                    setQuery('')
                  }}
                  className='flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                >
                  <span
                    className='mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full'
                    style={{ background: groupStyles.get(node.group)?.colour ?? 'var(--rp-cat-1)' }}
                    aria-hidden='true'
                  />
                  {
                    /* Entity names here run long and share prefixes - a single
                    * truncated line rendered "TASMANIAN SALMONID INDUSTRY EMS
                    * FRAMEWORK TEMPLATE" and "TASMANIAN SALMONID EMS FRAMEWORK
                    * TEMPLATE" as the same row. Two lines separate them, and
                    * the title carries the full name for anything longer. */
                  }
                  <span className='rp-clamp-2 min-w-0 flex-1 leading-snug' title={node.label}>
                    {node.label}
                  </span>
                  <span className='shrink-0 self-start pt-0.5 text-xs text-ink-3'>
                    {node.group}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Evidence - the resources that actually mention the selected entity.
// ---------------------------------------------------------------------------

function EvidenceList({ slug, name }: { slug: string; name: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['graph-evidence', slug, name],
    queryFn: () => searchTenantFull(slug, name, { mode: 'hybrid' }),
    staleTime: 5 * 60 * 1000,
  })
  if (isLoading) {
    return (
      <div className='space-y-2'>
        <div
          className='rp-shimmer bg-surface-3 h-10 rounded-[var(--rp-radius)]'
          aria-hidden='true'
        />
        <div
          className='rp-shimmer bg-surface-3 h-10 rounded-[var(--rp-radius)]'
          aria-hidden='true'
        />
      </div>
    )
  }
  const resources = (data?.resources ?? []).slice(0, 3)
  if (resources.length === 0) {
    return <p className='text-xs text-ink-3'>No indexed passages mention this yet.</p>
  }
  return (
    <ul className='space-y-2'>
      {resources.map((resource) => (
        <li key={resource.id}>
          <Link
            to={`/t/${slug}/library/${resource.id}`}
            className='rp-focus flex gap-2.5 rounded-[var(--rp-radius)] border border-line bg-surface p-2.5 transition-colors hover:bg-[var(--rp-surface-2)]'
          >
            <div
              className='relative aspect-[210/297] w-[4.5rem] shrink-0 self-start overflow-hidden border border-line'
              aria-hidden='true'
            >
              <ResourceThumb
                slug={slug}
                id={resource.id}
                type={resource.type}
                imgClassName='object-top'
              />
            </div>
            <div className='min-w-0 flex-1'>
              <p className='rp-clamp-2 text-xs font-medium text-ink'>{resource.title}</p>
              {resource.matchedPassage
                ? <p className='rp-clamp-2 mt-1 text-xs text-ink-3'>{resource.matchedPassage}</p>
                : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Detail dock - slides in from the right (docks to a bottom sheet on mobile)
// when a node is selected. Holds the entity or concept evidence.
// ---------------------------------------------------------------------------

function DetailDock({
  onClose,
  panelRef,
  children,
}: {
  onClose: () => void
  panelRef: (el: HTMLElement | null) => void
  children: React.ReactNode
}) {
  return (
    <aside
      ref={panelRef}
      aria-label='Selection details'
      // Focusable so a selection made from the rail or the find field can
      // hand the reading position to the details it opened; -1 keeps it out
      // of the tab order itself.
      tabIndex={-1}
      className='rp-anim-fade absolute inset-x-0 bottom-0 z-30 flex max-h-[68%] flex-col overflow-hidden rounded-t-[var(--rp-radius)] border border-line rp-map-panel outline-none rp-map-gutter-right md:inset-x-auto md:top-3 md:bottom-3 md:max-h-none md:w-[360px] md:rounded-[calc(var(--rp-radius)+4px)]'
    >
      <button
        type='button'
        onClick={onClose}
        aria-label='Close details'
        className='rp-btn rp-btn-ghost absolute right-2 top-2 z-10 h-8 w-8 !px-0'
      >
        <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
          <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
        </svg>
      </button>
      <div className='rp-scroll flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-5'>
        {children}
      </div>
    </aside>
  )
}

function EntityPanel({
  slug,
  node,
  edges,
  degree,
  groupStyle,
  pathState,
  onSelect,
  onExpand,
  onArmPath,
  onClearPath,
  expanding,
}: {
  slug: string
  node: MapNode
  edges: MapEdge[]
  degree: number
  groupStyle: GroupStyle | undefined
  pathState: { from: string | null; path: MapEdge[] | null; noPath: boolean }
  onSelect: (id: string) => void
  onExpand: () => void
  onArmPath: () => void
  onClearPath: () => void
  expanding: boolean
}) {
  const connections = useMemo(() => {
    const grouped = new Map<string, { other: string; outgoing: boolean }[]>()
    for (const edge of edges) {
      if (edge.source !== node.id && edge.target !== node.id) continue
      const outgoing = edge.source === node.id
      const other = outgoing ? edge.target : edge.source
      const label = edge.label || 'related to'
      const list = grouped.get(label)
      if (list) list.push({ other, outgoing })
      else grouped.set(label, [{ other, outgoing }])
    }
    return [...grouped.entries()]
  }, [edges, node.id])

  return (
    <>
      <div className='pr-8'>
        <p className='rp-eyebrow text-ink-3'>Entity</p>
        <div className='mt-1 flex items-start gap-2'>
          <span
            className='mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full'
            style={{
              background: groupStyle?.hollow ? 'var(--rp-surface)' : groupStyle?.colour,
              boxShadow: groupStyle?.hollow ? `inset 0 0 0 2px ${groupStyle.colour}` : undefined,
            }}
            aria-hidden='true'
          />
          <h2 className='font-display text-lg leading-tight text-ink'>{node.label}</h2>
        </div>
        <p className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
          <span
            className='font-semibold uppercase tracking-wide'
            style={{ color: groupStyle?.ink ?? 'var(--rp-ink-2)' }}
          >
            {node.group || 'Entity'}
          </span>
          <span className='text-ink-3' aria-hidden='true'>·</span>
          <span className='text-ink-2'>
            {degree} {degree === 1 ? 'relation' : 'relations'}
          </span>
          <span className='text-ink-3' aria-hidden='true'>·</span>
          <span className='text-ink-2'>
            {node.weight} {node.weight === 1 ? 'mention' : 'mentions'}
          </span>
        </p>
      </div>

      <div className='flex flex-wrap gap-1.5'>
        <button
          type='button'
          onClick={onExpand}
          disabled={expanding}
          className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
        >
          {expanding ? 'Expanding…' : 'Expand connections'}
        </button>
        <button
          type='button'
          onClick={pathState.from === node.id ? onClearPath : onArmPath}
          className={`rp-btn h-8 px-2.5 text-xs ${
            pathState.from === node.id ? 'rp-btn-primary' : 'rp-btn-outline'
          }`}
        >
          {pathState.from === node.id ? 'Cancel trace' : 'Trace a connection'}
        </button>
      </div>

      {pathState.from === node.id && !pathState.path
        ? (
          <p className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-2.5 text-xs text-ink-2'>
            Now select any other entity to trace how the two are connected.
          </p>
        )
        : null}
      {pathState.noPath
        ? (
          <p
            className='rounded-[var(--rp-radius)] border p-2.5 text-xs'
            style={{
              borderColor: 'var(--rp-warn-line)',
              background: 'var(--rp-warn-bg)',
              color: 'var(--rp-warn-ink)',
            }}
          >
            No connection found between these two in the current map.
          </p>
        )
        : null}
      {pathState.path && pathState.path.length > 0
        ? (
          <div className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-2.5'>
            <p className='text-xs font-medium uppercase tracking-wide text-ink-3'>Connection</p>
            <ol className='mt-1.5 space-y-1'>
              {pathState.path.map((step, i) => (
                <li key={i} className='text-xs text-ink'>
                  <span className='font-medium'>{step.source}</span>{' '}
                  <span className='text-ink-3'>{step.label || 'related to'} →</span>{' '}
                  <span className='font-medium'>{step.target}</span>
                </li>
              ))}
            </ol>
            <button
              type='button'
              onClick={onClearPath}
              className='rp-btn rp-btn-ghost mt-2 h-7 px-2 text-xs'
            >
              Clear
            </button>
          </div>
        )
        : null}

      {connections.length > 0
        ? (
          <div>
            <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>Connections</h3>
            <div className='mt-2 space-y-2.5'>
              {connections.map(([label, list]) => (
                <div key={label}>
                  <p className='text-xs italic text-ink-2'>{label}</p>
                  <div className='mt-1 flex flex-wrap gap-1.5'>
                    {list.map(({ other, outgoing }) => (
                      // !py: rp-chip's own padding is unlayered and would win
                      // over a plain utility. A long entity name wraps, and
                      // without the left alignment the wrapped lines centred
                      // against the arrow and read as stray padding.
                      <button
                        key={`${outgoing ? 'out' : 'in'}-${other}`}
                        type='button'
                        onClick={() => onSelect(other)}
                        className='rp-chip gap-1 !py-1 text-left text-xs'
                        title={outgoing
                          ? `${node.label} ${label} ${other}`
                          : `${other} ${label} ${node.label}`}
                      >
                        <span className='shrink-0 text-ink-3' aria-hidden='true'>
                          {outgoing ? '→' : '←'}
                        </span>
                        <span className='min-w-0'>{other}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
        : (
          <p className='text-xs text-ink-3'>
            No extracted relations for this entity yet - it appears in the corpus, but the
            knowledge-graph agent has not linked it to anything.
          </p>
        )}

      <div>
        <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>Mentioned in</h3>
        <div className='mt-2'>
          <EvidenceList slug={slug} name={node.label} />
        </div>
      </div>

      <div className='mt-auto flex flex-wrap gap-1.5 border-t border-line pt-3'>
        <Link
          to={`/t/${slug}/entity/${encodeURIComponent(node.label)}`}
          className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
        >
          Open dossier
        </Link>
        <Link
          to={`/t/${slug}/ask?ask=${
            encodeURIComponent(`What does the research say about ${node.label}?`)
          }`}
          className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
        >
          Ask about this
        </Link>
      </div>
    </>
  )
}

function ConceptPanel({
  slug,
  node,
  edges,
  labelById,
  groupStyle,
  onSelect,
}: {
  slug: string
  node: MapNode
  edges: MapEdge[]
  labelById: Map<string, string>
  groupStyle: GroupStyle | undefined
  onSelect: (id: string) => void
}) {
  const related = edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => ({
      otherId: e.source === node.id ? e.target : e.source,
      count: e.weight,
    }))
    .sort((a, b) => b.count - a.count)
  const isTopic = node.id.startsWith('topic:')
  const slugPart = node.id.split(':')[1] ?? ''
  const busiest = related[0]?.count ?? 1

  /** Library link filtered to this node - and to a pair when other is given. */
  const libraryHref = (otherId?: string) => {
    const params = new URLSearchParams()
    params.set(isTopic ? 'topic' : 'kind', slugPart)
    if (otherId) {
      const otherIsTopic = otherId.startsWith('topic:')
      params.set(otherIsTopic ? 'topic' : 'kind', otherId.split(':')[1] ?? '')
    }
    return `/t/${slug}/library?${params.toString()}`
  }

  return (
    <>
      <div className='pr-8'>
        <p className='rp-eyebrow text-ink-3'>{isTopic ? 'Topic' : 'Kind'}</p>
        <h2 className='mt-1 font-display text-lg text-ink'>{node.label}</h2>
        <p
          className='mt-1 text-xs font-semibold uppercase tracking-wide'
          style={{ color: groupStyle?.ink ?? 'var(--rp-ink-2)' }}
        >
          on {node.weight} {node.weight === 1 ? 'resource' : 'resources'}
        </p>
      </div>
      {related.length > 0
        ? (
          <div>
            <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>
              Appears together with
            </h3>
            <ul className='mt-2 space-y-1'>
              {related.map(({ otherId, count }) => (
                <li key={otherId}>
                  <div className='flex items-center justify-between gap-1.5'>
                    <button
                      type='button'
                      onClick={() => onSelect(otherId)}
                      className='min-w-0 truncate rounded-[var(--rp-radius)] px-1.5 py-1 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                    >
                      {labelById.get(otherId) ?? otherId}
                    </button>
                    <Link
                      to={libraryHref(otherId)}
                      className='shrink-0 text-xs text-ink-3 underline-offset-2 hover:text-[var(--rp-ink)] hover:underline'
                      title='View the resources where both appear'
                    >
                      {count} {count === 1 ? 'resource' : 'resources'}
                    </Link>
                  </div>
                  {/* The same overlap the map draws as line weight, read as a bar. */}
                  <div className='mx-1.5 h-1 bg-surface-3' aria-hidden='true'>
                    <div
                      className='h-full'
                      style={{
                        width: `${Math.max(3, (count / busiest) * 100)}%`,
                        background: groupStyle?.colour ?? 'var(--rp-accent)',
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
        : <p className='text-xs text-ink-3'>No overlaps recorded yet.</p>}
      <div className='mt-auto border-t border-line pt-3'>
        <Link
          to={libraryHref()}
          className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
        >
          View these {node.weight} {node.weight === 1 ? 'resource' : 'resources'}
        </Link>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Navigator rail - the way in. The legend and a ranked list of entities,
// nothing else: the map explains itself through interaction, and the rest of
// the story lives in Help. Floats top-left on desktop, docks as a bottom
// sheet on mobile.
// ---------------------------------------------------------------------------

function NavigatorRail({
  nodes,
  degrees,
  groupStyles,
  hiddenGroups,
  onToggleGroup,
  onSelect,
  onClose,
  mode,
  selectedId,
  panelRef,
}: {
  nodes: MapNode[]
  degrees: Map<string, number>
  groupStyles: Map<string, GroupStyle>
  hiddenGroups: Set<string>
  onToggleGroup: (group: string) => void
  onSelect: (id: string) => void
  onClose: () => void
  mode: Mode
  selectedId: string | null
  panelRef: (el: HTMLElement | null) => void
}) {
  const isEntity = mode === 'entity'
  // The 3D canvas does not expose its marks to the keyboard or a screen
  // reader the way the 2D SVG's tabbable nodes did, so this list is the
  // accessible route to EVERY entity - the shortlist opens out to the full
  // ranked set on demand.
  const [showAll, setShowAll] = useState(false)
  const ranked = useMemo(() => {
    const rank = (node: MapNode) =>
      isEntity ? (degrees.get(node.id) ?? 0) * 1000 + node.weight : node.weight
    return [...nodes].sort((a, b) => rank(b) - rank(a))
  }, [nodes, degrees, isEntity])
  const top = showAll ? ranked : ranked.slice(0, 10)

  return (
    <aside
      ref={panelRef}
      aria-label='Map navigator'
      className='rp-anim-fade absolute inset-x-0 bottom-0 z-20 flex max-h-[60%] flex-col overflow-hidden rounded-t-[var(--rp-radius)] border border-line rp-map-panel rp-map-gutter-left md:inset-x-auto md:bottom-auto md:top-1/2 md:max-h-[calc(100%-2rem)] md:w-[300px] md:-translate-y-1/2 md:rounded-[calc(var(--rp-radius)+4px)]'
    >
      <button
        type='button'
        onClick={onClose}
        aria-label='Hide navigator'
        className='rp-btn rp-btn-ghost absolute right-2 top-2 z-10 h-8 w-8 shrink-0 !px-0'
      >
        <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
          <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
        </svg>
      </button>

      <div className='rp-scroll flex-1 overflow-y-auto px-4 py-4'>
        {groupStyles.size > 1
          ? (
            <div className='mb-4'>
              <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>
                Legend
                <span className='ml-1.5 font-normal normal-case tracking-normal text-ink-3'>
                  (tap to show or hide)
                </span>
              </h3>
              <div className='mt-2 flex flex-wrap gap-1.5'>
                {[...groupStyles.entries()].map(([group, style]) => (
                  <button
                    key={group}
                    type='button'
                    aria-pressed={!hiddenGroups.has(group)}
                    onClick={() => onToggleGroup(group)}
                    className={`rp-chip gap-1.5 text-xs ${
                      hiddenGroups.has(group) ? 'opacity-40' : ''
                    }`}
                  >
                    <span
                      className='inline-block h-2.5 w-2.5 rounded-full'
                      style={{
                        background: style.hollow ? 'var(--rp-surface)' : style.colour,
                        boxShadow: style.hollow ? `inset 0 0 0 2px ${style.colour}` : undefined,
                      }}
                      aria-hidden='true'
                    />
                    {group || 'Entity'}
                    <span className='text-ink-3'>{style.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )
          : null}

        <div>
          <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>
            {showAll
              ? (isEntity ? 'All entities, most connected first' : 'All categories')
              : (isEntity ? 'Most connected' : 'Largest categories')}
          </h3>
          <ul className='mt-2 space-y-0.5'>
            {top.map((node) => {
              const active = node.id === selectedId
              const style = groupStyles.get(node.group)
              const measure = isEntity ? (degrees.get(node.id) ?? 0) : node.weight
              return (
                <li key={node.id}>
                  <button
                    type='button'
                    onClick={() => onSelect(node.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-center gap-2 rounded-[var(--rp-radius)] px-2 py-1.5 text-left text-sm transition-colors ${
                      active
                        ? 'bg-[var(--rp-surface-2)] text-ink'
                        : 'text-ink hover:bg-[var(--rp-surface-2)]'
                    }`}
                  >
                    <span
                      className='inline-block h-2.5 w-2.5 shrink-0 rounded-full'
                      style={{
                        background: style?.hollow ? 'var(--rp-surface)' : style?.colour,
                        boxShadow: style?.hollow ? `inset 0 0 0 2px ${style.colour}` : undefined,
                      }}
                      aria-hidden='true'
                    />
                    <span className='min-w-0 flex-1 truncate'>{node.label}</span>
                    <span className='shrink-0 tabular-nums text-xs text-ink-3'>{measure}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {ranked.length > 10
            ? (
              <button
                type='button'
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
                className='rp-btn rp-btn-ghost mt-1.5 h-8 px-2 text-xs'
              >
                {showAll
                  ? 'Show fewer'
                  : `Show all ${ranked.length} ${isEntity ? 'entities' : 'categories'}`}
              </button>
            )
            : null}
        </div>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type SegmentOption<T extends string> = {
  value: T
  label: string
  title: string
  icon: React.ReactNode
}

/**
 * The phone form of a segmented control: the spelled-out option names and the
 * VIEW / LAYOUT caption are what make the desktop control 300px wide, so on a
 * narrow screen each option becomes its glyph and the caption moves onto the
 * group's aria-label. The chosen option is filled solid rather than washed -
 * with no words to read, the selected state has to be unmistakable at a
 * glance, and white-on-primary holds its contrast over the banner scrim.
 */
function IconSegmented<T extends string>({
  groupLabel,
  value,
  options,
  onChange,
}: {
  groupLabel: string
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
}) {
  return (
    <div
      role='group'
      aria-label={groupLabel}
      className='inline-flex h-9 shrink-0 items-center overflow-hidden rounded-[var(--rp-radius-btn)] border border-[var(--rp-on-primary)]/45'
    >
      {options.map((option, index) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type='button'
            aria-pressed={active}
            aria-label={option.label}
            title={`${option.label} - ${option.title}`}
            onClick={() => onChange(option.value)}
            className={`rp-focus flex h-full w-9 items-center justify-center transition-colors duration-150 ${
              index > 0 ? 'border-l border-[var(--rp-on-primary)]/35' : ''
            } ${
              active
                ? 'bg-[var(--rp-on-primary)] text-[var(--rp-primary)]'
                : 'text-[var(--rp-on-primary)]/80 hover:bg-[var(--rp-on-primary)]/15'
            }`}
          >
            {option.icon}
          </button>
        )
      })}
    </div>
  )
}

function ModeToggle({
  mode,
  onChange,
  compact = false,
}: {
  mode: Mode
  onChange: (mode: Mode) => void
  compact?: boolean
}) {
  const options: SegmentOption<Mode>[] = [
    {
      value: 'entity',
      label: 'Entity graph',
      title: 'The entities and the relations between them',
      icon: <EntityGlyph />,
    },
    {
      value: 'concept',
      label: 'Concept map',
      title: 'The topics and kinds that share resources',
      icon: <ConceptGlyph />,
    },
  ]
  if (compact) {
    return (
      <IconSegmented groupLabel='Graph mode' value={mode} options={options} onChange={onChange} />
    )
  }
  return (
    <div
      role='group'
      aria-label='Graph mode'
      className='inline-flex h-[calc(2.75rem*var(--rp-density-ctl,1))] shrink-0 items-center overflow-hidden rounded-[var(--rp-radius-btn)] border border-[var(--rp-on-primary)]/30'
    >
      <span className='px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--rp-on-primary)]/60'>
        View
      </span>
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={mode === option.value}
          onClick={() => onChange(option.value)}
          className={`rp-focus h-full border-l border-[var(--rp-on-primary)]/20 px-3.5 text-sm font-medium transition-colors duration-150 ${
            mode === option.value
              ? 'bg-[var(--rp-on-primary)]/20 text-[var(--rp-on-primary)]'
              : 'text-[var(--rp-on-primary)]/65 hover:bg-[var(--rp-on-primary)]/10 hover:text-[var(--rp-on-primary)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Secondary control, styled against the hero rather than as a second white
 * segmented control, so it never competes with the lens toggle beside it.
 */
function LayoutToggle({
  layout,
  onChange,
  compact = false,
}: {
  layout: MapLayout
  onChange: (layout: MapLayout) => void
  compact?: boolean
}) {
  const options: SegmentOption<MapLayout>[] = [
    {
      value: 'grouped',
      label: 'Grouped',
      title: 'Gather each category into its own territory',
      icon: <GroupedGlyph />,
    },
    {
      value: 'free',
      label: 'Free',
      title: 'One open force layout, no category grouping',
      icon: <FreeGlyph />,
    },
  ]
  if (compact) {
    return (
      <IconSegmented groupLabel='Map layout' value={layout} options={options} onChange={onChange} />
    )
  }
  return (
    <div
      role='group'
      aria-label='Map layout'
      className='inline-flex h-[calc(2.75rem*var(--rp-density-ctl,1))] shrink-0 items-center overflow-hidden rounded-[var(--rp-radius-btn)] border border-[var(--rp-on-primary)]/30'
    >
      <span className='px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--rp-on-primary)]/60'>
        Layout
      </span>
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={layout === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`rp-focus h-full border-l border-[var(--rp-on-primary)]/20 px-3.5 text-sm font-medium transition-colors duration-150 ${
            layout === option.value
              ? 'bg-[var(--rp-on-primary)]/20 text-[var(--rp-on-primary)]'
              : 'text-[var(--rp-on-primary)]/65 hover:bg-[var(--rp-on-primary)]/10 hover:text-[var(--rp-on-primary)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The banner (or the flat primary) behind the page chrome, plus the scrim that
 * guarantees the type a ground. Shared by the wide hero and the phone strip.
 */
function HeroGround({ bannerImageUrl }: { bannerImageUrl?: string }) {
  return (
    <>
      {bannerImageUrl
        ? (
          <img
            src={bannerImageUrl}
            alt=''
            aria-hidden='true'
            className='absolute inset-0 h-full w-full object-cover'
          />
        )
        : null}
      {/* Scrim - the banner is bright, so the type needs a guaranteed ground. */}
      <div
        className='absolute inset-0'
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--rp-primary) 78%, transparent), color-mix(in srgb, var(--rp-primary) 92%, transparent))',
        }}
        aria-hidden='true'
      />
    </>
  )
}

/** Empty, error and everything-filtered-out share one frame on the map's own ground. */
function CanvasNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className='absolute inset-0 flex items-center justify-center bg-surface p-6'>
      <MapConstellation still />
      <div className='rp-anim-fade relative w-full max-w-md'>{children}</div>
    </div>
  )
}

export function GraphPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const [mode, setMode] = useState<Mode>('entity')
  const [layout, setLayout] = useState<MapLayout>('grouped')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  const [pathFrom, setPathFrom] = useState<string | null>(null)
  const [path, setPath] = useState<MapEdge[] | null>(null)
  const [noPath, setNoPath] = useState(false)
  const [extraGraph, setExtraGraph] = useState<RelationsGraph | null>(null)
  const [expanding, setExpanding] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  // Phone only: the find field lives behind the strip's magnifier.
  const [searchOpen, setSearchOpen] = useState(false)
  const [railOpen, setRailOpen] = useState<boolean>(() =>
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(min-width: 768px)').matches
      : true
  )
  // Held as state rather than in refs so that a panel mounting or unmounting
  // re-runs the measurement - a ref changing would not.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null)
  const [railEl, setRailEl] = useState<HTMLElement | null>(null)
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null)
  const insets = usePanelInsets(stageEl, railEl, dockEl)

  const relationsQuery = useQuery({
    queryKey: ['relations-graph', slug],
    queryFn: () => getRelationsGraph(slug, undefined, false),
    staleTime: 5 * 60 * 1000,
    enabled: mode === 'entity',
  })

  const conceptQuery = useQuery({
    queryKey: ['concept-graph', slug],
    queryFn: () => getGraph(slug, 'topic', 'kind'),
    staleTime: 5 * 60 * 1000,
    enabled: mode === 'concept',
  })

  const labelsetsQuery = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
    staleTime: 5 * 60 * 1000,
  })
  // Touch so the query stays mounted for other graph surfaces.
  void labelsetsQuery.data

  // Merge the base relations graph with any expanded neighbourhoods.
  const entityGraph = useMemo(() => {
    const base = relationsQuery.data
    if (!base) return null
    if (!extraGraph) return base
    // Case-insensitive merge: the server dedupes each response on its own,
    // but base and expansion can canonicalise the same entity to different
    // spellings, and a plain id merge would put "Tasmanian Salmonid
    // Industry" back beside "Tasmanian salmonid industry".
    const canonical = new Map(base.nodes.map((n) => [n.id.trim().toLowerCase(), n.id]))
    const nodes = [...base.nodes]
    for (const node of extraGraph.nodes) {
      const key = node.id.trim().toLowerCase()
      if (!canonical.has(key)) {
        canonical.set(key, node.id)
        nodes.push(node)
      }
    }
    const mapId = (id: string) => canonical.get(id.trim().toLowerCase()) ?? id
    const edgeKeys = new Set(base.edges.map((e) => `${e.source}|${e.label}|${e.target}`))
    const edges = [...base.edges]
    for (const edge of extraGraph.edges) {
      const source = mapId(edge.source)
      const target = mapId(edge.target)
      if (source === target) continue
      const key = `${source}|${edge.label}|${target}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({ ...edge, source, target })
      }
    }
    return { nodes, edges }
  }, [relationsQuery.data, extraGraph])

  const { nodes, edges } = useMemo((): { nodes: MapNode[]; edges: MapEdge[] } => {
    if (mode === 'entity') {
      if (!entityGraph) return { nodes: [], edges: [] }
      return {
        nodes: entityGraph.nodes.map((n) => ({
          id: n.id,
          label: n.id,
          group: n.group || 'Entity',
          weight: n.weight,
        })),
        edges: entityGraph.edges.map((e) => ({ ...e, weight: 1 })),
      }
    }
    const data = conceptQuery.data
    if (!data) return { nodes: [], edges: [] }
    return {
      nodes: data.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        group: n.group === 'primary' ? 'Topic' : 'Kind',
        weight: n.weight,
      })),
      // The raw overlap count is kept: the canvas log-scales it into line
      // weight, so "2 750 resources in common" reads differently from "8".
      edges: data.edges.map((e) => ({
        ...e,
        label: `together on ${e.weight} ${e.weight === 1 ? 'resource' : 'resources'}`,
      })),
    }
  }, [mode, entityGraph, conceptQuery.data])

  const groupStyles = useMemo(() => buildGroupStyles(nodes), [nodes])
  const degrees = useMemo(() => buildDegrees(edges), [edges])
  const labelById = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes])
  const selected = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null
  const visibleCount = useMemo(
    () => nodes.filter((n) => !hiddenGroups.has(n.group)).length,
    [nodes, hiddenGroups],
  )

  const select = useCallback((id: string | null) => {
    if (id === null) {
      setSelectedId(null)
      return
    }
    setSelectedId(id)
    setNoPath(false)
    setPathFrom((from) => {
      if (from && from !== id) {
        const found = shortestPath(edges, from, id)
        setPath(found)
        setNoPath(found === null)
        return found === null ? from : null
      }
      return from
    })
  }, [edges])

  // A selection made by name - the rail, the find field, a connection chip -
  // moves the reading position into the dock it opens, so the keyboard and
  // screen-reader path lands on the details rather than appearing to do
  // nothing. A click on the canvas itself deliberately does not.
  const dockFocusPendingRef = useRef(false)

  const focusAndSelect = (id: string) => {
    dockFocusPendingRef.current = true
    select(id)
    setFocusId(id)
    // Re-trigger centring even for the same node.
    setTimeout(() => setFocusId(null), 50)
  }

  useEffect(() => {
    if (!selectedId || !dockEl || !dockFocusPendingRef.current) return
    dockFocusPendingRef.current = false
    dockEl.focus()
  }, [selectedId, dockEl])

  // On a narrow screen the navigator and the detail dock both live at the
  // bottom - selecting a node hands the space to the detail dock.
  useEffect(() => {
    if (!selectedId) return
    if (
      typeof globalThis.matchMedia === 'function' &&
      !globalThis.matchMedia('(min-width: 768px)').matches
    ) {
      setRailOpen(false)
    }
  }, [selectedId])

  // Each lens builds a fresh scene. Hide it until the map engine reports that
  // its settled first frame has actually been painted.
  useEffect(() => {
    setMapReady(false)
  }, [slug, mode])

  // Escape clears the current selection.
  useEffect(() => {
    if (!selectedId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [selectedId])

  const expandSelected = async () => {
    if (!selected) return
    setExpanding(true)
    try {
      const more = await getRelationsGraph(slug, selected.label, false)
      setExtraGraph((prev) => {
        if (!prev) return more
        return {
          nodes: [...prev.nodes, ...more.nodes],
          edges: [...prev.edges, ...more.edges],
        }
      })
    } catch {
      // The map keeps working with what it has.
    } finally {
      setExpanding(false)
    }
  }

  const switchMode = (next: Mode) => {
    setMapReady(false)
    setMode(next)
    setSelectedId(null)
    setPathFrom(null)
    setPath(null)
    setNoPath(false)
    setHiddenGroups(new Set())
  }

  const loading = mode === 'entity' ? relationsQuery.isLoading : conceptQuery.isLoading
  const error = mode === 'entity' ? relationsQuery.error : conceptQuery.error
  const refetch = mode === 'entity' ? relationsQuery.refetch : conceptQuery.refetch
  const hasGraph = !loading && !error && nodes.length > 0
  const mapBusy = loading || (hasGraph && !mapReady)
  // The API flags an entity graph that is empty because extraction is still
  // running, so the empty state can say "working" rather than "set this up".
  const extracting =
    (relationsQuery.data as { extracting?: boolean } | undefined)?.extracting === true

  const nodeCount = mode === 'entity'
    ? `${nodes.length} ${nodes.length === 1 ? 'entity' : 'entities'}`
    : `${nodes.length} ${nodes.length === 1 ? 'category' : 'categories'}`
  const edgeCount = mode === 'entity'
    ? `${edges.length} ${edges.length === 1 ? 'relation' : 'relations'}`
    : `${edges.length} ${edges.length === 1 ? 'overlap' : 'overlaps'}`
  const counts = `${nodeCount} · ${edgeCount}`
  const subtitle = mode === 'entity'
    ? `${counts} · ${groupStyles.size} ${groupStyles.size === 1 ? 'category' : 'categories'}`
    : counts

  return (
    <div className='flex h-[calc(100dvh-var(--rp-header-h,126px))] flex-col overflow-hidden bg-app'>
      {
        /* Phone chrome - one strip. A stacked hero (title, stats, a full-width
          find field and two spelled-out segmented controls) took 325px of an
          844px screen and left the map the bottom half of its own page, so on
          a narrow screen the controls collapse to their glyphs, the counts
          demote to a caption under the title, and find moves behind a button
          that drops the field over the canvas rather than above it. */
      }
      <div className='relative z-30 shrink-0 md:hidden'>
        <div className='relative overflow-hidden border-b border-line'>
          <HeroGround bannerImageUrl={config.branding.bannerImageUrl} />
          {
            /* A literal 1.5rem, not px-6. Tailwind emits every spacing utility
              as calc(var(--spacing) * n) and this app derives --spacing from
              the per-tenant density dial, while the header's own gutter
              (.rp-shell) is a fixed 1.5rem. On a spacious portal px-6 would
              resolve to 33.6px against the header's 24px and the map's title
              would sit visibly off the logo directly above it. */
          }
          {
            /* The vertical rhythm is set from the INK, not the boxes. The title
              is .rp-display at a 1.05 leading, so its line box sits 3.6px above
              the cap of the K and its descenders fall 1.1px below the box; the
              padding is asymmetric to absorb that and land even optical margins
              above the title and below the controls. Measured on a phone: 7.6px
              over the title, 6.9px between it and the controls, 8.0px under
              them.

              The counts sit on the title's baseline rather than on the row
              below, which is where they were and where they read wrong: an 11px
              caption centred in a 36px row of glyph buttons floats 14.4px down
              from the row's top no matter what the margin does, so the gap under
              the title measured 19.3px against 11.6px above it and the block sat
              loose and bottom-heavy. No margin could close it - at zero the
              buttons already met the descenders of "g" and "p" - so the caption
              had to move. On its baseline it is also the house pattern for a
              heading with a count beside it (see the Library page), it gets more
              width than it had in the row, and the strip gets 2px shorter. */
          }
          <div className='relative pb-2 pt-1' style={{ paddingInline: '1.5rem' }}>
            <div className='flex flex-wrap items-baseline justify-between gap-x-2'>
              {
                /* At the house heading size the title cannot share a row with
                  the five glyph controls on any phone, so they take the row
                  below. That also retires the nowrap this title used to carry:
                  it was there because the title had about 144px beside the
                  controls and .rp-display's `text-wrap: balance` outranks the
                  nowrap inside `truncate`, so it would have taken a second line
                  and the strip's height with it. Sharing its row with only the
                  counts it has 34px of slack at 320px, so it cannot wrap at the
                  default font - and where it genuinely cannot fit, at 320px with
                  a scaled-up root font, the counts wrap below it and balance
                  takes a second line rather than nowrap clipping a two-word page
                  title to "Knowledge ma…". `truncate` stays for its overflow
                  guard, which still catches a single unbreakable word. */
              }
              <h1 className='rp-display truncate text-2xl text-[var(--rp-on-primary)]'>
                Knowledge map
              </h1>
              {hasGraph
                ? (
                  <p className='shrink-0 text-[11px] leading-tight text-[var(--rp-on-primary)]/75'>
                    {
                      /* Demoted, and demoted again on the narrowest phones: the
                        category count the wide hero carries is dropped here (the
                        navigator's legend names every category anyway), and the
                        relation count follows it on a narrow screen rather than
                        being cut off mid-word. */
                    }
                    {nodeCount}
                    <span className='hidden min-[390px]:inline'>{` · ${edgeCount}`}</span>
                  </p>
                )
                : null}
            </div>
            <div className='mt-2 flex items-center justify-end gap-1.5'>
              <button
                type='button'
                aria-label='Find in the map'
                aria-expanded={searchOpen}
                title='Find in the map'
                onClick={() => setSearchOpen((open) => !open)}
                className={`rp-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--rp-radius-btn)] border transition-colors duration-150 ${
                  searchOpen
                    ? 'border-transparent bg-[var(--rp-on-primary)] text-[var(--rp-primary)]'
                    : 'border-[var(--rp-on-primary)]/45 text-[var(--rp-on-primary)]/80'
                }`}
              >
                <SearchGlyph />
              </button>
              <ModeToggle mode={mode} onChange={switchMode} compact />
              {hasGraph ? <LayoutToggle layout={layout} onChange={setLayout} compact /> : null}
            </div>
          </div>
        </div>
        {searchOpen
          ? (
            <div
              className='rp-anim-fade absolute inset-x-0 top-full border-b border-line bg-surface py-2 rp-shadow-md'
              // The same literal gutter as the strip it drops out of, so the
              // field's edges continue the title's rather than sitting inside
              // them.
              style={{ paddingInline: '1.5rem' }}
            >
              <NodeSearch
                nodes={nodes}
                groupStyles={groupStyles}
                onPick={(id) => {
                  focusAndSelect(id)
                  setSearchOpen(false)
                }}
                autoFocus
                onDismiss={() => setSearchOpen(false)}
                className='h-10'
              />
            </div>
          )
          : null}
      </div>

      {
        /* Chrome - title, find and the lens toggle. Kept slim so the map owns
          the height below it. */
      }
      <div className='relative z-40 hidden shrink-0 border-b border-line md:block'>
        <HeroGround bannerImageUrl={config.branding.bannerImageUrl} />
        <div className='relative px-4 py-10 sm:px-6 sm:py-14'>
          <div className='mx-auto max-w-3xl text-center'>
            <h1 className='rp-display text-3xl text-[var(--rp-on-primary)] sm:text-4xl'>
              Knowledge map
            </h1>
            {hasGraph
              ? <p className='mt-3 text-sm text-[var(--rp-on-primary)]/75'>{subtitle}</p>
              : null}
          </div>
          <div className='mt-7 flex flex-wrap items-center justify-center gap-2.5'>
            <NodeSearch nodes={nodes} groupStyles={groupStyles} onPick={focusAndSelect} />
            <ModeToggle mode={mode} onChange={switchMode} />
            {hasGraph ? <LayoutToggle layout={layout} onChange={setLayout} /> : null}
          </div>
        </div>
      </div>

      {/* Canvas stage - the map fills it; panels float over it. */}
      <div
        ref={setStageEl}
        className='relative min-h-0 flex-1 bg-surface'
        aria-busy={mapBusy}
      >
        <p className='sr-only' role='status' aria-live='polite' aria-atomic='true'>
          {mapBusy ? 'Loading knowledge map.' : hasGraph ? 'Knowledge map ready.' : ''}
        </p>
        {loading ? null : error
          ? (
            <CanvasNotice>
              <ErrorCard
                message={error instanceof Error ? error.message : 'The map could not load.'}
                onRetry={() => void refetch()}
              />
            </CanvasNotice>
          )
          : nodes.length === 0
          ? (
            <CanvasNotice>
              <EmptyState
                title={mode !== 'entity'
                  ? 'No taxonomy overlaps yet'
                  : extracting
                  ? 'Building the knowledge graph'
                  : 'No knowledge graph yet'}
                description={mode !== 'entity'
                  ? 'Once resources carry topics and kinds, their overlaps appear here.'
                  : extracting
                  ? 'The knowledge-graph agent is working through the corpus now. Relations appear here as it extracts them - check back shortly.'
                  : 'No knowledge-graph agent has run over this corpus yet - configure one from Manage and the entities and relations will appear here.'}
              />
            </CanvasNotice>
          )
          : (
            <>
              <div
                className={`absolute inset-0 ${mapReady ? 'rp-anim-fade' : 'invisible'}`}
              >
                <KnowledgeMap3D
                  nodes={nodes}
                  edges={edges}
                  groupStyles={groupStyles}
                  degrees={degrees}
                  measure={mode === 'entity' ? 'links' : 'resources'}
                  layout={layout}
                  hiddenGroups={hiddenGroups}
                  selectedId={selectedId}
                  pathEdges={path}
                  pathFrom={pathFrom}
                  onSelect={select}
                  focusId={focusId}
                  insets={insets}
                  hint='Drag to orbit · scroll to zoom · click a node to explore it'
                  onReady={() => setMapReady(true)}
                />
              </div>

              {visibleCount === 0
                ? (
                  <CanvasNotice>
                    <EmptyState
                      title='Everything is hidden'
                      description='The legend filters have hidden every category on the map.'
                    >
                      <button
                        type='button'
                        onClick={() => setHiddenGroups(new Set())}
                        className='rp-btn rp-btn-outline'
                      >
                        Show everything again
                      </button>
                    </EmptyState>
                  </CanvasNotice>
                )
                : null}

              {/* Tracing status - floats over the canvas, out of the panels' way. */}
              {pathFrom && !path
                ? (
                  <div
                    // Below the Browse button on a phone, beside it on a wide
                    // screen: centred at 390px the chip lands straight on top
                    // of it.
                    className='rp-anim-fade absolute left-1/2 top-14 z-30 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-full border bg-surface px-3.5 py-1.5 text-xs rp-shadow-md md:top-3'
                    style={{ borderColor: 'var(--rp-accent)' }}
                    role='status'
                  >
                    <span
                      className='inline-block h-2 w-2 animate-pulse rounded-full'
                      style={{ background: 'var(--rp-accent)' }}
                      aria-hidden='true'
                    />
                    <span className='text-ink'>
                      Tracing from <span className='font-semibold'>{labelById.get(pathFrom)}</span>
                      {' '}
                      - pick another entity
                    </span>
                  </div>
                )
                : null}

              {/* Reopen affordance when the navigator is hidden. */}
              {!railOpen
                ? (
                  <button
                    type='button'
                    onClick={() => setRailOpen(true)}
                    className='rp-btn rp-btn-outline rp-shadow-md absolute left-3 top-3 z-20 h-9 gap-1.5 px-3 text-sm'
                  >
                    <svg
                      viewBox='0 0 20 20'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='1.7'
                      className='h-4 w-4'
                      aria-hidden='true'
                    >
                      <path d='M4 6h12M4 10h12M4 14h8' strokeLinecap='round' />
                    </svg>
                    Browse
                  </button>
                )
                : (
                  <NavigatorRail
                    nodes={nodes}
                    degrees={degrees}
                    groupStyles={groupStyles}
                    hiddenGroups={hiddenGroups}
                    onToggleGroup={(group) =>
                      setHiddenGroups((prev) => {
                        const next = new Set(prev)
                        if (next.has(group)) next.delete(group)
                        else next.add(group)
                        return next
                      })}
                    onSelect={focusAndSelect}
                    onClose={() => setRailOpen(false)}
                    mode={mode}
                    selectedId={selectedId}
                    panelRef={setRailEl}
                  />
                )}

              {/* Detail dock - only when a node is selected. */}
              {selected
                ? (
                  <DetailDock onClose={() => select(null)} panelRef={setDockEl}>
                    {mode === 'entity'
                      ? (
                        <EntityPanel
                          slug={slug}
                          node={selected}
                          edges={edges}
                          degree={degrees.get(selected.id) ?? 0}
                          groupStyle={groupStyles.get(selected.group)}
                          pathState={{ from: pathFrom, path, noPath }}
                          onSelect={focusAndSelect}
                          onExpand={() => void expandSelected()}
                          onArmPath={() => {
                            setPathFrom(selected.id)
                            setPath(null)
                            setNoPath(false)
                          }}
                          onClearPath={() => {
                            setPathFrom(null)
                            setPath(null)
                            setNoPath(false)
                          }}
                          expanding={expanding}
                        />
                      )
                      : (
                        <ConceptPanel
                          slug={slug}
                          node={selected}
                          edges={edges}
                          labelById={labelById}
                          groupStyle={groupStyles.get(selected.group)}
                          onSelect={focusAndSelect}
                        />
                      )}
                  </DetailDock>
                )
                : null}
            </>
          )}
      </div>
    </div>
  )
}
