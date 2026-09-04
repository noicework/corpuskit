import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { KgImplementEvent } from '@research-portal/core'
import { getGraphStrategy, type GraphStrategy, saveGraphStrategy } from '../../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../../components/ui.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

const CAT_COLOURS = [
  'var(--rp-cat-1)',
  'var(--rp-cat-2)',
  'var(--rp-cat-3)',
  'var(--rp-cat-4)',
  'var(--rp-cat-5)',
  'var(--rp-cat-6)',
]

function colourFor(index: number): string {
  return CAT_COLOURS[index % CAT_COLOURS.length]!
}

type DraftEntityType = { label: string; description: string }
type DraftEntity = { name: string; label: string }
type DraftRelation = { source: string; target: string; label: string }
type DraftExample = { text: string; entities: DraftEntity[]; relations: DraftRelation[] }
type Draft = { entityTypes: DraftEntityType[]; examples: DraftExample[] }

function draftFromStrategy(strategy: GraphStrategy): Draft {
  return {
    entityTypes: strategy.entityDefs.map((d) => ({
      label: d.label,
      description: d.description ?? '',
    })),
    examples: strategy.examples.map((e) => ({
      text: e.text,
      entities: e.entities.map((en) => ({ ...en })),
      relations: e.relations.map((r) => ({ ...r })),
    })),
  }
}

function blankExample(): DraftExample {
  return {
    text: '',
    entities: [{ name: '', label: '' }],
    relations: [{ source: '', target: '', label: '' }],
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>)
    const bk = Object.keys(b as Record<string, unknown>)
    if (ak.length !== bk.length) return false
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return false
}

/** Type labels referenced by at least one example entity, keyed by trimmed lower-case label. */
function referencedTypes(draft: Draft): Map<string, number[]> {
  const map = new Map<string, number[]>()
  draft.examples.forEach((example, i) => {
    example.entities.forEach((en) => {
      const key = en.label.trim().toLowerCase()
      if (!key) return
      const arr = map.get(key) ?? []
      arr.push(i)
      map.set(key, arr)
    })
  })
  return map
}

/** Mirrors the server's validation so problems surface before a save attempt. */
function validate(draft: Draft): string[] {
  const problems: string[] = []

  if (draft.entityTypes.length === 0) problems.push('Add at least one entity type.')
  if (draft.entityTypes.some((t) => !t.label.trim())) {
    problems.push('Every entity type needs a name.')
  }
  const seenTypes = new Set<string>()
  for (const t of draft.entityTypes) {
    const key = t.label.trim().toLowerCase()
    if (!key) continue
    if (seenTypes.has(key)) {
      problems.push(`Entity type "${t.label.trim()}" is defined more than once.`)
    }
    seenTypes.add(key)
  }

  if (draft.examples.length < 6) {
    const remaining = 6 - draft.examples.length
    problems.push(
      `Add ${remaining} more worked ${remaining === 1 ? 'example' : 'examples'} (6 minimum).`,
    )
  }

  draft.examples.forEach((example, i) => {
    const n = i + 1
    if (!example.text.trim()) problems.push(`Example ${n}: the text is empty.`)
    if (example.entities.length < 2) problems.push(`Example ${n}: needs at least 2 entities.`)
    if (example.relations.length < 1) problems.push(`Example ${n}: needs at least 1 relation.`)

    const names = new Set<string>()
    example.entities.forEach((en) => {
      const name = en.name.trim()
      if (!name) problems.push(`Example ${n}: an entity has no name.`)
      else names.add(name.toLowerCase())
      if (!en.label.trim()) {
        problems.push(`Example ${n}: entity "${name || '(unnamed)'}" has no type.`)
      } else if (!seenTypes.has(en.label.trim().toLowerCase())) {
        problems.push(
          `Example ${n}: entity "${name || '(unnamed)'}" uses undefined type "${en.label.trim()}".`,
        )
      }
    })

    example.relations.forEach((r) => {
      if (!r.label.trim()) problems.push(`Example ${n}: a relation has no label.`)
      if (!r.source.trim() || !names.has(r.source.trim().toLowerCase())) {
        problems.push(
          `Example ${n}: relation source "${
            r.source || '(none)'
          }" is not one of this example's entities.`,
        )
      }
      if (!r.target.trim() || !names.has(r.target.trim().toLowerCase())) {
        problems.push(
          `Example ${n}: relation target "${
            r.target || '(none)'
          }" is not one of this example's entities.`,
        )
      }
    })
  })

  return problems
}

// --- A two-click confirm, no window.confirm (mirrors InvestigationDetailPage) ----

