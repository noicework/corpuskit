import type {
  AdminTenantOverview,
  AnalyseEvent,
  AskEvent,
  CatalogPage,
  DensityId,
  EnrichmentAgentStatus,
  EnrichmentRunEvent,
  FacetCounts,
  GenerateKind,
  GenerateResult,
  GraphData,
  KbAgent,
  KbCounters,
  KgImplementEvent,
  KgProposal,
  KnowledgeBoxStatus,
  Labelset,
  MigrationEvent,
  PaletteChoice,
  Question,
  RecentResource,
  ResourceContent,
  ResourceSummary,
  RetrievalMode,
  SearchResults,
  ShapeId,
  TenantConfig,
  TenantSummary,
  TextScaleId,
  TypographyChoice,
} from '@research-portal/core'

/**
 * Typed error thrown by every helper below. Carries the HTTP status so callers
 * (e.g. TenantLayout) can branch on 404 vs other failures.
 */
export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Human-readable fallbacks for the API's machine error codes. */
const ERROR_COPY: Record<string, string> = {
  knowledge_box_not_connected:
    'This portal is not connected to its content yet - an administrator can connect it from Administration.',
  unknown_tenant: 'This portal does not exist or has been removed.',
  management_unavailable: 'The content service is not available right now - try again shortly.',
  summarize_failed: 'The summary could not be generated - try fewer documents or try again.',
  empty_summary: 'The platform returned an empty summary - try different documents.',
  feedback_failed: 'The feedback could not be sent - try again shortly.',
  internal_error: 'Something went wrong on our side - try again shortly.',
  invalid_request: 'The request was not valid - check the details and try again.',
  invalid_query: 'The request was not valid - check the details and try again.',
}

function friendlyError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; error?: unknown }
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (typeof record.error === 'string') {
      return ERROR_COPY[record.error] ?? fallback
    }
  }
  return fallback
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path)

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new ApiError(res.status, friendlyError(body, res.statusText || 'Request failed'))
  }

  return (await res.json()) as T
}

export function getTenants(): Promise<TenantSummary[]> {
  return request<TenantSummary[]>('/api/tenants')
}

export function getTenantConfig(slug: string): Promise<TenantConfig> {
  return request<TenantConfig>(`/api/t/${encodeURIComponent(slug)}/config`)
}

export function searchTenant(slug: string, query: string): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query })
  return request<SearchResults>(`/api/t/${encodeURIComponent(slug)}/search?${params.toString()}`)
}

export function getSuggestedQuestions(slug: string): Promise<Question[]> {
  return request<Question[]>(`/api/t/${encodeURIComponent(slug)}/suggest`)
}

export function getResources(slug: string): Promise<ResourceSummary[]> {
  return request<ResourceSummary[]>(`/api/t/${encodeURIComponent(slug)}/resources`)
}

export function getResource(slug: string, id: string): Promise<ResourceSummary> {
  return request<ResourceSummary>(
    `/api/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}`,
  )
}

export function getKnowledgeBoxStatus(slug: string): Promise<KnowledgeBoxStatus> {
  return request<KnowledgeBoxStatus>(`/api/t/${encodeURIComponent(slug)}/knowledge-box`)
}

export function searchTenantFull(
  slug: string,
  query: string,
  opts: { mode?: RetrievalMode; topicIds?: string[]; kindIds?: string[] } = {},
): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query })
  if (opts.mode) params.set('mode', opts.mode)
  if (opts.topicIds && opts.topicIds.length > 0) params.set('topics', opts.topicIds.join(','))
  if (opts.kindIds && opts.kindIds.length > 0) params.set('kinds', opts.kindIds.join(','))
  return request<SearchResults>(`/api/t/${encodeURIComponent(slug)}/search?${params.toString()}`)
}

/**
 * Search the in-app documentation ONLY (the Help section). Scoped server-side
 * to documentation content; never returns research resources.
 */
export function searchDocs(slug: string, query: string): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query })
  return request<SearchResults>(
    `/api/t/${encodeURIComponent(slug)}/docs/search?${params.toString()}`,
  )
}

/**
 * Stream a grounded, cited answer about USING the portal, scoped to the
 * documentation only. Same event contract as `streamAsk`; aborts via the signal.
 */
