import { DatabaseSync } from 'node:sqlite'
import type { RbacDatabase, SqlValue } from './rbac-state.ts'

/** One owned SQLite connection, also suitable for real transactional test fixtures. */
export class LocalRbacDatabase implements RbacDatabase {
  private readonly database: DatabaseSync
  private inTransaction = false

  constructor(path: string) {
    this.database = new DatabaseSync(path)
  }

  exec(query: string, ...bindings: SqlValue[]): void {
    if (bindings.length === 0) this.database.exec(query)
    else this.database.prepare(query).run(...bindings)
  }

  all<T extends object>(query: string, ...bindings: SqlValue[]): T[] {
    return this.database.prepare(query).all(...bindings) as T[]
  }

  transactionSync<T>(callback: () => T): T {
    if (this.inTransaction) throw new Error('Nested RBAC transactions are not supported')
    if (callback.constructor.name === 'AsyncFunction') {
      throw new Error('RBAC transactions must be synchronous')
    }
    this.database.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = callback()
      if (
        result !== null && (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) throw new Error('RBAC transactions must be synchronous')
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  close(): void {
    this.database.close()
  }
}
