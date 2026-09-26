import { appendAudit, type AuditActor, type AuditStore, createAuditEvent } from './audit.ts'
import type { BindingStoreApi } from './bindings.ts'
import type { EnrichmentStoreApi } from './enrichments.ts'
import {
  emptyErasedCounts,
  ERASED_RECORD_KINDS,
  type ErasedCounts,
  type ErasedRecordKind,
} from './erased-records.ts'
import type { SuggestionStoreApi } from './interrogate.ts'
import type { KgProposalStoreApi } from './kg.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import type { RbacState } from './rbac-state.ts'
import type {
  InsightsStoreApi,
  InvestigationStoreApi,
  McpKeyStoreApi,
  RoutingLogApi,
  SessionsStoreApi,
  SourceStoreApi,
  WatchStoreApi,
} from './stores.ts'
import type { TenantStoreApi } from './tenants.ts'

export { ERASED_RECORD_KINDS, type ErasedCounts, type ErasedRecordKind }

/**
 * Every store that keeps records under a portal's slug, each able to erase them. Erasure is
 * reached only through this set, so a store added to it is erased by construction, and the
 * inventory tests fail when a store keyed by slug is left out.
 */
export interface PortalErasureStores {
  tenants: Pick<TenantStoreApi, 'erase'>
  bindings: Pick<BindingStoreApi, 'status' | 'remove'>
  lifecycle: Pick<PortalLifecycleStore, 'erase'>
  sessions: Pick<SessionsStoreApi, 'erase'>
  investigations: Pick<InvestigationStoreApi, 'erase'>
  watches: Pick<WatchStoreApi, 'erase'>
  sources: Pick<SourceStoreApi, 'erase'>
  insights: Pick<InsightsStoreApi, 'erase'>
  suggestions: Pick<SuggestionStoreApi, 'erase'>
  enrichments: Pick<EnrichmentStoreApi, 'erase'>
  kgProposals: Pick<KgProposalStoreApi, 'erase'>
  branding: { erase(slug: string): number }
  routing: Pick<RoutingLogApi, 'erase'>
  mcpKeys: Pick<McpKeyStoreApi, 'erase'>
  /** Role assignments and the audit log; absent in an embedded app without access control. */
  rbac?: Pick<RbacState, 'erasePortalRecords' | 'transaction'>
  audit: Pick<AuditStore, 'append'>
}

export interface PortalErasureContext {
  requestId: string
  actor: AuditActor
  now?: () => number
}

export interface PortalErasureResult {
  slug: string
  /** Stored records removed, for each kind in `ERASED_RECORD_KINDS`. */
  erased: ErasedCounts
  total: number
}

/**
 * Runs the whole erasure as one atomic unit where the runtime can: the Durable Object passes its
 * SQLite transaction, so every record and the erasure's audit line commit or roll back together.
 * Without it, file stores are erased first and the audit log and its line then commit together;
 * a failed erasure is completed by calling it again.
 */
export type ErasureTransaction = <T>(slug: string, work: () => T) => T

const AUDIT_FIELDS: Record<ErasedRecordKind, string> = {
  configuration: 'erasedConfiguration',
  aliases: 'erasedAliases',
  bindings: 'erasedBindings',
  lifecycle: 'erasedLifecycle',
  sessions: 'erasedSessions',
  investigations: 'erasedInvestigations',
  watches: 'erasedWatches',
  sources: 'erasedSources',
  insights: 'erasedInsights',
  suggestions: 'erasedSuggestions',
  enrichments: 'erasedEnrichments',
  kgProposals: 'erasedKgProposals',
  branding: 'erasedBranding',
  routing: 'erasedRouting',
  mcpKeys: 'erasedMcpKeys',
  assignments: 'erasedAssignments',
  auditEvents: 'erasedAuditEvents',
}

