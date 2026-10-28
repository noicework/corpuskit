import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type RbacDatabase, RbacState, type SqlValue } from './rbac-state.ts'

/** App and scheduler share this single persistent RBAC connection. */
export function openLocalRbac(env: Record<string, string | undefined>) {
  const path = env.RBAC_PATH ?? join(env.DATA_DIR ?? './data', 'rbac.sqlite')
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const database = new LocalRbacDatabase(path)
  try {
    const rbac = new RbacState(database)
    rbac.migrate()
    return { database, rbac }
  } catch (error) {
    database.close()
    throw error
  }
}

/** One owned SQLite connection, also suitable for real transactional test fixtures. */
export class LocalRbacDatabase implements RbacDatabase {
  private readonly database: DatabaseSync
  private inTransaction = false

  constructor(path: string) {
    this.database = new DatabaseSync(path)
    try {
      const mode = this.all<{ journal_mode: string }>('PRAGMA journal_mode')[0]?.journal_mode
      if (mode === 'wal') {
        throw new Error(
          'Local SQLite uses WAL; stop all writers and convert to journal_mode=DELETE',
        )
      }
      // Rollback journals work on network filesystems with functioning POSIX locks. WAL does not.
      this.database.exec(
        'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000',
      )
    } catch (error) {
      this.database.close()
      throw error
    }
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
