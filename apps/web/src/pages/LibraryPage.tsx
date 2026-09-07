import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import type { CatalogItem } from '@research-portal/core'
import { getCatalog, getFacets } from '../api/client.ts'
import { Byline, bylineFor } from '../components/Byline.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { GridDensity, ViewToggle } from '../components/ViewControls.tsx'
import { useViewMode, type ViewMode } from '../components/useViewMode.ts'
import { EmptyState, ErrorCard, prettyLabel, sameLabel, Skeleton } from '../components/ui.tsx'
import { plainDashes, presentTitle } from '../lib/display-title.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

const PAGE_SIZE = 24

export type SortValue = 'published' | 'oldestPublished' | 'newest' | 'oldest' | 'title'

export const SORT_VALUES: SortValue[] = [
  'published',
  'oldestPublished',
  'newest',
  'oldest',
  'title',
]

/** The default sort: what was published most recently, not what was uploaded last. */
export const DEFAULT_SORT: SortValue = 'published'

export const SORT_OPTIONS: Record<
  SortValue,
  { label: string; sort: 'created' | 'title' | 'published'; order: 'asc' | 'desc' }
> = {
  published: { label: 'Newest published', sort: 'published', order: 'desc' },
  oldestPublished: { label: 'Oldest published', sort: 'published', order: 'asc' },
  newest: { label: 'Newest added', sort: 'created', order: 'desc' },
  oldest: { label: 'Oldest added', sort: 'created', order: 'asc' },
  title: { label: 'Title A-Z', sort: 'title', order: 'asc' },
}

/**
 * A facet selection from the URL. Each facet answers to its singular name and
 * its plural (`?topic=` and `?topics=`, the form the resource page's topic
 * badges and the Search rail link with), comma-separated for several.
 */
