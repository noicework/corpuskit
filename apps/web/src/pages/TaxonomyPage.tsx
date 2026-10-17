import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { AdminAccessError } from '../api/break-glass.ts'
import { type FormEvent, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import type { Labelset } from '@research-portal/core'
import { createAdminLabelset, getCounters, getFacets, getLabelsets } from '../api/client.ts'
import { Button, ErrorCard, prettyLabel, SectionHeader, Skeleton } from '../components/ui.tsx'
import { Plus } from '../components/icons.tsx'
import { MessagePanel } from './admin/MessagePanel.tsx'
import { inputClass, type Message } from './admin/shared.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'
import { AdminPageAccess } from './AdminPage.tsx'
import { usePermissionAdminAccess } from '../components/EmergencyAccess.tsx'

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
  ui: ResearchUi = englishResearchUi,
): string {
  if (labelset.kind === 'PARAGRAPHS') return ui('Applied to passages, not whole resources')
  const total = Object.values(counts).reduce((n, c) => n + c, 0)
  if (!labelset.multiple && resources !== undefined && resources > 0 && total > resources) {
    return ui('Multiple values per resource (observed in the index)')
  }
  return ui(labelset.multiple ? 'Multiple values per resource' : 'Single value per resource')
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
  const { ui } = usePortalLocale()
  const sorted = [...labelset.labels].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
  const definitions = labelset.definitions ?? {}
  const hasDefinitions = sorted.some((label) => Boolean(definitions[label]))
  const passages = labelset.kind === 'PARAGRAPHS'

  const chip = (label: string) => {
    const count = counts[label] ?? 0
    return (
      <span className={`rp-tag ${count > 0 ? 'text-ink' : 'text-ink-3'}`}>
        {prettyLabel(label, organisation, ui)}
        <span className='text-ink-3'>
          {count.toLocaleString()}
          {passages ? ui(' passages') : ''}
        </span>
      </span>
    )
  }

  return (
    <div className='rp-card min-w-0 p-5 lg:p-6'>
      <SectionHeader
        className='rp-manage-section-head'
        title={prettyLabel(labelset.title, organisation, ui)}
        description={
          <>
            {cardinalityLabel(labelset, counts, resources, ui)}
            {passages ? ui(' - counts are passages') : ''}
          </>
        }
        actions={
          <span className='rp-tag'>
            {labelset.labels.length} {labelset.labels.length === 1 ? ui('value') : ui('values')}
          </span>
        }
      />

      {sorted.length === 0
        ? <p className='mt-4 text-sm text-ink-3'>{ui('No values yet.')}</p>
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
  onAdded,
}: {
  slug: string
  onAdded: () => Promise<unknown>
}) {
  const { ui, error: localError } = usePortalLocale()
  const [title, setTitle] = useState('')
  const [multiple, setMultiple] = useState(false)
  const [seed, setSeed] = useState('')
  const authority = useAccess()
  const context = authority.controller.context
  const { runExplicit } = usePermissionAdminAccess('taxonomy.write', { kind: 'portal', slug })
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
      const result = await runExplicit(
        `Add category to ${slug}`,
        (access) =>
          createAdminLabelset(slug, access, {
            title: title.trim(),
            multiple,
            labels,
          }),
      )
      authority.controller.assertCurrent(context)
      if (result === undefined) return
      if (result?.ok !== true || typeof result.id !== 'string' || !result.id) {
        throw new AdminAccessError()
      }
      setMessage({
        tone: 'ok',
        text: ui('Added "{title}" - it will appear once indexed.', { title: title.trim() }),
      })
      setTitle('')
      setSeed('')
      await onAdded()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: localError(err, 'Could not add that category - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rp-card min-w-0 p-5 lg:p-6'>
      <SectionHeader className='rp-manage-section-head' title={ui('Add a category')} />
      <form onSubmit={onSubmit} className='mt-4 space-y-3'>
        <div>
          <label
            htmlFor='taxonomy-name'
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            {ui('Name')}
          </label>
          <input
            id='taxonomy-name'
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={ui('e.g. Region')}
            autoComplete='off'
            required
          />
        </div>

        <div>
          <p className='mb-1.5 block text-sm font-medium text-ink'>{ui('Values per resource')}</p>
          <div className='rp-seg'>
            <button
              type='button'
              aria-pressed={!multiple}
              onClick={() => setMultiple(false)}
              className='rp-seg-item'
            >
              {ui('Single')}
            </button>
            <button
              type='button'
              aria-pressed={multiple}
              onClick={() => setMultiple(true)}
              className='rp-seg-item'
            >
              {ui('Multiple')}
            </button>
          </div>
        </div>

        <div>
          <label
            htmlFor='taxonomy-seed'
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            {ui('Seed values')}
          </label>
          <input
            id='taxonomy-seed'
            className={inputClass}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder={ui('Comma-separated, e.g. North, South, East, West')}
            autoComplete='off'
          />
        </div>

        <Button type='submit' disabled={busy} leadingIcon={Plus}>
          {busy ? ui('Adding…') : ui('Add category')}
        </Button>
      </form>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

function LabelsetCardSkeleton() {
  return (
    <div className='rp-card min-w-0 p-5 lg:p-6'>
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
  return (
    <AdminPageAccess>
      <TaxonomyContent />
    </AdminPageAccess>
  )
}

function TaxonomyContent() {
  const { ui } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const queryClient = useQueryClient()
  const { sessionAllowed } = usePermissionAdminAccess('taxonomy.write', { kind: 'portal', slug })

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
    <main className='rp-shell py-8 lg:py-10'>
      <h1 className='rp-display text-2xl text-ink sm:text-3xl'>{ui('Taxonomy')}</h1>
      <p className='mt-1 text-sm text-ink-3'>
        {ui('Categories used to classify resources. Counts reflect indexed content.')}
      </p>

      {isLoading && (
        <div className='mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2'>
          <LabelsetCardSkeleton />
          <LabelsetCardSkeleton />
        </div>
      )}

      {isError && (
        <div className='mt-8'>
          <ErrorCard
            message={error instanceof Error ? error.message : ui('Could not load the taxonomy.')}
            onRetry={() => void refetch()}
          />
        </div>
      )}

      {labelsets && (
        <>
          <div className='mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2'>
            {visible.map((ls) => (
              <LabelsetCard
                key={ls.id}
                labelset={ls}
                counts={facets?.[ls.id] ?? {}}
                organisation={config.branding.organisation}
                resources={counters?.resources}
              />
            ))}
            {sessionAllowed
              ? (
                <AddLabelsetCard
                  slug={slug}
                  onAdded={refreshAll}
                />
              )
              : null}
          </div>
          {hiddenCount > 0
            ? (
              <p className='mt-4 text-xs text-ink-3'>
                {ui(
                  hiddenCount === 1
                    ? '{count} category with no indexed values is not shown.'
                    : '{count} categories with no indexed values are not shown.',
                  { count: hiddenCount },
                )}
              </p>
            )
            : null}
        </>
      )}
    </main>
  )
}
