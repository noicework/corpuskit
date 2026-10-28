import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { Search } from './icons.tsx'
import { IconButton } from './ui.tsx'
import { SearchSuggestPanel, useSearchSuggest } from './SearchSuggest.tsx'

/**
 * The header search, centred and full-measure: it is the only search box in the product, so it
 * carries the weight. As the reader types it suggests documents, topics and questions; Enter with
 * nothing highlighted searches for what was typed.
 */
export function HeaderSearch({ config }: { config: TenantConfig }) {
  const { ui } = usePortalLocale()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const suggest = useSearchSuggest({
    config,
    query,
    setQuery,
    primary: 'search',
    onChosen: () => setQuery(''),
  })

  return (
    <div className='relative hidden w-[min(40rem,42vw)] min-w-0 items-center lg:flex'>
      <form
        role='search'
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = query.trim()
          if (!trimmed) return
          navigate(`/t/${config.slug}/search?q=${encodeURIComponent(trimmed)}`)
          setQuery('')
        }}
        className='rp-field flex w-full items-center gap-1 rounded-[var(--rp-radius-input)] border bg-surface p-1'
      >
        <label htmlFor='header-search' className='sr-only'>
          {ui('Search')} {config.branding.productName}
        </label>
        <input
          id='header-search'
          type='search'
          {...suggest.inputProps}
          placeholder={config.searchPlaceholder}
          className='min-h-[max(2.75rem,calc(2.75rem*var(--rp-density-ctl,1)))] min-w-0 flex-1 bg-transparent px-3 text-base text-ink outline-none'
        />
        <IconButton type='submit' label={ui('Search')} icon={Search} size='lg' />
      </form>
      <SearchSuggestPanel state={suggest} config={config} />
    </div>
  )
}
