import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { type PortalRole } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { AlertCircle, Copy, Plus, RotateCw, Trash, X } from '../../components/icons.tsx'
import {
  createKey,
  KeyError,
  keyRoles,
  type KeySummary,
  keyUnconfirmed,
  listKeyPortals,
  listKeys,
  revokeKey,
} from '../../api/keys.ts'

const roleLabel = (role: PortalRole) =>
  ({
    viewer: 'Viewer',
    analyst: 'Analyst',
    curator: 'Curator',
    'portal-admin': 'Portal administrator',
  })[role]
export function KeysPanel({ slug }: { slug: string }) {
  const access = useAccess()
  const location = useLocation()
  if (!access.can('keys.manage', { kind: 'portal', slug }) || !access.state.session?.user) {
    return null
  }
  return <KeyManager key={`${slug}:${access.generation}:${location.key}`} slug={slug} />
}
function KeyManager({ slug }: { slug: string }) {
  const { ui, date, error: localError } = usePortalLocale()

  const access = useAccess()
  const controller = access.controller
  const context = controller.context
  const options = { authority: controller, context }
  const roles = keyRoles(slug, options)
  const id = useId()
  const lifetime = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<PortalRole>('viewer')
  const [expiry, setExpiry] = useState('')
  const [estate, setEstate] = useState<string[]>([])
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revoke, setRevoke] = useState<KeySummary | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const anchored = useRef(false)
  const assignmentsLoading = useIsFetching({ queryKey: ['access-assignments'] })
  useLayoutEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    const purge = () => {
      abort.abort()
      setIssued(null)
      setRevoke(null)
    }
    const unregister = controller.registerCleanup(purge)
    return () => {
      unregister()
      purge()
      if (lifetime.current === abort) lifetime.current = null
    }
  }, [controller])
  useLayoutEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])
  const portals = useQuery({
    queryKey: ['key-portals', slug, access.identityKey, access.generation],
    queryFn: ({ signal }) => listKeyPortals(slug, { ...options, signal }),
    retry: false,
  })
  const rows = useQuery({
    queryKey: ['scoped-keys', slug, access.identityKey, access.generation],
    queryFn: ({ signal }) => listKeys(slug, { ...options, signal }),
    retry: false,
  })
  useLayoutEffect(() => {
    if (
      anchored.current || assignmentsLoading || rows.isPending ||
      globalThis.location.hash !== '#access-keys'
    ) return
    let cancelled = false, frame = 0
    void document.fonts.ready.then(() => {
      if (cancelled) return
      frame = requestAnimationFrame(() => {
        if (
          cancelled || controller.context !== context || !lifetime.current ||
          lifetime.current.signal.aborted ||
          (document.activeElement !== document.body && document.activeElement?.id !== 'access-keys')
        ) return
        const heading = document.getElementById('access-keys')
        heading?.scrollIntoView({ block: 'start' })
        heading?.focus({ preventScroll: true })
        anchored.current = true
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [controller, context, assignmentsLoading, rows.isPending])
  const current = (signal: AbortSignal) =>
    !signal.aborted && controller.context === context &&
    controller.can('keys.manage', { kind: 'portal', slug })
  function restoreSafeFocus() {
    requestAnimationFrame(() => {
      const signal = lifetime.current?.signal
      if (signal && current(signal) && document.activeElement === document.body) {
        document.getElementById('access-keys')?.focus({ preventScroll: true })
      }
    })
  }
  async function refreshList() {
    const signal = lifetime.current?.signal
    if (!signal || !current(signal)) return
    void portals.refetch()
    const result = await rows.refetch()
    if (current(signal) && result.isSuccess) {
      setUncertain(false)
      setError(null)
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    const signal = lifetime.current?.signal
    if (!signal || !current(signal) || busyRef.current || uncertain || issued) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const expiresAt = expiry ? new Date(expiry).toISOString() : undefined
      const result = await createKey(slug, {
        label,
        role,
        ...(expiresAt ? { expiresAt } : {}),
        ...(estate.length ? { estate } : {}),
      }, {
        ...options,
        signal,
      })
      if (!current(signal)) return
      setIssued(result.key)
      setLabel('')
      setRole('viewer')
      setExpiry('')
      setEstate([])
      void rows.refetch()
    } catch (failure) {
      if (current(signal)) {
        setError(failure instanceof Error ? failure.message : keyUnconfirmed)
        setUncertain(!(failure instanceof KeyError && failure.correctable))
      }
    } finally {
      if (current(signal)) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }
  async function remove() {
    const signal = lifetime.current?.signal
    if (!revoke || !signal || !current(signal) || busyRef.current || uncertain) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await revokeKey(slug, revoke.id, { ...options, signal })
      if (current(signal)) {
        setRevoke(null)
        setNotice('Key revoked.')
        void rows.refetch().then(restoreSafeFocus)
      }
    } catch (failure) {
      if (current(signal)) {
        setRevoke(null)
        setError(failure instanceof Error ? failure.message : keyUnconfirmed)
        setUncertain(true)
      }
    } finally {
      if (current(signal)) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section
      aria-labelledby='access-keys'
      data-keys-panel
      className='rp-card min-w-0 p-5 lg:p-6'
    >
      <SectionHeader
        className='rp-admin-section-head'
        title={<span id='access-keys' tabIndex={-1} className='scroll-mt-24'>{ui('Keys')}</span>}
        description={ui(
          'Connect a tool to this portal. Keys cannot manage portal access or settings.',
        )}
        headingLevel={3}
        actions={
          <Button
            variant='ghost'
            size='sm'
            leadingIcon={RotateCw}
            disabled={busy || rows.isFetching}
            onClick={() => void refreshList()}
          >
            {ui('Refresh key list')}
          </Button>
        }
      />
      <form onSubmit={(event) => void create(event)} data-key-form className='mt-4 min-w-0'>
        <fieldset
          disabled={busy || uncertain || !!issued}
          className='grid min-w-0 gap-4 lg:grid-cols-3'
        >
          <label className='block min-w-0 text-sm' htmlFor={`${id}-label`}>
            {ui('Key label')}
            <input
              id={`${id}-label`}
              data-key-label
              aria-describedby={error ? `${id}-error` : undefined}
              aria-invalid={!!error && !uncertain}
              className='rp-input mt-2 w-full'
              required
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className='block min-w-0 text-sm' htmlFor={`${id}-role`}>
            {ui('Role')}
            <select
              id={`${id}-role`}
              data-key-role
              aria-describedby={error ? `${id}-error` : undefined}
              aria-invalid={!!error && !uncertain}
              className='rp-input rp-select mt-2 w-full'
              value={role}
              onChange={(e) => setRole(e.target.value as PortalRole)}
            >
              {roles.map((r) => <option key={r} value={r}>{ui(roleLabel(r))}</option>)}
            </select>
          </label>
          <label className='block min-w-0 text-sm' htmlFor={`${id}-expiry`}>
            {ui('Expiry (optional, local time)')}
            <input
              id={`${id}-expiry`}
              data-key-expiry
              aria-describedby={error ? `${id}-error` : undefined}
              aria-invalid={!!error && !uncertain}
              className='rp-input mt-2 w-full min-w-0'
              type='datetime-local'
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <fieldset className='min-w-0 lg:col-span-3' aria-describedby={`${id}-coverage-help`}>
            <legend className='text-sm font-semibold'>{ui('Portals covered')}</legend>
            <p id={`${id}-coverage-help`} className='mt-2 text-sm text-ink-2'>
              {ui('This portal is always included. Add portals you administer for an estate key.')}
            </p>
            {portals.isPending
              ? <p role='status' className='mt-2 text-sm'>{ui('Loading available portals...')}</p>
              : portals.isError
              ? (
                <p role='alert' className='mt-2 text-sm'>
                  {ui('Could not load available portals. Refresh the key list to try again.')}
                </p>
              )
              : portals.data?.some((portal) => portal.slug !== slug)
              ? (
                <div className='mt-2 grid min-w-0 gap-2 sm:grid-cols-2'>
                  {portals.data.filter((portal) => portal.slug !== slug).map((portal) => (
                    <label
                      key={portal.slug}
                      className='rp-focus flex min-h-11 min-w-0 flex-wrap cursor-pointer items-center gap-3 rounded-[var(--rp-radius-input)] border border-[var(--rp-field)] p-3 text-sm [overflow-wrap:anywhere] focus-within:ring-2 focus-within:ring-[var(--rp-focus)]'
                    >
                      <input
                        type='checkbox'
                        data-key-portal={portal.slug}
                        className='h-6 w-6 shrink-0 accent-[var(--rp-primary)]'
                        checked={estate.includes(portal.slug)}
                        disabled={!estate.includes(portal.slug) && estate.length >= 19}
                        onChange={(event) =>
                          setEstate((current) =>
                            event.target.checked
                              ? [...current, portal.slug]
                              : current.filter((value) => value !== portal.slug)
                          )}
                      />
                      <span className='min-w-0 flex-1 basis-48'>
                        {portal.title} <span className='text-ink-2'>({portal.slug})</span>
                      </span>
                    </label>
                  ))}
                </div>
              )
              : null}
            <KeyEndpoint
              key={estate.length > 0 ? 'estate' : slug}
              slug={slug}
              estate={estate.length > 0}
            />
          </fieldset>
          <Button
            type='submit'
            className='justify-self-start'
            leadingIcon={Plus}
            disabled={!roles.includes(role)}
          >
            {busy ? ui('Creating key...') : ui('Create key')}
          </Button>
        </fieldset>
      </form>
      <p className='mt-3 text-sm text-ink-2'>
        {ui("A key is shown once. Its effective role cannot exceed the creator's current access.")}
      </p>
      {error && (
        <p
          ref={errorRef}
          id={`${id}-error`}
          tabIndex={-1}
          role='alert'
          className='mt-4 flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'
        >
          <AlertCircle size='sm' className='shrink-0' />
          <span>{localError(error, keyUnconfirmed)}</span>
        </p>
      )}
      {notice && <p role='status' className='mt-4 text-sm'>{ui(notice)}</p>}
      {rows.isPending
        ? <p role='status' className='mt-4'>{ui('Loading keys...')}</p>
        : rows.isError
        ? (
          <p role='alert' className='mt-4 flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'>
            <AlertCircle size='sm' className='shrink-0' />
            <span>{ui('Could not load keys. Try again.')}</span>
          </p>
        )
        : rows.data?.length === 0
        ? (
          <div className='mt-6'>
            <h4 className='font-semibold'>{ui('No keys')}</h4>
            <p className='mt-2 text-ink-2'>
              {ui('Create a key to connect an authorised tool to this portal.')}
            </p>
          </div>
        )
        : (
          <ul className='mt-6 divide-y divide-[var(--rp-line)]'>
            {rows.data?.map((row) => (
              <li
                key={row.id}
                data-key-id={row.id}
                className='flex min-w-0 flex-col gap-4 py-5 sm:flex-row sm:justify-between'
              >
                <div className='min-w-0 text-sm [overflow-wrap:anywhere]'>
                  <h4 className='font-semibold'>{row.label}</h4>
                  <p className='mt-2 text-ink-2'>{row.prefix}... · {row.id}</p>
                  <p className='mt-2'>
                    {ui('Role: ')}
                    {ui(roleLabel(row.role))}
                    {ui('. Effective role:')}{' '}
                    {row.effectiveRole ? ui(roleLabel(row.effectiveRole)) : ui('None')}.
                  </p>
                  <p data-key-coverage className='mt-2'>
                    {row.revokedAt
                      ? ui('Portal access revoked')
                      : ui('Portals covered: {portals}', {
                        portals: [slug, ...(row.estate ?? [])].map((covered) =>
                          portals.data?.find((portal) => portal.slug === covered)?.title ??
                            ui('Portal name unavailable')
                        ).join(', '),
                      })}
                  </p>
                  {!row.revokedAt && <KeyEndpoint slug={slug} estate={!!row.estate?.length} />}
                  {row.effectiveRole && row.effectiveRole !== row.role && (
                    <p className='mt-2'>{ui("The creator's current access limits this key.")}</p>
                  )}
                  <p className='mt-2'>
                    <span
                      className={row.inactiveReason === 'active'
                        ? 'rp-badge rp-badge-ok'
                        : row.inactiveReason === 'revoked'
                        ? 'rp-badge rp-badge-quiet'
                        : undefined}
                    >
                      {ui(keyExplanation(row))}
                    </span>
                  </p>
                  {row.legacy && <p className='mt-2'>{ui('legacy, viewer, cannot be upgraded')}</p>}
                  <p className='mt-2 text-ink-2'>
                    {ui('Created ')}
                    {date(row.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}.{' '}
                    {row.expiresAt
                      ? ui('Expires {value1}.', {
                        value1: date(row.expiresAt, { dateStyle: 'medium', timeStyle: 'short' }),
                      })
                      : ui('No expiry.')}
                    {row.revokedAt &&
                      ui(' Revoked {date}.', {
                        date: date(row.revokedAt, { dateStyle: 'medium', timeStyle: 'short' }),
                      })}
                  </p>
                </div>
                {!row.revokedAt && (
                  <Button
                    data-key-revoke
                    variant='danger'
                    size='sm'
                    leadingIcon={Trash}
                    className='self-start'
                    disabled={busy || uncertain}
                    onClick={() => {
                      setRevoke(row)
                      setError(null)
                    }}
                  >
                    {ui('Revoke key')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      {revoke && (
        <ConfirmActionDialog
          title={ui('Revoke key')}
          description={ui(
            'Revoke {label}? Tools using this key will lose access. This cannot be undone.',
            { label: revoke.label },
          )}
          cancelLabel={ui('Keep key')}
          confirmLabel={ui('Revoke key')}
          busy={busy}
          onCancel={() => setRevoke(null)}
          onConfirm={() => void remove()}
        />
      )}
      {issued && (
        <OneTimeKey
          value={issued}
          onClose={() => {
            setIssued(null)
            restoreSafeFocus()
          }}
        />
      )}
    </section>
  )
}
function KeyEndpoint({ slug, estate }: { slug: string; estate: boolean }) {
  const { ui } = usePortalLocale()
  const url = `${globalThis.location?.origin ?? ''}${
    estate ? '/api/estate/mcp' : `/api/t/${encodeURIComponent(slug)}/mcp`
  }`
  const [status, setStatus] = useState('')
  const alive = useRef(false)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function copy() {
    setStatus('')
    try {
      await navigator.clipboard.writeText(url)
      if (alive.current) setStatus('Copied')
    } catch {
      if (alive.current) setStatus('Could not copy the URL. Select it and copy it manually.')
    }
  }
  return (
    <div data-key-endpoint className='mt-2 min-w-0 text-sm text-ink-2'>
      <p>
        {ui(estate ? 'Use the estate MCP endpoint:' : 'Use the portal MCP endpoint:')}{' '}
        <code className='[overflow-wrap:anywhere]'>{url}</code>
      </p>
      <div className='mt-2 flex flex-wrap items-center gap-2'>
        <Button variant='outline' size='sm' leadingIcon={Copy} onClick={() => void copy()}>
          {ui('Copy')}
        </Button>
        <span role='status'>{ui(status)}</span>
      </div>
    </div>
  )
}
function keyExplanation(row: KeySummary) {
  return {
    active: 'Active key',
    expired: 'Expired: create a replacement key if access is still needed.',
    revoked: 'Revoked',
    unproven_creator: 'Inert: the creator could not be verified.',
    creator_no_access: 'Inert: the creator no longer has access to this portal.',
    creator_claims_expired:
      "Inert: the creator's Entra sign-in has expired. The creator must sign in again to restore it.",
  }[row.inactiveReason]
}
function OneTimeKey({ value, onClose }: { value: string; onClose(): void }) {
  const { ui } = usePortalLocale()

  const id = useId(),
    dialog = useRef<HTMLDialogElement>(null),
    close = useRef<HTMLButtonElement>(null)
  const [status, setStatus] = useState('')
  const alive = useRef(false)
  useLayoutEffect(() => {
    alive.current = true
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    close.current?.focus()
    return () => {
      alive.current = false
      element.close()
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      if (alive.current) setStatus('Key copied')
    } catch {
      if (alive.current) {
        setStatus('Could not copy the key. Select the key and copy it manually before closing.')
      }
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      data-one-time-key
      className='rp-dialog'
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const nodes = [...dialog.current!.querySelectorAll<HTMLElement>('textarea,button')]
        if (event.shiftKey && document.activeElement === nodes[0]) {
          event.preventDefault()
          nodes.at(-1)?.focus()
        } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
          event.preventDefault()
          nodes[0]?.focus()
        }
      }}
    >
      <h2 id={`${id}-title`} className='text-lg font-semibold'>{ui('Copy your key')}</h2>
      <p className='mt-4 text-base'>
        {ui('This key is shown once. Copy it to your secure credential store before closing.')}
      </p>
      <label htmlFor={`${id}-value`} className='sr-only'>{ui('One-time key')}</label>
      <textarea
        id={`${id}-value`}
        data-key-secret
        readOnly
        spellCheck={false}
        autoComplete='off'
        className='rp-input mt-4 min-h-24 w-full break-all text-sm'
        value={value}
      />
      <p role='status' className='mt-3 text-sm'>{ui(status)}</p>
      <div className='mt-6 flex flex-wrap justify-end gap-2'>
        <button
          type='button'
          ref={close}
          className='rp-btn rp-btn-outline'
          onClick={onClose}
        >
          <X size='sm' />
          {ui('Close key')}
        </button>
        <Button
          leadingIcon={Copy}
          onClick={() => void copy()}
        >
          {ui('Copy key')}
        </Button>
      </div>
    </dialog>,
    document.body,
  )
}