export async function streamDocsAsk(
  slug: string,
  body: { query: string; context?: { author: 'USER' | 'AGENT'; text: string }[] },
  onEvent: (event: AskEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/t/${encodeURIComponent(slug)}/docs/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || 'The help assistant is unavailable')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as AskEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

export function getCatalog(
  slug: string,
  opts: {
    page?: number
    pageSize?: number
    query?: string
    topicIds?: string[]
    kindIds?: string[]
    sort?: 'created' | 'modified' | 'title'
    order?: 'asc' | 'desc'
  } = {},
): Promise<CatalogPage> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.query) params.set('q', opts.query)
  if (opts.topicIds && opts.topicIds.length > 0) params.set('topics', opts.topicIds.join(','))
  if (opts.kindIds && opts.kindIds.length > 0) params.set('kind', opts.kindIds.join(','))
  if (opts.sort) params.set('sort', opts.sort)
  if (opts.order) params.set('order', opts.order)
  return request<CatalogPage>(`/api/t/${encodeURIComponent(slug)}/catalog?${params.toString()}`)
}

/** Top resources filed under one topic - drives Explore's topic rows. */
export function getTopicResources(
  slug: string,
  topicId: string,
  limit = 12,
): Promise<ResourceSummary[]> {
  return request<ResourceSummary[]>(
    `/api/t/${encodeURIComponent(slug)}/topics/${
      encodeURIComponent(topicId)
    }/resources?limit=${limit}`,
  )
}

export function getFacets(slug: string, labelsets: string[] = ['topic']): Promise<FacetCounts> {
  return request<FacetCounts>(
    `/api/t/${encodeURIComponent(slug)}/facets?ls=${labelsets.join(',')}`,
  )
}

export function getLabelsets(slug: string): Promise<Labelset[]> {
  return request<Labelset[]>(`/api/t/${encodeURIComponent(slug)}/labelsets`)
}

export function getCounters(slug: string): Promise<KbCounters> {
  return request<KbCounters>(`/api/t/${encodeURIComponent(slug)}/counters`)
}

export function getGraph(
  slug: string,
  primary = 'topic',
  secondary = 'kind',
): Promise<GraphData> {
  return request<GraphData>(
    `/api/t/${encodeURIComponent(slug)}/graph?primary=${primary}&secondary=${secondary}`,
  )
}

export function generateArtifact(
  slug: string,
  kind: GenerateKind,
  query: string,
): Promise<GenerateResult> {
  return fetch(`/api/t/${encodeURIComponent(slug)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, query }),
  }).then(async (res) => {
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null)
      const message = body && typeof body === 'object' && 'message' in body &&
          typeof body.message === 'string'
        ? body.message
        : 'Generation failed - try a narrower request.'
      throw new ApiError(res.status, message)
    }
    return (await res.json()) as GenerateResult
  })
}

export interface AskRequest {
  query: string
  context?: { author: 'USER' | 'AGENT'; text: string }[]
  resourceId?: string
  topicIds?: string[]
  /** 'deep' grounds on the full text of matching resources (self-heal / deep research). */
  depth?: 'default' | 'deep'
  /** Sub-questions researched alongside the main query (deep-research mode). */
  prequeries?: string[]
}

/**
 * Stream a grounded answer. Events arrive in order: stage events, a sources
 * event, delta text chunks, citation events, optionally usage, then done (or
 * error). Returns when the stream closes; abort via the signal.
 */
export async function streamAsk(
  slug: string,
  body: AskRequest,
  onEvent: (event: AskEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/t/${encodeURIComponent(slug)}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || 'The answer service is unavailable')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as AskEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

async function adminRequest<T>(path: string, passcode: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-admin-passcode': passcode,
    },
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'message' in body &&
        typeof body.message === 'string'
      ? body.message
      : body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'Request failed'
    throw new ApiError(res.status, message)
  }
  return body as T
}

export function getAdminOverview(passcode: string): Promise<AdminTenantOverview[]> {
  return adminRequest<AdminTenantOverview[]>('/api/admin/overview', passcode)
}

export function revertKnowledgeBox(
  slug: string,
  passcode: string,
): Promise<{ ok: boolean; status: KnowledgeBoxStatus }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/knowledge-box`, passcode, {
    method: 'DELETE',
  })
}

export interface ConnectResult {
  ok: boolean
  status: KnowledgeBoxStatus
  resourceCount: number
}

