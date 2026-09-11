import {
  type EffectiveRoles,
  EffectiveRolesSchema,
  PLATFORM_ROLES,
  type PlatformRole,
  PORTAL_ROLES,
  type PortalRole,
  type Role,
  RoleSchema,
  type Scope,
  ScopeSchema,
} from '@research-portal/core'
import { appendAudit, type AuditActor, type AuditStore, createAuditEvent } from './audit.ts'
import { type RbacDatabase, RbacState, type RoleAssignment } from './rbac-state.ts'

/** Internal verified-session facts only. Shape validation does not verify an HTTP identity. */
export interface VerifiedAssignmentSession {
  verified: true
  tenantId: string
  oid: string
  email?: string
  preferredUsername?: string
  roles: string[]
  groups: string[]
  groupStatus: 'complete' | 'absent' | 'malformed' | 'overage' | 'unverified'
  /** Original claim and session times in milliseconds, never the renewed envelope iat. */
  claimIssuedAt: number
  expiresAt: number
}
export interface AssignmentContext {
  requestId: string
  actor: AuditActor
}
export type AssignmentInput = Pick<RoleAssignment, 'subjectKind' | 'subjectId' | 'scope' | 'role'>
export type AssignmentResult<T = RoleAssignment> =
  | { ok: true; value: T }
  | { ok: false; code: 'last_owner' | 'email_conflict' | 'invalid_input' | 'invalid_principal' }

interface OwnerEvidence {
  oid: string
  roles_json: string
  groups_json: string
  group_status: string
  claim_iat: number
  expires_at: number
}
const claimLifetime = 8 * 60 * 60 * 1000
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(value)
const email = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalised = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised) && normalised.length <= 254
    ? normalised
    : null
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 1024 &&
  value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
const sameScope = (a: RoleAssignment['scope'], b: RoleAssignment['scope']) =>
  a.kind === b.kind && (a.kind === 'platform' || (b.kind === 'portal' && a.slug === b.slug))

export interface RoleResolutionStores {
  rbac: Pick<RbacState, 'assignments' | 'groupCapability' | 'observeUnknownRole'>
  tenants: { list(includeDisabled?: boolean): { slug: string }[] }
  audience: string
  /** Receives only a bounded SHA-256 identifier, never the raw claim. */
  logUnknownRole?: (identifier: string) => void
}
export interface RoleProvenance {
  source: 'app-role' | 'group' | 'local'
  scope: Scope
  role: Role
}
export interface RoleResolution {
  effectiveRoles: EffectiveRoles
  provenance: RoleProvenance[]
  groupCapability: 'enabled' | 'disabled' | VerifiedAssignmentSession['groupStatus']
}

