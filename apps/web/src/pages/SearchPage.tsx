import {
  FederatedSearchStatus,
  PartnerSearchSwitch,
  PeerSearchResult,
  SearchSourceBadge,
  SearchSourceFacet,
} from '../components/FederatedSearch.tsx'
import { ResourceProvenanceLabel } from '../components/ResourceProvenanceLabel.tsx'
import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { StaleAuthorityError } from '../api/access-lifecycle.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import {
  offersAgentAsk,
  participatesInFederation,
  type RetrievalMode,
  type ScoredResource,
} from '@research-portal/core'
import {
  addWatch,
  deleteWatch,
  getFacets,
  listWatches,
  markWatchSeen,
  type SavedWatch,
  searchTenantFull,
  summarizeResources,
} from '../api/client.ts'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { GridDensity, ViewToggle } from '../components/ViewControls.tsx'
import { useViewMode } from '../components/useViewMode.ts'
import {
  DEFAULT_SORT,
  LibraryBrowser,
  SORT_OPTIONS,
  SORT_VALUES,
  type SortValue,
} from './LibraryPage.tsx'
import { Button, IconButton, sameLabel, typeLabel } from '../components/ui.tsx'
import { plainDashes, presentTitle } from '../lib/display-title.ts'
import { SaveEvidenceButton } from '../components/SaveEvidence.tsx'
import { SearchAnswer, type SearchAnswerResult } from '../components/SearchAnswer.tsx'
import { EmptyState, ErrorCard, prettyLabel, Skeleton } from '../components/ui.tsx'
import { answerModeParam, readAnswerMode } from '../lib/search-mode.ts'
import { RouteChip } from '../components/RouteChip.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'
import {
  passageIsInformative,
  passageIsQuotable,
  passageRepeatsSummary,
  scrubSnippetBoilerplate,
} from '../lib/passage.ts'
import { Byline, bylineFor } from '../components/Byline.tsx'
import {
  ArrowRight,
  Check,
  Copy,
  EyeOff,
  SlidersHorizontal,
  Trash,
  X,
} from '../components/icons.tsx'

/**
 * An author lookup's heading counts articles and their attachments apart:
 * "42 articles · 24 supplements" for a person with 42 papers, never "66
 * resources" (D4-16). Filed format first, the title's shape otherwise.
 */
function isAttachment(resource: { title: string; format?: string }): boolean {
  if (resource.format) return resource.format !== 'article'
  return /^(?:supplementary|supplement\b|peer review|video|movie|media|additional file|appendix)/i
    .test(resource.title)
}

export function authorCount(
  resources: readonly { title: string; format?: string }[],
  ui: ResearchUi = englishResearchUi,
): string {
  const attachments = resources.filter(isAttachment).length
  const articles = resources.length - attachments
  const parts = [ui(articles === 1 ? '{count} article' : '{count} articles', { count: articles })]
  if (attachments > 0) {
    parts.push(
      ui(attachments === 1 ? '{count} supplement' : '{count} supplements', { count: attachments }),
    )
  }
  return parts.join(' · ')
}

const MODES: { value: RetrievalMode; label: string }[] = [
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'keyword', label: 'Keyword' },
]

/** Relevance below this is flagged as a weak match rather than hidden - honesty over false confidence. */
const WEAK_MATCH_THRESHOLD = 0.35
/** Threshold for the "Strong" match-strength filter. */
const STRONG_MATCH_THRESHOLD = 0.6

type MatchStrength = 'all' | 'strong'

const STRENGTH_OPTIONS: { value: MatchStrength; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'strong', label: 'Strong (60%+)' },
]

function RelevanceMeter(
  { relevance, referenceChunk }: { relevance: number; referenceChunk?: boolean },
) {
  const { ui } = usePortalLocale()
  const percent = Math.round(relevance * 100)
  const weak = relevance < WEAK_MATCH_THRESHOLD

  return (
    <div className='flex shrink-0 items-center gap-2'>
      {referenceChunk ? <span className='text-2xs text-ink-3'>{ui('reference list')}</span> : null}
      {weak ? <span className='text-2xs text-ink-3'>{ui('weak match')}</span> : null}
      <div
        className='h-1 w-20 overflow-hidden rounded-[var(--rp-radius)] bg-surface-3'
        role='progressbar'
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ui('Relevance')}
      >
        <div
          className='h-full'
          style={{ width: `${percent}%`, backgroundColor: 'var(--rp-accent-line)' }}
        />
      </div>
      <span className='text-xs font-medium tabular-nums text-ink-3'>{percent}%</span>
    </div>
  )
}

/** Deep link into the reader, carrying the matched passage and (for PDFs) the page it sits on. */
function resourceLink(slug: string, resource: ScoredResource): string {
  const params = new URLSearchParams()
  if (resource.matchedField === 'summary') {
    // Generated text is not in the document, so there is nothing to
    // highlight; the reader says so rather than landing on page one.
    params.set('matched', 'summary')
  } else if (resource.matchedField !== 'metadata') {
    // A byline matched by an author or identifier lookup is not in the
    // document either; the reader opens at page one.
    if (resource.matchedPassage) params.set('passage', resource.matchedPassage.slice(0, 300))
    if (resource.matchedPage) params.set('page', String(resource.matchedPage))
  }
  const query = params.toString()
  return `/t/${slug}/library/${resource.id}${query ? `?${query}` : ''}`
}

/**
 * One result. The matched passage is the point of the card - it is the citation
 * in context, which is what keeps this list readable on its own when someone
 * switches the AI answer off.
 */
