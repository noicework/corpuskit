import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import type { RetrievalMode, ScoredResource } from '@research-portal/core'
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
import { LibraryBrowser, SORT_OPTIONS, SORT_VALUES, type SortValue } from './LibraryPage.tsx'
import { sameLabel, typeLabel } from '../components/ui.tsx'
import { SaveEvidenceButton } from '../components/SaveEvidence.tsx'
import { SearchAnswer, type SearchAnswerResult } from '../components/SearchAnswer.tsx'
import { EmptyState, ErrorCard, prettyLabel, Skeleton, TypeBadge } from '../components/ui.tsx'
import { answerModeParam, readAnswerMode } from '../lib/search-mode.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'
import { passageIsInformative } from '../lib/passage.ts'

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

/** Publish year from an ISO date, or null when the date is missing/unparseable. */
function formatYear(iso: string): string | null {
  const match = /^(\d{4})/.exec(iso)
  return match ? match[1] ?? null : null
}

function RelevanceMeter(
  { relevance, referenceChunk }: { relevance: number; referenceChunk?: boolean },
) {
  const percent = Math.round(relevance * 100)
  const weak = relevance < WEAK_MATCH_THRESHOLD

  return (
    <div className='flex shrink-0 items-center gap-2'>
      {referenceChunk ? <span className='text-[11px] text-ink-3'>reference list</span> : null}
      {weak ? <span className='text-[11px] text-ink-3'>weak match</span> : null}
      <div
        className='h-1 w-20 overflow-hidden rounded-[var(--rp-radius)] bg-surface-3'
        role='progressbar'
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label='Relevance'
      >
        <div
          className='h-full'
          style={{ width: `${percent}%`, backgroundColor: 'var(--rp-accent)' }}
        />
      </div>
      <span className='text-xs font-medium tabular-nums text-ink-3'>{percent}%</span>
    </div>
  )
}

/** Deep link into the reader, carrying the matched passage and (for PDFs) the page it sits on. */
function resourceLink(slug: string, resource: ScoredResource): string {
  const params = new URLSearchParams()
  if (resource.matchedPassage) params.set('passage', resource.matchedPassage.slice(0, 300))
  if (resource.matchedPage) params.set('page', String(resource.matchedPage))
  const query = params.toString()
  return `/t/${slug}/library/${resource.id}${query ? `?${query}` : ''}`
}

/**
 * One result. The matched passage is the point of the card - it is the citation
 * in context, which is what keeps this list readable on its own when someone
 * switches the AI answer off.
 */
