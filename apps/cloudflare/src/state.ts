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
import { type RbacDatabase, RbacState, type RbacStores } from '../../api/src/rbac-state.ts'
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
  RoutingLogApi,
  RoutingRecord,
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
  tenantRecord,
  type TenantStoreApi,
  tenantSummaries,
  tenantSummary,
  validateTenantPatch,
  withPlatformHostname,
} from '../../api/src/tenants.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  appendAudit,
  type AuditInput,
  AuditWriteError,
  createAuditEvent,
} from '../../api/src/audit.ts'
import type { LocalMutationScope } from '../../api/src/audit-execution.ts'
import { DECLARATIONS } from '../../api/src/permissions.ts'
import {
  decodeScopedKeyRecords,
  KeyPortalSlugSchema,
  KeyTimeSchema,
  migrateLegacyKeyRecord,
  type ScopedKeyRecord,
} from '../../api/src/scoped-key-record.ts'

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
interface LocalContext {
  input: Omit<AuditInput, 'outcome'>
  signal: AbortSignal
  closed: boolean
  failure?: AuditWriteError
  parent?: LocalContext
}

export class DurableState {
  readonly rbacDatabase: RbacDatabase
  readonly rbac: RbacState
  private readonly localContext = new AsyncLocalStorage<LocalContext>()
  private mutating = false
  readonly localMutations: LocalMutationScope = {
    run: (input, signal, work) => {
      const parent = this.localContext.getStore()
      const context: LocalContext = {
        input,
        signal,
        closed: false,
        parent: parent?.input.requestId === input.requestId ? parent : undefined,
        failure: undefined as AuditWriteError | undefined,
      }
      return this.localContext.run(context, async () => {
        try {
          const result = await work()
          if (context.failure) throw context.failure
          return result
        } catch (error) {
          throw context.failure ?? error
        } finally {
          context.closed = true
        }
      })
    },
  }

  /** Covers whole synchronous store methods, including their multiple SQL statements. */
  localMutation<T>(operation: string, args: unknown[], work: () => T): T {
    const context = this.localContext.getStore()
    if (!context) return work()
    this.guardLocalScope()
    const declaration = DECLARATIONS.find((d) => d.kind === 'local' && d.path === operation)
    if (!declaration) throw this.failLocalAudit()
    if (this.mutating) return work()
    try {
      return this.rbacDatabase.transactionSync(() => {
        this.mutating = true
        const result = work()
        const first = args[0] as
          | { tenant?: string; slug?: string; id?: string }
          | string
          | undefined
        const slug = typeof first === 'string' ? first : first?.tenant
        const returnedId = typeof result === 'object' && result !== null && 'id' in result
          ? result.id
          : typeof result === 'object' && result !== null && 'slug' in result
          ? result.slug
          : undefined
        const [store, method] = operation.split('.')
        const argumentId = store === 'sessions'
          ? (method === 'put' ? (args[2] as { id: string }).id : args[2])
          : store === 'investigations'
          ? (method === 'updateEvidence' || method === 'removeEvidence' ? args[3] : args[2])
          : store === 'watches'
          ? (method === 'remove' ? args[2] : method === 'update' ? args[1] : undefined)
          : ['sources', 'mcpKeys', 'enrichments', 'branding', 'suggestions'].includes(store!)
          ? args[1]
          : typeof first === 'string'
          ? first
          : first?.slug
        const id = returnedId ?? (typeof first === 'object' ? first?.id : undefined) ??
          (typeof argumentId === 'string' ? argumentId : undefined) ?? context.input.target.id
        const safeId = typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(id)
          ? id
          : undefined
        const detail = context.input.detail as Record<string, unknown>
        appendAudit(
          this.rbac.audit,
          createAuditEvent({
            ...context.input,
            action: 'local.mutation',
            outcome: 'success',
            scope: declaration.scope === 'platform'
              ? { kind: 'platform' }
              : slug
              ? { kind: 'portal', slug }
              : context.input.scope,
            target: { kind: operation.split('.')[0]!, ...(safeId ? { id: safeId } : {}) },
            detail: {
              permission: declaration.permission,
              mutation: operation,
              ...(detail?.operation ? { operation: detail.operation } : {}),
              ...(detail?.sessionOid
                ? { sessionOid: detail.sessionOid, sessionTenantId: detail.sessionTenantId }
                : {}),
            },
          }),
        )
        return result
      })
    } catch (error) {
      if (error instanceof AuditWriteError) this.failLocalAudit(error)
      throw error
    } finally {
      this.mutating = false
    }
  }

