import type { Permission } from '@research-portal/core'
import type { Hono, MiddlewareHandler } from 'hono'
import type { AuditActor } from './audit.ts'

export interface SubAction {
  readonly action: string
  readonly permission: Permission
  readonly scope: 'portal' | 'platform'
  readonly fields?: readonly string[]
}
export interface Declaration {
  readonly kind: 'http' | 'mcp' | 'boundary' | 'internal' | 'local'
  readonly method: string
  readonly path: string
  readonly permission: Permission
  readonly scope: 'portal' | 'platform' | 'public'
  readonly reason?: string
  readonly action: 'request.privileged' | 'local.mutation'
  readonly target: { readonly kind: 'request' | 'tool'; readonly param?: string }
  readonly subActions?: readonly SubAction[]
  readonly detailFields?: readonly string[]
}
function entry(
  kind: Declaration['kind'],
  method: string,
  path: string,
  permission: Permission,
  scope: Declaration['scope'],
  extra: Partial<Pick<Declaration, 'reason' | 'subActions' | 'detailFields'>> = {},
): Declaration {
  return Object.freeze({
    kind,
    method,
    path,
    permission,
    scope,
    action: kind === 'local' ? 'local.mutation' : 'request.privileged',
    target: Object.freeze({
      kind: kind === 'mcp' ? 'tool' : 'request',
      ...(path.includes(':id') ? { param: 'id' } : path.includes(':slug') ? { param: 'slug' } : {}),
    }),
    ...extra,
    ...(extra.subActions
      ? {
        subActions: Object.freeze(extra.subActions.map((action) =>
          Object.freeze({
            ...action,
            ...(action.fields ? { fields: Object.freeze([...action.fields]) } : {}),
          })
        )),
      }
      : {}),
    ...(extra.detailFields ? { detailFields: Object.freeze([...extra.detailFields]) } : {}),
  })
}

