import { messageFor } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { type ComponentProps, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AdminTenantOverview } from '@research-portal/core'
import { removePortal, setPortalDisabled } from '../../api/client.ts'
import { useAdminAccess } from '../../components/EmergencyAccess.tsx'
import { useAccess, useScopeAccess } from '../../components/AccessProvider.tsx'
import { AdminAccessError, sessionAccess } from '../../api/break-glass.ts'
import { PortalConnections } from './PortalConnections.tsx'
import { CreateKbBox } from './CreateKbBox.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { RenamePortal } from './RenamePortal.tsx'
import { type Message } from './shared.ts'
import { ArrowRight, ChevronDown, Eye, EyeOff, Pencil, Trash } from '../../components/icons.tsx'
import { Button, IconButton, SectionHeader } from '../../components/ui.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'

type Status = AdminTenantOverview['knowledgeBox']['status']

const STATUS_DOT: Record<Status, string> = {
  connected: 'bg-[var(--rp-ok-ink)]',
  demo: 'bg-[var(--rp-warn-ink)]',
  none: 'bg-surface-3',
  unavailable: 'bg-[var(--rp-bad-ink)]',
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden='true'
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
    />
  )
}

function StatusBadge({ status }: { status: Status }) {
  const { ui } = usePortalLocale()

  if (status === 'connected') return <span className='rp-badge rp-badge-ok'>{ui('Connected')}</span>
  if (status === 'demo') return <span className='rp-badge rp-badge-warn'>{ui('Demo only')}</span>
  if (status === 'unavailable') {
    return <span className='rp-badge rp-badge-bad'>{ui('Unavailable')}</span>
  }
  return <span className='rp-badge rp-badge-quiet'>{ui('Not connected')}</span>
}

/**
 * One portal in the connections accordion. Collapsed by default to a single
 * summary row; the caller controls expansion so only one portal is open at
 * a time. Expanded content is the connection form plus lifecycle controls -
 * everything else (content, appearance, analysis) lives in that portal's own
 * Manage workspace at /t/:slug/manage.
 */
