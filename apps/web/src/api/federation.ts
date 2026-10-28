import { FederationPeerSchema } from '@research-portal/core'
import { z } from 'zod'
import { request } from './client.ts'
import { assertResultCurrent } from './break-glass.ts'
import type { RequestContext } from './access-lifecycle.ts'
import type { PeerDraft } from '../lib/federation-peers.ts'

const snapshotSchema = z.object({
  participates: z.boolean(),
  agentAsk: z.boolean(),
  supportedKinds: z.string().array(),
  peers: z.object({ keySet: z.boolean() }).passthrough().transform(({ keySet, ...peer }) => ({
    ...FederationPeerSchema.parse(peer),
    keySet,
  })).array(),
})
export type FederationSnapshot = z.infer<typeof snapshotSchema>
const base = (slug: string) => `/api/admin/t/${encodeURIComponent(slug)}`
export async function getFederation(slug: string, context: RequestContext) {
  const value = await request(`${base(slug)}/federation`, { cache: 'no-store' }, context)
  assertResultCurrent(value)
  return snapshotSchema.parse(value)
}
export async function getFederationDocuments(slug: string, context: RequestContext) {
  const value = await request(`${base(slug)}/federation/documents`, { cache: 'no-store' }, context)
  assertResultCurrent(value)
  return z.object({
    items: z.object({ id: z.string(), title: z.string(), excluded: z.boolean() }).array(),
    writable: z.boolean(),
  }).parse(value)
}
async function change(path: string, method: string, body: unknown, context: RequestContext) {
  const value = await request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, context)
  assertResultCurrent(value)
  z.object({ ok: z.literal(true) }).parse(value)
}
export function updateFederation(
  slug: string,
  body: { agentAsk?: boolean; federation?: { participates?: boolean; peers?: PeerDraft[] } },
  context: RequestContext,
) {
  return change(`/api/admin/tenants/${encodeURIComponent(slug)}`, 'PATCH', body, context)
}
export function setPeerKey(slug: string, id: string, token: string, context: RequestContext) {
  return change(
    `${base(slug)}/federation/peers/${encodeURIComponent(id)}/key`,
    'PUT',
    { token },
    context,
  )
}
export function setFederationExclusion(
  slug: string,
  id: string,
  excluded: boolean,
  context: RequestContext,
) {
  return change(`${base(slug)}/resources/${encodeURIComponent(id)}/federation-exclusion`, 'PUT', {
    excluded,
  }, context)
}
