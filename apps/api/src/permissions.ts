import type { Permission } from '@research-portal/core'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
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
  readonly portalTarget?: 'url-slug'
  readonly aggregate?: 'authorised-portals'
  readonly safeMetadata?: true
  readonly owned?: 'research'
  readonly operator?: true
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
  extra: Partial<
    Pick<
      Declaration,
      'reason' | 'subActions' | 'detailFields' | 'aggregate' | 'safeMetadata' | 'owned' | 'operator'
    >
  > = {},
): Declaration {
  return Object.freeze({
    kind,
    method,
    path,
    permission,
    scope,
    ...(scope === 'portal' && path.includes(':slug') ? { portalTarget: 'url-slug' as const } : {}),
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

/** D11's sole route/tool catalogue, consumed by registration and request authorisation. */
export const DECLARATIONS: readonly Declaration[] = Object.freeze([
  entry('http', 'GET', '/api/admin/t/:slug/lifecycle', 'portal.create', 'platform', {
    operator: true,
  }),
  entry('http', 'PUT', '/api/admin/t/:slug/lifecycle', 'portal.create', 'platform', {
    operator: true,
    subActions: [{
      action: 'portal.lifecycle.update',
      permission: 'portal.create',
      scope: 'platform',
    }],
  }),
  entry('http', 'GET', '/api/admin/t/:slug/usage', 'portal.create', 'platform', {
    operator: true,
  }),
  // Portal host aliases are hosting control, like the lifecycle: a portal role could otherwise
  // claim a hostname the deployment already answers on and take it over for its own portal.
  entry('http', 'GET', '/api/admin/t/:slug/aliases', 'portal.create', 'platform', {
    operator: true,
  }),
  entry('http', 'PUT', '/api/admin/t/:slug/aliases/:hostname', 'portal.create', 'platform', {
    operator: true,
    subActions: [{ action: 'portal.alias.set', permission: 'portal.create', scope: 'platform' }],
  }),
  entry('http', 'DELETE', '/api/admin/t/:slug/aliases/:hostname', 'portal.create', 'platform', {
    operator: true,
    subActions: [{ action: 'portal.alias.remove', permission: 'portal.create', scope: 'platform' }],
  }),
  entry('http', 'PATCH', '/api/admin/t/:slug/access', 'behaviour.write', 'portal', {
    operator: true,
    subActions: [{
      action: 'tenant.access.update',
      permission: 'behaviour.write',
      scope: 'portal',
    }],
  }),
  entry('http', 'GET', '/api/admin/t/:slug/audit', 'audit.read', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/audit/export', 'audit.export', 'portal'),
  entry('http', 'GET', '/api/admin/audit', 'audit.read', 'platform'),
  entry('http', 'GET', '/api/admin/audit/export', 'audit.export', 'platform'),
  ...['people', 'groups'].flatMap((family) => [
    ...['GET', 'POST'].map((method) =>
      entry('http', method, `/api/admin/${family}`, 'platform.members.manage', 'platform')
    ),
    ...['PATCH', 'DELETE'].map((method) =>
      entry('http', method, `/api/admin/${family}/:id`, 'platform.members.manage', 'platform')
    ),
  ]),
  ...['members', 'groups'].flatMap((family) => [
    ...['GET', 'POST'].map((method) =>
      entry('http', method, `/api/admin/t/:slug/${family}`, 'members.manage', 'portal', {
        ...(family === 'members' ? { operator: true } : {}),
      })
    ),
    ...['PATCH', 'DELETE'].map((method) =>
      entry('http', method, `/api/admin/t/:slug/${family}/:id`, 'members.manage', 'portal', {
        ...(family === 'members' && method === 'DELETE' ? { operator: true } : {}),
      })
    ),
  ]),
  ...([
    ['lifecycle', ['set'], 'portal.create', 'platform'],
    ['lifecycle', ['remove'], 'portal.delete', 'platform'],
    ['lifecycle', ['consumeAsk', 'refundAsk'], 'portal.ask', 'portal'],
    ['lifecycle', ['touch'], 'portal.read', 'portal'],
    ['lifecycle', ['reserveAdd', 'settleAdd', 'forgetResource'], 'content.write', 'portal'],
    ['lifecycle', ['resetCapacity'], 'bindings.write', 'portal'],
    ['bindings', ['set', 'remove'], 'bindings.write', 'portal'],
    ['tenants', ['seed', 'add'], 'portal.create', 'platform'],
    ['tenants', ['setAlias', 'removeAlias'], 'portal.create', 'platform'],
    ['tenants', ['remove'], 'portal.delete', 'platform'],
    // Erasure of a deleted portal's records; `erasure.erase` is the one atomic unit around them.
    ['erasure', ['erase'], 'portal.create', 'platform'],
    ['lifecycle', ['erase'], 'portal.create', 'platform'],
    ['tenants', ['erase'], 'portal.create', 'platform'],
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
  entry('http', 'GET', '/api/tenants', 'portal.read', 'portal', {
    aggregate: 'authorised-portals',
  }),
  entry('http', 'GET', '/api/t/:slug/config', 'portal.read', 'portal', {
    safeMetadata: true,
    reason:
      'D9 permits only the safe pre-auth projection without portal.read; full config remains protected.',
  }),
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
  entry('http', 'GET', '/api/t/:slug/sessions', 'portal.ask', 'portal', { owned: 'research' }),
  entry('http', 'GET', '/api/t/:slug/sessions/:id', 'portal.ask', 'portal', { owned: 'research' }),
  entry('http', 'PUT', '/api/t/:slug/sessions/:id', 'portal.ask', 'portal', { owned: 'research' }),
  entry('http', 'DELETE', '/api/t/:slug/sessions/:id', 'portal.ask', 'portal', {
    owned: 'research',
  }),
  entry('http', 'GET', '/api/t/:slug/watches', 'portal.read', 'portal', { owned: 'research' }),
  entry('http', 'POST', '/api/t/:slug/watches', 'portal.watch', 'portal', { owned: 'research' }),
  entry('http', 'POST', '/api/t/:slug/watches/:id/seen', 'portal.watch', 'portal', {
    owned: 'research',
  }),
  entry('http', 'DELETE', '/api/t/:slug/watches/:id', 'portal.watch', 'portal', {
    owned: 'research',
  }),
  entry('http', 'POST', '/api/ask-estate', 'portal.ask', 'portal', {
    aggregate: 'authorised-portals',
  }),
  entry('http', 'GET', '/api/t/:slug/investigations', 'portal.read', 'portal', {
    owned: 'research',
  }),
  entry('http', 'POST', '/api/t/:slug/investigations', 'portal.investigate', 'portal', {
    owned: 'research',
  }),
  entry('http', 'GET', '/api/t/:slug/investigations/:id', 'portal.read', 'portal', {
    owned: 'research',
  }),
  entry('http', 'PATCH', '/api/t/:slug/investigations/:id', 'portal.investigate', 'portal', {
    owned: 'research',
  }),
  entry('http', 'DELETE', '/api/t/:slug/investigations/:id', 'portal.investigate', 'portal', {
    owned: 'research',
  }),
  entry(
    'http',
    'POST',
    '/api/t/:slug/investigations/:id/evidence',
    'portal.investigate',
    'portal',
    { owned: 'research' },
  ),
  entry(
    'http',
    'PATCH',
    '/api/t/:slug/investigations/:id/evidence/:eid',
    'portal.investigate',
    'portal',
    { owned: 'research' },
  ),
  entry(
    'http',
    'DELETE',
    '/api/t/:slug/investigations/:id/evidence/:eid',
    'portal.investigate',
    'portal',
    { owned: 'research' },
  ),
  entry(
    'http',
    'POST',
    '/api/t/:slug/investigations/:id/artefacts',
    'portal.investigate',
    'portal',
    { owned: 'research' },
  ),
  entry(
    'http',
    'POST',
    '/api/t/:slug/investigations/:id/synthesise',
    'portal.investigate',
    'portal',
    { owned: 'research' },
  ),
  entry('http', 'POST', '/api/t/:slug/verdicts', 'portal.generate', 'portal'),
  entry('http', 'POST', '/api/t/:slug/followups', 'portal.generate', 'portal'),
  // D13: the estate overview is a platform-admin read, not an owner-only settings write.
  entry('http', 'GET', '/api/admin/overview', 'portal.create', 'platform'),
  entry('http', 'DELETE', '/api/admin/t/:slug/knowledge-box', 'bindings.write', 'portal', {
    operator: true,
  }),
  entry('http', 'POST', '/api/admin/tenants', 'portal.create', 'platform', {
    operator: true,
    subActions: [
      { action: 'tenant.domain.attach', permission: 'domains.write', scope: 'portal' },
      { action: 'tenant.domain.detach', permission: 'domains.write', scope: 'portal' },
    ],
  }),
  entry('http', 'DELETE', '/api/admin/tenants/:slug', 'portal.delete', 'platform', {
    subActions: [{ action: 'tenant.domain.detach', permission: 'domains.write', scope: 'portal' }],
  }),
  // Hosting retention (docs/HOSTING.md, "Deleting and erasing portals"). Ordinary deletion stays
  // owner-only. A platform administrator, and so the operator credential, may delete only a portal
  // that has stayed suspended for OPERATOR_DELETE_AFTER_DAYS, and may erase only what a portal
  // that is already deleted left stored. Neither can reach a live, unsuspended portal.
  entry('http', 'POST', '/api/admin/tenants/:slug/delete-suspended', 'portal.create', 'platform', {
    operator: true,
    subActions: [{ action: 'tenant.domain.detach', permission: 'domains.write', scope: 'portal' }],
  }),
  entry('http', 'POST', '/api/admin/tenants/:slug/erase', 'portal.create', 'platform', {
    operator: true,
  }),
  entry('http', 'POST', '/api/admin/t/:slug/knowledge-box/create', 'bindings.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/counters', 'content.write', 'portal', {
    operator: true,
  }),
  entry('http', 'GET', '/api/admin/t/:slug/recent', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/link', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/text', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/upload', 'content.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/disable', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/enable', 'behaviour.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/analyse', 'behaviour.write', 'portal'),
  entry('http', 'PATCH', '/api/admin/tenants/:slug', 'appearance.write', 'portal', {
    operator: true,
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
        fields: ['searchPlaceholder', 'regionalDiscovery'],
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
  // D13: the enrichment archive is curator material, matching its import counterpart.
  entry('http', 'GET', '/api/admin/t/:slug/enrichments/export', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/enrichments/import', 'enrichments.write', 'portal'),
  entry('http', 'GET', '/api/admin/t/:slug/enrichments', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/enrichments/run', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/questions/run', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/resources/:id/enrich', 'enrichments.write', 'portal'),
  entry('http', 'POST', '/api/admin/t/:slug/branding/:kind', 'appearance.write', 'portal', {
    operator: true,
  }),
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
  entry('http', 'POST', '/api/admin/migrate', 'portal.create', 'platform', {
    operator: true,
    detailFields: ['from', 'to'],
    subActions: [
      { action: 'migration.source', permission: 'content.write', scope: 'portal' },
      { action: 'migration.destination', permission: 'content.write', scope: 'portal' },
    ],
  }),
  entry('http', 'POST', '/api/admin/t/:slug/knowledge-box', 'bindings.write', 'portal', {
    operator: true,
  }),
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
    reason:
      'Application shell and public marketing documents, including /about and /docs pages, served outside the API router; no research data is returned.',
  }),
])

export function declarationFor(method: string, path: string): Declaration {
  const normal = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const candidates = DECLARATIONS.filter((item) => item.kind === 'http' && item.path === path)
  const declaration = candidates.find((item) => item.method === normal) ??
    candidates.find((item) => item.method === 'ALL')
  if (!declaration) throw new Error('Missing route permission declaration')
  return declaration
}

/**
 * Hosting read-only mode refuses every portal operation that changes content or configuration.
 * Any non-read portal route or tool counts unless it is exempt here, so a new one is refused by
 * default. Exempt: asking and a user's own research artefacts; revoking access (removing a
 * member, a group mapping or an MCP key); `disable` and `enable`, which keep their own meaning;
 * and the access mode, where the handler accepts only a change that makes the portal more
 * restrictive (`isAccessTightening`).
 */
const READ_ONLY_EXEMPT_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'portal.read',
  'portal.ask',
  'portal.generate',
  'portal.investigate',
  'portal.watch',
])
const READ_ONLY_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  'DELETE /api/admin/t/:slug/members/:id',
  'DELETE /api/admin/t/:slug/groups/:id',
  'DELETE /api/t/:slug/mcp/keys/:id',
  'PATCH /api/admin/t/:slug/access',
  'POST /api/admin/t/:slug/disable',
  'POST /api/admin/t/:slug/enable',
])
export function mutatesPortal(
  declaration: Pick<Declaration, 'kind' | 'method' | 'path' | 'permission' | 'scope'>,
): boolean {
  if (declaration.scope !== 'portal') return false
  if (declaration.kind !== 'http' && declaration.kind !== 'mcp') return false
  if (declaration.method === 'GET' || declaration.method === 'HEAD') return false
  if (READ_ONLY_EXEMPT_PERMISSIONS.has(declaration.permission)) return false
  return !READ_ONLY_EXEMPT_ROUTES.has(`${declaration.method} ${declaration.path}`)
}

const ACCESS_ORDER = ['public', 'authenticated', 'restricted'] as const
/** Whether an access-mode change keeps the portal at least as restrictive as it was. */
export function isAccessTightening(
  from: typeof ACCESS_ORDER[number],
  to: typeof ACCESS_ORDER[number],
): boolean {
  return ACCESS_ORDER.indexOf(to) >= ACCESS_ORDER.indexOf(from)
}

/**
 * How a portal route or tool meets the hosting daily ask limit (`asksPerDay`):
 * - `count`: it answers a question with a paid model call, so each call counts as one ask and
 *   is refused once the day's asks are spent.
 * - `gate`: it makes a paid model call that only accompanies an ask already counted (routing,
 *   sub-questions, source verdicts, follow-up suggestions). It does not count, but it is
 *   refused once the day's asks are spent.
 * Every non-read portal route or tool with the ask or generate permission counts unless it is
 * listed here, so a new one is limited by default.
 */
export type AskUse = 'count' | 'gate'
const ASK_FREE_ROUTES: ReadonlySet<string> = new Set([
  // A user's own saved research and answer feedback make no model call.
  'PUT /api/t/:slug/sessions/:id',
  'DELETE /api/t/:slug/sessions/:id',
  'POST /api/t/:slug/feedback',
])
const ASK_GATED_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/t/:slug/route',
  'POST /api/t/:slug/subqueries',
  'POST /api/t/:slug/verdicts',
  'POST /api/t/:slug/followups',
])
/** Paid answers declared under another permission. */
const ASK_COUNTED_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/t/:slug/investigations/:id/synthesise',
])
export function askUse(
  declaration: Pick<Declaration, 'kind' | 'method' | 'path' | 'permission' | 'scope'>,
): AskUse | null {
  if (declaration.scope !== 'portal') return null
  if (declaration.kind !== 'http' && declaration.kind !== 'mcp') return null
  if (declaration.method === 'GET' || declaration.method === 'HEAD') return null
  const key = `${declaration.method} ${declaration.path}`
  if (ASK_GATED_ROUTES.has(key)) return 'gate'
  if (ASK_COUNTED_ROUTES.has(key)) return 'count'
  if (ASK_FREE_ROUTES.has(key)) return null
  return declaration.permission === 'portal.ask' || declaration.permission === 'portal.generate'
    ? 'count'
    : null
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
  return actor?.kind === 'operator' || actor?.kind === 'break-glass' ||
    (declaration.permission !== 'portal.read' && declaration.permission !== 'portal.ask')
}

