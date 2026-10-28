import type {
  EvaluationInput,
  EvaluationRun,
  EvaluationSchedule,
  EvaluationSet,
} from '@research-portal/core'
import { EvaluationInputSchema } from '@research-portal/core'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'
import type { SqlExecutor } from './rbac-state.ts'

/** Shared SQLite adapter: local DATA_DIR/rbac.sqlite and the managed Durable Object database. */
export class EvaluationStore {
  constructor(
    private readonly database: SqlExecutor,
    private readonly mutate: <T>(work: () => T) => T = (work) => work(),
  ) {
    database.exec(`CREATE TABLE IF NOT EXISTS evaluation_sets (
      slug TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(slug,id))`)
    database.exec(`CREATE TABLE IF NOT EXISTS evaluation_schedules (
      slug TEXT NOT NULL, set_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(slug,set_id))`)
    database.exec(`CREATE TABLE IF NOT EXISTS evaluation_runs (
      slug TEXT NOT NULL, id TEXT NOT NULL, set_id TEXT NOT NULL, started_at TEXT NOT NULL,
      status TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(slug,id))`)
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS evaluation_running_portal
      ON evaluation_runs(slug) WHERE status = 'running'`)
  }
  list(slug: string): EvaluationSet[] {
    KeyPortalSlugSchema.parse(slug)
    return this.database.all<{ json: string }>(
      'SELECT json FROM evaluation_sets WHERE slug = ? ORDER BY id',
      slug,
    ).map((row) => JSON.parse(row.json))
  }
  get(slug: string, id: string): EvaluationSet | null {
    return this.list(slug).find((set) => set.id === id) ?? null
  }
  put(slug: string, id: string, input: EvaluationInput, at = Date.now()): EvaluationSet {
    KeyPortalSlugSchema.parse(slug)
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid evaluation id')
    const set = {
      ...EvaluationInputSchema.parse(input),
      id,
      slug,
      updatedAt: new Date(Math.max(at, Date.parse(this.get(slug, id)?.updatedAt ?? '') + 1 || at))
        .toISOString(),
    }
    return this.mutate(() => {
      if (!this.get(slug, id) && this.list(slug).length >= 50) {
        throw new Error('Evaluation set limit reached')
      }
      this.database.exec(
        `INSERT INTO evaluation_sets(slug,id,json) VALUES (?,?,?)
        ON CONFLICT(slug,id) DO UPDATE SET json = excluded.json`,
        slug,
        id,
        JSON.stringify(set),
      )
      return set
    })
  }
  remove(slug: string, id: string): void {
    KeyPortalSlugSchema.parse(slug)
    this.mutate(() => {
      this.database.exec('DELETE FROM evaluation_runs WHERE slug = ? AND set_id = ?', slug, id)
      this.database.exec('DELETE FROM evaluation_sets WHERE slug = ? AND id = ?', slug, id)
      this.database.exec('DELETE FROM evaluation_schedules WHERE slug = ? AND set_id = ?', slug, id)
    })
  }
  runs(slug: string, setId: string): EvaluationRun[] {
    KeyPortalSlugSchema.parse(slug)
    return this.database.all<{ json: string }>(
      'SELECT json FROM evaluation_runs WHERE slug = ? AND set_id = ? ORDER BY started_at DESC, id DESC LIMIT 100',
      slug,
      setId,
    ).map((row) => JSON.parse(row.json))
  }
  run(slug: string, id: string): EvaluationRun | null {
    KeyPortalSlugSchema.parse(slug)
    const row = this.database.all<{ json: string }>(
      'SELECT json FROM evaluation_runs WHERE slug = ? AND id = ?',
      slug,
      id,
    )[0]
    return row ? JSON.parse(row.json) : null
  }
  /** A portal has one active run. Expired runs remain visible as failed attempts. */
  start(slug: string, run: EvaluationRun): boolean {
    KeyPortalSlugSchema.parse(slug)
    if (run.slug !== slug || run.definition.slug !== slug) throw new Error('Portal mismatch')
    return this.mutate(() => {
      const active = this.database.all<{ json: string }>(
        "SELECT json FROM evaluation_runs WHERE slug = ? AND status = 'running'",
        slug,
      )
      for (const row of active) {
        const prior = JSON.parse(row.json) as EvaluationRun
        if (Date.parse(run.startedAt) - Date.parse(prior.startedAt) < 10 * 60_000) return false
        prior.status = 'failed'
        prior.completedAt = run.startedAt
        this.database.exec(
          'UPDATE evaluation_runs SET status = ?, json = ? WHERE slug = ? AND id = ?',
          prior.status,
          JSON.stringify(prior),
          slug,
          prior.id,
        )
      }
      if (!this.get(slug, run.setId)) return false
      this.database.exec(
        `INSERT INTO evaluation_runs(slug,id,set_id,started_at,status,json)
        VALUES (?,?,?,?,?,?)`,
        slug,
        run.id,
        run.setId,
        run.startedAt,
        run.status,
        JSON.stringify(run),
      )
      this.database.exec(
        `DELETE FROM evaluation_runs WHERE slug = ? AND set_id = ? AND id NOT IN
        (SELECT id FROM evaluation_runs WHERE slug = ? AND set_id = ? ORDER BY started_at DESC, id DESC LIMIT 100)`,
        slug,
        run.setId,
        slug,
        run.setId,
      )
      return true
    })
  }
  finish(slug: string, run: EvaluationRun): void {
    if (run.slug !== slug) throw new Error('Portal mismatch')
    this.mutate(() =>
      this.database.exec(
        "UPDATE evaluation_runs SET status = ?, json = ? WHERE slug = ? AND id = ? AND status = 'running'",
        run.status,
        JSON.stringify(run),
        slug,
        run.id,
      )
    )
  }
  schedules(slug?: string): EvaluationSchedule[] {
    if (slug !== undefined) KeyPortalSlugSchema.parse(slug)
    return this.database.all<{ json: string }>(
      `SELECT json FROM evaluation_schedules${
        slug === undefined ? '' : ' WHERE slug = ?'
      } ORDER BY slug,set_id`,
      ...(slug === undefined ? [] : [slug]),
    ).map((row) => JSON.parse(row.json))
  }
  schedule(slug: string, setId: string, value: EvaluationSchedule | null): void {
    KeyPortalSlugSchema.parse(slug)
    if (value && (value.slug !== slug || value.setId !== setId)) throw new Error('Portal mismatch')
    this.mutate(() => {
      if (!value) {
        this.database.exec(
          'DELETE FROM evaluation_schedules WHERE slug = ? AND set_id = ?',
          slug,
          setId,
        )
      } else if (this.get(slug, setId)) {
        this.database.exec(
          `INSERT INTO evaluation_schedules(slug,set_id,json)
        VALUES (?,?,?) ON CONFLICT(slug,set_id) DO UPDATE SET json = excluded.json`,
          slug,
          setId,
          JSON.stringify(value),
        )
      }
    })
  }
  claimSchedule(slug: string, setId: string, at: number): boolean {
    KeyPortalSlugSchema.parse(slug)
    return this.mutate(() => {
      const schedule = this.schedules(slug).find((s) => s.setId === setId)
      if (!schedule || schedule.nextAt > at) return false
      const set = this.get(slug, setId)
      if (!set || set.updatedAt !== schedule.updatedAt) return false
      this.database.exec(
        'UPDATE evaluation_schedules SET json = ? WHERE slug = ? AND set_id = ?',
        JSON.stringify({ ...schedule, nextAt: at + schedule.everyDays * 86_400_000 }),
        slug,
        setId,
      )
      return true
    })
  }
  erase(slug: string): number {
    KeyPortalSlugSchema.parse(slug)
    return this.mutate(() => {
      const count = this.database.all<{ count: number }>(
        `SELECT
        (SELECT count(*) FROM evaluation_sets WHERE slug = ?) +
        (SELECT count(*) FROM evaluation_runs WHERE slug = ?) +
        (SELECT count(*) FROM evaluation_schedules WHERE slug = ?) AS count`,
        slug,
        slug,
        slug,
      )[0]!.count
      this.database.exec('DELETE FROM evaluation_runs WHERE slug = ?', slug)
      this.database.exec('DELETE FROM evaluation_sets WHERE slug = ?', slug)
      this.database.exec('DELETE FROM evaluation_schedules WHERE slug = ?', slug)
      return count
    })
  }
}
