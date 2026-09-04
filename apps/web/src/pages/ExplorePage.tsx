import { type FormEvent, useCallback, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import type { ResourceSummary, TenantConfig } from '@research-portal/core'
import { getCatalog, getFacets, getTopicResources } from '../api/client.ts'
import { topicsWithFacetCounts } from '../lib/topic-rows.ts'
import { EmptyState, ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { RegionMap, REGIONS } from '../components/RegionMap.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

/* -------------------------------------------------------------------------
 * Hero
 * ---------------------------------------------------------------------- */

/**
 * The hero backdrop. With a tenant hero photograph it is a full-bleed cover
 * image under a duotone wash of the tenant's hero colours; without one it is
 * the gradient, lifted by a radial bloom and a faint dot grid so it reads as a
 * designed surface rather than a flat colour field.
 */
function HeroBackdrop({ imageUrl }: { imageUrl?: string }) {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(imageUrl) && !imageFailed

  return (
    <div className='absolute inset-0 -z-10 overflow-hidden' aria-hidden='true'>
      <div
        className='absolute inset-0'
        style={{ background: 'linear-gradient(135deg, var(--rp-hero-from), var(--rp-hero-to))' }}
      />
      {showImage && imageUrl
        ? (
          <>
            <img
              src={imageUrl}
              alt=''
              onError={() => setImageFailed(true)}
              className='rp-anim-kenburns absolute inset-0 h-full w-full object-cover'
            />
            <div className='rp-hero-duotone absolute inset-0' />
            <div className='rp-scrim-bottom absolute inset-0' />
          </>
        )
        : (
          <>
            <div className='rp-dotgrid absolute inset-0 opacity-70' />
            <div className='rp-hero-glow absolute inset-0' />
          </>
        )}
    </div>
  )
}

function Hero({
  config,
  onAsk,
}: {
  config: TenantConfig
  /** The hero's own question path: submitting or picking a suggestion. */
  onAsk: (text: string) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    onAsk(trimmed)
  }

  // The horizontal gutter is `rp-shell`'s job. This section used to add `px-6`
  // of its own on top of it, so on a 390px phone the two stacked into a 48px
  // inset each side and left the headline, the ask field and the suggestion
  // chips only 277px to live in. The extra inset is kept from `sm:` up, where
  // there is width to spend on it.
  return (
    <section className='relative isolate pb-24 pt-14 sm:px-6 sm:pb-28 sm:pt-20'>
      <HeroBackdrop imageUrl={config.branding.heroImageUrl} />

      <div className='rp-shell grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-14'>
        <div className='min-w-0'>
          <h1 className='rp-display rp-anim-rise text-4xl text-[var(--rp-on-hero)] sm:text-5xl lg:text-6xl'>
            What would you like to explore?
          </h1>

          <form onSubmit={handleSubmit} className='rp-anim-rise rp-delay-1 mt-8' role='search'>
            <label htmlFor='explore-search' className='sr-only'>
              Ask {config.branding.productName}
            </label>
            <div className='relative max-w-2xl'>
              <div className='rp-shadow-xl flex items-center gap-2 rounded-[var(--rp-radius-input)] bg-surface p-1.5 pl-3.5 ring-1 ring-[var(--rp-on-hero)]/40 focus-within:ring-2 focus-within:ring-[var(--rp-on-hero)]'>
                <svg
                  viewBox='0 0 20 20'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='1.8'
                  strokeLinecap='round'
                  aria-hidden='true'
                  className='h-5 w-5 shrink-0 text-ink-3'
                >
                  <circle cx='9' cy='9' r='5.5' />
                  <path d='M13.2 13.2L17 17' />
                </svg>
                {
                  /* No placeholder: the tenant's corpus blurb is far longer than
                   * the field is wide and clipped mid-word ("Ask fisheries,
                   * aquaculture, stoc"), which read as a broken control. The
                   * headline directly above already says what the field is for,
                   * and the sr-only label above names it for assistive tech. */
                }
                <input
                  id='explore-search'
                  ref={inputRef}
                  type='text'
                  autoComplete='off'
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className='min-w-0 flex-1 border-0 bg-transparent px-2 py-2 text-[0.95rem] text-ink focus:outline-none'
                />
                <button type='submit' className='rp-btn rp-btn-primary shrink-0 font-semibold'>
                  Ask
                </button>
              </div>
            </div>
          </form>

          {config.suggestedQuestions.length > 0
            ? (
              <div className='rp-anim-rise rp-delay-2 mt-4 flex max-w-2xl flex-wrap gap-2'>
                {config.suggestedQuestions.slice(0, 3).map((question) => (
                  <button
                    key={question.id}
                    type='button'
                    onClick={() => onAsk(question.text)}
                    className='rp-focus-inverse rounded-[var(--rp-radius-chip)] border border-[var(--rp-on-hero)]/30 bg-[var(--rp-on-hero)]/12 px-3 py-1.5 text-sm text-[var(--rp-on-hero)] backdrop-blur-sm transition-colors duration-150 hover:bg-[var(--rp-on-hero)]/25'
                  >
                    {question.text}
                  </button>
                ))}
              </div>
            )
            : null}
        </div>

        <RecentDocuments slug={config.slug} />
      </div>
    </section>
  )
}

/**
 * A short list of what has most recently landed in the corpus, beside the ask.
 * It is a sign of life on a portal that is still loading, and a way in for a
 * reader who does not yet have a question.
 */
function RecentDocuments({ slug }: { slug: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['recent-documents', slug],
    queryFn: () => getCatalog(slug, { pageSize: 12, sort: 'created', order: 'desc' }),
    staleTime: 5 * 60 * 1000,
  })

  // Only documents the platform has finished with - a pending one has no
  // thumbnail and no real title yet.
  const items = (data?.items ?? []).filter((item) => item.status === 'processed').slice(0, 5)

  if (!isLoading && items.length === 0) return null

  return (
    <div className='rp-anim-rise rp-delay-3 hidden lg:block'>
      <p className='rp-eyebrow text-[var(--rp-on-primary)]/60'>Recently added</p>
      <ul className='mt-4 space-y-1'>
        {isLoading
          ? Array.from({ length: 4 }).map((_, index) => (
            <li key={index} className='flex items-center gap-3 py-2.5'>
              <span className='rp-shimmer h-14 w-11 shrink-0 bg-[var(--rp-on-primary)]/15' />
              <span className='rp-shimmer h-3 w-40 bg-[var(--rp-on-primary)]/15' />
            </li>
          ))
          : items.map((item) => (
            <li key={item.id}>
              <Link
                to={`/t/${slug}/library/${item.id}`}
                className='rp-focus-inverse group -mx-2.5 flex items-center gap-3 rounded-[var(--rp-radius-btn)] border-b border-[var(--rp-on-primary)]/15 px-2.5 py-2.5 transition-colors duration-150 hover:bg-[var(--rp-on-primary)]/10'
              >
                <span className='h-14 w-11 shrink-0 overflow-hidden bg-[var(--rp-on-primary)]/10'>
                  <ResourceThumb
                    slug={slug}
                    id={item.id}
                    type='document'
                    imgClassName='object-top'
                  />
                </span>
                <span className='min-w-0 flex-1'>
                  <span className='rp-clamp-2 block text-sm leading-snug text-[var(--rp-on-primary)]'>
                    {item.title}
                  </span>
                </span>
                <span
                  aria-hidden='true'
                  className='shrink-0 text-[var(--rp-on-primary)]/50 transition-transform duration-200 group-hover:translate-x-0.5'
                >
                  &rarr;
                </span>
              </Link>
            </li>
          ))}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Quick entry
 * ---------------------------------------------------------------------- */

const TILE_ICONS = {
  library: <path d='M4 4.5h7v6H4zM4 13.5h7v6H4zM15 4.5h5v15h-5z' />,
  ask: <path d='M4 5.5h16v11H9l-5 4z' />,
  graph: (
    <>
      <circle cx='6' cy='6.5' r='2.5' />
      <circle cx='18' cy='9.5' r='2.5' />
      <circle cx='10' cy='17.5' r='2.5' />
      <path d='M8.2 7.7l7.6 1.4M16.4 11.6l-4.7 4.2M8.4 15.4l-1.6-6.5' />
    </>
  ),
  investigations: (
    <>
      <circle cx='10.5' cy='10.5' r='5.5' />
      <path d='M14.6 14.6L20 20' />
    </>
  ),
} as const

function TileIcon({ name }: { name: keyof typeof TILE_ICONS }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className='h-9 w-9 shrink-0'
      aria-hidden='true'
    >
      {TILE_ICONS[name]}
    </svg>
  )
}

/** The four ways into the corpus, as brand-washed blocks under the hero. */
function QuickEntry({ slug }: { slug: string }) {
  const tiles = [
    { to: 'library', label: 'Browse the library', icon: 'library' },
    { to: 'ask', label: 'Ask a question', icon: 'ask' },
    { to: 'graph', label: 'Explore the graph', icon: 'graph' },
    { to: 'investigations', label: 'Run an investigation', icon: 'investigations' },
  ] as const

  return (
    <div className='rp-shell rp-anim-rise rp-delay-2 grid grid-cols-1 gap-3 py-10 sm:grid-cols-2'>
      {tiles.map((tile) => (
        <Link key={tile.to} to={`/t/${slug}/${tile.to}`} className='rp-tile'>
          <TileIcon name={tile.icon} />
          <span className='rp-tile-label'>{tile.label}</span>
          <svg
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.5'
            strokeLinecap='round'
            strokeLinejoin='round'
            className='rp-tile-arrow h-5 w-5 shrink-0'
            aria-hidden='true'
          >
            <path d='M4 12h15M13 6l6 6-6 6' />
          </svg>
        </Link>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Regional discovery
 * ---------------------------------------------------------------------- */

/**
 * A featured band: the corpus is national, so the map is a way in by place.
 * Each region asks a real question about that state rather than searching a
 * bare place name. The list beside the map is not decoration - it is the
 * keyboard and screen-reader path to the same questions, so it carries its own
 * group label; the sentence that used to tell a reader what to do here has
 * gone, and the label is what keeps that instruction for assistive tech.
 */
function RegionBand({ slug }: { slug: string }) {
  return (
    <section style={{ backgroundColor: 'var(--rp-primary)' }}>
      {
        /* Tighter stack on a phone, where the map reads as the continuation of
        * the region buttons rather than a second block; the wider gap returns
        * at `md:`, where it is the column gap between copy and map. */
      }
      <div className='rp-shell grid gap-8 py-12 md:grid-cols-2 md:items-center md:gap-10 md:py-16'>
        <div className='min-w-0'>
          <h2 className='rp-display text-3xl text-[var(--rp-on-primary)] sm:text-4xl'>
            Explore by region
          </h2>
          <p className='mt-4 max-w-md text-base leading-relaxed text-[var(--rp-on-primary)]/75'>
            Research from every corner of the country
          </p>
          {
            /* On a phone the seven links fill their wrap lines, so the group
             * reads as a justified block of destinations rather than a ragged
             * cloud of tags, and each one clears 44px for a thumb - a 33px pill
             * is a poor target. Both are dropped at `sm:`, where the row goes
             * back to natural widths beside the map. */
          }
          <ul aria-label='Regions' className='mt-6 flex flex-wrap gap-2'>
            {REGIONS.map((region) => (
              <li key={region.id} className='grow sm:grow-0'>
                <Link
                  to={`/t/${slug}/search?q=${encodeURIComponent(region.query)}`}
                  className='rp-focus-inverse inline-flex min-h-11 w-full items-center justify-center rounded-[var(--rp-radius-chip)] border border-[var(--rp-on-primary)]/30 bg-[var(--rp-on-primary)]/10 px-3 py-1.5 text-sm text-[var(--rp-on-primary)] transition-colors duration-150 hover:bg-[var(--rp-on-primary)]/20 sm:min-h-0 sm:w-auto'
                >
                  {region.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className='min-w-0'>
          <RegionMap slug={slug} />
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------
 * Topic rows
 * ---------------------------------------------------------------------- */

function ResourceCard({ slug, resource }: { slug: string; resource: ResourceSummary }) {
  return (
    <Link
      to={`/t/${slug}/library/${resource.id}`}
      className='rp-card rp-lift rp-focus group flex w-64 shrink-0 flex-col overflow-hidden sm:w-72'
    >
      {
        /* A 4:3 grey ground with the document peeking up from behind it: inset at
        * the sides, dropped from the top, and running past the bottom edge so the
        * page reads as a real document tucked into the card. */
      }
      <div className='relative aspect-[4/3] w-full overflow-hidden bg-surface-2'>
        <div className='rp-shadow-sm absolute inset-x-6 bottom-0 top-6 overflow-hidden bg-surface'>
          <ResourceThumb
            slug={slug}
            id={resource.id}
            type={resource.type}
            className='rp-zoom'
            imgClassName='object-top'
          />
        </div>
        <span className='absolute left-2 top-2'>
          <TypeBadge type={resource.type} />
        </span>
      </div>
      <div className='flex flex-1 flex-col gap-1.5 border-t border-line p-3.5'>
        <h3 className='rp-clamp-2 text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em] text-ink'>
          {resource.title}
        </h3>
        {resource.summary && resource.summary !== resource.title
          ? <p className='rp-clamp-3 text-sm leading-relaxed text-ink-3'>{resource.summary}</p>
          : null}
        {resource.sourceName
          ? (
            <p className='mt-auto truncate pt-1 text-[11px] tabular-nums text-ink-3/80'>
              {resource.sourceName}
            </p>
          )
          : null}
      </div>
    </Link>
  )
}

function SectionHeading(
  { slug, topicId, label, count }: { slug: string; topicId: string; label: string; count: number },
) {
  return (
    <div className='flex items-center gap-2.5'>
      {
        /* `min-w-0` is load-bearing: without it the heading's automatic minimum
         * size is its longest word, and since the badge is `nowrap` and the
         * "See all" link is `shrink-0`, a narrow viewport (or a phone with the
         * system font scaled up) could not compress this row - it pushed past
         * the right edge and scrolled the whole page sideways. `break-words`
         * covers the remaining case of a single topic label longer than the
         * column it is left with. */
      }
      <h2 className='rp-display min-w-0 break-words text-xl text-ink sm:text-[1.375rem]'>
        {label}
      </h2>
      <span className='rp-badge rp-badge-quiet shrink-0 tabular-nums'>{count}</span>
      <span className='h-px flex-1 bg-[var(--rp-line)]' aria-hidden='true' />
      {
        /* `py-3 -my-3` grows the hit area to 44px tall without moving anything:
         * the link's own text box is only 20px, too small to hit reliably on a
         * phone, and the negative margin keeps its outer size unchanged so the
         * heading row's height is still set by the heading. */
      }
      <Link
        to={`/t/${slug}/library?topic=${encodeURIComponent(topicId)}`}
        className='rp-focus -my-3 shrink-0 rounded-[var(--rp-radius-btn)] py-3 text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
      >
        See all<span aria-hidden='true'>&rarr;</span>
      </Link>
    </div>
  )
}

function TopicRowSkeleton() {
  return (
    <div>
      <Skeleton className='h-6 w-56' />
      {
        /* The placeholder cards are `shrink-0` and four of them are far wider
         * than a phone, so with the row's overflow left visible this skeleton
         * used to stretch the document to ~1084px and scroll the whole page
         * sideways for as long as the topics were loading. It clips instead,
         * and takes the same full-width mobile track as the real row so the
         * swap from skeleton to content does not shift. */
      }
      <div className='-mx-[1.5rem] mt-4 flex gap-3 overflow-hidden px-[1.5rem] sm:mx-0 sm:px-0'>
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className='rp-card w-64 shrink-0 overflow-hidden sm:w-72'
          >
            <div className='rp-shimmer bg-surface-3 aspect-[4/3] w-full' aria-hidden='true' />
            <div className='space-y-2 border-t border-line p-3.5'>
              <Skeleton className='h-4 w-4/5' />
              <Skeleton className='h-3 w-full' />
              <Skeleton className='h-3 w-2/3' />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Resources shown per topic row - a horizontal scroll row's worth. */
const TOPIC_ROW_LIMIT = 12

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export function ExplorePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const navigate = useNavigate()

  // The box's real classification index, not per-resource topicIds (the DA
  // classifier's labels don't reliably land in a listed resource's own
  // usermetadata - see the provider's `topicResources` doc comment). Facet
  // counts say which topics are non-empty; each non-empty topic's row is
  // then fetched from the same index via `topicResources`.
  const {
    data: facets,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['topic-facets', config.slug],
    queryFn: () => getFacets(config.slug, ['topic']),
  })

  const nonEmptyTopics = useMemo(
    () => topicsWithFacetCounts(config.topics, facets ?? {}),
    [facets, config.topics],
  )

  const topicRowQueries = useQueries({
    queries: nonEmptyTopics.map(({ topic }) => ({
      queryKey: ['topic-resources', config.slug, topic.id],
      queryFn: () => getTopicResources(config.slug, topic.id, TOPIC_ROW_LIMIT),
      staleTime: 5 * 60 * 1000,
    })),
  })

  // The hero asks rather than searches - Search no longer answers questions,
  // so a question the reader types (or picks from the suggestions) goes
  // straight to Ask with the question pre-filled and auto-sent.
  const ask = useCallback(
    (text: string) => navigate(`/t/${config.slug}/ask?ask=${encodeURIComponent(text)}`),
    [navigate, config.slug],
  )

  // Genuinely empty only when the box's classification index has zero topic
  // facets - never because a per-resource topicIds field came back empty.
  const hasRows = nonEmptyTopics.length > 0

  return (
    <main>
      <Hero config={config} onAsk={ask} />

      <QuickEntry slug={config.slug} />

      <RegionBand slug={config.slug} />

      <section className='rp-shell space-y-10 pb-16 pt-12'>
        {isError
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load resources.'}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {isLoading
          ? (
            <>
              <TopicRowSkeleton />
              <TopicRowSkeleton />
            </>
          )
          : null}

        {!isLoading && !isError && !hasRows
          ? (
            <EmptyState
              title='Nothing to browse yet'
              description='This portal has no resources filed against its topics. Add content in the management screen, or run a corpus analysis to build the taxonomy.'
            >
              <Link to={`/t/${config.slug}/library`} className='rp-btn rp-btn-primary'>
                Open the library
              </Link>
            </EmptyState>
          )
          : null}

        {!isLoading && !isError
          ? nonEmptyTopics.map(({ topic, count }, index) => {
            const rowQuery = topicRowQueries[index]
            if (rowQuery?.isLoading) return <TopicRowSkeleton key={topic.id} />
            // A row's own fetch failing, or resolving empty (e.g. every
            // matching resource is hidden/junk), quietly drops that one row
            // rather than mislabelling the whole portal empty.
            const items = rowQuery?.data
            if (!items || items.length === 0) return null

            return (
              <div key={topic.id}>
                <SectionHeading
                  slug={config.slug}
                  topicId={topic.id}
                  label={topic.label}
                  count={count}
                />
                {
                  /* On a phone the track spans the whole viewport rather than
                   * stopping at the shell's gutter, so cards pass under both
                   * screen edges as the row scrolls instead of being sliced off
                   * against an invisible margin 1.5rem in. The negative margin
                   * releases the track; the equal padding inside it supplies
                   * the resting inset, so at scroll 0 the first card still sits
                   * on the 1.5rem gutter, in line with the heading above it,
                   * and the last card keeps the same clearance at the far end.
                   *
                   * The 1.5rem is written out rather than taken from the
                   * spacing scale on purpose. `rp-shell`'s gutter is a fixed
                   * 1.5rem, but Tailwind's spacing utilities resolve against
                   * `--spacing`, which the tenant density dial scales - a
                   * `comfortable` or `spacious` portal would give this track a
                   * negative margin wider than the gutter it is cancelling and
                   * push the whole page sideways.
                   *
                   * `scroll-pl` matches the padding so snapping and any
                   * scroll-into-view (keyboard focus, for one) come to rest on
                   * the visual gutter rather than against the screen edge. */
                }
                <div className='rp-scroll-row rp-no-scrollbar -mx-[1.5rem] mt-3.5 flex gap-3 overflow-x-auto scroll-pl-[1.5rem] px-[1.5rem] pb-4 pt-1 sm:mx-0 sm:scroll-pl-0 sm:px-0'>
                  {items.map((resource) => (
                    <ResourceCard key={resource.id} slug={config.slug} resource={resource} />
                  ))}
                </div>
              </div>
            )
          })
          : null}
      </section>
    </main>
  )
}
