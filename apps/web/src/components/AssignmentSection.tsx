import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type Permission, PLATFORM_ROLES, PORTAL_ROLES, type Scope } from '@research-portal/core'
import { useAccess } from './AccessProvider.tsx'
import { AssignmentEditor } from './AssignmentEditor.tsx'
import {
  AssignmentError,
  type AssignmentFamily,
  changeAssignment,
  createAssignment,
  listAssignments,
  removeAssignment,
} from '../api/access.ts'
import type { AuthorityController } from '../api/access-lifecycle.ts'

export const unconfirmedMessage =
  'The change could not be confirmed. Refresh this view before trying again.'
// Feedback owns one section and exactly one refresh, never assignment data or input values.
const notices = new WeakMap<
  AuthorityController,
  Map<string, { identity: string | null; slug: string | null; generation: number }>
>()

export function useAccessMutation(scope: Scope, permission: Permission, section: string) {
  const { controller } = useAccess()
  const context = controller.context
  const lifetime = useRef<object | null>(null)
  const [notice, setNotice] = useState(() => {
    const item = notices.get(controller)?.get(section)
    return item?.identity === context.identityKey && item?.slug === context.slug &&
      item?.generation === context.generation
  })
  useLayoutEffect(() => {
    notices.get(controller)?.delete(section)
    lifetime.current = {}
    const cleanup = controller.registerCleanup(() => {
      lifetime.current = null
      setNotice(false)
    })
    return () => {
      lifetime.current = null
      cleanup()
    }
  }, [controller, section])
  const mutate = async (operation: () => Promise<unknown>) => {
    const token = lifetime.current
    if (!token) return
    controller.assertCurrent(context)
    if (!controller.can(permission, scope)) return
    let failure: unknown
    try {
      await operation()
    } catch (error) {
      if (error instanceof AssignmentError && error.correctable) throw error
      failure = error
    }
    if (controller.context !== context) return
    // A completed operation can change shared authority even after its originating tab unmounts.
    if (failure && lifetime.current === token) {
      const entries = notices.get(controller) ?? new Map()
      entries.set(section, {
        identity: context.identityKey,
        slug: context.slug,
        generation: context.generation + 2,
      })
      notices.set(controller, entries)
    }
    try {
      await controller.refresh(context.slug ?? undefined)
      const refreshed = controller.context
      requestAnimationFrame(() => {
        if (controller.context !== refreshed || document.activeElement !== document.body) return
        const heading = document.querySelector<HTMLElement>('main h1')
        if (heading) {
          heading.tabIndex = -1
          heading.focus({ preventScroll: true })
        }
      })
    } catch {
      notices.get(controller)?.delete(section)
    }
    if (failure) throw failure
  }
  return { mutate, notice, options: { authority: controller, context } }
}

export function AssignmentSection(
  { scope, name, family }: { scope: Scope; name: string; family: AssignmentFamily },
) {
  const access = useAccess()
  const permission = scope.kind === 'portal' ? 'members.manage' : 'platform.members.manage'
  if (!access.can(permission, scope)) return null
  return (
    <Section
      key={`${JSON.stringify(scope)}:${access.generation}:${family}`}
      scope={scope}
      name={name}
      family={family}
    />
  )
}
function Section(
  { scope, name, family }: { scope: Scope; name: string; family: AssignmentFamily },
) {
  const access = useAccess()
  const id = useId()
  const permission = scope.kind === 'portal' ? 'members.manage' : 'platform.members.manage'
  const { mutate, notice, options } = useAccessMutation(scope, permission, family)
  const title = family === 'groups' ? 'Group mappings' : 'Members'
  const rows = useQuery({
    queryKey: ['access-assignments', scope, family, access.identityKey, access.generation],
    queryFn: ({ signal }) => listAssignments(scope, family, { ...options, signal }),
    enabled: access.can(permission, scope),
    retry: false,
  })
  const supported = family !== 'groups' || rows.data?.capability === 'enabled'
  return (
    <section className='mt-6 min-w-0' aria-labelledby={id} data-assignment-section={family}>
      <h3 id={id} className='rp-display mb-4 text-xl'>{title}</h3>
      {notice && (
        <p role='alert' className='mb-4 text-sm text-[var(--rp-bad-ink)]'>{unconfirmedMessage}</p>
      )}
      {!supported && (
        <p className='mb-4 text-base text-ink-2'>
          Group mappings are unavailable. Use individual assignments until group support is
          confirmed.
        </p>
      )}
      {rows.isLoading && (
        <p role='status' className='text-base text-ink-2'>Loading {title.toLowerCase()}...</p>
      )}
      {rows.isError && (
        <div role='alert'>
          <p className='text-base text-ink-2'>Could not load {title.toLowerCase()}. Try again.</p>
          <button
            type='button'
            className='rp-btn rp-btn-outline mt-4 min-h-[44px]'
            onClick={() => void rows.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {rows.data && (
        <AssignmentEditor
          scope={scope}
          scopeName={name}
          family={family}
          roles={scope.kind === 'portal' ? PORTAL_ROLES : PLATFORM_ROLES}
          items={rows.data.items}
          canEdit={supported}
          onCreate={(input) => mutate(() => createAssignment(scope, family, input, options))}
          onChange={(id, role) => mutate(() => changeAssignment(scope, family, id, role, options))}
          onRemove={(id) => mutate(() => removeAssignment(scope, family, id, options))}
        />
      )}
    </section>
  )
}
