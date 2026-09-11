import {
  PLATFORM_ROLES,
  PORTAL_ROLES,
  type Role,
  type Scope,
  ScopeSchema,
} from '@research-portal/core'
import {
  appendAudit,
  type AuditEvent,
  type AuditReadFilter,
  type AuditStore,
  AuditWriteError,
  createAuditEvent,
  validateAuditEvent,
} from './audit.ts'
import { AssignmentService } from './assignments.ts'

/** Shared scalar subset supported by both DatabaseSync and Durable Object SQL. */
export type SqlValue = string | number | null
export interface SqlExecutor {
  exec(query: string, ...bindings: SqlValue[]): void
  all<T extends object>(query: string, ...bindings: SqlValue[]): T[]
}
export interface RbacDatabase extends SqlExecutor {
  /** Synchronous only. Adapters must roll back if the callback or commit fails. */
  transactionSync<T>(callback: () => T): T
}
export interface RoleAssignment {
  id: string
  tenantId: string
  subjectKind: 'active-oid' | 'pending-email' | 'group'
  subjectId: string
  scope: Scope
  role: Role
  emailProvenance: string | null
  createdAt: number
  updatedAt: number
}
export interface AssignmentReader {
  list(tenantId: string): RoleAssignment[]
}
/** Guarded assignment services are constructed internally using the database contract. */
export interface RbacStores {
  audit: AuditStore
  assignments: AssignmentReader
  locks: { lockedUntil(trustedIp: string): number | null }
}

interface AssignmentRow {
  id: string
  tenant_id: string
  subject_kind: RoleAssignment['subjectKind']
  subject_id: string
  scope_kind: Scope['kind']
  scope_slug: string
  role: Role
  email_provenance: string | null
  created_at: number
  updated_at: number
}

// Schema constants come from the core catalogue; no grant policy is duplicated here.
const sqlRoles = (roles: readonly string[]) => roles.map((role) => `'${role}'`).join(',')
const schema = [
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, request_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('anonymous','user','break-glass','legacy-key','system')),
    actor_id TEXT, actor_label TEXT, action TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('platform','portal')), scope_slug TEXT,
    target_kind TEXT NOT NULL, target_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('intent','success','denied','failure','uncertain')),
    detail_json TEXT NOT NULL,
    CHECK((scope_kind = 'platform' AND scope_slug IS NULL) OR
      (scope_kind = 'portal' AND length(scope_slug) > 0)))`,
  'CREATE INDEX IF NOT EXISTS audit_events_by_at ON audit_events(at)',
  'CREATE INDEX IF NOT EXISTS audit_events_by_request ON audit_events(request_id)',
  'CREATE INDEX IF NOT EXISTS audit_events_by_scope ON audit_events(scope_kind,scope_slug,at)',
  `CREATE TABLE IF NOT EXISTS role_assignments (
    id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL CHECK(length(tenant_id) > 0),
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('active-oid','pending-email','group')),
    subject_id TEXT NOT NULL CHECK(length(subject_id) > 0),
    scope_kind TEXT NOT NULL, scope_slug TEXT NOT NULL, role TEXT NOT NULL,
    email_provenance TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id,subject_kind,subject_id,scope_kind,scope_slug),
    CHECK(subject_kind != 'pending-email' OR (subject_id = lower(trim(subject_id)) AND instr(subject_id,'@') > 1)),
    CHECK((scope_kind = 'platform' AND scope_slug = '' AND role IN (${sqlRoles(PLATFORM_ROLES)})) OR
      (scope_kind = 'portal' AND length(scope_slug) > 0 AND role IN (${sqlRoles(PORTAL_ROLES)}))))`,
  'CREATE INDEX IF NOT EXISTS role_assignments_by_email ON role_assignments(tenant_id,email_provenance)',
  `CREATE TABLE IF NOT EXISTS rbac_migrations (
    name TEXT PRIMARY KEY NOT NULL, completed_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rbac_owner_evidence (
    tenant_id TEXT NOT NULL, oid TEXT NOT NULL, roles_json TEXT NOT NULL,
    groups_json TEXT NOT NULL, group_status TEXT NOT NULL,
    claim_iat INTEGER NOT NULL, expires_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,oid))`,
  `CREATE TABLE IF NOT EXISTS rbac_group_capabilities (
    audience TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','verified-supported')),
    verified_at INTEGER,
    CHECK(status = 'disabled' OR verified_at IS NOT NULL))`,
  `CREATE TABLE IF NOT EXISTS break_glass_attempts (
    id TEXT PRIMARY KEY NOT NULL, trusted_ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS break_glass_attempts_by_ip ON break_glass_attempts(trusted_ip,at)',
  `CREATE TABLE IF NOT EXISTS break_glass_locks (
    trusted_ip TEXT PRIMARY KEY NOT NULL, locked_until INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rbac_unknown_roles (
    identifier TEXT PRIMARY KEY NOT NULL CHECK(length(identifier) = 64 AND identifier NOT GLOB '*[^0-9a-f]*'),
    observed_at INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS rbac_unknown_roles_bound BEFORE INSERT ON rbac_unknown_roles
    WHEN (SELECT count(*) FROM rbac_unknown_roles) >= 256
    AND NOT EXISTS (SELECT 1 FROM rbac_unknown_roles WHERE identifier = NEW.identifier)
    BEGIN SELECT RAISE(IGNORE); END`,
]

/** Internal persistence foundation. Guarded services receive the database at construction. */
export class RbacState {
  readonly audit: AuditStore
  readonly assignments: AssignmentReader
  readonly locks: RbacStores['locks']

