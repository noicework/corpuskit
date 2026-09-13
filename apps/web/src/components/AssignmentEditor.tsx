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
  const access = useAccess()
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const roleField = useRef<HTMLSelectElement>(null)
  const lifetime = useRef<object | null>(null)
  const sending = useRef(false)
  const [form, setForm] = useState<'new' | RoleAssignment | null>(null)
  const [subjectKind, setSubjectKind] = useState<'active-oid' | 'pending-email'>('pending-email')
  const [subjectId, setSubjectId] = useState('')
  const [role, setRole] = useState<Role>(scope.kind === 'portal' ? 'viewer' : 'platform-admin')
  const [confirmation, setConfirmation] = useState<
    { kind: 'remove'; row: RoleAssignment } | { kind: 'owner' } | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const group = family === 'groups'
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
            : { subjectKind, subjectId: subjectId.trim(), role },
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
      <p className='max-w-prose text-sm text-ink-2'>
        Local assignments for{' '}
        {scopeName}. Other Entra or local assignments may still provide access.
      </p>
      {items.length === 0 && (
        <div className='py-6'>
          <h3 className='rp-display text-xl'>{group ? 'No group mappings' : 'No local members'}</h3>
          <p className='mt-2 text-base text-ink-2'>
            {group
              ? canEdit
                ? 'Map a supported Entra group to a role for this scope.'
                : 'Individual assignments remain available.'
              : 'Add a person by object ID or email. Entra access may still apply.'}
          </p>
        </div>
      )}
      <ul className='mt-4 divide-y divide-[var(--rp-line)]'>
        {items.map((row) => (
          <li
            key={row.id}
            className='flex min-w-0 flex-wrap items-start justify-between gap-4 py-4'
            data-assignment-id={row.id}
          >
            <div className='min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]'>
              <p className='text-base'>{row.subjectId}</p>
              <p className='mt-1 text-sm text-ink-2'>
                {assignmentRoleLabel[row.role]} · Local {group ? 'group mapping' : 'assignment'}
              </p>
              <p className='mt-1 text-sm text-ink-2'>
                {row.subjectKind === 'pending-email'
                  ? 'Pending sign-in'
                  : row.subjectKind === 'group'
                  ? canEdit ? 'Group object ID' : 'Inactive group mapping'
                  : 'Active object ID'}
              </p>
              {row.subjectKind === 'pending-email' && (
                <p className='mt-1 text-sm text-ink-2'>
                  This assignment activates when the matching organisation account signs in.
                </p>
              )}
              {row.emailProvenance && row.subjectKind !== 'pending-email' && (
                <p className='mt-1 text-sm text-ink-2'>Activated from {row.emailProvenance}</p>
              )}
            </div>
            <div className='flex min-w-0 flex-wrap gap-2'>
              {canEdit && (
                <button
                  type='button'
                  className='rp-btn rp-btn-outline min-h-[44px]'
                  disabled={busy}
                  onClick={() => {
                    setForm(row)
                    setRole(row.role)
                    setError(null)
                  }}
                  aria-label={`Edit role for ${row.subjectId}`}
                >
                  Edit role
                </button>
              )}
              <button
                type='button'
                className='rp-btn rp-btn-ghost min-h-[44px]'
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setConfirmation({ kind: 'remove', row })
                }}
                aria-label={`Remove ${group ? 'mapping' : 'member'} ${row.subjectId}`}
              >
                Remove {group ? 'mapping' : 'member'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!form && canEdit && (
        <button
          type='button'
          className='rp-btn rp-btn-primary mt-4 min-h-[44px]'
          onClick={() => {
            setForm('new')
            setSubjectId('')
            setRole(scope.kind === 'portal' ? 'viewer' : 'platform-admin')
            setError(null)
          }}
        >
          {addLabel}
        </button>
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
          <h3 className='rp-display break-words text-xl [overflow-wrap:anywhere]'>
            {form === 'new' ? addLabel : `Edit role for ${form.subjectId}`}
          </h3>
          <fieldset disabled={busy} className='mt-4 min-w-0 space-y-4'>
            <legend className='sr-only'>Assignment for {scopeName}</legend>
            {form === 'new' && (
              <>
                {!group && (
                  <label className='block text-sm' htmlFor={`${id}-kind`}>
                    Assign by<select
                      id={`${id}-kind`}
                      className='rp-input mt-2 w-full text-base'
                      value={subjectKind}
                      onChange={(e) => setSubjectKind(e.target.value as typeof subjectKind)}
                    >
                      <option value='pending-email'>Email</option>
                      <option value='active-oid'>Object ID</option>
                    </select>
                  </label>
                )}
                <label className='block text-sm' htmlFor={`${id}-subject`}>
                  {group
                    ? 'Group object ID'
                    : subjectKind === 'pending-email'
                    ? 'Email'
                    : 'Object ID'}
                  <input
                    ref={field}
                    id={`${id}-subject`}
                    data-assignment-subject
                    className='rp-input mt-2 w-full text-base'
                    required
                    maxLength={subjectKind === 'pending-email' && !group ? 254 : 160}
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
              Role<select
                ref={roleField}
                id={`${id}-role`}
                data-assignment-role
                className='rp-input mt-2 w-full text-base'
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                aria-invalid={!!error}
                aria-describedby={[
                  scope.kind === 'platform' ? `${id}-role-help` : '',
                  error ? `${id}-error` : '',
                ].filter(Boolean).join(' ') || undefined}
              >
                {allowed.map((value) => (
                  <option key={value} value={value}>{assignmentRoleLabel[value]}</option>
                ))}
              </select>
            </label>
            {scope.kind === 'platform' && (
              <p id={`${id}-role-help`} data-platform-role-help className='text-sm text-ink-2'>
                {assignmentRoleLabel[role]} access applies to all present and future portals.
              </p>
            )}
            {error && !confirmation && (
              <p id={`${id}-error`} role='alert' className='text-sm text-[var(--rp-bad-ink)]'>
                {error}
              </p>
            )}
            <div className='flex flex-wrap gap-3'>
              <button
                type='submit'
                className='rp-btn rp-btn-primary min-h-[44px]'
                disabled={!allowed.includes(role)}
              >
                {form === 'new' ? addLabel : 'Save role'}
              </button>
              <button
                type='button'
                className='rp-btn rp-btn-outline min-h-[44px]'
                onClick={clearForm}
              >
                {form === 'new'
                  ? group ? 'Keep mapping' : 'Close member form'
                  : 'Keep current role'}
              </button>
            </div>
          </fieldset>
          {busy && <p role='status' className='mt-4 text-sm'>Saving change...</p>}
        </form>
      )}
      {confirmation && (
        <ConfirmActionDialog
          title={confirmation.kind === 'owner'
            ? 'Grant Owner'
            : `Remove ${group ? 'mapping' : 'member'}`}
          description={confirmation.kind === 'owner'
            ? `Grant Owner to ${
              form === 'new' ? subjectId : form && form.subjectId
            }? This includes managing platform access and settings, and deleting portals.`
            : `Remove ${confirmation.row.subjectId}'s local assignment for ${scopeName}? Other sources may still provide access.`}
          confirmLabel={confirmation.kind === 'owner'
            ? 'Grant Owner'
            : `Remove ${group ? 'mapping' : 'member'}`}
          cancelLabel={confirmation.kind === 'owner'
            ? 'Keep current role'
            : group
            ? 'Keep mapping'
            : 'Keep member'}
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
