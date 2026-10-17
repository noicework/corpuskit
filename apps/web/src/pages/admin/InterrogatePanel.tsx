import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSuggestions,
  ignoreSuggestion,
  implementSuggestion,
  runInterrogation,
  type SetupSuggestion,
} from '../../api/client.ts'
import { Button, SectionHeader, Skeleton } from '../../components/ui.tsx'
import { Check, ChevronDown, RotateCw, Sparkles, X } from '../../components/icons.tsx'

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
  const { ui } = usePortalLocale()

  if (suggestion.kind === 'labelset' && suggestion.labelset) {
    return (
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-ink-3'>
          {suggestion.labelset.paragraphs ? ui('Passage-level') : ui('Document-level')}:
        </span>
        {suggestion.labelset.labels.map((label) => (
          <span key={label} className='rp-tag'>{label}</span>
        ))}
      </div>
    )
  }
  if (suggestion.kind === 'label-addition' && suggestion.labels) {
    return (
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        <span className='text-xs text-ink-3'>{ui('Add to ')}{suggestion.labels.labelsetId}:</span>
        {suggestion.labels.labels.map((label) => (
          <span key={label} className='rp-tag'>{label}</span>
        ))}
      </div>
    )
  }
  if (suggestion.kind === 'entity-type' && suggestion.entityType) {
    return (
      <p className='mt-2 text-xs text-ink-2'>
        <span className='rp-tag mr-1.5'>{suggestion.entityType.label}</span>
        {suggestion.entityType.description}
      </p>
    )
  }
  if (suggestion.kind === 'graph-example' && suggestion.example) {
    return (
      <div className='mt-2 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-2.5'>
        <p className='text-xs italic text-ink-2'>
          {ui('“')}
          {suggestion.example.text}
          {ui('”')}
        </p>
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
  const { ui, error: localError } = usePortalLocale()

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
      const result = await runExplicit(ui('Implement this setup suggestion'), async (access) => {
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
      const result = await runExplicit(ui('Ignore this setup suggestion'), async (access) => {
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
      <div className='flex flex-col items-start gap-3 sm:flex-row sm:justify-between'>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='rp-tag'>
              {KIND_COPY[suggestion.kind] ?? ui('Unsupported suggestion')}
            </span>
            {status === 'implemented'
              ? (
                <span className='rp-badge rp-badge-ok'>
                  {ui('Implemented')}
                </span>
              )
              : status === 'ignored'
              ? <span className='rp-badge rp-badge-quiet'>{ui('Ignored')}</span>
              : null}
          </div>
          <h3 className='mt-1.5 text-sm font-semibold text-ink'>{suggestion.title}</h3>
          <p className='mt-0.5 text-xs text-ink-2'>{suggestion.detail}</p>
          <SuggestionBody suggestion={suggestion} />
        </div>
        {!decided
          ? (
            <div className='flex max-w-full flex-wrap gap-1.5'>
              {canImplement && (
                <Button
                  size='sm'
                  leadingIcon={Check}
                  disabled={busy !== null}
                  data-suggestion-implement
                  onClick={() => void implement()}
                >
                  {busy === 'implement' ? ui('Implementing…') : ui('Implement')}
                </Button>
              )}
              <Button
                variant='ghost'
                size='sm'
                leadingIcon={X}
                disabled={busy !== null}
                data-suggestion-ignore
                onClick={() => void ignore()}
              >
                {ui('Ignore')}
              </Button>
            </div>
          )
          : null}
      </div>
      {outcome ? <p className='mt-2 text-xs text-[var(--rp-ok-ink)]'>{outcome}</p> : null}
      {error
        ? (
          <p className='mt-2 text-xs text-[var(--rp-bad-ink)]'>
            {localError(error, 'The action failed. Please try again.')}
          </p>
        )
        : null}
    </div>
  )
}

function InterrogatePanelContent({ slug }: { slug: string }) {
  const { ui, error: localError } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess(
    'behaviour.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [snapshot, setSnapshot] = useState<SetupSuggestion[]>()
  const [running, setRunning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyId = useId()
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
        readOnly ? ui('Load setup suggestions') : ui('Interrogate this knowledge box'),
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
    <div>
      <SectionHeader
        className='rp-manage-section-head'
        title={ui('Interrogate the knowledge box')}
        description={ui(
          'Examines the corpus and current setup, then proposes discrete improvements to labelsets and the knowledge graph - implement or ignore each with one click.',
        )}
        actions={
          <>
            <Button
              variant='ghost'
              size='sm'
              leadingIcon={RotateCw}
              data-suggestions-read
              disabled={running}
              onClick={() => void interrogate(true)}
            >
              {ui('Load suggestions')}
            </Button>
            <Button leadingIcon={Sparkles} disabled={running} onClick={() => void interrogate()}>
              {running ? ui('Interrogating…') : ui('Run interrogation')}
            </Button>
          </>
        }
      />
      {running
        ? (
          <p className='mt-3 text-xs text-ink-3' role='status'>
            {ui(
              'Reading the corpus and comparing it with the current setup - this takes up to half a minute…',
            )}
          </p>
        )
        : null}
      {runError
        ? (
          <p className='mt-3 text-xs text-[var(--rp-bad-ink)]'>
            {localError(runError, 'The interrogation could not complete - try again.')}
          </p>
        )
        : null}

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
            {ui('No pending suggestions - run an interrogation to generate some.')}
          </p>
        )
        : null}

      {decided.length > 0
        ? (
          <div className='mt-4'>
            <Button
              variant='ghost'
              size='sm'
              aria-expanded={historyOpen}
              aria-controls={historyId}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <ChevronDown size='sm' className={historyOpen ? 'rotate-180' : ''} />
              {ui('Decision history (')}
              {decided.length})
            </Button>
            <div id={historyId} hidden={!historyOpen} className='mt-2 space-y-2'>
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
          </div>
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