/**
 * Connect a knowledge box to a tenant. The administrator types the KB id,
 * service-account token and admin passcode into the form themselves; values
 * go straight to the server and are never stored client-side.
 */
export function connectKnowledgeBox(
  slug: string,
  input: { url: string; token: string; passcode: string },
): Promise<ConnectResult> {
  return adminRequest<ConnectResult>(
    `/api/admin/t/${encodeURIComponent(slug)}/knowledge-box`,
    input.passcode,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.url, token: input.token }),
    },
  )
}

/**
 * Provision a brand new knowledge box on the platform and connect this
 * tenant to it. Used both for tenants with no box yet and as a "start
 * fresh" affordance for tenants still on the demo box.
 */
export function createAdminKb(
  slug: string,
  passcode: string,
  title?: string,
): Promise<{ ok: boolean; status: KnowledgeBoxStatus }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/knowledge-box/create`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  })
}

export function getAdminCounters(slug: string, passcode: string): Promise<KbCounters> {
  return adminRequest<KbCounters>(`/api/admin/t/${encodeURIComponent(slug)}/counters`, passcode)
}

export function getAdminRecent(slug: string, passcode: string): Promise<RecentResource[]> {
  return adminRequest<RecentResource[]>(`/api/admin/t/${encodeURIComponent(slug)}/recent`, passcode)
}

export function addAdminLink(
  slug: string,
  passcode: string,
  input: { url: string; title?: string; hidden?: boolean },
): Promise<{ id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/resources/link`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function addAdminText(
  slug: string,
  passcode: string,
  input: { title: string; body: string },
): Promise<{ id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/resources/text`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/**
 * Upload a file's raw bytes. The file's own type drives the content-type
 * header and its name travels separately (URL-encoded) since a raw-byte
 * body can't carry multipart fields.
 */
export function uploadAdminFile(
  slug: string,
  passcode: string,
  file: File,
): Promise<{ id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/resources/upload`, passcode, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
  })
}

/**
 * Run a knowledge-box migration and stream its progress. The response body
 * is a text/event-stream of `data: <MigrationEvent JSON>\n\n` frames; each
 * parsed event is handed to `onEvent` as it arrives.
 */