  private failLocalAudit(error = new AuditWriteError()): AuditWriteError {
    for (let context = this.localContext.getStore(); context; context = context.parent) {
      context.failure = error
    }
    return error
  }

  private guardLocalScope(): void {
    for (let context = this.localContext.getStore(); context; context = context.parent) {
      context.signal.throwIfAborted()
      if (context.failure) throw context.failure
      if (context.closed) throw this.failLocalAudit()
    }
  }

  /** Fail closed if a new store method bypasses the declared synchronous boundary. */
  private guardLocalWrite(): void {
    const context = this.localContext.getStore()
    if (!context) return
    this.guardLocalScope()
    if (!this.mutating) throw this.failLocalAudit()
  }

  auditedStore<T extends object>(name: string, store: T): T {
    return new Proxy(store, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        const operation = `${name}.${String(property)}`
        if (!DECLARATIONS.some((d) => d.kind === 'local' && d.path === operation)) {
          return value.bind(target)
        }
        return (...args: unknown[]) =>
          this.localMutation(operation, args, () => value.apply(target, args))
      },
    })
  }

  constructor(
    private readonly sql: SqlStorageLike,
    private readonly transactions?: Pick<RbacDatabase, 'transactionSync'>,
    now: () => number = Date.now,
  ) {
    let inTransaction = false
    const transactionSync = <T>(callback: () => T): T => {
      if (!transactions) throw new Error('RBAC requires a transaction capability')
      if (inTransaction) throw new Error('Nested RBAC transactions are not supported')
      if (callback.constructor.name === 'AsyncFunction') {
        throw new Error('RBAC transactions must be synchronous')
      }
      return transactions.transactionSync(() => {
        inTransaction = true
        try {
          const result = callback()
          if (
            result !== null && (typeof result === 'object' || typeof result === 'function') &&
            'then' in result
          ) {
            throw new Error('RBAC transactions must be synchronous')
          }
          return result
        } finally {
          inTransaction = false
        }
      })
    }
    this.rbacDatabase = {
      exec: (query, ...bindings) => {
        const write = () => {
          sql.exec(query, ...bindings)
        }
        if (inTransaction) write()
        else transactionSync(write)
      },
      all: <T extends object>(
        query: string,
        ...bindings: import('../../api/src/rbac-state.ts').SqlValue[]
      ): T[] => sql.exec(query, ...bindings).toArray() as T[],
      transactionSync,
    }
    this.rbac = new RbacState(this.rbacDatabase, now)
  }

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
      CREATE TABLE IF NOT EXISTS routing_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_slug TEXT NOT NULL,
        record TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS routing_records_by_tenant
        ON routing_records (tenant_slug, id);
    `)
    // Legacy construction remains usable until the Worker injects storage in plan 02-04.
    if (this.transactions) this.rbac.migrate()
    // Startup only: lookups cannot create an internal system actor or rewrite key state.
    const changes = this.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM state WHERE key LIKE 'mcp-keys:%'",
    ).toArray().flatMap((row) => {
      const slug = KeyPortalSlugSchema.parse(row.key.slice('mcp-keys:'.length))
      const raw: unknown = JSON.parse(row.value)
      const records = decodeScopedKeyRecords(raw, slug)
      return (raw as { v?: number }[]).some((record) => record.v === undefined)
        ? [{ key: row.key, slug, records }]
        : []
    })
    if (changes.length) {
      this.rbacDatabase.transactionSync(() => {
        for (const change of changes) {
          this.put(change.key, change.records)
          appendAudit(
            this.rbac.audit,
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
    }
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
      if (key.startsWith('mcp-keys:')) throw new Error('Invalid persisted key state')
      console.error(JSON.stringify({ message: 'invalid durable JSON', key, error: String(error) }))
      if (key === 'tenants') throw new Error('Invalid persisted portal configuration')
      return fallback
    }
  }

  put(key: string, value: unknown): void {
    this.guardLocalWrite()
    this.sql.exec(
      `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      Date.now(),
    )
  }

  delete(key: string): void {
    this.guardLocalWrite()
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

  /** Append one routing decision and trim the tenant's log to `keep` rows. */
  appendRouting(slug: string, record: unknown, keep: number): void {
    this.guardLocalWrite()
    this.sql.exec(
      'INSERT INTO routing_records (tenant_slug, record, created_at) VALUES (?, ?, ?)',
      slug,
      JSON.stringify(record),
      Date.now(),
    )
    this.sql.exec(
      `DELETE FROM routing_records WHERE tenant_slug = ? AND id NOT IN (
         SELECT id FROM routing_records WHERE tenant_slug = ? ORDER BY id DESC LIMIT ?
       )`,
      slug,
      slug,
      keep,
    )
  }

  /** The tenant's routing decisions, newest first, at most `limit`. */
  routingRecords<T>(slug: string, limit: number): T[] {
    const rows = this.sql.exec<{ record: string }>(
      'SELECT record FROM routing_records WHERE tenant_slug = ? ORDER BY id DESC LIMIT ?',
      slug,
      limit,
    ).toArray()
    const out: T[] = []
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.record) as T)
      } catch {
        // a torn row is skipped, as the file-backed log skips a torn line
      }
    }
    return out
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
    this.guardLocalWrite()
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
    this.guardLocalWrite()
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
    this.guardLocalWrite()
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
  custom: Record<string, unknown>
  overrides: Record<string, unknown>
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
    const raw = tenantRecord(this.state.get<unknown>('tenants', {}))
    return {
      custom: Object.hasOwn(raw, 'custom') ? tenantRecord(raw.custom) : {},
      overrides: Object.hasOwn(raw, 'overrides') ? tenantRecord(raw.overrides) : {},
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
    const custom = Object.hasOwn(data.custom, slug)
      ? TenantConfigSchema.parse(data.custom[slug])
      : undefined
    if (custom && custom.slug !== slug) throw new Error('Invalid persisted portal slug')
    const base = tenantConfig(slug) ?? custom
    if (!base) return undefined
    if (!Object.hasOwn(data.overrides, slug)) return withPlatformHostname(base)
    const override = validateTenantPatch(data.overrides[slug])
    const { prompts: _prompts, ...configPatch } = override
    return withPlatformHostname(TenantConfigSchema.parse({ ...base, ...configPatch }))
  }

  promptsFor(slug: string): { ask?: string; images?: boolean } {
    this.get(slug)
    return this.existingPatch(this.load(), slug).prompts ?? {}
  }

  private existingPatch(data: TenantState, slug: string): TenantPatch {
    return Object.hasOwn(data.overrides, slug) ? validateTenantPatch(data.overrides[slug]) : {}
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
    if (data.custom[slug]) {
      data.custom[slug] = { ...TenantConfigSchema.parse(data.custom[slug]), branding: merged }
    } else data.overrides[slug] = { ...this.existingPatch(data, slug), branding: merged }
    this.save(data)
  }

  patch(slug: string, patch: TenantPatch): void {
    validateTenantPatch(patch)
    const base = this.get(slug)
    if (!base) throw new Error('Unknown portal')
    TenantConfigSchema.parse({ ...base, ...patch })
    const data = this.load()
    data.overrides[slug] = { ...this.existingPatch(data, slug), ...patch }
    this.save(data)
  }

  list(includeDisabled = false): TenantSummary[] {
    const data = this.load()
    const rows: TenantSummary[] = []
    const slugs = new Set([
      ...tenantSummaries().map((row) => row.slug),
      ...Object.keys(data.custom),
    ])
    for (const slug of slugs) {
      try {
        const config = this.get(slug)
        if (config) rows.push(tenantSummary(config))
      } catch {
        // Corrupt portal configuration never appears in an aggregate response.
      }
    }
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
  constructor(private readonly state: DurableState) {}

  private migrateLegacy(slug: string): void {
    const legacyKey = key('enrichments', slug)
    const legacy = this.state.get<EnrichmentRecords>(legacyKey, {})
    if (Object.keys(legacy).length > 0) {
      this.state.localMutation('enrichments.migrateLegacy', [slug], () => {
        this.state.importEnrichments(slug, legacy, 'skip')
        this.state.delete(legacyKey)
      })
    }
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
    return key('mcp-keys', KeyPortalSlugSchema.parse(slug))
  }

  list(slug: string): ScopedKeyRecord[] {
    return decodeScopedKeyRecords(this.state.get<unknown>(this.storageKey(slug), []), slug)
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
    this.state.put(this.storageKey(record.tenant), all)
  }

  revoke(slug: string, id: string, revokedAt: string): boolean {
    KeyTimeSchema.parse(revokedAt)
    const all = this.list(slug)
    const found = all.find((record) => record.id === id)
    if (!found) return false
    if (!found.revokedAt) found.revokedAt = revokedAt
    this.state.put(this.storageKey(slug), all)
    return true
  }
}

