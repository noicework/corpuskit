import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { nextAccountMenuIndex } from './account-menu-behaviour.ts'
import { HELP_MENU_LABEL, type HelpMenuItem, helpMenuItems } from './help-menu-items.ts'

const MENU_ITEM_SELECTOR = '[role="menuitem"]'
const PAGE_TAB_STOP_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function HelpIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={className}
      aria-hidden='true'
    >
      <circle cx='12' cy='12' r='9' />
      <path d='M9.4 9.2a2.7 2.7 0 015.2.9c0 1.8-2.6 2.4-2.6 4' />
      <path d='M12 17.4h.01' />
    </svg>
  )
}

/** Three linked steps: the flow the How-this-works page explains. */
export function FlowIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={className}
      aria-hidden='true'
    >
      <rect x='3' y='4' width='6' height='5' rx='1.2' />
      <rect x='15' y='4' width='6' height='5' rx='1.2' />
      <rect x='9' y='15' width='6' height='5' rx='1.2' />
      <path d='M6 9v2.5a2 2 0 002 2h8a2 2 0 002-2V9M12 13.5V15' />
    </svg>
  )
}

/** The icon for one help destination, shared by the menu and the phone sheet. */
export function HelpItemIcon({ item, className }: { item: HelpMenuItem; className: string }) {
  return item.key === 'how'
    ? <FlowIcon className={className} />
    : <HelpIcon className={className} />
}

function visibleTabStops(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(PAGE_TAB_STOP_SELECTOR)).filter(
    (element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  )
}

/**
 * The header's help control: a menu button over the documentation and the
 * How-this-works page. Hover may reveal it; activation owns focus and the
 * menu-button keyboard contract (arrows, Home, End, Escape), matching the
 * account menu beside it. It does not close on pointer leave.
 */
export function HelpMenu({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false)
  const generatedId = useId()
  const triggerId = `help-trigger-${generatedId}`
  const menuId = `help-menu-${generatedId}`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const focusOnOpen = useRef<'first' | 'last' | null>(null)
  const items = helpMenuItems(slug)

  useEffect(() => {
    if (!open || !focusOnOpen.current) return
    const frame = requestAnimationFrame(() => {
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)
      const target = focusOnOpen.current === 'last' ? nodes?.[nodes.length - 1] : nodes?.[0]
      focusOnOpen.current = null
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function openAndFocus(position: 'first' | 'last') {
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)
    const target = position === 'last' ? nodes?.[nodes.length - 1] : nodes?.[0]
    if (target) {
      target.focus()
      return
    }
    focusOnOpen.current = position
    setOpen(true)
  }

  function moveFocusOut(direction: 'forward' | 'backward') {
    setOpen(false)
    const trigger = triggerRef.current
    if (!trigger) return
    const stops = visibleTabStops().filter((element) => !panelRef.current?.contains(element))
    const current = stops.indexOf(trigger)
    const target = direction === 'backward' ? stops[current - 1] : stops[current + 1]
    ;(target ?? trigger).focus()
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openAndFocus(event.key === 'ArrowUp' ? 'last' : 'first')
      return
    }
    if (event.key === 'Tab' && open) setOpen(false)
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      moveFocusOut(event.shiftKey ? 'backward' : 'forward')
      return
    }
    const direction = event.key === 'ArrowDown'
      ? 'next'
      : event.key === 'ArrowUp'
      ? 'previous'
      : event.key === 'Home'
      ? 'first'
      : event.key === 'End'
      ? 'last'
      : null
    if (!direction) return
    const nodes = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? [],
    )
    if (nodes.length === 0) return
    event.preventDefault()
    const current = nodes.indexOf(document.activeElement as HTMLElement)
    nodes[nextAccountMenuIndex(current, nodes.length, direction)]?.focus()
  }

  return (
    <div
      ref={wrapperRef}
      className='relative shrink-0'
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setOpen(true)
      }}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type='button'
        onClick={() => open ? setOpen(false) : openAndFocus('first')}
        onKeyDown={onTriggerKeyDown}
        aria-label={HELP_MENU_LABEL}
        title={HELP_MENU_LABEL}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={menuId}
        className='rp-focus flex h-[calc(2.75rem*var(--rp-density-ctl,1))] w-[calc(2.75rem*var(--rp-density-ctl,1))] shrink-0 items-center justify-center rounded-full border transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
        style={{
          borderColor: 'color-mix(in srgb, var(--rp-brand-fg) 25%, transparent)',
          color: 'var(--rp-brand-fg)',
        }}
      >
        <HelpIcon className='h-6 w-6' />
      </button>
      {open
        ? (
          <div className='absolute right-0 top-full z-50 pt-1'>
            <div
              ref={panelRef}
              id={menuId}
              role='menu'
              aria-labelledby={triggerId}
              onKeyDown={onMenuKeyDown}
              className='rp-anim-fade rp-shadow-lg w-[min(16rem,calc(100vw-1rem))] rounded-[var(--rp-radius)] border border-line bg-surface p-1.5'
            >
              {items.map((item) => (
                <Link
                  key={item.key}
                  to={item.href}
                  role='menuitem'
                  tabIndex={-1}
                  onClick={() => setOpen(false)}
                  className='rp-focus flex min-h-[calc(2.25rem*var(--rp-density-ctl,1))] w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-[var(--rp-btn-px)] py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
                >
                  <HelpItemIcon item={item} className='h-4.5 w-4.5 shrink-0 text-ink-2' />
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        )
        : null}
    </div>
  )
}
