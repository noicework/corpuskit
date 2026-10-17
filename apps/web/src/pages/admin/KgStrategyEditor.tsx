import { stageText } from './shared.ts'
import { messageFor } from './shared.ts'
import type { Locale } from '../../lib/portal-locale.tsx'
import { englishUi } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { KgImplementEvent } from '@research-portal/core'
import { getGraphStrategy, type GraphStrategy, saveGraphStrategy } from '../../api/client.ts'
import { Button, EmptyState, ErrorCard, SectionHeader, Skeleton } from '../../components/ui.tsx'
import { ArrowRight, Bookmark, Plus, RotateCw, Trash } from '../../components/icons.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
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
function validate(draft: Draft, ui: Locale['ui'] = englishUi): string[] {
  const problems: string[] = []

  if (draft.entityTypes.length === 0) problems.push(ui('Add at least one entity type.'))
  if (draft.entityTypes.some((t) => !t.label.trim())) {
    problems.push(ui('Every entity type needs a name.'))
  }
  const seenTypes = new Set<string>()
  for (const t of draft.entityTypes) {
    const key = t.label.trim().toLowerCase()
    if (!key) continue
    if (seenTypes.has(key)) {
      problems.push(
        ui('Entity type "{value1}" is defined more than once.', { value1: t.label.trim() }),
      )
    }
    seenTypes.add(key)
  }

  if (draft.examples.length < 6) {
    const remaining = 6 - draft.examples.length
    problems.push(
      ui(
        remaining === 1
          ? 'Add {remaining} more worked example (6 minimum).'
          : 'Add {remaining} more worked examples (6 minimum).',
        {
          remaining: remaining,
        },
      ),
    )
  }

  draft.examples.forEach((example, i) => {
    const n = i + 1
    if (!example.text.trim()) problems.push(ui('Example {n}: the text is empty.', { n: n }))
    if (example.entities.length < 2) {
      problems.push(ui('Example {n}: needs at least 2 entities.', { n: n }))
    }
    if (example.relations.length < 1) {
      problems.push(ui('Example {n}: needs at least 1 relation.', { n: n }))
    }

    const names = new Set<string>()
    example.entities.forEach((en) => {
      const name = en.name.trim()
      if (!name) problems.push(ui('Example {n}: an entity has no name.', { n: n }))
      else names.add(name.toLowerCase())
      if (!en.label.trim()) {
        problems.push(
          ui('Example {n}: entity "{value2}" has no type.', {
            n: n,
            value2: name || ui('(unnamed)'),
          }),
        )
      } else if (!seenTypes.has(en.label.trim().toLowerCase())) {
        problems.push(
          ui('Example {n}: entity "{value2}" uses undefined type "{value3}".', {
            n: n,
            value2: name || ui('(unnamed)'),
            value3: en.label.trim(),
          }),
        )
      }
    })

    example.relations.forEach((r) => {
      if (!r.label.trim()) problems.push(ui('Example {n}: a relation has no label.', { n: n }))
      if (!r.source.trim() || !names.has(r.source.trim().toLowerCase())) {
        problems.push(
          ui('Example {n}: relation source "{value2}" is not one of this example\'s entities.', {
            n: n,
            value2: r.source || ui('(none)'),
          }),
        )
      }
      if (!r.target.trim() || !names.has(r.target.trim().toLowerCase())) {
        problems.push(
          ui('Example {n}: relation target "{value2}" is not one of this example\'s entities.', {
            n: n,
            value2: r.target || ui('(none)'),
          }),
        )
      }
    })
  })

  return problems
}