/**
 * Intent-routing decisions per tenant in their own table: one append and
 * one trim per decision, never a rewrite of the whole history.
 */
export class DurableRoutingLog implements RoutingLogApi {
  /** Rows kept per tenant: the evaluation set the admin Routing panel reads. */
  static readonly KEEP = 5_000

  constructor(
    private readonly state: DurableState,
    private readonly keep: number = DurableRoutingLog.KEEP,
  ) {}

  record(slug: string, entry: RoutingRecord): void {
    this.state.appendRouting(slug, entry, this.keep)
  }

  recent(slug: string, limit = 50): RoutingRecord[] {
    return this.state.routingRecords<RoutingRecord>(slug, limit)
  }

  summary(
    slug: string,
  ): { total: number; byIntent: Record<string, number>; byStage: Record<string, number> } {
    const byIntent: Record<string, number> = {}
    const byStage: Record<string, number> = {}
    const rows = this.state.routingRecords<RoutingRecord>(slug, this.keep)
    for (const r of rows) {
      byIntent[r.intent] = (byIntent[r.intent] ?? 0) + 1
      byStage[r.stage] = (byStage[r.stage] ?? 0) + 1
    }
    return { total: rows.length, byIntent, byStage }
  }
}

export interface DurableStores extends RbacStores {
  localMutations: LocalMutationScope
  rbac: RbacState
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
  routing: DurableRoutingLog
}