function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className,
  confirmClassName,
}: {
  label: string
  confirmLabel: string
  onConfirm: () => void
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

function EntityTypeRow({
  type,
  index,
  usedIn,
  onChange,
  onRemove,
}: {
  type: DraftEntityType
  index: number
  usedIn: number[]
  onChange: (patch: Partial<DraftEntityType>) => void
  onRemove: () => void
}) {
  const disabled = usedIn.length > 0
  const reason = `Used by example ${
    usedIn.map((i) => i + 1).join(', ')
  } - remove those references first.`

  return (
    <div className='flex flex-wrap items-start gap-2'>
      <span
        aria-hidden='true'
        className='mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full'
        style={{ background: colourFor(index) }}
      />
      <input
        className='rp-input min-w-[9rem] flex-1'
        placeholder='Type name, e.g. Person'
        value={type.label}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <input
        className='rp-input min-w-[12rem] flex-[2]'
        placeholder='Description (optional)'
        value={type.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <button
        type='button'
        disabled={disabled}
        title={disabled ? reason : undefined}
        onClick={onRemove}
        className='rp-btn rp-btn-ghost h-9 shrink-0 px-2.5 text-xs'
        style={disabled ? undefined : { color: 'var(--rp-bad-ink)' }}
      >
        Remove
      </button>
      {disabled && <p className='basis-full pl-[1.125rem] text-xs text-ink-3'>{reason}</p>}
    </div>
  )
}

function ExampleCard({
  example,
  index,
  entityTypes,
  onChange,
  onRemove,
}: {
  example: DraftExample
  index: number
  entityTypes: DraftEntityType[]
  onChange: (next: DraftExample) => void
  onRemove: () => void
}) {
  const updateEntity = (i: number, patch: Partial<DraftEntity>) => {
    onChange({
      ...example,
      entities: example.entities.map((en, j) => j === i ? { ...en, ...patch } : en),
    })
  }
  const removeEntity = (i: number) => {
    onChange({ ...example, entities: example.entities.filter((_, j) => j !== i) })
  }
  const addEntity = () => {
    onChange({ ...example, entities: [...example.entities, { name: '', label: '' }] })
  }

  const updateRelation = (i: number, patch: Partial<DraftRelation>) => {
    onChange({
      ...example,
      relations: example.relations.map((r, j) => j === i ? { ...r, ...patch } : r),
    })
  }
  const removeRelation = (i: number) => {
    onChange({ ...example, relations: example.relations.filter((_, j) => j !== i) })
  }
  const addRelation = () => {
    onChange({
      ...example,
      relations: [...example.relations, { source: '', target: '', label: '' }],
    })
  }

  const entityNames = example.entities.map((en) => en.name).filter(Boolean)

  return (
    <div className='rounded-[var(--rp-radius)] border border-line bg-surface p-4'>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-xs font-semibold text-ink-3'>Example {index + 1}</p>
        <ConfirmButton
          label='Remove example'
          confirmLabel='Click again to remove'
          onConfirm={onRemove}
          className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
          confirmClassName='rp-btn rp-btn-danger h-7 px-2 text-xs'
        />
      </div>

      <textarea
        className='rp-input mt-2'
        rows={3}
        placeholder='Paste or write a representative passage…'
        value={example.text}
        onChange={(e) => onChange({ ...example, text: e.target.value })}
      />

      <div className='mt-3'>
        <p className='rp-eyebrow text-ink-3'>Entities</p>
        <div className='mt-1.5 space-y-1.5'>
          {example.entities.map((en, i) => {
            const typeIndex = entityTypes.findIndex((t) =>
              t.label.trim() !== '' &&
              t.label.trim().toLowerCase() === en.label.trim().toLowerCase()
            )
            return (
              <div key={i} className='flex flex-wrap items-center gap-1.5'>
                <span
                  aria-hidden='true'
                  className='h-2.5 w-2.5 shrink-0 rounded-full'
                  style={{ background: typeIndex >= 0 ? colourFor(typeIndex) : 'var(--rp-line)' }}
                />
                <input
                  className='rp-input min-w-[8rem] flex-1'
                  placeholder='Name'
                  value={en.name}
                  onChange={(e) => updateEntity(i, { name: e.target.value })}
                />
                <select
                  className='rp-input w-40 shrink-0'
                  value={en.label}
                  onChange={(e) => updateEntity(i, { label: e.target.value })}
                >
                  <option value=''>Type…</option>
                  {entityTypes.map((t, ti) => (
                    <option key={ti} value={t.label}>{t.label || '(unnamed)'}</option>
                  ))}
                </select>
                <button
                  type='button'
                  onClick={() => removeEntity(i)}
                  className='rp-btn rp-btn-ghost h-9 shrink-0 px-2.5 text-xs'
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>
        <button
          type='button'
          onClick={addEntity}
          className='rp-btn rp-btn-outline mt-2 h-8 px-2.5 text-xs'
        >
          Add entity
        </button>
      </div>

      <div className='mt-3'>
        <p className='rp-eyebrow text-ink-3'>Relations</p>
        <div className='mt-1.5 space-y-1.5'>
          {example.relations.map((r, i) => (
            <div key={i} className='flex flex-wrap items-center gap-1.5'>
              <select
                className='rp-input w-36 shrink-0'
                value={r.source}
                onChange={(e) =>
                  updateRelation(i, { source: e.target.value })}
              >
                <option value=''>source…</option>
                {entityNames.map((name, ni) => <option key={ni} value={name}>{name}</option>)}
              </select>
              <span aria-hidden='true' className='text-sm text-ink-3'>-</span>
              <input
                className='rp-input min-w-[8rem] flex-1'
                placeholder='e.g. funds, develops, studies'
                value={r.label}
                onChange={(e) =>
                  updateRelation(i, { label: e.target.value })}
              />
              <span aria-hidden='true' className='text-sm text-ink-3'>-&gt;</span>
              <select
                className='rp-input w-36 shrink-0'
                value={r.target}
                onChange={(e) => updateRelation(i, { target: e.target.value })}
              >
                <option value=''>target…</option>
                {entityNames.map((name, ni) => <option key={ni} value={name}>{name}</option>)}
              </select>
              <button
                type='button'
                onClick={() => removeRelation(i)}
                className='rp-btn rp-btn-ghost h-9 shrink-0 px-2.5 text-xs'
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type='button'
          onClick={addRelation}
          className='rp-btn rp-btn-outline mt-2 h-8 px-2.5 text-xs'
        >
          Add relation
        </button>
      </div>
    </div>
  )
}

/**
 * Full read/write view of the knowledge-graph extraction strategy: the entity
 * types and worked examples that teach the llm-graph agent which relations
 * matter. Everything here is directly editable - there is no separate view
 * mode - with a sticky save bar appearing once the draft diverges from what
 * is registered on the box.
 */
export function KgStrategyEditor({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['kg-strategy', slug],
    queryFn: () => getGraphStrategy(slug, passcode),
  })

  const [draft, setDraft] = useState<Draft | null>(null)
  const baselineRef = useRef<Draft | null>(null)
  const dirtyRef = useRef(false)

  const [applyExisting, setApplyExisting] = useState(true)
  const [saving, setSaving] = useState(false)
  const [log, setLog] = useState<KgImplementEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  // Sync the draft from the server whenever fresh data arrives and there are
  // no unsaved edits to clobber (covers first load and a strategy appearing
  // via the propose/implement flow above, while leaving an active edit alone).
  useEffect(() => {
    if (data === undefined || dirtyRef.current) return
    const next = data.strategy ? draftFromStrategy(data.strategy) : null
    baselineRef.current = next
    setDraft(next)
  }, [data])

  const dirty = draft !== null && !deepEqual(draft, baselineRef.current)

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  if (isLoading) {
    return (
      <div className='space-y-2'>
        <Skeleton className='h-9 w-full' />
        <Skeleton className='h-9 w-full' />
        <Skeleton className='h-28 w-full' />
      </div>
    )
  }

  if (isError) {
    return (
      <ErrorCard
        message='Could not load the knowledge-graph strategy.'
        onRetry={() => void refetch()}
      />
    )
  }

  if (!data?.strategy || !draft) {
    return (
      <EmptyState
        title='No knowledge graph agent is registered yet'
        description='Propose and implement one above, then refine it here.'
      />
    )
  }

  const problems = validate(draft)
  const referenced = referencedTypes(draft)
  const canSave = dirty && problems.length === 0 && !saving

  const onSave = async () => {
    setSaving(true)
    setLog([])
    setMessage(null)
    try {
      await saveGraphStrategy(
        slug,
        passcode,
        {
          entityTypes: draft.entityTypes.map((t) => ({
            label: t.label.trim(),
            description: t.description.trim() || undefined,
          })),
          examples: draft.examples.map((e) => ({
            text: e.text.trim(),
            entities: e.entities.map((en) => ({ name: en.name.trim(), label: en.label.trim() })),
            relations: e.relations.map((r) => ({
              source: r.source.trim(),
              target: r.target.trim(),
              label: r.label.trim(),
            })),
          })),
          applyExisting,
        },
        (event) => {
          setLog((prev) => [...prev, event])
          if (event.type === 'done') {
            setMessage({
              tone: 'ok',
              text: `Strategy saved - ${event.agents} ${
                event.agents === 1 ? 'agent' : 'agents'
              } re-registered.`,
            })
          }
          if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
        },
      )
      const result = await refetch()
      const fresh = result.data?.strategy ?? null
      const next = fresh ? draftFromStrategy(fresh) : null
      baselineRef.current = next
      dirtyRef.current = false
      setDraft(next)
      await queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save the strategy.') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='space-y-5 pb-1'>
      <div>
        <p className='text-sm font-semibold text-ink'>Entity types</p>
        <p className='mt-0.5 text-xs text-ink-3'>The kinds of things the extractor recognises.</p>
        <div className='mt-2 space-y-2'>
          {draft.entityTypes.map((t, i) => (
            <EntityTypeRow
              key={i}
              type={t}
              index={i}
              usedIn={referenced.get(t.label.trim().toLowerCase()) ?? []}
              onChange={(patch) =>
                setDraft({
                  ...draft,
                  entityTypes: draft.entityTypes.map((et, j) => j === i ? { ...et, ...patch } : et),
                })}
              onRemove={() =>
                setDraft({ ...draft, entityTypes: draft.entityTypes.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
        <button
          type='button'
          onClick={() =>
            setDraft({
              ...draft,
              entityTypes: [...draft.entityTypes, { label: '', description: '' }],
            })}
          className='rp-btn rp-btn-outline mt-2'
        >
          Add entity type
        </button>
      </div>

      <div>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <p className='text-sm font-semibold text-ink'>Worked examples</p>
            <p className='mt-0.5 text-xs text-ink-3'>
              Worked examples teach the extractor which relations matter - at least six are needed.
            </p>
          </div>
          <span
            className={`rp-badge ${draft.examples.length >= 6 ? 'rp-badge-ok' : 'rp-badge-warn'}`}
          >
            {draft.examples.length} of 6+ examples
          </span>
        </div>
        <div className='mt-3 space-y-3'>
          {draft.examples.map((example, i) => (
            <ExampleCard
              key={i}
              example={example}
              index={i}
              entityTypes={draft.entityTypes}
              onChange={(next) =>
                setDraft({
                  ...draft,
                  examples: draft.examples.map((ex, j) => j === i ? next : ex),
                })}
              onRemove={() =>
                setDraft({ ...draft, examples: draft.examples.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
        <button
          type='button'
          onClick={() => setDraft({ ...draft, examples: [...draft.examples, blankExample()] })}
          className='rp-btn rp-btn-outline mt-3'
        >
          Add example
        </button>
      </div>

      {problems.length > 0 && (
        <div
          className='rounded-[var(--rp-radius)] border px-4 py-3 text-sm'
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

      {message && <MessagePanel message={message} />}

      {log.length > 0 && (
        <ol className='max-h-56 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface p-3 text-xs'>
          {log.map((event, index) => (
            <li key={index} className='flex gap-2'>
              {event.type === 'stage' && (
                <span className='font-semibold text-ink'>{event.label}</span>
              )}
              {event.type === 'item' && (
                <span className='text-ink-2' title={event.detail}>{event.label}</span>
              )}
              {event.type === 'done' && (
                <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>Finished.</span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>{event.message}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {dirty && (
        <div className='sticky bottom-0 z-10 -mx-4 border-t border-line bg-surface-2 px-4 py-3 shadow-[var(--rp-shadow-md)]'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <label className='flex items-start gap-2 text-sm text-ink-2'>
              <input
                type='checkbox'
                checked={applyExisting}
                disabled={saving}
                onChange={(e) => setApplyExisting(e.target.checked)}
                className='mt-0.5'
              />
              <span>
                Re-extract across existing resources
                <span className='block text-xs text-ink-3'>
                  Runs the new strategy over everything already ingested, not just future additions.
                </span>
              </span>
            </label>
            <button
              type='button'
              disabled={!canSave}
              onClick={() => void onSave()}
              className='rp-btn rp-btn-primary shrink-0'
            >
              {saving ? 'Saving…' : 'Save and re-register agent'}
            </button>
          </div>
          <p className='mt-2 text-xs text-ink-3'>
            Saving replaces the live extraction agent. Existing graph data remains until
            re-extraction updates it.
          </p>
        </div>
      )}
    </div>
  )
}
