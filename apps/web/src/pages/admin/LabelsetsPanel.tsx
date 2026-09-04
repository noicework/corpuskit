import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Labelset } from '@research-portal/core'
import {
  getLabelsets,
  LabelsetSaveError,
  type LabelsetUpdateResult,
  updateAdminLabelset,
} from '../../api/client.ts'
import { EmptyState, ErrorCard, prettyLabel, Skeleton } from '../../components/ui.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

// Mirrors the server's schema so problems surface before a save attempt.
const TITLE_MAX = 60
const LABEL_MAX = 60
const TEXT_MAX = 600
const LABELS_MAX = 60

type DraftLabel = { title: string; text: string }
type Draft = { title: string; multiple: boolean; labels: DraftLabel[] }

function draftFrom(labelset: Labelset): Draft {
  return {
    title: labelset.title,
    multiple: labelset.multiple,
    labels: labelset.labels.map((title) => ({
      title,
      text: labelset.definitions?.[title] ?? '',
    })),
  }
}

/** Trimmed, as the server will see it. */
function normalise(draft: Draft): Draft {
  return {
    title: draft.title.trim(),
    multiple: draft.multiple,
    labels: draft.labels.map((l) => ({ title: l.title.trim(), text: l.text.trim() })),
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b))
}

function validate(draft: Draft): string[] {
  const problems: string[] = []
  const title = draft.title.trim()
  if (!title) problems.push('The set needs a name.')
  if (title.length > TITLE_MAX) problems.push(`The name is longer than ${TITLE_MAX} characters.`)
  if (draft.labels.length === 0) problems.push('Add at least one label.')
  if (draft.labels.length > LABELS_MAX) {
    problems.push(`A set can hold at most ${LABELS_MAX} labels.`)
  }
  const seen = new Set<string>()
  draft.labels.forEach((label, index) => {
    const name = label.title.trim()
    const n = index + 1
    if (!name) {
      problems.push(`Label ${n} has no name.`)
      return
    }
    if (name.length > LABEL_MAX) {
      problems.push(`Label "${name}" is longer than ${LABEL_MAX} characters.`)
    }
    if (label.text.trim().length > TEXT_MAX) {
      problems.push(`The definition of "${name}" is longer than ${TEXT_MAX} characters.`)
    }
    const key = name.toLowerCase()
    if (seen.has(key)) problems.push(`Label "${name}" appears more than once.`)
    seen.add(key)
  })
  return problems
}

function resultMessage(title: string, result: LabelsetUpdateResult): string {
  if (result.agents.length === 0) {
    return `Saved "${title}". No labeller carries this set, so no agent was restarted.`
  }
  const names = result.agents
    .map((a) => `${a.newTitle} (previous agent ${a.previousId} removed)`)
    .join(', ')
  const noun = result.agents.length === 1 ? 'labeller' : 'labellers'
  return `Saved "${title}". Re-instantiated ${result.agents.length} ${noun} for new resources ` +
    `only: ${names}.`
}

