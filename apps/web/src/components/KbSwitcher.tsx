import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { KnowledgeBoxStatus, TenantConfig, TenantSummary } from '@research-portal/core'
import { getKnowledgeBoxStatus, getTenants } from '../api/client.ts'
import { portalHref } from '../lib/portal-url.ts'
import { useAccess } from './AccessProvider.tsx'
import { nextAccountMenuIndex } from './account-menu-behaviour.ts'
import { showsPortalSwitcher } from './kb-switcher-behaviour.ts'
import { Check, ChevronDown, Database, Plus, Settings } from './icons.tsx'
import { IconButton } from './ui.tsx'

const MENU_ITEM_SELECTOR = '[role="menuitem"]'
const PAGE_TAB_STOP_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function StatusDot({ status }: { status?: KnowledgeBoxStatus['status'] }) {
  const { ui } = usePortalLocale()
  const colour = status === 'connected'
    ? 'var(--rp-ok-ink)'
    : status === 'demo'
    ? 'var(--rp-warn-ink)'
    : status === 'unavailable'
    ? 'var(--rp-bad-ink)'
    : 'var(--rp-line)'
  const label = status === 'connected'
    ? 'Connected'
    : status === 'demo'
    ? 'Demo content'
    : status === 'unavailable'
    ? 'Unavailable'
    : 'Not connected'
  return (
    <span className='relative flex h-2.5 w-2.5 shrink-0 items-center justify-center'>
      <span
        className='h-2 w-2 rounded-full'
        style={{ backgroundColor: colour }}
        aria-hidden='true'
      />
      <span className='sr-only'>{ui(label)}</span>
    </span>
  )
}

/**
 * The knowledge box switcher: the portal wordmark (with its logo, when the
 * tenant has one) doubles as a dropdown that switches between the portals in the
 * caller's directory - each backed by its own knowledge box - and links to the
 * management screen. With nowhere else to go it renders nothing.
 */
