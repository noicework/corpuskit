import { PORTAL_ROLES, type PortalRole, PortalRoleSchema } from '@research-portal/core'
import { z } from 'zod'
import { type CreatorAuthorityStores, resolveCreatorAuthority } from './creator-authority.ts'
import { constantTimeHashEqual } from './mcp.ts'
import { validSessionFacts } from './principal.ts'
import {
  KeyPortalSlugSchema,
  KeyTimeSchema,
  type ScopedKeyRecord,
  ScopedKeyRecordSchema,
  type ScopedKeyStore,
} from './scoped-key-record.ts'

export interface ScopedKeyDependencies {
  keys: ScopedKeyStore
  creatorStores: CreatorAuthorityStores
  configuredTenantId: string
  now?: () => number
}
export interface VerifiedScopedKey {
  kind: 'key'
  id: string
  slug: string
  role: PortalRole
  actor: { kind: 'key'; id: string }
}
export type ScopedKeyStatus =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'unproven_creator'
  | 'creator_no_access'
export type ScopedKeySummary = Omit<ScopedKeyRecord, 'hash'> & {
  status: ScopedKeyStatus
  effectiveRole: PortalRole | null
}
export class ScopedKeyError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'forbidden' | 'key_limit' | 'collision' | 'already_committed',
  ) {
    super(code)
    this.name = 'ScopedKeyError'
  }
}
const inputSchema = z.object({
  slug: KeyPortalSlugSchema,
  label: z.string().trim().min(1).max(80),
  role: PortalRoleSchema,
  expiresAt: KeyTimeSchema.optional(),
}).strict()
const tokenPattern = /^ck_[A-Za-z0-9_-]{43}$/
const legacyPattern = /^ck_mcp_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/
const clock = (deps: ScopedKeyDependencies) => (deps.now ?? Date.now)()
const boundedRole = (stored: PortalRole, current: PortalRole) =>
  PORTAL_ROLES[Math.min(PORTAL_ROLES.indexOf(stored), PORTAL_ROLES.indexOf(current))]!

async function hashToken(token: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
  )
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}
async function status(
  record: ScopedKeyRecord,
  deps: ScopedKeyDependencies,
): Promise<{ status: ScopedKeyStatus; effectiveRole: PortalRole | null }> {
  if (record.revokedAt) return { status: 'revoked', effectiveRole: null }
  if (record.expiresAt && Date.parse(record.expiresAt) <= clock(deps)) {
    return { status: 'expired', effectiveRole: null }
  }
  if (!record.creator || record.provenance !== 'verified-session') {
    return { status: 'unproven_creator', effectiveRole: null }
  }
  const authority = await resolveCreatorAuthority(
    { ...record.creator, slug: record.tenant },
    deps.creatorStores,
    deps.configuredTenantId,
    clock(deps),
  )
  return {
    status: authority.reason,
    effectiveRole: authority.role ? boundedRole(record.role, authority.role) : null,
  }
}