function CardinalitySwitch({
  multiple,
  disabled,
  onChange,
}: {
  multiple: boolean
  disabled: boolean
  onChange: (multiple: boolean) => void
}) {
  const option = (value: boolean, label: string) => (
    <button
      type='button'
      aria-pressed={multiple === value}
      disabled={disabled}
      onClick={() => onChange(value)}
      className={`rounded-[calc(var(--rp-radius)-2px)] px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
        multiple === value
          ? 'bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'
          : 'text-ink-2 hover:bg-[var(--rp-surface-2)]'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className='inline-flex rounded-[var(--rp-radius)] border border-line bg-surface p-1'>
      {option(false, 'Single')}
      {option(true, 'Multiple')}
    </div>
  )
}

function LabelRow({
  label,
  index,
  setId,
  disabled,
  onChange,
  onRemove,
}: {
  label: DraftLabel
  index: number
  setId: string
  disabled: boolean
  onChange: (patch: Partial<DraftLabel>) => void
  onRemove: () => void
}) {
  const nameId = `ls-${setId}-label-${index}`
  const textId = `ls-${setId}-text-${index}`
  return (
    // One grid row on md+ (name | definition | remove); stacked on a phone,
    // where a divider keeps each label's trio reading as one row.
    <div className='grid grid-cols-1 items-start gap-2 border-b border-line pb-3 last:border-b-0 last:pb-0 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:border-b-0 md:pb-0'>
      <input
        id={nameId}
        className='rp-input'
        placeholder='Label'
        aria-label={`Label ${index + 1} name`}
        value={label.title}
        maxLength={LABEL_MAX}
        disabled={disabled}
        autoComplete='off'
        onChange={(e) => onChange({ title: e.target.value })}
      />
      <textarea
        id={textId}
        className='rp-input'
        rows={2}
        placeholder='Definition - what this label means and when it applies'
        aria-label={`Definition of label ${label.title.trim() || index + 1}`}
        value={label.text}
        maxLength={TEXT_MAX}
        disabled={disabled}
        onChange={(e) => onChange({ text: e.target.value })}
      />
      <button
        type='button'
        disabled={disabled}
        onClick={onRemove}
        className='rp-btn rp-btn-ghost h-[calc(2.25rem*var(--rp-density-ctl,1))] shrink-0 justify-self-end px-2.5 text-xs md:justify-self-auto'
        style={{ color: 'var(--rp-bad-ink)' }}
      >
        Remove
      </button>
    </div>
  )
}

function LabelsetEditor({
  slug,
  passcode,
  labelset,
  draft,
  onDraft,
  onSaved,
  organisation,
}: {
  slug: string
  passcode: string
  labelset: Labelset
  draft: Draft
  onDraft: (next: Draft | null) => void
  onSaved: () => Promise<unknown>
  organisation: string
}) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [previous, setPrevious] = useState<unknown>(null)

  const baseline = draftFrom(labelset)
  const dirty = !sameDraft(draft, baseline)
  const problems = validate(draft)
  const canSave = dirty && problems.length === 0 && !saving

  const update = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch })
  const updateLabel = (index: number, patch: Partial<DraftLabel>) =>
    update({ labels: draft.labels.map((l, i) => i === index ? { ...l, ...patch } : l) })

  const onSave = async () => {
    setSaving(true)
    setMessage(null)
    setPrevious(null)
    const body = normalise(draft)
    try {
      const result = await updateAdminLabelset(slug, passcode, labelset.id, body)
      setMessage({ tone: 'ok', text: resultMessage(body.title, result) })
      onDraft(null)
      await onSaved()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save this label set.') })
      if (err instanceof LabelsetSaveError && err.previous) setPrevious(err.previous)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='relative rounded-[var(--rp-radius)] border border-line bg-surface p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-sm font-semibold text-ink'>
            {prettyLabel(labelset.title, organisation)}
          </p>
          <p className='mt-0.5 font-mono text-xs text-ink-3'>{labelset.id}</p>
        </div>
        <span className='rp-badge'>
          {labelset.kind === 'PARAGRAPHS' ? 'Passage level' : 'Document level'}
        </span>
      </div>

      <div className='mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]'>
        <div className='min-w-0'>
          <label
            htmlFor={`ls-${labelset.id}-title`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Name
          </label>
          <input
            id={`ls-${labelset.id}-title`}
            className='rp-input'
            value={draft.title}
            maxLength={TITLE_MAX}
            disabled={saving}
            autoComplete='off'
            onChange={(e) => update({ title: e.target.value })}
          />
        </div>
        <div>
          <p className='mb-1.5 block text-sm font-medium text-ink'>Values per resource</p>
          <CardinalitySwitch
            multiple={draft.multiple}
            disabled={saving}
            onChange={(multiple) => update({ multiple })}
          />
        </div>
      </div>

      <div className='mt-5'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <p className='text-sm font-semibold text-ink'>Labels and definitions</p>
            <p className='mt-0.5 text-xs text-ink-3'>
              A definition says what the label means and when it applies - it is what the labeller
              classifies against.
            </p>
          </div>
          <span className='rp-badge'>
            {draft.labels.length} of {LABELS_MAX}
          </span>
        </div>

        <div className='mt-3 hidden grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] gap-2 md:grid'>
          <p className='rp-eyebrow text-ink-3'>Label</p>
          <p className='rp-eyebrow text-ink-3'>Definition</p>
          <span aria-hidden='true' />
        </div>

        <div className='mt-2 space-y-3'>
          {draft.labels.map((label, index) => (
            <LabelRow
              key={index}
              label={label}
              index={index}
              setId={labelset.id}
              disabled={saving}
              onChange={(patch) => updateLabel(index, patch)}
              onRemove={() => update({ labels: draft.labels.filter((_, i) => i !== index) })}
            />
          ))}
          {draft.labels.length === 0 && (
            <p className='text-sm text-ink-3'>No labels - add at least one to save.</p>
          )}
        </div>

        <button
          type='button'
          disabled={saving || draft.labels.length >= LABELS_MAX}
          onClick={() => update({ labels: [...draft.labels, { title: '', text: '' }] })}
          className='rp-btn rp-btn-outline mt-3'
        >
          Add label
        </button>
      </div>

      {problems.length > 0 && dirty && (
        <div
          className='mt-4 rounded-[var(--rp-radius)] border px-4 py-3 text-sm'
          style={{
            background: 'var(--rp-warn-bg)',
            borderColor: 'var(--rp-warn-line)',
            color: 'var(--rp-warn-ink)',
          }}
        >
          <p className='font-medium'>Before this can be saved:</p>
          <ul className='mt-1 list-disc space-y-0.5 pl-5'>
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {message && <MessagePanel message={message} className='mt-4' />}

      {previous !== null && (
        <details className='mt-3 rounded-[var(--rp-radius)] border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2'>
          <summary className='cursor-pointer font-medium text-ink'>
            Previous agent configuration - keep this to restore the labeller by hand
          </summary>
          <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-2'>
            {JSON.stringify(previous, null, 2)}
          </pre>
        </details>
      )}

      <p className='mt-4 text-xs text-ink-3'>
        Saving replaces this set on the knowledge box and restarts every labeller that carries it,
        for new resources only. Resources already in the corpus keep their current labels.
      </p>

      {dirty && (
        <div className='sticky bottom-0 z-10 -mx-4 -mb-4 mt-4 border-t border-line bg-surface-2 px-4 py-3 shadow-[var(--rp-shadow-md)]'>
          <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3'>
            <p className='text-xs text-ink-3'>Unsaved changes</p>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
              <button
                type='button'
                disabled={saving}
                onClick={() => {
                  setMessage(null)
                  setPrevious(null)
                  onDraft(null)
                }}
                className='rp-btn rp-btn-outline w-full sm:w-auto'
              >
                Discard
              </button>
              <button
                type='button'
                disabled={!canSave}
                onClick={() => void onSave()}
                className='rp-btn rp-btn-primary w-full sm:w-auto'
              >
                {saving ? 'Saving…' : (
                  <>
                    <span className='sm:hidden'>Save</span>
                    <span className='hidden sm:inline'>Save and restart labellers</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Label sets and their per-label definitions, editable in place. The list on
 * the left picks a set; the editor on the right owns its name, cardinality
 * and one row per label. Saving writes the set to the knowledge box and
 * re-instantiates every labeller that carries it, for new resources only.
 * Unsaved edits are kept per set, so switching sets loses nothing.
 */
export function LabelsetsPanel({
  slug,
  passcode,
  organisation = '',
}: {
  slug: string
  passcode: string
  organisation?: string
}) {
  const queryClient = useQueryClient()
  const { data: labelsets, isLoading, isError, refetch } = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const selected = labelsets?.find((ls) => ls.id === selectedId) ?? labelsets?.[0] ?? null
  const dirtyIds = new Set(
    (labelsets ?? [])
      .filter((ls) => drafts[ls.id] && !sameDraft(drafts[ls.id]!, draftFrom(ls)))
      .map((ls) => ls.id),
  )

  const setDraft = (id: string, next: Draft | null) =>
    setDrafts((prev) => {
      const copy = { ...prev }
      if (next) copy[id] = next
      else delete copy[id]
      return copy
    })

  const onSaved = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['labelsets', slug] }),
      queryClient.invalidateQueries({ queryKey: ['facets', slug] }),
      queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] }),
    ])

  return (
    <section
      aria-labelledby='labelsets-heading'
      className='mt-5 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'
    >
      <div>
        <p id='labelsets-heading' className='text-sm font-semibold text-ink'>Label sets</p>
        <p className='mt-0.5 text-xs text-ink-3'>
          Each set's labels and definitions are the vocabulary its labeller classifies against.
          Saving a set restarts its labellers for new resources only.
        </p>
      </div>

      {isLoading && (
        <div className='mt-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]'>
          <div className='space-y-2'>
            <Skeleton className='h-12 w-full' />
            <Skeleton className='h-12 w-full' />
          </div>
          <Skeleton className='h-48 w-full' />
        </div>
      )}

      {isError && (
        <div className='mt-4'>
          <ErrorCard message='Could not load the label sets.' onRetry={() => void refetch()} />
        </div>
      )}

      {labelsets && labelsets.length === 0 && (
        <div className='mt-4'>
          <EmptyState
            title='No label sets yet'
            description='Add a category on the Taxonomy page, then define its labels here.'
          />
        </div>
      )}

      {labelsets && labelsets.length > 0 && selected && (
        <div className='mt-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]'>
          <ul
            aria-label='Label sets'
            className='rp-no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 md:mx-0 md:flex-col md:overflow-visible md:px-0'
          >
            {labelsets.map((ls) => {
              const active = ls.id === selected.id
              return (
                <li key={ls.id} className='shrink-0 md:shrink'>
                  <button
                    type='button'
                    onClick={() => setSelectedId(ls.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full rounded-[var(--rp-radius)] border px-3 py-2 text-left transition-colors duration-150 ${
                      active
                        ? 'border-[var(--rp-line-2)] bg-[var(--rp-wash)] text-ink'
                        : 'border-transparent text-ink-2 hover:bg-[var(--rp-surface-3)] hover:text-[var(--rp-ink)]'
                    }`}
                  >
                    <span className='flex items-center gap-2'>
                      <span className='truncate text-sm font-medium'>
                        {prettyLabel(ls.title, organisation)}
                      </span>
                      {dirtyIds.has(ls.id) && (
                        <span
                          className='h-1.5 w-1.5 shrink-0 rounded-full'
                          style={{ background: 'var(--rp-warn-ink)' }}
                          aria-label='Unsaved changes'
                        />
                      )}
                    </span>
                    <span className='mt-0.5 block whitespace-nowrap text-xs text-ink-3 md:whitespace-normal'>
                      <span className='font-mono'>{ls.id}</span>
                      {' · '}
                      {ls.multiple ? 'Multiple' : 'Single'}
                      {' · '}
                      {ls.labels.length} {ls.labels.length === 1 ? 'label' : 'labels'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          <LabelsetEditor
            key={selected.id}
            slug={slug}
            passcode={passcode}
            labelset={selected}
            draft={drafts[selected.id] ?? draftFrom(selected)}
            onDraft={(next) => setDraft(selected.id, next)}
            onSaved={onSaved}
            organisation={organisation}
          />
        </div>
      )}
    </section>
  )
}