function ResultCard(
  { resource, slug, query, kindLabel, citedIndex, lookup = false }: {
    resource: ScoredResource
    slug: string
    query: string
    kindLabel: (id: string) => string
    /** Lowest `[n]` marker the AI answer cites this resource under, when it is cited at all. */
    citedIndex?: number
    /** True when the list is an exact author or identifier lookup rather than a retrieval. */
    lookup?: boolean
  },
) {
  const { ui } = usePortalLocale()
  const keyFacts = resource.keyFacts.slice(0, 3)
  const byline = bylineFor(resource, ui)
  const title = presentTitle(resource.title)
  const summary = resource.summary ? plainDashes(resource.summary) : ''
  const snippet = resource.matchedPassage ? scrubSnippetBoilerplate(resource.matchedPassage) : ''
  // A reference-list, front-matter or DOI-fragment match is flagged by the
  // API and labelled on the meter; quoting it would only show the reader a
  // bibliography line, and an author or identifier lookup's "passage" is the
  // byline or wherever the surname appears - an author-contribution
  // statement, a declaration (D2-20). A snippet that merely repeats the title
  // or the summary is noise of a different kind.
  const showSnippet = snippet.length > 0 &&
    passageIsQuotable(resource, lookup) &&
    passageIsInformative(snippet, query) &&
    !passageRepeatsSummary(snippet, resource.title) &&
    !(resource.summary && passageRepeatsSummary(snippet, resource.summary))

  return (
    <article id={`result-${resource.id}`} className='rp-card scroll-mt-6 p-4 sm:p-5'>
      <div className='flex gap-4'>
        <div className='hidden aspect-[210/297] w-[4.5rem] shrink-0 self-start overflow-hidden rounded-[var(--rp-radius)] border border-line sm:block'>
          <ResourceThumb slug={slug} id={resource.id} type={resource.type} />
        </div>

        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
              <SearchSourceBadge resource={resource} />
              <ResourceProvenanceLabel resourceId={resource.id} />
              <span className='rp-tag'>{typeLabel(resource.type, ui)}</span>
              {
                /* The kind chip is dropped when it only restates the type badge
                * (a `document` typed "Report" filed under kind "report"). */
              }
              {resource.kind && !sameLabel(kindLabel(resource.kind), typeLabel(resource.type, ui))
                ? <span className='rp-tag'>{kindLabel(resource.kind)}</span>
                : null}
              {citedIndex !== undefined
                ? (
                  <span
                    className='rp-badge font-semibold text-[var(--rp-on-accent)]'
                    style={{ backgroundColor: 'var(--rp-accent)', borderColor: 'var(--rp-accent)' }}
                  >
                    {ui('Cited [{index}]', { index: citedIndex ?? '' })}
                  </span>
                )
                : null}
            </div>
            <RelevanceMeter
              relevance={resource.relevance}
              referenceChunk={resource.referenceChunk}
            />
          </div>

          <h3 className='mt-2.5 text-base font-semibold tracking-[-0.01em] text-ink'>
            <Link
              to={resourceLink(slug, resource)}
              className='rp-focus inline-block min-h-6 rounded-[var(--rp-radius-btn)] max-lg:min-h-11'
            >
              <span className='rp-clamp-2'>{title}</span>
            </Link>
          </h3>
          {byline
            ? (
              <Byline
                parts={[byline.join('\u00a0·\u00a0')]}
                doi={resource.doi}
                className='rp-library-result-byline'
              />
            )
            : null}
          {resource.sourceName && !byline
            ? (
              <p className='mt-0.5 truncate text-2xs tabular-nums text-ink-3'>
                {resource.sourceName}
              </p>
            )
            : null}
          {summary && summary !== resource.title
            ? <p className='rp-clamp-3 mt-1.5 text-sm leading-relaxed text-ink-2'>{summary}</p>
            : null}

          {showSnippet
            ? (
              <blockquote className='break-words mt-3 text-sm leading-relaxed text-ink-2'>
                &ldquo;{snippet.length > 340
                  ? `${snippet.slice(0, 340).replace(/\s\S*$/, '')}…`
                  : snippet}&rdquo;
              </blockquote>
            )
            : null}

          {keyFacts.length > 0
            ? (
              <div className='mt-3.5'>
                <p className='rp-eyebrow text-ink-3'>{ui('Key facts')}</p>
                <ol className='mt-1.5 space-y-1'>
                  {keyFacts.map((fact, index) => (
                    <li key={index} className='flex gap-2 text-sm text-ink-2'>
                      <span className='font-medium tabular-nums text-ink-3'>{index + 1}.</span>
                      <span>{fact}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )
            : null}

          <div className='mt-3 flex justify-end'>
            <SaveEvidenceButton
              slug={slug}
              compact
              evidence={{
                passage: resource.matchedPassage || resource.title,
                ...(resource.matchedPassage && resource.matchedPage
                  ? { page: resource.matchedPage }
                  : {}),
                resourceId: resource.id,
                resourceTitle: resource.title,
                score: resource.relevance,
                question: query,
              }}
            />
          </div>
        </div>
      </div>
    </article>
  )
}

function ResultCardSkeleton() {
  return (
    <div className='rp-card p-4 sm:p-5'>
      <div className='flex items-center justify-between'>
        <Skeleton className='h-5 w-16' />
        <Skeleton className='h-4 w-24' />
      </div>
      <Skeleton className='mt-3.5 h-5 w-3/4' />
      <Skeleton className='mt-2 h-4 w-full' />
      <Skeleton className='mt-1 h-4 w-5/6' />
    </div>
  )
}

/**
 * Multi-document summary overlay - reading state, the synthesised summary,
 * the source titles it drew from, and a copy action. Shared shape with the
 * one on LibraryPage; kept as a local component since the two pages don't
 * share a components file.
 */
function SummaryModal({
  loading,
  error,
  summary,
  titles,
  onClose,
  onRetry,
}: {
  loading: boolean
  error: string | null
  summary: string
  titles: string[]
  onClose: () => void
  onRetry: () => void
}) {
  const { ui } = usePortalLocale()
  const [copied, setCopied] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // Move focus into the dialog on open, and give it back to whatever
  // triggered it once the dialog closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      previouslyFocused?.focus()
    }
  }, [])

  function copy() {
    navigator.clipboard.writeText(summary).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      // Clipboard access can be denied - the summary is still on screen to select by hand.
    })
  }

  return createPortal(
    <div
      className='rp-scrim rp-anim-fade fixed inset-0 z-[80] flex items-center justify-center p-4 backdrop-blur-sm'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role='dialog'
        aria-modal='true'
        aria-label={ui('Summary')}
        className='rp-card rp-shadow-xl flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden'
      >
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5'>
          <h2 className='text-lg font-semibold text-ink'>{ui('Summary')}</h2>
          <IconButton
            onClick={onClose}
            label={ui('Close')}
            icon={X}
          />
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
          {loading
            ? (
              <div>
                <p className='text-sm text-ink-2'>
                  {ui(
                    titles.length === 1
                      ? 'Reading {count} document…'
                      : 'Reading {count} documents…',
                    { count: titles.length },
                  )}
                </p>
                <div className='mt-3 space-y-2' aria-hidden='true'>
                  <div className='rp-shimmer bg-surface-3 h-3.5 w-full rounded-[var(--rp-radius)]' />
                  <div className='rp-shimmer bg-surface-3 h-3.5 w-full rounded-[var(--rp-radius)]' />
                  <div className='rp-shimmer bg-surface-3 h-3.5 w-5/6 rounded-[var(--rp-radius)]' />
                </div>
              </div>
            )
            : null}

          {!loading && error ? <ErrorCard message={error} onRetry={onRetry} /> : null}

          {!loading && !error
            ? (
              <p className='rp-measure rp-prose whitespace-pre-wrap text-sm text-ink-2'>
                {summary}
              </p>
            )
            : null}
        </div>

        {!loading && !error
          ? (
            <div className='shrink-0 border-t border-line px-5 py-3.5'>
              <p className='rp-eyebrow text-ink-3'>{ui('Sources')}</p>
              <ul className='mt-1.5 max-h-24 space-y-0.5 overflow-y-auto text-xs text-ink-3'>
                {titles.map((title, index) => <li key={index} className='truncate'>{title}</li>)}
              </ul>
              <div className='mt-3 flex justify-end'>
                <Button variant='outline' onClick={copy} leadingIcon={copied ? Check : Copy}>
                  {copied ? ui('Copied') : ui('Copy')}
                </Button>
              </div>
            </div>
          )
          : null}
      </div>
    </div>,
    document.body,
  )
}