export function KbSwitcher({ config }: { config: TenantConfig }) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const generatedId = useId()
  const triggerId = `kb-trigger-${generatedId}`
  const menuId = `kb-menu-${generatedId}`
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusOnOpen = useRef<'first' | 'last'>('first')
  const navigate = useNavigate()
  const access = useAccess()
  const canCreate = access.can('portal.create', { kind: 'platform' })

  const { data: tenants } = useQuery({
    queryKey: ['tenants', access.identityKey, access.generation],
    queryFn: getTenants,
    enabled: access.state.status === 'ready',
  })
  const { data: statuses } = useQuery({
    queryKey: [
      'kb-statuses',
      access.identityKey,
      access.generation,
      tenants?.map((t) => t.slug).join(','),
    ],
    enabled: access.state.status === 'ready' && open && Boolean(tenants && tenants.length > 0),
    queryFn: async () => {
      const entries = await Promise.all(
        (tenants ?? []).map(async (t) => {
          try {
            const snapshot = await access.controller.readScopeSnapshot(t.slug)
            if (!snapshot.portalAccess?.permissions.includes('portal.read')) {
              return [t.slug, undefined] as const
            }
            return [t.slug, await getKnowledgeBoxStatus(t.slug)] as const
          } catch {
            return [t.slug, undefined] as const
          }
        }),
      )
      return Object.fromEntries(entries) as Record<string, KnowledgeBoxStatus | undefined>
    },
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onEsc = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  // Match the opening arrow key, then let the menu keys walk the list.
  useEffect(() => {
    if (!open) return
    const items = panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)
    const target = focusOnOpen.current === 'last' ? items?.[items.length - 1] : items?.[0]
    target?.focus()
  }, [open])

  function openAndFocus(position: 'first' | 'last') {
    focusOnOpen.current = position
    const items = panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)
    const target = position === 'last' ? items?.[items.length - 1] : items?.[0]
    if (target) {
      target.focus()
      return
    }
    setOpen(true)
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openAndFocus(event.key === 'ArrowUp' ? 'last' : 'first')
    }
    if (event.key === 'Tab' && open) setOpen(false)
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      event.preventDefault()
      setOpen(false)
      const trigger = triggerRef.current
      if (!trigger) return
      const stops = Array.from(document.querySelectorAll<HTMLElement>(PAGE_TAB_STOP_SELECTOR))
        .filter(
          (element) =>
            !panelRef.current?.contains(element) && element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden',
        )
      const current = stops.indexOf(trigger)
      const target = event.shiftKey ? stops[current - 1] : stops[current + 1]
      ;(target ?? trigger).focus()
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

  const switchTo = (target: TenantSummary) => {
    setOpen(false)
    const slug = target.slug
    if (slug === config.slug) return
    // Each destination resolves its own permissions before mounting content.
    const destination = portalHref(slug, {
      hostname: target.hostname,
      suffix: '/library',
    })
    if (/^https:\/\//.test(destination)) {
      globalThis.location.assign(destination)
      return
    }
    navigate(destination)
  }

  if (!showsPortalSwitcher(tenants, config.slug, canCreate)) return null

  return (
    <div ref={wrapRef} className='relative shrink-0'>
      <IconButton
        ref={triggerRef}
        id={triggerId}
        label={ui('Switch portal - currently {name}', { name: config.branding.productName })}
        icon={ChevronDown}
        size='lg'
        onClick={() => open ? setOpen(false) : openAndFocus('first')}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup='menu'
        aria-expanded={open}
        // The menu mounts only while open; a reference to an absent id is broken (WCAG 4.1.2).
        aria-controls={open ? menuId : undefined}
        className='rp-chrome-switcher ml-1 shrink-0'
      />

      {open && (
        <div
          ref={panelRef}
          id={menuId}
          role='menu'
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
          className='rp-chrome-menu rp-card rp-shadow-lg rp-anim-fade fixed left-4 right-4 top-[var(--rp-header-h)] z-50 mt-2 p-1.5 sm:absolute sm:left-0 sm:right-auto sm:top-full sm:w-[18.5rem]'
        >
          <p className='rp-eyebrow px-2.5 pb-1.5 pt-2 text-ink-3'>
            {ui('Knowledge boxes')}
          </p>
          <div className='rp-no-scrollbar max-h-[60vh] overflow-y-auto'>
            {(tenants ?? []).map((t) => {
              const current = t.slug === config.slug
              return (
                <button
                  key={t.slug}
                  type='button'
                  role='menuitem'
                  tabIndex={-1}
                  onClick={() => switchTo(t)}
                  className={`rp-chrome-menu-item rp-focus flex w-full items-center gap-3 rounded-[var(--rp-radius-btn)] px-2.5 py-2 text-left transition-colors duration-150 hover:bg-[var(--rp-surface-2)] ${
                    current ? 'bg-surface-2' : ''
                  }`}
                >
                  <Database size='sm' className='shrink-0 text-ink-2' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-sm font-medium text-ink'>
                      {t.productName}
                    </span>
                    <span className='block truncate text-xs text-ink-3'>
                      {t.organisation}
                    </span>
                  </span>
                  <StatusDot status={statuses?.[t.slug]?.status} />
                  {current && <Check size='sm' className='shrink-0 text-[var(--rp-accent-fg)]' />}
                </button>
              )
            })}
          </div>
          {canCreate && (
            <>
              <div className='my-1.5 border-t border-line' />
              <Link
                to='/admin'
                role='menuitem'
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className='rp-chrome-menu-item rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-2.5 py-2 text-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
              >
                <Plus size='sm' className='shrink-0 text-ink-3' />
                {ui('Add a portal')}
              </Link>
              <Link
                to='/admin'
                role='menuitem'
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className='rp-chrome-menu-item rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-2.5 py-2 text-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
              >
                <Settings size='sm' className='shrink-0 text-ink-3' />
                {ui('Manage portals')}
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  )
}
