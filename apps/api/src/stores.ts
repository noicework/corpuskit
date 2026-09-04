import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { Enrichment } from '@research-portal/core'
import { EnrichmentStore } from './enrichments.ts'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

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
  private dirFor(slug: string, clientId: string): string {
    return join(DATA_DIR, 'sessions', safeSegment(slug), safeSegment(clientId))
  }

  list(slug: string, clientId: string): { id: string; title: string; updatedAt: string }[] {
    try {
      const dir = this.dirFor(slug, clientId)
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<StoredSession | null>(join(dir, f), null))
        .filter((s): s is StoredSession => s !== null)
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 100)
    } catch {
      return []
    }
  }

  get(slug: string, clientId: string, id: string): StoredSession | null {
    return readJson<StoredSession | null>(
      join(this.dirFor(slug, clientId), `${safeSegment(id)}.json`),
      null,
    )
  }

  put(slug: string, clientId: string, session: StoredSession): void {
    writeJson(join(this.dirFor(slug, clientId), `${safeSegment(session.id)}.json`), session)
  }

  remove(slug: string, clientId: string, id: string): void {
    try {
      rmSync(join(this.dirFor(slug, clientId), `${safeSegment(id)}.json`))
    } catch {
      // already gone
    }
  }
}

// --- Saved searches / watches ------------------------------------------------

export interface Watch {
  id: string
  clientId: string
  query: string
  createdAt: string
  lastRun: string | null
  /** Fingerprint of the top results last time the watch ran. */
  fingerprint: string | null
  /** True when the latest run saw results change since the user last viewed. */
  changed: boolean
}

export class WatchStore {
  private pathFor(slug: string): string {
    return join(DATA_DIR, 'watches', `${safeSegment(slug)}.json`)
  }

  list(slug: string, clientId?: string): Watch[] {
    const all = readJson<Watch[]>(this.pathFor(slug), [])
    return clientId ? all.filter((w) => w.clientId === clientId) : all
  }

  add(slug: string, clientId: string, query: string): Watch {
    const all = readJson<Watch[]>(this.pathFor(slug), [])
    const trimmed = query.trim()
    // One watch per (client, query) - repeat clicks return the existing one.
    const existing = all.find((w) => w.clientId === clientId && w.query === trimmed)
    if (existing) return existing
    const watch: Watch = {
      id: crypto.randomUUID(),
      clientId,
      query: trimmed,
      createdAt: new Date().toISOString(),
      lastRun: null,
      fingerprint: null,
      changed: false,
    }
    // Cap per client, never across clients - one browser cannot evict another's.
    const mine = all.filter((w) => w.clientId === clientId)
    const keep = mine.length >= 50 ? all.filter((w) => w !== mine[0]) : all
    writeJson(this.pathFor(slug), [...keep, watch])
    return watch
  }

  update(slug: string, id: string, patch: Partial<Watch>, clientId?: string): void {
    const all = readJson<Watch[]>(this.pathFor(slug), [])
    writeJson(
      this.pathFor(slug),
      all.map((w) =>
        w.id === id && (clientId === undefined || w.clientId === clientId) ? { ...w, ...patch } : w
      ),
    )
  }