/** Resolve only verified internal facts. Current assignment reads deliberately have no cache. */
export async function resolveEffectiveRoles(
  session: VerifiedAssignmentSession | null,
  stores: RoleResolutionStores,
  configuredTenantId: string,
  now = Date.now(),
): Promise<RoleResolution> {
  const result: RoleResolution = {
    effectiveRoles: { portalRoles: [] },
    provenance: [],
    groupCapability: 'unverified',
  }
  if (
    !session || session.verified !== true || !identifier(configuredTenantId) ||
    session.tenantId !== configuredTenantId || !identifier(session.oid) ||
    !strings(session.roles) ||
    !Number.isSafeInteger(now) || !Number.isSafeInteger(session.claimIssuedAt) ||
    !Number.isSafeInteger(session.expiresAt) || session.claimIssuedAt < 0 ||
    session.claimIssuedAt > now + 30_000 || session.expiresAt <= session.claimIssuedAt ||
    Math.min(session.expiresAt, session.claimIssuedAt + claimLifetime) <= now
  ) return result

  const groupsValid = strings(session.groups) && session.groups.every(identifier)
  result.groupCapability = stores.rbac.groupCapability(stores.audience) !== 'verified-supported'
    ? 'disabled'
    : !groupsValid
    ? 'malformed'
    : session.groupStatus === 'complete'
    ? 'enabled'
    : ['absent', 'malformed', 'overage', 'unverified'].includes(session.groupStatus)
    ? session.groupStatus
    : 'unverified'
  const grant = (source: RoleProvenance['source'], scope: Scope, role: Role) => {
    result.provenance.push({ source, scope, role })
    if (scope.kind === 'platform') {
      const next = role as PlatformRole
      const current = result.effectiveRoles.platformRole
      if (!current || PLATFORM_ROLES.indexOf(next) > PLATFORM_ROLES.indexOf(current)) {
        result.effectiveRoles.platformRole = next
      }
    } else {
      const next = role as PortalRole
      const current = result.effectiveRoles.portalRoles.find((r) => r.slug === scope.slug)
      if (!current) result.effectiveRoles.portalRoles.push({ slug: scope.slug, role: next })
      else if (PORTAL_ROLES.indexOf(next) > PORTAL_ROLES.indexOf(current.role)) current.role = next
    }
  }
  for (const role of [...new Set(session.roles)].sort()) {
    if (role === 'CorpusKit.Owner') grant('app-role', { kind: 'platform' }, 'owner')
    else if (role === 'CorpusKit.PlatformAdmin' || role === 'CorpusKit.Admin') {
      grant('app-role', { kind: 'platform' }, 'platform-admin')
    } else {
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(role)),
      )
      const id = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
      if (stores.rbac.observeUnknownRole(id)) {
        ;(stores.logUnknownRole ?? ((id) => console.warn('Unknown app role ignored', id)))(id)
      }
    }
  }
  const rows = stores.rbac.assignments.list(configuredTenantId)
  for (const source of ['group', 'local'] as const) {
    for (const row of rows) {
      if (row.tenantId !== configuredTenantId) continue
      const matches = source === 'group'
        ? result.groupCapability === 'enabled' && row.subjectKind === 'group' &&
          session.groups.includes(row.subjectId)
        : row.subjectKind === 'active-oid' && row.subjectId === session.oid
      const scope = ScopeSchema.safeParse(row.scope)
      const role = RoleSchema.safeParse(row.role)
      if (!matches || !scope.success || !role.success) continue
      const domain: readonly string[] = scope.data.kind === 'platform'
        ? PLATFORM_ROLES
        : PORTAL_ROLES
      if (domain.includes(role.data)) grant(source, scope.data, role.data)
    }
  }
  if (result.effectiveRoles.platformRole) {
    for (const portal of stores.tenants.list(true)) {
      if (!identifier(portal.slug)) continue
      const existing = result.effectiveRoles.portalRoles.find((r) => r.slug === portal.slug)
      if (existing) existing.role = 'portal-admin'
      else result.effectiveRoles.portalRoles.push({ slug: portal.slug, role: 'portal-admin' })
    }
  }
  result.effectiveRoles.portalRoles.sort((a, b) => a.slug.localeCompare(b.slug))
  return result
}

/** Phase 2 compatibility gate: portal-only authority never unlocks global administration. */
export function coarseAdminEligibility(roles: unknown): boolean {
  const parsed = EffectiveRolesSchema.safeParse(roles)
  return parsed.success && parsed.data.platformRole !== undefined
}

/**
 * Internal assignment mutations. Callers own permission checks; this boundary always enforces
 * tenant identity, binding invariants, last-owner protection and mandatory atomic audit writes.
 */
export class AssignmentService {
  private readonly state: RbacState

  constructor(
    private readonly database: RbacDatabase,
    private readonly audit: AuditStore,
    private readonly configuredTenantId: string,
    private readonly now: () => number = Date.now,
    private readonly audience?: string,
  ) {
    if (!identifier(configuredTenantId)) throw new Error('Configured tenant is required')
    this.state = new RbacState(database, now)
  }

  list(): RoleAssignment[] {
    return this.state.assignments.list(this.configuredTenantId)
  }

  private input(input: AssignmentInput): AssignmentInput | null {
    const scope = ScopeSchema.safeParse(input.scope)
    const role = RoleSchema.safeParse(input.role)
    if (!scope.success || !role.success) return null
    if (scope.data.kind === 'portal' && !identifier(scope.data.slug)) return null
    const validRole = scope.data.kind === 'platform'
      ? (PLATFORM_ROLES as readonly string[]).includes(role.data)
      : (PORTAL_ROLES as readonly string[]).includes(role.data)
    if (!validRole || !['active-oid', 'pending-email', 'group'].includes(input.subjectKind)) {
      return null
    }
    const subjectId = input.subjectKind === 'pending-email'
      ? email(input.subjectId)
      : input.subjectId
    if (!subjectId || (input.subjectKind !== 'pending-email' && !identifier(subjectId))) return null
    return { subjectKind: input.subjectKind, subjectId, scope: scope.data, role: role.data }
  }

