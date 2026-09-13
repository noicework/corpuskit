import { useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type Permission, PORTAL_ROLES } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import { AssignmentEditor } from '../../components/AssignmentEditor.tsx'
import {
  AssignmentError,
  changeAssignment,
  createAssignment,
  listAssignments,
  removeAssignment,
} from '../../api/access.ts'
import type { AuthorityController } from '../../api/access-lifecycle.ts'

export const ACCESS_SECTION_PERMISSIONS: readonly Permission[] = [
  'members.manage',
  'behaviour.write',
  'keys.manage',
]
const unconfirmedMessage =
  'The change could not be confirmed. Refresh this view before trying again.'
// Generic feedback survives only the single refresh that discarded the originating form.
// Never retain assignment rows, input values or target labels across authority generations.
const notices = new WeakMap<
  AuthorityController,
  { identity: string | null; slug: string; generation: number }
>()

export function AccessPanel({ slug, name }: { slug: string; name: string }) {
  const access = useAccess()
  const scope = { kind: 'portal' as const, slug }
  if (!ACCESS_SECTION_PERMISSIONS.some((permission) => access.can(permission, scope))) return null
  return (
    <section className='rp-card min-w-0 p-6' data-access-panel>
      <h2 className='rp-display break-words text-xl [overflow-wrap:anywhere]'>Access to {name}</h2>
      <p className='mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]'>Portal: {slug}</p>
      {access.can('members.manage', scope)
        ? <Members key={`${slug}:${access.generation}`} slug={slug} name={name} />
        : (
          <p className='mt-6 text-base text-ink-2'>
            No access settings are available in this view.
          </p>
        )}
    </section>
  )
}

function Members({ slug, name }: { slug: string; name: string }) {
  const access = useAccess()
  const { controller } = access
  const context = controller.context
  const scope = { kind: 'portal' as const, slug }
  const options = { authority: controller, context }
  const lifetime = useRef<object | null>(null)
  const [notice, setNotice] = useState(() => {
    const item = notices.get(controller)
    return item?.identity === context.identityKey && item.slug === slug &&
      item.generation === context.generation
  })
  useLayoutEffect(() => {
    notices.delete(controller)
    lifetime.current = {}
    const cleanup = controller.registerCleanup(() => {
      lifetime.current = null
      setNotice(false)
    })
    return () => {
      lifetime.current = null
      cleanup()
    }
  }, [controller])
  const rows = useQuery({
    queryKey: ['access-members', slug, access.identityKey, access.generation],
    queryFn: ({ signal }) => listAssignments(scope, 'members', { ...options, signal }),
    enabled: access.can('members.manage', scope),
    retry: false,
  })
  const mutate = async (operation: () => Promise<unknown>) => {
    const token = lifetime.current
    if (!token) return
    controller.assertCurrent(context)
    if (!controller.can('members.manage', scope)) return
    let failure: unknown
    try {
      await operation()
    } catch (error) {
      if (error instanceof AssignmentError && error.correctable) throw error
      failure = error
    }
    if (controller.context !== context) return
    // Leaving this tab discards its UI, but a completed mutation still changes
    // the authority used by other tabs in this same current portal.
    if (failure && lifetime.current === token) {
      notices.set(controller, {
        identity: context.identityKey,
        slug,
        generation: context.generation + 2,
      })
    }
    try {
      await controller.refresh(slug)
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
      notices.delete(controller)
    }
    if (failure) throw failure
  }
  return (
    <section className='mt-6 min-w-0' aria-labelledby='access-members-heading'>
      <h3 id='access-members-heading' className='rp-display mb-4 text-xl'>Members</h3>
      {notice && (
        <p role='alert' className='mb-4 text-sm text-[var(--rp-bad-ink)]'>{unconfirmedMessage}</p>
      )}
      {rows.isLoading && <p role='status' className='text-base text-ink-2'>Loading members...</p>}
      {rows.isError && (
        <div role='alert'>
          <p className='text-base text-ink-2'>Could not load members. Try again.</p>
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
          family='members'
          roles={PORTAL_ROLES}
          items={rows.data.items}
          onCreate={(input) => mutate(() => createAssignment(scope, 'members', input, options))}
          onChange={(id, role) =>
            mutate(() => changeAssignment(scope, 'members', id, role, options))}
          onRemove={(id) => mutate(() => removeAssignment(scope, 'members', id, options))}
        />
      )}
    </section>
  )
}
