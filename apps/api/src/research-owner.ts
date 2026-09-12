/** Exact identifiers with explicit provenance. Storage must not coerce this to a shared string. */
export type ResearchOwner =
  | { kind: 'user'; tenantId: string; oid: string }
  | { kind: 'anonymous'; clientId: string }

/** Bound the complete local path as well as individual filesystem components. */
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512) {
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
  if (new TextEncoder().encode(value).length > 512) throw new Error('Research identifier too long')
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