/** Only these registered handler identities are infrastructure, never an application prefix. */
const middleware = new WeakSet<MiddlewareHandler>()
const preflight = new WeakSet<MiddlewareHandler>()
/** Only a registered CORS handler may finish OPTIONS without a protected operation. */
export function registerPreflightInfrastructure(
  app: Hono,
  path: string,
  handler: MiddlewareHandler,
): void {
  preflight.add(handler)
  registerInfrastructure(app, path, handler)
}
export function isInfrastructurePreflight(c: Context): boolean {
  const routes = matchedRoutes(c)
  return c.req.method === 'OPTIONS' && routes.some((route) => preflight.has(route.handler)) &&
    routes.every((route) => middleware.has(route.handler))
}
export function infrastructureHandler<T extends MiddlewareHandler>(handler: T): T {
  middleware.add(handler)
  return handler
}
export function registerInfrastructure(app: Hono, path: string, handler: MiddlewareHandler): void {
  app.use(path, infrastructureHandler(handler))
}
export function assertDeclarationInventory(
  declarations: readonly Declaration[] = DECLARATIONS,
): void {
  const keys = declarations.map((item) => `${item.kind} ${item.method} ${item.path}`)
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate permission declaration')
  for (const item of declarations) {
    if (
      item.operator !== undefined && (
        item.operator !== true || item.kind !== 'http' || !item.path.startsWith('/api/admin/') ||
        item.scope === 'public' ||
        ['portal.delete', 'platform.members.manage', 'platform.settings.write'].includes(
          item.permission,
        )
      )
    ) throw new Error('Invalid operator permission declaration')
    if (item.scope === 'public' && !item.reason?.trim()) throw new Error('Missing public reason')
    const names = item.subActions?.map((action) => action.action) ?? []
    if (new Set(names).size !== names.length) throw new Error('Duplicate sub-action declaration')
  }
}
assertDeclarationInventory()

/** Resolve Hono's actual operation, excluding only explicitly registered infrastructure identities. */
export function matchedDeclaration(c: Context): Declaration {
  const operations = matchedRoutes(c).filter((route) => !middleware.has(route.handler))
  if (operations.length !== 1) throw new Error('Missing or ambiguous registered operation')
  const route = operations[0]!
  return declarationFor(route.method, route.path)
}

export function assertRouteInventory(
  app: Hono,
  declarations: readonly Declaration[] = DECLARATIONS,
): void {
  assertDeclarationInventory(declarations)
  const registrations = app.routes.filter((route) => !middleware.has(route.handler))
    .map((route) => `${route.method} ${route.path}`)
  const actual = new Set(registrations)
  if (actual.size !== registrations.length) throw new Error('Duplicate concrete route registration')
  const declared = new Set(
    declarations.filter((item) => item.kind === 'http')
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
