import { authorize, type EvaluationSchedule, normalisePrincipal } from '@research-portal/core'
import type { Hono } from 'hono'
import type { PortalRequestContext } from './app.ts'
import { resolveRoleGrants } from './assignments.ts'
import { executeAudited, type LocalMutationScope } from './audit-execution.ts'
import type { EvaluationStore } from './evaluation-store.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import type { RbacState } from './rbac-state.ts'
import type { TenantStoreApi } from './tenants.ts'

const runners = new WeakMap<Hono, () => Promise<void>>()
export function registerScheduledEvaluations(app: Hono, run: () => Promise<void>): void {
  runners.set(app, run)
}
/** Called by the managed cron and the local daily maintenance timer, never by a public route. */
export async function runScheduledEvaluations(app: Hono): Promise<void> {
  await runners.get(app)?.()
}

export interface ScheduleServices {
  store?: EvaluationStore
  rbac?: RbacState
  lifecycle: PortalLifecycleStore
  tenants: TenantStoreApi
  configuredTenantId: string
  audience: string
  externalLoginEnabled?: boolean
  localMutations?: LocalMutationScope
  now?: () => number
  dispatch(context: PortalRequestContext, path: string, init: RequestInit): Promise<Response>
}

/** A saved schedule delegates only current local assignments, never stale directory claims. */
export async function scheduledAuthority(
  services: Omit<ScheduleServices, 'dispatch'>,
  owner: EvaluationSchedule['owner'],
  slug: string,
): Promise<PortalRequestContext | null> {
  if (
    !services.rbac || (owner.tenantId !== services.configuredTenantId &&
      !(owner.tenantId === 'external' && services.externalLoginEnabled))
  ) return null
  const config = services.tenants.get(slug)
  if (
    !config || services.tenants.isDisabled(slug) || services.lifecycle.get(slug).status !== 'active'
  ) return null
  const resolution = await resolveRoleGrants(owner, null, {
    rbac: services.rbac,
    audience: services.audience,
    externalLoginEnabled: services.externalLoginEnabled,
    assignmentTenantId: services.configuredTenantId,
  })
  const principal = normalisePrincipal({ kind: 'user', ...owner }, resolution.effectiveRoles, {
    slug,
    accessMode: config.accessMode,
    configuredTenantId: services.configuredTenantId,
  })
  if (!authorize(principal, 'behaviour.write', { kind: 'portal', slug })) return null
  const at = services.now?.() ?? Date.now()
  // Private execution envelope for the persisted delegation. No sign-in cookie is minted and
  // no directory roles, groups, email or credentials are persisted or replayed.
  return {
    requestId: crypto.randomUUID(),
    coarseAdminEligible: !!resolution.effectiveRoles.platformRole,
    ...resolution,
    session: {
      ...owner,
      verified: true,
      roles: [],
      groups: [],
      groupStatus: 'absent',
      ...(owner.tenantId === 'external' ? { provenance: 'external' as const } : {}),
      claimIssuedAt: at,
      createdAt: at,
      expiresAt: at + 120_000,
    },
  }
}

export async function evaluateDueSchedules(services: ScheduleServices): Promise<void> {
  const { store, rbac } = services
  if (!store || !rbac) return
  const at = services.now?.() ?? Date.now()
  let admitted = 0
  for (const schedule of store.schedules().sort((a, b) => a.nextAt - b.nextAt)) {
    // Each run has a 100-second budget. Bound one daily pass on the managed runtime and
    // take the oldest due work first, so a busy portal cannot starve the other portals.
    if (admitted >= 3) break
    if (schedule.nextAt > at) continue
    const set = store.get(schedule.slug, schedule.setId)
    // Changes to a definition require fresh ask-cost consent. A pause or lost grant spends none.
    if (
      !set || set.updatedAt !== schedule.updatedAt ||
      set.questions.length !== schedule.confirmedAsks
    ) continue
    const context = await scheduledAuthority(services, schedule.owner, schedule.slug)
    if (!context) continue
    admitted++
    await executeAudited({
      audit: rbac.audit,
      localMutations: services.localMutations,
      input: {
        requestId: context.requestId,
        actor: { kind: 'system' },
        action: 'maintenance.evaluation.run',
        scope: { kind: 'portal', slug: schedule.slug },
        target: { kind: 'evaluation', id: schedule.setId },
        detail: { permission: 'behaviour.write' },
      },
      classify: (ok) => ok ? 'success' : 'failure',
      run: async (signal) => {
        if (!store.claimSchedule(schedule.slug, schedule.setId, at)) return true
        const response = await services.dispatch(
          context,
          `/api/admin/t/${encodeURIComponent(schedule.slug)}/evaluations/${
            encodeURIComponent(set.id)
          }/runs`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              confirmedAsks: schedule.confirmedAsks,
              updatedAt: schedule.updatedAt,
            }),
          },
        )
        const run = await response.json() as { status?: string }
        return response.ok && run.status === 'completed'
      },
    })
  }
}
