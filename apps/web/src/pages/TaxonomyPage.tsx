import { type FormEvent, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import type { Labelset } from '@research-portal/core'
import { createAdminLabelset, getCounters, getFacets, getLabelsets } from '../api/client.ts'
import { prettyLabel } from '../components/ui.tsx'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { MessagePanel } from './admin/MessagePanel.tsx'
import { errorMessage, inputClass, type Message } from './admin/shared.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'
import { getAuthSession } from '../api/auth.ts'

/** Whether a labelset has any indexed value at all - one with none is hidden. */
export function labelsetHasCounts(counts: Record<string, number> | undefined): boolean {
  return Object.values(counts ?? {}).some((n) => n > 0)
}

/**
 * The cardinality line. A labelset declared single-valued whose counts add up
 * to more than the corpus has resources is, in practice, multi-valued - say
 * what the index shows rather than what the declaration claims.
 */
export function cardinalityLabel(
  labelset: Pick<Labelset, 'multiple' | 'kind'>,
  counts: Record<string, number>,
  resources: number | undefined,
): string {
  if (labelset.kind === 'PARAGRAPHS') return 'Applied to passages, not whole resources'
  const total = Object.values(counts).reduce((n, c) => n + c, 0)
  if (!labelset.multiple && resources !== undefined && resources > 0 && total > resources) {
    return 'Multiple values per resource (observed in the index)'
  }
  return labelset.multiple ? 'Multiple values per resource' : 'Single value per resource'
}

function LabelsetCard({
  labelset,
  counts,
  organisation,
  resources,
}: {
  labelset: Labelset
  counts: Record<string, number>
  organisation: string
  /** Resources in the box, for the observed-cardinality check. */
  resources: number | undefined
}) {
  const sorted = [...labelset.labels].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
  const definitions = labelset.definitions ?? {}
  const hasDefinitions = sorted.some((label) => Boolean(definitions[label]))
  const passages = labelset.kind === 'PARAGRAPHS'

  const chip = (label: string) => {
    const count = counts[label] ?? 0
    return (
      <span className={`rp-chip ${count > 0 ? 'text-ink' : 'text-ink-3'}`}>
        {prettyLabel(label, organisation)}
        <span className='text-ink-3'>
          {count.toLocaleString()}
          {passages ? ' passages' : ''}
        </span>
      </span>
    )
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-6 shadow-sm'>
      <div className='flex items-baseline justify-between gap-3'>
        <h2 className='text-lg font-semibold tracking-tight text-ink'>
          {prettyLabel(labelset.title, organisation)}
        </h2>
        <span className='shrink-0 text-xs font-medium uppercase tracking-wide text-ink-3'>
          {labelset.labels.length} {labelset.labels.length === 1 ? 'value' : 'values'}
        </span>
      </div>
      <p className='mt-1 text-xs text-ink-3'>
        {cardinalityLabel(labelset, counts, resources)}
        {passages ? ' - counts are passages' : ''}
      </p>

      {sorted.length === 0
        ? <p className='mt-4 text-sm text-ink-3'>No values yet.</p>
        : hasDefinitions
        ? (
          // With definitions the card is the vocabulary reference: each value
          // sits above its own definition rather than in a chip cloud.
          <ul className='mt-4 space-y-3'>
            {sorted.map((label) => (
              <li key={label}>
                {chip(label)}
                {definitions[label]
                  ? (
                    <p className='mt-1 max-w-prose text-xs leading-relaxed text-ink-3'>
                      {definitions[label]}
                    </p>
                  )
                  : null}
              </li>
            ))}
          </ul>
        )
        : (
          <div className='mt-4 flex flex-wrap gap-2'>
            {sorted.map((label) => <span key={label}>{chip(label)}</span>)}
          </div>
        )}
    </div>
  )
}

function AddLabelsetCard({
  slug,
  credential,
  ssoAdmin,
  onAdded,
}: {
  slug: string
  /** The admin credential ManagePage would send: `microsoft-sso` or the passcode. */
  credential: string
  /** A signed-in administrator needs no passcode field. */
  ssoAdmin: boolean
  onAdded: () => Promise<unknown>
}) {
  const [title, setTitle] = useState('')
  const [multiple, setMultiple] = useState(false)
  const [seed, setSeed] = useState('')
  const [passcode, setPasscode] = useState(credential)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const labels = seed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    setBusy(true)
    setMessage(null)
    try {
      await createAdminLabelset(slug, ssoAdmin ? 'microsoft-sso' : passcode, {
        title: title.trim(),
        multiple,
        labels,
      })
      setMessage({ tone: 'ok', text: `Added "${title.trim()}" - it will appear once indexed.` })
      setTitle('')
      setSeed('')
      await onAdded()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not add that category - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-dashed border-line bg-surface-2 p-6'>
      <h2 className='text-sm font-semibold text-ink'>Add a category</h2>
      <form onSubmit={onSubmit} className='mt-4 space-y-3'>
        <div>
          <label
            htmlFor='taxonomy-name'
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Name
          </label>
          <input
            id='taxonomy-name'
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='e.g. Region'
            autoComplete='off'
            required
          />
        </div>

        <div>
          <p className='mb-1.5 block text-sm font-medium text-ink'>Values per resource</p>
          <div className='inline-flex rounded-[var(--rp-radius)] border border-line bg-surface p-1'>
            <button
              type='button'
              aria-pressed={!multiple}
              onClick={() => setMultiple(false)}
              className={`rounded-[calc(var(--rp-radius)-2px)] px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
                !multiple
                  ? 'bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'
                  : 'text-ink-2 hover:bg-[var(--rp-surface-2)]'
              }`}
            >
              Single
            </button>
            <button
              type='button'
              aria-pressed={multiple}
              onClick={() => setMultiple(true)}
              className={`rounded-[calc(var(--rp-radius)-2px)] px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
                multiple
                  ? 'bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'
                  : 'text-ink-2 hover:bg-[var(--rp-surface-2)]'
              }`}
            >
              Multiple
            </button>
          </div>
        </div>

        <div>
          <label
            htmlFor='taxonomy-seed'
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Seed values
          </label>
          <input
            id='taxonomy-seed'
            className={inputClass}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder='Comma-separated, e.g. North, South, East, West'
            autoComplete='off'
          />
        </div>

        {!ssoAdmin && (
          <div>
            <label
              htmlFor='taxonomy-passcode'
              className='mb-1.5 block text-sm font-medium text-ink'
            >
              Admin passcode
            </label>
            <input
              id='taxonomy-passcode'
              type='password'
              className={inputClass}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete='off'
              required
            />
          </div>
        )}

        <button
          type='submit'
          disabled={busy}
          className='rp-btn rp-btn-primary'
        >
          {busy ? 'Adding…' : 'Add category'}
        </button>
      </form>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

function LabelsetCardSkeleton() {
  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-6 shadow-sm'>
      <Skeleton className='h-5 w-1/3' />
      <Skeleton className='mt-3 h-4 w-1/2' />
      <div className='mt-4 flex flex-wrap gap-2'>
        <Skeleton className='h-6 w-20 rounded-[var(--rp-radius)]' />
        <Skeleton className='h-6 w-24 rounded-[var(--rp-radius)]' />
        <Skeleton className='h-6 w-16 rounded-[var(--rp-radius)]' />
      </div>
    </div>
  )
}

/**
 * Taxonomy - the categories used to classify resources, with live counts
 * from the knowledge box, plus an admin affordance to add a new category.
 */
export function TaxonomyPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const queryClient = useQueryClient()
  // Same administrator rule as ManagePage: a signed-in administrator
  // (Microsoft SSO) or the session passcode; SSO sends `microsoft-sso`.
  const { data: auth } = useQuery({
    queryKey: ['auth-session'],
    queryFn: getAuthSession,
    staleTime: 60_000,
    retry: false,
  })
  const ssoAdmin = auth?.user?.isAdmin === true
  const passcode = sessionStorage.getItem('rp-admin-passcode') ?? ''
  const isAdmin = ssoAdmin || passcode.length > 0
  const adminCredential = ssoAdmin ? 'microsoft-sso' : passcode

  const {
    data: labelsets,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
  })

  const labelsetIds = useMemo(() => labelsets?.map((l) => l.id) ?? [], [labelsets])

  const { data: facets } = useQuery({
    queryKey: ['facets', slug, labelsetIds],
    queryFn: () => getFacets(slug, labelsetIds),
    enabled: labelsetIds.length > 0,
  })
  const { data: counters } = useQuery({
    queryKey: ['counters', slug],
    queryFn: () => getCounters(slug),
    staleTime: 60_000,
  })
  // A labelset with no indexed value at all is noise on this page (a stale
  // classifier's empty categories); it is hidden and counted in one line.
  const visible = useMemo(
    () => labelsets?.filter((ls) => !facets || labelsetHasCounts(facets[ls.id])) ?? [],
    [labelsets, facets],
  )
  const hiddenCount = (labelsets?.length ?? 0) - visible.length

  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['labelsets', slug] }),
      queryClient.invalidateQueries({ queryKey: ['facets', slug] }),
    ])

  return (
    <main className='mx-auto max-w-6xl px-6 py-10'>
      <h1 className='text-2xl font-semibold tracking-tight text-ink'>Taxonomy</h1>
      <p className='mt-1 text-sm text-ink-3'>
        Categories used to classify resources. Counts reflect indexed content.
      </p>

      {isLoading && (
        <div className='mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2'>
          <LabelsetCardSkeleton />
          <LabelsetCardSkeleton />
        </div>
      )}

      {isError && (
        <div className='mt-8'>
          <ErrorCard
            message={error instanceof Error ? error.message : 'Could not load the taxonomy.'}
            onRetry={() => void refetch()}
          />
        </div>
      )}

      {labelsets && (
        <>
          <div className='mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2'>
            {visible.map((ls) => (
              <LabelsetCard
                key={ls.id}
                labelset={ls}
                counts={facets?.[ls.id] ?? {}}
                organisation={config.branding.organisation}
                resources={counters?.resources}
              />
            ))}
            {isAdmin
              ? (
                <AddLabelsetCard
                  slug={slug}
                  credential={adminCredential}
                  ssoAdmin={ssoAdmin}
                  onAdded={refreshAll}
                />
              )
              : null}
          </div>
          {hiddenCount > 0
            ? (
              <p className='mt-4 text-xs text-ink-3'>
                {hiddenCount} {hiddenCount === 1 ? 'category' : 'categories'} with no indexed values
                {' '}
                {hiddenCount === 1 ? 'is' : 'are'} not shown.
              </p>
            )
            : null}
        </>
      )}
    </main>
  )
}
