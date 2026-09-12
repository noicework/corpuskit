import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import type { Enrichment } from '@research-portal/core'
import { EnrichmentStore } from './enrichments.ts'
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from './persist.ts'
import { appendAudit, type AuditStore, createAuditEvent } from './audit.ts'
import type { RbacDatabase } from './rbac-state.ts'
import {
  decodeLegacyWatches,
  decodeWatchCollection,
  encodeResearchOwner,
  encodeStorageIdentifier,
  equalResearchOwner,
  ownedRecord,
  readOwnedRecord,
  type ResearchOwner,
  researchOwnerValue,
  storageIdentifierPath,
  watchOwner,
} from './research-owner.ts'
import {
  decodeScopedKeyRecords,
  KeyPortalSlugSchema,
  KeyTimeSchema,
  type LegacyMcpKeyRecord,
  migrateLegacyKeyRecord,
  type ScopedKeyRecord,
  type ScopedKeyStore,
} from './scoped-key-record.ts'

// ---------------------------------------------------------------------------
// Volume-backed stores for the portal's own operational data: ask insights
// (the platform's activity endpoints are auth-restricted to dashboard users,
// so the proxy records what it already sees), research-trail sessions,
// saved-search watches and per-portal source registries.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR ?? './data'

function readJson<T>(path: string, fallback: T): T {
  return readJsonSafe(path, fallback)
}

function writeJson(path: string, value: unknown): void {
  writeJsonAtomic(path, value)
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
}

/** An injected caller boundary appends its required audit synchronously after the write. */
export interface OwnedMutationBoundary {
  database: Pick<RbacDatabase, 'transactionSync'>
  complete: () => void
}

function checkedOwnedPath(path: string): string {
  // Reserve room below macOS's 1024-byte path limit for the atomic writer's suffix.
  if (new TextEncoder().encode(resolve(path)).length > 1000) {
    throw new Error('Owned storage path too long')
  }
  return path
}

