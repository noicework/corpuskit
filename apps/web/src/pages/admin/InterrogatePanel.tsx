import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSuggestions,
  ignoreSuggestion,
  implementSuggestion,
  runInterrogation,
  type SetupSuggestion,
} from '../../api/client.ts'
import { Skeleton } from '../../components/ui.tsx'

// ---------------------------------------------------------------------------
// Knowledge-box interrogation: one click examines the corpus and current
// setup, then proposes discrete improvements - new labelsets, missing
// labels, extra entity types, extra worked examples. Each suggestion is a
// card with Implement / Ignore, so curation is a series of quick decisions.
// ---------------------------------------------------------------------------

const KIND_COPY: Record<SetupSuggestion['kind'], string> = {
  'labelset': 'New labelset',
  'label-addition': 'Extend labelset',
  'entity-type': 'New entity type',
  'graph-example': 'Graph example',
}

function SuggestionBody({ suggestion }: { suggestion: SetupSuggestion }) {
  if (suggestion.kind === 'labelset' && suggestion.labelset) {
    return (
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-ink-3'>
          {suggestion.labelset.paragraphs ? 'Passage-level' : 'Document-level'}:
        </span>
        {suggestion.labelset.labels.map((label) => (
          <span key={label} className='rp-chip text-xs'>{label}</span>
        ))}
      </div>
    )
  }
  if (suggestion.kind === 'label-addition' && suggestion.labels) {
    return (
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-ink-3'>Add to {suggestion.labels.labelsetId}:</span>
        {suggestion.labels.labels.map((label) => (
          <span key={label} className='rp-chip text-xs'>{label}</span>
        ))}
      </div>
    )
  }
  if (suggestion.kind === 'entity-type' && suggestion.entityType) {
    return (
      <p className='mt-2 text-xs text-ink-2'>
        <span className='rp-chip mr-1.5 text-xs'>{suggestion.entityType.label}</span>
        {suggestion.entityType.description}
      </p>
    )
  }
  if (suggestion.kind === 'graph-example' && suggestion.example) {
    return (
      <div className='mt-2 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-2.5'>
        <p className='text-xs italic text-ink-2'>&ldquo;{suggestion.example.text}&rdquo;</p>
        {suggestion.example.relations.length > 0
          ? (
            <p className='mt-1.5 text-xs text-ink-3'>
              {suggestion.example.relations.map((relation, index) => (
                <span key={index}>
                  {index > 0 ? ' · ' : ''}
                  <span className='text-ink'>{relation.source}</span> {relation.label}{' '}
                  <span className='text-ink'>{relation.target}</span>
                </span>
              ))}
            </p>
          )
          : null}
      </div>
    )
  }
  return null
}

