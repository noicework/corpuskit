import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import type { Permission, Scope } from '@research-portal/core'
import {
  AuthorityController,
  FilePickerFocus,
  registerAuthorityController,
} from '../api/access-lifecycle.ts'
import type { AuthSession } from '../api/auth.ts'

interface AccessValue {
  state: { status: 'loading' | 'ready' | 'unavailable'; session: AuthSession | null }
  can(permission: Permission, scope: Scope): boolean
  identityKey: string | null
  slug: string | null
  generation: number
  refresh(): Promise<void>
  controller: AuthorityController
  safeClient: QueryClient
}
const AccessContext = createContext<AccessValue | null>(null)
const scopeReaders = new WeakMap<AuthorityController, Map<string, number>>()

export function useAccess(): AccessValue {
  const value = useContext(AccessContext)
  if (!value) throw new Error('AccessProvider is required')
  return value
}

/** The router determines the page scope; individual row scopes never change it. */
export function AccessProvider(
  { children, slug: suppliedSlug }: { children: ReactNode; slug?: string | null },
) {
  const location = useLocation()
  const selected = /^\/t\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(location.pathname)?.[1] ?? null
  const slug = suppliedSlug === undefined ? selected : suppliedSlug
  const [controller] = useState(() => new AuthorityController())
  const [safeClient] = useState(() =>
    new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  )
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [
    controller,
  ])
  const snapshot = useCallback(() => controller.context, [controller])
  const context = useSyncExternalStore(subscribe, snapshot)
  const refresh = useCallback(() => controller.refresh(slug ?? undefined), [controller, slug])

  useLayoutEffect(() => registerAuthorityController(controller), [controller])
  useLayoutEffect(() => {
    const clear = () => {
      void safeClient.cancelQueries()
      safeClient.clear()
    }
    const unregister = controller.registerCleanup(clear)
    return () => {
      unregister()
      clear()
    }
  }, [controller, safeClient])
  useLayoutEffect(() => {
    void refresh().catch(() => {})
    return () => controller.invalidate('page scope changed', 'loading')
  }, [controller, refresh])
  useEffect(() => {
    // An observed return withdraws authority until the session is read again. The focus a
    // native file picker hands back just before its change event is not a return: withdrawing
    // then would drop the chosen file, so that one is re-checked without withdrawal.
    const picker = new FilePickerFocus()
    const activated = (event: Event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
        picker.activated(Date.now())
      }
    }
    const blurred = () => picker.blurred(Date.now())
    const revalidate = () => {
      const check = picker.focused() === 'picker'
        ? controller.revalidate(slug ?? undefined)
        : refresh()
      void check.catch(() => {})
    }
    document.addEventListener('click', activated, true)
    globalThis.addEventListener('blur', blurred)
    globalThis.addEventListener('focus', revalidate)
    return () => {
      document.removeEventListener('click', activated, true)
      globalThis.removeEventListener('blur', blurred)
      globalThis.removeEventListener('focus', revalidate)
    }
  }, [controller, refresh, slug])

  const matches = context.slug === slug
  const status = controller.status === 'ready' && !matches ? 'loading' : controller.status
  const session = status === 'ready' ? controller.session : null
  const value: AccessValue = {
    state: { status, session },
    can: (permission, scope) => status === 'ready' && controller.can(permission, scope),
    identityKey: matches ? context.identityKey : null,
    slug,
    generation: context.generation,
    refresh,
    controller,
    safeClient,
  }
  return (
    <AccessContext.Provider value={value}>
      <GenerationQueries key={`${slug}:${context.generation}`} controller={controller}>
        {children}
      </GenerationQueries>
    </AccessContext.Provider>
  )
}

/** Every unchanged legacy query key is isolated by this owned client. */
function GenerationQueries(
  { controller, children }: { controller: AuthorityController; children: ReactNode },
) {
  const [client] = useState(() =>
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
  )
  useLayoutEffect(() => {
    const clear = () => {
      void client.cancelQueries()
      client.clear()
    }
    const unregister = controller.registerCleanup(clear)
    return () => {
      unregister()
      clear()
    }
  }, [client, controller])
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Shared leaf reads are cached by the parent and cannot replace its selected scope. */
export function useScopeAccess(slug: string | null) {
  const parent = useAccess()
  const { controller, generation } = parent
  const [result, setResult] = useState<
    { slug: string; generation: number; session: AuthSession | null } | null
  >(null)
  useEffect(() => {
    if (!slug || parent.state.status !== 'ready') return
    const readers = scopeReaders.get(controller) ?? new Map<string, number>()
    scopeReaders.set(controller, readers)
    readers.set(slug, (readers.get(slug) ?? 0) + 1)
    let active = true
    void controller.readScopeSnapshot(slug).then(
      (session) => {
        if (active) setResult({ slug, generation, session })
      },
      () => {
        if (active) setResult({ slug, generation, session: null })
      },
    )
    return () => {
      active = false
      const remaining = (readers.get(slug) ?? 1) - 1
      if (remaining) readers.set(slug, remaining)
      else {
        readers.delete(slug)
        controller.cancelScopeSnapshot(slug)
      }
    }
  }, [controller, generation, slug, parent.state.status])
  const current =
    result?.generation === generation && result.slug === slug && parent.state.status === 'ready'
      ? result
      : null
  return useMemo(() => ({
    state: current
      ? current.session ? 'ready' as const : 'unavailable' as const
      : 'loading' as const,
    session: current?.session ?? null,
    can: (permission: Permission) =>
      !!current?.session?.portalAccess?.available &&
      current.session.portalAccess.permissions.includes(permission),
  }), [current])
}
