import type { ScoredResource, SearchResults } from '@research-portal/core'
import { plainDashes, presentTitle } from '../lib/display-title.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'

export function PartnerSearchSwitch({ checked, onChange }: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { ui } = usePortalLocale()
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className='rp-btn rp-btn-outline max-w-full whitespace-normal text-left'
      style={{
        minHeight: 'max(44px, calc(2.75rem * var(--rp-density-ctl, 1)))',
        whiteSpace: 'normal',
      }}
    >
      <span className='rp-switch' data-on={checked ? 'true' : 'false'} aria-hidden='true'>
        <span className='rp-switch-knob' />
      </span>
      <span className='min-w-0 [overflow-wrap:anywhere]'>{ui('Include partner collections')}</span>
    </button>
  )
}

export function SearchSourceFacet({ results, selected, onChange }: {
  results: SearchResults | undefined
  selected: string
  onChange: (id: string) => void
}) {
  const { ui } = usePortalLocale()
  return (
    <div>
      <label htmlFor='search-source' className='rp-eyebrow text-ink-3'>{ui('Source')}</label>
      <select
        id='search-source'
        className='rp-input rp-select mt-2 w-full min-w-0 max-w-full'
        style={{ minHeight: 'max(44px, calc(2.75rem * var(--rp-density-ctl, 1)))' }}
        value={selected}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value=''>{ui('All collections')}</option>
        {(results?.sources ?? []).map((source) => (
          <option key={source.id} value={source.id}>
            {source.label}{' '}
            ({results?.resources.filter((r) => r.source?.id === source.id).length ?? 0})
          </option>
        ))}
      </select>
      <p className='mt-3 text-xs leading-relaxed text-ink-3'>
        {ui('One result from each collection in turn, keeping each collection’s ranking.')}
      </p>
    </div>
  )
}

/** Always mounted while shared search is active, so changes are politely announced. */
export function FederatedSearchStatus({ results, loading, count }: {
  results: SearchResults | undefined
  loading: boolean
  count: number
}) {
  const { ui } = usePortalLocale()
  return (
    <div role='status' aria-live='polite' aria-atomic='true' className='text-sm text-ink-2'>
      {loading
        ? <p className='mt-4'>{ui('Searching this collection and partner collections…')}</p>
        : results
        ? (
          <>
            <span className='sr-only'>
              {ui(count === 1 ? '{count} result' : '{count} results', { count })}
            </span>
            {results.failedSources?.length
              ? (
                <div
                  className='mt-4 rounded-[var(--rp-radius)] border p-3'
                  style={{
                    borderColor: 'var(--rp-warn-line)',
                    background: 'var(--rp-warn-bg)',
                    color: 'var(--rp-warn-ink)',
                  }}
                >
                  <p className='font-medium'>{ui('Not searched:')}</p>
                  <ul className='mt-1 space-y-1'>
                    {results.failedSources.map((source) => (
                      <li key={source.id}>
                        {ui('{source} ({reason})', {
                          source: source.label,
                          reason: ui(
                            source.reason === 'timeout'
                              ? 'time limit reached'
                              : source.reason === 'unauthorised'
                              ? 'access unavailable'
                              : 'search unavailable',
                          ),
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}
          </>
        )
        : null}
    </div>
  )
}

export function SearchSourceBadge({ resource }: { resource: ScoredResource }) {
  const { ui } = usePortalLocale()
  return resource.source
    ? (
      <span
        className='rp-badge min-w-0 max-w-full'
        title={resource.source.label}
      >
        <span className='sr-only'>{ui('Source') + ': '}</span>
        <span className='min-w-0 truncate'>{resource.source.label}</span>
      </span>
    )
    : null
}

/** Partner passages are read here, or at their allowed origin; never in the host's reader. */
export function PeerSearchResult({ resource }: { resource: ScoredResource }) {
  const title = presentTitle(resource.title)
  return (
    <article className='rp-card min-w-0 p-4 sm:p-5 [overflow-wrap:anywhere]'>
      <SearchSourceBadge resource={resource} />
      <h3 className='mt-2.5 text-base font-semibold text-ink'>
        {resource.peerUrl
          ? (
            <a
              href={resource.peerUrl}
              className='rp-focus inline-block'
              style={{ minHeight: 'max(44px, calc(2.75rem * var(--rp-density-ctl, 1)))' }}
            >
              {title}
            </a>
          )
          : title}
      </h3>
      <blockquote className='mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-2'>
        {plainDashes(resource.matchedPassage ?? '')}
      </blockquote>
    </article>
  )
}
