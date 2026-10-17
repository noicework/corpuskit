import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from './AccessProvider.tsx'
import {
  AlertCircle,
  Bookmark,
  BookmarkFilled,
  Check,
  ChevronDown,
  Pin,
  Plus,
  X,
} from './icons.tsx'
import { Button, IconButton } from './ui.tsx'
import type { ResearchUi } from '../lib/research-copy.ts'
import {
  createResearchStorageContext,
  type CurrentInvestigation,
  readCurrentInvestigation,
  registerResearchCleanup,
  researchStorageCurrent,
  writeCurrentInvestigation,
} from '../lib/research-storage.ts'
// Aliased: the DOM `KeyboardEvent` is used for the document-level listeners
// below, so React's synthetic one must not shadow it.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addEvidence,
  createInvestigation,
  type InvestigationMeta,
  listInvestigations,
  type NewEvidence,
  saveArtefact,
} from '../api/client.ts'

// ---------------------------------------------------------------------------
// "Save to investigation" - the universal affordance that promotes a passage
// to Evidence. Renders as a quiet button; opens a picker of the client's
// investigations with inline creation. Used on search results, answer
// sources, evidence tables and the document reader.
//
// An authorised researcher can mark one investigation current in its identity
// and authority generation. Only anonymous public references persist locally. Once set, Save becomes a one-click action straight into it -
// the chevron alongside still opens the full picker to switch or start new.
// ---------------------------------------------------------------------------

const CURRENT_INVESTIGATION_EVENT = 'rp-current-investigation-change'

export function useResearchStorage(slug: string) {
  const access = useAccess()
  return useMemo(() => createResearchStorageContext(access.controller, slug), [
    access.controller,
    access.generation,
    slug,
  ])
}

export function useCurrentInvestigation(slug: string): CurrentInvestigation | null {
  const storage = useResearchStorage(slug)
  const [current, setCurrent] = useState(() => readCurrentInvestigation(storage))
  useLayoutEffect(() => {
    const onChange = () => setCurrent(readCurrentInvestigation(storage))
    onChange()
    const unregister = registerResearchCleanup(storage, () => setCurrent(null))
    globalThis.addEventListener(CURRENT_INVESTIGATION_EVENT, onChange)
    globalThis.addEventListener('storage', onChange)
    return () => {
      unregister()
      globalThis.removeEventListener(CURRENT_INVESTIGATION_EVENT, onChange)
      globalThis.removeEventListener('storage', onChange)
    }
  }, [storage])
  return researchStorageCurrent(storage) ? current : null
}