function ConfirmRemoveExample({ onConfirm }: { onConfirm: () => void }) {
  const { ui } = usePortalLocale()
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Button variant='danger' size='sm' leadingIcon={Trash} onClick={() => setConfirming(true)}>
        {ui('Remove example')}
      </Button>
      {confirming && (
        <ConfirmActionDialog
          title={ui('Remove example')}
          description={ui('Remove this worked example from the strategy?')}
          confirmLabel={ui('Remove example')}
          cancelLabel={ui('Keep example')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            onConfirm()
          }}
        />
      )}
    </>
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
  const { ui } = usePortalLocale()

  const disabled = usedIn.length > 0
  const reason = ui('Used by example {examples} - remove those references first.', {
    examples: usedIn.map((i) => i + 1).join(', '),
  })

  return (
    <div className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border-b border-line pb-3 last:border-0 last:pb-0 sm:flex sm:flex-row sm:flex-wrap'>
      <span
        aria-hidden='true'
        className='mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full'
        style={{ background: colourFor(index) }}
      />
      <input
        className='rp-input col-start-2 min-w-0 w-full sm:w-auto sm:flex-1'
        aria-label={ui('Type name, e.g. Person')}
        placeholder={ui('Type name, e.g. Person')}
        value={type.label}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <input
        className='rp-input col-start-2 min-w-0 w-full sm:w-auto sm:flex-[2]'
        aria-label={ui('Description (optional)')}
        placeholder={ui('Description (optional)')}
        value={type.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <Button
        size='sm'
        leadingIcon={Trash}
        variant='danger'
        type='button'
        disabled={disabled}
        title={disabled ? reason : undefined}
        onClick={onRemove}
        className='col-start-2 justify-self-start shrink-0'
      >
        {ui('Remove')}
      </Button>
      {disabled && (
        <p className='col-start-2 text-xs text-ink-3 sm:basis-full sm:pl-[1.125rem]'>{reason}</p>
      )}
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
  const { ui } = usePortalLocale()

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
    <div className='min-w-0 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border border-line bg-surface-2 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <p className='text-xs font-semibold text-ink-3'>{ui('Example ')}{index + 1}</p>
        <ConfirmRemoveExample onConfirm={onRemove} />
      </div>

      <textarea
        className='rp-input mt-2 min-w-0'
        aria-label={`${ui('Example ')}${index + 1}`}
        rows={3}
        placeholder={ui('Paste or write a representative passage…')}
        value={example.text}
        onChange={(e) => onChange({ ...example, text: e.target.value })}
      />

      <div className='mt-3'>
        <p className='rp-eyebrow text-ink-3'>{ui('Entities')}</p>
        <div className='mt-1.5 space-y-1.5'>
          {example.entities.map((en, i) => {
            const typeIndex = entityTypes.findIndex((t) =>
              t.label.trim() !== '' &&
              t.label.trim().toLowerCase() === en.label.trim().toLowerCase()
            )
            return (
              <div
                key={i}
                className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b border-line pb-3 last:border-0 last:pb-0 sm:flex sm:flex-wrap'
              >
                <span
                  aria-hidden='true'
                  className='h-2.5 w-2.5 shrink-0 rounded-full'
                  style={{ background: typeIndex >= 0 ? colourFor(typeIndex) : 'var(--rp-line)' }}
                />
                <input
                  className='rp-input col-start-2 min-w-0 w-full sm:w-auto sm:flex-1'
                  aria-label={ui('Name')}
                  placeholder={ui('Name')}
                  value={en.name}
                  onChange={(e) => updateEntity(i, { name: e.target.value })}
                />
                <select
                  className='rp-input rp-select col-start-2 min-w-0 w-full sm:w-auto sm:flex-1'
                  aria-label={ui('Entity type')}
                  value={en.label}
                  onChange={(e) => updateEntity(i, { label: e.target.value })}
                >
                  <option value=''>{ui('Type…')}</option>
                  {entityTypes.map((t, ti) => (
                    <option key={ti} value={t.label}>{t.label || ui('(unnamed)')}</option>
                  ))}
                </select>
                <Button
                  variant='danger'
                  leadingIcon={Trash}
                  size='sm'
                  type='button'
                  onClick={() => removeEntity(i)}
                  className='col-start-2 justify-self-start shrink-0'
                >
                  {ui('Remove')}
                </Button>
              </div>
            )
          })}
        </div>
        <Button
          leadingIcon={Plus}
          variant='outline'
          type='button'
          onClick={addEntity}
          className='mt-2'
        >
          {ui('Add entity')}
        </Button>
      </div>

      <div className='mt-3'>
        <p className='rp-eyebrow text-ink-3'>{ui('Relations')}</p>
        <div className='mt-1.5 space-y-1.5'>
          {example.relations.map((r, i) => (
            <div
              key={i}
              className='flex min-w-0 flex-col items-start gap-2 border-b border-line pb-3 last:border-0 last:pb-0 sm:flex-row sm:flex-wrap sm:items-center'
            >
              <select
                className='rp-input rp-select min-w-0 w-full sm:w-auto sm:flex-1'
                aria-label={ui('Relation source')}
                value={r.source}
                onChange={(e) => updateRelation(i, { source: e.target.value })}
              >
                <option value=''>{ui('source…')}</option>
                {entityNames.map((name, ni) => <option key={ni} value={name}>{name}</option>)}
              </select>
              <input
                className='rp-input min-w-0 w-full sm:w-auto sm:flex-1'
                aria-label={ui('e.g. funds, develops, studies')}
                placeholder={ui('e.g. funds, develops, studies')}
                value={r.label}
                onChange={(e) => updateRelation(i, { label: e.target.value })}
              />
              <ArrowRight size='sm' className='hidden shrink-0 text-ink-3 sm:block' />
              <select
                className='rp-input rp-select min-w-0 w-full sm:w-auto sm:flex-1'
                aria-label={ui('Relation target')}
                value={r.target}
                onChange={(e) => updateRelation(i, { target: e.target.value })}
              >
                <option value=''>{ui('target…')}</option>
                {entityNames.map((name, ni) => <option key={ni} value={name}>{name}</option>)}
              </select>
              <Button
                variant='danger'
                leadingIcon={Trash}
                size='sm'
                type='button'
                onClick={() => removeRelation(i)}
                className='col-start-2 justify-self-start shrink-0'
              >
                {ui('Remove')}
              </Button>
            </div>
          ))}
        </div>
        <Button
          leadingIcon={Plus}
          variant='outline'
          type='button'
          onClick={addRelation}
          className='mt-2'
        >
          {ui('Add relation')}
        </Button>
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
function KgStrategyEditorContent({ slug }: { slug: string }) {
  const { language, ui, error: localError } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess('graph.write', {
    kind: 'portal',
    slug,
  })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getGraphStrategy>>>()
  const queryClient = useQueryClient()
  const { data: sessionData, isLoading, isError } = useQuery({
    queryKey: ['kg-strategy', slug],
    enabled: sessionAllowed,
    retry: false,
    queryFn: () => getGraphStrategy(slug, sessionAccess),
  })

  const data = sessionAllowed ? sessionData : snapshot
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

  const load = async () => {
    try {
      const result = await runExplicit(ui('Load the current graph strategy'), async (access) => {
        const result = await getGraphStrategy(slug, access)
        if (
          !result ||
          (result.strategy !== null &&
            (!Array.isArray(result.strategy?.entityDefs) ||
              !Array.isArray(result.strategy?.examples)))
        ) throw new AdminAccessError()
        return result
      })
      assertCurrent()
      if (result !== undefined) {
        if (sessionAllowed) queryClient.setQueryData(['kg-strategy', slug], result)
        else setSnapshot(result)
      }
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not load the strategy.', localError),
        ),
      )
    }
  }
  const readControl = (
    <Button
      leadingIcon={RotateCw}
      variant='ghost'
      size='sm'
      type='button'
      data-graph-read='strategy'
      onClick={() => void load()}
    >
      {ui('Load current strategy')}
    </Button>
  )
  const sectionHeader = (
    <SectionHeader
      className='rp-manage-section-head'
      title={ui('Current strategy')}
      description={ui(
        'The entity types and worked examples that teach the extraction agent what to pull out - fully editable.',
      )}
      actions={readControl}
    />
  )
  if (isLoading) {
    return (
      <div className='space-y-4'>
        {sectionHeader}
        <Skeleton className='h-9 w-full' />
      </div>
    )
  }
  if (!data?.strategy || !draft) {
    return (
      <div className='space-y-3'>
        {sectionHeader}
        {isError && (
          <ErrorCard
            message={ui('Could not load the knowledge-graph strategy.')}
            onRetry={() => void load()}
          />
        )}
        <EmptyState
          title={ui('Load the current graph strategy')}
          description={ui(
            'Read the strategy before editing. If no agent is registered, propose and implement one above.',
          )}
        />
        {message && <MessagePanel message={message} />}
      </div>
    )
  }

  const problems = validate(draft, ui)
  const referenced = referencedTypes(draft)
  const canSave = dirty && problems.length === 0 && !saving

  const onSave = async () => {
    setSaving(true)
    setLog([])
    setMessage(null)
    try {
      const result = await runExplicit(ui('Save the graph strategy'), async (access) => {
        let completed = false
        let failed = false
        await saveGraphStrategy(
          slug,
          access,
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
            assertCurrent()
            setLog((prev) => [...prev, event])
            if (event.type === 'error') failed = true
            if (event.type === 'done') {
              completed = Number.isFinite(event.agents)
              setMessage(messageFor('ok', ({ ui }) =>
                ui(
                  event.agents === 1
                    ? 'Strategy saved - {count} agent re-registered.'
                    : 'Strategy saved - {count} agents re-registered.',
                  { count: event.agents },
                )))
            }
            if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
          },
        )
        if (!completed || failed) throw new AdminAccessError()
        return true
      })
      assertCurrent()
      if (result === undefined) return
      baselineRef.current = draft
      dirtyRef.current = false
      setDraft({ ...draft })
      if (sessionAllowed) {
        await queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] })
      }
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save the strategy.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setSaving(false)
    }
  }

  return (
    <div className='min-w-0 space-y-5 pb-1'>
      {sectionHeader}
      <div>
        <SectionHeader
          className='rp-manage-section-head'
          headingLevel={3}
          title={ui('Entity types')}
          description={ui('The kinds of things the extractor recognises.')}
        />
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
        <Button
          variant='outline'
          leadingIcon={Plus}
          type='button'
          onClick={() =>
            setDraft({
              ...draft,
              entityTypes: [...draft.entityTypes, { label: '', description: '' }],
            })}
          className='mt-2'
        >
          {ui('Add entity type')}
        </Button>
      </div>

      <div>
        <SectionHeader
          className='rp-manage-section-head'
          headingLevel={3}
          title={ui('Worked examples')}
          description={ui(
            'Worked examples teach the extractor which relations matter - at least six are needed.',
          )}
          actions={
            <span
              className={`rp-badge ${draft.examples.length >= 6 ? 'rp-badge-ok' : 'rp-badge-warn'}`}
            >
              {draft.examples.length}
              {ui(' of 6+ examples')}
            </span>
          }
        />
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
        <Button
          variant='outline'
          leadingIcon={Plus}
          type='button'
          onClick={() => setDraft({ ...draft, examples: [...draft.examples, blankExample()] })}
          className='mt-3'
        >
          {ui('Add example')}
        </Button>
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
          <p className='font-medium'>{ui('Before this can be saved:')}</p>
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
                <span className='font-semibold text-ink'>
                  {stageText(event.label, { language, ui })}
                </span>
              )}
              {event.type === 'item' && (
                <span className='text-ink-2' title={event.detail}>{event.label}</span>
              )}
              {event.type === 'done' && (
                <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>
                  {ui('Finished.')}
                </span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>
                  {localError(event.message, 'The action failed. Please try again.')}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {dirty && (
        <div className='sticky bottom-0 z-10 border-t border-line bg-surface py-3 shadow-[var(--rp-shadow-md)]'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <label className='rp-check min-w-0 items-start text-sm text-ink-2'>
              <input
                type='checkbox'
                checked={applyExisting}
                disabled={saving}
                onChange={(e) => setApplyExisting(e.target.checked)}
                className='mt-0.5'
              />
              <span>
                {ui('Re-extract across existing resources')}
                <span className='block text-xs text-ink-3'>
                  {ui(
                    'Runs the new strategy over everything already ingested, not just future additions.',
                  )}
                </span>
              </span>
            </label>
            <Button
              variant='primary'
              leadingIcon={Bookmark}
              type='button'
              disabled={!canSave}
              onClick={() => void onSave()}
              className='shrink-0'
            >
              {saving ? ui('Saving…') : ui('Save and re-register agent')}
            </Button>
          </div>
          <p className='mt-2 text-xs text-ink-3'>
            {ui(
              'Saving replaces the live extraction agent. Existing graph data remains until re-extraction updates it.',
            )}
          </p>
        </div>
      )}
    </div>
  )
}

export function KgStrategyEditor(props: { slug: string }) {
  const access = useAccess()
  const permission = usePermissionAdminAccess('graph.write', { kind: 'portal', slug: props.slug })
  if (
    access.state.status !== 'ready' || (!permission.sessionAllowed && !permission.breakGlassEnabled)
  ) return null
  return <KgStrategyEditorContent key={`${props.slug}:${access.generation}`} {...props} />
}
