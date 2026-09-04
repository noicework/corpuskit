import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import type { CatalogItem } from '@research-portal/core'
import { getCatalog, getFacets } from '../api/client.ts'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { GridDensity, ViewToggle } from '../components/ViewControls.tsx'
import { useViewMode, type ViewMode } from '../components/useViewMode.ts'
import { EmptyState, ErrorCard, prettyLabel, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

const PAGE_SIZE = 24

export type SortValue = 'newest' | 'oldest' | 'title'

export const SORT_VALUES: SortValue[] = ['newest', 'oldest', 'title']

export const SORT_OPTIONS: Record<
  SortValue,
  { label: string; sort: 'created' | 'title'; order: 'asc' | 'desc' }
> = {
  newest: { label: 'Newest added', sort: 'created', order: 'desc' },
  oldest: { label: 'Oldest added', sort: 'created', order: 'asc' },
  title: { label: 'Title A-Z', sort: 'title', order: 'asc' },
}

const STATUS_BADGES: Record<'pending' | 'error', { label: string; className: string }> = {
  pending: { label: 'Processing', className: 'rp-badge rp-badge-warn' },
  error: { label: 'Error', className: 'rp-badge rp-badge-bad' },
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Publish year from an ISO date, or null when the date is missing/unparseable. */
function formatYear(iso: string): string | null {
  const match = /^(\d{4})/.exec(iso)
  return match ? match[1] ?? null : null
}

/**
 * Catalogue items may carry the platform's `kind` label and the source's
 * original publish date - fields not yet in the shared CatalogItem type, so
 * they're read defensively here and simply omitted when absent.
 */
type CatalogItemMeta = CatalogItem & { kind?: string; published?: string }

function LibraryCard(
  {
    item,
    slug,
    topicLabel,
    organisation,
    view = 'grid',
    compact = false,
  }: {
    item: CatalogItem
    slug: string
    topicLabel: (id: string) => string | undefined
    organisation: string
    /** A list row is a horizontal card with a small A4 thumbnail. */
    view?: ViewMode
    /** Narrow viewport - a list row's short lines earn a longer summary. */
    compact?: boolean
  },
) {
  const meta = item as CatalogItemMeta
  const topicLabels = item.topicIds
    .map((id) => topicLabel(id))
    .filter((label): label is string => Boolean(label))
  const statusInfo = item.status === 'processed' ? null : STATUS_BADGES[item.status]
  const publishedYear = meta.published ? formatYear(meta.published) : null

  const list = view === 'list'
  const body = (
    <>
      <div
        className={list
          ? 'relative m-3.5 mr-0 aspect-[210/297] w-[4.5rem] shrink-0 self-start overflow-hidden border border-line'
          : 'relative aspect-[4/3] w-full overflow-hidden bg-surface-2'}
        aria-hidden='true'
      >
        {
          /* The page peeks up from behind the grey ground, as on Explore. In a
          * list row there is no room for that, so it fills its frame. */
        }
        <div
          className={list
            ? 'absolute inset-0 overflow-hidden bg-surface'
            : 'rp-shadow-sm absolute inset-x-6 bottom-0 top-6 overflow-hidden bg-surface'}
        >
          <ResourceThumb slug={slug} id={item.id} type='document' imgClassName='object-top' />
        </div>
        {
          /* A list row's thumbnail is only 4.5rem wide, too narrow to carry the
          * status badge without clipping it - there it rides with the other
          * badges in the text column instead. */
        }
        {statusInfo && !list
          ? (
            <span className={`absolute left-2 top-2 ${statusInfo.className}`}>
              {statusInfo.label}
            </span>
          )
          : null}
      </div>
      <div
        className={list
          ? 'flex min-w-0 flex-1 flex-col gap-1.5 p-3.5'
          : 'flex flex-1 flex-col gap-2 border-t border-line p-3.5'}
      >
        <h3 className='rp-clamp-2 text-sm font-semibold leading-snug text-ink'>
          {item.title}
        </h3>
        {
          /* Three lines is the budget almost everywhere: two clipped most grid
          * summaries mid-sentence, and the third line is what lets a card read
          * as a description rather than a truncated fragment. A phone's list
          * row still wants more - its text column is barely 230px, so three
          * lines is about a dozen words - and four costs nothing there, since
          * the row is only as tall as the text it actually has. A desktop list
          * row is the opposite case: its column runs the best part of a
          * thousand pixels, so three lines already carry a few hundred
          * characters and a four-line clamp would mostly buy whitespace. */
        }
        {item.summary && item.summary !== item.title
          ? (
            <p
              className={`text-xs leading-relaxed text-ink-3 ${
                list && compact ? 'rp-clamp-4' : 'rp-clamp-3'
              }`}
            >
              {item.summary}
            </p>
          )
          : null}
        {topicLabels.length > 0 || meta.kind || (statusInfo && list)
          ? (
            <div className='flex flex-wrap gap-1'>
              {statusInfo && list
                ? <span className={statusInfo.className}>{statusInfo.label}</span>
                : null}
              {meta.kind
                ? (
                  <span className='rp-badge rp-badge-quiet'>
                    {prettyLabel(meta.kind, organisation)}
                  </span>
                )
                : null}
              {topicLabels.slice(0, 3).map((label) => (
                <span
                  key={label}
                  className='rp-badge rp-badge-quiet'
                >
                  {label}
                </span>
              ))}
            </div>
          )
          : null}
        {item.created || publishedYear || item.sourceName
          ? (
            <div className='mt-auto pt-1'>
              {item.created || publishedYear
                ? (
                  <p className='flex flex-wrap items-baseline gap-x-1.5 text-xs tabular-nums text-ink-3'>
                    {item.created ? <span>{formatDate(item.created)}</span> : null}
                    {publishedYear ? <span>Published {publishedYear}</span> : null}
                  </p>
                )
                : null}
              {item.sourceName
                ? (
                  <p className='truncate text-[11px] tabular-nums text-ink-3/80'>
                    {item.sourceName}
                  </p>
                )
                : null}
            </div>
          )
          : null}
      </div>
    </>
  )

  return (
    <Link
      to={`/t/${slug}/library/${item.id}`}
      className={`rp-card rp-lift rp-focus flex overflow-hidden ${
        list ? 'flex-row items-stretch' : 'flex-col'
      }`}
    >
      {body}
    </Link>
  )
}

function LibraryCardSkeleton() {
  return (
    <div className='rp-card flex flex-col overflow-hidden'>
      <div className='rp-shimmer bg-surface-3 h-24 w-full' aria-hidden='true' />
      <div className='flex flex-col gap-2 border-t border-line p-3.5'>
        <Skeleton className='h-4 w-3/4' />
        <Skeleton className='h-4 w-1/2' />
        <Skeleton className='h-3 w-24' />
      </div>
    </div>
  )
}

/**
 * The library browser. Exported separately so the Library route (which is the
 * search page) can render it as its own no-query state.
 */
export function LibraryBrowser(
  {
    bare = false,
    sort: sortProp,
    onSortChange,
    density: densityProp,
    onDensityChange,
    view: viewProp,
    onViewChange,
  }: {
    bare?: boolean
    /** Controlled sort and density, when the host renders the controls itself. */
    sort?: SortValue
    onSortChange?: (value: SortValue) => void
    density?: number
    onDensityChange?: (value: number) => void
    /**
     * Controlled layout, when the host renders the view toggle itself. An
     * explicit choice always wins; leave it unset to let the browser hold the
     * state and render its own toggle.
     */
    view?: ViewMode
    onViewChange?: (value: ViewMode) => void
  } = {},
) {
  const { config } = useOutletContext<TenantOutletContext>()

  // Uncontrolled, the layout starts from the viewport - a phone opens in list -
  // and switches to whatever the toggle is set to from the first click on. A
  // host that controls `view` (the search page) wins at every width either way.
  const { view: viewState, setView: setViewState, compact } = useViewMode()
  const view = viewProp ?? viewState
  const setView = onViewChange ?? setViewState

  const [queryDraft, setQueryDraft] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sortState, setSortState] = useState<SortValue>('newest')
  const sort = sortProp ?? sortState
  const setSort = onSortChange ?? setSortState
  // Grid density: how many cards sit across the widest breakpoint.
  const [densityState, setDensityState] = useState(4)
  const density = densityProp ?? densityState
  const setDensity = onDensityChange ?? setDensityState
  const [searchParams] = useSearchParams()
  const [selectedTopics, setSelectedTopics] = useState<string[]>(() => {
    const fromUrl = searchParams.get('topic')
    return fromUrl ? [fromUrl] : []
  })
  // Kind deep links arrive from the knowledge map's concept lens.
  const [selectedKinds, setSelectedKinds] = useState<string[]>(() => {
    const fromUrl = searchParams.get('kind')
    return fromUrl ? [fromUrl] : []
  })
  const [filtersOpen, setFiltersOpen] = useState(false)
  /** The filter rail, and therefore the sidebar grid track, need topics to filter by. */
  const showFilterRail = !bare && config.topics.length > 0
  const [page, setPage] = useState(0)
  const [accumulated, setAccumulated] = useState<CatalogItem[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(queryDraft.trim()), 300)
    return () => clearTimeout(timer)
  }, [queryDraft])

  const topicsKey = selectedTopics.join(',')
  const kindsKey = selectedKinds.join(',')

  useEffect(() => {
    setPage(0)
    setAccumulated([])
    setTotal(0)
  }, [debouncedQuery, sort, topicsKey, kindsKey])

  const sortOption = SORT_OPTIONS[sort]

  const { data: facets } = useQuery({
    queryKey: ['facets', config.slug],
    queryFn: () => getFacets(config.slug, ['topic']),
  })
  const topicCounts = facets?.topic ?? {}

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['catalog', config.slug, debouncedQuery, sort, topicsKey, kindsKey, page],
    queryFn: () =>
      getCatalog(config.slug, {
        page,
        pageSize: PAGE_SIZE,
        query: debouncedQuery || undefined,
        topicIds: selectedTopics,
        kindIds: selectedKinds,
        sort: sortOption.sort,
        order: sortOption.order,
      }),
  })

  useEffect(() => {
    if (!data) return
    setAccumulated((prev) => (page === 0 ? data.items : [...prev, ...data.items]))
    setTotal(data.total)
  }, [data, page])

  const topicLabel = useMemo(() => {
    const map = new Map(config.topics.map((topic) => [topic.id, topic.label]))
    return (id: string) => map.get(id)
  }, [config.topics])

  function toggleTopic(id: string) {
    setSelectedTopics((prev) =>
      prev.includes(id) ? prev.filter((topicId) => topicId !== id) : [...prev, id]
    )
  }

  // A minimum track width keeps the grid responsive: the density sets how many
  // columns to aim for, and narrow viewports still fall back to fewer.
  const gridStyle = view === 'list' ? { gridTemplateColumns: '1fr' } : {
    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${
      Math.round(1180 / density)
    }px), 1fr))`,
  }

  const hasMore = accumulated.length < total
  const isInitialLoading = isLoading && page === 0

  return (
    <main className={bare ? '' : 'rp-shell py-8'}>
      {!bare && (
        <div className='flex flex-wrap items-baseline justify-between gap-2'>
          <h1 className='rp-display text-2xl text-ink'>Library</h1>
          {!isInitialLoading && !isError
            ? (
              <p className='text-sm font-medium tabular-nums text-ink-3'>
                {total.toLocaleString()} {total === 1 ? 'resource' : 'resources'}
              </p>
            )
            : null}
        </div>
      )}

      {
        /* Bare mode drops the library's own heading, search and facet rail, but
        * the listing still needs its sort. */
      }
      {bare && !onSortChange && (
        <div className='mb-4 flex flex-wrap items-center justify-end gap-2'>
          <ViewToggle
            value={view}
            onChange={setView}
            className='mr-1 h-[calc(2.25rem*var(--rp-density-ctl,1))]'
          />
          <GridDensity value={density} onChange={setDensity} view={view} className='mr-3' />
          <label htmlFor='library-sort-bare' className='text-xs font-medium text-ink-3'>
            Sort
          </label>
          <select
            id='library-sort-bare'
            value={sort}
            onChange={(event) => setSort(event.target.value as SortValue)}
            className='rp-focus rp-select h-[calc(2.25rem*var(--rp-density-ctl,1))] rounded-[var(--rp-radius-input)] border border-line bg-surface px-3 text-sm text-ink'
          >
            {SORT_VALUES.map((value) => (
              <option key={value} value={value}>
                {SORT_OPTIONS[value].label}
              </option>
            ))}
          </select>
        </div>
      )}

      {!bare && (
        <div className='mt-4 flex flex-wrap items-center gap-2'>
          {
            /* No `onSubmit`: this listing is client-side, so it narrows as the
            * reader types and there is nothing to commit. */
          }
          <SearchField
            id='library-search'
            label='Search the library'
            value={queryDraft}
            onChange={setQueryDraft}
            placeholder='Search within the library'
            className='min-w-[min(16rem,100%)] flex-1'
          />

          {
            /* Layout, then grid size, then sort - the same trio in the same
            * order as the search page's listing controls. */
          }
          <ViewToggle
            value={view}
            onChange={setView}
            className='h-[calc(2.25rem*var(--rp-density-ctl,1))]'
          />
          <GridDensity value={density} onChange={setDensity} view={view} />

          <label htmlFor='library-sort' className='sr-only'>
            Sort by
          </label>
          <select
            id='library-sort'
            value={sort}
            onChange={(event) => setSort(event.target.value as SortValue)}
            className='rp-focus rp-select h-[calc(2.25rem*var(--rp-density-ctl,1))] rounded-[var(--rp-radius-input)] border border-line bg-surface px-3 text-sm text-ink'
          >
            {SORT_VALUES.map((value) => (
              <option key={value} value={value}>
                {SORT_OPTIONS[value].label}
              </option>
            ))}
          </select>

          {
            /* Wrapped, because .rp-btn sets its own display and would beat an
            * `lg:hidden` utility on the button itself - which is why this was
            * still sitting in the desktop toolbar doing nothing, the facet rail
            * beside it being `lg:block` and never hidden there. Same wrapping as
            * the header's menu button, for the same reason. */
          }
          {showFilterRail
            ? (
              <span className='lg:hidden'>
                <button
                  type='button'
                  onClick={() => setFiltersOpen((open) => !open)}
                  className='rp-btn rp-btn-outline'
                  aria-expanded={filtersOpen}
                >
                  Filters{(selectedTopics.length + selectedKinds.length) > 0
                    ? ` (${selectedTopics.length + selectedKinds.length})`
                    : ''}
                </button>
              </span>
            )
            : null}
        </div>
      )}

      {!bare && selectedKinds.length > 0
        ? (
          <div className='mt-4 flex flex-wrap items-center gap-2'>
            <span className='text-xs uppercase tracking-wide text-ink-3'>Filtered to kind</span>
            {selectedKinds.map((kind) => (
              <button
                key={kind}
                type='button'
                onClick={() => setSelectedKinds((prev) => prev.filter((k) => k !== kind))}
                className='rp-chip text-xs'
                title='Remove this filter'
              >
                {kind.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                <span aria-hidden='true'>×</span>
              </button>
            ))}
          </div>
        )
        : null}

      {
        /* The sidebar track only exists when the filter rail does. A portal
        * whose corpus has no topics renders no aside, and an unconditional
        * `230px 1fr` put the only child in the 230px column - a full-width
        * page of cards squeezed into a narrow strip with the rest blank. */
      }
      <div
        className={bare
          ? ''
          : `mt-6 grid grid-cols-1 gap-6 ${showFilterRail ? 'lg:grid-cols-[230px_1fr]' : ''}`}
      >
        {showFilterRail
          ? (
            <aside className={`${filtersOpen ? 'block' : 'hidden'} lg:block`}>
              <div className='rp-card p-4 lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)]'>
                <div className='flex items-center justify-between gap-2'>
                  <p className='rp-eyebrow text-ink-3'>Topics</p>
                  {selectedTopics.length > 0
                    ? (
                      <button
                        type='button'
                        onClick={() => setSelectedTopics([])}
                        className='text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
                      >
                        Clear
                      </button>
                    )
                    : null}
                </div>
                <div className='mt-2.5 space-y-0.5'>
                  {config.topics.map((topic) => {
                    const count = topicCounts[topic.id] ?? 0
                    const checked = selectedTopics.includes(topic.id)
                    const muted = count === 0 && !checked
                    return (
                      <label
                        key={topic.id}
                        className={`flex cursor-pointer items-start gap-2.5 rounded-[var(--rp-radius-btn)] px-1 py-1 text-sm ${
                          muted ? 'text-ink-3' : 'text-ink-2'
                        }`}
                      >
                        <input
                          type='checkbox'
                          checked={checked}
                          onChange={() => toggleTopic(topic.id)}
                          className='mt-[2px] h-4 w-4 shrink-0 rounded-[var(--rp-radius-input)] border-line'
                          style={{ accentColor: 'var(--rp-accent)' }}
                        />
                        <span className='min-w-0 flex-1'>{topic.label}</span>
                        <span className='self-center text-xs tabular-nums text-ink-3'>{count}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </aside>
          )
          : null}

        <div className='min-w-0'>
          {isError
            ? (
              <ErrorCard
                message={error instanceof Error ? error.message : 'Could not load the library.'}
                onRetry={() => void refetch()}
              />
            )
            : null}

          {isInitialLoading
            ? (
              <div className='grid gap-3' style={gridStyle}>
                {Array.from({ length: 10 }).map((_, index) => <LibraryCardSkeleton key={index} />)}
              </div>
            )
            : null}

          {!isInitialLoading && !isError && accumulated.length === 0
            ? (
              <EmptyState
                title='No resources match these filters'
                description='Try a different search term, or clear the topic filters.'
              />
            )
            : null}

          {!isInitialLoading && !isError && accumulated.length > 0
            ? (
              <>
                <div style={gridStyle} className='grid gap-3'>
                  {accumulated.map((item) => (
                    <LibraryCard
                      view={view}
                      compact={compact}
                      key={item.id}
                      item={item}
                      slug={config.slug}
                      topicLabel={topicLabel}
                      organisation={config.branding.organisation}
                    />
                  ))}
                </div>

                {hasMore
                  ? (
                    <div className='mt-6 flex justify-center'>
                      <button
                        type='button'
                        onClick={() => setPage((prev) => prev + 1)}
                        disabled={isFetching}
                        className='rp-btn rp-btn-outline'
                      >
                        {isFetching ? 'Loading…' : 'Load more'}
                      </button>
                    </div>
                  )
                  : null}
              </>
            )
            : null}
        </div>
      </div>
    </main>
  )
}

/** The standalone /library route, kept for direct links and the mobile sheet. */
export function LibraryPage() {
  return <LibraryBrowser />
}