export async function migrateKb(
  from: string,
  to: string,
  passcode: string,
  onEvent: (event: MigrationEvent) => void,
): Promise<void> {
  const res = await fetch('/api/admin/migrate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-passcode': passcode,
    },
    body: JSON.stringify({ from, to }),
  })

  if (!res.ok || !res.body) {
    let message = res.statusText || 'Migration failed'
    try {
      const body: unknown = await res.json()
      if (
        body && typeof body === 'object' && 'message' in body &&
        typeof body.message === 'string'
      ) {
        message = body.message
      } else if (
        body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ) {
        message = body.error
      }
    } catch {
      // Body wasn't JSON - fall back to statusText.
    }
    throw new ApiError(res.status, message)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as MigrationEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

export function discoverCrawl(
  slug: string,
  passcode: string,
  url: string,
  limit = 50,
): Promise<{ source: string; count: number; links: string[] }> {
  const params = new URLSearchParams({ url, limit: String(limit) })
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/crawl?${params.toString()}`,
    passcode,
  )
}

/** Labels for a new set: plain titles, or title + definition pairs. */
export type NewLabelsetLabel = string | { title: string; text?: string }

export function createAdminLabelset(
  slug: string,
  passcode: string,
  input: { title: string; multiple: boolean; labels: NewLabelsetLabel[] },
): Promise<{ ok: boolean; id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/labelsets`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export interface LabelsetUpdateInput {
  title: string
  multiple: boolean
  labels: { title: string; text: string }[]
}

export interface LabelsetUpdateResult {
  ok: boolean
  id: string
  /** The labellers re-instantiated for this set; empty when none carried it. */
  agents: { previousId: string; newTitle: string }[]
}

/**
 * A labelset save that removed a labeller but could not start its
 * replacement. `previous` is the removed agent's full configuration so it
 * can be restored by hand.
 */
export class LabelsetSaveError extends ApiError {
  constructor(status: number, message: string, readonly previous?: unknown) {
    super(status, message)
    this.name = 'LabelsetSaveError'
  }
}

/**
 * Replace a labelset's title, cardinality, labels and definitions. The server
 * re-instantiates every labeller carrying the set for new resources only.
 */
export async function updateAdminLabelset(
  slug: string,
  passcode: string,
  id: string,
  input: LabelsetUpdateInput,
): Promise<LabelsetUpdateResult> {
  const res = await fetch(
    `/api/admin/t/${encodeURIComponent(slug)}/labelsets/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-passcode': passcode },
      body: JSON.stringify(input),
    },
  )
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const message = typeof record.message === 'string'
      ? record.message
      : typeof record.error === 'string'
      ? record.error
      : 'The label set could not be saved'
    throw new LabelsetSaveError(res.status, message, record.previous)
  }
  return body as LabelsetUpdateResult
}

export function addPortal(
  passcode: string,
  input: { name: string; organisation?: string; tagline?: string },
): Promise<{ ok: boolean; slug: string }> {
  return adminRequest('/api/admin/tenants', passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function removePortal(slug: string, passcode: string): Promise<{ ok: boolean }> {
  return adminRequest(`/api/admin/tenants/${encodeURIComponent(slug)}`, passcode, {
    method: 'DELETE',
  })
}

export function setPortalDisabled(
  slug: string,
  passcode: string,
  disabled: boolean,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/${disabled ? 'disable' : 'enable'}`,
    passcode,
    { method: 'POST' },
  )
}

/** Run corpus analysis and stream its progress events. */
export async function analysePortal(
  slug: string,
  passcode: string,
  onEvent: (event: AnalyseEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/admin/t/${encodeURIComponent(slug)}/analyse`, {
    method: 'POST',
    headers: { 'x-admin-passcode': passcode },
  })
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || 'Analysis failed to start')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as AnalyseEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

export function getResourceContent(slug: string, id: string): Promise<ResourceContent> {
  return request<ResourceContent>(
    `/api/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}/content`,
  )
}

/** Openers written from this one document; [] when none could be grounded. */
export function getResourceQuestions(slug: string, id: string): Promise<string[]> {
  return request<{ questions: string[] }>(
    `/api/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}/questions`,
  ).then((r) => r.questions ?? [])
}

/** URL for streaming a stored file field (PDF/video/audio) inline. */
export function resourceFileUrl(slug: string, id: string, fieldId: string): string {
  return `/api/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}/file/${
    encodeURIComponent(fieldId)
  }`
}

export function getEntityGroups(
  slug: string,
): Promise<{ group: string; entities: string[] }[]> {
  return request(`/api/t/${encodeURIComponent(slug)}/entities`)
}

export function renamePortal(
  slug: string,
  passcode: string,
  input: { name?: string; organisation?: string; tagline?: string },
): Promise<{ ok: boolean }> {
  return adminRequest(`/api/admin/tenants/${encodeURIComponent(slug)}`, passcode, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** Save the portal's typography, text-scale, shape and/or density choice (same PATCH as rename). */
export function updatePortalAppearance(
  slug: string,
  passcode: string,
  input: {
    typography?: TypographyChoice
    shape?: ShapeId
    textScale?: TextScaleId
    density?: DensityId
    paletteId?: PaletteChoice
  },
): Promise<{ ok: boolean }> {
  return adminRequest(`/api/admin/tenants/${encodeURIComponent(slug)}`, passcode, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function proposeKg(slug: string, passcode: string): Promise<KgProposal> {
  return adminRequest<KgProposal>(
    `/api/admin/t/${encodeURIComponent(slug)}/kg/propose`,
    passcode,
    { method: 'POST' },
  )
}

export function getAgents(slug: string, passcode: string): Promise<KbAgent[]> {
  return adminRequest<KbAgent[]>(`/api/admin/t/${encodeURIComponent(slug)}/agents`, passcode)
}

export function deleteAgent(
  slug: string,
  passcode: string,
  taskId: string,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/agents/${encodeURIComponent(taskId)}`,
    passcode,
    { method: 'DELETE' },
  )
}

