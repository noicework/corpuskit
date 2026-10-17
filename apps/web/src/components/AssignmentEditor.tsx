import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { PLATFORM_ROLES, PORTAL_ROLES, type Role, type Scope } from '@research-portal/core'
import {
  AssignmentError,
  type AssignmentFamily,
  type GroupInput,
  type MemberInput,
  type RoleAssignment,
} from '../api/access.ts'
import { useAccess } from './AccessProvider.tsx'
import { ConfirmActionDialog } from './ConfirmActionDialog.tsx'
import { Button, EmptyState, SectionHeader } from './ui.tsx'
import { AlertCircle, Pencil, Plus, Trash } from './icons.tsx'

export const assignmentRoleLabel: Record<Role, string> = {
  viewer: 'Viewer',
  analyst: 'Analyst',
  curator: 'Curator',
  'portal-admin': 'Portal administrator',
  'platform-admin': 'Platform administrator',
  owner: 'Owner',
}
interface Props {
  scope: Scope
  scopeName: string
  family: AssignmentFamily
  roles: readonly Role[]
  items: RoleAssignment[]
  canEdit?: boolean
  onCreate(input: MemberInput | GroupInput): Promise<unknown>
  onChange(id: string, role: Role): Promise<unknown>
  onRemove(id: string): Promise<unknown>
}
export function AssignmentEditor(props: Props) {
  const access = useAccess()
  const permitted = access.can(
    props.scope.kind === 'portal' ? 'members.manage' : 'platform.members.manage',
    props.scope,
  )
  if (!permitted) return null
  return (
    <Editor
      key={`${access.generation}:${JSON.stringify(props.scope)}:${props.family}`}
      {...props}
    />
  )
}
function Editor(
  { scope, scopeName, family, roles, items, canEdit = true, onCreate, onChange, onRemove }: Props,
) {
  const locale = usePortalLocale()
  const { ui } = locale
  const access = useAccess()
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const roleField = useRef<HTMLSelectElement>(null)
  const lifetime = useRef<object | null>(null)
  const sending = useRef(false)
  const [form, setForm] = useState<'new' | RoleAssignment | null>(null)
  const [subjectKind, setSubjectKind] = useState<'active-oid' | 'pending-email'>('pending-email')
  const [subjectId, setSubjectId] = useState('')
  // Without Entra sign-in no Entra identity can claim a row, so start from the external source.
  const defaultSource = access.state.session?.entraEnabled === false ? 'external' : 'entra'
  const [source, setSource] = useState<'entra' | 'external'>(defaultSource)
  const [role, setRole] = useState<Role>(scope.kind === 'portal' ? 'viewer' : 'platform-admin')
  const [confirmation, setConfirmation] = useState<
    { kind: 'remove'; row: RoleAssignment } | { kind: 'owner' } | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const group = family === 'groups'
  // Identity sources matter only once external sign-in is configured or an external row exists.
  const sources = !group &&
    (access.state.session?.externalLoginEnabled === true ||
      items.some((row) => row.source === 'external'))
  const allowed = roles.filter((value) =>
    (scope.kind === 'portal' ? [...PORTAL_ROLES] as Role[] : [...PLATFORM_ROLES] as Role[])
      .includes(value)
  )
  useLayoutEffect(() => {
    lifetime.current = {}
    const clear = () => {
      lifetime.current = null
      setForm(null)
      setSubjectId('')
      setConfirmation(null)
      setError(null)
    }
    const unregister = access.controller.registerCleanup(clear)
    return () => {
      lifetime.current = null
      unregister()
    }
  }, [access.controller])
  useLayoutEffect(() => {
    if (form === 'new') field.current?.focus()
    else if (form) roleField.current?.focus()
  }, [form])
  useLayoutEffect(() => {
    if (error && !busy && !confirmation) {
      ;(form === 'new' ? field.current : roleField.current)?.focus()
    }
  }, [error, busy, confirmation, form])
  useLayoutEffect(() => {
    if (!canEdit) {
      setForm(null)
      setSubjectId('')
      setConfirmation((value) => value?.kind === 'owner' ? null : value)
      setError(null)
    }
  }, [canEdit])
  const clearForm = () => {
    setForm(null)
    setSubjectId('')
    setError(null)
    setConfirmation(null)
  }
  const run = async (operation: () => Promise<unknown>) => {
    if (sending.current || !lifetime.current) return
    const token = lifetime.current
    const context = access.controller.context
    access.controller.assertCurrent(context)
    if (
      !access.controller.can(
        scope.kind === 'portal' ? 'members.manage' : 'platform.members.manage',
        scope,
      )
    ) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      if (lifetime.current !== token || access.controller.context !== context) return
      clearForm()
    } catch (failure) {
      if (lifetime.current !== token || access.controller.context !== context) return
      setError(
        failure instanceof AssignmentError
          ? failure.message
          : 'The change could not be confirmed. Refresh this view before trying again.',
      )
    } finally {
      if (lifetime.current === token) {
        sending.current = false
        setBusy(false)
      }
    }
  }
  const save = () => {
    if (!canEdit || !allowed.includes(role)) return
    return run(() =>
      form === 'new'
        ? onCreate(
          group
            ? { subjectId: subjectId.trim(), role }
            : { subjectKind, subjectId: subjectId.trim(), role, ...(sources ? { source } : {}) },
        )
        : onChange((form as RoleAssignment).id, role)
    )
  }
  const addLabel = group
    ? 'Add group mapping'
    : scope.kind === 'platform'
    ? 'Add platform member'
    : 'Add member'
  return (
    <div className='min-w-0' data-assignment-editor>
      {items.length === 0 && (
        <EmptyState
          title={group ? ui('No group mappings') : ui('No local members')}
          description={group
            ? canEdit
              ? ui('Map a supported Entra group to a role for this scope.')
              : ui('Individual assignments remain available.')
            : ui('Add a person by object ID or email. Entra access may still apply.')}
        />
      )}
      <ul className='mt-4 divide-y divide-[var(--rp-line)]'>
        {items.map((row) => (
          <li
            key={row.id}
            className='flex min-w-0 flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between'
            data-assignment-id={row.id}
          >
            <div className='min-w-0 flex-1 [overflow-wrap:anywhere]'>
              <p className='text-base'>{row.subjectId}</p>
              <p className='mt-2 text-sm'>
                <span className='rp-tag'>{ui(assignmentRoleLabel[row.role])}</span>
              </p>
              <p className='mt-1 text-sm text-ink-2'>
                {group ? ui('Local group mapping') : ui('Local assignment')}
              </p>
              <p className='mt-1 text-sm text-ink-2'>
                {row.subjectKind === 'pending-email'
                  ? <span className='rp-badge rp-badge-warn'>{ui('Pending sign-in')}</span>
                  : row.subjectKind === 'group'
                  ? canEdit ? ui('Group object ID') : (
                    <span className='rp-badge rp-badge-quiet'>
                      {ui('Inactive group mapping')}
                    </span>
                  )
                  : ui('Active object ID')}
              </p>
              {!group && sources && (
                <p className='mt-1 text-sm text-ink-2' data-assignment-source={row.source}>
                  {ui('Identity source')}:{' '}
                  {row.source === 'external' ? ui('External account') : 'Microsoft Entra'}
                </p>
              )}
              {row.subjectKind === 'pending-email' && (
                <p className='mt-2 text-sm text-ink-2'>
                  {ui('This assignment activates when the matching {source} account signs in.', {
                    source: !sources
                      ? ui('organisation')
                      : row.source === 'external'
                      ? ui('external')
                      : 'Microsoft Entra',
                  })}
                </p>
              )}
              {row.emailProvenance && row.subjectKind !== 'pending-email' && (
                <p className='mt-1 text-sm text-ink-2'>
                  {ui('Activated from {email}', { email: row.emailProvenance })}
                </p>
              )}
            </div>
            <div className='flex w-full min-w-0 gap-2 sm:w-auto'>
              {canEdit && (
                <Button
                  variant='ghost'
                  size='sm'
                  leadingIcon={Pencil}
                  className='min-w-0 flex-1 whitespace-normal sm:flex-none'
                  disabled={busy}
                  onClick={() => {
                    setForm(row)
                    setRole(row.role)
                    setError(null)
                  }}
                  aria-label={ui('Edit role for {identity}', { identity: row.subjectId })}
                >
                  <span className='min-w-0 [overflow-wrap:anywhere]'>{ui('Edit role')}</span>
                </Button>
              )}
              <Button
                variant='danger'
                size='sm'
                leadingIcon={Trash}
                className='min-w-0 flex-[1.4] whitespace-normal sm:flex-none'
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setConfirmation({ kind: 'remove', row })
                }}
                aria-label={group
                  ? ui('Remove mapping {identity}', { identity: row.subjectId })
                  : ui('Remove member {identity}', { identity: row.subjectId })}
              >
                <span className='min-w-0 [overflow-wrap:anywhere]'>
                  {group ? ui('Remove mapping') : ui('Remove member')}
                </span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!form && canEdit && (
        <Button
          leadingIcon={Plus}
          className='mt-4'
          onClick={() => {
            setForm('new')
            setSubjectId('')
            setSource(defaultSource)
            setRole(scope.kind === 'portal' ? 'viewer' : 'platform-admin')
            setError(null)
          }}
        >
          {ui(addLabel)}
        </Button>
      )}
      {form && (
        <form
          className='mt-6 min-w-0 border-t border-[var(--rp-line)] pt-6'
          onSubmit={(event) => {
            event.preventDefault()
            if (role === 'owner' && (form === 'new' || form.role !== 'owner')) {
              setConfirmation({ kind: 'owner' })
            } else void save()
          }}
        >
          <SectionHeader
            headingLevel={3}
            className='rp-admin-section-head [overflow-wrap:anywhere]'
            title={form === 'new'
              ? ui(addLabel)
              : ui('Edit role for {identity}', { identity: form.subjectId })}
          />
          <fieldset disabled={busy} className='mt-4 min-w-0 space-y-4'>
            <legend className='sr-only'>{ui('Assignment for {name}', { name: scopeName })}</legend>
            {form === 'new' && (
              <>
                {!group && (
                  <label className='block text-sm' htmlFor={`${id}-kind`}>
                    {ui('Assign by')}
                    <select
                      id={`${id}-kind`}
                      className='rp-input rp-select mt-2 w-full text-base'
                      value={subjectKind}
                      onChange={(e) => setSubjectKind(e.target.value as typeof subjectKind)}
                    >
                      <option value='pending-email'>{ui('Email')}</option>
                      <option value='active-oid'>{ui('Object ID')}</option>
                    </select>
                  </label>
                )}
                {!group && sources && (
                  <label className='block text-sm' htmlFor={`${id}-source`}>
                    {ui('Identity source')}
                    <select
                      id={`${id}-source`}
                      data-assignment-source-input
                      className='rp-input rp-select mt-2 w-full text-base'
                      value={source}
                      onChange={(e) => setSource(e.target.value as typeof source)}
                      aria-describedby={`${id}-source-help`}
                    >
                      <option value='entra'>Microsoft Entra</option>
                      <option value='external'>{ui('External account')}</option>
                    </select>
                    <span id={`${id}-source-help`} className='mt-2 block text-xs text-ink-3'>
                      {ui(
                        'Choose how this person signs in. Access stays bound to this identity source.',
                      )}
                    </span>
                  </label>
                )}
                <label className='block text-sm' htmlFor={`${id}-subject`}>
                  {group
                    ? ui('Group object ID')
                    : subjectKind === 'pending-email'
                    ? ui('Email')
                    : ui('Object ID')}
                  <input
                    ref={field}
                    id={`${id}-subject`}
                    data-assignment-subject
                    className='rp-input mt-2 w-full text-base'
                    required
                    maxLength={subjectKind === 'pending-email' && !group
                      ? 254
                      : source === 'external' && !group
                      ? 260
                      : 160}
                    type={subjectKind === 'pending-email' && !group ? 'email' : 'text'}
                    value={subjectId}
                    onChange={(e) => setSubjectId(e.target.value)}
                    aria-invalid={!!error}
                    aria-describedby={error ? `${id}-error` : undefined}
                  />
                </label>
              </>
            )}
            <label className='block text-sm' htmlFor={`${id}-role`}>
              {ui('Role')}
              <select
                ref={roleField}
                id={`${id}-role`}
                data-assignment-role
                className='rp-input rp-select mt-2 w-full text-base'
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                aria-invalid={!!error}
                aria-describedby={[
                  scope.kind === 'platform' ? `${id}-role-help` : '',
                  error ? `${id}-error` : '',
                ].filter(Boolean).join(' ') || undefined}
              >
                {allowed.map((value) => (
                  <option key={value} value={value}>{ui(assignmentRoleLabel[value])}</option>
                ))}
              </select>
            </label>
            {scope.kind === 'platform' && (
              <p id={`${id}-role-help`} data-platform-role-help className='text-xs text-ink-3'>
                {ui('{role} access applies to all present and future portals.', {
                  role: ui(assignmentRoleLabel[role]),
                })}
              </p>
            )}
            {error && !confirmation && (
              <p
                id={`${id}-error`}
                role='alert'
                className='flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'
              >
                <AlertCircle size='sm' className='shrink-0' />
                {locale.error(
                  error,
                  'The change could not be confirmed. Refresh this view before trying again.',
                )}
              </p>
            )}
            <div className='flex flex-wrap justify-end gap-2'>
              <Button variant='outline' onClick={clearForm}>
                {form === 'new'
                  ? group ? ui('Keep mapping') : ui('Close member form')
                  : ui('Keep current role')}
              </Button>
              <Button
                type='submit'
                leadingIcon={form === 'new' ? Plus : undefined}
                disabled={!allowed.includes(role)}
              >
                {form === 'new' ? ui(addLabel) : ui('Save role')}
              </Button>
            </div>
          </fieldset>
          {busy && <p role='status' className='mt-4 text-sm'>{ui('Saving change...')}</p>}
        </form>
      )}
      {confirmation && (
        <ConfirmActionDialog
          destructive={confirmation.kind !== 'owner'}
          title={confirmation.kind === 'owner'
            ? ui('Grant Owner')
            : group
            ? ui('Remove mapping')
            : ui('Remove member')}
          description={confirmation.kind === 'owner'
            ? ui(
              'Grant Owner to {identity}? This includes managing platform access and settings, and deleting portals.',
              { identity: form === 'new' ? subjectId : form ? form.subjectId : '' },
            )
            : ui(
              'Remove {identity}’s local assignment for {name}? Other sources may still provide access.',
              { identity: confirmation.row.subjectId, name: scopeName },
            )}
          confirmLabel={confirmation.kind === 'owner'
            ? ui('Grant Owner')
            : group
            ? ui('Remove mapping')
            : ui('Remove member')}
          cancelLabel={confirmation.kind === 'owner'
            ? ui('Keep current role')
            : group
            ? ui('Keep mapping')
            : ui('Keep member')}
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirmation(null)
            setError(null)
          }}
          onConfirm={() => {
            if (confirmation.kind === 'owner') void save()
            else void run(() => onRemove(confirmation.row.id))
          }}
        />
      )}
    </div>
  )
}