export function durableStores(
  state: DurableState,
  env: Record<string, string | undefined>,
): DurableStores {
  return {
    localMutations: state.localMutations,
    rbac: state.rbac,
    audit: state.rbac.audit,
    assignments: state.rbac.assignments,
    locks: state.rbac.locks,
    bindings: state.auditedStore('bindings', new DurableBindingStore(state, env)),
    tenants: state.auditedStore('tenants', new DurableTenantStore(state)),
    insights: state.auditedStore('insights', new DurableInsightsStore(state)),
    sessions: state.auditedStore('sessions', new DurableSessionsStore(state)),
    watches: state.auditedStore('watches', new DurableWatchStore(state)),
    sources: state.auditedStore('sources', new DurableSourceStore(state)),
    investigations: state.auditedStore('investigations', new DurableInvestigationStore(state)),
    suggestions: state.auditedStore('suggestions', new DurableSuggestionStore(state)),
    enrichments: state.auditedStore('enrichments', new DurableEnrichmentStore(state)),
    kgProposals: state.auditedStore('kgProposals', new DurableKgProposalStore(state)),
    branding: state.auditedStore('branding', new DurableBrandingStore(state)),
    mcpKeys: state.auditedStore('mcpKeys', new DurableMcpKeyStore(state)),
    routing: state.auditedStore('routing', new DurableRoutingLog(state)),
  }
}