/** The audit detail of an erasure: its counts, never what was erased. */
export function erasureAuditDetail(erased: ErasedCounts, total: number): Record<string, unknown> {
  return {
    permission: 'portal.create',
    count: total,
    ...Object.fromEntries(ERASED_RECORD_KINDS.map((kind) => [AUDIT_FIELDS[kind], erased[kind]])),
  }
}

/**
 * Permanently delete every record stored under the slug of a portal that has been deleted, then
 * record one `portal.erase` audit line naming the actor and the slug with the counts. The retired
 * slug itself stays, so the slug is never reused. Running it again erases nothing more.
 *
 * The caller checks that the slug is retired and serves no portal; the stores refuse a live
 * portal's registry entry as a last line of defence.
 */
export function erasePortal(
  stores: PortalErasureStores,
  slug: string,
  context: PortalErasureContext,
  transaction?: ErasureTransaction,
): PortalErasureResult {
  const run = () => {
    const erased = emptyErasedCounts()
    const registry = stores.tenants.erase(slug)
    erased.configuration = registry.configuration
    erased.aliases = registry.aliases
    // The binding store caches its records, so its own removal is the only safe path.
    const binding = stores.bindings.status(slug).status
    if (binding === 'connected' || binding === 'unavailable') {
      stores.bindings.remove(slug)
      erased.bindings = 1
    }
    erased.lifecycle = stores.lifecycle.erase(slug)
    erased.sessions = stores.sessions.erase(slug)
    erased.investigations = stores.investigations.erase(slug)
    erased.watches = stores.watches.erase(slug)
    erased.sources = stores.sources.erase(slug)
    erased.insights = stores.insights.erase(slug)
    erased.suggestions = stores.suggestions.erase(slug)
    erased.enrichments = stores.enrichments.erase(slug)
    erased.kgProposals = stores.kgProposals.erase(slug)
    erased.branding = stores.branding.erase(slug)
    erased.routing = stores.routing.erase(slug)
    erased.mcpKeys = stores.mcpKeys.erase(slug)
    const record = () => {
      if (stores.rbac) {
        Object.assign(erased, stores.rbac.erasePortalRecords(slug, context.requestId))
      }
      const total = ERASED_RECORD_KINDS.reduce((sum, kind) => sum + erased[kind], 0)
      appendAudit(
        stores.audit,
        createAuditEvent({
          requestId: context.requestId,
          actor: context.actor,
          action: 'portal.erase',
          scope: { kind: 'platform' },
          target: { kind: 'portal', id: slug },
          outcome: 'success',
          detail: erasureAuditDetail(erased, total),
        }, context.now),
      )
      return { slug, erased, total }
    }
    if (transaction || !stores.rbac) return record()
    return stores.rbac.transaction(record)
  }
  return transaction ? transaction(slug, run) : run()
}

export const MAX_OPERATOR_DELETE_AFTER_DAYS = 36_500

/**
 * `OPERATOR_DELETE_AFTER_DAYS`: how many days a portal must stay suspended before a platform
 * administrator or the operator credential may delete it. A whole number from 1 to 36500; unset,
 * empty or anything else turns operator deletion off.
 */
export function operatorDeleteAfterDays(value: string | undefined): number | null {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d{1,5}$/.test(trimmed)) return null
  const days = Number(trimmed)
  return days >= 1 && days <= MAX_OPERATOR_DELETE_AFTER_DAYS ? days : null
}

/** One start-up warning when the setting is present but unusable. Never includes the value. */
export function operatorDeleteWarning(env: Record<string, string | undefined>): string | null {
  const value = env.OPERATOR_DELETE_AFTER_DAYS
  if (value === undefined || value.trim() === '' || operatorDeleteAfterDays(value) !== null) {
    return null
  }
  return 'OPERATOR_DELETE_AFTER_DAYS is not a whole number of days from 1 to ' +
    `${MAX_OPERATOR_DELETE_AFTER_DAYS}; operator deletion of suspended portals is off`
}
