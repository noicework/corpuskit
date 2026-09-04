import {
  DEFAULT_RESEARCH_ENRICHMENT,
  type Enrichment,
  type KgProposal,
  KgProposalSchema,
  type KnowledgeBoxStatus,
  type TenantConfig,
  TenantConfigSchema,
  type TenantSummary,
} from '@research-portal/core'
import { envBindings, type KbBinding, regionalBase } from '@research-portal/retrieval'
import type { BrandingAsset, BrandingAssetStore, BrandingKind } from '../../api/src/app.ts'
import type { BindingStoreApi } from '../../api/src/bindings.ts'
import type { EnrichmentStoreApi } from '../../api/src/enrichments.ts'
import type { KgProposalStoreApi } from '../../api/src/kg.ts'
import type { Suggestion, SuggestionStoreApi } from '../../api/src/interrogate.ts'
import type {
  AskInsight,
  EnrichmentCollisionPolicy,
  EnrichmentImportResult,
  EnrichmentRecords,
  EvidenceItem,
  InsightsStoreApi,
  InsightsSummary,
  Investigation,
  InvestigationArtefact,
  InvestigationStoreApi,
  McpKeyRecord,
  McpKeyStoreApi,
  SessionsStoreApi,
  Source,
  SourceStoreApi,
  SourceSummary,
  StoredSession,
  Watch,
  WatchStoreApi,
} from '../../api/src/stores.ts'
import {
  type NewTenantInput,
  tenantConfig,
  type TenantPatch,
  type TenantStoreApi,
  tenantSummaries,
  tenantSummary,
  withPlatformHostname,
} from '../../api/src/tenants.ts'

type SqlValue = ArrayBuffer | string | number | null
type SqlRow = Record<string, SqlValue>

export interface SqlStorageLike {
  exec<T extends SqlRow>(query: string, ...bindings: unknown[]): {
    toArray(): T[]
    one(): T
  }
}

/**
 * A synchronous JSON/blob store over a Durable Object's SQLite database.
 * Keeping the adapter synchronous preserves the mature route/store contracts
 * while SQLite output gates make every mutation durable before the response.
 */
export class DurableState {
  constructor(private readonly sql: SqlStorageLike) {}

  migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branding_assets (
        key TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        content_type TEXT NOT NULL,
        version TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS enrichment_records (
        tenant_slug TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        enrichment TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_slug, agent_id, resource_id)
      );
    `)
  }

  get<T>(key: string, fallback: T): T {
    const row = this.sql.exec<{ value: string }>(
      'SELECT value FROM state WHERE key = ?',
      key,
    ).toArray()[0]
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch (error) {
      console.error(JSON.stringify({ message: 'invalid durable JSON', key, error: String(error) }))
      return fallback
    }
  }

  put(key: string, value: unknown): void {
    this.sql.exec(
      `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      Date.now(),
    )
  }

  delete(key: string): void {
    this.sql.exec('DELETE FROM state WHERE key = ?', key)
  }

  list<T>(prefix: string): { key: string; value: T }[] {
    return this.sql.exec<{ key: string; value: string }>(
      `SELECT key, value FROM state WHERE key LIKE ? ESCAPE '\\' ORDER BY key`,
      `${escapeLike(prefix)}%`,
    ).toArray().flatMap((row) => {
      try {
        return [{ key: row.key, value: JSON.parse(row.value) as T }]
      } catch (error) {
        console.error(
          JSON.stringify({ message: 'invalid durable JSON', key: row.key, error: String(error) }),
        )
        return []
      }
    })
  }

  enrichment(slug: string, agentId: string, resourceId: string): Enrichment | undefined {
    const row = this.sql.exec<{ enrichment: string }>(
      `SELECT enrichment FROM enrichment_records
       WHERE tenant_slug = ? AND agent_id = ? AND resource_id = ?`,
      slug,
      agentId,
      resourceId,
    ).toArray()[0]
    return row ? this.parseEnrichment(row.enrichment, slug, agentId, resourceId) : undefined
  }

  enrichmentRecords(slug: string): EnrichmentRecords {
    const rows = this.sql.exec<{
      agent_id: string
      resource_id: string
      enrichment: string
    }>(
      `SELECT agent_id, resource_id, enrichment FROM enrichment_records
       WHERE tenant_slug = ? ORDER BY agent_id, resource_id`,
      slug,
    ).toArray()
    const records: EnrichmentRecords = Object.create(null)
    for (const row of rows) {
      const enrichment = this.parseEnrichment(
        row.enrichment,
        slug,
        row.agent_id,
        row.resource_id,
      )
      if (!enrichment) continue
      const bucket = records[row.agent_id] ?? (records[row.agent_id] = Object.create(null))
      bucket[row.resource_id] = enrichment
    }
    return records
  }

  enrichmentsForAgent(slug: string, agentId: string): Record<string, Enrichment> {
    return this.enrichmentRecords(slug)[agentId] ?? {}
  }

  enrichmentCount(slug: string, agentId: string): number {
    return this.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM enrichment_records WHERE tenant_slug = ? AND agent_id = ?',
      slug,
      agentId,
    ).one().count
  }

  putEnrichment(slug: string, resourceId: string, enrichment: Enrichment): void {
    this.sql.exec(
      `INSERT INTO enrichment_records
        (tenant_slug, agent_id, resource_id, enrichment, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_slug, agent_id, resource_id) DO UPDATE SET
         enrichment = excluded.enrichment, updated_at = excluded.updated_at`,
      slug,
      enrichment.schemaId,
      resourceId,
      JSON.stringify(enrichment),
      Date.now(),
    )
  }

  importEnrichments(
    slug: string,
    records: EnrichmentRecords,
    collision: EnrichmentCollisionPolicy,
  ): EnrichmentImportResult {
    const existing = new Map<string, Set<string>>()
    for (
      const row of this.sql.exec<{ agent_id: string; resource_id: string }>(
        'SELECT agent_id, resource_id FROM enrichment_records WHERE tenant_slug = ?',
        slug,
      ).toArray()
    ) {
      const resources = existing.get(row.agent_id) ?? new Set<string>()
      resources.add(row.resource_id)
      existing.set(row.agent_id, resources)
    }

    let imported = 0
    let skipped = 0
    let overwritten = 0
    const now = Date.now()
    const writes: [string, string, string, string, number][] = []
    for (const [agentId, incoming] of Object.entries(records)) {
      const resources = existing.get(agentId) ?? new Set<string>()
      for (const [resourceId, enrichment] of Object.entries(incoming)) {
        const exists = resources.has(resourceId)
        if (exists && collision === 'skip') {
          skipped++
          continue
        }
        writes.push([
          slug,
          agentId,
          resourceId,
          JSON.stringify(enrichment),
          now,
        ])
        resources.add(resourceId)
        imported++
        if (exists) overwritten++
      }
      existing.set(agentId, resources)
    }

    // Twenty rows use exactly 100 bound parameters, the SQLite-backed
    // Durable Object maximum per query. Batching keeps a 3,163-record restore
    // comfortably inside the request CPU budget.
    for (let offset = 0; offset < writes.length; offset += 20) {
      const batch = writes.slice(offset, offset + 20)
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
      this.sql.exec(
        `INSERT INTO enrichment_records
          (tenant_slug, agent_id, resource_id, enrichment, updated_at)
         VALUES ${placeholders}
         ON CONFLICT(tenant_slug, agent_id, resource_id) DO UPDATE SET
           enrichment = excluded.enrichment, updated_at = excluded.updated_at`,
        ...batch.flat(),
      )
    }

    // SQLite-backed Durable Objects coalesce this uninterrupted synchronous
    // sequence into one atomic transaction, so no partial import is visible.
    return { imported, skipped, overwritten, reasons: { existing: skipped } }
  }

  private parseEnrichment(
    value: string,
    slug: string,
    agentId: string,
    resourceId: string,
  ): Enrichment | undefined {
    try {
      return JSON.parse(value) as Enrichment
    } catch (error) {
      console.error(JSON.stringify({
        message: 'invalid durable enrichment JSON',
        slug,
        agentId,
        resourceId,
        error: String(error),
      }))
      return undefined
    }
  }

  getAsset(key: string): BrandingAsset | null {
    const row = this.sql.exec<{
      bytes: ArrayBuffer
      content_type: string
      version: string
    }>(
      'SELECT bytes, content_type, version FROM branding_assets WHERE key = ?',
      key,
    ).toArray()[0]
    if (!row) return null
    return {
      bytes: new Uint8Array(row.bytes),
      contentType: row.content_type,
      version: row.version,
    }
  }

  putAsset(key: string, asset: BrandingAsset): void {
    const bytes = asset.bytes.buffer.slice(
      asset.bytes.byteOffset,
      asset.bytes.byteOffset + asset.bytes.byteLength,
    )
    this.sql.exec(
      `INSERT INTO branding_assets (key, bytes, content_type, version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes,
         content_type = excluded.content_type, version = excluded.version,
         updated_at = excluded.updated_at`,
      key,
      bytes,
      asset.contentType,
      asset.version,
      Date.now(),
    )
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function segment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
}

