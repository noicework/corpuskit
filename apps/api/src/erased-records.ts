/**
 * The kinds of record a portal erasure removes, in the order they are reported. Each is counted
 * in stored records: rows, files or keys. A store that keeps a collection in one record counts
 * one, so the same data can count differently on the Durable Object and on the local server.
 */
export const ERASED_RECORD_KINDS = [
  /** The portal's configuration, override and disabled flag in the portal registry. */
  'configuration',
  'aliases',
  /** The knowledge box binding: its endpoint and sealed service account token. */
  'bindings',
  /** Hosting status and limits, ask counts, the capacity ledger and the suspension record. */
  'lifecycle',
  'sessions',
  'investigations',
  'watches',
  'sources',
  'insights',
  'suggestions',
  /** Generated enrichments and cached suggested questions. */
  'enrichments',
  'kgProposals',
  /** Uploaded logo, hero image and fonts. */
  'branding',
  'routing',
  /** Data key records, including revoked ones. */
  'mcpKeys',
  /** Member rows, pending email invitations and group mappings. */
  'assignments',
  'auditEvents',
] as const

export type ErasedRecordKind = typeof ERASED_RECORD_KINDS[number]
export type ErasedCounts = Record<ErasedRecordKind, number>

export function emptyErasedCounts(): ErasedCounts {
  return Object.fromEntries(ERASED_RECORD_KINDS.map((kind) => [kind, 0])) as ErasedCounts
}
