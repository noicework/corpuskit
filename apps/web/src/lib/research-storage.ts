import type { AuthorityContext, AuthorityController } from '../api/access-lifecycle.ts'

export interface ResearchStorageContext {
  readonly slug: string
  readonly identityKey: string | null
  readonly generation: number
  readonly anonymousPublic: boolean
  readonly clientId: string | null
}
export interface CurrentInvestigation {
  id: string
  name: string
}
const contexts = new WeakMap<
  ResearchStorageContext,
  { controller: AuthorityController; authority: AuthorityContext }
>()
const currentReferences = new WeakMap<AuthorityContext, Map<string, CurrentInvestigation | null>>()

export function createResearchStorageContext(
  controller: AuthorityController,
  slug: string,
): ResearchStorageContext {
  const authority = controller.context
  let clientId: string | null = null
  try {
    clientId = localStorage.getItem('rp-client-id')
  } catch { /* Storage is optional. */ }
  const context = Object.freeze({
    slug,
    identityKey: authority.identityKey,
    generation: authority.generation,
    anonymousPublic: !controller.session?.authenticated &&
      controller.can('portal.read', { kind: 'portal', slug }) &&
      authority.identityKey === JSON.stringify(['anonymous', clientId]),
    clientId,
  })
  contexts.set(context, { controller, authority })
  return context
}

export function researchStorageCurrent(context: ResearchStorageContext): boolean {
  const owner = contexts.get(context)
  return !!owner && owner.controller.status === 'ready' &&
    owner.controller.context === owner.authority && owner.authority.slug === context.slug
}

function read(context: ResearchStorageContext, kind: 'chat' | 'current-investigation'): unknown {
  if (!researchStorageCurrent(context) || !context.anonymousPublic) return null
  try {
    const raw = localStorage.getItem(key(context, kind)) ??
      localStorage.getItem(`rp-${kind}-${context.slug}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function key(context: ResearchStorageContext, kind: string): string {
  return `rp-research-v1:${encodeURIComponent(context.slug)}:anonymous:${
    encodeURIComponent(context.clientId!)
  }:${kind}`
}
function write(context: ResearchStorageContext, kind: string, value: unknown): void {
  if (!researchStorageCurrent(context) || !context.anonymousPublic) return
  try {
    localStorage.setItem(key(context, kind), JSON.stringify(value))
  } catch { /* Ephemeral when unavailable. */ }
}
export function readResearchDraft(context: ResearchStorageContext): unknown[] {
  const value = read(context, 'chat')
  return Array.isArray(value) ? value : []
}
export function writeResearchDraft(context: ResearchStorageContext, value: unknown[]): void {
  write(context, 'chat', value)
}
export function readCurrentInvestigation(
  context: ResearchStorageContext,
): CurrentInvestigation | null {
  if (!researchStorageCurrent(context)) return null
  const authority = contexts.get(context)!.authority
  const memory = currentReferences.get(authority)
  const value = memory?.has(context.slug)
    ? memory.get(context.slug)
    : read(context, 'current-investigation')
  if (
    !value || typeof value !== 'object' || !('id' in value) || !('name' in value) ||
    typeof value.id !== 'string' || typeof value.name !== 'string'
  ) return null
  return { id: value.id, name: value.name }
}
export function writeCurrentInvestigation(
  context: ResearchStorageContext,
  value: CurrentInvestigation | null,
): void {
  if (!researchStorageCurrent(context)) return
  const authority = contexts.get(context)!.authority
  const memory = currentReferences.get(authority) ?? new Map()
  memory.set(context.slug, value)
  currentReferences.set(authority, memory)
  write(context, 'current-investigation', value)
}
/** Discard sensitive memory synchronously; durable anonymous history remains its owner's. */
export function registerResearchCleanup(
  context: ResearchStorageContext,
  cleanup: () => void,
): () => void {
  const owner = contexts.get(context)!
  return owner.controller.registerCleanup(() => {
    currentReferences.delete(owner.authority)
    cleanup()
  })
}