/** D11's sole route/tool catalogue. Labels classify audit only in Phase 2. */
export const DECLARATIONS: readonly Declaration[] = Object.freeze([
  ...([
    ['bindings', ['set', 'remove'], 'bindings.write', 'portal'],
    ['tenants', ['seed', 'add'], 'portal.create', 'platform'],
    ['tenants', ['remove'], 'portal.delete', 'platform'],
    ['tenants', ['setDisabled', 'patch'], 'behaviour.write', 'portal'],
    ['tenants', ['patchBranding'], 'appearance.write', 'portal'],
    ['sessions', ['put', 'remove'], 'portal.ask', 'portal'],
    ['insights', ['record'], 'portal.ask', 'portal'],
    ['routing', ['record'], 'portal.ask', 'portal'],
    ['watches', ['add', 'update', 'remove'], 'portal.watch', 'portal'],
    ['sources', ['add', 'update', 'remove'], 'content.write', 'portal'],
    [
      'investigations',
      [
        'create',
        'update',
        'remove',
        'addEvidence',
        'updateEvidence',
        'removeEvidence',
        'addArtefact',
      ],
      'portal.investigate',
      'portal',
    ],
    ['suggestions', ['replacePending', 'setStatus'], 'behaviour.write', 'portal'],
    ['enrichments', ['put', 'importRecords', 'migrateLegacy'], 'enrichments.write', 'portal'],
    ['kgProposals', ['set'], 'graph.write', 'portal'],
    ['branding', ['put'], 'appearance.write', 'portal'],
    ['mcpKeys', ['add', 'revoke'], 'keys.manage', 'portal'],
  ] as const).flatMap(([store, methods, permission, scope]) =>
    methods.map((method) =>
      entry(
        'local',
        'LOCAL',
        `${store}.${method}`,
        permission,
        scope,
      )
    )
  ),
  entry('internal', 'SYSTEM', 'maintenance.source.sync', 'content.write', 'portal'),
  entry('internal', 'SYSTEM', 'maintenance.watch.run', 'portal.watch', 'portal'),
  entry('internal', 'SYSTEM', 'maintenance.enrichment.run', 'enrichments.write', 'portal'),
  entry('internal', 'SYSTEM', 'maintenance.questions.run', 'portal.generate', 'portal'),
  entry('http', 'GET', '/api/health', 'portal.read', 'public', {
    reason: 'Health only; no research or administrative state.',
  }),
  entry('http', 'GET', '/api/tenants', 'portal.read', 'public', {
    reason: 'Current public portal directory compatibility; no new non-public mode in Phase 2.',
  }),
  entry('http', 'GET', '/api/t/:slug/config', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/branding/:kind', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/resources/:id/thumbnail', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/search', 'portal.read', 'portal'),
  entry('http', 'POST', '/api/t/:slug/route', 'portal.ask', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/extraction/methods', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/extraction/profile', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/extraction/compare', 'content.write', 'portal'),
  entry('http', 'PUT', '/api/admin/t/:slug/extraction/rules', 'behaviour.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/routing', 'behaviour.write', 'portal'),
  entry('http', 'GET', '/api/t/:slug/docs/search', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/catalog', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/topics/:topicId/resources', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/facets', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/labelsets', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/suggest', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/resources', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/resources/:id', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/resources/:id/questions', 'portal.read', 'portal', {
    subActions: [
      { action: 'resource.questions.generate', permission: 'portal.generate', scope: 'portal' },
      { action: 'resource.questions.cache', permission: 'enrichments.write', scope: 'portal' },
    ],
  }),
  entry('http', 'GET', '/api/t/:slug/resources/:id/content', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/resources/:id/file/:fieldId', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/typeahead', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/graph/relations', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/entities', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/knowledge-box', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/counters', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/graph', 'portal.read', 'portal'),
  entry('http', 'POST', '/api/t/:slug/generate', 'portal.generate', 'portal'),
  entry('http', 'POST', '/api/t/:slug/feedback', 'portal.ask', 'portal'),
  entry('http', 'POST', '/api/t/:slug/summarize', 'portal.generate', 'portal'),
  entry('http', 'POST', '/api/t/:slug/subqueries', 'portal.generate', 'portal'),
  entry('http', 'GET', '/api/t/:slug/entity', 'portal.read', 'portal'),
  entry('http', 'GET', '/api/t/:slug/sessions', 'portal.ask', 'portal'),
  entry('http', 'GET', '/api/t/:slug/sessions/:id', 'portal.ask', 'portal'),
  entry('http', 'PUT', '/api/t/:slug/sessions/:id', 'portal.ask', 'portal'),
  entry('http', 'DELETE', '/api/t/:slug/sessions/:id', 'portal.ask', 'portal'),
  entry('http', 'GET', '/api/t/:slug/watches', 'portal.watch', 'portal'),
  entry('http', 'POST', '/api/t/:slug/watches', 'portal.watch', 'portal'),
  entry('http', 'POST', '/api/t/:slug/watches/:id/seen', 'portal.watch', 'portal'),
  entry('http', 'DELETE', '/api/t/:slug/watches/:id', 'portal.watch', 'portal'),
  entry('http', 'POST', '/api/ask-estate', 'portal.ask', 'public', {
    reason: 'Current public estate ask compatibility; Phase 3 must scope non-public portals.',
  }),
  entry('http', 'GET', '/api/t/:slug/investigations', 'portal.investigate', 'portal'),
  entry('http', 'POST', '/api/t/:slug/investigations', 'portal.investigate', 'portal'),
  entry('http', 'GET', '/api/t/:slug/investigations/:id', 'portal.investigate', 'portal'),
  entry('http', 'PATCH', '/api/t/:slug/investigations/:id', 'portal.investigate', 'portal'),
  entry('http', 'DELETE', '/api/t/:slug/investigations/:id', 'portal.investigate', 'portal'),
  entry('http', 'POST', '/api/t/:slug/investigations/:id/evidence', 'portal.investigate', 'portal'),
  entry(
    'http',
    'PATCH',
    '/api/t/:slug/investigations/:id/evidence/:eid',
    'portal.investigate',
    'portal',
  ),
  entry(
    'http',
    'DELETE',
    '/api/t/:slug/investigations/:id/evidence/:eid',
    'portal.investigate',
    'portal',
  ),
  entry(
    'http',
    'POST',
    '/api/t/:slug/investigations/:id/artefacts',
    'portal.investigate',
    'portal',
  ),
  entry(
    'http',
    'POST',
    '/api/t/:slug/investigations/:id/synthesise',
    'portal.investigate',
    'portal',
  ),
  entry('http', 'POST', '/api/t/:slug/verdicts', 'portal.generate', 'portal'),
  entry('http', 'POST', '/api/t/:slug/followups', 'portal.generate', 'portal'),
  entry('http', 'GET', '/api/admin/overview', 'platform.settings.write', 'platform'),
  entry('http', 'DELETE', '/api/admin/t/:slug/knowledge-box', 'bindings.write', 'portal'),
  entry('http', 'POST', '/api/admin/tenants', 'portal.create', 'platform'),
  entry('http', 'DELETE', '/api/admin/tenants/:slug', 'portal.delete', 'platform'),
  entry('http', 'POST', '/api/admin/t/:slug/knowledge-box/create', 'bindings.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/counters', 'content.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/recent', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/link', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/text', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/upload', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/disable', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/enable', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/analyse', 'behaviour.write', 'portal'),
  entry('http', 'PATCH', '/api/admin/tenants/:slug', 'appearance.write', 'portal', {
    subActions: [
      {
        action: 'tenant.appearance.update',
        permission: 'appearance.write',
        scope: 'portal',
        fields: [
          'name',
          'organisation',
          'tagline',
          'colours',
          'typography',
          'shape',
          'textScale',
          'density',
          'paletteId',
        ],
      },
      {
        action: 'tenant.behaviour.update',
        permission: 'behaviour.write',
        scope: 'portal',
        fields: ['searchPlaceholder'],
      },
    ],
  }),
  entry('http', 'POST', '/api/admin/t/:slug/kg/propose', 'graph.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/kg/implement', 'graph.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/suggestions', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/interrogate', 'behaviour.write', 'portal'),
  entry(
    'http',
    'POST',
    '/api/admin/t/:slug/suggestions/:id/implement',
    'behaviour.write',
    'portal',
    {
      detailFields: ['suggestionKind', 'suggestionId'],
      subActions: [
        { action: 'suggestion.graph.write', permission: 'graph.write', scope: 'portal' },
        { action: 'suggestion.taxonomy.write', permission: 'taxonomy.write', scope: 'portal' },
        { action: 'suggestion.content.write', permission: 'content.write', scope: 'portal' },
      ],
    },
  ),
  entry('http', 'POST', '/api/admin/t/:slug/suggestions/:id/ignore', 'behaviour.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/kg/strategy', 'graph.write', 'portal'),
  entry('http', 'PUT', '/api/admin/t/:slug/kg/strategy', 'graph.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/agents', 'graph.write', 'portal'),
  entry('http', 'DELETE', '/api/admin/t/:slug/agents/:taskId', 'graph.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/enrichments/export', 'portal.export', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/enrichments/import', 'enrichments.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/enrichments', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/enrichments/run', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/questions/run', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/:id/enrich', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/branding/:kind', 'appearance.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/prompts', 'behaviour.write', 'portal'),
  entry('http', 'PUT', '/api/admin/t/:slug/prompts', 'behaviour.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/search-configs', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/search-configs/ensure', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/docs/ingest', 'content.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/crawl', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/labelsets', 'taxonomy.write', 'portal'),
  entry('http', 'PUT', '/api/admin/t/:slug/labelsets/:id', 'taxonomy.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/reingest', 'content.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/corpus-health', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/purge-failed', 'content.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/insights', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/:id/hidden', 'content.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/sources', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/sources', 'content.write', 'portal'),
  entry('http', 'PATCH', '/api/admin/t/:slug/sources/:id', 'content.write', 'portal'),
  entry('http', 'DELETE', '/api/admin/t/:slug/sources/:id', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/sources/:id/sync', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/migrate', 'platform.settings.write', 'platform', {
    detailFields: ['from', 'to'],
  }),
  entry('http', 'POST', '/api/admin/t/:slug/knowledge-box', 'bindings.write', 'portal'),
  entry('http', 'POST', '/api/t/:slug/ask', 'portal.ask', 'portal'),
  entry('http', 'POST', '/api/t/:slug/docs/ask', 'portal.ask', 'portal'),
  entry('http', 'GET', '/api/t/:slug/mcp/keys', 'keys.manage', 'portal'),
  entry('http', 'POST', '/api/t/:slug/mcp/keys', 'keys.manage', 'portal'),
  entry('http', 'DELETE', '/api/t/:slug/mcp/keys/:id', 'keys.manage', 'portal'),
  entry('http', 'ALL', '/api/t/:slug/mcp', 'portal.read', 'portal'),
  entry('mcp', 'MCP', 'search_corpus', 'portal.read', 'portal'),
  entry('mcp', 'MCP', 'get_document', 'portal.read', 'portal'),
  entry('mcp', 'MCP', 'browse_catalogue', 'portal.read', 'portal'),
  entry('mcp', 'MCP', 'answer_question', 'portal.ask', 'portal'),
  entry('http', 'ALL', '/t/*', 'portal.read', 'public', {
    reason: 'Application shell bookmark redirects only; no research data is returned.',
  }),
  entry('boundary', 'ALL', '/auth/*', 'portal.read', 'public', {
    reason: 'Authentication bootstrap and safe account session metadata.',
  }),
  entry('boundary', 'ALL', 'static-assets', 'portal.read', 'public', {
    reason: 'Application shell assets served outside the API router.',
  }),
])

export function declarationFor(method: string, path: string): Declaration {
  const normal = method === 'HEAD' ? 'GET' : method
  const declaration = DECLARATIONS.find((item) =>
    item.kind === 'http' && item.path === path && (item.method === normal || item.method === 'ALL')
  )
  if (!declaration) throw new Error('Missing route permission declaration')
  return declaration
}

/** Called while registering each concrete handler, retaining Hono's literal path inference. */
export function declaredRoute<P extends string>(method: string, path: P): P {
  declarationFor(method, path)
  return path
}
export function declaredTool<N extends string>(name: N): N {
  if (!DECLARATIONS.some((item) => item.kind === 'mcp' && item.path === name)) {
    throw new Error('Missing tool permission declaration')
  }
  return name
}

/** Name an internal operation at its call site without activating permission enforcement. */
export function declaredSubAction<T>(
  method: string,
  path: string,
  action: string,
  run: (declaration: SubAction) => T,
): T {
  const declaration = declarationFor(method, path).subActions?.find((item) =>
    item.action === action
  )
  if (!declaration) throw new Error('Missing internal permission declaration')
  return run(declaration)
}
export function isPrivileged(declaration: Declaration, actor?: AuditActor): boolean {
  return actor?.kind === 'break-glass' ||
    (declaration.permission !== 'portal.read' && declaration.permission !== 'portal.ask')
}

/** Only these registered handler identities are infrastructure, never an application prefix. */
const middleware = new WeakSet<MiddlewareHandler>()
export function registerInfrastructure(app: Hono, path: string, handler: MiddlewareHandler): void {
  middleware.add(handler)
  app.use(path, handler)
}
export function assertRouteInventory(app: Hono): void {
  const actual = new Set(
    app.routes.filter((route) => !middleware.has(route.handler))
      .map((route) => `${route.method} ${route.path}`),
  )
  const declared = new Set(
    DECLARATIONS.filter((item) => item.kind === 'http')
      .map((item) => `${item.method} ${item.path}`),
  )
  if (actual.size !== declared.size || [...actual].some((key) => !declared.has(key))) {
    throw new Error('Route permission inventory mismatch')
  }
}
export function assertToolInventory(names: readonly string[]): void {
  const expected = DECLARATIONS.filter((item) => item.kind === 'mcp').map((item) => item.path)
  if (
    new Set(names).size !== names.length || expected.length !== names.length ||
    names.some((name) => !expected.includes(name))
  ) throw new Error('Tool permission inventory mismatch')
}
