import { usePortalLocale } from '../lib/portal-locale.tsx'
import { type KeyboardEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MAP_HEIGHT, MAP_WIDTH, STATES } from './australia-paths.ts'

/**
 * A bare place name is a poor question: the answer engine gets a noun with no
 * intent and produces a thin, odd-looking answer. Asking a real question gives
 * it something to answer and still retrieves the same regional documents.
 */
export const regionQuestion = (label: string) => `What research has been done in ${label}?`

export const REGIONS = STATES.map((state) => ({
  id: state.id,
  label: state.label,
  query: regionQuestion(state.label),
}))

/**
 * A map of Australia for regional discovery: each state links into the search
 * for that region's documents. Geometry is real (see australia-paths.ts), not
 * hand-drawn - it is generated from public state boundaries and simplified.
 */
export function RegionMap({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()
  const navigate = useNavigate()
  const [active, setActive] = useState<string | null>(null)

  const go = (label: string) => navigate(`/t/${slug}/search?q=${encodeURIComponent(label)}`)

  const onKey = (event: KeyboardEvent<SVGGElement>, label: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      go(label)
    }
  }

  return (
    <svg
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      className='h-auto w-full overflow-visible'
      role='group'
      aria-label={ui('Map of Australia - choose a region to search its documents')}
    >
      {STATES.map((state) => {
        const on = active === state.id
        return (
          <g
            key={state.id}
            role='link'
            tabIndex={0}
            aria-label={ui('Search {value1} documents', { value1: state.label })}
            onClick={() => go(state.label)}
            onKeyDown={(event) => onKey(event, state.label)}
            onMouseEnter={() => setActive(state.id)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(state.id)}
            onBlur={() => setActive(null)}
            className='rp-pages-region-link cursor-pointer'
          >
            {/* Enlarge the island's hit area without changing its boundary. */}
            {state.id === 'tas' && (
              <rect x={740} y={750} width={150} height={148} fill='transparent' />
            )}
            <path
              d={state.path}
              className='transition-[fill,stroke] duration-150'
              style={{
                fill: on
                  ? 'var(--rp-accent)'
                  : 'color-mix(in srgb, var(--rp-on-primary) 13%, transparent)',
                stroke: on
                  ? 'var(--rp-on-primary)'
                  : 'color-mix(in srgb, var(--rp-on-primary) 45%, transparent)',
                strokeWidth: 1.6,
                strokeLinejoin: 'round',
              }}
            />
          </g>
        )
      })}
      {/* Labels last, so no neighbouring shape can paint over them. */}
      {STATES.map((state) => {
        const on = active === state.id
        return (
          <text
            key={`${state.id}-label`}
            x={state.labelX}
            y={state.labelY}
            textAnchor='middle'
            className='pointer-events-none select-none'
            style={{
              fill: on ? 'var(--rp-on-accent)' : 'var(--rp-on-primary)',
              fontSize: state.id === 'tas' || state.id === 'vic' ? '1.5rem' : '1.875rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              paintOrder: 'stroke',
              stroke: on ? 'none' : 'color-mix(in srgb, var(--rp-primary) 45%, transparent)',
              strokeWidth: on ? 0 : 4,
            }}
          >
            {state.id.toUpperCase()}
          </text>
        )
      })}
    </svg>
  )
}
