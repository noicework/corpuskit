import {
  PLATFORM_ROLES,
  PORTAL_ROLES,
  type Role,
  type Scope,
  ScopeSchema,
} from '@research-portal/core'
import {
  type AuditEvent,
  type AuditReadFilter,
  type AuditStore,
  AuditWriteError,
  validateAuditEvent,
} from './audit.ts'

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

  constructor(private readonly database: RbacDatabase, private readonly now = Date.now) {
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