function key(...parts: string[]): string {
  return parts.map(segment).join(':')
}

/** Copy only string bindings out of the generated Cloudflare Env object. */
export function stringEnv(env: object): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') result[name] = value
  }
  return result
}

export class DurableBindingStore implements BindingStoreApi {
  private readonly demo: Record<string, KbBinding>

  constructor(private readonly state: DurableState, env: Record<string, string | undefined>) {
    this.demo = envBindings(env)
    const connected = this.connected()
    const zone = env.ARAG_ZONE
    if (!zone) return
    let changed = false
    for (const entry of Object.values(connected)) {
      if (!entry.baseUrl && entry.kbId) {
        entry.baseUrl = `${regionalBase(zone)}/kb/${entry.kbId}`
        changed = true
      }
    }
    if (changed) this.state.put('bindings', connected)
  }

  private connected(): Record<string, KbBinding & { connectedAt: string }> {
    return this.state.get('bindings', {})
  }

  get(slug: string): KbBinding | undefined {
    return this.connected()[slug] ?? this.demo[slug]
  }

  isDemo(slug: string): boolean {
    return !this.connected()[slug] && Boolean(this.demo[slug])
  }

  set(slug: string, binding: KbBinding): void {
    const connected = this.connected()
    connected[slug] = { ...binding, connectedAt: new Date().toISOString() }
    this.state.put('bindings', connected)
  }

  remove(slug: string): void {
    const connected = this.connected()
    delete connected[slug]
    this.state.put('bindings', connected)
  }

  status(slug: string): KnowledgeBoxStatus {
    const connected = this.connected()[slug]
    if (connected) return { slug, status: 'connected', kbId: truncate(displayId(connected)) }
    const demo = this.demo[slug]
    if (demo) return { slug, status: 'demo', kbId: truncate(displayId(demo)) }
    return { slug, status: 'none' }
  }
}

const displayId = (binding: KbBinding) =>
  binding.kbId ?? binding.baseUrl.split('/').pop() ?? binding.baseUrl
const truncate = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)

interface TenantState {
  custom: Record<string, TenantConfig>
  overrides: Record<string, TenantPatch>
  disabled: string[]
}

const DEFAULT_COLOURS = {
  primary: '#27364b',
  accent: '#5a8bd6',
  heroFrom: '#141d2b',
  heroTo: '#27364b',
}

export class DurableTenantStore implements TenantStoreApi {
  constructor(private readonly state: DurableState) {}

  private load(): TenantState {
    const raw = this.state.get<Partial<TenantState>>('tenants', {})
    const custom: Record<string, TenantConfig> = {}
    for (const [slug, value] of Object.entries(raw.custom ?? {})) {
      const parsed = TenantConfigSchema.safeParse(value)
      if (parsed.success) custom[slug] = parsed.data
    }
    return {
      custom,
      overrides: raw.overrides ?? {},
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
    }
  }

  private save(value: TenantState): void {
    this.state.put('tenants', value)
  }

  /** Seed a tenant copied from the small platform registry into its tenant DO. */
  seed(config: TenantConfig): void {
    if (tenantConfig(config.slug)) return
    const data = this.load()
    data.custom[config.slug] = TenantConfigSchema.parse(config)
    this.save(data)
  }

  get(slug: string): TenantConfig | undefined {
    const data = this.load()
    const base = tenantConfig(slug) ?? data.custom[slug]
    if (!base) return undefined
    const override = data.overrides[slug]
    if (!override) return withPlatformHostname(base)
    const { prompts: _prompts, ...configPatch } = override
    return withPlatformHostname({ ...base, ...configPatch })
  }

  promptsFor(slug: string): { ask?: string; images?: boolean } {
    return this.load().overrides[slug]?.prompts ?? {}
  }

