import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type Permission, PLATFORM_ROLES, PORTAL_ROLES, type Scope } from '@research-portal/core'
import { useAccess } from './AccessProvider.tsx'
import { AssignmentEditor } from './AssignmentEditor.tsx'
import { ErrorCard, SectionHeader, Skeleton } from './ui.tsx'
import { AlertCircle } from './icons.tsx'
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
    const originUrl = globalThis.location.href
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
      let attempts = 0, frame = 0
      const cleanup = () => {
        cancelAnimationFrame(frame)
        unregister()
      }
      const unregister = controller.registerCleanup(cleanup)
      const restore = () => {
        if (
          controller.context !== refreshed || globalThis.location.href !== originUrl ||
          document.activeElement !== document.body
        ) {
          cleanup()
          return
        }
        const heading = document.querySelector<HTMLElement>('main h1')
        if (heading) {
          heading.tabIndex = -1
          heading.focus({ preventScroll: true })
          cleanup()
        } else if (++attempts < 30) frame = requestAnimationFrame(restore)
        else cleanup()
      }
      frame = requestAnimationFrame(restore)
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
  const { ui } = usePortalLocale()
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
    <section
      className='rp-card min-w-0 space-y-4 p-5 lg:p-6'
      aria-labelledby={id}
      data-assignment-section={family}
    >
      <SectionHeader
        className='rp-admin-section-head'
        title={<span id={id}>{ui(title)}</span>}
        description={ui(
          'Local assignments for {name}. Other Entra or local assignments may still provide access.',
          { name },
        )}
      />
      {notice && (
        <p role='alert' className='flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'>
          <AlertCircle size='sm' className='shrink-0' />
          {ui(unconfirmedMessage)}
        </p>
      )}
      {!supported && (
        <p className='text-sm text-ink-2'>
          {ui(
            'Group mappings are unavailable. Use individual assignments until group support is confirmed.',
          )}
        </p>
      )}
      {rows.isLoading && (
        <div role='status' className='space-y-3'>
          <span className='sr-only'>
            {ui('Loading {items}...', { items: ui(title.toLowerCase()) })}
          </span>
          <Skeleton className='h-5 w-1/3' />
          <Skeleton className='h-16 w-full' />
        </div>
      )}
      {rows.isError && (
        <div role='alert'>
          <ErrorCard
            message={ui('Could not load {items}. Try again.', { items: ui(title.toLowerCase()) })}
            onRetry={() => void rows.refetch()}
          />
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
