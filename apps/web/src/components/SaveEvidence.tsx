// Aliased: the DOM `KeyboardEvent` is used for the document-level listeners
// below, so React's synthetic one must not shadow it.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  useEffect,
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
// A tenant can also mark one investigation "current" (kept in localStorage,
// per browser). Once set, Save becomes a one-click action straight into it -
// the chevron alongside still opens the full picker to switch or start new.
// ---------------------------------------------------------------------------

export interface CurrentInvestigation {
  id: string
  name: string
}

const CURRENT_INVESTIGATION_EVENT = 'rp-current-investigation-change'

function currentInvestigationKey(slug: string): string {
  return `rp-current-investigation-${slug}`
}

/** Read the tenant's current investigation from localStorage - null if none is set. */
export function getCurrentInvestigation(slug: string): CurrentInvestigation | null {
  try {
    const raw = localStorage.getItem(currentInvestigationKey(slug))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null && typeof parsed === 'object' &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      typeof (parsed as { name?: unknown }).name === 'string'
    ) {
      return parsed as CurrentInvestigation
    }
    return null
  } catch {
    return null
  }
}

/** Set (or clear, with null) the tenant's current investigation. */
export function setCurrentInvestigation(slug: string, value: CurrentInvestigation | null): void {
  try {
    if (value) localStorage.setItem(currentInvestigationKey(slug), JSON.stringify(value))
    else localStorage.removeItem(currentInvestigationKey(slug))
  } catch {
    // localStorage unavailable (private mode, quota) - current investigation is a
    // convenience, not critical, so fail quietly.
  }
  globalThis.dispatchEvent(new CustomEvent(CURRENT_INVESTIGATION_EVENT, { detail: { slug } }))
}

/**
 * Reactive read of the current investigation - every mounted instance updates
 * the moment any of them calls setCurrentInvestigation, so a badge here and a
 * toggle there never drift out of sync.
 */
export function useCurrentInvestigation(slug: string): CurrentInvestigation | null {
  const [current, setCurrent] = useState(() => getCurrentInvestigation(slug))

  useEffect(() => {
    setCurrent(getCurrentInvestigation(slug))
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ slug: string } | undefined>).detail
      if (!detail || detail.slug === slug) setCurrent(getCurrentInvestigation(slug))
    }
    globalThis.addEventListener(CURRENT_INVESTIGATION_EVENT, onChange)
    globalThis.addEventListener('storage', onChange)
    return () => {
      globalThis.removeEventListener(CURRENT_INVESTIGATION_EVENT, onChange)
      globalThis.removeEventListener('storage', onChange)
    }
  }, [slug])

  return current
}