  remove(slug: string, clientId: string, id: string): void {
    const all = readJson<Watch[]>(this.pathFor(slug), [])
    writeJson(this.pathFor(slug), all.filter((w) => !(w.id === id && w.clientId === clientId)))
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
  private dirFor(slug: string, clientId: string): string {
    return join(DATA_DIR, 'investigations', safeSegment(slug), safeSegment(clientId))
  }

  private pathFor(slug: string, clientId: string, id: string): string {
    return join(this.dirFor(slug, clientId), `${safeSegment(id)}.json`)
  }

  list(slug: string, clientId: string): {
    id: string
    name: string
    question: string
    status: 'active' | 'closed'
    updatedAt: string
    evidenceCount: number
  }[] {
    try {
      return readdirSync(this.dirFor(slug, clientId))
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<Investigation | null>(join(this.dirFor(slug, clientId), f), null))
        .filter((i): i is Investigation => i !== null)
        .map((i) => ({
          id: i.id,
          name: i.name,
          question: i.question,
          status: i.status,
          updatedAt: i.updatedAt,
          evidenceCount: i.evidence.length,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch {
      return []
    }
  }

  get(slug: string, clientId: string, id: string): Investigation | null {
    return readJson<Investigation | null>(this.pathFor(slug, clientId, id), null)
  }

  create(
    slug: string,
    clientId: string,
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
    writeJson(this.pathFor(slug, clientId, investigation.id), investigation)
    return investigation
  }

  update(
    slug: string,
    clientId: string,
    id: string,
    patch: Partial<Pick<Investigation, 'name' | 'question' | 'notes' | 'status'>>,
  ): Investigation | null {
    const current = this.get(slug, clientId, id)
    if (!current) return null
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    writeJson(this.pathFor(slug, clientId, id), next)
    return next
  }

  remove(slug: string, clientId: string, id: string): void {
    try {
      rmSync(this.pathFor(slug, clientId, id))
    } catch {
      // already gone
    }
  }

  addEvidence(
    slug: string,
    clientId: string,
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
    writeJson(this.pathFor(slug, clientId, id), current)
    return item
  }

  updateEvidence(
    slug: string,
    clientId: string,
    id: string,
    evidenceId: string,
    patch: Partial<Pick<EvidenceItem, 'verdict' | 'note' | 'tags'>>,
  ): boolean {
    const current = this.get(slug, clientId, id)
    if (!current) return false
    const index = current.evidence.findIndex((e) => e.id === evidenceId)
    if (index < 0) return false
    current.evidence[index] = { ...current.evidence[index] as EvidenceItem, ...patch }
    current.updatedAt = new Date().toISOString()
    writeJson(this.pathFor(slug, clientId, id), current)
    return true
  }

  removeEvidence(slug: string, clientId: string, id: string, evidenceId: string): void {
    const current = this.get(slug, clientId, id)
    if (!current) return
    current.evidence = current.evidence.filter((e) => e.id !== evidenceId)
    current.updatedAt = new Date().toISOString()
    writeJson(this.pathFor(slug, clientId, id), current)
  }

  addArtefact(
    slug: string,
    clientId: string,
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
    writeJson(this.pathFor(slug, clientId, id), current)
    return artefact
  }
}

// --- MCP credentials --------------------------------------------------------

/**
 * The server-side representation of one CorpusKit-issued MCP credential.
 * `hash` is a SHA-256 digest of the complete credential. The complete value is
 * returned only by the minting response and is never persisted.
 */
export interface McpKeyRecord {
  id: string
  tenant: string
  issuerUserId: string
  label: string
  prefix: string
  hash: string
  createdAt: string
  revokedAt: string | null
}

export class McpKeyStore {
  constructor(private readonly dataDir = DATA_DIR) {}

  private pathFor(slug: string): string {
    return join(this.dataDir, 'mcp-keys', `${safeSegment(slug)}.json`)
  }

  list(slug: string): McpKeyRecord[] {
    return readJson<McpKeyRecord[]>(this.pathFor(slug), [])
      .filter((record) => record.tenant === slug)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  findByPrefix(slug: string, prefix: string): McpKeyRecord | undefined {
    return this.list(slug).find((record) => record.prefix === prefix)
  }

  add(record: McpKeyRecord): void {
    const all = this.list(record.tenant)
    if (all.some((existing) => existing.id === record.id || existing.prefix === record.prefix)) {
      throw new Error('MCP credential identifier collision')
    }
    writeJson(this.pathFor(record.tenant), [...all, record])
  }

  revoke(slug: string, id: string, revokedAt: string): boolean {
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
export type McpKeyStoreApi = Pick<McpKeyStore, keyof McpKeyStore>

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