/** Implement the proposed knowledge-graph strategy, streaming progress. */
export async function implementKg(
  slug: string,
  passcode: string,
  opts: { applyExisting: boolean; includeSummaries: boolean; includeMemory?: boolean },
  onEvent: (event: KgImplementEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/admin/t/${encodeURIComponent(slug)}/kg/implement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-passcode': passcode },
    body: JSON.stringify(opts),
  })
  if (!res.ok || !res.body) {
    const body: unknown = await res.json().catch(() => null)
    const message = body && typeof body === 'object' && 'message' in body &&
        typeof body.message === 'string'
      ? body.message
      : 'Implementation failed to start'
    throw new ApiError(res.status, message)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as KgImplementEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

/** Thumbnail URL for a resource; 404s when the platform has none. */
export function thumbnailUrl(slug: string, id: string): string {
  return `/api/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}/thumbnail`
}

export type BrandingUploadKind = 'logo' | 'hero' | 'font-heading' | 'font-body'

const FONT_MIME_BY_EXT: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

export async function uploadBranding(
  slug: string,
  passcode: string,
  kind: BrandingUploadKind,
  file: File,
): Promise<{ ok: boolean; url: string }> {
  // Browsers rarely set File.type for font files, so derive it from the name.
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const contentType = kind === 'font-heading' || kind === 'font-body'
    ? FONT_MIME_BY_EXT[ext] ?? 'application/octet-stream'
    : file.type || 'application/octet-stream'
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/branding/${kind}`, passcode, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: file,
  })
}

export function getTypeahead(
  slug: string,
  q: string,
): Promise<{ entities: string[]; titles: string[] }> {
  return request(`/api/t/${encodeURIComponent(slug)}/typeahead?q=${encodeURIComponent(q)}`)
}

export function getPrompts(
  slug: string,
  passcode: string,
): Promise<{ ask?: string; images?: boolean }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/prompts`, passcode)
}

export function savePrompts(
  slug: string,
  passcode: string,
  prompts: { ask?: string; images?: boolean },
): Promise<{ ok: boolean }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/prompts`, passcode, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prompts),
  })
}

export function getSearchConfigs(
  slug: string,
  passcode: string,
): Promise<Record<string, unknown>> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/search-configs`, passcode)
}

export function ensureSearchConfigs(
  slug: string,
  passcode: string,
): Promise<{ ok: boolean; created: string[] }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/search-configs/ensure`,
    passcode,
    { method: 'POST' },
  )
}

export interface RelationsGraph {
  nodes: { id: string; group: string; weight: number }[]
  edges: { source: string; target: string; label: string }[]
}

export function getRelationsGraph(
  slug: string,
  entity?: string,
  includeBuiltin?: boolean,
): Promise<RelationsGraph> {
  const params = new URLSearchParams()
  if (entity) params.set('entity', entity)
  if (includeBuiltin) params.set('includeBuiltin', 'true')
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return request(`/api/t/${encodeURIComponent(slug)}/graph/relations${suffix}`)
}

// ---------------------------------------------------------------------------
// Anonymous client identity: research trails and saved searches are stored
// server-side per browser, keyed by this locally-persisted id.
// ---------------------------------------------------------------------------

export function clientId(): string {
  const KEY = 'rp-client-id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(KEY, id)
  }
  return id
}

async function clientRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'x-rp-client': clientId() },
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, friendlyError(body, 'Request failed'))
  }
  return body as T
}

// --- Answer feedback (the platform's learning loop) -------------------------

export function sendAnswerFeedback(
  slug: string,
  input: { learningId: string; good: boolean; text?: string },
): Promise<{ ok: boolean }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

// --- Multi-document summaries ------------------------------------------------

export function summarizeResources(
  slug: string,
  resourceIds: string[],
  kind: 'simple' | 'extended' = 'simple',
): Promise<{ summary: string }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/summarize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceIds, kind }),
  })
}

// --- Deep research: decompose a question into sub-questions ------------------

export function getSubqueries(slug: string, query: string): Promise<{ questions: string[] }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/subqueries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
}

// --- Entity dossiers ---------------------------------------------------------

export interface EntityDossier {
  name: string
  relations: {
    nodes: { id: string; group: string; weight: number }[]
    edges: { source: string; target: string; label: string }[]
  }
  resources: SearchResults['resources']
}

export function getEntityDossier(slug: string, name: string): Promise<EntityDossier> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/entity?name=${encodeURIComponent(name)}`,
  )
}

// --- Research-trail sessions (server-synced per browser) ---------------------

export interface StoredSessionMeta {
  id: string
  title: string
  updatedAt: string
}

