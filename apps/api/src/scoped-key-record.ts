import { PortalRoleSchema } from '@research-portal/core'
import { z } from 'zod'

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/)
// Keep local filenames and Durable keys collision-free without lossy sanitisation.
export const KeyPortalSlugSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export const KeyTimeSchema = z.string().refine((value) => {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}, 'Expected a canonical UTC timestamp')

const legacyShape = {
  id: identifier,
  tenant: KeyPortalSlugSchema,
  issuerUserId: identifier,
  label: z.string().min(1).max(80).refine((value) =>
    [...value].every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  ),
  prefix: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: KeyTimeSchema,
  revokedAt: KeyTimeSchema.nullable(),
}
const LegacyMcpKeyRecordSchema = z.object(legacyShape).strict()

/** Historical input shape retained until all minting callers use scoped metadata. */
export type LegacyMcpKeyRecord = z.infer<typeof LegacyMcpKeyRecordSchema>

export const ScopedKeyRecordSchema = z.object({
  ...legacyShape,
  v: z.literal(1),
  role: PortalRoleSchema,
  expiresAt: KeyTimeSchema.nullable(),
  creator: z.object({ tenantId: identifier, oid: identifier }).strict().nullable(),
  provenance: z.enum(['verified-session', 'legacy-unproven']),
}).strict().refine(
  (record) =>
    record.provenance === 'verified-session'
      ? record.creator !== null
      : record.creator === null && record.role === 'viewer' && record.expiresAt === null,
  'Inconsistent key provenance',
)

export type ScopedKeyRecord = z.infer<typeof ScopedKeyRecordSchema>

/** Decode, never infer identity from the historical issuer string. No input is mutated. */
export function migrateLegacyKeyRecord(value: unknown): ScopedKeyRecord {
  if (value !== null && typeof value === 'object' && 'v' in value) {
    return ScopedKeyRecordSchema.parse(value)
  }
  return ScopedKeyRecordSchema.parse({
    ...LegacyMcpKeyRecordSchema.parse(value),
    v: 1,
    role: 'viewer',
    expiresAt: null,
    creator: null,
    provenance: 'legacy-unproven',
  })
}

/** Reject the entire unavailable store rather than silently dropping corrupt authority. */
export function decodeScopedKeyRecords(value: unknown, slug: string): ScopedKeyRecord[] {
  KeyPortalSlugSchema.parse(slug)
  if (!Array.isArray(value)) throw new Error('Invalid persisted key records')
  const records = value.map(migrateLegacyKeyRecord)
  const ids = new Set<string>()
  const prefixes = new Set<string>()
  const hashes = new Set<string>()
  for (const record of records) {
    if (
      record.tenant !== slug || ids.has(record.id) || prefixes.has(record.prefix) ||
      hashes.has(record.hash)
    ) throw new Error('Invalid or duplicate persisted key record')
    ids.add(record.id)
    prefixes.add(record.prefix)
    hashes.add(record.hash)
  }
  return records
}

/** Explicit staged contract shared by both runtimes, with no optional authority methods. */
export interface ScopedKeyStore {
  list(slug: string): ScopedKeyRecord[]
  findByHash(slug: string, hash: string): ScopedKeyRecord | undefined
  findByPrefix(slug: string, prefix: string): ScopedKeyRecord | undefined
  add(record: LegacyMcpKeyRecord | ScopedKeyRecord): void
  revoke(slug: string, id: string, at: string): boolean
}
