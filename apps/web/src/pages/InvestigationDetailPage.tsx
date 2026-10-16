import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { StaleAuthorityError } from '../api/access-lifecycle.ts'
import {
  exportResearchFile,
  researchExportAuthority,
  type ResearchFile,
} from '../lib/research-export.ts'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  ApiError,
  deleteEvidence,
  deleteInvestigation,
  type EvidenceItem,
  type EvidenceVerdict,
  getInvestigation,
  getResource,
  type Investigation,
  type InvestigationArtefact,
  synthesiseInvestigation,
  updateEvidence,
  updateInvestigation,
} from '../api/client.ts'
import { MakeCurrentToggle } from '../components/SaveEvidence.tsx'
import {
  EmptyState,
  ErrorCard,
  ExportNotice,
  savedFileNotice,
  Skeleton,
  useExportNotice,
} from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Investigation detail - the heart of the research workspace. A named
// question, a notebook, an accumulating evidence list with per-item verdicts,
// and whatever artefacts other tools have saved into it. Everything here
// writes straight through the typed client; the whole investigation is one
// query (['investigation', slug, id]) so any mutation just invalidates it.
// ---------------------------------------------------------------------------

function useInvestigationAuthority(slug: string) {
  const access = useAccess()
  const context = access.controller.context
  const lifetime = useRef(new AbortController())
  useLayoutEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [])
  const canWrite = () =>
    !lifetime.current.signal.aborted &&
    context === access.controller.context &&
    access.controller.can('portal.investigate', { kind: 'portal', slug })
  const run = async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (!canWrite()) throw new StaleAuthorityError()
    const result = await operation()
    if (!canWrite()) throw new StaleAuthorityError()
    return result
  }
  return { access, canWrite, run, signal: () => lifetime.current.signal }
}

/**
 * A score is normally 0-1, shown as a percentage. A legacy item can carry a
 * score already stored as a percent (>1) - treat that as already-percent
 * rather than multiplying it again, and cap either case at 100.
 */
function formatScorePercent(score: number): number {
  const pct = score <= 1 ? score * 100 : score
  return Math.min(100, Math.round(pct))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// --- Editable text field: click to reveal a pencil, click to edit inline ----

function EditableField({
  value,
  placeholder,
  ariaLabel,
  onSave,
  className,
  editable,
}: {
  editable: boolean
  value: string
  placeholder: string
  ariaLabel: string
  onSave: (next: string) => void
  className?: string
}) {
  const { ui } = usePortalLocale()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== value.trim()) onSave(next)
  }

  const cancel = () => {
    setDraft(value)
    setEditing(false)
  }

  if (!editable) {
    return (
      <p className={`break-words ${className ?? ''}`}>
        {value ||
          (ariaLabel === 'Research question' ? ui('No research question set') : placeholder)}
      </p>
    )
  }

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={ui(ariaLabel)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') cancel()
        }}
        onBlur={commit}
        placeholder={placeholder}
        className={`rp-input ${className ?? ''}`}
      />
    )
  }

  return (
    <button
      type='button'
      onClick={() => setEditing(true)}
      className='rp-focus group flex min-w-0 max-w-full items-center gap-1.5 rounded-[var(--rp-radius-btn)] text-left'
    >
      <span className={`truncate ${value ? '' : 'italic text-ink-3'} ${className ?? ''}`}>
        {value || placeholder}
      </span>
      <svg
        viewBox='0 0 20 20'
        fill='currentColor'
        aria-hidden='true'
        className='h-3.5 w-3.5 shrink-0 text-ink-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100'
      >
        <path d='M14.69 2.86a1.5 1.5 0 012.12 0l.33.33a1.5 1.5 0 010 2.12L7.56 14.89l-3.02.67a.5.5 0 01-.6-.6l.67-3.02L14.69 2.86z' />
      </svg>
    </button>
  )
}

// --- A two-click confirm, no window.confirm ---------------------------------

function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className,
  confirmClassName,
}: {
  label: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
  confirmClassName?: string
}) {
  const [confirming, setConfirming] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  if (confirming) {
    return (
      <button
        type='button'
        disabled={disabled}
        onClick={() => {
          if (timerRef.current) clearTimeout(timerRef.current)
          setConfirming(false)
          onConfirm()
        }}
        className={confirmClassName ?? 'rp-btn rp-btn-danger'}
      >
        {confirmLabel}
      </button>
    )
  }

  return (
    <button
      type='button'
      disabled={disabled}
      onClick={() => {
        setConfirming(true)
        timerRef.current = setTimeout(() => setConfirming(false), 4000)
      }}
      className={className ?? 'rp-btn rp-btn-outline'}
    >
      {label}
    </button>
  )
}

// --- Header: name, question, status, ask, delete ----------------------------

function InvestigationHeader(
  { slug, investigation }: { slug: string; investigation: Investigation },
) {
  const { ui } = usePortalLocale()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { canWrite, run } = useInvestigationAuthority(slug)

  const patch = useMutation({
    mutationFn: (input: { name?: string; question?: string; status?: 'active' | 'closed' }) =>
      run(() => updateInvestigation(slug, investigation.id, input)),
    onSuccess: () => {
      if (!canWrite()) return
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigation.id] })
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => run(() => deleteInvestigation(slug, investigation.id)),
    onSuccess: () => {
      if (!canWrite()) return
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      navigate(`/t/${slug}/investigations`)
    },
  })

  return (
    <div className='rp-card p-5'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0 flex-1'>
          <EditableField
            editable={canWrite()}
            value={investigation.name}
            placeholder={ui('Untitled investigation')}
            ariaLabel='Investigation name'
            onSave={(name) => {
              if (name.length > 0) patch.mutate({ name })
            }}
            className='text-xl font-semibold tracking-tight text-ink'
          />
          <div className='mt-1.5'>
            <EditableField
              editable={canWrite()}
              value={investigation.question}
              placeholder={ui('No research question set - click to add one')}
              ariaLabel='Research question'
              onSave={(question) => patch.mutate({ question })}
              className='text-sm text-ink-2'
            />
          </div>
        </div>
        <span className='shrink-0'>
          {investigation.status === 'active'
            ? <span className='rp-badge rp-badge-ok'>{ui('Active')}</span>
            : <span className='rp-badge rp-badge-quiet'>{ui('Closed')}</span>}
        </span>
      </div>

      <div className='mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4'>
        {investigation.question.length > 0
          ? (
            <Link
              to={`/t/${slug}/ask?ask=${encodeURIComponent(investigation.question)}`}
              className='rp-btn rp-btn-primary'
            >
              {ui('Ask this question')}
            </Link>
          )
          : null}
        {canWrite()
          ? (
            <button
              type='button'
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate({ status: investigation.status === 'active' ? 'closed' : 'active' })}
              className='rp-btn rp-btn-outline'
            >
              {investigation.status === 'active'
                ? ui('Close investigation')
                : ui('Reopen investigation')}
            </button>
          )
          : null}
        <MakeCurrentToggle slug={slug} investigation={investigation} />
        {canWrite()
          ? (
            <div className='ml-auto'>
              <ConfirmButton
                label={ui('Delete')}
                confirmLabel={ui('Confirm delete')}
                disabled={removeMutation.isPending}
                onConfirm={() => removeMutation.mutate()}
                className='rp-btn rp-btn-ghost text-[var(--rp-bad-ink)]'
                confirmClassName='rp-btn rp-btn-danger'
              />
            </div>
          )
          : null}
      </div>
    </div>
  )
}

