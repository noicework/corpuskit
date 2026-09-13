import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
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
  suggestion,
  onDecided,
}: {
  slug: string
  suggestion: SetupSuggestion
  onDecided: (status: SetupSuggestion['status']) => void
}) {
  const { runExplicit, sessionAllowed, breakGlassEnabled } = usePermissionAdminAccess(
    'behaviour.write',
    {
      kind: 'portal',
      slug,
    },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const subPermission = suggestion.kind === 'labelset' || suggestion.kind === 'label-addition'
    ? 'taxonomy.write'
    : suggestion.kind === 'entity-type' || suggestion.kind === 'graph-example'
    ? 'graph.write'
    : null
  const canImplement = subPermission !== null &&
    (sessionAllowed ? authority.can(subPermission, { kind: 'portal', slug }) : breakGlassEnabled)
  const [busy, setBusy] = useState<'implement' | 'ignore' | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const refresh = () => {
    assertCurrent()
    if (sessionAllowed) void queryClient.invalidateQueries({ queryKey: ['suggestions', slug] })
    void queryClient.invalidateQueries({ queryKey: ['labelsets', slug] })
  }

  const implement = async () => {
    if (!canImplement) return
    assertCurrent()
    setBusy('implement')
    setError(null)
    try {
      const result = await runExplicit('Implement this setup suggestion', async (access) => {
        assertCurrent()
        if (
          subPermission === null ||
          (sessionAllowed && !authority.can(subPermission, { kind: 'portal', slug }))
        ) throw new AdminAccessError()
        const result = await implementSuggestion(slug, access, suggestion.id)
        if (result?.ok !== true || typeof result.summary !== 'string') throw new AdminAccessError()
        return result
      })
      assertCurrent()
      if (result === undefined) return
      onDecided('implemented')
      setOutcome(result.summary)
      refresh()
    } catch (err) {
      if (context !== authority.controller.context) return
      setError(err instanceof Error ? err.message : 'Could not implement this suggestion.')
    } finally {
      if (context === authority.controller.context) setBusy(null)
    }
  }

  const ignore = async () => {
    setBusy('ignore')
    setError(null)
    try {
      const result = await runExplicit('Ignore this setup suggestion', async (access) => {
        const result = await ignoreSuggestion(slug, access, suggestion.id)
        if (result?.ok !== true) throw new AdminAccessError()
        return true
      })
      assertCurrent()
      if (result === undefined) return
      onDecided('ignored')
      refresh()
    } catch (err) {
      if (context !== authority.controller.context) return
      setError(err instanceof Error ? err.message : 'Could not update the suggestion.')
    } finally {
      if (context === authority.controller.context) setBusy(null)
    }
  }

  const status = suggestion.status
  const decided = status !== 'pending'

  return (
    <div
      data-suggestion={suggestion.id}
      className={`rounded-[var(--rp-radius)] border border-line bg-surface p-3.5 ${
        decided ? 'opacity-70' : ''
      }`}
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='rp-badge'>
              {KIND_COPY[suggestion.kind] ?? 'Unsupported suggestion'}
            </span>
            {status === 'implemented'
              ? <span className='text-xs font-medium text-[var(--rp-ok-ink)]'>Implemented</span>
              : status === 'ignored'
              ? <span className='text-xs text-ink-3'>Ignored</span>
              : null}
          </div>
          <h4 className='mt-1.5 text-sm font-semibold text-ink'>{suggestion.title}</h4>
          <p className='mt-0.5 text-xs text-ink-2'>{suggestion.detail}</p>
          <SuggestionBody suggestion={suggestion} />
        </div>
        {!decided
          ? (
            <div className='flex max-w-full flex-wrap gap-1.5'>
              {canImplement && (
                <button
                  type='button'
                  disabled={busy !== null}
                  data-suggestion-implement
                  onClick={() => void implement()}
                  className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
                >
                  {busy === 'implement' ? 'Implementing…' : 'Implement'}
                </button>
              )}
              <button
                type='button'
                disabled={busy !== null}
                data-suggestion-ignore
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

function InterrogatePanelContent({ slug }: { slug: string }) {
  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess(
    'behaviour.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [snapshot, setSnapshot] = useState<SetupSuggestion[]>()
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: sessionSuggestions, isLoading } = useQuery({
    queryKey: ['suggestions', slug],
    queryFn: () => getSuggestions(slug, sessionAccess),
    staleTime: 30_000,
    enabled: sessionAllowed,
    retry: false,
  })

  const suggestions = sessionAllowed ? sessionSuggestions : snapshot
  const interrogate = async (readOnly = false) => {
    setRunning(true)
    setRunError(null)
    try {
      const fresh = await runExplicit(
        readOnly ? 'Load setup suggestions' : 'Interrogate this knowledge box',
        async (access) => {
          const result = await (readOnly ? getSuggestions : runInterrogation)(slug, access)
          if (
            !Array.isArray(result) ||
            result.some((item) =>
              !item || typeof item.id !== 'string' || typeof item.title !== 'string' ||
              typeof item.detail !== 'string' ||
              !['pending', 'implemented', 'ignored'].includes(item.status) ||
              !Object.hasOwn(KIND_COPY, item.kind) ||
              (item.labelset !== undefined &&
                (!Array.isArray(item.labelset?.labels) ||
                  item.labelset.labels.some((label) => typeof label !== 'string'))) ||
              (item.labels !== undefined &&
                (!Array.isArray(item.labels?.labels) ||
                  item.labels.labels.some((label) => typeof label !== 'string'))) ||
              (item.entityType !== undefined &&
                (typeof item.entityType?.label !== 'string' ||
                  typeof item.entityType?.description !== 'string')) ||
              (item.example !== undefined &&
                (typeof item.example?.text !== 'string' || !Array.isArray(item.example.relations) ||
                  item.example.relations.some((relation) =>
                    !relation ||
                    [relation.source, relation.target, relation.label].some((value) =>
                      typeof value !== 'string'
                    )
                  )))
            )
          ) throw new AdminAccessError()
          return result
        },
      )
      assertCurrent()
      if (fresh === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['suggestions', slug], fresh)
      else setSnapshot(fresh)
    } catch (err) {
      if (context !== authority.controller.context) return
      setRunError(
        err instanceof Error ? err.message : 'The interrogation could not complete - try again.',
      )
    } finally {
      if (context === authority.controller.context) setRunning(false)
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
      <button
        type='button'
        data-suggestions-read
        className='rp-btn rp-btn-outline mt-3'
        disabled={running}
        onClick={() => void interrogate(true)}
      >
        Load suggestions
      </button>
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
                suggestion={suggestion}
                onDecided={(status) => {
                  if (!sessionAllowed) {
                    setSnapshot((items) =>
                      items?.map((item) => item.id === suggestion.id ? { ...item, status } : item)
                    )
                  }
                }}
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
                  suggestion={suggestion}
                  onDecided={(status) => {
                    if (!sessionAllowed) {
                      setSnapshot((items) =>
                        items?.map((item) => item.id === suggestion.id ? { ...item, status } : item)
                      )
                    }
                  }}
                />
              ))}
            </div>
          </details>
        )
        : null}
    </div>
  )
}

export function InterrogatePanel(props: { slug: string }) {
  const authority = useAccess()
  const permission = usePermissionAdminAccess('behaviour.write', {
    kind: 'portal',
    slug: props.slug,
  })
  if (
    authority.state.status !== 'ready' ||
    (!permission.sessionAllowed && !permission.breakGlassEnabled)
  ) return null
  return <InterrogatePanelContent key={`${props.slug}:${authority.generation}`} {...props} />
}