  isCustom(slug: string): boolean {
    return Boolean(this.load().custom[slug]) && !tenantConfig(slug)
  }

  isDisabled(slug: string): boolean {
    return this.load().disabled.includes(slug)
  }

  setDisabled(slug: string, disabled: boolean): void {
    const data = this.load()
    const set = new Set(data.disabled)
    if (disabled) set.add(slug)
    else set.delete(slug)
    this.save({ ...data, disabled: [...set] })
  }

  patchBranding(
    slug: string,
    branding: {
      productName?: string
      organisation?: string
      tagline?: string
      colours?: TenantConfig['branding']['colours']
      typography?: TenantConfig['branding']['typography']
      shape?: TenantConfig['branding']['shape']
      textScale?: TenantConfig['branding']['textScale']
      density?: TenantConfig['branding']['density']
      paletteId?: TenantConfig['branding']['paletteId']
    },
  ): void {
    const base = this.get(slug)
    if (!base) return
    const data = this.load()
    const merged = {
      ...base.branding,
      ...(branding.productName ? { productName: branding.productName } : {}),
      ...(branding.organisation ? { organisation: branding.organisation } : {}),
      ...(branding.tagline ? { tagline: branding.tagline } : {}),
      ...(branding.colours ? { colours: branding.colours } : {}),
      ...(branding.typography ? { typography: branding.typography } : {}),
      ...(branding.shape ? { shape: branding.shape } : {}),
      ...(branding.textScale ? { textScale: branding.textScale } : {}),
      ...(branding.density ? { density: branding.density } : {}),
      ...(branding.paletteId ? { paletteId: branding.paletteId } : {}),
    }
    if (data.custom[slug]) data.custom[slug] = { ...data.custom[slug], branding: merged }
    else data.overrides[slug] = { ...data.overrides[slug], branding: merged }
    this.save(data)
  }

  patch(slug: string, patch: TenantPatch): void {
    const data = this.load()
    data.overrides[slug] = { ...data.overrides[slug], ...patch }
    this.save(data)
  }

  list(includeDisabled = false): TenantSummary[] {
    const data = this.load()
    const rows = [
      ...tenantSummaries(),
      ...Object.values(data.custom).map((tenant) =>
        tenantSummary(this.get(tenant.slug) ?? withPlatformHostname(tenant))
      ),
    ]
    return includeDisabled ? rows : rows.filter((row) => !data.disabled.includes(row.slug))
  }

  add(input: NewTenantInput): TenantConfig {
    const data = this.load()
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!base) throw new Error('The portal name must contain letters or numbers')
    let slug = base
    for (let index = 2; this.get(slug); index += 1) slug = `${base}-${index}`
    const config = TenantConfigSchema.parse({
      slug,
      branding: {
        productName: input.name,
        organisation: input.organisation?.trim() || input.name,
        tagline: input.tagline?.trim() || 'Research, discovery and development',
        colours: DEFAULT_COLOURS,
      },
      searchPlaceholder: 'Search this portal…',
      topics: [],
      suggestedQuestions: [],
      entityTypes: [],
      relationTypes: [],
    })
    const configured = withPlatformHostname(config)
    data.custom[slug] = configured
    this.save(data)
    return configured
  }

  remove(slug: string): boolean {
    const data = this.load()
    if (!data.custom[slug] || tenantConfig(slug)) return false
    delete data.custom[slug]
    delete data.overrides[slug]
    data.disabled = data.disabled.filter((item) => item !== slug)
    this.save(data)
    return true
  }
}

export class DurableInsightsStore implements InsightsStoreApi {
  constructor(private readonly state: DurableState) {}

  private all(slug: string): AskInsight[] {
    return this.state.get(key('insights', slug), [])
  }

  record(slug: string, insight: AskInsight): void {
    const all = this.all(slug)
    all.push(insight)
    this.state.put(key('insights', slug), all.slice(-50_000))
  }