// --- Notebook: debounced free-form notes ------------------------------------

function NotebookSection({ slug, investigation }: { slug: string; investigation: Investigation }) {
  const { ui } = usePortalLocale()
  const queryClient = useQueryClient()
  const { access, canWrite, run } = useInvestigationAuthority(slug)
  const [draft, setDraft] = useState(investigation.notes)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedIdRef = useRef(investigation.id)

  // Only resync the draft when we've switched to a different investigation -
  // never on our own refetch, or the user's in-flight typing would be wiped.
  useEffect(() => {
    if (loadedIdRef.current !== investigation.id) {
      loadedIdRef.current = investigation.id
      setDraft(investigation.notes)
      setStatus('idle')
    }
  }, [investigation.id, investigation.notes])

  useLayoutEffect(() =>
    access.controller.registerCleanup(() => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setDraft('')
    }), [access.controller])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const mutation = useMutation({
    mutationFn: (notes: string) =>
      run(() => updateInvestigation(slug, investigation.id, { notes })),
    onSuccess: () => {
      if (!canWrite()) return
      setStatus('saved')
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigation.id] })
    },
  })

  const onChange = (value: string) => {
    if (!canWrite()) return
    setDraft(value)
    setStatus('saving')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (canWrite()) mutation.mutate(value)
    }, 1500)
  }

  return (
    <section className='rp-card p-5'>
      <div className='flex items-center justify-between gap-3'>
        <h2 className='text-sm font-semibold text-ink'>{ui('Notebook')}</h2>
        <span aria-live='polite' className='text-xs text-ink-3'>
          {status === 'saving' ? ui('Saving…') : status === 'saved' ? ui('Saved') : ''}
        </span>
      </div>
      {canWrite()
        ? (
          <textarea
            rows={6}
            value={draft}
            onChange={(event) => onChange(event.target.value)}
            placeholder={ui('Working notes, hunches, things still to check…')}
            className='rp-input mt-3'
          />
        )
        : (
          <p className='mt-3 whitespace-pre-wrap break-words text-sm text-ink-2'>
            {investigation.notes || ui('No notes yet.')}
          </p>
        )}
    </section>
  )
}

// --- Evidence: verdict chips, colour-coded --------------------------------

const VERDICTS: { id: EvidenceVerdict; label: string }[] = [
  { id: 'supports', label: 'Supports' },
  { id: 'partial', label: 'Partial' },
  { id: 'not-relevant', label: 'Not relevant' },
  { id: 'contradicts', label: 'Contradicts' },
]

function verdictLabel(verdict: EvidenceVerdict | null, ui: ResearchUi = englishResearchUi): string {
  if (!verdict) return ui('Not assessed')
  const label = VERDICTS.find((v) => v.id === verdict)?.label
  return label ? ui(label) : verdict
}

function verdictChipStyle(id: EvidenceVerdict, active: boolean): CSSProperties {
  if (!active) return {}
  switch (id) {
    case 'supports':
      return {
        borderColor: 'var(--rp-ok-line)',
        background: 'var(--rp-ok-bg)',
        color: 'var(--rp-ok-ink)',
      }
    case 'contradicts':
      return {
        borderColor: 'var(--rp-bad-line)',
        background: 'var(--rp-bad-bg)',
        color: 'var(--rp-bad-ink)',
      }
    case 'partial':
      return {
        borderColor: 'var(--rp-warn-line)',
        background: 'var(--rp-warn-bg)',
        color: 'var(--rp-warn-ink)',
      }
    case 'not-relevant':
      return {
        borderColor: 'var(--rp-line)',
        background: 'var(--rp-surface-2)',
        color: 'var(--rp-ink-3)',
      }
  }
}

/**
 * Whether the document a passage was saved from is still in the Library. A document that was
 * deleted answers 404, as one unpublished does to a reader; either way the saved passage is kept
 * and is shown as no longer in the Library, not as an error. Any other failure says nothing.
 */