function PortalRowContent({
  row,
  expanded,
  onToggleExpanded,
}: {
  row: AdminTenantOverview
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const { ui } = usePortalLocale()

  const emergency = useAdminAccess()
  const authority = useAccess()
  const context = authority.controller.context
  const leaf = useScopeAccess(expanded ? row.tenant.slug : null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const current = () => active.current && context === authority.controller.context
  const assertCurrent = () => {
    authority.controller.assertCurrent(context)
    if (!active.current) throw new AdminAccessError()
  }
  const canBind = !row.disabled && leaf.can('bindings.write')
  const canRename = !row.disabled && leaf.can('appearance.write')
  const canRead = !row.disabled && leaf.can('portal.read')
  const canEnable = row.disabled === true && leaf.session?.portalAccess?.slug === row.tenant.slug &&
    leaf.session.portalAccess.canEnable === true
  const canDisable = !row.disabled && leaf.can('behaviour.write')
  const canRemove = !row.disabled && authority.can('portal.delete', { kind: 'platform' }) &&
    (!row.tenant.hostname || leaf.can('domains.write'))
  const emergencyOnly = emergency.breakGlassEnabled &&
    !authority.can('portal.create', { kind: 'platform' })
  const run = async <T,>(
    allowed: () => boolean,
    label: string,
    action: (access: typeof sessionAccess) => Promise<T>,
  ) => {
    assertCurrent()
    if (allowed()) {
      return action({
        request: (input, init) => {
          assertCurrent()
          if (!allowed()) throw new AdminAccessError()
          return sessionAccess.request(input, init)
        },
      })
    }
    if (emergencyOnly) {
      return emergency.runEmergency(label, (access) => {
        assertCurrent()
        return action(access)
      })
    }
    throw new AdminAccessError()
  }
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [removeConfirm, setRemoveConfirm] = useState(false)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-overview'] })

  const onToggleDisabled = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await run(
        () => row.disabled ? canEnable : leaf.can('behaviour.write'),
        `${row.disabled ? 'Enable' : 'Disable'} ${row.tenant.productName}`,
        (access) => setPortalDisabled(row.tenant.slug, access, !row.disabled),
      )
      assertCurrent()
      if (result === undefined) return
      setMessage(messageFor('ok', ({ ui }) =>
        ui(
          row.disabled
            ? 'Portal enabled. Refresh the overview to see its latest state.'
            : 'Portal disabled. Refresh the overview to see its latest state.',
        )))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
      assertCurrent()
      if (!emergencyOnly) await authority.refresh()
    } catch (err) {
      if (!current()) return
      setMessage(
        messageFor(
          'error',
          ({ error }) => error(err, 'Could not update the portal.'),
        ),
      )
    } finally {
      if (current()) setBusy(false)
    }
  }

  const onRemove = async () => {
    // Native modality must end before the emergency passcode overlay takes focus.
    if (emergencyOnly) setRemoveConfirm(false)
    setBusy(true)
    setMessage(null)
    try {
      const result = await run(
        () =>
          !row.disabled && authority.can('portal.delete', { kind: 'platform' }) &&
          (!row.tenant.hostname || leaf.can('domains.write')),
        `Remove ${row.tenant.productName}`,
        (access) => removePortal(row.tenant.slug, access),
      )
      assertCurrent()
      if (result === undefined) return
      setRemoveConfirm(false)
      setMessage(
        messageFor(
          'ok',
          ({ ui }) => ui('Portal removed. Refresh the overview to see its latest state.'),
        ),
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      if (!current()) return
      setMessage(
        messageFor(
          'error',
          ({ error }) => error(err, 'Could not remove the portal.'),
        ),
      )
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <section data-portal-row={row.tenant.slug} className='rp-card overflow-hidden'>
      <SectionHeader
        className='rp-admin-section-head p-5 lg:p-6'
        title={
          <span className='flex min-w-0 items-center gap-3'>
            <StatusDot status={row.knowledgeBox.status} />
            <span className='min-w-0 break-words'>{row.tenant.productName}</span>
          </span>
        }
        description={row.tenant.organisation}
        actions={
          <>
            <StatusBadge status={row.knowledgeBox.status} />
            {row.disabled && <span className='rp-badge rp-badge-quiet'>{ui('Hidden')}</span>}
            <span className='text-sm tabular-nums text-ink-3'>
              {row.resourceCount === null
                ? ui('unreachable')
                : ui(row.resourceCount === 1 ? '{count} document' : '{count} documents', {
                  count: row.resourceCount,
                })}
            </span>
            <IconButton
              label={row.tenant.productName}
              icon={ChevronDown}
              size='sm'
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-controls={`portal-actions-${row.tenant.slug}`}
              className={`transition-transform duration-150 motion-reduce:transition-none ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </>
        }
      />

      {expanded && (
        <div
          id={`portal-actions-${row.tenant.slug}`}
          data-portal-actions={row.tenant.slug}
          className='border-t border-line'
        >
          <div className='flex flex-wrap items-start justify-between gap-4 p-5 lg:p-6'>
            {renaming
              ? (
                <RenamePortal
                  headingLevel={3}
                  slug={row.tenant.slug}
                  initialName={row.tenant.productName}
                  initialOrganisation={row.tenant.organisation}
                  initialTagline={row.tenant.tagline}
                  onCancel={() => setRenaming(false)}
                  onSaved={() => setRenaming(false)}
                />
              )
              : (
                <div className='min-w-0 basis-full sm:basis-auto sm:flex-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <h3 className='break-words text-lg font-semibold tracking-tight text-ink'>
                      {row.tenant.productName}
                    </h3>
                    {(canRename || (emergencyOnly && !row.disabled)) && (
                      <Button
                        variant='ghost'
                        size='sm'
                        leadingIcon={Pencil}
                        onClick={() => setRenaming(true)}
                      >
                        {ui('Rename')}
                      </Button>
                    )}
                  </div>
                  <p className='mt-0.5 text-sm text-ink-3'>{row.tenant.organisation}</p>
                </div>
              )}

            <div className='flex min-w-0 max-w-full flex-col items-start gap-2 sm:items-end'>
              <StatusBadge status={row.knowledgeBox.status} />
              {(canBind || canRename || canDisable) && (
                <Link
                  to={`/t/${row.tenant.slug}/manage`}
                  className='rp-btn rp-btn-primary max-w-full whitespace-normal py-2 text-center'
                >
                  {ui('Open portal management')}
                  <ArrowRight size='sm' />
                </Link>
              )}
              {canRead && (
                <Link
                  to={`/t/${row.tenant.slug}`}
                  className='rp-btn rp-btn-ghost rp-btn-sm'
                >
                  <Eye size='sm' />
                  {ui('View portal')}
                </Link>
              )}
            </div>
          </div>

          <div className='px-5 pb-5 lg:px-6 lg:pb-6'>
            {(canBind || (emergencyOnly && !row.disabled)) && (
              <>
                <CreateKbBox row={row} onCreated={refresh} />
                <PortalConnections
                  slug={row.tenant.slug}
                  name={row.tenant.productName}
                  knowledgeBox={row.knowledgeBox}
                  resourceCount={row.resourceCount}
                  onChanged={refresh}
                />
              </>
            )}

            <div className='mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4'>
              {(canEnable || canDisable || emergencyOnly) && (
                <Button
                  variant='ghost'
                  size='sm'
                  leadingIcon={row.disabled ? Eye : EyeOff}
                  data-portal-enable={row.disabled ? true : undefined}
                  data-portal-disable={!row.disabled ? true : undefined}
                  disabled={busy}
                  onClick={() => void onToggleDisabled()}
                  title={row.disabled
                    ? ui('Show this portal in the switcher and portal list again')
                    : ui('Hide this portal from the switcher and portal list')}
                >
                  {row.disabled ? ui('Enable') : ui('Disable')}
                </Button>
              )}
              {row.custom && (canRemove || (emergencyOnly && !row.disabled)) && (
                <Button
                  variant='danger'
                  size='sm'
                  leadingIcon={Trash}
                  data-portal-remove
                  disabled={busy}
                  onClick={() => {
                    setMessage(null)
                    setRemoveConfirm(true)
                  }}
                  title={ui(
                    'Removes this portal from the app - the knowledge box itself is untouched',
                  )}
                >
                  {ui('Remove')}
                </Button>
              )}
            </div>

            {message && <MessagePanel message={message} className='mt-4' />}
          </div>
        </div>
      )}
      {removeConfirm && (
        <ConfirmActionDialog
          title={ui("Remove the '{name}' portal from the app?", { name: row.tenant.productName })}
          description={ui(
            'Removes this portal from the app - the knowledge box itself is untouched',
          )}
          confirmLabel={ui('Remove')}
          cancelLabel={ui('Cancel')}
          busy={busy}
          busyLabel={ui('Removing…')}
          error={message?.tone === 'error' ? message.text : null}
          onConfirm={() => void onRemove()}
          onCancel={() => setRemoveConfirm(false)}
        />
      )}
    </section>
  )
}

export function PortalRow(props: ComponentProps<typeof PortalRowContent>) {
  const { generation } = useAccess()
  return (
    <PortalRowContent
      key={`${generation}:${props.row.tenant.slug}:${props.expanded}:${props.row.disabled}`}
      {...props}
    />
  )
}
