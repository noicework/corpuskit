import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { Link } from 'react-router-dom'
import {
  type AccountEntry,
  type AccountMenuTabDirection,
  accountTriggerAttributes,
  nextAccountMenuIndex,
} from './account-menu-behaviour.ts'
import { Database, History, type IconComponent, Settings, User, Users } from './icons.tsx'
import { IconButton } from './ui.tsx'

const MENU_ITEM_SELECTOR = '[role="menuitem"]'
const PAGE_TAB_STOP_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type AccountMenuVariant = 'header' | 'mobile'

type AccountMenuProps = {
  entries: readonly AccountEntry[]
  portalRole?: string | null
  platformRole?: string | null
  portalName?: string
  label: string
  onProfile: () => void
  variant?: AccountMenuVariant
  onTabOut?: (direction: AccountMenuTabDirection) => void
}

function entryIcon(entry: AccountEntry): IconComponent {
  if (entry.href.endsWith('/manage')) return Settings
  if (entry.href === '/admin/people') return Users
  if (entry.href === '/admin/audit') return History
  return Database
}

function visibleTabStops(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(PAGE_TAB_STOP_SELECTOR)).filter(
    (element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  )
}

/**
 * A supplied-destination menu button. Mouse hover may reveal it, but activation owns
 * focus and the full menu-button keyboard contract. It deliberately does not
 * close on pointer leave, satisfying the persistence requirement for content
 * disclosed on hover.
 */
export function AccountMenu({
  entries,
  portalRole,
  platformRole,
  portalName,
  label,
  onProfile,
  variant = 'header',
  onTabOut,
}: AccountMenuProps) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const generatedId = useId()
  const triggerId = `account-trigger-${generatedId}`
  const menuId = `account-menu-${generatedId}`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const focusOnOpen = useRef<'first' | 'last' | null>(null)

  const hasEntries = entries.length > 0
  const triggerAttributes = accountTriggerAttributes(hasEntries, open, menuId)

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
    if (!hasEntries) return
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

  const button = variant === 'header'
    ? (
      <IconButton
        ref={triggerRef}
        id={triggerId}
        label={label}
        icon={User}
        size='lg'
        onClick={() => hasEntries ? openAndFocus('first') : onProfile()}
        onKeyDown={onTriggerKeyDown}
        {...triggerAttributes}
        className='rp-chrome-header-control shrink-0 rounded-full border'
      />
    )
    : (
      <button
        ref={triggerRef}
        id={triggerId}
        type='button'
        onClick={() => hasEntries ? openAndFocus('first') : onProfile()}
        onKeyDown={onTriggerKeyDown}
        aria-label={label}
        title={label}
        {...triggerAttributes}
        className='rp-navsheet-action rp-focus-inverse w-full'
      >
        <User size='md' className='shrink-0' />
        {label}
      </button>
    )

  if (!hasEntries) return button

  const menuSurface = (
    <div
      ref={panelRef}
      id={menuId}
      role='menu'
      aria-labelledby={triggerId}
      onKeyDown={onMenuKeyDown}
      className={`rp-chrome-menu rp-card rp-shadow-lg rp-anim-fade w-[min(12rem,calc(100vw-1rem))] p-1.5 ${
        variant === 'mobile' ? 'shrink-0' : ''
      }`}
    >
      {(portalRole || platformRole) && (
        <div
          role='group'
          aria-label={ui('Current access')}
          className='border-b border-line px-3 py-2 text-sm text-ink-2 break-words'
        >
          {portalRole && <p>{portalName}: {ui(portalRole)}</p>}
          {platformRole && <p>{ui('Platform')}: {ui(platformRole)}</p>}
        </div>
      )}
      {entries.map((entry) => {
        const EntryIcon = entryIcon(entry)
        return (
          <Link
            key={entry.href}
            to={entry.href}
            role='menuitem'
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className='rp-chrome-menu-item rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-[var(--rp-btn-px)] py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
          >
            <EntryIcon size='sm' className='shrink-0 text-ink-2' />
            <span className='min-w-0 break-words'>{ui(entry.label)}</span>
          </Link>
        )
      })}
      <button
        type='button'
        role='menuitem'
        tabIndex={-1}
        onClick={() => {
          // The selected menu item unmounts before the dialog can remember it.
          // Hand focus to the persistent launcher for the dialog's return path.
          triggerRef.current?.focus()
          setOpen(false)
          onProfile()
        }}
        className='rp-chrome-menu-item rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-[var(--rp-btn-px)] py-2 text-left text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
      >
        <User size='sm' className='shrink-0 text-ink-2' />
        <span className='min-w-0 break-words'>{ui('Profile')}</span>
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
