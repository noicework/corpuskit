import type { Watch } from './stores.ts'

/** Exact identifiers with explicit provenance. Storage must not coerce this to a shared string. */
export type ResearchOwner =
  | { kind: 'user'; tenantId: string; oid: string }
  | { kind: 'anonymous'; clientId: string }

/** Bound the complete local path as well as individual filesystem components. */
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 128) {
    throw new Error('Invalid research identifier')
  }
  // TextEncoder replaces unpaired surrogates, which would collapse distinct identities.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid research Unicode')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Invalid research Unicode')
  }
  if (new TextEncoder().encode(value).length > 128) throw new Error('Research identifier too long')
  // Bound JSON escape expansion too, keeping the complete filesystem path representable.
  if (new TextEncoder().encode(JSON.stringify(value)).length > 130) {
    throw new Error('Research identifier too long')
  }
  return value
}

/** Strings are transitional anonymous callers, never evidence of signed ownership. */
export function researchOwnerValue(value: unknown): ResearchOwner {
  if (typeof value === 'string') return { kind: 'anonymous', clientId: identifier(value) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid research owner')
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'anonymous' && Object.keys(record).sort().join() === 'clientId,kind') {
    return { kind: 'anonymous', clientId: identifier(record.clientId) }
  }
  if (record.kind === 'user' && Object.keys(record).sort().join() === 'kind,oid,tenantId') {
    return { kind: 'user', tenantId: identifier(record.tenantId), oid: identifier(record.oid) }
  }
  throw new Error('Invalid research owner')
}

function encodeTuple(tuple: readonly (string | number)[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(tuple))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  )
}

export function encodeResearchOwner(input: ResearchOwner | string): string {
  const owner = researchOwnerValue(input)
  return encodeTuple(
    owner.kind === 'user'
      ? [2, 'user', owner.tenantId, owner.oid]
      : [2, 'anonymous', owner.clientId],
  )
}

export function equalResearchOwner(a: ResearchOwner | string, b: ResearchOwner | string): boolean {
  return encodeResearchOwner(a) === encodeResearchOwner(b)
}

export function encodeStorageIdentifier(value: string): string {
  return encodeTuple([2, identifier(value)])
}

/** Splitting is reversible. The terminal marker separates variable-length path fields. */
export function storageIdentifierPath(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid encoded identifier')
  return encoded.match(/.{1,120}/g)!.join('/') + '/_'
}

export interface OwnedRecord<T> {
  v: 2
  slug: string
  owner: ResearchOwner
  payload: T
}

export function ownedRecord<T>(
  slug: string,
  owner: ResearchOwner | string,
  payload: T,
): OwnedRecord<T> {
  encodeStorageIdentifier(slug)
  return { v: 2, slug, owner: researchOwnerValue(owner), payload }
}

/** Persisted metadata must be typed; transitional string compatibility is input-only. */
export function readOwnedRecord<T extends { id: string }>(
  value: unknown,
  slug: string,
  owner: ResearchOwner | string,
  id?: string,
): T {
  const record = value as OwnedRecord<T> | null
  if (
    !record || Object.keys(record).sort().join() !== 'owner,payload,slug,v' ||
    record.v !== 2 || record.slug !== slug || typeof record.owner !== 'object' ||
    !equalResearchOwner(record.owner, owner) || !record.payload ||
    typeof record.payload !== 'object' ||
    (id !== undefined && record.payload.id !== id)
  ) throw new Error('Invalid owned record')
  encodeStorageIdentifier(record.payload.id)
  return record.payload
}

/** Never infer an original identity or portal from a sanitised historical key. */
export const LEGACY_OWNER_DIAGNOSTIC = {
  provenance: 'anonymous-only',
  unresolved: 'missing-raw-owner-or-portal-evidence',
} as const

/** Legacy rows need independent raw portal evidence as well as their recorded client ID. */
export function legacyWatchOwner(value: unknown, slug: string): ResearchOwner | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row.slug !== slug || 'owner' in row || typeof row.clientId !== 'string') return undefined
  try {
    return researchOwnerValue(row.clientId)
  } catch {
    return undefined
  }
}

export function watchOwner(value: { clientId: string; owner?: ResearchOwner }): ResearchOwner {
  if (!value.owner || typeof value.owner !== 'object') throw new Error('Invalid watch owner')
  const owner = researchOwnerValue(value.owner)
  if (value.clientId !== (owner.kind === 'anonymous' ? owner.clientId : owner.oid)) {
    throw new Error('Invalid watch provenance')
  }
  return owner
}

export function decodeWatchCollection(value: unknown, slug: string): Watch[] {
  const record = value as { v: number; slug: string; entries: Watch[] } | null
  if (
    !record || record.v !== 2 || record.slug !== slug || !Array.isArray(record.entries) ||
    Object.keys(record).sort().join() !== 'entries,slug,v'
  ) throw new Error('Invalid watch collection')
  const ids = new Set<string>()
  for (const watch of record.entries) {
    watchOwner(watch)
    encodeStorageIdentifier(watch.id)
    if (ids.has(watch.id)) throw new Error('Duplicate watch identifier')
    ids.add(watch.id)
  }
  return record.entries
}

export function decodeLegacyWatches(value: unknown, slug: string): Watch[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Invalid legacy watch collection')
  const proven = value.flatMap((row) => {
    const owner = legacyWatchOwner(row, slug)
    return owner ? [{ ...row, owner } as Watch] : []
  })
  return decodeWatchCollection({ v: 2, slug, entries: proven }, slug)
}