export function facetsFromUrl(
  params: { get: (name: string) => string | null },
  ...names: string[]
): string[] {
  const raw = names.map((name) => params.get(name)).find((value) => value !== null) ?? ''
  return [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
}

/** How a `format` label reads on a card and on the artwork placeholder. */
export function formatLabel(format: string | undefined, type: string | undefined): string | null {
  if (format === 'article') return 'Article'
  if (format === 'supplement') return 'Supplement'
  if (format === 'media') return type === 'video' ? 'Video' : 'Media'
  return null
}

/**
 * The day a corpus was bulk-imported, when there is one: the created date
 * shared by at least four in five of the items on the page. "Added 3 Sept
 * 2026" on every card carries no information, so cards on that day drop
 * the line; anything added since still shows it.
 */
export function bulkImportDay(items: { created?: string }[]): string | null {
  const days = items.map((i) => i.created?.slice(0, 10)).filter((d): d is string => Boolean(d))
  if (days.length < 5) return null
  const counts = new Map<string, number>()
  for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1)
  const [day, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!
  return count / days.length >= 0.8 ? day : null
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

function LibraryCard(
  {
    item,
    slug,
    topicLabel,
    organisation,
    view = 'grid',
    compact = false,
    hideAdded = false,
  }: {
    item: CatalogItem
    slug: string
    topicLabel: (id: string) => string | undefined
    organisation: string
    /** A list row is a horizontal card with a small A4 thumbnail. */
    view?: ViewMode
    /** Narrow viewport - a list row's short lines earn a longer summary. */
    compact?: boolean
    /** This item's created date is the corpus's bulk-import day - say nothing about it. */
    hideAdded?: boolean
  },
) {
  const topicLabels = item.topicIds
    .map((id) => topicLabel(id))
    .filter((label): label is string => Boolean(label))
  const statusInfo = item.status === 'processed' ? null : STATUS_BADGES[item.status]
  const publishedYear = item.published ? formatYear(item.published) : null
  const byline = bylineFor(item)
  const format = formatLabel(item.format, item.type)
  // The kind chip is dropped when it only restates the format badge
  // ("Supplementary Material" under "Supplement").
  const kind = item.kind && !(format && sameLabel(prettyLabel(item.kind, organisation), format))
    ? prettyLabel(item.kind, organisation)
    : null
  const title = presentTitle(item.title)
  const summary = item.summary ? plainDashes(item.summary) : ''

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
          {
            /* Same artwork pipeline as Search: the platform thumbnail when one
            * exists. A text-only article has no page to render, so its
            * placeholder says what it is ("Article"), never "Report". */
          }
          <ResourceThumb
            slug={slug}
            id={item.id}
            type={item.type ?? 'document'}
            label={format ?? undefined}
            imgClassName='object-top'
          />
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
          {title}
        </h3>
        {byline ? <Byline parts={byline} className='!mt-0' /> : null}
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
        {summary && summary !== item.title
          ? (
            <p
              className={`text-xs leading-relaxed text-ink-3 ${
                list && compact ? 'rp-clamp-4' : 'rp-clamp-3'
              }`}
            >
              {summary}
            </p>
          )
          : null}
        {topicLabels.length > 0 || format || kind || (statusInfo && list)
          ? (
            <div className='flex flex-wrap gap-1'>
              {statusInfo && list
                ? <span className={statusInfo.className}>{statusInfo.label}</span>
                : null}
              {format ? <span className='rp-badge rp-badge-quiet'>{format}</span> : null}
              {kind ? <span className='rp-badge rp-badge-quiet'>{kind}</span> : null}
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
        {(item.created && !hideAdded) || (publishedYear && !byline) || item.sourceName
          ? (
            <div className='mt-auto pt-1'>
              {(item.created && !hideAdded) || (publishedYear && !byline)
                ? (
                  <p className='flex flex-wrap items-baseline gap-x-1.5 text-xs tabular-nums text-ink-3'>
                    {publishedYear && !byline ? <span>Published {publishedYear}</span> : null}
                    {item.created && !hideAdded
                      ? <span>Added {formatDate(item.created)}</span>
                      : null}
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
  const [sortState, setSortState] = useState<SortValue>(DEFAULT_SORT)
  const sort = sortProp ?? sortState
  const setSort = onSortChange ?? setSortState
  // Grid density: how many cards sit across the widest breakpoint.
  const [densityState, setDensityState] = useState(4)
  const density = densityProp ?? densityState
  const setDensity = onDensityChange ?? setDensityState
  const [searchParams] = useSearchParams()
  const [selectedTopics, setSelectedTopics] = useState<string[]>(() =>
    facetsFromUrl(searchParams, 'topic', 'topics')
  )
  // Kind deep links arrive from the knowledge map's concept lens.
  const [selectedKinds, setSelectedKinds] = useState<string[]>(() =>
    facetsFromUrl(searchParams, 'kind', 'kinds')
  )
  // Format (article / supplement / media) - present only on a corpus whose
  // ingest filed its resources that way; the facet hides itself otherwise.
  const [selectedFormats, setSelectedFormats] = useState<string[]>(() =>
    facetsFromUrl(searchParams, 'format', 'formats')
  )
  // Until the reader touches the facet, a corpus filed by format opens on its
  // articles: the last-uploaded videos and supplements make a poor first screen.
  const [formatTouched, setFormatTouched] = useState(() =>
    facetsFromUrl(searchParams, 'format', 'formats').length > 0
  )
  const toggleFormat = (id: string) => {
    setFormatTouched(true)
    setSelectedFormats((prev) => prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id])
  }
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
  const formatsKey = selectedFormats.join(',')

  useEffect(() => {
    setPage(0)
    setAccumulated([])
    setTotal(0)
  }, [debouncedQuery, sort, topicsKey, kindsKey, formatsKey])

  const sortOption = SORT_OPTIONS[sort]

  // The same aggregation, under the same query key, as the Search rail - so
  // the two never show different numbers for one topic.
  const { data: facets } = useQuery({
    queryKey: ['facets', config.slug],
    queryFn: () => getFacets(config.slug),
  })
  const topicCounts = facets?.topic ?? {}
  // Resources carrying none of the portal's topics - the gap the classifier
  // has yet to close, made visible rather than silently filtered away. A
  // real count from the index: topics are multi-valued, so "resources minus
  // the sum of topic counts" could never surface it.
  const untagged = facets?.untagged?.topic ?? null
  const kindCounts = facets?.kind ?? {}
  const kindIds = useMemo(() => Object.keys(kindCounts).sort(), [kindCounts])
  const kindLabel = (id: string) => prettyLabel(id, config.branding.organisation)
  const toggleKind = (id: string) =>
    setSelectedKinds((prev) => prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id])
  const formatCounts = facets?.format ?? {}
  const FORMATS = [
    { id: 'article', label: 'Articles' },
    { id: 'supplement', label: 'Supplementary material' },
    { id: 'media', label: 'Video and audio' },
  ]
  const formatFacets = FORMATS.filter((f) => (formatCounts[f.id] ?? 0) > 0)
  useEffect(() => {
    if (!formatTouched && selectedFormats.length === 0 && (formatCounts.article ?? 0) > 0) {
      setSelectedFormats(['article'])
    }
  }, [formatTouched, selectedFormats.length, formatCounts.article])

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['catalog', config.slug, debouncedQuery, sort, topicsKey, kindsKey, formatsKey, page],
    queryFn: () =>
      getCatalog(config.slug, {
        page,
        pageSize: PAGE_SIZE,
        query: debouncedQuery || undefined,
        topicIds: selectedTopics,
        kindIds: selectedKinds,
        formatIds: selectedFormats,
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
  const importDay = useMemo(() => bulkImportDay(accumulated), [accumulated])

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
                  Filters{(selectedTopics.length + selectedKinds.length + selectedFormats.length) >
                      0
                    ? ` (${selectedTopics.length + selectedKinds.length + selectedFormats.length})`
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
                {kindLabel(kind)}
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
          : `mt-6 grid grid-cols-1 gap-6 ${showFilterRail ? 'lg:grid-cols-[14.5rem_1fr]' : ''}`}
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
                        className='inline-flex min-h-6 items-center text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
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
                        <span className='min-w-0 flex-1 [overflow-wrap:anywhere]'>
                          {topic.label}
                        </span>
                        <span className='shrink-0 self-center text-xs tabular-nums text-ink-3'>
                          {count}
                        </span>
                      </label>
                    )
                  })}
                  {untagged
                    ? (
                      <p
                        className='flex items-start gap-2.5 px-1 py-1 text-sm text-ink-3'
                        title='Resources not yet filed under a topic'
                      >
                        <span
                          className='mt-[2px] inline-block h-4 w-4 shrink-0'
                          aria-hidden='true'
                        />
                        <span className='min-w-0 flex-1 italic'>Untagged</span>
                        <span className='shrink-0 self-center text-xs tabular-nums'>
                          {untagged}
                        </span>
                      </p>
                    )
                    : null}
                </div>
                {kindIds.length > 0
                  ? (
                    <div className='mt-4 border-t border-line pt-3'>
                      <div className='flex items-center justify-between gap-2'>
                        <p className='rp-eyebrow text-ink-3'>Kind</p>
                        {selectedKinds.length > 0
                          ? (
                            <button
                              type='button'
                              onClick={() => setSelectedKinds([])}
                              className='inline-flex min-h-6 items-center text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
                            >
                              Clear
                            </button>
                          )
                          : null}
                      </div>
                      <div className='mt-2.5 space-y-0.5'>
                        {kindIds.map((id) => {
                          const count = kindCounts[id] ?? 0
                          const checked = selectedKinds.includes(id)
                          return (
                            <label
                              key={id}
                              className={`flex cursor-pointer items-start gap-2.5 rounded-[var(--rp-radius-btn)] px-1 py-1 text-sm ${
                                count === 0 && !checked ? 'text-ink-3' : 'text-ink-2'
                              }`}
                            >
                              <input
                                type='checkbox'
                                checked={checked}
                                onChange={() => toggleKind(id)}
                                className='mt-[2px] h-4 w-4 shrink-0 rounded-[var(--rp-radius-input)] border-line'
                                style={{ accentColor: 'var(--rp-accent)' }}
                              />
                              <span className='min-w-0 flex-1 [overflow-wrap:anywhere]'>
                                {kindLabel(id)}
                              </span>
                              <span className='shrink-0 self-center text-xs tabular-nums text-ink-3'>
                                {count}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                  : null}
                {formatFacets.length > 0
                  ? (
                    <div className='mt-4 border-t border-line pt-3'>
                      <div className='flex items-center justify-between gap-2'>
                        <p className='rp-eyebrow text-ink-3'>Format</p>
                        {selectedFormats.length > 0
                          ? (
                            <button
                              type='button'
                              onClick={() => {
                                setFormatTouched(true)
                                setSelectedFormats([])
                              }}
                              className='inline-flex min-h-6 items-center text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
                            >
                              Clear
                            </button>
                          )
                          : null}
                      </div>
                      <div className='mt-2.5 space-y-0.5'>
                        {formatFacets.map((format) => {
                          const checked = selectedFormats.includes(format.id)
                          return (
                            <label
                              key={format.id}
                              className='flex cursor-pointer items-start gap-2.5 rounded-[var(--rp-radius-btn)] px-1 py-1 text-sm text-ink-2'
                            >
                              <input
                                type='checkbox'
                                checked={checked}
                                onChange={() => toggleFormat(format.id)}
                                className='mt-[2px] h-4 w-4 shrink-0 rounded-[var(--rp-radius-input)] border-line'
                                style={{ accentColor: 'var(--rp-accent)' }}
                              />
                              <span className='min-w-0 flex-1 [overflow-wrap:anywhere]'>
                                {format.label}
                              </span>
                              <span className='shrink-0 self-center text-xs tabular-nums text-ink-3'>
                                {formatCounts[format.id] ?? 0}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                  : null}
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
                description='Try a different search term, or clear a filter.'
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
                      hideAdded={importDay !== null && item.created?.slice(0, 10) === importDay}
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
