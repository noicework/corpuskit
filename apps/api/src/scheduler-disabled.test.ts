import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import type { TenantStoreApi } from './tenants.ts'
import type { SourceStoreApi, WatchStoreApi } from './stores.ts'
import type { EnrichmentStoreApi } from './enrichments.ts'
import type { RbacState } from './rbac-state.ts'
import { startScheduler } from './scheduler.ts'

Deno.test('local scheduler opt-out registers no timers while the default retains all three', () => {
  const timeout = globalThis.setTimeout
  const interval = globalThis.setInterval
  let timers = 0
  const register = (() => {
    timers++
    return 0
  }) as unknown as typeof setTimeout
  globalThis.setTimeout = register
  globalThis.setInterval = register
  const start = (env: Record<string, string | undefined>) =>
    startScheduler(
      {} as AragProvider,
      {} as TenantStoreApi,
      {} as SourceStoreApi,
      {} as WatchStoreApi,
      {} as EnrichmentStoreApi,
      {} as RbacState,
      env,
    )
  try {
    start({ LOCAL_SCHEDULER_ENABLED: 'false' })()
    expect(timers).toBe(0)
    start({})()
    expect(timers).toBe(3)
  } finally {
    globalThis.setTimeout = timeout
    globalThis.setInterval = interval
  }
})