export function listServerSessions(slug: string): Promise<StoredSessionMeta[]> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/sessions`)
}

export function getServerSession<T = unknown>(
  slug: string,
  id: string,
): Promise<{ id: string; title: string; updatedAt: string; messages: T[] }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}`)
}

export function putServerSession(
  slug: string,
  session: { id: string; title: string; updatedAt: string; messages: unknown[] },
): Promise<{ ok: boolean }> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(session.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    },
  )
}

export function deleteServerSession(slug: string, id: string): Promise<{ ok: boolean }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// --- Saved searches / watches ------------------------------------------------

export interface SavedWatch {
  id: string
  query: string
  createdAt: string
  lastRun: string | null
  changed: boolean
}

export function listWatches(slug: string): Promise<SavedWatch[]> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/watches`)
}

export function addWatch(slug: string, query: string): Promise<SavedWatch> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/watches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
}

export function markWatchSeen(slug: string, id: string): Promise<{ ok: boolean }> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/watches/${encodeURIComponent(id)}/seen`,
    { method: 'POST' },
  )
}

export function deleteWatch(slug: string, id: string): Promise<{ ok: boolean }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/watches/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// --- Federated estate ask ----------------------------------------------------

/** One event from the estate-wide ask stream; slug null marks the final event. */
export interface EstateEvent {
  slug: string | null
  event: AskEvent | { type: 'estate-done' }
}

export async function streamEstateAsk(
  query: string,
  onEvent: (event: EstateEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ask-estate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || 'The answer service is unavailable')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as EstateEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

// --- Admin: ask insights -----------------------------------------------------

export interface AskInsightRow {
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
  recent: AskInsightRow[]
}

export function getInsights(slug: string, passcode: string): Promise<InsightsSummary> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/insights`, passcode)
}

// --- Admin: hidden-resource curation -----------------------------------------

export function setResourceHidden(
  slug: string,
  passcode: string,
  resourceId: string,
  hidden: boolean,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(resourceId)}/hidden`,
    passcode,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hidden }),
    },
  )
}

// --- Admin: source registry and syncs ----------------------------------------

export interface PortalSource {
  id: string
  url: string
  addedAt: string
  lastSync: string | null
  /** Pages ingested by the most recent sync run. */
  lastAdded: number
  /** Pages ingested from this source in total, across every run. */
  itemCount: number
  auto: boolean
  /** Outcome of the most recent run - absent until a source has been synced. */
  lastStatus?: 'ok' | 'error'
  lastError?: string | null
  /** New pages one run may ingest; absent means the server default. */
  maxPages?: number
}

/** What POST /sources returns: the new source plus what discovery found on it. */
export interface AddedSource extends PortalSource {
  discovered: number
  discoveredVia: string
}

export function getSources(slug: string, passcode: string): Promise<PortalSource[]> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/sources`, passcode)
}

export function addSource(
  slug: string,
  passcode: string,
  input: { url: string; auto?: boolean; maxPages?: number },
): Promise<AddedSource> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/sources`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateSource(
  slug: string,
  passcode: string,
  id: string,
  patch: { auto?: boolean; maxPages?: number },
): Promise<PortalSource> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/sources/${encodeURIComponent(id)}`,
    passcode,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
}

export function deleteSource(
  slug: string,
  passcode: string,
  id: string,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/sources/${encodeURIComponent(id)}`,
    passcode,
    { method: 'DELETE' },
  )
}

export type SourceSyncEvent =
  | { type: 'item'; label: string }
  // `deferred` counts pages left un-synced this run (e.g. the knowledge box
  // was busy) - they are picked up automatically on the next sync.
  | { type: 'done'; added: number; deferred?: number }
  | { type: 'error'; message: string }