function truncateName(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, Math.max(0, max - 1))}…` : name
}

/**
 * True on a phone-width viewport, where an anchored dropdown has nowhere to
 * go: the trigger is usually right-aligned, so the panel runs off the right
 * edge and up over the site header. Below this width the picker becomes a
 * bottom sheet instead.
 */
const COMPACT_QUERY = '(max-width: 639.98px)'

function useCompactViewport(): boolean {
  // Resolved during the first render, not in an effect afterwards: the picker
  // mounts already open, and a first paint as the wrong shape would rebuild
  // the panel a frame later - throwing away the focus just moved into it.
  const [compact, setCompact] = useState(() => globalThis.matchMedia?.(COMPACT_QUERY).matches)

  useEffect(() => {
    const query = globalThis.matchMedia(COMPACT_QUERY)
    const apply = () => setCompact(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  return compact ?? false
}

/**
 * How much of the bottom of the layout viewport the software keyboard is
 * covering. iOS does not shrink the layout viewport (nor `100dvh`) when the
 * keyboard opens, so a sheet anchored to the bottom sits behind it and its
 * "New investigation" field becomes untypeable; `visualViewport` is the only
 * thing that reports the genuinely visible area. Same reasoning the assistant
 * composer uses to stay above the keyboard.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const viewport = globalThis.visualViewport
    if (!viewport) return
    const apply = () => {
      const covered = document.documentElement.clientHeight - viewport.height - viewport.offsetTop
      // Under a keyboard's worth is browser chrome animating (the iOS URL bar
      // collapsing); reacting to that would make the sheet twitch.
      setInset(covered > 80 ? Math.round(covered) : 0)
    }
    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
    }
  }, [])

  return inset
}

/** The focusable descendants of a panel, in tab order. */
function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return [
    ...panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ]
}

/**
 * The "make current" toggle. `variant='chip'` (default) is a labelled chip for
 * a card or a header; `variant='icon'` is a compact pin-only button for tight
 * rows such as picker entries.
 */
export function MakeCurrentToggle({
  slug,
  investigation,
  variant = 'chip',
  className,
}: {
  slug: string
  investigation: { id: string; name: string }
  variant?: 'chip' | 'icon'
  className?: string
}) {
  const { ui } = usePortalLocale()
  const current = useCurrentInvestigation(slug)
  const storage = useResearchStorage(slug)
  const access = useAccess()
  const canWrite = () =>
    researchStorageCurrent(storage) &&
    access.controller.can('portal.investigate', { kind: 'portal', slug })
  const isCurrent = current?.id === investigation.id

  const toggle = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canWrite()) return
    writeCurrentInvestigation(
      storage,
      isCurrent ? null : { id: investigation.id, name: investigation.name },
    )
    globalThis.dispatchEvent(new Event(CURRENT_INVESTIGATION_EVENT))
  }

  if (!canWrite()) return null

  if (variant === 'icon') {
    return (
      <button
        type='button'
        onClick={toggle}
        aria-pressed={isCurrent}
        title={isCurrent ? ui('Current investigation') : ui('Make current')}
        aria-label={isCurrent ? ui('Current investigation') : ui('Make current')}
        className={`rp-btn rp-btn-sm rp-btn-ghost rp-icon-btn shrink-0 ${
          isCurrent ? 'text-[var(--rp-accent-fg)]' : 'text-ink-3'
        } ${className ?? ''}`}
      >
        <Pin size='sm' />
        <span className='sr-only'>
          {isCurrent ? ui('Current investigation') : ui('Make current')}
        </span>
      </button>
    )
  }

  return (
    <button
      type='button'
      onClick={toggle}
      aria-pressed={isCurrent}
      className={`rp-chip rp-answer-chip ${isCurrent ? 'rp-chip-active' : ''} ${className ?? ''}`}
    >
      <Pin size='sm' />
      {isCurrent ? ui('Current investigation') : ui('Make current')}
      {isCurrent ? <Check size='sm' /> : null}
    </button>
  )
}

/**
 * Shared picker body used by both save buttons below.
 *
 * Two presentations for one panel. On a wide screen it stays the anchored
 * dropdown it has always been, hanging off the right edge of its trigger. On a
 * phone that shape has nowhere to go - the trigger sits at the right of a
 * header row, so a 16rem panel runs off the screen and up over the site
 * chrome - so the same content becomes a modal bottom sheet portalled to the
 * body: full width inside the viewport, riding above the software keyboard,
 * with a close control, and never overlapping anything because it is drawn
 * over its own backdrop.
 *
 * Focus moves into the panel on open and returns to whatever opened it on
 * close in both presentations; the sheet, being modal, also traps Tab.
 */
function InvestigationPicker({
  slug,
  investigations,
  busy,
  error,
  newName,
  onNewNameChange,
  onPick,
  onCreate,
  onClose,
  panelRef,
  ariaLabel,
}: {
  slug: string
  investigations: InvestigationMeta[] | undefined
  busy: boolean
  error: boolean
  newName: string
  onNewNameChange: (value: string) => void
  onPick: (investigationId: string, name: string) => void
  onCreate: () => void
  /** Dismisses the picker - the sheet's close control and its backdrop. */
  onClose: () => void
  /**
   * Handed up so the opener's outside-click check can treat the panel as
   * inside itself. The sheet is portalled to the body, so it is not a DOM
   * descendant of the trigger and would otherwise dismiss on its own taps.
   */
  panelRef: MutableRefObject<HTMLDivElement | null>
  ariaLabel: string
}) {
  const { ui } = usePortalLocale()
  const compact = useCompactViewport()
  const keyboardInset = useKeyboardInset()

  // Focus in on open, and back to the trigger on close. The opener may have
  // been replaced by the "Saved to ..." status by then, so only restore to an
  // element still in the document.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => {
      if (opener && document.contains(opener)) opener.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function trapTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = focusablesIn(panel)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const body = (
    <>
      {error
        ? (
          <p
            role='alert'
            className='flex items-start gap-1.5 px-1 pb-1 text-xs text-[var(--rp-bad-ink)]'
          >
            <AlertCircle size='sm' className='shrink-0' />
            {ui('Could not save - try again.')}
          </p>
        )
        : null}
      <div className={compact ? 'max-h-[40vh] overflow-y-auto' : 'max-h-44 overflow-y-auto'}>
        {(investigations ?? []).filter((i) => i.status === 'active').map((investigation) => (
          <div key={investigation.id} className='flex items-center gap-0.5'>
            <button
              type='button'
              disabled={busy}
              onClick={() =>
                onPick(investigation.id, investigation.name)}
              className='rp-focus flex min-h-[2.75rem] min-w-0 flex-1 items-center justify-between gap-2 rounded-[var(--rp-radius-btn)] px-2 py-2 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)] lg:py-1.5'
            >
              <span className='truncate'>{investigation.name}</span>
              <span className='shrink-0 text-xs text-ink-3'>{investigation.evidenceCount}</span>
            </button>
            <MakeCurrentToggle slug={slug} investigation={investigation} variant='icon' />
          </div>
        ))}
        {investigations && investigations.length === 0
          ? (
            <p className='px-2 py-1.5 text-xs text-ink-3'>
              {ui('No investigations yet - start one below.')}
            </p>
          )
          : null}
      </div>
      <form
        className='mt-1 flex items-center gap-1 border-t border-line pt-2'
        onSubmit={(event) => {
          event.preventDefault()
          onCreate()
        }}
      >
        <input
          type='text'
          value={newName}
          onChange={(event) => onNewNameChange(event.target.value)}
          placeholder={ui('New investigation…')}
          aria-label={ui('New investigation name')}
          className='rp-input min-w-0 flex-1 text-sm'
        />
        <button
          type='submit'
          disabled={busy || newName.trim().length === 0}
          className='rp-btn rp-btn-sm rp-btn-primary shrink-0'
        >
          <Plus size='sm' />
          {busy ? '…' : ui('Create')}
        </button>
      </form>
    </>
  )

  if (!compact) {
    return (
      <div
        ref={panelRef}
        tabIndex={-1}
        role='dialog'
        aria-label={ariaLabel}
        className='rp-card rp-shadow-lg rp-focus absolute right-0 z-50 mt-1 w-64 p-2'
      >
        <p className='px-1 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3'>
          {ui('Save to investigation')}
        </p>
        {body}
      </div>
    )
  }

  return createPortal(
    <div className='fixed inset-0 z-[80]'>
      <div
        aria-hidden='true'
        className='rp-scrim absolute inset-0 touch-none'
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role='dialog'
        aria-modal='true'
        aria-label={ariaLabel}
        onKeyDown={trapTab}
        style={{
          bottom: keyboardInset,
          maxHeight: `calc(100vh - ${keyboardInset}px - 3rem)`,
        }}
        className='rp-shadow-xl rp-focus absolute inset-x-0 flex flex-col overflow-y-auto rounded-t-[var(--rp-radius)] border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]'
      >
        <div className='flex items-center justify-between gap-2 pb-2'>
          <p className='text-xs font-medium uppercase tracking-wide text-ink-3'>
            {ui('Save to investigation')}
          </p>
          <IconButton label={ui('Close')} icon={X} onClick={onClose} />
        </div>
        {body}
      </div>
    </div>,
    document.body,
  )
}

/** Keeps the saved control focusable while making further activations inert. */
export function SaveEvidenceAction({
  compact,
  saved,
  busy,
  current,
  label,
  open,
  ui,
  onSave,
  onPick,
}: {
  compact: boolean
  saved: string | null
  busy: boolean
  current: CurrentInvestigation | null
  label: string
  open: boolean
  ui: ResearchUi
  onSave: () => void
  onPick: () => void
}) {
  const saveLabel = current ? ui('Save to {value1}', { value1: current.name }) : undefined
  return (
    <Button
      variant='outline'
      size={compact ? 'sm' : 'md'}
      leadingIcon={saved ? BookmarkFilled : Bookmark}
      disabled={busy && Boolean(current) && !saved}
      aria-pressed={Boolean(saved)}
      aria-disabled={saved ? true : undefined}
      title={saved ? ui('Saved to {name}', { name: saved }) : saveLabel}
      aria-label={saved
        ? ui('Saved to {name}', { name: saved })
        : saveLabel ?? (label === 'Save' ? ui('Save to investigation') : undefined)}
      aria-expanded={!saved && !current ? open : undefined}
      aria-haspopup={!saved && !current ? 'dialog' : undefined}
      onClick={(event) => {
        if (saved || (busy && current)) {
          event.preventDefault()
          return
        }
        if (current) onSave()
        else onPick()
      }}
    >
      {saved
        ? <span role='status'>{ui('Saved to {name}', { name: saved })}</span>
        : current
        ? busy ? ui('Saving…') : (
          <>
            <span>{ui('Save')}</span>
            <span className='hidden sm:inline'>
              {ui('to {name}', { name: truncateName(current.name) })}
            </span>
          </>
        )
        : label === 'Save'
        ? ui('Save')
        : label}
    </Button>
  )
}

export function SaveEvidenceButton({
  slug,
  evidence,
  compact = false,
  label = 'Save',
}: {
  slug: string
  evidence: NewEvidence
  compact?: boolean
  label?: string
}) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const current = useCurrentInvestigation(slug)
  const storage = useResearchStorage(slug)
  const access = useAccess()
  const canWrite = () =>
    researchStorageCurrent(storage) &&
    access.controller.can('portal.investigate', { kind: 'portal', slug })

  useLayoutEffect(() =>
    registerResearchCleanup(storage, () => {
      setOpen(false)
      setSaved(null)
      setBusy(false)
      setError(false)
      setNewName('')
    }), [storage])

  const { data: investigations } = useQuery({
    queryKey: ['investigations', slug],
    queryFn: () => listInvestigations(slug),
    enabled: open && canWrite(),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      // The phone sheet is portalled to the body, so "inside" means either
      // the trigger or the panel; without the second check its own taps
      // would read as an outside click and dismiss it.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const saveTo = async (investigationId: string, name: string) => {
    if (!canWrite()) return
    setBusy(true)
    setError(false)
    try {
      await addEvidence(slug, investigationId, evidence)
      if (!canWrite()) return
      setSaved(name)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })
    } catch {
      if (canWrite()) setError(true)
    } finally {
      if (canWrite()) setBusy(false)
    }
  }

  const createAndSave = async () => {
    const name = newName.trim()
    if (!name || !canWrite()) return
    setBusy(true)
    setError(false)
    try {
      const investigation = await createInvestigation(slug, {
        name,
        question: evidence.question,
      })
      if (!canWrite()) return
      setNewName('')
      await saveTo(investigation.id, investigation.name)
    } catch {
      if (canWrite()) setError(true)
      if (canWrite()) setBusy(false)
    }
  }

  if (!canWrite()) return null

  if (saved && compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs text-[var(--rp-ok-ink)] ${
          compact ? '' : 'px-1'
        }`}
        role='status'
      >
        <BookmarkFilled size='sm' />
        {ui('Saved to {name}', { name: saved })}
      </span>
    )
  }

  return (
    <div ref={rootRef} className='relative inline-flex items-center gap-1'>
      <SaveEvidenceAction
        compact={compact}
        saved={saved}
        busy={busy}
        current={current}
        label={label}
        open={open}
        ui={ui}
        onSave={() => {
          if (current) void saveTo(current.id, current.name)
        }}
        onPick={() => setOpen((value) => !value)}
      />
      {current && !saved
        ? (
          <IconButton
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='dialog'
            label={ui('Choose a different investigation')}
            icon={ChevronDown}
            variant='outline'
            size={compact ? 'sm' : 'md'}
          />
        )
        : null}
      {open && !saved
        ? (
          <InvestigationPicker
            slug={slug}
            investigations={investigations}
            busy={busy}
            error={error}
            newName={newName}
            onNewNameChange={setNewName}
            onPick={(id, name) => void saveTo(id, name)}
            onCreate={() => void createAndSave()}
            onClose={() => setOpen(false)}
            panelRef={panelRef}
            ariaLabel={ui('Save to investigation')}
          />
        )
        : null}
    </div>
  )
}

