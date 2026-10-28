import type { LinkCheck, LinkHealthStoreApi } from './link-health.ts'
import type { RbacDatabase } from './rbac-state.ts'
import type { OwnedMutationBoundary } from './stores.ts'

/** Local admin state shares the runtime's DATA_DIR SQLite connection and audit transaction. */
export class LinkHealthStore implements LinkHealthStoreApi {
  private readonly transient = new Map<string, LinkCheck[]>()
  constructor(
    private readonly database?: RbacDatabase,
    private readonly boundary?: OwnedMutationBoundary,
  ) {
    database?.exec(
      'CREATE TABLE IF NOT EXISTS link_health (slug TEXT PRIMARY KEY, payload TEXT NOT NULL)',
    )
  }
  list(slug: string): LinkCheck[] {
    if (!this.database) return structuredClone(this.transient.get(slug) ?? [])
    const row = this.database.all<{ payload: string }>(
      'SELECT payload FROM link_health WHERE slug = ?',
      slug,
    )[0]
    return row ? JSON.parse(row.payload) : []
  }
  put(slug: string, entry: LinkCheck): void {
    const write = () => {
      const rows = this.list(slug).filter((row) => row.id !== entry.id)
      // Never silently discard a remembered ignore decision.
      if (rows.length >= 10_000) throw new Error('Link review storage limit reached')
      rows.push(entry)
      if (this.database) {
        this.database.exec(
          'INSERT INTO link_health (slug, payload) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET payload = excluded.payload',
          slug,
          JSON.stringify(rows),
        )
      } else this.transient.set(slug, structuredClone(rows))
    }
    if (this.boundary) {
      this.boundary.database.transactionSync(() => {
        write()
        this.boundary!.complete()
      })
    } else write()
  }
  remove(slug: string, id: string): void {
    const write = () => {
      const rows = this.list(slug).filter((row) => row.id !== id)
      if (this.database) {
        this.database.exec(
          'UPDATE link_health SET payload = ? WHERE slug = ?',
          JSON.stringify(rows),
          slug,
        )
      } else this.transient.set(slug, rows)
    }
    if (this.boundary) {
      this.boundary.database.transactionSync(() => {
        write()
        this.boundary!.complete()
      })
    } else write()
  }
  erase(slug: string): number {
    if (this.database) {
      if (!this.database.all('SELECT slug FROM link_health WHERE slug = ?', slug).length) return 0
      this.database.exec('DELETE FROM link_health WHERE slug = ?', slug)
      return 1
    }
    return Number(this.transient.delete(slug))
  }
}