function truncateName(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, Math.max(0, max - 1))}…` : name
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className={className}>
      <path d='M9.69 18.933a.75.75 0 00.62 0c.204-.093.478-.227.797-.406.636-.357 1.48-.9 2.325-1.634C15.31 15.375 17 13.02 17 10a7 7 0 10-14 0c0 3.02 1.69 5.375 3.268 6.893.845.734 1.689 1.277 2.325 1.634.32.179.593.313.797.406zM10 11.5a2 2 0 110-4 2 2 0 010 4z' />
    </svg>
  )
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className={className}>
      <path
        fillRule='evenodd'
        d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z'
        clipRule='evenodd'
      />
    </svg>
  )
}

/** Bookmark glyph for the Save action - the house stroke idiom. */
function SaveIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.8}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={className}
    >
      <path d='M6 4.5h12a1 1 0 011 1V20l-7-4-7 4V5.5a1 1 0 011-1z' />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.8}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={className}
    >
      <path d='M6 6l12 12M18 6L6 18' />
    </svg>
  )
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
  const current = useCurrentInvestigation(slug)
  const isCurrent = current?.id === investigation.id

  const toggle = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
    setCurrentInvestigation(
      slug,
      isCurrent ? null : { id: investigation.id, name: investigation.name },
    )
  }

  if (variant === 'icon') {
    return (
      <button
        type='button'
        onClick={toggle}
        aria-pressed={isCurrent}
        title={isCurrent ? 'This is your current investigation' : 'Make current'}
        className={`rp-btn rp-btn-ghost h-7 w-7 shrink-0 p-0 ${
          isCurrent ? 'text-[var(--rp-accent-fg)]' : 'text-ink-3'
        } ${className ?? ''}`}
      >
        <PinIcon className='h-3.5 w-3.5' />
        <span className='sr-only'>{isCurrent ? 'Current investigation' : 'Make current'}</span>
      </button>
    )
  }

  return (
    <button
      type='button'
      onClick={toggle}
      aria-pressed={isCurrent}
      className={`rp-chip ${isCurrent ? 'rp-chip-active' : ''} ${className ?? ''}`}
    >
      <PinIcon className='h-3.5 w-3.5' />
      {isCurrent ? 'Current ✓' : 'Make current'}
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
          <p className='px-1 pb-1 text-xs text-[var(--rp-bad-ink)]'>
            Could not save - try again.
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
              className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-[var(--rp-radius)] px-2 text-left text-ink hover:bg-[var(--rp-surface-2)] ${
                compact ? 'min-h-11 py-2 text-sm' : 'py-1.5 text-sm'
              }`}
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
              No investigations yet - start one below.
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
          placeholder='New investigation…'
          aria-label='New investigation name'
          className={`rp-input min-w-0 flex-1 ${compact ? 'h-11 text-sm' : 'h-8 text-xs'}`}
        />
        <button
          type='submit'
          disabled={busy || newName.trim().length === 0}
          className={`rp-btn rp-btn-primary shrink-0 px-3 ${
            compact ? 'h-11 text-sm' : 'h-8 px-2 text-xs'
          }`}
        >
          {busy ? '…' : 'Create'}
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
        className='absolute right-0 z-30 mt-1 w-64 outline-none rounded-[var(--rp-radius)] border border-line bg-surface p-2 shadow-lg'
      >
        <p className='px-1 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3'>
          Save to investigation
        </p>
        {body}
      </div>
    )
  }

  return createPortal(
    <div className='fixed inset-0 z-[90]'>
      <div
        aria-hidden='true'
        className='absolute inset-0 touch-none bg-[color-mix(in_srgb,var(--rp-ink)_45%,transparent)]'
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
        className='absolute inset-x-0 flex flex-col outline-none overflow-y-auto rounded-t-[var(--rp-radius)] border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] shadow-lg'
      >
        <div className='flex items-center justify-between gap-2 pb-2'>
          <p className='text-xs font-medium uppercase tracking-wide text-ink-3'>
            Save to investigation
          </p>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rp-focus -mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--rp-radius-btn)] text-ink-3 transition-colors duration-150 hover:text-ink'
          >
            <CloseIcon className='h-4 w-4' />
          </button>
        </div>
        {body}
      </div>
    </div>,
    document.body,
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
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const current = useCurrentInvestigation(slug)

  const { data: investigations } = useQuery({
    queryKey: ['investigations', slug],
    queryFn: () => listInvestigations(slug),
    enabled: open,
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
    setBusy(true)
    setError(false)
    try {
      await addEvidence(slug, investigationId, evidence)
      setSaved(name)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const createAndSave = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(false)
    try {
      const investigation = await createInvestigation(slug, {
        name,
        question: evidence.question,
      })
      setNewName('')
      await saveTo(investigation.id, investigation.name)
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs text-[var(--rp-ok-ink)] ${
          compact ? '' : 'px-1'
        }`}
        role='status'
      >
        Saved to {saved}
      </span>
    )
  }

  const sizeClass = compact ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-xs'
  // The glyph is for the roomy variants (the document header, the selection
  // popover). Evidence rows and search cards stay exactly as they were: they
  // are already tight, and the word alone reads fine there.
  const icon = compact ? null : <SaveIcon className='h-4 w-4 shrink-0' />

  return (
    <div ref={rootRef} className='relative inline-flex items-center gap-1'>
      {current
        ? (
          <button
            type='button'
            disabled={busy}
            title={`Save to ${current.name}`}
            aria-label={`Save to ${current.name}`}
            onClick={() => void saveTo(current.id, current.name)}
            className={`rp-btn rp-btn-outline ${sizeClass}`}
          >
            {busy ? 'Saving…' : (
              <>
                {icon}
                <span>Save</span>
                {
                  /* The destination is worth its width on a wide screen; on a
                  * phone it is in the accessible name, the tooltip and the
                  * picker, and the confirmation names it after the save. */
                }
                <span className='hidden sm:inline'>to {truncateName(current.name)}</span>
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
            aria-label={label === 'Save' ? 'Save to investigation' : undefined}
            className={`rp-btn rp-btn-outline ${sizeClass}`}
          >
            {icon}
            {label}
          </button>
        )}
      {current
        ? (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='true'
            aria-label='Choose a different investigation'
            title='Choose a different investigation'
            className={`rp-btn rp-btn-outline px-1.5 ${compact ? 'h-7' : 'h-8'}`}
          >
            <ChevronDownIcon className='h-3.5 w-3.5' />
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
            ariaLabel='Save to investigation'
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
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const current = useCurrentInvestigation(slug)

  const { data: investigations } = useQuery({
    queryKey: ['investigations', slug],
    queryFn: () => listInvestigations(slug),
    enabled: open,
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
    setBusy(true)
    setError(false)
    try {
      await saveArtefact(slug, investigationId, artefact)
      setSaved(name)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const createAndSave = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(false)
    try {
      const investigation = await createInvestigation(slug, { name })
      setNewName('')
      await saveTo(investigation.id, investigation.name)
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <span
        className='inline-flex items-center gap-1 px-1 text-xs text-[var(--rp-ok-ink)]'
        role='status'
      >
        Saved to {saved}
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
            title={`Save to ${current.name}`}
            aria-label={`Save to ${current.name}`}
            onClick={() => void saveTo(current.id, current.name)}
            className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
          >
            {busy ? 'Saving…' : (
              <>
                <SaveIcon className='h-4 w-4 shrink-0' />
                <span>Save</span>
                <span className='hidden sm:inline'>to {truncateName(current.name)}</span>
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
            aria-label='Save to investigation'
            className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
          >
            <SaveIcon className='h-4 w-4 shrink-0' />
            <span>Save</span>
            <span className='hidden sm:inline'>to investigation</span>
          </button>
        )}
      {current
        ? (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='true'
            aria-label='Choose a different investigation'
            title='Choose a different investigation'
            className='rp-btn rp-btn-outline h-8 px-1.5'
          >
            <ChevronDownIcon className='h-3.5 w-3.5' />
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
            ariaLabel='Save artefact to investigation'
          />
        )
        : null}
    </div>
  )
}