function useSourceGone(slug: string, resourceId: string): boolean {
  const source = useQuery({
    queryKey: ['resource', slug, resourceId],
    queryFn: () => getResource(slug, resourceId),
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 1,
    // One read per cited document when the investigation opens, not on every return to the tab.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  return source.error instanceof ApiError && source.error.status === 404
}

function EvidenceCard(
  { slug, investigationId, item }: { slug: string; investigationId: string; item: EvidenceItem },
) {
  const { ui, date } = usePortalLocale()
  const queryClient = useQueryClient()
  const { access, canWrite, run } = useInvestigationAuthority(slug)
  const sourceGone = useSourceGone(slug, item.resourceId)
  const [expanded, setExpanded] = useState(false)
  const [note, setNote] = useState(item.note)
  const [noteDirty, setNoteDirty] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
  }, [])

  useLayoutEffect(() =>
    access.controller.registerCleanup(() => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      setNote('')
      setTagDraft('')
    }), [access.controller])

  const invalidate = () =>
    canWrite() &&
    void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })

  const verdictMutation = useMutation({
    mutationFn: (verdict: EvidenceVerdict) =>
      run(() => updateEvidence(slug, investigationId, item.id, { verdict })),
    onSuccess: invalidate,
  })

  const noteMutation = useMutation({
    mutationFn: (nextNote: string) =>
      run(() => updateEvidence(slug, investigationId, item.id, { note: nextNote })),
    onSuccess: () => {
      if (!canWrite()) return
      setNoteDirty(false)
      invalidate()
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => run(() => deleteEvidence(slug, investigationId, item.id)),
    onSuccess: invalidate,
  })

  const tagsMutation = useMutation({
    mutationFn: (tags: string[]) =>
      run(() => updateEvidence(slug, investigationId, item.id, { tags })),
    onSuccess: invalidate,
  })

  const onNoteChange = (value: string) => {
    if (!canWrite()) return
    setNote(value)
    setNoteDirty(true)
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    noteTimerRef.current = setTimeout(() => {
      if (canWrite()) noteMutation.mutate(value)
    }, 1500)
  }

  const addTag = () => {
    if (!canWrite()) return
    const tag = tagDraft.trim()
    setTagDraft('')
    if (!tag || item.tags.includes(tag)) return
    tagsMutation.mutate([...item.tags, tag])
  }

  const removeTag = (tag: string) => {
    if (canWrite()) tagsMutation.mutate(item.tags.filter((t) => t !== tag))
  }

  const sourceHref = `/t/${slug}/library/${encodeURIComponent(item.resourceId)}?passage=${
    encodeURIComponent(item.passage.slice(0, 200))
  }`
  const askQuestion = item.question ||
    ui('What does the research say about {name}?', { name: item.resourceTitle })
  const askHref = `/t/${slug}/ask?ask=${encodeURIComponent(askQuestion)}`

  return (
    <div className='rp-card p-4'>
      <div className='flex items-start justify-between gap-3'>
        {sourceGone
          ? (
            <span
              className='min-w-0 truncate text-sm font-semibold text-ink-2'
              title={item.resourceTitle}
            >
              {item.resourceTitle}
            </span>
          )
          : (
            <Link
              to={sourceHref}
              className='rp-focus min-w-0 truncate text-sm font-semibold text-ink underline-offset-2 hover:underline'
              title={item.resourceTitle}
            >
              {item.resourceTitle}
            </Link>
          )}
        {item.score != null
          ? (
            <span className='rp-badge rp-badge-quiet shrink-0 tabular-nums'>
              {formatScorePercent(item.score)}%
            </span>
          )
          : null}
      </div>

      {sourceGone && (
        <p className='mt-2 text-xs text-ink-3' data-evidence-source-gone>
          <span className='rp-badge rp-badge-quiet mr-2'>{ui('No longer in the Library')}</span>
          {ui(
            'The document this passage came from was deleted or unpublished. The passage, its verdict and notes are kept.',
          )}
        </p>
      )}

      <blockquote
        className={`break-words mt-2 border-l-2 border-line pl-3 text-sm leading-relaxed text-ink-2 ${
          expanded ? '' : 'rp-clamp-4'
        }`}
      >
        {item.passage}
      </blockquote>
      {item.passage.length > 220
        ? (
          <button
            type='button'
            onClick={() => setExpanded((e) => !e)}
            className='rp-focus mt-1 inline-flex min-h-6 items-center rounded-[var(--rp-radius-btn)] text-xs font-medium text-ink-3 hover:text-ink'
          >
            {expanded ? ui('Show less') : ui('Show more')}
          </button>
        )
        : null}

      {item.question
        ? (
          <p className='mt-2 text-xs italic text-ink-3'>
            {ui('Retrieved for “')}
            {item.question}&rdquo;
          </p>
        )
        : null}
      {item.aiRelevance ? <p className='mt-1 text-xs text-ink-2'>{item.aiRelevance}</p> : null}

      <div className='mt-3 flex flex-wrap gap-1.5' role='group' aria-label={ui('Verdict')}>
        {canWrite()
          ? VERDICTS.map((v) => {
            const active = item.verdict === v.id
            return (
              <button
                key={v.id}
                type='button'
                aria-pressed={active}
                disabled={verdictMutation.isPending}
                onClick={() => verdictMutation.mutate(v.id)}
                style={verdictChipStyle(v.id, active)}
                className='rp-chip'
              >
                {ui(v.label)}
              </button>
            )
          })
          : <span className='rp-chip'>{verdictLabel(item.verdict, ui)}</span>}
      </div>

      <div className='mt-3 flex flex-wrap items-center gap-1.5' aria-label={ui('Tags')}>
        {item.tags.map((tag) => (
          <span key={tag} className='rp-chip'>
            {tag}
            {canWrite()
              ? (
                <button
                  type='button'
                  onClick={() => removeTag(tag)}
                  aria-label={ui('Remove tag {tag}', { tag: tag })}
                  className='rp-focus -my-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded-[var(--rp-radius-btn)] text-ink-3 hover:text-ink'
                >
                  &times;
                </button>
              )
              : null}
          </span>
        ))}
        {canWrite()
          ? (
            <input
              type='text'
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addTag()
                }
              }}
              onBlur={() => {
                if (tagDraft.trim()) addTag()
              }}
              placeholder={ui('Add tag…')}
              aria-label={ui('Add tag for {value1}', { value1: item.resourceTitle })}
              className='rp-input h-7 w-24 text-xs'
            />
          )
          : null}
      </div>

      <div className='mt-3 flex items-center gap-2'>
        {canWrite()
          ? (
            <input
              type='text'
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              placeholder={ui('Add a note…')}
              aria-label={ui('Note for {value1}', { value1: item.resourceTitle })}
              className='rp-input h-8 text-xs'
            />
          )
          : <p className='text-xs text-ink-2 break-words'>{item.note}</p>}
        {noteMutation.isPending || noteDirty
          ? <span className='shrink-0 text-xs text-ink-3'>{ui('Saving…')}</span>
          : null}
      </div>

      <div className='mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5'>
        <span className='text-xs text-ink-3'>
          {ui('Added')} {date(item.createdAt, { year: 'numeric', month: 'short', day: 'numeric' })}
        </span>
        <div className='flex items-center gap-2'>
          <Link to={askHref} className='rp-btn rp-btn-ghost h-7 px-2 text-xs'>
            {ui('Ask about this')}
          </Link>
          {canWrite()
            ? (
              <ConfirmButton
                label={ui('Remove')}
                confirmLabel={ui('Confirm remove')}
                disabled={removeMutation.isPending}
                onConfirm={() => removeMutation.mutate()}
                className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
                confirmClassName='rp-btn rp-btn-danger h-7 px-2 text-xs'
              />
            )
            : null}
        </div>
      </div>
    </div>
  )
}