function ResultCard(
  { resource, slug, query, kindLabel, citedIndex }: {
    resource: ScoredResource
    slug: string
    query: string
    kindLabel: (id: string) => string
    /** Lowest `[n]` marker the AI answer cites this resource under, when it is cited at all. */
    citedIndex?: number
  },
) {
  const keyFacts = resource.keyFacts.slice(0, 3)
  const year = resource.published ? formatYear(resource.published) : null

  return (
    <article id={`result-${resource.id}`} className='rp-card scroll-mt-6 p-4 sm:p-5'>
      <div className='flex gap-4'>
        <div className='hidden aspect-[210/297] w-[4.5rem] shrink-0 self-start overflow-hidden rounded-[2px] border border-line sm:block'>
          <ResourceThumb slug={slug} id={resource.id} type={resource.type} />
        </div>

        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <TypeBadge type={resource.type} />
              {
                /* The kind chip is dropped when it only restates the type badge
                * (a `document` typed "Report" filed under kind "report"). */
              }
              {resource.kind && !sameLabel(kindLabel(resource.kind), typeLabel(resource.type))
                ? <span className='rp-badge rp-badge-quiet'>{kindLabel(resource.kind)}</span>
                : null}
              {citedIndex !== undefined
                ? (
                  <span
                    className='rp-badge font-semibold text-[var(--rp-on-accent)]'
                    style={{ backgroundColor: 'var(--rp-accent)', borderColor: 'var(--rp-accent)' }}
                  >
                    Cited [{citedIndex}]
                  </span>
                )
                : null}
              {year
                ? <span className='text-xs font-medium tabular-nums text-ink-3'>{year}</span>
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
              className='rp-focus rounded-[var(--rp-radius-btn)]'
            >
              {resource.title}
            </Link>
          </h3>
          {resource.sourceName
            ? (
              <p className='mt-0.5 truncate text-[11px] tabular-nums text-ink-3/80'>
                {resource.sourceName}
              </p>
            )
            : null}
          {resource.summary && resource.summary !== resource.title
            ? <p className='mt-1.5 text-sm leading-relaxed text-ink-2'>{resource.summary}</p>
            : null}

          {resource.matchedPassage && passageIsInformative(resource.matchedPassage, query)
            ? (
              <blockquote className='break-words mt-3 text-sm leading-relaxed text-ink-2'>
                &ldquo;{resource.matchedPassage.length > 340
                  ? `${resource.matchedPassage.slice(0, 340).replace(/\s\S*$/, '')}…`
                  : resource.matchedPassage}&rdquo;
              </blockquote>
            )
            : null}

          {keyFacts.length > 0
            ? (
              <div className='mt-3.5'>
                <p className='rp-eyebrow text-ink-3'>Key facts</p>
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
      className='rp-anim-fade fixed inset-0 z-[70] flex items-center justify-center bg-neutral-950/60 p-4 backdrop-blur-sm'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role='dialog'
        aria-modal='true'
        aria-label='Summary'
        className='rp-card rp-shadow-xl flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden'
      >
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5'>
          <h2 className='text-sm font-semibold text-ink'>Summary</h2>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rp-btn rp-btn-ghost h-8 w-8 !px-0'
          >
            <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-3.5 w-3.5'>
              <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
            </svg>
          </button>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
          {loading
            ? (
              <div>
                <p className='text-sm text-ink-2'>
                  Reading {titles.length} {titles.length === 1 ? 'document' : 'documents'}…
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
            ? <p className='whitespace-pre-wrap text-sm leading-relaxed text-ink-2'>{summary}</p>
            : null}
        </div>

        {!loading && !error
          ? (
            <div className='shrink-0 border-t border-line px-5 py-3.5'>
              <p className='rp-eyebrow text-ink-3'>Sources</p>
              <ul className='mt-1.5 max-h-24 space-y-0.5 overflow-y-auto text-xs text-ink-3'>
                {titles.map((title, index) => <li key={index} className='truncate'>{title}</li>)}
              </ul>
              <div className='mt-3 flex justify-end'>
                <button type='button' onClick={copy} className='rp-btn rp-btn-outline'>
                  {copied ? 'Copied' : 'Copy'}
                </button>
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
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [titles, setTitles] = useState<string[]>([])
  const lastRequest = useRef<{ ids: string[]; kind: 'simple' | 'extended' } | null>(null)
  // A slower earlier request must never overwrite a newer one.
  const requestSeq = useRef(0)

  const run = useCallback(
    (ids: string[], resourceTitles: string[], kind: 'simple' | 'extended' = 'simple') => {
      lastRequest.current = { ids, kind }
      const requestId = ++requestSeq.current
      setTitles(resourceTitles)
      setOpen(true)
      setLoading(true)
      setError(null)
      setSummary('')
      summarizeResources(slug, ids, kind)
        .then((res) => {
          if (requestId !== requestSeq.current) return
          setSummary(res.summary)
        })
        .catch((err) => {
          if (requestId !== requestSeq.current) return
          setError(err instanceof Error ? err.message : 'Could not generate a summary.')
        })
        .finally(() => {
          if (requestId !== requestSeq.current) return
          setLoading(false)
        })
    },
    [slug],
  )

  const retry = useCallback(() => {
    if (!lastRequest.current) return
    run(lastRequest.current.ids, titles, lastRequest.current.kind)
  }, [run, titles])

  return { open, loading, error, summary, titles, run, retry, close: () => setOpen(false) }
}

/** Quiet strip of saved searches - each chip re-runs the search and shows a changed dot when new results have arrived. */
function WatchStrip(
  { watches, onRun, onDelete }: {
    watches: SavedWatch[]
    onRun: (watch: SavedWatch) => void
    onDelete: (id: string) => void
  },
) {
  if (watches.length === 0) return null

  return (
    <div className='mb-4 flex flex-wrap items-center gap-1.5'>
      <span className='rp-eyebrow shrink-0 text-ink-3'>Saved</span>
      {watches.map((watch) => (
        <div
          key={watch.id}
          className='inline-flex items-center gap-0.5 rounded-[var(--rp-radius)] border border-line bg-surface py-0.5 pl-1 pr-0.5'
        >
          <button
            type='button'
            onClick={() => onRun(watch)}
            className='rp-focus flex items-center gap-1.5 rounded-[var(--rp-radius-btn)] px-1.5 py-1 text-xs text-ink-2 transition-colors duration-150 hover:text-[var(--rp-ink)]'
          >
            {watch.changed
              ? (
                <>
                  <span
                    role='status'
                    className='h-1.5 w-1.5 shrink-0 rounded-full'
                    style={{ backgroundColor: 'var(--rp-accent)' }}
                    aria-label='New results'
                  />
                  <span className='sr-only'>has new results</span>
                </>
              )
              : null}
            <span className='max-w-[12rem] truncate'>{watch.query}</span>
          </button>
          <button
            type='button'
            onClick={(event) => {
              event.stopPropagation()
              onDelete(watch.id)
            }}
            aria-label={`Remove saved search "${watch.query}"`}
            className='rp-focus flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--rp-radius-btn)] text-ink-3 transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
          >
            <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-3 w-3'>
              <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

export function SearchPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
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
  const answerMode = readAnswerMode(searchParams)

  // Open by default on the desktop layout; the Filters button hides it again.
  const [filtersOpen, setFiltersOpen] = useState(true)
  // The no-query state is the library listing, so its controls belong in the
  // same row as the retrieval modes rather than floating above the grid.
  const [librarySort, setLibrarySort] = useState<SortValue>('newest')
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
  const kindLabel = (id: string) => prettyLabel(id, config.branding.organisation)

  const { data: facets } = useQuery({
    queryKey: ['facets', config.slug],
    queryFn: () => getFacets(config.slug, ['topic', 'kind']),
  })
  const topicCounts = facets?.topic ?? {}
  const kindCounts = facets?.kind ?? {}
  const kindIds = useMemo(() => Object.keys(kindCounts).sort(), [kindCounts])

  const {
    data: results,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search', config.slug, q, mode, selectedTopics.join(','), selectedKinds.join(',')],
    queryFn: () =>
      searchTenantFull(config.slug, q, { mode, topicIds: selectedTopics, kindIds: selectedKinds }),
    enabled: q.trim().length > 0,
  })

  // Match strength is not a server filter - the search API only accepts topicIds - so
  // this narrows the already-fetched, calibrated results client-side.
  const filteredResults = useMemo(() => {
    if (!results) return []
    if (strength !== 'strong') return results.resources
    return results.resources.filter((r) => r.relevance >= STRONG_MATCH_THRESHOLD)
  }, [results, strength])

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
        label: 'Strong matches only',
        onRemove: () => setStrength('all'),
      })
    }
    return chips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTopics, selectedKinds, strength, config.topics, config.branding.organisation])

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
  const invalidateWatches = () =>
    queryClient.invalidateQueries({ queryKey: ['watches', config.slug] })
  const addWatchMutation = useMutation({
    mutationFn: () => addWatch(config.slug, trimmedQuery),
    onSuccess: invalidateWatches,
  })
  const deleteWatchMutation = useMutation({
    mutationFn: (id: string) => deleteWatch(config.slug, id),
    onSuccess: invalidateWatches,
  })
  const markSeenMutation = useMutation({
    mutationFn: (id: string) => markWatchSeen(config.slug, id),
    onSuccess: invalidateWatches,
  })
  const isWatchingCurrent = hasQuery &&
    (watches ?? []).some((watch) => watch.query.trim() === trimmedQuery)

  function runWatch(watch: SavedWatch) {
    updateParams({ q: watch.query })
    markSeenMutation.mutate(watch.id)
  }

  const summaryModal = useResourceSummary(config.slug)

  function summariseResults() {
    if (filteredResults.length === 0) return
    const top = filteredResults.slice(0, 10)
    summaryModal.run(top.map((r) => r.id), top.map((r) => r.title))
  }

  return (
    <main className='rp-shell py-8'>
      {
        /* Heading, then the field, then the controls - the library's shape, so
        * the two listing pages read as one product. The heading is "Search"
        * rather than the query itself: the query is right below it in a box the
        * reader can edit, and a heading that repeated it would say the same
        * thing twice while breaking the parallel with "Library" next door. The
        * count rides on the heading line the way the library's total does. */
      }
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h1 className='rp-display text-2xl text-ink'>Search</h1>
        {hasQuery && !isLoading && !isError && results
          ? (
            <p className='text-sm font-medium tabular-nums text-ink-3'>
              {filteredResults.length} {filteredResults.length === 1 ? 'resource' : 'resources'}
              {answerMode ? ` · ${citedResults.length} cited` : ''}
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
          label={`Search ${config.branding.productName}`}
          value={draft}
          onChange={setDraft}
          onSubmit={submitQuery}
          placeholder={config.searchPlaceholder}
          className='min-w-[min(16rem,100%)] flex-1'
        />

        <div
          className='inline-flex overflow-hidden rounded-[var(--rp-radius)] border border-line bg-surface'
          role='radiogroup'
          aria-label='Retrieval mode'
        >
          {MODES.map((option, index) => {
            const active = mode === option.value
            return (
              <button
                key={option.value}
                type='button'
                role='radio'
                aria-checked={active}
                onClick={() =>
                  updateParams({ mode: option.value === 'hybrid' ? null : option.value })}
                className={`rp-focus px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
                  index > 0 ? 'border-l border-line' : ''
                } ${
                  active
                    ? 'text-[var(--rp-on-primary)]'
                    : 'text-[var(--rp-ink-2)] hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                }`}
                style={active ? { backgroundColor: 'var(--rp-primary)' } : undefined}
              >
                {option.label}
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
        <button
          type='button'
          onClick={() => setFiltersOpen((open) => !open)}
          className='rp-chip h-9 sm:h-7'
          aria-expanded={filtersOpen}
        >
          Filters{activeFilters.length > 0 ? ` (${activeFilters.length})` : ''}
        </button>

        {
          /* The listing's own controls, in the no-query state. Right-aligned
          * only where the toolbar is genuinely one line: once the search field
          * makes the row wrap, `ml-auto` strands this cluster against the right
          * edge of its own line with a ragged gap beside it, so below `lg` it
          * just follows the chips. */
        }
        {!hasQuery
          ? (
            <div className='flex items-center gap-2 lg:ml-auto'>
              <ViewToggle value={libraryView} onChange={setLibraryView} />
              <GridDensity
                value={libraryDensity}
                onChange={setLibraryDensity}
                view={libraryView}
              />
              <label htmlFor='search-sort' className='text-xs font-medium text-ink-3'>
                Sort
              </label>
              <select
                id='search-sort'
                value={librarySort}
                onChange={(event) => setLibrarySort(event.target.value as SortValue)}
                className='rp-focus rp-select rounded-[var(--rp-radius-input)] border border-line bg-surface px-2.5 py-1.5 text-xs text-ink'
              >
                {SORT_VALUES.map((value) => (
                  <option key={value} value={value}>{SORT_OPTIONS[value].label}</option>
                ))}
              </select>
            </div>
          )
          : null}

        {/* The answer opt-out, which used to live beside the removed search box. */}
        {hasQuery
          ? (
            <button
              type='button'
              onClick={() => runSearch(q, !answerMode)}
              aria-pressed={!answerMode}
              title={answerMode
                ? 'Hide the AI answer and show only the matching resources'
                : 'Show a cited AI answer above the results again'}
              className={`rp-chip h-9 sm:h-7 ${!answerMode ? 'rp-chip-active' : ''}`}
            >
              Results only
            </button>
          )
          : null}

        {hasQuery
          ? (
            isWatchingCurrent
              ? (
                <span
                  className='rp-badge rp-badge-quiet'
                  title='This search is re-checked daily - a dot appears in the saved strip when new results arrive.'
                >
                  Watching
                </span>
              )
              : (
                <button
                  type='button'
                  onClick={() => addWatchMutation.mutate()}
                  disabled={addWatchMutation.isPending}
                  title='Get notified here when new results appear for this search'
                  className='rp-chip h-9 sm:h-7'
                >
                  {addWatchMutation.isPending ? 'Saving…' : 'Watch this search'}
                </button>
              )
          )
          : null}
      </div>

      {hasQuery && answerMode
        ? (
          <div className='mt-6'>
            <SearchAnswer slug={config.slug} query={q} onResult={setAnswer} />
          </div>
        )
        : null}

      <div
        className={`mt-6 grid grid-cols-1 gap-6 ${filtersOpen ? 'lg:grid-cols-[275px_1fr]' : ''}`}
      >
        <aside className={filtersOpen ? 'block' : 'hidden'}>
          <div className='rp-card p-4 lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)]'>
            {config.topics.length > 0
              ? (
                <div>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='rp-eyebrow text-ink-3'>Topics</p>
                    {selectedTopics.length > 0
                      ? (
                        <button
                          type='button'
                          onClick={() => updateParams({ topics: null })}
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
                          <span className='self-center text-xs tabular-nums text-ink-3'>
                            {count}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
              : null}

            {kindIds.length > 0
              ? (
                <div className={config.topics.length > 0 ? 'mt-5 border-t border-line pt-4' : ''}>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='rp-eyebrow text-ink-3'>Kind</p>
                    {selectedKinds.length > 0
                      ? (
                        <button
                          type='button'
                          onClick={() => updateParams({ kinds: null })}
                          className='text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
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
                      const muted = count === 0 && !checked
                      return (
                        <label
                          key={id}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-[var(--rp-radius-btn)] px-1 py-1 text-sm ${
                            muted ? 'text-ink-3' : 'text-ink-2'
                          }`}
                        >
                          <input
                            type='checkbox'
                            checked={checked}
                            onChange={() => toggleKind(id)}
                            className='mt-[2px] h-4 w-4 shrink-0 rounded-[var(--rp-radius-input)] border-line'
                            style={{ accentColor: 'var(--rp-accent)' }}
                          />
                          <span className='min-w-0 flex-1'>{kindLabel(id)}</span>
                          <span className='self-center text-xs tabular-nums text-ink-3'>
                            {count}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
              : null}

            <div
              className={(config.topics.length > 0 || kindIds.length > 0)
                ? 'mt-5 border-t border-line pt-4'
                : ''}
            >
              <p className='rp-eyebrow text-ink-3'>Match strength</p>
              <div
                className='mt-2.5 inline-flex overflow-hidden rounded-[var(--rp-radius)] border border-line bg-surface'
                role='radiogroup'
                aria-label='Match strength'
              >
                {STRENGTH_OPTIONS.map((option, index) => {
                  const active = strength === option.value
                  return (
                    <button
                      key={option.value}
                      type='button'
                      role='radio'
                      aria-checked={active}
                      onClick={() => setStrength(option.value)}
                      className={`rp-focus px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                        index > 0 ? 'border-l border-line' : ''
                      } ${
                        active
                          ? 'text-[var(--rp-on-primary)]'
                          : 'text-[var(--rp-ink-2)] hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                      }`}
                      style={active ? { backgroundColor: 'var(--rp-primary)' } : undefined}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
              <p className='mt-1.5 text-xs text-ink-3'>
                Strong matches score 60% or higher on the calibrated relevance scale.
              </p>
            </div>
          </div>
        </aside>

        <div className='min-w-0'>
          <WatchStrip
            watches={watches ?? []}
            onRun={runWatch}
            onDelete={(id) => deleteWatchMutation.mutate(id)}
          />
          {hasQuery
            ? (
              <p className='-mt-2 mb-4 text-xs text-ink-3'>
                Watched searches are re-checked daily - a dot appears here when results change.
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
                message={error instanceof Error ? error.message : 'Could not run this search.'}
                onRetry={() => void refetch()}
              />
            )
            : null}

          {hasQuery && !isLoading && !isError && results
            ? (
              <>
                {activeFilters.length > 0
                  ? (
                    <div className='mb-3 flex flex-wrap items-center gap-1.5'>
                      {activeFilters.map((filter) => (
                        <button
                          key={filter.key}
                          type='button'
                          onClick={filter.onRemove}
                          className='rp-chip h-7 gap-1'
                        >
                          {filter.label}
                          <span aria-hidden='true' className='text-ink-3'>&times;</span>
                        </button>
                      ))}
                    </div>
                  )
                  : null}

                {results.resources.length === 0
                  ? (
                    <EmptyState
                      title='No resources matched that search'
                      description='Try broader terms, a different retrieval mode, or fewer topic filters.'
                    />
                  )
                  : filteredResults.length === 0
                  ? (
                    <EmptyState
                      title='No results match these filters'
                      description='The search found matches, but none clear the current filters.'
                    >
                      <button
                        type='button'
                        onClick={() => updateParams({ topics: null, strength: null })}
                        className='rp-btn rp-btn-outline'
                      >
                        Clear filters
                      </button>
                    </EmptyState>
                  )
                  : (
                    <>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        {answerMode
                          ? (
                            <div
                              className='inline-flex overflow-hidden rounded-[var(--rp-radius)] border border-line bg-surface'
                              role='radiogroup'
                              aria-label='Results view'
                            >
                              {[
                                {
                                  value: 'resources' as const,
                                  label: `Retrieved (${filteredResults.length})`,
                                },
                                {
                                  value: 'citations' as const,
                                  label: `Cited (${citedResults.length})`,
                                },
                              ].map((option, index) => {
                                const active = resultView === option.value
                                return (
                                  <button
                                    key={option.value}
                                    type='button'
                                    role='radio'
                                    aria-checked={active}
                                    onClick={() => setResultView(option.value)}
                                    className={`rp-focus px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                                      index > 0 ? 'border-l border-line' : ''
                                    } ${
                                      active
                                        ? 'text-[var(--rp-on-primary)]'
                                        : 'text-[var(--rp-ink-2)] hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                                    }`}
                                    style={active
                                      ? { backgroundColor: 'var(--rp-primary)' }
                                      : undefined}
                                  >
                                    {option.label}
                                  </button>
                                )
                              })}
                            </div>
                          )
                          : (
                            <p className='text-xs font-medium text-ink-3'>
                              Every match, most relevant first
                            </p>
                          )}
                        <button
                          type='button'
                          onClick={summariseResults}
                          className='text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
                        >
                          Summarise these results
                        </button>
                      </div>

                      {answerMode && resultView === 'citations' && citedResults.length === 0
                        ? (
                          <div className='mt-2'>
                            <EmptyState
                              title='No results have been cited yet'
                              description={answer.citations.length > 0
                                ? 'The AI answer cited resources outside the current filters.'
                                : 'The AI answer above has not cited any of these results.'}
                            >
                              <button
                                type='button'
                                onClick={() => setResultView('resources')}
                                className='rp-btn rp-btn-outline'
                              >
                                Show all resources
                              </button>
                            </EmptyState>
                          </div>
                        )
                        : (
                          <div className='mt-2 grid grid-cols-1 gap-3 2xl:grid-cols-2'>
                            {(resultView === 'citations' ? citedResults : filteredResults).map((
                              resource,
                            ) => (
                              <ResultCard
                                key={resource.id}
                                resource={resource}
                                slug={config.slug}
                                query={trimmedQuery}
                                kindLabel={kindLabel}
                                citedIndex={citationIndexByResource.get(resource.id)}
                              />
                            ))}
                          </div>
                        )}
                    </>
                  )}

                {results.relatedQuestions.length > 0
                  ? (
                    <div className='mt-8'>
                      <p className='rp-eyebrow text-ink-3'>People also ask</p>
                      <div className='mt-2.5 grid gap-1.5 sm:grid-cols-2 2xl:grid-cols-3'>
                        {results.relatedQuestions.map((question) => (
                          <button
                            key={question.id}
                            type='button'
                            onClick={() => askQuestion(question.text)}
                            className='rp-focus flex items-center justify-between gap-3 rounded-[var(--rp-radius-btn)] border border-line bg-[var(--rp-surface)] px-3.5 py-2.5 text-left text-sm text-[var(--rp-ink-2)] transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                          >
                            <span>{question.text}</span>
                            <span aria-hidden='true' className='shrink-0 text-ink-3'>&rarr;</span>
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

      {summaryModal.open
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
