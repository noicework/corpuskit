import { redactAnswerRecordText } from './answer-record-redaction.ts'
import {
  ANSWER_RECORD_RETENTION_DAYS,
  type AnswerRecord,
  AnswerRecordRetentionSchema,
  AnswerRecordSchema,
} from '@research-portal/core'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './persist.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'
import { z } from 'zod'

export interface AnswerRecordState {
  get<T>(key: string, fallback: T): T
  has(key: string): boolean
  keys(prefix: string): string[]
  put(key: string, value: unknown): void
  delete(key: string): void
  list<T>(prefix: string): { key: string; value: T }[]
}
const PREFIX = 'answer-records:'
const DAY = 86_400_000
const IdSchema = z.string().uuid()
const prefixFor = (slug: string) => `${PREFIX}${KeyPortalSlugSchema.parse(slug)}:`
const recordKey = (slug: string, id: string) => `${prefixFor(slug)}record:${IdSchema.parse(id)}`

export class AnswerRecordStore {
  constructor(private readonly state: AnswerRecordState, private readonly now = Date.now) {}

  retention(slug: string): number {
    return AnswerRecordRetentionSchema.parse(this.state.get(`${prefixFor(slug)}retention`, {
      days: ANSWER_RECORD_RETENTION_DAYS,
    })).days
  }
  /** One bounded row per answer, rather than an ever-growing portal history in a single row. */
  record(slug: string, record: AnswerRecord): void {
    const parsed = AnswerRecordSchema.parse(JSON.parse(JSON.stringify(
      AnswerRecordSchema.parse(record),
      (_key, value) => typeof value === 'string' ? redactAnswerRecordText(value) : value,
    )))
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 384 * 1024) {
      throw new Error('Answer record too large')
    }
    if (parsed.portal !== slug) throw new Error('Answer record portal mismatch')
    const key = recordKey(slug, parsed.answerId)
    if (this.state.has(key)) throw new Error('Answer record already exists')
    this.state.put(key, parsed)
  }
  list(slug: string, from?: string, to?: string): AnswerRecord[] {
    const cutoff = this.now() - this.retention(slug) * DAY
    return this.state.list<AnswerRecord>(prefixFor(slug) + 'record:').map(({ value }) =>
      AnswerRecordSchema.parse(value)
    ).filter((r) =>
      r.portal === slug && Date.parse(r.at) > cutoff &&
      (!from || r.at >= from) && (!to || r.at <= to)
    ).sort((a, b) => a.at.localeCompare(b.at) || a.answerId.localeCompare(b.answerId))
  }
  get(slug: string, id: string): AnswerRecord | null {
    if (!IdSchema.safeParse(id).success) return null
    const value = this.state.get<AnswerRecord | null>(recordKey(slug, id), null)
    if (value === null) return null
    const record = AnswerRecordSchema.parse(value)
    return record.portal === slug && Date.parse(record.at) > this.now() - this.retention(slug) * DAY
      ? record
      : null
  }
  setRetention(slug: string, days: number): void {
    AnswerRecordRetentionSchema.parse({ days })
    this.state.put(`${prefixFor(slug)}retention`, { days })
    this.purgePortal(slug, days)
  }
  private purgePortal(slug: string, days: number): number {
    let count = 0
    for (const { key, value } of this.state.list<AnswerRecord>(prefixFor(slug) + 'record:')) {
      if (Date.parse(AnswerRecordSchema.parse(value).at) <= this.now() - days * DAY) {
        this.state.delete(key)
        count++
      }
    }
    return count
  }
  /** Physical deletion, including inactive and retired portals. Reads already hide expiry. */
  purgeExpired(): number {
    const slugs = new Set(this.state.keys(PREFIX).map((key) => key.split(':')[1]!))
    let count = 0
    for (const slug of slugs) count += this.purgePortal(slug, this.retention(slug))
    return count
  }
  erase(slug: string): number {
    const rows = this.state.keys(prefixFor(slug))
    for (const key of rows) this.state.delete(key)
    return rows.length
  }
}
export type AnswerRecordStoreApi = Pick<
  AnswerRecordStore,
  'record' | 'list' | 'get' | 'retention' | 'setRetention' | 'purgeExpired' | 'erase'
>

/** Explicit DATA_DIR adapter, with no module-level paths or cached record collections. */
export class FileAnswerRecordState implements AnswerRecordState {
  constructor(private readonly directory: string) {}
  path(key: string): string {
    const parts = key.split(':')
    const slug = KeyPortalSlugSchema.parse(parts[1])
    if (parts[0] !== 'answer-records') throw new Error('Invalid answer record key')
    const name = parts[2] === 'retention' && parts.length === 3
      ? 'retention'
      : parts[2] === 'record' && parts.length === 4
      ? IdSchema.parse(parts[3])
      : null
    if (!name) throw new Error('Invalid answer record key')
    return join(this.directory, 'answer-records', slug, `${name}.json`)
  }
  get<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path(key), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback)
      throw new Error('Answer record storage unavailable')
    }
  }
  has(key: string): boolean {
    return existsSync(this.path(key))
  }
  put(key: string, value: unknown): void {
    writeJsonAtomic(this.path(key), value)
  }
  delete(key: string): void {
    rmSync(this.path(key), { force: true })
  }
  /** Listing keys deliberately does not parse bytes, so erasure also removes corrupt data. */
  keys(prefix: string): string[] {
    const root = join(this.directory, 'answer-records')
    mkdirSync(root, { recursive: true })
    const keys: string[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !KeyPortalSlugSchema.safeParse(entry.name).success) continue
      for (const file of readdirSync(join(root, entry.name))) {
        if (!file.endsWith('.json')) continue
        const name = file.slice(0, -5)
        if (name !== 'retention' && !IdSchema.safeParse(name).success) continue
        const key = `${prefixFor(entry.name)}${name === 'retention' ? name : `record:${name}`}`
        if (key.startsWith(prefix)) keys.push(key)
      }
    }
    return keys
  }
  list<T>(prefix: string): { key: string; value: T }[] {
    return this.keys(prefix).map((key) => ({ key, value: this.get<T>(key, null as T) }))
  }
  mutationPaths(args: unknown[]): string[] {
    const slug = String(args[0])
    const value = args[1]
    if (typeof value === 'object' && value !== null && 'answerId' in value) {
      return [this.path(recordKey(slug, String(value.answerId)))]
    }
    return [...new Set([`${prefixFor(slug)}retention`, ...this.keys(prefixFor(slug))])]
      .map((key) => this.path(key))
  }
}

/** Embedded applications keep isolated state unless a runtime injects storage. */
export function transientAnswerRecordStore(now = Date.now): AnswerRecordStore {
  const values = new Map<string, unknown>()
  return new AnswerRecordStore({
    get: <T>(key: string, fallback: T) => structuredClone(values.get(key) ?? fallback) as T,
    has: (key) => values.has(key),
    keys: (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
    put: (key, value) => {
      values.set(key, structuredClone(value))
    },
    delete: (key) => {
      values.delete(key)
    },
    list: <T>(prefix: string) =>
      [...values].filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) as T })),
  }, now)
}
