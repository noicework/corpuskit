import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { StaleAuthorityError } from '../api/access-lifecycle.ts'
import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import { createInvestigation, type InvestigationMeta, listInvestigations } from '../api/client.ts'
import { MakeCurrentToggle, useCurrentInvestigation } from '../components/SaveEvidence.tsx'
import { Button, EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import { Plus } from '../components/icons.tsx'
import { tenantCopy } from '../lib/tenant-copy.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Investigations - the research workspace list. Each investigation is a named
// question that accumulates evidence, sessions and outputs over time; this
// page is the entry point and the "start one" affordance.
// ---------------------------------------------------------------------------

/** Coarse relative time - "3 hours ago" - good enough for a last-updated hint. */
function timeAgo(iso: string, ui: ResearchUi = englishResearchUi): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.round(ms / 1000)
  if (sec < 60) return ui('just now')
  const min = Math.round(sec / 60)
  if (min < 60) return ui(min === 1 ? '{count} minute ago' : '{count} minutes ago', { count: min })
  const hr = Math.round(min / 60)
  if (hr < 24) return ui(hr === 1 ? '{count} hour ago' : '{count} hours ago', { count: hr })
  const day = Math.round(hr / 24)
  if (day < 30) return ui(day === 1 ? '{count} day ago' : '{count} days ago', { count: day })
  const month = Math.round(day / 30)
  if (month < 12) {
    return ui(month === 1 ? '{count} month ago' : '{count} months ago', { count: month })
  }
  const year = Math.round(month / 12)
  return ui(year === 1 ? '{count} year ago' : '{count} years ago', { count: year })
}

function StatusBadge({ status }: { status: 'active' | 'closed' }) {
  const { ui } = usePortalLocale()
  return status === 'active'
    ? <span className='rp-badge rp-badge-ok'>{ui('Active')}</span>
    : <span className='rp-badge rp-badge-quiet'>{ui('Closed')}</span>
}

function InvestigationCard(
  { slug, investigation }: { slug: string; investigation: InvestigationMeta },
) {
  const { ui } = usePortalLocale()
  const current = useCurrentInvestigation(slug)
  const isCurrent = current?.id === investigation.id

  return (
    <div className='rp-card relative flex flex-col gap-3 p-5 lg:p-6 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'>
      <Link
        to={`/t/${slug}/investigations/${investigation.id}`}
        aria-label={investigation.name || ui('Untitled investigation')}
        className='rp-focus absolute inset-0 rounded-[inherit]'
      />
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <h2 className='min-w-0 break-words text-base font-semibold text-ink'>
          {investigation.name}
        </h2>
        <div className='flex shrink-0 items-center gap-1.5'>
          {isCurrent ? <span className='rp-badge rp-badge-ok'>{ui('Current')}</span> : null}
          <StatusBadge status={investigation.status} />
        </div>
      </div>
      {investigation.question
        ? <p className='rp-clamp-2 text-sm leading-relaxed text-ink-2'>{investigation.question}</p>
        : <p className='text-sm italic text-ink-3'>{ui('No research question set')}</p>}
      <div className='mt-auto flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-ink-3'>
        <span>
          {ui(
            investigation.evidenceCount === 1
              ? '{count} item of evidence'
              : '{count} items of evidence',
            { count: investigation.evidenceCount },
          )}
        </span>
        <span>{ui('Updated')} {timeAgo(investigation.updatedAt, ui)}</span>
      </div>
      <div className='relative z-10 flex justify-end'>
        <MakeCurrentToggle slug={slug} investigation={investigation} />
      </div>
    </div>
  )
}

function CreateInvestigationForm({ slug }: { slug: string }) {
  const { ui, language } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const copy = tenantCopy(config, { language, ui })
  const access = useAccess()
  const context = access.controller.context
  const canWrite = () =>
    context === access.controller.context &&
    access.controller.can('portal.investigate', { kind: 'portal', slug })
  const [name, setName] = useState('')
  const [question, setQuestion] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: async () => {
      if (!canWrite()) throw new StaleAuthorityError()
      const result = await createInvestigation(slug, {
        name: name.trim(),
        question: question.trim() || undefined,
      })
      if (!canWrite()) throw new StaleAuthorityError()
      return result
    },
    onSuccess: (investigation) => {
      if (!canWrite()) return
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      navigate(`/t/${slug}/investigations/${investigation.id}`)
    },
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canWrite() || name.trim().length === 0 || mutation.isPending) return
    mutation.mutate()
  }

  return (
    <form onSubmit={onSubmit} className='rp-card flex flex-col gap-4 p-5 lg:p-6'>
      <div>
        <label htmlFor='investigation-name' className='mb-1.5 block text-sm font-medium text-ink'>
          {ui('Investigation name')}
        </label>
        {
          /* The investigation's name, not the reader's: the label says so, and the browser
            is told not to offer the person's own name (WCAG 1.3.5 applies to personal data). */
        }
        <input
          id='investigation-name'
          type='text'
          autoComplete='off'
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={copy.investigationExample}
          className='rp-input'
          required
        />
      </div>
      <div>
        <label
          htmlFor='investigation-question'
          className='mb-1.5 block text-sm font-medium text-ink'
        >
          {ui('Research question')}{' '}
          <span className='font-normal text-ink-3'>{ui('(optional)')}</span>
        </label>
        <input
          id='investigation-question'
          type='text'
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={ui('The question this investigation is trying to answer')}
          className='rp-input'
        />
      </div>
      {mutation.isError
        ? (
          <p className='text-sm' style={{ color: 'var(--rp-bad-ink)' }}>
            {ui('Could not start the investigation - try again.')}
          </p>
        )
        : null}
      <div>
        <Button
          type='submit'
          leadingIcon={Plus}
          disabled={mutation.isPending || name.trim().length === 0}
        >
          {mutation.isPending ? ui('Starting…') : ui('Start investigation')}
        </Button>
      </div>
    </form>
  )
}

export function InvestigationsPage() {
  const { ui } = usePortalLocale()
  const access = useAccess()
  const { config } = useOutletContext<TenantOutletContext>()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['investigations', config.slug],
    queryFn: () => listInvestigations(config.slug),
    enabled: access.can('portal.read', { kind: 'portal', slug: config.slug }),
  })

  const sorted = data
    ? [...data].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    : []

  return (
    <main className='rp-shell py-8 lg:py-10'>
      <h1 className='rp-display text-2xl sm:text-3xl text-ink'>{ui('Investigations')}</h1>
      <p className='rp-measure mt-1 text-sm text-ink-2'>
        {ui('Named research questions that accumulate evidence, sessions and outputs.')}
      </p>

      {access.can('portal.investigate', { kind: 'portal', slug: config.slug })
        ? (
          <div className='mt-6 max-w-2xl'>
            <CreateInvestigationForm slug={config.slug} />
          </div>
        )
        : null}

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
              message={error instanceof Error
                ? error.message
                : ui('Could not load investigations.')}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {!isLoading && !isError && sorted.length === 0
          ? (
            <EmptyState
              title={ui('No investigations yet')}
              description={access.can('portal.investigate', { kind: 'portal', slug: config.slug })
                ? ui(
                  'Start an investigation to keep every passage, verdict and note you gather - your conclusions stay linked to their evidence.',
                )
                : ui('Your saved investigations will appear here.')}
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
