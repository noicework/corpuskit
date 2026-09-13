import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { type PortalRole } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
import {
  createKey,
  KeyError,
  keyRoles,
  type KeySummary,
  keyUnconfirmed,
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
const date = (value: string) =>
  new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
export function KeysPanel({ slug }: { slug: string }) {
  const access = useAccess()
  const location = useLocation()
  if (!access.can('keys.manage', { kind: 'portal', slug }) || !access.state.session?.user) {
    return null
  }
  return <KeyManager key={`${slug}:${access.generation}:${location.key}`} slug={slug} />
}
function KeyManager({ slug }: { slug: string }) {
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
      const result = await createKey(slug, { label, role, ...(expiresAt ? { expiresAt } : {}) }, {
        ...options,
        signal,
      })
      if (!current(signal)) return
      setIssued(result.key)
      setLabel('')
      setRole('viewer')
      setExpiry('')
      void rows.refetch()
    } catch (failure) {
      if (current(signal)) {
        setError(failure instanceof KeyError ? failure.message : keyUnconfirmed)
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
        setError(failure instanceof KeyError ? failure.message : keyUnconfirmed)
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
      className='mt-8 min-w-0 border-t border-line pt-6'
    >
      <h3 id='access-keys' tabIndex={-1} className='rp-display scroll-mt-24 text-xl'>Keys</h3>
      <p className='mt-2 text-base text-ink-2'>
        Connect a tool to this portal. Keys cannot manage portal access or settings.
      </p>
      <form onSubmit={(event) => void create(event)} data-key-form className='mt-4 min-w-0'>
        <fieldset
          disabled={busy || uncertain || !!issued}
          className='grid min-w-0 gap-4 lg:grid-cols-3'
        >
          <label className='block min-w-0 text-sm' htmlFor={`${id}-label`}>
            Key label<input
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
            Role<select
              id={`${id}-role`}
              data-key-role
              aria-describedby={error ? `${id}-error` : undefined}
              aria-invalid={!!error && !uncertain}
              className='rp-input mt-2 w-full'
              value={role}
              onChange={(e) => setRole(e.target.value as PortalRole)}
            >
              {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </label>
          <label className='block min-w-0 text-sm' htmlFor={`${id}-expiry`}>
            Expiry (optional, local time)<input
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
          <button
            type='submit'
            className='rp-btn rp-btn-primary min-h-[44px] justify-self-start'
            disabled={!roles.includes(role)}
          >
            {busy ? 'Creating key...' : 'Create key'}
          </button>
        </fieldset>
      </form>
      <p className='mt-3 text-sm text-ink-2'>
        A key is shown once. Its effective role cannot exceed the creator's current access.
      </p>
      {error && (
        <p
          ref={errorRef}
          id={`${id}-error`}
          tabIndex={-1}
          role='alert'
          className='mt-4 text-sm text-[var(--rp-bad-ink)]'
        >
          {error}
        </p>
      )}
      {notice && <p role='status' className='mt-4 text-sm'>{notice}</p>}
      {rows.isPending
        ? <p role='status' className='mt-4'>Loading keys...</p>
        : rows.isError
        ? <p role='alert' className='mt-4'>Could not load keys. Try again.</p>
        : rows.data?.length === 0
        ? (
          <div className='mt-6'>
            <h4 className='font-semibold'>No keys</h4>
            <p className='mt-2 text-ink-2'>
              Create a key to connect an authorised tool to this portal.
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
                    Role: {roleLabel(row.role)}. Effective role:{' '}
                    {row.effectiveRole ? roleLabel(row.effectiveRole) : 'None'}.
                  </p>
                  {row.effectiveRole && row.effectiveRole !== row.role && (
                    <p className='mt-2'>The creator's current access limits this key.</p>
                  )}
                  <p className='mt-2'>{keyExplanation(row)}</p>
                  {row.legacy && <p className='mt-2'>legacy, viewer, cannot be upgraded</p>}
                  <p className='mt-2 text-ink-2'>
                    Created {date(row.createdAt)}.{' '}
                    {row.expiresAt ? `Expires ${date(row.expiresAt)}.` : 'No expiry.'}
                    {row.revokedAt && ` Revoked ${date(row.revokedAt)}.`}
                  </p>
                </div>
                {!row.revokedAt && (
                  <button
                    type='button'
                    className='rp-btn rp-btn-outline min-h-[44px] self-start'
                    disabled={busy || uncertain}
                    onClick={() => {
                      setRevoke(row)
                      setError(null)
                    }}
                  >
                    Revoke key
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      <button
        type='button'
        className='rp-btn rp-btn-outline mt-4 min-h-[44px]'
        disabled={busy || rows.isFetching}
        onClick={() => void refreshList()}
      >
        Refresh key list
      </button>
      {revoke && (
        <ConfirmActionDialog
          title='Revoke key'
          description={`Revoke ${revoke.label}? Tools using this key will lose access. This cannot be undone.`}
          cancelLabel='Keep key'
          confirmLabel='Revoke key'
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
function keyExplanation(row: KeySummary) {
  return {
    active: 'Active',
    expired: 'Expired: create a replacement key if access is still needed.',
    revoked: 'Revoked',
    unproven_creator: 'Inert: the creator could not be verified.',
    creator_no_access: 'Inert: the creator no longer has access to this portal.',
    creator_claims_expired:
      "Inert: the creator's Entra sign-in has expired. The creator must sign in again to restore it.",
  }[row.inactiveReason]
}
function OneTimeKey({ value, onClose }: { value: string; onClose(): void }) {
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
      className='rp-card fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto bg-surface p-6 text-ink shadow-xl backdrop:bg-[color-mix(in_srgb,var(--rp-ink)_45%,transparent)]'
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
      <h2 id={`${id}-title`} className='rp-display text-xl'>Copy your key</h2>
      <p className='mt-4 text-base'>
        This key is shown once. Copy it to your secure credential store before closing.
      </p>
      <label htmlFor={`${id}-value`} className='sr-only'>One-time key</label>
      <textarea
        id={`${id}-value`}
        data-key-secret
        readOnly
        spellCheck={false}
        autoComplete='off'
        className='rp-input mt-4 min-h-24 w-full break-all text-sm'
        value={value}
      />
      <p role='status' className='mt-3 text-sm'>{status}</p>
      <div className='mt-6 flex flex-wrap gap-3'>
        <button
          type='button'
          ref={close}
          className='rp-btn rp-btn-outline min-h-[44px]'
          onClick={onClose}
        >
          Close key
        </button>
        <button
          type='button'
          className='rp-btn rp-btn-primary min-h-[44px]'
          onClick={() => void copy()}
        >
          Copy key
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
