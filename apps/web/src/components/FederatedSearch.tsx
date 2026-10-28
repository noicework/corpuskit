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
    <div role='status' aria-live='polite' aria-atomic='true' className='mt-4 text-sm text-ink-2'>
      {loading ? <p>{ui('Searching this collection and partner collections…')}</p> : results
        ? (
          <>
            <p>
              {ui('{count} results shown from the shared search.', { count })}
            </p>
            {(results.failedSources ?? []).map((source) => (
              <p key={source.id} className='mt-1'>
                {ui(
                  source.reason === 'timeout'
                    ? '{source} could not be searched within the time limit.'
                    : '{source} could not be searched.',
                  {
                    source: source.label,
                  },
                )}
              </p>
            ))}
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
        className='rp-badge max-w-full [overflow-wrap:anywhere]'
        style={{ whiteSpace: 'normal' }}
      >
        {ui('Source: {source}', { source: resource.source.label })}
      </span>
    )
    : null
}

/** Partner passages are read here, or at their allowed origin; never in the host's reader. */
export function PeerSearchResult({ resource }: { resource: ScoredResource }) {
  const { ui } = usePortalLocale()
  const title = presentTitle(resource.title)
  return (
    <article className='rp-card min-w-0 p-4 sm:p-5 [overflow-wrap:anywhere]'>
      <SearchSourceBadge resource={resource} />
      <p className='mt-2 text-xs text-ink-3'>{ui('Partner collection')}</p>
      <h3 className='mt-2.5 text-base font-semibold text-ink'>
        {resource.peerUrl
          ? (
            <a href={resource.peerUrl} className='rp-focus inline-block min-h-11'>
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
