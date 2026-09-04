import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  type AccountMenuTabDirection,
  accountTriggerAttributes,
  nextAccountMenuIndex,
} from './account-menu-behaviour.ts'

const MENU_ITEM_SELECTOR = '[role="menuitem"]'
const PAGE_TAB_STOP_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type AccountMenuVariant = 'header' | 'mobile'

type AccountMenuProps = {
  isAdmin: boolean
  label: string
  manageHref: string
  onProfile: () => void
  variant?: AccountMenuVariant
  onTabOut?: (direction: AccountMenuTabDirection) => void
}

function AccountIcon({ className }: { className: string }) {
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
      <circle cx='12' cy='8.5' r='3.75' />
      <path d='M4.5 20a7.5 7.5 0 0115 0' />
    </svg>
  )
}

function visibleTabStops(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(PAGE_TAB_STOP_SELECTOR)).filter(
    (element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  )
}

/**
 * An admin-only menu button. Mouse hover may reveal it, but activation owns
 * focus and the full menu-button keyboard contract. It deliberately does not
 * close on pointer leave, satisfying the persistence requirement for content
 * disclosed on hover.
 */
export function AccountMenu({
  isAdmin,
  label,
  manageHref,
  onProfile,
  variant = 'header',
  onTabOut,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const generatedId = useId()
  const triggerId = `account-trigger-${generatedId}`
  const menuId = `account-menu-${generatedId}`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const focusOnOpen = useRef<'first' | 'last' | null>(null)

  const triggerAttributes = accountTriggerAttributes(isAdmin, open, menuId)

  useEffect(() => {
    if (!open) return

    if (focusOnOpen.current) {
      const frame = requestAnimationFrame(() => {
        const items = panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)
        const target = focusOnOpen.current === 'last' ? items?.[items.length - 1] : items?.[0]
        focusOnOpen.current = null
        target?.focus()
      })
      return () => cancelAnimationFrame(frame)
    }
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
    const items = panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)
    const target = position === 'last' ? items?.[items.length - 1] : items?.[0]
    if (target) {
      target.focus()
      return
    }
    focusOnOpen.current = position
    setOpen(true)
  }

  function moveFocusOut(direction: AccountMenuTabDirection) {
    setOpen(false)
    if (onTabOut) {
      onTabOut(direction)
      return
    }
    const trigger = triggerRef.current
    if (!trigger) return
    const stops = visibleTabStops().filter((element) => !panelRef.current?.contains(element))
    const current = stops.indexOf(trigger)
    const target = direction === 'backward' ? stops[current - 1] : stops[current + 1]
    ;(target ?? trigger).focus()
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!isAdmin) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
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
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? [],
    )
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    items[nextAccountMenuIndex(current, items.length, direction)]?.focus()
  }

  const buttonClass = variant === 'header'
    ? `rp-focus flex h-[calc(2.75rem*var(--rp-density-ctl,1))] w-[calc(2.75rem*var(--rp-density-ctl,1))] shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
      isAdmin ? 'hover:bg-[var(--rp-surface-2)]' : ''
    }`
    : 'rp-navsheet-action rp-focus-inverse w-full'

  const button = (
    <button
      ref={triggerRef}
      id={triggerId}
      type='button'
      onClick={() => isAdmin ? openAndFocus('first') : onProfile()}
      onKeyDown={onTriggerKeyDown}
      aria-label={label}
      title={label}
      {...triggerAttributes}
      className={buttonClass}
      style={variant === 'header'
        ? {
          borderColor: 'color-mix(in srgb, var(--rp-primary) 25%, transparent)',
          color: 'var(--rp-primary)',
        }
        : undefined}
    >
      <AccountIcon className={variant === 'header' ? 'h-6 w-6' : 'h-5 w-5 shrink-0'} />
      {variant === 'mobile' ? label : null}
    </button>
  )

  if (!isAdmin) return button

  const menuSurface = (
    <div
      ref={panelRef}
      id={menuId}
      role='menu'
      aria-labelledby={triggerId}
      onKeyDown={onMenuKeyDown}
      className={`rp-anim-fade rp-shadow-lg w-[min(12rem,calc(100vw-1rem))] rounded-[var(--rp-radius)] border border-line bg-surface p-1.5 ${
        variant === 'mobile' ? 'shrink-0' : ''
      }`}
    >
      <Link
        to={manageHref}
        role='menuitem'
        tabIndex={-1}
        onClick={() => setOpen(false)}
        className='rp-focus flex min-h-[calc(2.25rem*var(--rp-density-ctl,1))] w-full items-center rounded-[var(--rp-radius-btn)] px-[var(--rp-btn-px)] py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
      >
        Manage Account
      </Link>
      <button
        type='button'
        role='menuitem'
        tabIndex={-1}
        onClick={() => {
          setOpen(false)
          onProfile()
        }}
        className='rp-focus flex min-h-[calc(2.25rem*var(--rp-density-ctl,1))] w-full items-center rounded-[var(--rp-radius-btn)] px-[var(--rp-btn-px)] py-2 text-left text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
      >
        Profile
      </button>
    </div>
  )

  return (
    <div
      ref={wrapperRef}
      className={variant === 'header' ? 'relative shrink-0' : 'relative min-w-0'}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setOpen(true)
      }}
    >
      {button}
      {open
        ? variant === 'header'
          ? <div className='absolute right-0 top-full z-50 pt-1'>{menuSurface}</div>
          : <div className='flex justify-end pt-2'>{menuSurface}</div>
        : null}
    </div>
  )
}
