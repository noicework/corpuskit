import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useId, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { type AccessMode, type Permission } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import {
  AssignmentSection,
  unconfirmedMessage,
  useAccessMutation,
} from '../../components/AssignmentSection.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { AlertCircle } from '../../components/icons.tsx'
import { AssignmentError, changeAccessMode } from '../../api/access.ts'
import type { TenantOutletContext } from '../TenantLayout.tsx'
import { KeysPanel } from './KeysPanel.tsx'

export const ACCESS_SECTION_PERMISSIONS: readonly Permission[] = [
  'members.manage',
  'behaviour.write',
  'keys.manage',
]
const modes: { value: AccessMode; label: string; help: string }[] = [
  { value: 'public', label: 'Public', help: 'Anyone can browse, search and ask questions.' },
  {
    value: 'authenticated',
    label: 'Organisation sign-in',
    help: 'People signed in to this organisation can browse, search and ask questions.',
  },
  {
    value: 'restricted',
    label: 'Restricted',
    help: 'Only people with assigned access can open this portal.',
  },
]
export function AccessPanel({ slug, name }: { slug: string; name: string }) {
  const { ui } = usePortalLocale()

  const access = useAccess()
  const scope = { kind: 'portal' as const, slug }
  if (!ACCESS_SECTION_PERMISSIONS.some((permission) => access.can(permission, scope))) return null
  return (
    <div className='min-w-0 space-y-6 lg:space-y-8' data-access-panel>
      <section className='rp-card min-w-0 p-5 lg:p-6'>
        <SectionHeader
          className='rp-admin-section-head [overflow-wrap:anywhere]'
          title={<>{ui('Access to ')}{name}</>}
          description={<>{ui('Portal: ')}{slug}</>}
        />
      </section>
      <AssignmentSection scope={scope} name={name} family='members' />
      <AssignmentSection scope={scope} name={name} family='groups' />
      {access.can('behaviour.write', scope) && (
        <AccessModeSection key={`${slug}:${access.generation}`} slug={slug} name={name} />
      )}
      <KeysPanel slug={slug} />
    </div>
  )
}
function AccessModeSection({ slug, name }: { slug: string; name: string }) {
  const { ui, error: localError } = usePortalLocale()

  const { config } = useOutletContext<TenantOutletContext>()
  const current = config.slug === slug
    ? modes.find((mode) => mode.value === config.accessMode)
    : undefined
  const [selected, setSelected] = useState<AccessMode | undefined>(current?.value)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const { mutate, notice, options } = useAccessMutation(
    { kind: 'portal', slug },
    'behaviour.write',
    'mode',
  )
  const chosen = modes.find((mode) => mode.value === selected)
  const save = async () => {
    if (busy || !current || !chosen || chosen === current) return
    setBusy(true)
    setError(null)
    try {
      await mutate(() => changeAccessMode(slug, chosen.value, options))
    } catch (failure) {
      if (options.authority.context === options.context) {
        setError(failure instanceof AssignmentError ? failure.message : unconfirmedMessage)
      }
    } finally {
      if (options.authority.context === options.context) setBusy(false)
    }
  }
  return (
    <section
      className='rp-card min-w-0 p-5 lg:p-6'
      data-access-mode
      aria-labelledby={id}
    >
      <SectionHeader
        className='rp-admin-section-head'
        title={<span id={id}>{ui('Access mode')}</span>}
      />
      {notice && (
        <p role='alert' className='mt-4 flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'>
          <AlertCircle size='sm' className='shrink-0' />
          {localError(
            unconfirmedMessage,
            'The result could not be confirmed. Refresh this view before trying again.',
          )}
        </p>
      )}
      {!current
        ? (
          <p className='mt-4 text-base text-ink-2'>
            {ui('The current access mode could not be checked. Refresh this view.')}
          </p>
        )
        : (
          <>
            <p className='mt-4 text-base' data-current-access-mode>
              {ui('Current mode: ')}
              {ui(current.label)}
            </p>
            <fieldset className='mt-4 min-w-0 space-y-4' disabled={busy}>
              <legend className='sr-only'>{ui('Access mode for ')}{name}</legend>
              {modes.map((mode) => (
                <label
                  key={mode.value}
                  className='rp-check w-full min-w-0'
                >
                  <input
                    className='shrink-0'
                    type='radio'
                    name={id}
                    value={mode.value}
                    checked={selected === mode.value}
                    onChange={() => setSelected(mode.value)}
                  />
                  <span className='min-w-0 text-base'>
                    {ui(mode.label)}
                    <span className='mt-1 block text-sm text-ink-2'>{ui(mode.help)}</span>
                  </span>
                </label>
              ))}
              <Button
                disabled={!chosen || chosen === current}
                onClick={() => setConfirm(true)}
              >
                {ui('Save access mode')}
              </Button>
            </fieldset>
          </>
        )}
      {confirm && chosen && (
        <ConfirmActionDialog
          destructive={false}
          title={ui('Change access mode')}
          description={ui('Change {name} to {label}? {value3}', {
            name: name,
            label: ui(chosen.label),
            value3: chosen.value === 'public'
              ? ui('Portal content will be accessible without sign-in.')
              : ui(chosen.help),
          })}
          confirmLabel={ui('Change access mode')}
          cancelLabel={ui('Keep current mode')}
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirm(false)
            setError(null)
          }}
          onConfirm={() => void save()}
        />
      )}
    </section>
  )
}