  summary(slug: string, days = 90): InsightsSummary {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    const all = this.all(slug).filter((item) => Date.parse(item.ts) >= cutoff)
    const answered = all.filter((item) => item.answered)
    const counts = new Map<string, number>()
    for (const item of all) {
      const normalised = item.question.trim().toLowerCase().replace(/[?.!]+$/, '')
      counts.set(normalised, (counts.get(normalised) ?? 0) + 1)
    }
    const average = (values: (number | null)[]): number | null => {
      const numbers = values.filter((value): value is number => value !== null)
      return numbers.length
        ? Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10
        : null
    }
    return {
      totalAsks: all.length,
      answered: answered.length,
      unanswered: all.length - answered.length,
      avgGroundedness: average(answered.map((item) => item.groundedness)),
      avgAnswerRelevance: average(answered.map((item) => item.answerRelevance)),
      topQuestions: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(
        ([question, count]) => ({ question, count }),
      ),
      gaps: all.filter((item) =>
        !item.answered || (item.groundedness !== null && item.groundedness <= 2)
      ).slice(-30).reverse().map((item) => ({
        question: item.question,
        ts: item.ts,
        reason: !item.answered
          ? 'No answer found in the corpus'
          : `Weak grounding (${item.groundedness}/5)`,
      })),
      recent: all.slice(-25).reverse(),
    }
  }
}

export class DurableSessionsStore implements SessionsStoreApi {
  constructor(private readonly state: DurableState) {}

  private prefix(slug: string, clientId: string): string {
    return key('session', slug, clientId) + ':'
  }