export async function syncSource(
  slug: string,
  passcode: string,
  id: string,
  onEvent: (event: SourceSyncEvent) => void,
): Promise<void> {
  const res = await fetch(
    `/api/admin/t/${encodeURIComponent(slug)}/sources/${encodeURIComponent(id)}/sync`,
    { method: 'POST', headers: { 'x-admin-passcode': passcode } },
  )
  if (!res.ok || !res.body) throw new ApiError(res.status, 'The sync failed to start')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as SourceSyncEvent)
    } catch {
      // A truncated trailing frame (dropped connection) is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

// --- Investigations: the research workspace ----------------------------------

export type EvidenceVerdict = 'supports' | 'partial' | 'not-relevant' | 'contradicts'

export interface EvidenceItem {
  id: string
  passage: string
  resourceId: string
  resourceTitle: string
  score: number | null
  question: string
  verdict: EvidenceVerdict | null
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

export interface InvestigationMeta {
  id: string
  name: string
  question: string
  status: 'active' | 'closed'
  updatedAt: string
  evidenceCount: number
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

export function listInvestigations(slug: string): Promise<InvestigationMeta[]> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/investigations`)
}

export function createInvestigation(
  slug: string,
  input: { name: string; question?: string },
): Promise<Investigation> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/investigations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function getInvestigation(slug: string, id: string): Promise<Investigation> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${encodeURIComponent(id)}`,
  )
}

export function updateInvestigation(
  slug: string,
  id: string,
  patch: { name?: string; question?: string; notes?: string; status?: 'active' | 'closed' },
): Promise<Investigation> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
}

export function deleteInvestigation(slug: string, id: string): Promise<{ ok: boolean }> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

export interface NewEvidence {
  passage: string
  resourceId: string
  resourceTitle: string
  score?: number | null
  question?: string
  verdict?: EvidenceVerdict | null
  aiRelevance?: string | null
  note?: string
  tags?: string[]
}

export function addEvidence(
  slug: string,
  investigationId: string,
  input: NewEvidence,
): Promise<EvidenceItem> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${
      encodeURIComponent(investigationId)
    }/evidence`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
}

export function updateEvidence(
  slug: string,
  investigationId: string,
  evidenceId: string,
  patch: { verdict?: EvidenceVerdict | null; note?: string; tags?: string[] },
): Promise<{ ok: boolean }> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${
      encodeURIComponent(investigationId)
    }/evidence/${encodeURIComponent(evidenceId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
}

export function deleteEvidence(
  slug: string,
  investigationId: string,
  evidenceId: string,
): Promise<{ ok: boolean }> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${
      encodeURIComponent(investigationId)
    }/evidence/${encodeURIComponent(evidenceId)}`,
    { method: 'DELETE' },
  )
}

export function saveArtefact(
  slug: string,
  investigationId: string,
  input: { kind: string; title: string; data: unknown },
): Promise<InvestigationArtefact> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${
      encodeURIComponent(investigationId)
    }/artefacts`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
}

// --- Per-source relevance verdicts -------------------------------------------

export interface SourceVerdict {
  id: string
  verdict: string
  relevance: string
}

export function getSourceVerdicts(
  slug: string,
  question: string,
  sources: { id: string; title: string; passage: string }[],
): Promise<{ verdicts: SourceVerdict[] }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/verdicts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, sources: sources.slice(0, 12) }),
  })
}

// --- Follow-up questions ------------------------------------------------------

/**
 * Questions worth asking next, written from the answer just given and proved
 * against the passages that answer retrieved. Fired after the answer completes,
 * never before: nothing here may delay a reader's answer. The signal is the
 * caller's, so asking the next question cancels the follow-ups for the last one.
 */
export function getFollowUpQuestions(
  slug: string,
  input: {
    question: string
    answer: string
    passages: { title: string; text: string }[]
  },
  signal?: AbortSignal,
): Promise<{ questions: string[] }> {
  return clientRequest(`/api/t/${encodeURIComponent(slug)}/followups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: input.question.slice(0, 1000),
      answer: input.answer.slice(0, 20000),
      passages: input.passages.slice(0, 12).map((passage) => ({
        title: passage.title.slice(0, 300),
        text: passage.text.slice(0, 4000),
      })),
    }),
    ...(signal ? { signal } : {}),
  })
}

// --- Admin: corpus health -----------------------------------------------------

export interface CorpusHealthRow {
  id: string
  title: string
  words: number
  status: 'ok' | 'thin' | 'challenge'
  hidden: boolean
}

export function getCorpusHealth(slug: string, passcode: string): Promise<CorpusHealthRow[]> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/corpus-health`, passcode)
}

// --- Knowledge graph strategy (Manage) ---------------------------------------

export interface GraphStrategy {
  taskId: string
  title: string
  ident: string
  entityDefs: { label: string; description?: string }[]
  examples: {
    text: string
    entities: { name: string; label: string }[]
    relations: { source: string; target: string; label: string }[]
  }[]
}

export function getGraphStrategy(
  slug: string,
  passcode: string,
): Promise<{ strategy: GraphStrategy | null }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/kg/strategy`, passcode)
}