/** Hook wiring for the multi-document summary overlay - shared by any caller with a resource list. */
function useResourceSummary(slug: string) {
  const access = useAccess()
  const authority = access.controller.context
  const current = () =>
    access.controller.context === authority &&
    access.controller.can('portal.generate', { kind: 'portal', slug })
  const abort = useRef<AbortController | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [titles, setTitles] = useState<string[]>([])
  const lastRequest = useRef<{ ids: string[]; kind: 'simple' | 'extended' } | null>(null)
  // A slower earlier request must never overwrite a newer one.
  const requestSeq = useRef(0)

  useEffect(() => () => {
    abort.current?.abort()
    requestSeq.current++
  }, [authority])

  const run = useCallback(
    (ids: string[], resourceTitles: string[], kind: 'simple' | 'extended' = 'simple') => {
      if (!current()) return
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      lastRequest.current = { ids, kind }
      const requestId = ++requestSeq.current
      setTitles(resourceTitles)
      setOpen(true)
      setLoading(true)
      setError(null)
      setSummary('')
      summarizeResources(slug, ids, kind, controller.signal)
        .then((res) => {
          if (requestId !== requestSeq.current || controller.signal.aborted || !current()) return
          setSummary(res.summary)
        })
        .catch((err) => {
          if (requestId !== requestSeq.current || controller.signal.aborted || !current()) return
          setError(err instanceof Error ? err.message : 'Could not generate a summary.')
        })
        .finally(() => {
          if (requestId !== requestSeq.current || controller.signal.aborted || !current()) return
          setLoading(false)
        })
    },
    [slug, authority],
  )

  const retry = useCallback(() => {
    if (!lastRequest.current) return
    run(lastRequest.current.ids, titles, lastRequest.current.kind)
  }, [run, titles])

  return {
    open,
    loading,
    error,
    summary,
    titles,
    run,
    retry,
    close: () => {
      abort.current?.abort()
      requestSeq.current++
      setOpen(false)
    },
  }
}

/** Quiet strip of saved searches - each chip re-runs the search and shows a changed dot when new results have arrived. */
function WatchStrip(
  { watches, onRun, onDelete, canWatch }: {
    watches: SavedWatch[]
    onRun: (watch: SavedWatch) => void
    onDelete: (id: string) => void
    canWatch: boolean
  },
) {
  const { ui } = usePortalLocale()
  if (watches.length === 0) return null

  return (
    <div className='mb-4 flex flex-wrap items-center gap-1.5'>
      <span className='rp-eyebrow shrink-0 text-ink-3'>{ui('Watches')}</span>
      {watches.map((watch) => (
        <div
          key={watch.id}
          className='inline-flex items-center gap-0.5 rounded-[var(--rp-radius)] border border-line bg-surface py-0.5 pl-1 pr-0.5'
        >
          <button
            type='button'
            onClick={() => onRun(watch)}
            className='rp-focus flex min-h-11 items-center gap-1.5 rounded-[var(--rp-radius-btn)] px-1.5 py-1 text-xs text-ink-2 transition-colors duration-150 hover:text-[var(--rp-ink)]'
          >
            {watch.changed
              ? (
                <>
                  <span
                    role='status'
                    className='h-1.5 w-1.5 shrink-0 rounded-full'
                    style={{ backgroundColor: 'var(--rp-accent-line)' }}
                    aria-label={ui('New results')}
                  />
                  <span className='sr-only'>{ui('has new results')}</span>
                </>
              )
              : null}
            <span className='max-w-[12rem] truncate'>{watch.query}</span>
          </button>
          {canWatch
            ? (
              <IconButton
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete(watch.id)
                }}
                label={ui('Remove saved search "{value1}"', { value1: watch.query })}
                icon={Trash}
                variant='danger'
                size='sm'
              />
            )
            : null}
        </div>
      ))}
    </div>
  )
}