  list(slug: string, clientId: string): { id: string; title: string; updatedAt: string }[] {
    return this.state.list<StoredSession>(this.prefix(slug, clientId)).map(({ value }) => ({
      id: value.id,
      title: value.title,
      updatedAt: value.updatedAt,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100)
  }

  get(slug: string, clientId: string, id: string): StoredSession | null {
    return this.state.get(this.prefix(slug, clientId) + segment(id), null)
  }

  put(slug: string, clientId: string, session: StoredSession): void {
    this.state.put(this.prefix(slug, clientId) + segment(session.id), session)
  }

  remove(slug: string, clientId: string, id: string): void {
    this.state.delete(this.prefix(slug, clientId) + segment(id))
  }
}

export class DurableWatchStore implements WatchStoreApi {
  constructor(private readonly state: DurableState) {}

  list(slug: string, clientId?: string): Watch[] {
    const all = this.state.get<Watch[]>(key('watches', slug), [])
    return clientId ? all.filter((watch) => watch.clientId === clientId) : all
  }

  add(slug: string, clientId: string, query: string): Watch {
    const all = this.list(slug)
    const trimmed = query.trim()
    const existing = all.find((watch) => watch.clientId === clientId && watch.query === trimmed)
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
    const mine = all.filter((item) => item.clientId === clientId)
    const keep = mine.length >= 50 ? all.filter((item) => item !== mine[0]) : all
    this.state.put(key('watches', slug), [...keep, watch])
    return watch
  }

  update(slug: string, id: string, patch: Partial<Watch>, clientId?: string): void {
    this.state.put(
      key('watches', slug),
      this.list(slug).map((watch) =>
        watch.id === id && (clientId === undefined || watch.clientId === clientId)
          ? { ...watch, ...patch }
          : watch
      ),
    )
  }

  remove(slug: string, clientId: string, id: string): void {
    this.state.put(
      key('watches', slug),
      this.list(slug).filter((watch) => !(watch.id === id && watch.clientId === clientId)),
    )
  }
}

export class DurableSourceStore implements SourceStoreApi {
  constructor(private readonly state: DurableState) {}

  private storageKey(slug: string): string {
    return key('sources', slug)
  }

  list(slug: string): Source[] {
    return this.state.get(this.storageKey(slug), [])
  }

  summaries(slug: string): SourceSummary[] {
    return this.list(slug).map(({ synced, ...rest }) => ({
      ...rest,
      itemCount: rest.itemCount ?? synced?.length ?? 0,
    }))
  }

  find(slug: string, id: string): Source | undefined {
    return this.list(slug).find((source) => source.id === id)
  }

  findByUrl(slug: string, url: string): Source | undefined {
    return this.list(slug).find((source) => source.url === url)
  }

  slugs(): string[] {
    return this.state.list<Source[]>('sources:').map(({ key: storageKey }) =>
      storageKey.slice('sources:'.length)
    )
  }

  add(slug: string, url: string, auto: boolean, maxPages?: number): Source {
    const all = this.list(slug)
    const existing = all.find((source) => source.url === url)
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
    this.state.put(this.storageKey(slug), [...all, source])
    return source
  }

  update(slug: string, id: string, patch: Partial<Source>): void {
    this.state.put(
      this.storageKey(slug),
      this.list(slug).map((source) => source.id === id ? { ...source, ...patch } : source),
    )
  }

  remove(slug: string, id: string): void {
    this.state.put(
      this.storageKey(slug),
      this.list(slug).filter((source) => source.id !== id),
    )
  }
}

export class DurableInvestigationStore implements InvestigationStoreApi {
  constructor(private readonly state: DurableState) {}

  private prefix(slug: string, clientId: string): string {
    return key('investigation', slug, clientId) + ':'
  }

  private storageKey(slug: string, clientId: string, id: string): string {
    return this.prefix(slug, clientId) + segment(id)
  }

  list(slug: string, clientId: string) {
    return this.state.list<Investigation>(this.prefix(slug, clientId)).map(({ value }) => ({
      id: value.id,
      name: value.name,
      question: value.question,
      status: value.status,
      updatedAt: value.updatedAt,
      evidenceCount: value.evidence.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(slug: string, clientId: string, id: string): Investigation | null {
    return this.state.get(this.storageKey(slug, clientId, id), null)
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
    this.state.put(this.storageKey(slug, clientId, investigation.id), investigation)
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
    this.state.put(this.storageKey(slug, clientId, id), next)
    return next
  }

  remove(slug: string, clientId: string, id: string): void {
    this.state.delete(this.storageKey(slug, clientId, id))
  }

  addEvidence(
    slug: string,
    clientId: string,
    id: string,
    input: Omit<EvidenceItem, 'id' | 'createdAt'>,
  ): EvidenceItem | null {
    const current = this.get(slug, clientId, id)
    if (!current || current.evidence.length >= 500) return null
    const duplicate = current.evidence.find((item) =>
      item.resourceId === input.resourceId && item.passage === input.passage
    )
    if (duplicate) return duplicate
    const item: EvidenceItem = {
      ...input,
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      createdAt: new Date().toISOString(),
    }
    current.evidence.push(item)
    current.updatedAt = item.createdAt
    this.state.put(this.storageKey(slug, clientId, id), current)
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
    const index = current.evidence.findIndex((item) => item.id === evidenceId)
    if (index < 0) return false
    current.evidence[index] = { ...current.evidence[index]!, ...patch }
    current.updatedAt = new Date().toISOString()
    this.state.put(this.storageKey(slug, clientId, id), current)
    return true
  }

  removeEvidence(slug: string, clientId: string, id: string, evidenceId: string): void {
    const current = this.get(slug, clientId, id)
    if (!current) return
    current.evidence = current.evidence.filter((item) => item.id !== evidenceId)
    current.updatedAt = new Date().toISOString()
    this.state.put(this.storageKey(slug, clientId, id), current)
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
    this.state.put(this.storageKey(slug, clientId, id), current)
    return artefact
  }
}

export class DurableSuggestionStore implements SuggestionStoreApi {
  constructor(private readonly state: DurableState) {}

  list(slug: string): Suggestion[] {
    return this.state.get(key('suggestions', slug), [])
  }

  replacePending(slug: string, fresh: Suggestion[]): Suggestion[] {
    const kept = this.list(slug).filter((suggestion) => suggestion.status !== 'pending').slice(-40)
    const next = [...fresh, ...kept]
    this.state.put(key('suggestions', slug), next)
    return next
  }

  setStatus(
    slug: string,
    id: string,
    status: 'implemented' | 'ignored',
  ): Suggestion | null {
    const all = this.list(slug)
    const found = all.find((suggestion) => suggestion.id === id)
    if (!found) return null
    found.status = status
    this.state.put(key('suggestions', slug), all)
    return found
  }
}

export class DurableEnrichmentStore implements EnrichmentStoreApi {
  private readonly migratedSlugs = new Set<string>()

  constructor(private readonly state: DurableState) {}

  private migrateLegacy(slug: string): void {
    if (this.migratedSlugs.has(slug)) return
    const legacyKey = key('enrichments', slug)
    const legacy = this.state.get<EnrichmentRecords>(legacyKey, {})
    if (Object.keys(legacy).length > 0) {
      this.state.importEnrichments(slug, legacy, 'skip')
      this.state.delete(legacyKey)
    }
    this.migratedSlugs.add(slug)
  }

  get(
    slug: string,
    resourceId: string,
    schemaId = DEFAULT_RESEARCH_ENRICHMENT.id,
  ): Enrichment | undefined {
    this.migrateLegacy(slug)
    return this.state.enrichment(slug, schemaId, resourceId)
  }

  forAgent(slug: string, schemaId = DEFAULT_RESEARCH_ENRICHMENT.id): Record<string, Enrichment> {
    this.migrateLegacy(slug)
    return this.state.enrichmentsForAgent(slug, schemaId)
  }

  put(slug: string, resourceId: string, enrichment: Enrichment): void {
    this.migrateLegacy(slug)
    this.state.putEnrichment(slug, resourceId, enrichment)
  }

  count(slug: string, schemaId = DEFAULT_RESEARCH_ENRICHMENT.id): number {
    this.migrateLegacy(slug)
    return this.state.enrichmentCount(slug, schemaId)
  }

  exportRecords(slug: string): EnrichmentRecords {
    this.migrateLegacy(slug)
    return this.state.enrichmentRecords(slug)
  }

  importRecords(
    slug: string,
    records: EnrichmentRecords,
    collision: EnrichmentCollisionPolicy,
  ): EnrichmentImportResult {
    this.migrateLegacy(slug)
    return this.state.importEnrichments(slug, records, collision)
  }
}

export class DurableKgProposalStore implements KgProposalStoreApi {
  constructor(private readonly state: DurableState) {}

  get(slug: string): KgProposal | undefined {
    const parsed = KgProposalSchema.safeParse(
      this.state.get<Record<string, unknown>>('kg-proposals', {})[slug],
    )
    return parsed.success ? parsed.data : undefined
  }

  set(slug: string, proposal: KgProposal): void {
    const all = this.state.get<Record<string, unknown>>('kg-proposals', {})
    all[slug] = proposal
    this.state.put('kg-proposals', all)
  }
}

export class DurableBrandingStore implements BrandingAssetStore {
  constructor(private readonly state: DurableState) {}

  get(slug: string, kind: BrandingKind): BrandingAsset | null {
    return this.state.getAsset(key('branding', slug, kind))
  }

  put(slug: string, kind: BrandingKind, asset: BrandingAsset): void {
    this.state.putAsset(key('branding', slug, kind), asset)
  }
}

export class DurableMcpKeyStore implements McpKeyStoreApi {
  constructor(private readonly state: DurableState) {}

  private storageKey(slug: string): string {
    return key('mcp-keys', slug)
  }

  list(slug: string): McpKeyRecord[] {
    return this.state.get<McpKeyRecord[]>(this.storageKey(slug), [])
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
    this.state.put(this.storageKey(record.tenant), [...all, record])
  }

  revoke(slug: string, id: string, revokedAt: string): boolean {
    const all = this.list(slug)
    const found = all.find((record) => record.id === id)
    if (!found) return false
    if (!found.revokedAt) found.revokedAt = revokedAt
    this.state.put(this.storageKey(slug), all)
    return true
  }
}

export interface DurableStores {
  bindings: DurableBindingStore
  tenants: DurableTenantStore
  insights: DurableInsightsStore
  sessions: DurableSessionsStore
  watches: DurableWatchStore
  sources: DurableSourceStore
  investigations: DurableInvestigationStore
  suggestions: DurableSuggestionStore
  enrichments: DurableEnrichmentStore
  kgProposals: DurableKgProposalStore
  branding: DurableBrandingStore
  mcpKeys: DurableMcpKeyStore
}

export function durableStores(
  state: DurableState,
  env: Record<string, string | undefined>,
): DurableStores {
  return {
    bindings: new DurableBindingStore(state, env),
    tenants: new DurableTenantStore(state),
    insights: new DurableInsightsStore(state),
    sessions: new DurableSessionsStore(state),
    watches: new DurableWatchStore(state),
    sources: new DurableSourceStore(state),
    investigations: new DurableInvestigationStore(state),
    suggestions: new DurableSuggestionStore(state),
    enrichments: new DurableEnrichmentStore(state),
    kgProposals: new DurableKgProposalStore(state),
    branding: new DurableBrandingStore(state),
    mcpKeys: new DurableMcpKeyStore(state),
  }
}