function SuggestionCard({
  slug,
  passcode,
  suggestion,
}: {
  slug: string
  passcode: string
  suggestion: SetupSuggestion
}) {
  const [busy, setBusy] = useState<'implement' | 'ignore' | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['suggestions', slug] })
    void queryClient.invalidateQueries({ queryKey: ['labelsets', slug] })
  }

  const implement = async () => {
    setBusy('implement')
    setError(null)
    try {
      const result = await implementSuggestion(slug, passcode, suggestion.id)
      setOutcome(result.summary)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not implement this suggestion.')
    } finally {
      setBusy(null)
    }
  }

  const ignore = async () => {
    setBusy('ignore')
    setError(null)
    try {
      await ignoreSuggestion(slug, passcode, suggestion.id)
      refresh()
    } catch {
      setError('Could not update the suggestion - try again.')
    } finally {
      setBusy(null)
    }
  }

  const decided = suggestion.status !== 'pending'

  return (
    <div
      className={`rounded-[var(--rp-radius)] border border-line bg-surface p-3.5 ${
        decided ? 'opacity-70' : ''
      }`}
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='rp-badge'>{KIND_COPY[suggestion.kind]}</span>
            {suggestion.status === 'implemented'
              ? <span className='text-xs font-medium text-[var(--rp-ok-ink)]'>Implemented</span>
              : suggestion.status === 'ignored'
              ? <span className='text-xs text-ink-3'>Ignored</span>
              : null}
          </div>
          <h4 className='mt-1.5 text-sm font-semibold text-ink'>{suggestion.title}</h4>
          <p className='mt-0.5 text-xs text-ink-2'>{suggestion.detail}</p>
          <SuggestionBody suggestion={suggestion} />
        </div>
        {!decided
          ? (
            <div className='flex shrink-0 gap-1.5'>
              <button
                type='button'
                disabled={busy !== null}
                onClick={() => void implement()}
                className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
              >
                {busy === 'implement' ? 'Implementing…' : 'Implement'}
              </button>
              <button
                type='button'
                disabled={busy !== null}
                onClick={() => void ignore()}
                className='rp-btn rp-btn-ghost h-8 px-2.5 text-xs'
              >
                Ignore
              </button>
            </div>
          )
          : null}
      </div>
      {outcome ? <p className='mt-2 text-xs text-[var(--rp-ok-ink)]'>{outcome}</p> : null}
      {error ? <p className='mt-2 text-xs text-[var(--rp-bad-ink)]'>{error}</p> : null}
    </div>
  )
}

export function InterrogatePanel({ slug, passcode }: { slug: string; passcode: string }) {
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['suggestions', slug],
    queryFn: () => getSuggestions(slug, passcode),
    staleTime: 30_000,
  })

  const interrogate = async () => {
    setRunning(true)
    setRunError(null)
    try {
      const fresh = await runInterrogation(slug, passcode)
      queryClient.setQueryData(['suggestions', slug], fresh)
    } catch (err) {
      setRunError(
        err instanceof Error ? err.message : 'The interrogation could not complete - try again.',
      )
    } finally {
      setRunning(false)
    }
  }

  const pending = (suggestions ?? []).filter((s) => s.status === 'pending')
  const decided = (suggestions ?? []).filter((s) => s.status !== 'pending')

  return (
    <div className='mt-6 border-t border-line pt-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-ink'>Interrogate the knowledge box</h3>
          <p className='mt-0.5 text-xs text-ink-2'>
            Examines the corpus and current setup, then proposes discrete improvements to labelsets
            and the knowledge graph - implement or ignore each with one click.
          </p>
        </div>
        <button
          type='button'
          disabled={running}
          onClick={() => void interrogate()}
          className='rp-btn rp-btn-primary'
        >
          {running ? 'Interrogating…' : 'Run interrogation'}
        </button>
      </div>
      {running
        ? (
          <p className='mt-3 text-xs text-ink-3' role='status'>
            Reading the corpus and comparing it with the current setup - this takes up to half a
            minute…
          </p>
        )
        : null}
      {runError ? <p className='mt-3 text-xs text-[var(--rp-bad-ink)]'>{runError}</p> : null}

      {isLoading ? <Skeleton className='mt-4 h-20' /> : null}

      {pending.length > 0
        ? (
          <div className='mt-4 space-y-2.5'>
            {pending.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                slug={slug}
                passcode={passcode}
                suggestion={suggestion}
              />
            ))}
          </div>
        )
        : !isLoading && !running
        ? (
          <p className='mt-4 text-xs text-ink-3'>
            No pending suggestions - run an interrogation to generate some.
          </p>
        )
        : null}

      {decided.length > 0
        ? (
          <details className='mt-4'>
            <summary className='cursor-pointer text-xs text-ink-3'>
              Decision history ({decided.length})
            </summary>
            <div className='mt-2 space-y-2'>
              {decided.slice(0, 12).map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  slug={slug}
                  passcode={passcode}
                  suggestion={suggestion}
                />
              ))}
            </div>
          </details>
        )
        : null}
    </div>
  )
}