/** Async preparation never mutates. The caller invokes commit inside its audited mutation scope. */
export async function issueScopedKey(
  input: unknown,
  trustedSession: unknown,
  deps: ScopedKeyDependencies,
) {
  const parsed = inputSchema.safeParse(input)
  const now = clock(deps)
  if (!parsed.success || (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= now)) {
    throw new ScopedKeyError('invalid_input')
  }
  if (
    !validSessionFacts(trustedSession, now) || trustedSession.tenantId !== deps.configuredTenantId
  ) throw new ScopedKeyError('forbidden')
  const { slug, label, role, expiresAt } = parsed.data
  const creator = { tenantId: trustedSession.tenantId, oid: trustedSession.oid }
  // Refuse stale preparations if authority changed while crypto or caller work was awaiting.
  const authoritySnapshot = () =>
    JSON.stringify({
      evidence: deps.creatorStores.rbac.creatorEvidence(creator.tenantId, creator.oid),
      assignments: deps.creatorStores.rbac.assignments.list(creator.tenantId),
      groups: deps.creatorStores.rbac.groupCapability(deps.creatorStores.audience),
    })
  const snapshot = authoritySnapshot()
  const originalEvidence = deps.creatorStores.rbac.creatorEvidence(creator.tenantId, creator.oid)
  const authority = await resolveCreatorAuthority(
    { ...creator, slug },
    deps.creatorStores,
    deps.configuredTenantId,
    now,
  )
  if (
    !authority.proven || !authority.role ||
    PORTAL_ROLES.indexOf(role) > PORTAL_ROLES.indexOf(authority.role)
  ) throw new ScopedKeyError('forbidden')
  const checkLimit = () => {
    if (deps.keys.list(slug).filter((record) => !record.revokedAt).length >= 20) {
      throw new ScopedKeyError('key_limit')
    }
  }
  checkLimit()
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const key = `ck_${
      btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }`
    const record = ScopedKeyRecordSchema.parse({
      v: 1,
      id: crypto.randomUUID(),
      tenant: slug,
      issuerUserId: creator.oid,
      label,
      prefix: key.slice(0, 15),
      hash: await hashToken(key),
      createdAt: new Date(now).toISOString(),
      revokedAt: null,
      role,
      expiresAt: expiresAt ?? null,
      creator,
      provenance: 'verified-session',
    })
    const collides = () =>
      deps.keys.list(slug).some((row) =>
        row.id === record.id || row.prefix === record.prefix ||
        constantTimeHashEqual(row.hash, record.hash)
      )
    if (collides()) continue
    const { hash: _hash, ...metadata } = record
    let committed = false
    return {
      key,
      credential: { ...metadata, status: 'active' as const, effectiveRole: role },
      commit: () => {
        if (committed) throw new ScopedKeyError('already_committed')
        checkLimit()
        if (collides()) throw new ScopedKeyError('collision')
        if (
          snapshot !== authoritySnapshot() ||
          (originalEvidence && now < originalEvidence.expiresAt &&
            clock(deps) >= originalEvidence.expiresAt)
        ) throw new ScopedKeyError('forbidden')
        if (
          !validSessionFacts(trustedSession, clock(deps)) ||
          (record.expiresAt && Date.parse(record.expiresAt) <= clock(deps))
        ) throw new ScopedKeyError('forbidden')
        deps.keys.add(record)
        committed = true
      },
    }
  }
  throw new ScopedKeyError('collision')
}

/** No public or session fallback. Legacy tokens need independently verified persisted provenance. */
export async function verifyScopedKey(
  token: string,
  slug: string,
  deps: ScopedKeyDependencies,
): Promise<VerifiedScopedKey | null> {
  if (
    !KeyPortalSlugSchema.safeParse(slug).success ||
    (!tokenPattern.test(token) && !legacyPattern.test(token))
  ) return null
  const hash = await hashToken(token)
  const raw = deps.keys.findByHash(slug, hash)
  const parsed = ScopedKeyRecordSchema.safeParse(raw)
  const matches = constantTimeHashEqual(parsed.success ? parsed.data.hash : '0'.repeat(64), hash)
  if (!parsed.success || !matches || parsed.data.tenant !== slug) return null
  const record = parsed.data
  const current = await status(record, deps)
  if (!current.effectiveRole || current.status !== 'active') return null
  return {
    kind: 'key',
    id: record.id,
    slug,
    role: current.effectiveRole,
    actor: { kind: 'key', id: record.id },
  }
}

export async function inspectScopedKeys(
  slug: string,
  deps: ScopedKeyDependencies,
): Promise<ScopedKeySummary[]> {
  KeyPortalSlugSchema.parse(slug)
  return await Promise.all(
    deps.keys.list(slug).map(async (raw) => {
      const record = ScopedKeyRecordSchema.parse(raw)
      if (record.tenant !== slug) throw new ScopedKeyError('forbidden')
      const { hash: _hash, ...metadata } = record
      return { ...metadata, ...await status(record, deps) }
    }),
  )
}