export function SearchPage() {
  const { ui } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const access = useAccess()
  const authority = access.controller.context
  const permits = (permission: 'portal.watch' | 'portal.generate' | 'portal.read') =>
    access.controller.context === authority &&
    access.controller.can(permission, { kind: 'portal', slug: config.slug })
  const canWatch = permits('portal.watch')
  const canGenerate = permits('portal.generate')
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const offersPartners = offersAgentAsk(config) && participatesInFederation(config) &&
    (config.federation?.peers?.length ?? 0) > 0
  const federated = offersPartners && searchParams.get('federated') === '1'
  const selectedSource = federated ? searchParams.get('source') ?? '' : ''
  const mode: RetrievalMode = (() => {
    const raw = searchParams.get('mode')
    return raw === 'semantic' || raw === 'keyword' ? raw : 'hybrid'
  })()
  const selectedTopics = useMemo(() => {
    const raw = searchParams.get('topics')
    return raw ? raw.split(',').filter((id) => id.length > 0) : []
  }, [searchParams])
  const selectedKinds = useMemo(() => {
    const raw = searchParams.get('kinds')
    return raw ? raw.split(',').filter((id) => id.length > 0) : []
  }, [searchParams])
  const strength: MatchStrength = searchParams.get('strength') === 'strong' ? 'strong' : 'all'
  // ANSWERED (results + streamed cited answer) vs RESULTS ONLY. Held in the URL
  // so both are shareable and reload to the same state. Answered is the default -
  // a search with a query gets its cited answer with no extra click - and
  // `answer=0` is the explicit, shareable opt-out.
  const answerModeParamValue = readAnswerMode(searchParams)
  const intents = config.intents ?? []

  // Open by default on the desktop layout, where the rail sits beside the
  // results; closed on a phone, where it would otherwise stack two full facet
  // lists above the first result. The Filters button toggles it either way.
  const [filtersOpen, setFiltersOpen] = useState(
    () => typeof matchMedia !== 'function' || matchMedia('(min-width: 1024px)').matches,
  )
  // The no-query state is the library listing, so its controls belong in the
  // same row as the retrieval modes rather than floating above the grid.
  const [librarySort, setLibrarySort] = useState<SortValue>(DEFAULT_SORT)
  const [libraryDensity, setLibraryDensity] = useState(4)
  // The listing here is the same listing the library route renders, so it takes
  // the same viewport-derived default: a phone opens in list, a desktop in grid,
  // and the toggle below overrides either from the first click on.
  const { view: libraryView, setView: setLibraryView } = useViewMode()

  // What the search field is showing. The URL stays the one source of truth for
  // the query - `q` above is what is searched, shared and navigated back to -
  // and this holds only the keystrokes since the last commit, which have to live
  // somewhere until Enter. Re-seeded during render whenever `q` moves, so the
  // back button, a saved-watch chip and a suggested question all put their
  // query in the box; an effect would do the same a paint later, with the old
  // text visible in between.
  const [draft, setDraft] = useState(q)
  const [draftSeed, setDraftSeed] = useState(q)
  if (draftSeed !== q) {
    setDraftSeed(q)
    setDraft(q)
  }

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value.length === 0) next.delete(key)
          else next.set(key, value)
        }
        return next
      })
    },
    [setSearchParams],
  )

  function toggleTopic(id: string) {
    const set = new Set(selectedTopics)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    updateParams({ topics: Array.from(set).join(',') || null })
  }

  function toggleKind(id: string) {
    const set = new Set(selectedKinds)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    updateParams({ kinds: Array.from(set).join(',') || null })
  }

  function setStrength(next: MatchStrength) {
    updateParams({ strength: next === 'all' ? null : next })
  }

  const topicLabel = (id: string) => config.topics.find((topic) => topic.id === id)?.label ?? id
  const kindLabel = (id: string) => prettyLabel(id, config.branding.organisation, ui)

  // The same aggregation, under the same query key, as the Library rail.
  const { data: facets } = useQuery({
    queryKey: ['facets', config.slug],
    queryFn: () => getFacets(config.slug),
  })
  const topicCounts = facets?.topic ?? {}
  const kindCounts = facets?.kind ?? {}
  const kindIds = useMemo(() => Object.keys(kindCounts).sort(), [kindCounts])

  // The results never wait on routing: the server applies the rule stage
  // itself (an identifier, a gene symbol, an author surname is an exact
  // lookup decided in microseconds) and returns the decision with the
  // results, so the chip and the list arrive together and no classifier
  // call stands between the reader and the list.
  const {
    data: results,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      'search',
      config.slug,
      q,
      mode,
      selectedTopics.join(','),
      selectedKinds.join(','),
      federated,
    ],
    queryFn: () =>
      searchTenantFull(config.slug, q, {
        mode,
        topicIds: selectedTopics,
        kindIds: selectedKinds,
        federated,
      }),
    enabled: q.trim().length > 0,
  })
  const route = results?.route
  const routedIntent = route ? intents.find((i) => i.id === route.intent) : undefined
  // An exact lookup (an identifier, a term, an author) lists the documents
  // and generates nothing: an author search is a bibliography, not a
  // question, and a generated paragraph about a name reads as a profile
  // nobody asked for.
  // A person's name the collection does not hold is still a name: nothing
  // is generated about it either (D3-04).
  const lookupOnly =
    (routedIntent !== undefined && !routedIntent.answer.surfaces.includes('ask')) ||
    results?.lookup?.matched === true ||
    results?.lookup?.kind === 'author'
  const unmatchedAuthor = results?.lookup?.kind === 'author' && !results.lookup.matched &&
    results.resources.length > 0
  const answerMode = answerModeParamValue && !lookupOnly

  // Match strength is not a server filter - the search API only accepts topicIds - so
  // this narrows the already-fetched, calibrated results client-side.
  const filteredResults = useMemo(() => {
    if (!results) return []
    if (federated) {
      return results.resources.filter((r) => !selectedSource || r.source?.id === selectedSource)
    }
    if (strength !== 'strong') return results.resources
    return results.resources.filter((r) => r.relevance >= STRONG_MATCH_THRESHOLD)
  }, [results, strength, federated, selectedSource])

  // The AI Answer panel's citations/sources, reported up so the results list
  // can badge cited cards and power the Resources/Citations toggle. Reset to
  // 'resources' whenever the query changes - a fresh answer has no citations
  // yet, so a lingering Citations view would just show an empty state.
  const [answer, setAnswer] = useState<SearchAnswerResult>({ citations: [], sources: [] })
  const [resultView, setResultView] = useState<'resources' | 'citations'>('resources')
  useEffect(() => {
    setResultView('resources')
  }, [q])

  // Results-only mode has no answer: SearchAnswer is unmounted, so clear any
  // citations it left behind (they would otherwise linger as "Cited" badges) and
  // drop the Citations view, which only makes sense alongside an answer.
  useEffect(() => {
    if (!answerMode) {
      setAnswer({ citations: [], sources: [] })
      setResultView('resources')
    }
  }, [answerMode])

  // Lowest `[n]` marker each cited resource id appears under - used both for
  // the "Cited [n]" badge and to order the Citations view the same way the
  // markers read in the answer above.
  const citationIndexByResource = useMemo(() => {
    const map = new Map<string, number>()
    for (const citation of answer.citations) {
      const existing = map.get(citation.resourceId)
      if (existing === undefined || citation.index < existing) {
        map.set(citation.resourceId, citation.index)
      }
    }
    return map
  }, [answer.citations])

  // Only resources the answer cited AND that are still in the current
  // (filtered) result set - a citation to a resource this filter excludes
  // simply does not appear here, consistent with every other client-side
  // filter on this page.
  const citedResults = useMemo(
    () =>
      filteredResults
        .filter((resource) => citationIndexByResource.has(resource.id))
        .sort((a, b) => citationIndexByResource.get(a.id)! - citationIndexByResource.get(b.id)!),
    [filteredResults, citationIndexByResource],
  )

  const activeFilters = useMemo(() => {
    if (federated) {
      return selectedSource
        ? [{
          key: 'source',
          label: results?.sources?.find((source) => source.id === selectedSource)?.label ??
            selectedSource,
          onRemove: () => updateParams({ source: null }),
        }]
        : []
    }
    const chips: { key: string; label: string; onRemove: () => void }[] = selectedTopics.map(
      (id) => ({
        key: `topic-${id}`,
        label: topicLabel(id),
        onRemove: () => toggleTopic(id),
      }),
    )
    for (const id of selectedKinds) {
      chips.push({
        key: `kind-${id}`,
        label: kindLabel(id),
        onRemove: () => toggleKind(id),
      })
    }
    if (strength === 'strong') {
      chips.push({
        key: 'strength',
        label: ui('Strong matches only'),
        onRemove: () => setStrength('all'),
      })
    }
    return chips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedTopics,
    selectedKinds,
    strength,
    config.topics,
    config.branding.organisation,
    federated,
    selectedSource,
    results,
  ])

  // Run a search. `withAnswer` picks the intent: true for the
  // default answered search (results + streamed cited answer), false for the
  // results-only opt-out, which fires no LLM call.
  function runSearch(text: string, withAnswer: boolean) {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    updateParams({ q: trimmed, answer: answerModeParam(withAnswer) })
  }

  // Enter and the primary button run the search in whatever answer state the
  // page is already in - answered by default, results-only once the user has
  // opted out - so refining a query never flips the mode under them.

  // Suggested and "people also ask" chips are phrased as questions, so their
  // payoff is the synthesised answer - they always run answered, which is also
  // a way back for someone who had switched to results only.
  function askQuestion(text: string) {
    runSearch(text, true)
  }

  // What the search field's Enter does. Emptying the box and committing it is a
  // meaningful thing to ask for - it is how the reader gets back out of a search
  // to the browse listing - so it drops `q` rather than being swallowed by
  // runSearch's guard and leaving an empty box above someone else's results.
  function submitQuery(text: string) {
    if (text.trim().length === 0) updateParams({ q: null })
    else runSearch(text, answerMode)
  }

  const hasQuery = q.trim().length > 0
  const trimmedQuery = q.trim()

  const queryClient = useQueryClient()
  const { data: watches } = useQuery({
    queryKey: ['watches', config.slug],
    queryFn: () => listWatches(config.slug),
  })
  const invalidateWatches = () => {
    if (permits('portal.watch')) {
      void queryClient.invalidateQueries({ queryKey: ['watches', config.slug] })
    }
  }
  const checkWatch = () => {
    if (!permits('portal.watch')) throw new StaleAuthorityError()
  }
  const addWatchMutation = useMutation({
    mutationFn: () => {
      checkWatch()
      return addWatch(config.slug, trimmedQuery)
    },
    onSuccess: invalidateWatches,
  })
  const deleteWatchMutation = useMutation({
    mutationFn: (id: string) => {
      checkWatch()
      return deleteWatch(config.slug, id)
    },
    onSuccess: invalidateWatches,
  })
  const markSeenMutation = useMutation({
    mutationFn: (id: string) => {
      checkWatch()
      return markWatchSeen(config.slug, id)
    },
    onSuccess: invalidateWatches,
  })
  const isWatchingCurrent = hasQuery &&
    (watches ?? []).some((watch) => watch.query.trim() === trimmedQuery)

  function runWatch(watch: SavedWatch) {
    updateParams({ q: watch.query })
    if (permits('portal.watch')) markSeenMutation.mutate(watch.id)
  }

  const summaryModal = useResourceSummary(config.slug)

  function summariseResults() {
    if (!permits('portal.generate') || filteredResults.length === 0) return
    const top = filteredResults.slice(0, 10)
    summaryModal.run(top.map((r) => r.id), top.map((r) => r.title))
  }

  return (
    <main className='rp-shell py-8 lg:py-10'>
      {
        /* Heading, then the field, then the controls - the library's shape, so
        * the two listing pages read as one product. The heading is "Search"
        * rather than the query itself: the query is right below it in a box the
        * reader can edit, and a heading that repeated it would say the same
        * thing twice while breaking the parallel with "Library" next door. The
        * count rides on the heading line the way the library's total does. */
      }
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h1 className='rp-display text-2xl text-ink sm:text-3xl'>{ui('Search')}</h1>
        {hasQuery && !isLoading && !isError && results
          ? (
            <p className='text-sm font-medium tabular-nums text-ink-3'>
              {results.lookup?.kind === 'author' && results.lookup.matched
                ? authorCount(filteredResults, ui)
                : ui(filteredResults.length === 1 ? '{count} resource' : '{count} resources', {
                  count: filteredResults.length,
                })}
              {answerMode && citedResults.length > 0
                ? ui(' · {value1} cited', { value1: citedResults.length })
                : ''}
            </p>
          )
          : null}
      </div>

      <div className='mt-4 flex flex-wrap items-center gap-2.5'>
        {
          /* Pre-filled with the query the URL carries, so the page opens saying
          * what was asked. Enter commits the draft back to the URL, which is
          * what re-runs the search - one source of truth, and a refined search
          * is still a shareable link the back button walks. */
        }
        <SearchField
          id='search-query'
          label={ui('Search {value1}', { value1: config.branding.productName })}
          value={draft}
          onChange={setDraft}
          onSubmit={submitQuery}
          placeholder={config.searchPlaceholder}
          className='min-w-[min(16rem,100%)] flex-1'
        />

        <div
          className={federated ? 'hidden' : 'rp-seg'}
          role='group'
          aria-label={ui('Retrieval mode')}
        >
          {!federated && MODES.map((option) => {
            const active = mode === option.value
            return (
              <button
                key={option.value}
                type='button'
                aria-pressed={active}
                onClick={() =>
                  updateParams({ mode: option.value === 'hybrid' ? null : option.value })}
                className='rp-seg-item rp-btn-sm min-w-[2.75rem]'
              >
                {ui(option.label)}
              </button>
            )
          })}
        </div>

        {
          /* No `lg:hidden` here, unlike the library's: this page's facet rail is
          * collapsible at every width, so the button has work to do on a desktop
          * too. (The class was on it and inert - .rp-chip sets its own display
          * and beat the utility - so dropping it changes nothing but the lie.) */
        }
        {offersPartners
          ? (
            <PartnerSearchSwitch
              checked={federated}
              onChange={(checked) => {
                updateParams({ federated: checked ? '1' : null, source: null })
                setResultView('resources')
              }}
            />
          )
          : null}

        <Button
          variant='outline'
          size='sm'
          leadingIcon={SlidersHorizontal}
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
        >
          {ui('Filters')}
          {activeFilters.length > 0 ? ` (${activeFilters.length})` : ''}
        </Button>

        {
          /* The listing's own controls, in the no-query state. Right-aligned
          * only where the toolbar is genuinely one line: once the search field
          * makes the row wrap, `ml-auto` strands this cluster against the right
          * edge of its own line with a ragged gap beside it, so below `lg` it
          * just follows the chips. */
        }
        {!hasQuery
          ? (
            <div className='flex min-w-0 flex-wrap items-center gap-2 lg:ml-auto'>
              <ViewToggle value={libraryView} onChange={setLibraryView} />
              <GridDensity
                value={libraryDensity}
                onChange={setLibraryDensity}
                view={libraryView}
              />
              <label htmlFor='search-sort' className='text-xs font-medium text-ink-3'>
                {ui('Sort')}
              </label>
              <select
                id='search-sort'
                value={librarySort}
                onChange={(event) => setLibrarySort(event.target.value as SortValue)}
                className='rp-select min-w-0 max-w-full rounded-[var(--rp-radius-input)] border bg-surface px-2.5 py-1.5 text-xs text-ink'
              >
                {SORT_VALUES.map((value) => (
                  <option key={value} value={value}>{ui(SORT_OPTIONS[value].label)}</option>
                ))}
              </select>
            </div>
          )
          : null}

        {/* The answer opt-out, which used to live beside the removed search box. */}
        {hasQuery
          ? (
            <Button
              variant='outline'
              size='sm'
              leadingIcon={EyeOff}
              onClick={() => runSearch(q, !answerMode)}
              aria-pressed={!answerMode}
              title={answerMode
                ? ui('Hide the AI answer and show only the matching resources')
                : ui('Show a cited AI answer above the results again')}
              className={!answerMode ? 'rp-chip-active' : ''}
            >
              {ui('Results only')}
            </Button>
          )
          : null}

        {hasQuery
          ? (
            isWatchingCurrent
              ? (
                <span
                  className='rp-badge rp-badge-quiet'
                  title={ui(
                    'This search is in your Watches - it is re-checked daily and a dot appears in the strip when new results arrive.',
                  )}
                >
                  {ui('In your Watches')}
                </span>
              )
              : canWatch && !federated
              ? (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    if (permits('portal.watch')) addWatchMutation.mutate()
                  }}
                  disabled={addWatchMutation.isPending}
                  title={ui('Get notified here when new results appear for this search')}
                >
                  {addWatchMutation.isPending ? ui('Adding…') : ui('Add to Watches')}
                </Button>
              )
              : null
          )
          : null}
      </div>

      {hasQuery && federated
        ? (
          <FederatedSearchStatus
            results={results}
            loading={isLoading}
            count={filteredResults.length}
          />
        )
        : null}

      {hasQuery && intents.length > 0 && route
        ? (
          <div className='mt-4 flex flex-wrap items-center gap-3'>
            <RouteChip decision={route} intents={intents} />
            {lookupOnly && !(results && results.resources.length === 0)
              ? (
                <Link
                  to={`/t/${config.slug}/ask?ask=${encodeURIComponent(q)}`}
                  className='rp-btn rp-btn-outline rp-btn-sm'
                >
                  {ui('Ask about these results')}
                  <ArrowRight size='sm' />
                </Link>
              )
              : null}
          </div>
        )
        : null}
      {unmatchedAuthor && results
        ? (
          <p className='mt-4 text-sm text-ink-2' role='status'>
            {ui(
              'No author named {name} is on this collection’s papers. These are the resources retrieval found for the name.',
              { name: results.lookup?.value ?? '' },
            )}
          </p>
        )
        : null}
      {
        /* The answer waits for the results (milliseconds for a lookup, about
        * a second otherwise) so a lookup never starts a generation it will
        * not show. */
      }
      {hasQuery && answerMode && (results !== undefined || isError)
        ? (
          <div className='mt-6'>
            {federated
              ? (
                <p className='mb-2 text-sm text-ink-3'>
                  {ui(
                    'The answer below uses {source}. Partner passages are included in the search results.',
                    { source: config.branding.productName },
                  )}
                </p>
              )
              : null}
            <SearchAnswer slug={config.slug} query={q} onResult={setAnswer} />
          </div>
        )
        : null}

      <div
        className={`mt-6 grid grid-cols-1 gap-6 ${
          filtersOpen ? 'lg:grid-cols-[17rem_minmax(0,1fr)]' : ''
        }`}
      >
        <aside className={filtersOpen ? 'block' : 'hidden'}>
          <div className='rp-card p-4 lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)]'>
            {federated
              ? (
                <SearchSourceFacet
                  results={results}
                  selected={selectedSource}
                  onChange={(source) => updateParams({ source: source || null })}
                />
              )
              : null}
            {!federated && config.topics.length > 0
              ? (
                <div>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='rp-eyebrow text-ink-3'>{ui('Topics')}</p>
                    {selectedTopics.length > 0
                      ? (
                        <button
                          type='button'
                          onClick={() => updateParams({ topics: null })}
                          className='rp-btn rp-btn-ghost rp-btn-sm'
                        >
                          {ui('Clear')}
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
                          className={`rp-check w-full px-1 py-1 text-sm ${
                            muted ? 'text-ink-3' : 'text-ink-2'
                          }`}
                        >
                          <input
                            type='checkbox'
                            checked={checked}
                            onChange={() => toggleTopic(topic.id)}
                            className='shrink-0 rounded-[var(--rp-radius-input)]'
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
                  </div>
                </div>
              )
              : null}

            {!federated && kindIds.length > 0
              ? (
                <div className={config.topics.length > 0 ? 'mt-5 border-t border-line pt-4' : ''}>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='rp-eyebrow text-ink-3'>{ui('Kind')}</p>
                    {selectedKinds.length > 0
                      ? (
                        <button
                          type='button'
                          onClick={() => updateParams({ kinds: null })}
                          className='rp-btn rp-btn-ghost rp-btn-sm'
                        >
                          {ui('Clear')}
                        </button>
                      )
                      : null}
                  </div>
                  <div className='mt-2.5 space-y-0.5'>
                    {kindIds.map((id) => {
                      const count = kindCounts[id] ?? 0
                      const checked = selectedKinds.includes(id)
                      const muted = count === 0 && !checked
                      return (
                        <label
                          key={id}
                          className={`rp-check w-full px-1 py-1 text-sm ${
                            muted ? 'text-ink-3' : 'text-ink-2'
                          }`}
                        >
                          <input
                            type='checkbox'
                            checked={checked}
                            onChange={() => toggleKind(id)}
                            className='shrink-0 rounded-[var(--rp-radius-input)]'
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

            {!federated
              ? (
                <div
                  className={(config.topics.length > 0 || kindIds.length > 0)
                    ? 'mt-5 border-t border-line pt-4'
                    : ''}
                >
                  <p className='rp-eyebrow text-ink-3'>{ui('Match strength')}</p>
                  <div
                    className='rp-seg mt-2.5'
                    role='group'
                    aria-label={ui('Match strength')}
                  >
                    {STRENGTH_OPTIONS.map((option) => {
                      const active = strength === option.value
                      return (
                        <button
                          key={option.value}
                          type='button'
                          aria-pressed={active}
                          onClick={() => setStrength(option.value)}
                          className='rp-seg-item rp-btn-sm min-w-[2.75rem]'
                        >
                          {ui(option.label)}
                        </button>
                      )
                    })}
                  </div>
                  <p className='mt-1.5 text-xs text-ink-3'>
                    {ui('Strong matches score 60% or higher on the calibrated relevance scale.')}
                  </p>
                </div>
              )
              : null}
          </div>
        </aside>

        <div className='min-w-0'>
          {!federated
            ? (
              <WatchStrip
                watches={watches ?? []}
                canWatch={canWatch}
                onRun={runWatch}
                onDelete={(id) => {
                  if (permits('portal.watch')) deleteWatchMutation.mutate(id)
                }}
              />
            )
            : null}
          {hasQuery && !federated
            ? (
              <p className='-mt-2 mb-4 text-xs text-ink-3'>
                {ui('Watches are re-checked daily - a dot appears here when results change.')}
              </p>
            )
            : null}

          {
            /* No query yet: show the library itself rather than a panel of copy -
            * this route is the Library entry in the nav. */
          }
          {!hasQuery
            ? (
              <LibraryBrowser
                bare
                sort={librarySort}
                onSortChange={setLibrarySort}
                density={libraryDensity}
                onDensityChange={setLibraryDensity}
                view={libraryView}
              />
            )
            : null}

          {hasQuery && isLoading
            ? (
              <div className='space-y-3'>
                <ResultCardSkeleton />
                <ResultCardSkeleton />
                <ResultCardSkeleton />
              </div>
            )
            : null}

          {hasQuery && isError
            ? (
              <ErrorCard
                message={error instanceof Error ? error.message : ui('Could not run this search.')}
                onRetry={() => void refetch()}
              />
            )
            : null}

          {hasQuery && !isLoading && !isError && results
            ? (
              <>
                {activeFilters.length > 0
                  ? (
                    <div className='mb-3 flex flex-wrap items-center gap-2'>
                      {activeFilters.map((filter) => (
                        <button
                          key={filter.key}
                          type='button'
                          onClick={filter.onRemove}
                          className='rp-chip gap-1'
                        >
                          {filter.label}
                          <X size='sm' className='shrink-0 text-ink-3' />
                        </button>
                      ))}
                    </div>
                  )
                  : null}

                {results.resources.length === 0 && results.lookup && !results.lookup.matched
                  ? (
                    <EmptyState
                      title={ui('No resource carries this identifier')}
                      description={ui(
                        "The corpus holds nothing with the {value1} {value2}. Identifiers are matched exactly against each paper's record, never against reference lists.",
                        {
                          value1: results.lookup.kind === 'doi'
                            ? 'DOI'
                            : results.lookup.kind === 'author'
                            ? 'author'
                            : results.lookup.kind.toUpperCase(),
                          value2: results.lookup.value,
                        },
                      )}
                    />
                  )
                  : results.resources.length === 0
                  ? (
                    /* Honest and specific: an exact lookup found no document
                     * carrying the term, and the way forward is a question,
                     * not a browse listing under an "Exact lookup" chip. */
                    lookupOnly
                      ? (
                        <EmptyState
                          title={ui('No resource contains "{trimmedQuery}"', {
                            trimmedQuery: trimmedQuery,
                          })}
                          description={ui(
                            'An exact lookup returns only documents that carry every term. Ask searches by meaning and can find related work instead.',
                          )}
                        >
                          <Link
                            to={`/t/${config.slug}/ask?ask=${encodeURIComponent(trimmedQuery)}`}
                            className='rp-btn rp-btn-primary'
                          >
                            {ui('Ask this instead')}
                          </Link>
                        </EmptyState>
                      )
                      : (
                        <EmptyState
                          title={ui('No resources matched that search')}
                          description={ui(
                            'Try broader terms, a different retrieval mode, or fewer topic filters.',
                          )}
                        />
                      )
                  )
                  : filteredResults.length === 0
                  ? (
                    <EmptyState
                      title={ui('No results match these filters')}
                      description={ui(
                        'The search found matches, but none clear the current filters.',
                      )}
                    >
                      <button
                        type='button'
                        onClick={() => updateParams({ topics: null, strength: null })}
                        className='rp-btn rp-btn-outline'
                      >
                        {ui('Clear filters')}
                      </button>
                    </EmptyState>
                  )
                  : (
                    <>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        {answerMode
                          ? (
                            <div
                              className='rp-seg'
                              role='group'
                              aria-label={ui('Results view')}
                            >
                              {[
                                {
                                  value: 'resources' as const,
                                  label: ui('Retrieved ({count})', {
                                    count: filteredResults.length,
                                  }),
                                },
                                {
                                  value: 'citations' as const,
                                  label: ui('Cited ({count})', { count: citedResults.length }),
                                },
                              ].map((option) => {
                                const active = resultView === option.value
                                return (
                                  <button
                                    key={option.value}
                                    type='button'
                                    aria-pressed={active}
                                    onClick={() => setResultView(option.value)}
                                    className='rp-seg-item rp-btn-sm min-w-[2.75rem]'
                                  >
                                    {ui(option.label)}
                                  </button>
                                )
                              })}
                            </div>
                          )
                          : (
                            <p className='text-xs font-medium text-ink-3'>
                              {ui(
                                federated
                                  ? 'Matches from each collection in turn'
                                  : 'Every match, most relevant first',
                              )}
                            </p>
                          )}
                        {canGenerate && !federated
                          ? (
                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={summariseResults}
                            >
                              {ui('Summarise these results')}
                            </Button>
                          )
                          : null}
                      </div>

                      {answerMode && resultView === 'citations' && citedResults.length === 0
                        ? (
                          <div className='mt-2'>
                            <EmptyState
                              title={ui('No results have been cited yet')}
                              description={answer.citations.length > 0
                                ? ui('The AI answer cited resources outside the current filters.')
                                : ui('The AI answer above has not cited any of these results.')}
                            >
                              <button
                                type='button'
                                onClick={() => setResultView('resources')}
                                className='rp-btn rp-btn-outline'
                              >
                                {ui('Show all resources')}
                              </button>
                            </EmptyState>
                          </div>
                        )
                        : (
                          <div className='mt-2 grid grid-cols-1 gap-3 2xl:grid-cols-2'>
                            {(resultView === 'citations' ? citedResults : filteredResults).map((
                              resource,
                            ) => (
                              resource.source?.kind === 'peer'
                                ? <PeerSearchResult key={resource.id} resource={resource} />
                                : (
                                  <ResultCard
                                    key={resource.id}
                                    resource={resource}
                                    slug={config.slug}
                                    query={trimmedQuery}
                                    kindLabel={kindLabel}
                                    citedIndex={citationIndexByResource.get(resource.id)}
                                    lookup={lookupOnly}
                                  />
                                )
                            ))}
                          </div>
                        )}
                    </>
                  )}

                {results.relatedQuestions.length > 0
                  ? (
                    <div className='mt-8'>
                      <p className='rp-eyebrow text-ink-3'>{ui('People also ask')}</p>
                      <div className='mt-2.5 grid gap-1.5 sm:grid-cols-2 2xl:grid-cols-3'>
                        {results.relatedQuestions.map((question) => (
                          <button
                            key={question.id}
                            type='button'
                            onClick={() => askQuestion(question.text)}
                            className='rp-focus flex min-h-11 items-center justify-between gap-3 rounded-[var(--rp-radius-btn)] border border-line bg-[var(--rp-surface)] px-3.5 py-2.5 text-left text-sm text-[var(--rp-ink-2)] transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                          >
                            <span>{question.text}</span>
                            <ArrowRight size='sm' className='shrink-0 text-ink-3' />
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                  : null}
              </>
            )
            : null}
        </div>
      </div>

      {canGenerate && summaryModal.open
        ? (
          <SummaryModal
            loading={summaryModal.loading}
            error={summaryModal.error}
            summary={summaryModal.summary}
            titles={summaryModal.titles}
            onClose={summaryModal.close}
            onRetry={summaryModal.retry}
          />
        )
        : null}
    </main>
  )
}
