import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import { createInvestigation, type InvestigationMeta, listInvestigations } from '../api/client.ts'
import { MakeCurrentToggle, useCurrentInvestigation } from '../components/SaveEvidence.tsx'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Investigations - the research workspace list. Each investigation is a named
// question that accumulates evidence, sessions and outputs over time; this
// page is the entry point and the "start one" affordance.
// ---------------------------------------------------------------------------

/** Coarse relative time - "3 hours ago" - good enough for a last-updated hint. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.round(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} ${day === 1 ? 'day' : 'days'} ago`
  const month = Math.round(day / 30)
  if (month < 12) return `${month} ${month === 1 ? 'month' : 'months'} ago`
  const year = Math.round(month / 12)
  return `${year} ${year === 1 ? 'year' : 'years'} ago`
}

function StatusBadge({ status }: { status: 'active' | 'closed' }) {
  return status === 'active'
    ? <span className='rp-badge rp-badge-ok'>Active</span>
    : <span className='rp-badge rp-badge-quiet'>Closed</span>
}

function InvestigationCard(
  { slug, investigation }: { slug: string; investigation: InvestigationMeta },
) {
  const current = useCurrentInvestigation(slug)
  const isCurrent = current?.id === investigation.id

  return (
    <div className='rp-card relative flex flex-col gap-2.5 p-4 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'>
      <Link
        to={`/t/${slug}/investigations/${investigation.id}`}
        aria-label={investigation.name || 'Untitled investigation'}
        className='rp-focus absolute inset-0 rounded-[inherit]'
      />
      <div className='flex items-start justify-between gap-3'>
        <h3 className='min-w-0 truncate text-sm font-semibold text-ink'>{investigation.name}</h3>
        <div className='flex shrink-0 items-center gap-1.5'>
          {isCurrent ? <span className='rp-badge rp-badge-ok'>Current</span> : null}
          <StatusBadge status={investigation.status} />
        </div>
      </div>
      {investigation.question
        ? <p className='rp-clamp-2 text-sm leading-relaxed text-ink-2'>{investigation.question}</p>
        : <p className='text-sm italic text-ink-3'>No research question set</p>}
      <div className='mt-auto flex items-center justify-between gap-3 pt-1 text-xs text-ink-3'>
        <span>
          {investigation.evidenceCount} {investigation.evidenceCount === 1 ? 'item' : 'items'}{' '}
          of evidence
        </span>
        <span>Updated {timeAgo(investigation.updatedAt)}</span>
      </div>
      <div className='relative z-10 flex justify-end'>
        <MakeCurrentToggle slug={slug} investigation={investigation} />
      </div>
    </div>
  )
}

function CreateInvestigationForm({ slug }: { slug: string }) {
  const [name, setName] = useState('')
  const [question, setQuestion] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: () =>
      createInvestigation(slug, { name: name.trim(), question: question.trim() || undefined }),
    onSuccess: (investigation) => {
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      navigate(`/t/${slug}/investigations/${investigation.id}`)
    },
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim().length === 0 || mutation.isPending) return
    mutation.mutate()
  }

  return (
    <form onSubmit={onSubmit} className='rp-card flex flex-col gap-3 p-5'>
      <div>
        <label htmlFor='investigation-name' className='mb-1.5 block text-sm font-medium text-ink'>
          Name
        </label>
        <input
          id='investigation-name'
          type='text'
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder='e.g. Does controlled traffic farming pay off on heavy clay?'
          className='rp-input'
          required
        />
      </div>
      <div>
        <label
          htmlFor='investigation-question'
          className='mb-1.5 block text-sm font-medium text-ink'
        >
          Research question <span className='font-normal text-ink-3'>(optional)</span>
        </label>
        <input
          id='investigation-question'
          type='text'
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder='The question this investigation is trying to answer'
          className='rp-input'
        />
      </div>
      {mutation.isError
        ? (
          <p className='text-sm' style={{ color: 'var(--rp-bad-ink)' }}>
            Could not start the investigation - try again.
          </p>
        )
        : null}
      <div>
        <button
          type='submit'
          disabled={mutation.isPending || name.trim().length === 0}
          className='rp-btn rp-btn-primary'
        >
          {mutation.isPending ? 'Starting…' : 'Start investigation'}
        </button>
      </div>
    </form>
  )
}

export function InvestigationsPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['investigations', config.slug],
    queryFn: () => listInvestigations(config.slug),
  })

  const sorted = data
    ? [...data].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    : []

  return (
    <main className='mx-auto max-w-6xl px-6 py-10'>
      <h1 className='text-2xl font-semibold tracking-tight text-ink'>Investigations</h1>
      <p className='mt-1 text-sm text-ink-3'>
        Named research questions that accumulate evidence, sessions and outputs.
      </p>

      <div className='mt-6 max-w-2xl'>
        <CreateInvestigationForm slug={config.slug} />
      </div>

      <div className='mt-8'>
        {isLoading
          ? (
            <div className='space-y-3'>
              {[0, 1, 2].map((i) => <Skeleton key={i} className='h-24 w-full' />)}
            </div>
          )
          : null}

        {isError
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load investigations.'}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {!isLoading && !isError && sorted.length === 0
          ? (
            <EmptyState
              title='No investigations yet'
              description='Start an investigation to keep every passage, verdict and note you gather - your conclusions stay linked to their evidence.'
            />
          )
          : null}

        {!isLoading && !isError && sorted.length > 0
          ? (
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
              {sorted.map((investigation) => (
                <InvestigationCard
                  key={investigation.id}
                  slug={config.slug}
                  investigation={investigation}
                />
              ))}
            </div>
          )
          : null}
      </div>
    </main>
  )
}
