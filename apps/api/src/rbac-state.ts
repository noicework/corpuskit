import type { Role, Scope } from '@research-portal/core'
import type { AuditStore } from './audit.ts'

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
