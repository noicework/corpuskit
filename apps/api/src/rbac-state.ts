import { PLATFORM_ROLES, PORTAL_ROLES, type Role, type Scope } from '@research-portal/core'
import {
  appendAudit,
  type AuditEvent,
  AuditQueryError,
  type AuditQueryFilters,
  type AuditReadFilter,
  type AuditStore,
  AuditWriteError,
  canonicalAuditFilters,
  canonicalAuditScope,
  createAuditEvent,
  validateAuditEvent,
  validateAuditReadFilter,
} from './audit.ts'
import { AssignmentService, type GrantClaims } from './assignments.ts'
import { type BreakGlassPolicy, BreakGlassService } from './break-glass.ts'

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
/** Persisted, previously verified identity. Expired claims do not erase identity provenance. */
export interface CreatorEvidence extends GrantClaims {
  tenantId: string
  oid: string
  claimIssuedAt: number
  expiresAt: number
  observedAt: number
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
const auditSchema = (table: 'audit_events' | 'audit_events_v2') =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, request_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('anonymous','user','break-glass','key','legacy-key','system')),
    actor_id TEXT, actor_label TEXT, action TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('platform','portal')), scope_slug TEXT,
    target_kind TEXT NOT NULL, target_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('intent','success','denied','failure','uncertain')),
    detail_json TEXT NOT NULL,
    CHECK((scope_kind = 'platform' AND scope_slug IS NULL) OR
      (scope_kind = 'portal' AND length(scope_slug) > 0)))`
const auditIndexes = [
  'CREATE INDEX IF NOT EXISTS audit_events_by_at ON audit_events(at)',
  'CREATE INDEX IF NOT EXISTS audit_events_by_request ON audit_events(request_id)',
  'CREATE INDEX IF NOT EXISTS audit_events_by_scope ON audit_events(scope_kind,scope_slug,at)',
]
const schema = [
  auditSchema('audit_events'),
  ...auditIndexes,
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

export interface AuditSnapshot {
  id: string
  watermark: number
  expiresAt: string
}

interface SnapshotRow {
  id: string
  watermark: number
  scope_json: string
  filters_json: string
  created_at: number
  expires_at: number
}

/** Internal persistence foundation. Guarded services receive the database at construction. */
export class RbacState {
  readonly audit: AuditStore
  readonly assignments: AssignmentReader
  readonly locks: RbacStores['locks']

  /** Internal bookkeeping under an already-authorised request, never a system HTTP actor. */
  createAuditSnapshot(scope: Scope, filters: AuditQueryFilters): AuditSnapshot {
    const scopeJson = JSON.stringify(canonicalAuditScope(scope))
    const filtersJson = JSON.stringify(canonicalAuditFilters(filters))
    return this.database.transactionSync(() => {
      const now = this.now()
      this.database.exec('DELETE FROM audit_query_snapshots WHERE expires_at <= ?', now)
      const count =
        this.database.all<{ n: number }>('SELECT count(*) AS n FROM audit_query_snapshots')[0]!.n
      if (count >= 128) throw new AuditQueryError('snapshot_limit')
      // sqlite_sequence retains the committed high watermark even after all events are purged.
      const watermark = this.database.all<{ seq: number }>(
        "SELECT seq FROM sqlite_sequence WHERE name = 'audit_event_order'",
      )[0]?.seq ?? 0
      const id = crypto.randomUUID()
      const expires = now + 15 * 60_000
      this.database.exec(
        'INSERT INTO audit_query_snapshots (id,watermark,scope_json,filters_json,created_at,expires_at) VALUES (?,?,?,?,?,?)',
        id,
        watermark,
        scopeJson,
        filtersJson,
        now,
        expires,
      )
      return { id, watermark, expiresAt: new Date(expires).toISOString() }
    })
  }

  loadAuditSnapshot(id: string, scope: Scope, filters: AuditQueryFilters): AuditSnapshot {
    const scopeJson = JSON.stringify(canonicalAuditScope(scope))
    const filtersJson = JSON.stringify(canonicalAuditFilters(filters))
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new AuditQueryError('invalid_audit_query')
    }
    const row =
      this.database.all<SnapshotRow>('SELECT * FROM audit_query_snapshots WHERE id = ?', id)[0]
    if (!row || row.expires_at <= this.now()) throw new AuditQueryError('snapshot_expired')
    if (row.scope_json !== scopeJson || row.filters_json !== filtersJson) {
      throw new AuditQueryError('snapshot_mismatch')
    }
    if (
      !Number.isSafeInteger(row.watermark) || row.watermark < 0 ||
      !Number.isSafeInteger(row.created_at) || row.expires_at !== row.created_at + 15 * 60_000
    ) throw new AuditQueryError('invalid_audit_query')
    return {
      id: row.id,
      watermark: row.watermark,
      expiresAt: new Date(row.expires_at).toISOString(),
    }
  }

  /** Internal read only. No HTTP fields or assignment row can create verified provenance. */
  creatorEvidence(tenantId: string, oid: string): CreatorEvidence | null {
    const identifier = (value: unknown): value is string =>
      typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(value)
    if (!identifier(tenantId) || !identifier(oid)) return null
    const row = this.database.all<{
      tenant_id: string
      oid: string
      roles_json: string
      groups_json: string
      group_status: string
      claim_iat: number
      expires_at: number
      observed_at: number
    }>('SELECT * FROM rbac_owner_evidence WHERE tenant_id = ? AND oid = ?', tenantId, oid)[0]
    if (!row) return null
    try {
      const roles: unknown = JSON.parse(row.roles_json)
      const groups: unknown = JSON.parse(row.groups_json)
      if (
        row.tenant_id !== tenantId || row.oid !== oid ||
        !Array.isArray(roles) || roles.length > 1024 ||
        !roles.every((role) => typeof role === 'string' && role.length > 0 && role.length <= 256) ||
        !Array.isArray(groups) || groups.length > 1024 || !groups.every(identifier) ||
        !['complete', 'absent', 'malformed', 'overage', 'unverified'].includes(row.group_status) ||
        ![row.claim_iat, row.expires_at, row.observed_at].every((time) =>
          Number.isSafeInteger(time) && time >= 0
        ) ||
        row.claim_iat > row.observed_at + 30_000 || row.observed_at > this.now() ||
        row.expires_at <= row.claim_iat || row.expires_at > row.claim_iat + 28_800_000
      ) return null
      return {
        tenantId,
        oid,
        roles,
        groups,
        groupStatus: row.group_status as GrantClaims['groupStatus'],
        claimIssuedAt: row.claim_iat,
        expiresAt: row.expires_at,
        observedAt: row.observed_at,
      }
    } catch {
      return null
    }
  }

  breakGlassService(policy: BreakGlassPolicy): BreakGlassService {
    return new BreakGlassService(this.database, this.audit, policy, this.now)
  }

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
      this.database.exec(
        'DELETE FROM audit_event_order WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE audit_events.id = audit_event_order.event_id)',
      )
      this.database.exec('DELETE FROM audit_query_snapshots WHERE expires_at <= ?', now)
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
        validateAuditReadFilter(filter)
        const scope = filter.scope
        const limit = filter.limit ?? 100
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
          clauses.push('at < ?')
          bindings.push(filter.before)
        }
        for (
          const [field, column] of [['actorKind', 'actor_kind'], ['actorId', 'actor_id'], [
            'action',
            'action',
          ], ['outcome', 'outcome']] as const
        ) {
          if (filter[field] !== undefined) {
            clauses.push(`${column} = ?`)
            bindings.push(filter[field])
          }
        }
        if (filter.from !== undefined) {
          clauses.push('at >= ?')
          bindings.push(filter.from)
        }
        if (filter.to !== undefined) {
          clauses.push('at <= ?')
          bindings.push(filter.to)
        }
        if (filter.snapshotSequence !== undefined) {
          clauses.push('sequence <= ?')
          bindings.push(filter.snapshotSequence)
        }
        if (filter.cursor !== undefined) {
          clauses.push('(at < ? OR (at = ? AND id < ?))')
          bindings.push(filter.cursor.at, filter.cursor.at, filter.cursor.id)
        }
        return database.all<AuditEvent>(
          `SELECT audit_events.* FROM audit_events JOIN audit_event_order ON event_id = audit_events.id ${
            clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
          }
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
      const marker = 'rbac-audit-actors-v2'
      if (!this.database.all('SELECT name FROM rbac_migrations WHERE name = ?', marker).length) {
        this.database.exec(auditSchema('audit_events_v2'))
        const columns =
          'id,at,request_id,actor_kind,actor_id,actor_label,action,scope_kind,scope_slug,target_kind,target_id,outcome,detail_json'
        this.database.exec(
          `INSERT INTO audit_events_v2 (${columns}) SELECT ${columns} FROM audit_events`,
        )
        this.database.exec('DROP TABLE audit_events')
        this.database.exec('ALTER TABLE audit_events_v2 RENAME TO audit_events')
        for (const query of auditIndexes) this.database.exec(query)
        this.database.exec(
          'INSERT INTO rbac_migrations (name,completed_at) VALUES (?,?)',
          marker,
          this.now(),
        )
      }
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS audit_event_order (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE)',
      )
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS audit_query_snapshots (id TEXT PRIMARY KEY NOT NULL, watermark INTEGER NOT NULL, scope_json TEXT NOT NULL, filters_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
      )
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS audit_snapshots_by_expiry ON audit_query_snapshots(expires_at)',
      )
      this.database.exec(
        'CREATE TRIGGER IF NOT EXISTS audit_event_insert_order AFTER INSERT ON audit_events BEGIN INSERT INTO audit_event_order (event_id) VALUES (NEW.id); END',
      )
      const orderMarker = 'rbac-audit-order-v1'
      if (
        !this.database.all('SELECT name FROM rbac_migrations WHERE name = ?', orderMarker).length
      ) {
        this.database.exec(
          'INSERT INTO audit_event_order (event_id) SELECT id FROM audit_events WHERE NOT EXISTS (SELECT 1 FROM audit_event_order WHERE event_id = audit_events.id) ORDER BY at,id',
        )
        this.database.exec(
          'INSERT INTO rbac_migrations (name,completed_at) VALUES (?,?)',
          orderMarker,
          this.now(),
        )
      }
      this.database.exec(
        'INSERT OR IGNORE INTO rbac_migrations (name,completed_at) VALUES (?,?)',
        'rbac-schema-v1',
        this.now(),
      )
    })
  }
}
