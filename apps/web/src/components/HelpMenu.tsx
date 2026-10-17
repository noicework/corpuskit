import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { Link } from 'react-router-dom'
import { nextAccountMenuIndex } from './account-menu-behaviour.ts'
import { HELP_MENU_LABEL, type HelpMenuItem, helpMenuItems } from './help-menu-items.ts'
import { HelpCircle, type IconSize, Workflow } from './icons.tsx'
import { IconButton } from './ui.tsx'

const MENU_ITEM_SELECTOR = '[role="menuitem"]'
const PAGE_TAB_STOP_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The icon for one help destination, shared by the menu and the phone sheet. */
export function HelpItemIcon({
  item,
  className,
  size = 'md',
}: { item: HelpMenuItem; className?: string; size?: IconSize }) {
  return item.key === 'how'
    ? <Workflow size={size} className={className} />
    : <HelpCircle size={size} className={className} />
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
  const { ui } = usePortalLocale()
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
      <IconButton
        ref={triggerRef}
        id={triggerId}
        label={ui(HELP_MENU_LABEL)}
        icon={HelpCircle}
        size='lg'
        onClick={() => open ? setOpen(false) : openAndFocus('first')}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={menuId}
        className='rp-chrome-header-control shrink-0 rounded-full border'
      />
      {open
        ? (
          <div className='absolute right-0 top-full z-50 pt-1'>
            <div
              ref={panelRef}
              id={menuId}
              role='menu'
              aria-labelledby={triggerId}
              onKeyDown={onMenuKeyDown}
              className='rp-chrome-menu rp-card rp-shadow-lg rp-anim-fade w-[min(16rem,calc(100vw-1rem))] p-1.5'
            >
              {items.map((item) => (
                <Link
                  key={item.key}
                  to={item.href}
                  role='menuitem'
                  tabIndex={-1}
                  onClick={() => setOpen(false)}
                  className='rp-chrome-menu-item rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-[var(--rp-btn-px)] py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
                >
                  <HelpItemIcon item={item} size='sm' className='shrink-0 text-ink-2' />
                  <span className='min-w-0 break-words'>{ui(item.label)}</span>
                </Link>
              ))}
            </div>
          </div>
        )
        : null}
    </div>
  )
}