  private record(
    context: AssignmentContext,
    action: 'assignment.create' | 'assignment.update' | 'assignment.delete' | 'assignment.activate',
    row: RoleAssignment,
    previousRole?: RoleAssignment['role'],
  ): void {
    appendAudit(
      this.audit,
      createAuditEvent({
        ...context,
        action,
        scope: row.scope,
        target: { kind: 'assignment', id: row.id },
        outcome: 'success',
        detail: { role: row.role, previousRole, subjectKind: row.subjectKind },
      }, this.now),
    )
  }

  private denied<T>(
    context: AssignmentContext,
    code: Extract<AssignmentResult, { ok: false }>['code'],
    row?: RoleAssignment,
  ): AssignmentResult<T> {
    appendAudit(
      this.audit,
      createAuditEvent({
        ...context,
        action: 'assignment.denied',
        scope: row?.scope ?? { kind: 'platform' },
        target: { kind: 'assignment', ...(row ? { id: row.id } : {}) },
        outcome: 'denied',
        detail: { code },
      }, this.now),
    )
    // Return inside the transaction so the refusal event commits.
    return { ok: false, code }
  }

  private insert(row: RoleAssignment): void {
    this.database.exec(
      `INSERT INTO role_assignments
      (id,tenant_id,subject_kind,subject_id,scope_kind,scope_slug,role,email_provenance,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.tenantId,
      row.subjectKind,
      row.subjectId,
      row.scope.kind,
      row.scope.kind === 'portal' ? row.scope.slug : '',
      row.role,
      row.emailProvenance,
      row.createdAt,
      row.updatedAt,
    )
  }

  create(input: AssignmentInput, context: AssignmentContext): AssignmentResult {
    return this.database.transactionSync(() => {
      const valid = this.input(input)
      if (!valid) return this.denied(context, 'invalid_input')
      if (
        this.list().some((row) =>
          row.subjectKind === valid.subjectKind && row.subjectId === valid.subjectId &&
          sameScope(row.scope, valid.scope)
        )
      ) {
        return this.denied(context, 'invalid_input')
      }
      const row: RoleAssignment = {
        ...valid,
        id: crypto.randomUUID(),
        tenantId: this.configuredTenantId,
        emailProvenance: valid.subjectKind === 'pending-email' ? valid.subjectId : null,
        createdAt: this.now(),
        updatedAt: this.now(),
      }
      this.insert(row)
      this.record(context, 'assignment.create', row)
      return { ok: true, value: row }
    })
  }

  change(
    id: string,
    patch: Partial<AssignmentInput>,
    context: AssignmentContext,
  ): AssignmentResult {
    return this.mutate(id, patch, context)
  }

  remove(id: string, context: AssignmentContext): AssignmentResult {
    return this.mutate(id, null, context)
  }

  private mutate(
    id: string,
    patch: Partial<AssignmentInput> | null,
    context: AssignmentContext,
  ): AssignmentResult {
    return this.database.transactionSync(() => {
      const rows = this.list()
      const previous = rows.find((row) => row.id === id)
      if (!previous) return this.denied(context, 'invalid_input')
      const valid = patch === null ? null : this.input({ ...previous, ...patch })
      if (patch !== null && !valid) return this.denied(context, 'invalid_input', previous)
      if (
        valid && previous.emailProvenance && previous.subjectKind === 'active-oid' &&
        (valid.subjectKind !== previous.subjectKind || valid.subjectId !== previous.subjectId)
      ) {
        return this.denied(context, 'email_conflict', previous)
      }
      const next = valid
        ? {
          ...previous,
          ...valid,
          updatedAt: this.now(),
          emailProvenance: valid.subjectKind === 'pending-email'
            ? valid.subjectId
            : previous.emailProvenance,
        }
        : null
      const remaining = rows.filter((row) => row.id !== id)
      if (
        next &&
        remaining.some((row) =>
          row.subjectKind === next.subjectKind && row.subjectId === next.subjectId &&
          sameScope(row.scope, next.scope)
        )
      ) {
        return this.denied(context, 'invalid_input', previous)
      }
      if (next) remaining.push(next)
      if (
        previous.role === 'owner' && previous.subjectKind !== 'pending-email' &&
        this.owners(remaining).size === 0
      ) {
        return this.denied(context, 'last_owner', previous)
      }
      this.database.exec(
        'DELETE FROM role_assignments WHERE id = ? AND tenant_id = ?',
        id,
        this.configuredTenantId,
      )
      if (next) this.insert(next)
      this.record(
        context,
        next ? 'assignment.update' : 'assignment.delete',
        next ?? previous,
        previous.role,
      )
      return { ok: true, value: next ?? previous }
    })
  }

  private validSession(session: VerifiedAssignmentSession): boolean {
    return session.verified === true && session.tenantId === this.configuredTenantId &&
      identifier(session.oid) && strings(session.roles) && strings(session.groups) &&
      ['complete', 'absent', 'malformed', 'overage', 'unverified'].includes(session.groupStatus) &&
      Number.isSafeInteger(session.claimIssuedAt) && Number.isSafeInteger(session.expiresAt) &&
      session.claimIssuedAt <= this.now() + 30_000 && session.claimIssuedAt >= 0 &&
      session.expiresAt > session.claimIssuedAt
  }

  private fresh(session: VerifiedAssignmentSession): boolean {
    return this.validSession(session) &&
      Math.min(session.expiresAt, session.claimIssuedAt + claimLifetime) > this.now()
  }

  /** Supplied only after cryptographic verification by trusted ingress, never from request JSON. */
  observeSession(session: VerifiedAssignmentSession): boolean {
    return this.database.transactionSync(() => this.observe(session))
  }

  private observe(session: VerifiedAssignmentSession): boolean {
    if (!this.validSession(session)) return false
    const old = this.database.all<OwnerEvidence>(
      'SELECT * FROM rbac_owner_evidence WHERE tenant_id = ? AND oid = ?',
      this.configuredTenantId,
      session.oid,
    )[0]
    if (old && old.claim_iat > session.claimIssuedAt) return false
    // Equal issuance times cannot restore a claim contradicted by another verified observation.
    const roles = old?.claim_iat === session.claimIssuedAt
      ? session.roles.filter((role) => (JSON.parse(old.roles_json) as string[]).includes(role))
      : session.roles
    const groups = old?.claim_iat === session.claimIssuedAt
      ? session.groups.filter((group) => (JSON.parse(old.groups_json) as string[]).includes(group))
      : session.groups
    const status = old?.claim_iat === session.claimIssuedAt && old.group_status !== 'complete'
      ? old.group_status
      : session.groupStatus
    const expires = Math.min(
      session.expiresAt,
      session.claimIssuedAt + claimLifetime,
      old?.claim_iat === session.claimIssuedAt ? old.expires_at : Infinity,
    )
    this.database.exec(
      `INSERT INTO rbac_owner_evidence
      (tenant_id,oid,roles_json,groups_json,group_status,claim_iat,expires_at,observed_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,oid) DO UPDATE SET
      roles_json=excluded.roles_json,groups_json=excluded.groups_json,group_status=excluded.group_status,
      claim_iat=excluded.claim_iat,expires_at=excluded.expires_at,observed_at=excluded.observed_at`,
      this.configuredTenantId,
      session.oid,
      JSON.stringify(roles),
      JSON.stringify(groups),
      status,
      session.claimIssuedAt,
      expires,
      this.now(),
    )
    return true
  }

  private owners(rows: RoleAssignment[]): Set<string> {
    const owners = new Set(
      rows.filter((row) => row.subjectKind === 'active-oid' && row.role === 'owner').map((row) =>
        row.subjectId
      ),
    )
    const groupSupport = this.audience !== undefined &&
      this.state.groupCapability(this.audience) === 'verified-supported'
    const groups = new Set(
      rows.filter((row) => row.subjectKind === 'group' && row.role === 'owner').map((row) =>
        row.subjectId
      ),
    )
    for (
      const evidence of this.database.all<OwnerEvidence>(
        'SELECT * FROM rbac_owner_evidence WHERE tenant_id = ? AND expires_at > ? AND claim_iat <= ? AND claim_iat > ?',
        this.configuredTenantId,
        this.now(),
        this.now() + 30_000,
        this.now() - claimLifetime,
      )
    ) {
      const roles: unknown = JSON.parse(evidence.roles_json)
      const claims: unknown = JSON.parse(evidence.groups_json)
      if (!strings(roles) || !strings(claims)) continue
      if (
        roles.includes('CorpusKit.Owner') ||
        (groupSupport && evidence.group_status === 'complete' &&
          claims.some((group) => groups.has(group)))
      ) owners.add(evidence.oid)
    }
    return owners
  }

  activate(
    session: VerifiedAssignmentSession,
    context: AssignmentContext,
  ): AssignmentResult<RoleAssignment[]> {
    return this.database.transactionSync(() => {
      if (!this.observe(session)) return this.denied(context, 'invalid_principal')
      if (!this.fresh(session)) return this.denied(context, 'invalid_principal')
      const emails = new Set(
        [email(session.email), email(session.preferredUsername)].filter((value): value is string =>
          value !== null
        ),
      )
      const rows = this.list()
      const pending = rows.filter((row) =>
        row.subjectKind === 'pending-email' && emails.has(row.subjectId)
      )
      const active = rows.filter((row) => row.subjectKind === 'active-oid')
      const plannedScopes = new Set<string>()
      for (const row of pending) {
        const scopeKey = JSON.stringify(row.scope)
        if (
          plannedScopes.has(scopeKey) ||
          active.some((other) =>
            (other.emailProvenance === row.subjectId && other.subjectId !== session.oid) ||
            (other.subjectId === session.oid && sameScope(other.scope, row.scope))
          )
        ) return this.denied(context, 'email_conflict', row)
        plannedScopes.add(scopeKey)
      }
      const activated: RoleAssignment[] = []
      for (const row of pending) {
        const next: RoleAssignment = {
          ...row,
          subjectKind: 'active-oid',
          subjectId: session.oid,
          emailProvenance: row.subjectId,
          updatedAt: this.now(),
        }
        this.database.exec(
          `UPDATE role_assignments SET subject_kind = 'active-oid', subject_id = ?,
          email_provenance = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
          next.subjectId,
          next.emailProvenance,
          next.updatedAt,
          next.id,
          this.configuredTenantId,
        )
        this.record(context, 'assignment.activate', next)
        activated.push(next)
      }
      return { ok: true, value: activated }
    })
  }

  /** Internal first-boot migration, never an HTTP-callable system actor. */
  bootstrapAdminEmails(raw: string): { created: number; alreadyCompleted: boolean } {
    return this.database.transactionSync(() => {
      const marker = `admin-emails-v1:${this.configuredTenantId}`
      if (this.database.all('SELECT name FROM rbac_migrations WHERE name = ?', marker).length) {
        return { created: 0, alreadyCompleted: true }
      }
      const emails = [
        ...new Set(
          raw.split(',').map((value) => email(value)).filter((value): value is string =>
            value !== null
          ),
        ),
      ]
      const rows = this.list()
      let created = 0
      for (const subjectId of emails) {
        if (
          rows.some((row) =>
            (row.subjectKind === 'pending-email' && row.subjectId === subjectId &&
              row.scope.kind === 'platform') ||
            (row.subjectKind === 'active-oid' && row.emailProvenance === subjectId)
          )
        ) continue
        this.insert({
          id: crypto.randomUUID(),
          tenantId: this.configuredTenantId,
          subjectKind: 'pending-email',
          subjectId,
          scope: { kind: 'platform' },
          role: 'owner',
          emailProvenance: subjectId,
          createdAt: this.now(),
          updatedAt: this.now(),
        })
        created++
      }
      this.database.exec(
        'INSERT INTO rbac_migrations (name,completed_at) VALUES (?,?)',
        marker,
        this.now(),
      )
      appendAudit(
        this.audit,
        createAuditEvent({
          requestId: crypto.randomUUID(),
          actor: { kind: 'system' },
          action: 'migration.admin_emails',
          scope: { kind: 'platform' },
          target: { kind: 'migration' },
          outcome: 'success',
          detail: { count: created },
        }, this.now),
      )
      return { created, alreadyCompleted: false }
    })
  }
}
