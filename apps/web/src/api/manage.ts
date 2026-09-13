import {
  KbCountersSchema,
  KnowledgeBoxStatusSchema,
  RecentResourceSchema,
} from '@research-portal/core'
import { getAdminCounters, getAdminRecent, getKnowledgeBoxStatus } from './client.ts'
import { type AdminRequestAccess, assertResultCurrent } from './break-glass.ts'
import type { RequestContext } from './access-lifecycle.ts'

export async function getManageStatus(slug: string, context: RequestContext) {
  const value = await getKnowledgeBoxStatus(slug, context)
  assertResultCurrent(value)
  const status = KnowledgeBoxStatusSchema.parse(value)
  if (status.slug !== slug) throw new Error('The connection status is unavailable.')
  return status
}

/** Only mounted content.write sections call this scoped, cancellable read model. */
export async function getManageContent(
  slug: string,
  access: AdminRequestAccess,
  signal: AbortSignal,
) {
  const scoped: AdminRequestAccess = {
    request(input, init) {
      return access.request(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      })
    },
  }
  const [counters, recent] = await Promise.all([
    getAdminCounters(slug, scoped),
    getAdminRecent(slug, scoped),
  ])
  assertResultCurrent(counters)
  assertResultCurrent(recent)
  return {
    counters: KbCountersSchema.parse(counters),
    recent: RecentResourceSchema.array().parse(recent),
  }
}