  /** Internal maintenance only. Purge and its evidence commit or roll back together. */
  retainAudit(
    retentionDays: number,
  ): { cutoff: string; deletedCount: number; retentionDays: number } {
    const now = this.now()
    const cutoffAt = now - retentionDays * 86400_000
    if (
      !Number.isSafeInteger(retentionDays) || retentionDays <= 0 ||
      !Number.isSafeInteger(cutoffAt) || Math.abs(cutoffAt) > 8.64e15
    ) {
      throw new Error('Invalid AUDIT_RETENTION_DAYS cutoff')
    }
    const cutoff = new Date(cutoffAt).toISOString()
    if (!/^\d{4}-/.test(cutoff)) throw new Error('Invalid AUDIT_RETENTION_DAYS cutoff')
    return this.database.transactionSync(() => {
      const deletedCount = this.database.all<{ count: number }>(
        'SELECT count(*) AS count FROM audit_events WHERE at < ?',
        cutoff,
      )[0]!.count
      this.database.exec('DELETE FROM audit_events WHERE at < ?', cutoff)
      const detail = { cutoff, deletedCount, retentionDays }
      appendAudit(
        this.audit,
        createAuditEvent({
          requestId: crypto.randomUUID(),
          actor: { kind: 'system' },
          action: 'audit.retention',
          scope: { kind: 'platform' },
          target: { kind: 'audit' },
          outcome: 'success',
          detail,
        }, () => now),
      )
      return detail
    })
  }

  /** Deployment evidence is configured internally, never by incoming claims. */
  groupCapability(audience: string): 'disabled' | 'verified-supported' {
    const row = this.database.all<{ status: string; verified_at: number | null }>(
      'SELECT status,verified_at FROM rbac_group_capabilities WHERE audience = ?',
      audience,
    )[0]
    return row?.status === 'verified-supported' && Number.isSafeInteger(row.verified_at) &&
        row.verified_at! >= 0 && row.verified_at! <= this.now()
      ? 'verified-supported'
      : 'disabled'
  }

  /** Persist only a SHA-256 identifier, bounded to 256 first observations per database. */
  observeUnknownRole(identifier: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(identifier)) throw new Error('Invalid role identifier')
    return this.database.transactionSync(() => {
      if (
        this.database.all(
          'SELECT identifier FROM rbac_unknown_roles WHERE identifier = ?',
          identifier,
        ).length
      ) return false
      this.database.exec(
        'INSERT OR IGNORE INTO rbac_unknown_roles (identifier,observed_at) VALUES (?,?)',
        identifier,
        this.now(),
      )
      return this.database.all(
        'SELECT identifier FROM rbac_unknown_roles WHERE identifier = ?',
        identifier,
      ).length === 1
    })
  }

  /** Internal factory. The configured tenant and deployment audience come from trusted config. */
  assignmentService(configuredTenantId: string, audience?: string): AssignmentService {
    return new AssignmentService(this.database, this.audit, configuredTenantId, this.now, audience)
  }

  constructor(private readonly database: RbacDatabase, private readonly now = Date.now) {
    this.assignments = Object.freeze({
      list: (tenantId: string): RoleAssignment[] =>
        database.all<AssignmentRow>(
          'SELECT * FROM role_assignments WHERE tenant_id = ? ORDER BY id',
          tenantId,
        ).map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          scope: row.scope_kind === 'platform'
            ? { kind: 'platform' }
            : { kind: 'portal', slug: row.scope_slug },
          role: row.role,
          emailProvenance: row.email_provenance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
    })
    this.locks = Object.freeze({
      lockedUntil: (trustedIp: string): number | null =>
        database.all<{ locked_until: number }>(
          'SELECT locked_until FROM break_glass_locks WHERE trusted_ip = ?',
          trustedIp,
        )[0]?.locked_until ?? null,
    })
    this.audit = Object.freeze({
      append: (event: AuditEvent): void => {
        try {
          validateAuditEvent(event)
          database.exec(
            `INSERT INTO audit_events (
              id,at,request_id,actor_kind,actor_id,actor_label,action,scope_kind,
              scope_slug,target_kind,target_id,outcome,detail_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            event.id,
            event.at,
            event.request_id,
            event.actor_kind,
            event.actor_id,
            event.actor_label,
            event.action,
            event.scope_kind,
            event.scope_slug,
            event.target_kind,
            event.target_id,
            event.outcome,
            event.detail_json,
          )
        } catch {
          throw new AuditWriteError()
        }
      },
      read: (filter: AuditReadFilter): AuditEvent[] => {
        const scope = ScopeSchema.parse(filter.scope)
        const limit = filter.limit ?? 100
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error('Invalid audit limit')
        }
        const clauses: string[] = []
        const bindings: SqlValue[] = []
        if (scope.kind === 'portal') {
          clauses.push("scope_kind = 'portal' AND scope_slug = ?")
          bindings.push(scope.slug)
        }
        if (filter.requestId !== undefined) {
          clauses.push('request_id = ?')
          bindings.push(filter.requestId)
        }
        if (filter.before !== undefined) {
          if (new Date(filter.before).toISOString() !== filter.before) {
            throw new Error('Invalid audit time')
          }
          clauses.push('at < ?')
          bindings.push(filter.before)
        }
        return database.all<AuditEvent>(
          `SELECT * FROM audit_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY at DESC,id DESC LIMIT ?`,
          ...bindings,
          limit,
        )
      },
    })
  }

  migrate(): void {
    this.database.transactionSync(() => {
      for (const query of schema) this.database.exec(query)
      this.database.exec(
        'INSERT OR IGNORE INTO rbac_migrations (name,completed_at) VALUES (?,?)',
        'rbac-schema-v1',
        this.now(),
      )
    })
  }
}