function ownedRead(path: string): unknown | undefined {
  checkedOwnedPath(path)
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function ownedWrite(
  path: string,
  value: unknown | undefined,
  boundary?: OwnedMutationBoundary,
): void {
  checkedOwnedPath(path)
  let before: Uint8Array | undefined
  try {
    before = readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const work = () => {
    if (value === undefined) {
      if (before !== undefined) rmSync(path)
    } else writeJson(path, value)
    const completion: unknown = boundary?.complete()
    if (completion && typeof (completion as PromiseLike<unknown>).then === 'function') {
      throw new Error('Owned completion must be synchronous')
    }
  }
  try {
    if (boundary) boundary.database.transactionSync(work)
    else work()
  } catch (error) {
    if (before !== undefined) writeFileSync(path, before)
    else {
      try {
        rmSync(path)
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError
      }
    }
    throw error
  }
}

function ownedDirectory(
  root: string,
  kind: string,
  slug: string,
  owner: ResearchOwner | string,
): string {
  return join(
    root,
    'research-v2',
    storageIdentifierPath(encodeStorageIdentifier(slug)),
    kind,
    storageIdentifierPath(encodeResearchOwner(owner)),
  )
}

function ownedFiles(dir: string): string[] {
  checkedOwnedPath(dir)
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'record.json')
      .map((entry) => join(entry.parentPath, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

// --- Ask insights -----------------------------------------------------------

export interface AskInsight {
  ts: string
  question: string
  answered: boolean
  citations: number
  durationSec: number | null
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
}

export interface InsightsSummary {
  totalAsks: number
  answered: number
  unanswered: number
  avgGroundedness: number | null
  avgAnswerRelevance: number | null
  topQuestions: { question: string; count: number }[]
  gaps: { question: string; ts: string; reason: string }[]
  recent: AskInsight[]
}

export class InsightsStore {
  private pathFor(slug: string): string {
    return join(DATA_DIR, 'insights', `${safeSegment(slug)}.jsonl`)
  }

  record(slug: string, insight: AskInsight): void {
    const path = this.pathFor(slug)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(insight) + '\n')
  }

  private readAll(slug: string): AskInsight[] {
    const path = this.pathFor(slug)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      // No insights recorded yet - not an error.
      return []
    }
    // Append-only log: a crash mid-append can leave one truncated trailing
    // line. Skip and log just that line rather than losing the whole file's
    // history, the way a whole-file JSON.parse fallback would.
    const insights: AskInsight[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        insights.push(JSON.parse(line) as AskInsight)
      } catch (err) {
        console.error(`[stores] skipping corrupt insight line in ${path}:`, err)
      }
    }
    return insights
  }

  summary(slug: string, days = 90): InsightsSummary {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    const all = this.readAll(slug).filter((i) => Date.parse(i.ts) >= cutoff)
    const answered = all.filter((i) => i.answered)
    const counts = new Map<string, number>()
    for (const i of all) {
      const key = i.question.trim().toLowerCase().replace(/[?.!]+$/, '')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const avg = (values: (number | null)[]): number | null => {
      const nums = values.filter((v): v is number => v !== null)
      return nums.length
        ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
        : null
    }
    // Knowledge gaps: the corpus could not answer, or answered on thin ground.
    const gaps = all
      .filter((i) => !i.answered || (i.groundedness !== null && i.groundedness <= 2))
      .slice(-30)
      .reverse()
      .map((i) => ({
        question: i.question,
        ts: i.ts,
        reason: !i.answered
          ? 'No answer found in the corpus'
          : `Weak grounding (${i.groundedness}/5)`,
      }))
    return {
      totalAsks: all.length,
      answered: answered.length,
      unanswered: all.length - answered.length,
      avgGroundedness: avg(answered.map((i) => i.groundedness)),
      avgAnswerRelevance: avg(answered.map((i) => i.answerRelevance)),
      topQuestions: byCount.slice(0, 10).map(([question, count]) => ({ question, count })),
      gaps,
      recent: all.slice(-25).reverse(),
    }
  }
}

// --- Research-trail sessions (namespaced per anonymous client id) -----------

export interface StoredSession {
  id: string
  title: string
  updatedAt: string
  messages: unknown[]
}

export class SessionsStore {
  constructor(
    private readonly dataDir = DATA_DIR,
    private readonly boundary?: OwnedMutationBoundary,
  ) {}
  private dirFor(slug: string, owner: ResearchOwner | string): string {
    return ownedDirectory(this.dataDir, 'sessions', slug, owner)
  }
  private pathFor(slug: string, owner: ResearchOwner | string, id: string): string {
    return join(
      this.dirFor(slug, owner),
      storageIdentifierPath(encodeStorageIdentifier(id)),
      'record.json',
    )
  }
  list(
    slug: string,
    owner: ResearchOwner | string,
  ): { id: string; title: string; updatedAt: string }[] {
    return ownedFiles(this.dirFor(slug, owner)).map((path) => {
      const session = readOwnedRecord<StoredSession>(ownedRead(path), slug, owner)
      if (path !== this.pathFor(slug, owner, session.id)) throw new Error('Invalid session path')
      return { id: session.id, title: session.title, updatedAt: session.updatedAt }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100)
  }
  get(slug: string, owner: ResearchOwner | string, id: string): StoredSession | null {
    const value = ownedRead(this.pathFor(slug, owner, id))
    return value === undefined ? null : readOwnedRecord<StoredSession>(value, slug, owner, id)
  }
  put(slug: string, owner: ResearchOwner | string, session: StoredSession): void {
    this.get(slug, owner, session.id)
    ownedWrite(
      this.pathFor(slug, owner, session.id),
      ownedRecord(slug, owner, session),
      this.boundary,
    )
  }
  remove(slug: string, owner: ResearchOwner | string, id: string): void {
    if (this.get(slug, owner, id)) {
      ownedWrite(this.pathFor(slug, owner, id), undefined, this.boundary)
    }
  }
}

// --- Saved searches / watches ------------------------------------------------

export interface Watch {
  id: string
  clientId: string
  readonly owner?: ResearchOwner
  query: string
  createdAt: string
  lastRun: string | null
  /** Fingerprint of the top results last time the watch ran. */
  fingerprint: string | null
  /** True when the latest run saw results change since the user last viewed. */
  changed: boolean
}

export class WatchStore {
  constructor(
    private readonly dataDir = DATA_DIR,
    private readonly boundary?: OwnedMutationBoundary,
  ) {}
  private pathFor(slug: string): string {
    return join(
      this.dataDir,
      'research-v2',
      storageIdentifierPath(encodeStorageIdentifier(slug)),
      'watches.json',
    )
  }
  private read(slug: string): Watch[] {
    const value = ownedRead(this.pathFor(slug))
    if (value !== undefined) return decodeWatchCollection(value, slug)
    const legacy = ownedRead(join(this.dataDir, 'watches', safeSegment(slug) + '.json'))
    return decodeLegacyWatches(legacy, slug)
  }
  private write(slug: string, entries: Watch[]): void {
    ownedWrite(this.pathFor(slug), { v: 2, slug, entries }, this.boundary)
  }
  /** Ownerless enumeration is reserved for the internal scheduler. */
  list(slug: string, owner?: ResearchOwner | string): Watch[] {
    if (owner !== undefined) researchOwnerValue(owner)
    return this.read(slug).filter((watch) =>
      owner === undefined || equalResearchOwner(watchOwner(watch), owner)
    )
  }
  add(slug: string, input: ResearchOwner | string, query: string): Watch {
    const owner = researchOwnerValue(input)
    const all = this.read(slug)
    const trimmed = query.trim()
    const mine = all.filter((watch) => equalResearchOwner(watchOwner(watch), owner))
    const existing = mine.find((watch) => watch.query === trimmed)
    if (existing) return existing
    const watch: Watch = {
      id: crypto.randomUUID(),
      clientId: owner.kind === 'anonymous' ? owner.clientId : owner.oid,
      owner,
      query: trimmed,
      createdAt: new Date().toISOString(),
      lastRun: null,
      fingerprint: null,
      changed: false,
    }
    this.write(slug, [
      ...(mine.length >= 50 ? all.filter((watch) => watch !== mine[0]) : all),
      watch,
    ])
    return watch
  }
  /** Ownerless updates are reserved for the internal scheduler. Identity fields are immutable. */
  update(slug: string, id: string, patch: Partial<Watch>, owner?: ResearchOwner | string): void {
    encodeStorageIdentifier(id)
    if (owner !== undefined) researchOwnerValue(owner)
    const all = this.read(slug)
    let changed = false
    const next = all.map((watch) => {
      if (
        watch.id !== id || (owner !== undefined && !equalResearchOwner(watchOwner(watch), owner))
      ) return watch
      changed = true
      return {
        ...watch,
        ...patch,
        id: watch.id,
        clientId: watch.clientId,
        owner: watch.owner,
        createdAt: watch.createdAt,
      }
    })
    if (changed) this.write(slug, next)
  }
  remove(slug: string, owner: ResearchOwner | string, id: string): void {
    encodeStorageIdentifier(id)
    researchOwnerValue(owner)
    const all = this.read(slug)
    const next = all.filter((watch) =>
      !(watch.id === id && equalResearchOwner(watchOwner(watch), owner))
    )
    if (next.length !== all.length) this.write(slug, next)
  }
}

// --- Source registry (scheduled re-syncs) ------------------------------------

export interface Source {
  id: string
  url: string
  addedAt: string
  lastSync: string | null
  lastAdded: number
  /** Sync automatically on the daily schedule. */
  auto: boolean
  /** Urls already ingested from this source (dedupe across syncs). */
  synced?: string[]
  /**
   * Running total of pages ingested from this source. Kept as its own counter
   * rather than read off `synced.length`, because `synced` is trimmed to the
   * most recent 5000 urls and would understate a long-lived source.
   */
  itemCount?: number
  /** Outcome of the most recent sync attempt, manual or scheduled. */
  lastStatus?: 'ok' | 'error'
  /** Why the most recent sync failed, when it did. */
  lastError?: string | null
  /**
   * Ceiling on how many NEW pages one sync run may ingest. Bounds the first
   * sync of a large site (which would otherwise pull the global cap in one
   * go) and keeps a demo predictable; the rest arrive on later runs.
   */
  maxPages?: number
}

/**
 * What the admin API hands back for a source. `synced` stays server-side: it
 * holds up to 5000 urls, which is pure weight on every poll of the sources
 * list, and the browser only ever needs the count.
 */
export type SourceSummary = Omit<Source, 'synced'> & { itemCount: number }

export class SourceStore {
  private pathFor(slug: string): string {
    return join(DATA_DIR, 'sources', `${safeSegment(slug)}.json`)
  }

  list(slug: string): Source[] {
    return readJson<Source[]>(this.pathFor(slug), [])
  }

  /** The list as the admin API exposes it - no url ledger, count always present. */
  summaries(slug: string): SourceSummary[] {
    return this.list(slug).map(({ synced, ...rest }) => ({
      ...rest,
      itemCount: rest.itemCount ?? synced?.length ?? 0,
    }))
  }

  find(slug: string, id: string): Source | undefined {
    return this.list(slug).find((s) => s.id === id)
  }

  /** The registered source whose url matches exactly, if any. */
  findByUrl(slug: string, url: string): Source | undefined {
    return this.list(slug).find((s) => s.url === url)
  }

  /** Slugs that have at least one source registered. */
  slugs(): string[] {
    try {
      return readdirSync(join(DATA_DIR, 'sources'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  add(slug: string, url: string, auto: boolean, maxPages?: number): Source {
    const all = this.list(slug)
    const existing = all.find((s) => s.url === url)
    if (existing) return existing
    const source: Source = {
      id: crypto.randomUUID(),
      url,
      addedAt: new Date().toISOString(),
      lastSync: null,
      lastAdded: 0,
      auto,
      synced: [],
      itemCount: 0,
      lastStatus: undefined,
      lastError: null,
      ...(maxPages ? { maxPages } : {}),
    }
    writeJson(this.pathFor(slug), [...all, source])
    return source
  }

  update(slug: string, id: string, patch: Partial<Source>): void {
    writeJson(
      this.pathFor(slug),
      this.list(slug).map((s) => (s.id === id ? { ...s, ...patch } : s)),
    )
  }

  remove(slug: string, id: string): void {
    writeJson(this.pathFor(slug), this.list(slug).filter((s) => s.id !== id))
  }
}

// --- Investigations: the research workspace -----------------------------------

export interface EvidenceItem {
  id: string
  passage: string
  resourceId: string
  resourceTitle: string
  /** Calibrated retrieval score at capture time, when known. */
  score: number | null
  /** The question this passage was retrieved for. */
  question: string
  verdict: 'supports' | 'partial' | 'not-relevant' | 'contradicts' | null
  /** The AI's one-line relevance judgement at capture time. */
  aiRelevance: string | null
  note: string
  tags: string[]
  createdAt: string
}

export interface InvestigationArtefact {
  id: string
  kind: string
  title: string
  data: unknown
  createdAt: string
}

export interface Investigation {
  id: string
  name: string
  question: string
  notes: string
  status: 'active' | 'closed'
  createdAt: string
  updatedAt: string
  evidence: EvidenceItem[]
  artefacts: InvestigationArtefact[]
}

export class InvestigationStore {
  constructor(
    private readonly dataDir = DATA_DIR,
    private readonly boundary?: OwnedMutationBoundary,
  ) {}
  private dirFor(slug: string, owner: ResearchOwner | string): string {
    return ownedDirectory(this.dataDir, 'investigations', slug, owner)
  }
  private pathFor(slug: string, owner: ResearchOwner | string, id: string): string {
    return join(
      this.dirFor(slug, owner),
      storageIdentifierPath(encodeStorageIdentifier(id)),
      'record.json',
    )
  }
  private put(slug: string, owner: ResearchOwner | string, value: Investigation): void {
    this.get(slug, owner, value.id)
    ownedWrite(this.pathFor(slug, owner, value.id), ownedRecord(slug, owner, value), this.boundary)
  }
  list(slug: string, owner: ResearchOwner | string) {
    return ownedFiles(this.dirFor(slug, owner)).map((path) => {
      const i = readOwnedRecord<Investigation>(ownedRead(path), slug, owner)
      if (path !== this.pathFor(slug, owner, i.id)) throw new Error('Invalid investigation path')
      return {
        id: i.id,
        name: i.name,
        question: i.question,
        status: i.status,
        updatedAt: i.updatedAt,
        evidenceCount: i.evidence.length,
      }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  get(slug: string, owner: ResearchOwner | string, id: string): Investigation | null {
    const value = ownedRead(this.pathFor(slug, owner, id))
    return value === undefined ? null : readOwnedRecord<Investigation>(value, slug, owner, id)
  }

  create(
    slug: string,
    clientId: ResearchOwner | string,
    input: { name: string; question?: string },
  ): Investigation {
    const now = new Date().toISOString()
    const investigation: Investigation = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      name: input.name,
      question: input.question ?? '',
      notes: '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      evidence: [],
      artefacts: [],
    }
    this.put(slug, clientId, investigation)
    return investigation
  }

  update(
    slug: string,
    clientId: ResearchOwner | string,
    id: string,
    patch: Partial<Pick<Investigation, 'name' | 'question' | 'notes' | 'status'>>,
  ): Investigation | null {
    const current = this.get(slug, clientId, id)
    if (!current) return null
    const next = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.question === undefined ? {} : { question: patch.question }),
      ...(patch.notes === undefined ? {} : { notes: patch.notes }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: new Date().toISOString(),
    }
    this.put(slug, clientId, next)
    return next
  }

  remove(slug: string, clientId: ResearchOwner | string, id: string): void {
    if (this.get(slug, clientId, id)) {
      ownedWrite(this.pathFor(slug, clientId, id), undefined, this.boundary)
    }
  }

  addEvidence(
    slug: string,
    clientId: ResearchOwner | string,
    id: string,
    input: Omit<EvidenceItem, 'id' | 'createdAt'>,
  ): EvidenceItem | null {
    const current = this.get(slug, clientId, id)
    if (!current || current.evidence.length >= 500) return null
    const item: EvidenceItem = {
      ...input,
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      createdAt: new Date().toISOString(),
    }
    // The same passage saved twice for the same question is one item.
    const duplicate = current.evidence.find(
      (e) => e.resourceId === item.resourceId && e.passage === item.passage,
    )
    if (duplicate) return duplicate
    current.evidence.push(item)
    current.updatedAt = item.createdAt
    this.put(slug, clientId, current)
    return item
  }

  updateEvidence(
    slug: string,
    clientId: ResearchOwner | string,
    id: string,
    evidenceId: string,
    patch: Partial<Pick<EvidenceItem, 'verdict' | 'note' | 'tags'>>,
  ): boolean {
    const current = this.get(slug, clientId, id)
    if (!current) return false
    const index = current.evidence.findIndex((e) => e.id === evidenceId)
    if (index < 0) return false
    current.evidence[index] = {
      ...current.evidence[index] as EvidenceItem,
      ...(patch.verdict === undefined ? {} : { verdict: patch.verdict }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
    }
    current.updatedAt = new Date().toISOString()
    this.put(slug, clientId, current)
    return true
  }

  removeEvidence(
    slug: string,
    clientId: ResearchOwner | string,
    id: string,
    evidenceId: string,
  ): void {
    const current = this.get(slug, clientId, id)
    if (!current) return
    current.evidence = current.evidence.filter((e) => e.id !== evidenceId)
    current.updatedAt = new Date().toISOString()
    this.put(slug, clientId, current)
  }

  addArtefact(
    slug: string,
    clientId: ResearchOwner | string,
    id: string,
    input: { kind: string; title: string; data: unknown },
  ): InvestigationArtefact | null {
    const current = this.get(slug, clientId, id)
    if (!current || current.artefacts.length >= 100) return null
    const artefact: InvestigationArtefact = {
      ...input,
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      createdAt: new Date().toISOString(),
    }
    current.artefacts.push(artefact)
    current.updatedAt = artefact.createdAt
    this.put(slug, clientId, current)
    return artefact
  }
}

// --- MCP credentials --------------------------------------------------------

/**
 * The server-side representation of one CorpusKit-issued MCP credential.
 * `hash` is a SHA-256 digest of the complete credential. The complete value is
 * returned only by the minting response and is never persisted.
 */
export type McpKeyRecord = LegacyMcpKeyRecord

function readKeyText(path: string): string {
  // Reject malformed bytes and retain a BOM so parsing cannot silently rewrite original data.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path))
}

export class McpKeyStore implements ScopedKeyStore {
  /** Construct at startup. HTTP lookups never rewrite records or assume system authority. */
  constructor(
    private readonly dataDir = DATA_DIR,
    migration?: { database: RbacDatabase; audit: AuditStore },
  ) {
    let files: string[]
    try {
      files = readdirSync(join(dataDir, 'mcp-keys')).filter((name) => name.endsWith('.json')).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const changes = files.flatMap((name) => {
      const slug = KeyPortalSlugSchema.parse(name.slice(0, -5))
      const path = this.pathFor(slug)
      const original = readKeyText(path)
      const raw: unknown = JSON.parse(original)
      const records = decodeScopedKeyRecords(raw, slug)
      return (raw as { v?: number }[]).some((record) => record.v === undefined)
        ? [{ slug, path, original, records }]
        : []
    })
    if (!changes.length) return
    if (!migration) throw new Error('Key migration requires startup audit storage')
    const written: typeof changes = []
    try {
      migration.database.transactionSync(() => {
        for (const change of changes) {
          writeJsonAtomic(change.path, change.records)
          written.push(change)
          appendAudit(
            migration.audit,
            createAuditEvent({
              requestId: crypto.randomUUID(),
              actor: { kind: 'system' },
              action: 'local.mutation',
              scope: { kind: 'portal', slug: change.slug },
              target: { kind: 'migration', id: 'scoped-keys-v1' },
              outcome: 'success',
              detail: { permission: 'keys.manage', mutation: 'mcpKeys.add' },
            }),
          )
        }
      })
    } catch (error) {
      // JSON and SQLite cannot share crash atomicity. Restore exact bytes on observed failure.
      for (const change of written.reverse()) writeFileAtomic(change.path, change.original)
      throw error
    }
  }

  private pathFor(slug: string): string {
    return join(this.dataDir, 'mcp-keys', `${KeyPortalSlugSchema.parse(slug)}.json`)
  }

  list(slug: string): ScopedKeyRecord[] {
    let raw: string
    try {
      raw = readKeyText(this.pathFor(slug))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return decodeScopedKeyRecords(JSON.parse(raw), slug)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  findByHash(slug: string, hash: string): ScopedKeyRecord | undefined {
    return this.list(slug).find((record) => record.hash === hash)
  }

  findByPrefix(slug: string, prefix: string): ScopedKeyRecord | undefined {
    return this.list(slug).find((record) => record.prefix === prefix)
  }

  add(input: McpKeyRecord | ScopedKeyRecord): void {
    const record = migrateLegacyKeyRecord(input)
    const all = decodeScopedKeyRecords([...this.list(record.tenant), record], record.tenant)
    writeJson(this.pathFor(record.tenant), all)
  }

  revoke(slug: string, id: string, revokedAt: string): boolean {
    KeyTimeSchema.parse(revokedAt)
    const all = this.list(slug)
    const found = all.find((record) => record.id === id)
    if (!found) return false
    if (!found.revokedAt) found.revokedAt = revokedAt
    writeJson(this.pathFor(slug), all)
    return true
  }
}

/** Public store contracts used by runtimes without a local filesystem. */
export type InsightsStoreApi = Pick<InsightsStore, keyof InsightsStore>
export type SessionsStoreApi = Pick<SessionsStore, keyof SessionsStore>
export type WatchStoreApi = Pick<WatchStore, keyof WatchStore>
export type SourceStoreApi = Pick<SourceStore, keyof SourceStore>
export type InvestigationStoreApi = Pick<InvestigationStore, keyof InvestigationStore>
export type McpKeyStoreApi = ScopedKeyStore
export type RoutingLogApi = Pick<RoutingLog, keyof RoutingLog>

// --- Enrichment import/export ----------------------------------------------

/** Persisted enrichment shape: agent id -> resource id -> enrichment. */
export type EnrichmentRecords = Record<string, Record<string, Enrichment>>

export type EnrichmentCollisionPolicy = 'skip' | 'overwrite'

export interface EnrichmentImportResult {
  /** New and overwritten records accepted by the store. */
  imported: number
  /** Existing records left untouched by the skip policy. */
  skipped: number
  /** Imported records that replaced an existing record. */
  overwritten: number
  reasons: { existing: number }
}

export interface EnrichmentTransferStoreApi {
  exportRecords(slug: string): EnrichmentRecords
  importRecords(
    slug: string,
    records: EnrichmentRecords,
    collision: EnrichmentCollisionPolicy,
  ): EnrichmentImportResult
}

// EnrichmentStore lives in enrichments.ts, which is also the generation path.
// Keep bulk persistence here with the other runtime store contracts so the
// import/export work does not couple itself to generation behaviour.
declare module './enrichments.ts' {
  interface EnrichmentStore extends EnrichmentTransferStoreApi {}
}

type VolumeEnrichmentStoreInternals = {
  cache: Map<string, EnrichmentRecords>
  load(slug: string): EnrichmentRecords
  pathFor(slug: string): string
}

function volumeInternals(store: EnrichmentStore): VolumeEnrichmentStoreInternals {
  return store as unknown as VolumeEnrichmentStoreInternals
}

EnrichmentStore.prototype.exportRecords = function (slug): EnrichmentRecords {
  return structuredClone(volumeInternals(this).load(slug))
}

EnrichmentStore.prototype.importRecords = function (
  slug,
  records,
  collision,
): EnrichmentImportResult {
  const internals = volumeInternals(this)
  const next = structuredClone(internals.load(slug))
  let imported = 0
  let skipped = 0
  let overwritten = 0

  for (const [agentId, incoming] of Object.entries(records)) {
    const bucket = next[agentId] ?? (next[agentId] = {})
    for (const [resourceId, enrichment] of Object.entries(incoming)) {
      const exists = Object.hasOwn(bucket, resourceId)
      if (exists && collision === 'skip') {
        skipped++
        continue
      }
      bucket[resourceId] = enrichment
      imported++
      if (exists) overwritten++
    }
  }

  if (imported > 0) {
    // One atomic rename makes the whole validated import visible at once.
    writeJsonAtomic(internals.pathFor(slug), next)
    internals.cache.set(slug, next)
  }

  return { imported, skipped, overwritten, reasons: { existing: skipped } }
}

// ---------------------------------------------------------------------------
// Routing log: one line per intent-routing decision, per tenant. The
// evaluation set for tuning the rules and an audit trail of which stored
// configuration answered which question (docs/INTENT-ROUTING.md).
// ---------------------------------------------------------------------------

export interface RoutingRecord {
  ts: string
  /** SHA-free short hash of the normalised question; the question itself is not stored. */
  questionHash: string
  questionLength: number
  intent: string
  stage: 'rule' | 'classifier' | 'default' | 'override'
  confidence: number
  rationale: string
  configuration: string
  latencyMs: number
}

export class RoutingLog {
  private pathFor(slug: string): string {
    return join(DATA_DIR, 'routing', `${safeSegment(slug)}.jsonl`)
  }

  record(slug: string, entry: RoutingRecord): void {
    const path = this.pathFor(slug)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n')
  }

  /** Newest first, capped. */
  recent(slug: string, limit = 50): RoutingRecord[] {
    let raw: string
    try {
      raw = readFileSync(this.pathFor(slug), 'utf8')
    } catch {
      return []
    }
    const rows: RoutingRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line) as RoutingRecord)
      } catch {
        // a torn line from a crash mid-write is skipped
      }
    }
    return rows.reverse().slice(0, limit)
  }

  /** Counts by intent and stage over the whole log - the panel's summary line. */
  summary(
    slug: string,
  ): { total: number; byIntent: Record<string, number>; byStage: Record<string, number> } {
    const rows = this.recent(slug, Number.MAX_SAFE_INTEGER)
    const byIntent: Record<string, number> = {}
    const byStage: Record<string, number> = {}
    for (const r of rows) {
      byIntent[r.intent] = (byIntent[r.intent] ?? 0) + 1
      byStage[r.stage] = (byStage[r.stage] ?? 0) + 1
    }
    return { total: rows.length, byIntent, byStage }
  }
}

/** A short, stable hash for grouping identical questions without storing them. */
export function questionHash(question: string): string {
  const normalised = question.toLowerCase().replace(/\s+/g, ' ').trim()
  let h = 2166136261
  for (let i = 0; i < normalised.length; i++) {
    h ^= normalised.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