// --- Artefacts: read-only, tolerant of whatever shape lands here ------------

function ArtefactRow({ artefact }: { artefact: InvestigationArtefact }) {
  const { ui, date } = usePortalLocale()
  const isViewableObject = artefact.data !== null && typeof artefact.data === 'object'

  return (
    <div className='rounded-[var(--rp-radius)] border border-line p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='rp-badge rp-badge-quiet shrink-0 uppercase tracking-[0.06em]'>
            {artefact.kind}
          </span>
          <span className='truncate text-sm font-medium text-ink'>{artefact.title}</span>
        </div>
        <span className='shrink-0 text-xs text-ink-3'>
          {date(artefact.createdAt, { year: 'numeric', month: 'short', day: 'numeric' })}
        </span>
      </div>
      {isViewableObject
        ? (
          <details className='mt-2'>
            <summary className='cursor-pointer text-xs font-medium text-ink-3 hover:text-ink'>
              {ui('View')}
            </summary>
            <pre className='mt-2 max-h-72 overflow-auto rounded-[var(--rp-radius)] bg-surface-2 p-3 text-xs text-ink-2'>
              {JSON.stringify(artefact.data, null, 2)}
            </pre>
          </details>
        )
        : null}
    </div>
  )
}

// --- Synthesis artefacts: rendered as a brief, not raw JSON -----------------

interface SynthesisReference {
  n: number
  resourceId: string
  resourceTitle: string
}

interface SynthesisData {
  summary: string
  supported: string[]
  contested: string[]
  gaps: string[]
  references: SynthesisReference[]
  /** Reference numbers the brief never cited: listed as not used, never silently dropped. */
  notUsed: number[]
}

/** Tolerant read of a synthesis artefact's data - never trusts the shape blindly. */
function readSynthesisData(data: unknown): SynthesisData {
  const record = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
  const references = Array.isArray(record.references)
    ? record.references.filter(
      (r): r is SynthesisReference =>
        r !== null && typeof r === 'object' &&
        typeof (r as SynthesisReference).resourceId === 'string',
    )
    : []
  return {
    summary: typeof record.summary === 'string' ? record.summary : '',
    supported: strings(record.supported),
    contested: strings(record.contested),
    gaps: strings(record.gaps),
    references,
    notUsed: Array.isArray(record.notUsed)
      ? record.notUsed.filter((n): n is number => typeof n === 'number')
      : [],
  }
}

/**
 * What a synthesis leaves out and what it carries with a caveat, read from
 * the evidence list: passages marked Not relevant are excluded from the
 * numbered evidence, passages marked Contradicts go in as opposing evidence,
 * and unjudged passages go in flagged as such. Derived from the current
 * verdicts, so it describes the evidence as it stands now.
 */
function synthesisCoverage(evidence: EvidenceItem[]): {
  excluded: EvidenceItem[]
  contradicting: number
  unjudged: number
} {
  return {
    excluded: evidence.filter((item) => item.verdict === 'not-relevant'),
    contradicting: evidence.filter((item) => item.verdict === 'contradicts').length,
    // Unjudged is "no verdict", whether the record stores null or omits it.
    unjudged: evidence.filter((item) => item.verdict == null).length,
  }
}