/**
 * "Save to investigation" for generated artefacts - same picker, but stores
 * the artefact payload (kind + data) instead of an evidence passage.
 */
export function SaveArtefactButton({
  slug,
  artefact,
}: {
  slug: string
  artefact: { kind: string; title: string; data: unknown }
}) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const current = useCurrentInvestigation(slug)
  const storage = useResearchStorage(slug)
  const access = useAccess()
  const canWrite = () =>
    researchStorageCurrent(storage) &&
    access.controller.can('portal.investigate', { kind: 'portal', slug })

  useLayoutEffect(() =>
    registerResearchCleanup(storage, () => {
      setOpen(false)
      setSaved(null)
      setBusy(false)
      setError(false)
      setNewName('')
    }), [storage])

  const { data: investigations } = useQuery({
    queryKey: ['investigations', slug],
    queryFn: () => listInvestigations(slug),
    enabled: open && canWrite(),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const saveTo = async (investigationId: string, name: string) => {
    if (!canWrite()) return
    setBusy(true)
    setError(false)
    try {
      await saveArtefact(slug, investigationId, artefact)
      if (!canWrite()) return
      setSaved(name)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })
    } catch {
      if (canWrite()) setError(true)
    } finally {
      if (canWrite()) setBusy(false)
    }
  }

  const createAndSave = async () => {
    const name = newName.trim()
    if (!name || !canWrite()) return
    setBusy(true)
    setError(false)
    try {
      const investigation = await createInvestigation(slug, { name })
      if (!canWrite()) return
      setNewName('')
      await saveTo(investigation.id, investigation.name)
    } catch {
      if (canWrite()) setError(true)
      if (canWrite()) setBusy(false)
    }
  }

  if (!canWrite()) return null

  if (saved) {
    return (
      <span
        className='inline-flex items-center gap-1 px-1 text-xs text-[var(--rp-ok-ink)]'
        role='status'
      >
        <BookmarkFilled size='sm' />
        {ui('Saved to {name}', { name: saved })}
      </span>
    )
  }

  return (
    <div ref={rootRef} className='relative inline-flex items-center gap-1'>
      {current
        ? (
          <button
            type='button'
            disabled={busy}
            title={ui('Save to {value1}', { value1: current.name })}
            aria-label={ui('Save to {value1}', { value1: current.name })}
            onClick={() => void saveTo(current.id, current.name)}
            className='rp-btn rp-btn-sm rp-btn-outline'
          >
            {busy ? ui('Saving…') : (
              <>
                <Bookmark size='sm' className='shrink-0' />
                <span>{ui('Save')}</span>
                <span className='hidden sm:inline'>
                  {ui('to {name}', { name: truncateName(current.name) })}
                </span>
              </>
            )}
          </button>
        )
        : (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='dialog'
            aria-label={ui('Save to investigation')}
            className='rp-btn rp-btn-sm rp-btn-outline'
          >
            <Bookmark size='sm' className='shrink-0' />
            <span>{ui('Save')}</span>
            <span className='hidden sm:inline'>{ui('to investigation')}</span>
          </button>
        )}
      {current
        ? (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='dialog'
            aria-label={ui('Choose a different investigation')}
            title={ui('Choose a different investigation')}
            className='rp-btn rp-btn-sm rp-btn-outline rp-icon-btn'
          >
            <ChevronDown size='sm' />
          </button>
        )
        : null}
      {open
        ? (
          <InvestigationPicker
            slug={slug}
            investigations={investigations}
            busy={busy}
            error={error}
            newName={newName}
            onNewNameChange={setNewName}
            onPick={(id, name) => void saveTo(id, name)}
            onCreate={() => void createAndSave()}
            onClose={() => setOpen(false)}
            panelRef={panelRef}
            ariaLabel={ui('Save artefact to investigation')}
          />
        )
        : null}
    </div>
  )
}
