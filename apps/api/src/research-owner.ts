/** Exact identifiers with explicit provenance. Storage must not coerce this to a shared string. */
export type ResearchOwner =
  | { kind: 'user'; tenantId: string; oid: string }
  | { kind: 'anonymous'; clientId: string }