export interface GraphStrategyUpdate {
  entityTypes: { label: string; description?: string }[]
  examples: GraphStrategy['examples']
  applyExisting: boolean
}

export async function saveGraphStrategy(
  slug: string,
  passcode: string,
  input: GraphStrategyUpdate,
  onEvent: (event: KgImplementEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/admin/t/${encodeURIComponent(slug)}/kg/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-passcode': passcode },
    body: JSON.stringify(input),
  })
  if (!res.ok || !res.body) {
    const body: unknown = await res.json().catch(() => null)
    const problems = body && typeof body === 'object' && 'problems' in body &&
        Array.isArray((body as { problems: unknown }).problems)
      ? (body as { problems: string[] }).problems.join(' ')
      : ''
    throw new ApiError(res.status, problems || 'The strategy could not be saved')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as KgImplementEvent)
    } catch {
      // truncated trailing frame
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}

// --- Knowledge-box interrogation and suggestions ------------------------------

export interface SetupSuggestion {
  id: string
  kind: 'labelset' | 'label-addition' | 'entity-type' | 'graph-example'
  title: string
  detail: string
  status: 'pending' | 'implemented' | 'ignored'
  createdAt: string
  labelset?: { id: string; title: string; paragraphs: boolean; labels: string[] }
  labels?: { labelsetId: string; labels: string[] }
  entityType?: { label: string; description: string }
  example?: {
    text: string
    entities: { name: string; label: string }[]
    relations: { source: string; target: string; label: string }[]
  }
}

export function getSuggestions(slug: string, passcode: string): Promise<SetupSuggestion[]> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/suggestions`, passcode)
}

export function runInterrogation(slug: string, passcode: string): Promise<SetupSuggestion[]> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/interrogate`, passcode, {
    method: 'POST',
  })
}

export function implementSuggestion(
  slug: string,
  passcode: string,
  id: string,
): Promise<{ ok: boolean; summary: string }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/suggestions/${encodeURIComponent(id)}/implement`,
    passcode,
    { method: 'POST' },
  )
}

export function ignoreSuggestion(
  slug: string,
  passcode: string,
  id: string,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/suggestions/${encodeURIComponent(id)}/ignore`,
    passcode,
    { method: 'POST' },
  )
}

export function synthesiseInvestigation(
  slug: string,
  investigationId: string,
): Promise<{ ok: boolean; artefact: InvestigationArtefact }> {
  return clientRequest(
    `/api/t/${encodeURIComponent(slug)}/investigations/${
      encodeURIComponent(investigationId)
    }/synthesise`,
    { method: 'POST' },
  )
}

// --- Enrichments (merchandising) --------------------------------------------

/** The enrichment agents on a portal, each with its JSON schema and coverage. */
export function getEnrichmentAgents(
  slug: string,
  passcode: string,
): Promise<EnrichmentAgentStatus[]> {
  return adminRequest<EnrichmentAgentStatus[]>(
    `/api/admin/t/${encodeURIComponent(slug)}/enrichments`,
    passcode,
  )
}

/** Regenerate one resource's enrichment on demand. */
export function enrichResource(
  slug: string,
  id: string,
  passcode: string,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}/enrich`,
    passcode,
    { method: 'POST' },
  )
}

/**
 * Run an enrichment agent over the corpus, streaming progress. `scope: 'missing'`
 * only enriches resources without an enrichment yet; `'all'` regenerates all.
 */
export async function runEnrichment(
  slug: string,
  passcode: string,
  body: { agentId?: string; scope: 'all' | 'missing'; limit?: number },
  onEvent: (event: EnrichmentRunEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/admin/t/${encodeURIComponent(slug)}/enrichments/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-passcode': passcode },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    let message = res.statusText || 'Enrichment run failed'
    try {
      const parsed: unknown = await res.json()
      if (
        parsed && typeof parsed === 'object' && 'error' in parsed &&
        typeof parsed.error === 'string'
      ) {
        message = parsed.error
      }
    } catch {
      // Body was not JSON - keep statusText.
    }
    throw new ApiError(res.status, message)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    try {
      onEvent(JSON.parse(data) as EnrichmentRunEvent)
    } catch {
      // A truncated trailing frame is not an event.
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}
