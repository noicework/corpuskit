import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { KnowledgeBoxStatus, TenantConfig, TenantSummary } from '@research-portal/core'
import { getKnowledgeBoxStatus, getTenants } from '../api/client.ts'
import { portalHref } from '../lib/portal-url.ts'

function StatusDot({ status }: { status?: KnowledgeBoxStatus['status'] }) {
  const colour = status === 'connected'
    ? 'var(--rp-ok-ink)'
    : status === 'demo'
    ? 'var(--rp-warn-ink)'
    : 'var(--rp-line)'
  const label = status === 'connected'
    ? 'Connected'
    : status === 'demo'
    ? 'Demo content'
    : 'Not connected'
  return (
    <span className='relative flex h-2.5 w-2.5 shrink-0 items-center justify-center'>
      <span
        className='h-2 w-2 rounded-full'
        style={{ backgroundColor: colour }}
        aria-hidden='true'
      />
      <span className='sr-only'>{label}</span>
    </span>
  )
}

/**
 * The knowledge box switcher: the portal wordmark (with its logo, when the
 * tenant has one) doubles as a dropdown that switches between every portal -
 * each backed by its own knowledge box - and links to the management screen.
 */
export function KbSwitcher({ config }: { config: TenantConfig }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const location = useLocation()

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: getTenants })
  const { data: statuses } = useQuery({
    queryKey: ['kb-statuses', tenants?.map((t) => t.slug).join(',')],
    enabled: open && Boolean(tenants && tenants.length > 0),
    queryFn: async () => {
      const entries = await Promise.all(
        (tenants ?? []).map(async (t) => {
          try {
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
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onEsc = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  // Focus the first menu item on open, then let arrow keys walk the list.
  useEffect(() => {
    if (!open) return
    const items = panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    items?.[0]?.focus()
  }, [open])

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown'
      ? (current + 1) % items.length
      : (current <= 0 ? items.length - 1 : current - 1)
    items[next]?.focus()
  }

  const switchTo = (target: TenantSummary) => {
    setOpen(false)
    const slug = target.slug
    if (slug === config.slug) return
    // Keep the current section when switching boxes, e.g. /search stays /search.
    const section = location.pathname.replace(new RegExp(`^/t/${config.slug}`), '')
    const destination = portalHref(slug, {
      hostname: target.hostname,
      suffix: `${section}${location.search}`,
    })
    if (/^https:\/\//.test(destination)) {
      globalThis.location.assign(destination)
      return
    }
    navigate(destination)
  }

  return (
    <div ref={wrapRef} className='relative'>
      <button
        ref={triggerRef}
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-label={`Switch portal - currently ${config.branding.productName}`}
        title='Switch portal'
        className='rp-focus ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--rp-radius-btn)] text-ink-3 transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-ink'
      >
        {
          /* The header already shows this portal's logo, so the trigger is just
          * the disclosure - a second mark here would double up. */
        }
        <span className='sr-only'>{config.branding.productName}</span>
        <svg
          className={`h-4 w-4 shrink-0 text-ink-3 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
          viewBox='0 0 20 20'
          fill='currentColor'
          aria-hidden='true'
        >
          <path
            fillRule='evenodd'
            d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.23 8.29a.75.75 0 010-1.08z'
            clipRule='evenodd'
          />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          role='menu'
          onKeyDown={onMenuKeyDown}
          className='rp-glass rp-shadow-lg rp-anim-fade absolute left-0 top-full z-50 mt-2 w-[calc(100vw-2rem)] max-w-72 rounded-[var(--rp-radius)] border border-line p-1.5 sm:w-[18.5rem] sm:max-w-none'
        >
          <p className='rp-eyebrow px-2.5 pb-1.5 pt-2 text-ink-3'>
            Knowledge boxes
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
                  className={`rp-focus flex w-full items-center gap-3 rounded-[var(--rp-radius-btn)] px-2.5 py-2 text-left transition-colors duration-150 hover:bg-[var(--rp-surface-2)] ${
                    current ? 'bg-surface-2' : ''
                  }`}
                >
                  <StatusDot status={statuses?.[t.slug]?.status} />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-sm font-medium text-ink'>
                      {t.productName}
                    </span>
                    <span className='block truncate text-xs text-ink-3'>
                      {t.organisation}
                    </span>
                  </span>
                  {current && (
                    <svg
                      viewBox='0 0 20 20'
                      fill='currentColor'
                      aria-hidden='true'
                      className='h-4 w-4 shrink-0'
                      style={{ color: 'var(--rp-accent-fg)' }}
                    >
                      <path
                        fillRule='evenodd'
                        d='M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z'
                        clipRule='evenodd'
                      />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
          <div className='my-1.5 border-t border-line' />
          <Link
            to='/admin'
            role='menuitem'
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className='rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-2.5 py-2 text-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
          >
            <svg
              viewBox='0 0 20 20'
              fill='currentColor'
              aria-hidden='true'
              className='h-4 w-4 shrink-0 text-ink-3'
            >
              <path d='M10 4a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 0110 4z' />
            </svg>
            Add a portal
          </Link>
          <Link
            to='/admin'
            role='menuitem'
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className='rp-focus flex w-full items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-2.5 py-2 text-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
          >
            <svg
              viewBox='0 0 20 20'
              fill='currentColor'
              aria-hidden='true'
              className='h-4 w-4 shrink-0 text-ink-3'
            >
              <path
                fillRule='evenodd'
                d='M8.34 2.6a1 1 0 01.99-.85h1.34a1 1 0 01.99.85l.16 1.06c.36.14.7.34 1 .58l1-.4a1 1 0 011.22.44l.67 1.16a1 1 0 01-.23 1.28l-.84.66c.04.19.06.39.06.62s-.02.43-.06.62l.84.66a1 1 0 01.23 1.28l-.67 1.16a1 1 0 01-1.22.44l-1-.4c-.3.24-.64.44-1 .58l-.16 1.06a1 1 0 01-.99.85H9.33a1 1 0 01-.99-.85l-.16-1.06c-.36-.14-.7-.34-1-.58l-1 .4a1 1 0 01-1.22-.44l-.67-1.16a1 1 0 01.23-1.28l.84-.66A3.6 3.6 0 013.3 10c0-.23.02-.43.06-.62l-.84-.66a1 1 0 01-.23-1.28l.67-1.16a1 1 0 011.22-.44l1 .4c.3-.24.64-.44 1-.58zM10 12a2 2 0 100-4 2 2 0 000 4z'
                clipRule='evenodd'
              />
            </svg>
            Manage portals
          </Link>
        </div>
      )}
    </div>
  )
}