function SynthesisArtefactCard({
  slug,
  artefact,
  highlighted,
  evidence,
}: {
  slug: string
  artefact: InvestigationArtefact
  highlighted: boolean
  evidence: EvidenceItem[]
}) {
  const { ui, date } = usePortalLocale()
  const data = readSynthesisData(artefact.data)
  const coverage = synthesisCoverage(evidence)

  return (
    <div
      id={`artefact-${artefact.id}`}
      className={`rounded-[var(--rp-radius)] border p-4 transition-colors duration-500 ${
        highlighted ? 'border-[var(--rp-accent-fg)] bg-[var(--rp-surface-2)]' : 'border-line'
      }`}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='rp-badge rp-badge-quiet shrink-0 uppercase tracking-[0.06em]'>
            {ui('Synthesis')}
          </span>
          <span className='truncate text-sm font-medium text-ink'>{artefact.title}</span>
        </div>
        <span className='shrink-0 text-xs text-ink-3'>
          {date(artefact.createdAt, { year: 'numeric', month: 'short', day: 'numeric' })}
        </span>
      </div>

      {data.summary
        ? <p className='mt-3 text-sm leading-relaxed text-ink-2'>{data.summary}</p>
        : null}

      {data.supported.length > 0
        ? (
          <div className='mt-3'>
            <h4 className='text-xs font-semibold uppercase tracking-[0.06em] text-ink-3'>
              {ui('Established by the evidence')}
            </h4>
            <ul className='mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2'>
              {data.supported.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          </div>
        )
        : null}

      {data.contested.length > 0
        ? (
          <div className='mt-3'>
            <h4 className='text-xs font-semibold uppercase tracking-[0.06em] text-ink-3'>
              {ui('Contested')}
            </h4>
            <ul className='mt-1.5 space-y-1.5'>
              {data.contested.map((line, index) => (
                <li
                  key={index}
                  className='border-l-2 pl-3 text-sm leading-relaxed text-ink-2'
                  style={{ borderColor: 'var(--rp-warn-line)' }}
                >
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )
        : null}

      {data.gaps.length > 0
        ? (
          <div className='mt-3'>
            <h4 className='text-xs font-semibold uppercase tracking-[0.06em] text-ink-3'>
              {ui('Gaps')}
            </h4>
            <ul className='mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2'>
              {data.gaps.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          </div>
        )
        : null}

      {coverage.excluded.length > 0 || coverage.contradicting > 0 || coverage.unjudged > 0
        ? (
          <div className='mt-3 border-t border-line pt-3'>
            <h4 className='text-xs font-semibold uppercase tracking-[0.06em] text-ink-3'>
              {ui('What the synthesis left out')}
            </h4>
            <ul className='mt-1.5 space-y-1 text-xs leading-relaxed text-ink-2'>
              {coverage.excluded.length > 0
                ? (
                  <li>
                    {ui('Excluded')} {coverage.excluded.length}{' '}
                    {coverage.excluded.length === 1 ? ui('passage') : ui('passages')} {ui('marked')}
                    {' '}
                    <strong>{ui('Not relevant')}</strong>:{' '}
                    {coverage.excluded.map((item, index) => (
                      <span key={item.id}>
                        {index > 0 ? '; ' : ''}
                        <Link
                          to={`/t/${slug}/library/${encodeURIComponent(item.resourceId)}`}
                          className='text-ink underline-offset-2 hover:underline'
                        >
                          {item.resourceTitle}
                        </Link>
                      </span>
                    ))}
                  </li>
                )
                : null}
              {coverage.contradicting > 0
                ? (
                  <li>
                    {ui(
                      coverage.contradicting === 1
                        ? '{count} passage marked Contradicts went in as opposing evidence, not as support.'
                        : '{count} passages marked Contradicts went in as opposing evidence, not as support.',
                      { count: coverage.contradicting },
                    )}
                  </li>
                )
                : null}
              {coverage.unjudged > 0
                ? (
                  <li>
                    {ui(
                      coverage.unjudged === 1
                        ? '{count} unjudged passage was included and flagged as unjudged.'
                        : '{count} unjudged passages were included and flagged as unjudged.',
                      { count: coverage.unjudged },
                    )}
                  </li>
                )
                : null}
            </ul>
          </div>
        )
        : null}

      {data.references.length > 0
        ? (
          <div className='mt-3 border-t border-line pt-3'>
            <h4 className='text-xs font-semibold uppercase tracking-[0.06em] text-ink-3'>
              {ui('References')}
            </h4>
            <ol className='mt-1.5 space-y-1 text-sm text-ink-2'>
              {data.references.map((ref) => (
                <li key={ref.n}>
                  [{ref.n}]{' '}
                  <Link
                    to={`/t/${slug}/library/${encodeURIComponent(ref.resourceId)}`}
                    className='text-ink underline-offset-2 hover:underline'
                  >
                    {ref.resourceTitle}
                  </Link>
                  {data.notUsed.includes(ref.n)
                    ? (
                      <span className='ml-1.5 text-xs text-ink-3'>
                        {ui('Not used in this synthesis')}
                      </span>
                    )
                    : null}
                </li>
              ))}
            </ol>
          </div>
        )
        : null}
    </div>
  )
}

// --- Export to Word: the audit's "outputs with references intact" ----------

/** A synthesis artefact formatted as Word-friendly sections, references included. */
function synthesisArtefactHtml(
  artefact: InvestigationArtefact,
  ui: ResearchUi = englishResearchUi,
): string {
  const data = readSynthesisData(artefact.data)
  const list = (items: string[]) =>
    `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`

  return `<h2>${escapeHtml(artefact.title)}</h2>` +
    (data.summary ? `<p>${escapeHtml(data.summary)}</p>` : '') +
    (data.supported.length > 0
      ? `<h3>${escapeHtml(ui('Established by the evidence'))}</h3>${list(data.supported)}`
      : '') +
    (data.contested.length > 0
      ? `<h3>${escapeHtml(ui('Contested'))}</h3>${list(data.contested)}`
      : '') +
    (data.gaps.length > 0 ? `<h3>${escapeHtml(ui('Gaps'))}</h3>${list(data.gaps)}` : '') +
    (data.references.length > 0
      ? `<h3>${escapeHtml(ui('References'))}</h3><ol>${
        data.references.map((r) =>
          `<li>${escapeHtml(r.resourceTitle)}${
            data.notUsed.includes(r.n) ? ' ' + ui('(not used in this synthesis)') : ''
          }</li>`
        ).join('')
      }</ol>`
      : '')
}

function investigationToHtml(
  investigation: Investigation,
  ui: ResearchUi = englishResearchUi,
): { title: string; bodyHtml: string } {
  const title = investigation.name || ui('Investigation')

  const questionHtml = investigation.question
    ? `<h2>${escapeHtml(ui('Research question'))}</h2><p>${escapeHtml(investigation.question)}</p>`
    : ''
  const notesHtml = investigation.notes.trim().length > 0
    ? `<h2>${escapeHtml(ui('Notes'))}</h2><p>${
      escapeHtml(investigation.notes).replace(/\n/g, '<br>')
    }</p>`
    : ''

  const synthesisHtml = investigation.artefacts
    .filter((a) => a.kind === 'synthesis')
    .map((artefact) => synthesisArtefactHtml(artefact, ui))
    .join('')

  const sorted = [...investigation.evidence].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const sourceTitles = Array.from(new Set(sorted.map((e) => e.resourceTitle)))

  const evidenceHtml = sorted.length > 0
    ? `<h2>${escapeHtml(ui('Evidence'))}</h2>${
      sorted
        .map((item) => {
          const refIndex = sourceTitles.indexOf(item.resourceTitle) + 1
          const scoreText = item.score != null ? `${formatScorePercent(item.score)}%` : 'n/a'
          const noteHtml = item.note.trim().length > 0
            ? `<p><em>${escapeHtml(ui('Note:'))}</em> ${escapeHtml(item.note)}</p>`
            : ''
          return `<blockquote>${escapeHtml(item.passage)}</blockquote>` +
            `<p><strong>${escapeHtml(ui('Source:'))}</strong> ${
              escapeHtml(item.resourceTitle)
            } [${refIndex}] &nbsp; ` +
            `<strong>${escapeHtml(ui('Score:'))}</strong> ${scoreText} &nbsp; ` +
            `<strong>${escapeHtml(ui('Verdict:'))}</strong> ${
              escapeHtml(verdictLabel(item.verdict, ui))
            }</p>${noteHtml}`
        })
        .join('')
    }`
    : `<h2>${escapeHtml(ui('Evidence'))}</h2><p>${escapeHtml(ui('No evidence recorded.'))}</p>`

  const referencesHtml = sourceTitles.length > 0
    ? `<h2>${escapeHtml(ui('References'))}</h2><ol>${
      sourceTitles.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
    }</ol>`
    : ''

  return {
    title,
    bodyHtml: `${questionHtml}${notesHtml}${synthesisHtml}${evidenceHtml}${referencesHtml}`,
  }
}

/** Word-compatible HTML document shell - opens cleanly as a .doc in Word. */
function wordDocumentHtml(title: string, bodyHtml: string): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.5; }
h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; color: #111111; }
h1 { font-size: 22pt; margin-bottom: 12pt; }
h2 { font-size: 14pt; margin-top: 18pt; margin-bottom: 6pt; }
h3 { font-size: 12pt; margin-top: 12pt; margin-bottom: 4pt; }
blockquote { margin: 8pt 0; padding: 6pt 12pt; border-left: 3px solid #cccccc; color: #333333; font-style: italic; }
ol, ul { margin: 6pt 0; padding-left: 22pt; }
p { margin: 6pt 0; font-size: 11pt; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`
}

/** Filename-safe slug of a title, falling back to today's date when the title is empty. */
function slugOrDate(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return slug.length > 0 ? slug.slice(0, 60) : new Date().toISOString().slice(0, 10)
}

/** Build complete output in memory; the shared helper owns every browser sink. */
function investigationWordFile(
  investigation: Investigation,
  ui: ResearchUi = englishResearchUi,
): ResearchFile {
  const { title, bodyHtml } = investigationToHtml(investigation, ui)
  return {
    parts: ['\ufeff', wordDocumentHtml(title, bodyHtml)],
    type: 'application/msword',
    filename: `investigation-${slugOrDate(title)}.doc`,
  }
}

// --- Tags: v1's stand-in for claims/hypotheses - group and filter evidence -

/** Every tag in use across the investigation's evidence, with a count, most-used first. */
function tagCounts(evidence: EvidenceItem[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const item of evidence) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** Clusters evidence under tag headings; untagged items land in their own group, last. */
function groupEvidenceByTag(
  evidence: EvidenceItem[],
): { tag: string | null; items: EvidenceItem[] }[] {
  const groups = new Map<string | null, EvidenceItem[]>()
  for (const item of evidence) {
    const tags = item.tags.length > 0 ? item.tags : [null]
    for (const tag of tags) {
      const bucket = groups.get(tag)
      if (bucket) bucket.push(item)
      else groups.set(tag, [item])
    }
  }
  return Array.from(groups.entries())
    .sort((a, b) => a[0] === null ? 1 : b[0] === null ? -1 : a[0].localeCompare(b[0]))
    .map(([tag, items]) => ({ tag, items }))
}

function TagsSection({
  evidence,
  activeTag,
  onSelectTag,
  groupByTag,
  onToggleGroupByTag,
}: {
  evidence: EvidenceItem[]
  activeTag: string | null
  onSelectTag: (tag: string | null) => void
  groupByTag: boolean
  onToggleGroupByTag: () => void
}) {
  const { ui } = usePortalLocale()
  const tags = tagCounts(evidence)

  return (
    <section className='rp-card p-5'>
      <h2 className='text-sm font-semibold text-ink'>{ui('Tags')}</h2>
      <p className='mt-1 text-sm text-ink-2'>
        {ui('Tag evidence to group it under the claims or themes you are testing.')}
      </p>
      {tags.length === 0
        ? (
          <p className='mt-3 text-sm italic text-ink-3'>
            {ui('No tags yet - add one from any evidence card below.')}
          </p>
        )
        : (
          <div className='mt-3 flex flex-wrap items-center gap-1.5'>
            <button
              type='button'
              aria-pressed={activeTag === null}
              onClick={() => onSelectTag(null)}
              className={`rp-chip ${activeTag === null ? 'rp-chip-active' : ''}`}
            >
              {ui('All (')}
              {evidence.length})
            </button>
            {tags.map(([tag, count]) => (
              <button
                key={tag}
                type='button'
                aria-pressed={activeTag === tag}
                onClick={() => onSelectTag(activeTag === tag ? null : tag)}
                className={`rp-chip ${activeTag === tag ? 'rp-chip-active' : ''}`}
              >
                {tag} ({count})
              </button>
            ))}
            <button
              type='button'
              aria-pressed={groupByTag}
              onClick={onToggleGroupByTag}
              className={`rp-chip ml-auto ${groupByTag ? 'rp-chip-active' : ''}`}
            >
              {ui('Group by tag')}
            </button>
          </div>
        )}
    </section>
  )
}

// ---------------------------------------------------------------------------

const VERDICT_FILTERS = ['all', 'supports', 'partial', 'contradicts', 'not-relevant'] as const
type VerdictFilter = typeof VERDICT_FILTERS[number]

export function InvestigationDetailPage() {
  const { id } = useParams<{ id: string }>()
  return <InvestigationDetailBody key={id} />
}

function InvestigationDetailBody() {
  const { ui, error: localError } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const { access, canWrite, run, signal } = useInvestigationAuthority(config.slug)
  const exportAuthority = researchExportAuthority(access.controller, config.slug)
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all')
  const { notice: exportNotice, announce: announceExport } = useExportNotice()
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [groupByTag, setGroupByTag] = useState(false)
  const [highlightArtefactId, setHighlightArtefactId] = useState<string | null>(null)
  const [exportError, setExportError] = useState(false)
  const [synthesisMessage, setSynthesisMessage] = useState('')
  const [synthesisWarning, setSynthesisWarning] = useState(false)
  const synthesisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (synthesisTimerRef.current) clearTimeout(synthesisTimerRef.current)
  }, [])

  const {
    data: investigation,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['investigation', config.slug, id],
    queryFn: () => getInvestigation(config.slug, id ?? ''),
    enabled: Boolean(id) && access.can('portal.read', { kind: 'portal', slug: config.slug }),
  })

  const evidenceCount = investigation?.evidence.length ?? 0

  const synthesise = useMutation({
    mutationFn: () => run(() => synthesiseInvestigation(config.slug, investigation?.id ?? '')),
    onMutate: () => {
      if (!canWrite()) return
      setSynthesisMessage(
        ui(
          evidenceCount === 1
            ? 'Reading {count} evidence item…'
            : 'Reading {count} evidence items…',
          { count: evidenceCount },
        ),
      )
      if (synthesisTimerRef.current) clearTimeout(synthesisTimerRef.current)
      synthesisTimerRef.current = setTimeout(() => {
        if (!canWrite()) return
        setSynthesisMessage(
          ui('Still working - larger evidence sets can take up to thirty seconds…'),
        )
      }, 8000)
    },
    onSuccess: (result) => {
      if (!canWrite()) return
      if (synthesisTimerRef.current) clearTimeout(synthesisTimerRef.current)
      setSynthesisMessage('')
      void queryClient.invalidateQueries({
        queryKey: ['investigation', config.slug, investigation?.id ?? ''],
      })
      setHighlightArtefactId(result.artefact.id)
      globalThis.setTimeout(() => {
        if (!canWrite()) return
        document.getElementById(`artefact-${result.artefact.id}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        })
      }, 60)
      globalThis.setTimeout(() => {
        if (!canWrite()) return
        setHighlightArtefactId((current) => current === result.artefact.id ? null : current)
      }, 5000)
    },
    onError: () => {
      if (!canWrite()) return
      if (synthesisTimerRef.current) clearTimeout(synthesisTimerRef.current)
      setSynthesisMessage('')
    },
  })

  useLayoutEffect(() =>
    access.controller.registerCleanup(() => {
      if (synthesisTimerRef.current) clearTimeout(synthesisTimerRef.current)
      setSynthesisMessage('')
      setSynthesisWarning(false)
      setHighlightArtefactId(null)
    }), [access.controller])

  if (isLoading) {
    return (
      <main className='rp-shell py-10'>
        <div className='space-y-3'>
          <Skeleton className='h-32 w-full' />
          <Skeleton className='h-40 w-full' />
          <Skeleton className='h-24 w-full' />
        </div>
      </main>
    )
  }

  if (isError || !investigation) {
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <main className='rp-shell py-10'>
        <ErrorCard
          message={notFound
            ? ui('This investigation does not exist or has been removed.')
            : localError(error, 'Could not load this investigation.')}
          onRetry={() => void refetch()}
        />
        <Link to={`/t/${config.slug}/investigations`} className='rp-btn rp-btn-outline mt-4'>
          {ui('Back to investigations')}
        </Link>
      </main>
    )
  }

  const sortedEvidence = [...investigation.evidence].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const counts: Record<VerdictFilter, number> = {
    all: sortedEvidence.length,
    supports: sortedEvidence.filter((e) => e.verdict === 'supports').length,
    partial: sortedEvidence.filter((e) => e.verdict === 'partial').length,
    contradicts: sortedEvidence.filter((e) => e.verdict === 'contradicts').length,
    'not-relevant': sortedEvidence.filter((e) => e.verdict === 'not-relevant').length,
  }
  const filteredEvidence = sortedEvidence
    .filter((e) => verdictFilter === 'all' || e.verdict === verdictFilter)
    .filter((e) => tagFilter === null || e.tags.includes(tagFilter))

  // Synthesis works from the researcher's verdicts: unjudged passages go in
  // flagged, contradicted ones as opposing evidence. Neither is what a
  // researcher usually wants synthesised silently (P3-06), so the button
  // first says what it would do and offers judging first.
  const coverage = synthesisCoverage(sortedEvidence)
  const needsWarning = coverage.unjudged > 0 || coverage.contradicting > 0
  const startSynthesis = () => {
    if (!canWrite()) return
    if (needsWarning && !synthesisWarning) {
      setSynthesisWarning(true)
      return
    }
    setSynthesisWarning(false)
    void synthesise.mutate()
  }

  return (
    <main className='rp-shell py-10'>
      <h1 className='sr-only'>{investigation.name}</h1>
      <Link to={`/t/${config.slug}/investigations`} className='text-sm text-ink-3 hover:text-ink'>
        {ui('← Investigations')}
      </Link>

      {
        /* One column up to `xl`, in reading order. From `xl` the question,
        * notebook and tags sit beside the evidence and artefacts, so a wide
        * display is used rather than stranding a 900px column in its middle. */
      }
      <div className='xl:grid xl:grid-cols-2 xl:gap-8 2xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'>
        <div className='min-w-0'>
          <div className='mt-3'>
            <InvestigationHeader slug={config.slug} investigation={investigation} />
          </div>

          <div className='mt-6'>
            <NotebookSection slug={config.slug} investigation={investigation} />
          </div>

          <div className='mt-6'>
            <TagsSection
              evidence={investigation.evidence}
              activeTag={tagFilter}
              onSelectTag={setTagFilter}
              groupByTag={groupByTag}
              onToggleGroupByTag={() => setGroupByTag((g) => !g)}
            />
          </div>
        </div>

        <div className='min-w-0'>
          <section id='evidence-list' className='mt-6 xl:mt-3'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <h2 className='text-sm font-semibold text-ink'>
                {ui('Evidence')}{' '}
                <span className='font-normal text-ink-3'>({sortedEvidence.length})</span>
              </h2>
              <div className='flex flex-wrap items-center gap-2'>
                {canWrite()
                  ? (
                    <button
                      type='button'
                      disabled={sortedEvidence.length === 0 || synthesise.isPending}
                      onClick={startSynthesis}
                      className='rp-btn rp-btn-primary disabled:cursor-not-allowed'
                    >
                      {synthesise.isPending ? ui('Synthesising…') : ui('Synthesise the evidence')}
                    </button>
                  )
                  : null}
                {access.can('portal.export', { kind: 'portal', slug: config.slug })
                  ? (
                    <button
                      type='button'
                      disabled={sortedEvidence.length === 0}
                      onClick={() => {
                        setExportError(false)
                        void exportResearchFile({ ...exportAuthority, signal: signal() }, () =>
                          investigationWordFile(investigation, ui)).then((filename) => {
                            signal().throwIfAborted()
                            access.controller.assertCurrent(exportAuthority.context)
                            announceExport(savedFileNotice(filename, ui('Word document'), ui))
                          }).catch(() => {
                            if (
                              !signal().aborted &&
                              access.controller.context === exportAuthority.context
                            ) {
                              setExportError(true)
                            }
                          })
                      }}
                      className='rp-btn rp-btn-outline disabled:cursor-not-allowed'
                    >
                      {ui('Export to Word')}
                    </button>
                  )
                  : null}
                <ExportNotice notice={exportNotice} />
                {exportError
                  ? (
                    <p role='alert' className='text-sm text-[var(--rp-bad-ink)]'>
                      {ui('Could not export this investigation. Check your access and try again.')}
                    </p>
                  )
                  : null}
              </div>
            </div>

            {synthesisWarning && !synthesise.isPending
              ? (
                <div
                  role='alert'
                  className='mt-3 rounded-[var(--rp-radius)] border p-4'
                  style={{ borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }}
                >
                  <p className='text-sm font-medium' style={{ color: 'var(--rp-warn-ink)' }}>
                    {ui('Some of this evidence has not been weighed')}
                  </p>
                  <ul
                    className='mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed'
                    style={{ color: 'var(--rp-warn-ink)' }}
                  >
                    {coverage.unjudged > 0
                      ? (
                        <li>
                          {ui(
                            coverage.unjudged === 1
                              ? '{count} passage has no verdict. They will be included and flagged as unjudged.'
                              : '{count} passages have no verdict. They will be included and flagged as unjudged.',
                            { count: coverage.unjudged },
                          )}
                        </li>
                      )
                      : null}
                    {coverage.contradicting > 0
                      ? (
                        <li>
                          {ui(
                            coverage.contradicting === 1
                              ? '{count} passage is marked Contradicts. They will be reported as opposing evidence, never as support.'
                              : '{count} passages are marked Contradicts. They will be reported as opposing evidence, never as support.',
                            { count: coverage.contradicting },
                          )}
                        </li>
                      )
                      : null}
                    {coverage.excluded.length > 0
                      ? (
                        <li>
                          {ui(
                            coverage.excluded.length === 1
                              ? '{count} passage marked Not relevant will be left out.'
                              : '{count} passages marked Not relevant will be left out.',
                            { count: coverage.excluded.length },
                          )}
                        </li>
                      )
                      : null}
                  </ul>
                  <div className='mt-3 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      onClick={startSynthesis}
                      className='rp-btn rp-btn-primary'
                    >
                      {ui('Synthesise anyway')}
                    </button>
                    <button
                      type='button'
                      onClick={() => {
                        setSynthesisWarning(false)
                        setVerdictFilter('all')
                        document.getElementById('evidence-list')?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'start',
                        })
                      }}
                      className='rp-btn rp-btn-outline'
                    >
                      {ui('Judge the evidence first')}
                    </button>
                  </div>
                </div>
              )
              : null}
            {synthesise.isPending
              ? <p aria-live='polite' className='mt-2 text-xs text-ink-3'>{synthesisMessage}</p>
              : null}
            {synthesise.isError
              ? (
                <p className='mt-2 text-xs' style={{ color: 'var(--rp-bad-ink)' }}>
                  {ui('Could not synthesise the evidence - try again.')}
                </p>
              )
              : null}

            {sortedEvidence.length > 0
              ? (
                <div className='mt-3 flex flex-wrap gap-1.5'>
                  {VERDICT_FILTERS.map((f) => (
                    <button
                      key={f}
                      type='button'
                      aria-pressed={verdictFilter === f}
                      onClick={() => setVerdictFilter(f)}
                      className={`rp-chip ${verdictFilter === f ? 'rp-chip-active' : ''}`}
                    >
                      {f === 'all' ? ui('All') : verdictLabel(f, ui)} ({counts[f]})
                    </button>
                  ))}
                </div>
              )
              : null}

            <div className='mt-4'>
              {sortedEvidence.length === 0
                ? (
                  <EmptyState
                    title={ui('No evidence yet')}
                    description={ui(
                      'Save passages from Search, Ask answers, or the document reader.',
                    )}
                  />
                )
                : filteredEvidence.length === 0
                ? (
                  <EmptyState
                    title={ui('No evidence matches this filter')}
                    description={ui(
                      'Try a different verdict or tag, or clear filters to see everything.',
                    )}
                  />
                )
                : groupByTag
                ? (
                  <div className='space-y-5'>
                    {groupEvidenceByTag(filteredEvidence).map((group) => (
                      <div key={group.tag === null ? 'untagged' : `tag-${group.tag}`}>
                        <h3 className='mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-3'>
                          {group.tag === null ? ui('Untagged') : group.tag}{' '}
                          <span className='font-normal normal-case tracking-normal'>
                            ({group.items.length})
                          </span>
                        </h3>
                        <div className='space-y-3'>
                          {group.items.map((item) => (
                            <EvidenceCard
                              key={item.id}
                              slug={config.slug}
                              investigationId={investigation.id}
                              item={item}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )
                : (
                  <div className='space-y-3'>
                    {filteredEvidence.map((item) => (
                      <EvidenceCard
                        key={item.id}
                        slug={config.slug}
                        investigationId={investigation.id}
                        item={item}
                      />
                    ))}
                  </div>
                )}
            </div>
          </section>

          <section className='mt-6'>
            <h2 className='text-sm font-semibold text-ink'>
              {ui('Artefacts')}{' '}
              <span className='font-normal text-ink-3'>({investigation.artefacts.length})</span>
            </h2>
            <div className='mt-3'>
              {investigation.artefacts.length === 0
                ? (
                  <EmptyState
                    title={ui('No artefacts yet')}
                    description={ui('Outputs saved from research tools will appear here.')}
                  />
                )
                : (
                  <div className='space-y-2'>
                    {investigation.artefacts.map((artefact) =>
                      artefact.kind === 'synthesis'
                        ? (
                          <SynthesisArtefactCard
                            key={artefact.id}
                            slug={config.slug}
                            artefact={artefact}
                            highlighted={highlightArtefactId === artefact.id}
                            evidence={investigation.evidence}
                          />
                        )
                        : <ArtefactRow key={artefact.id} artefact={artefact} />
                    )}
                  </div>
                )}
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
