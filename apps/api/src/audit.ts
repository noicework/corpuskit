import { PERMISSIONS, ROLES, type Scope } from '@research-portal/core'
import { DECLARATIONS } from './permissions.ts'

export type AuditActor = {
  kind: 'anonymous' | 'user' | 'break-glass' | 'legacy-key' | 'system'
  id?: string
  label?: string
}
export type AuditOutcome = 'intent' | 'success' | 'denied' | 'failure' | 'uncertain'

/** These are the exact D7 columns. No request body or arbitrary error belongs here. */
export interface AuditEvent {
  id: string
  at: string
  request_id: string
  actor_kind: AuditActor['kind']
  actor_id: string | null
  actor_label: string | null
  action: AuditAction
  scope_kind: Scope['kind']
  scope_slug: string | null
  target_kind: string
  target_id: string | null
  outcome: AuditOutcome
  detail_json: string
}

export interface AuditReadFilter {
  scope: Scope
  requestId?: string
  before?: string
  limit?: number
}

/** Internal store contract. Authorised services own access; there is no HTTP mutation API. */
export interface AuditStore {
  append(event: AuditEvent): void
  read(filter: AuditReadFilter): AuditEvent[]
}

export class AuditWriteError extends Error {
  readonly code = 'audit_write_failed'
  constructor() {
    super('Required audit record could not be written')
    this.name = 'AuditWriteError'
  }
}

const codes = [
  'unauthorised',
  'forbidden',
  'invalid_input',
  'last_owner',
  'email_conflict',
  'invalid_principal',
  'expired_principal',
  'invalid_passcode',
  'locked',
  'unavailable',
  'operation_failed',
  'deadline_exceeded',
  'response_too_large',
  'client_aborted',
] as const
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/
type DetailValue = string | number | boolean
type Validator = (value: unknown) => value is DetailValue
const member = (values: readonly string[]): Validator => (value): value is string =>
  typeof value === 'string' && values.includes(value)
const count: Validator = (value): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const id: Validator = (value): value is string =>
  typeof value === 'string' && identifier.test(value) && !value.includes('://')
const declaredFields = DECLARATIONS.flatMap((item) =>
  item.subActions?.flatMap((action) => action.fields ?? []) ?? []
)
const fields = {
  role: member(ROLES),
  previousRole: member(ROLES),
  permission: member(PERMISSIONS),
  code: member(codes),
  subjectKind: member(['active-oid', 'pending-email', 'group']),
  count,
  retentionDays: count,
  deletedCount: count,
  cutoff: (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  claimAgeSeconds: count,
  lockedUntil: count,
  sessionOid: id,
  sessionTenantId: id,
  operation: member(DECLARATIONS.flatMap((item) => [
    `${item.method} ${item.path}`,
    ...(item.subActions?.map((action) => action.action) ?? []),
  ])),
  // Comma-separated names only, never field values or the submitted body.
  changedFields: (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 256 &&
    value.split(',').every((name) => declaredFields.includes(name)),
  from: id,
  to: id,
  suggestionId: id,
  suggestionKind: member(['labelset', 'label-addition', 'entity-type', 'graph-example']),
  method: member(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
} satisfies Record<string, Validator>
type Field = keyof typeof fields
const actionFields = {
  'assignment.create': ['role', 'subjectKind'],
  'assignment.update': ['role', 'previousRole', 'subjectKind'],
  'assignment.delete': ['previousRole', 'subjectKind'],
  'assignment.activate': ['role', 'subjectKind'],
  'assignment.denied': ['code'],
  'migration.admin_emails': ['count'],
  'request.denied': ['code', 'permission', 'method'],
  'request.privileged': [
    'code',
    'permission',
    'method',
    'sessionOid',
    'sessionTenantId',
    'operation',
    'changedFields',
    'from',
    'to',
    'suggestionId',
    'suggestionKind',
  ],
  'resource.questions.generate': ['code', 'permission', 'sessionOid', 'sessionTenantId'],
  'resource.questions.cache': ['code', 'permission', 'sessionOid', 'sessionTenantId'],
  'tenant.appearance.update': [
    'code',
    'permission',
    'changedFields',
    'sessionOid',
    'sessionTenantId',
  ],
  'tenant.behaviour.update': [
    'code',
    'permission',
    'changedFields',
    'sessionOid',
    'sessionTenantId',
  ],
  'suggestion.graph.write': [
    'code',
    'permission',
    'suggestionKind',
    'suggestionId',
    'sessionOid',
    'sessionTenantId',
  ],
  'suggestion.taxonomy.write': [
    'code',
    'permission',
    'suggestionKind',
    'suggestionId',
    'sessionOid',
    'sessionTenantId',
  ],
  'suggestion.content.write': [
    'code',
    'permission',
    'suggestionKind',
    'suggestionId',
    'sessionOid',
    'sessionTenantId',
  ],
  'break_glass.used': ['sessionOid', 'sessionTenantId'],
  'break_glass.failed': ['code', 'count', 'sessionOid', 'sessionTenantId'],
  'break_glass.locked': ['code', 'count', 'lockedUntil', 'sessionOid', 'sessionTenantId'],
  'audit.retention': ['retentionDays', 'deletedCount', 'cutoff'],
  'maintenance.run': ['code', 'count'],
  'maintenance.source.sync': ['code', 'permission'],
  'maintenance.watch.run': ['code', 'permission'],
  'maintenance.enrichment.run': ['code', 'permission'],
  'maintenance.questions.run': ['code', 'permission'],
} as const satisfies Record<string, readonly Field[]>
export type AuditAction = keyof typeof actionFields

/** Only own, named scalar fields are inspected. Unknown fields are discarded without traversal. */
export function redactAuditDetail(
  action: AuditAction,
  detail: unknown,
): Record<string, DetailValue> {
  try {
    if (
      !Object.hasOwn(actionFields, action) || detail === null || typeof detail !== 'object' ||
      Array.isArray(detail) || ![Object.prototype, null].includes(Object.getPrototypeOf(detail))
    ) {
      throw new AuditWriteError()
    }
    const safe: Record<string, DetailValue> = {}
    for (const field of actionFields[action]) {
      const property = Object.getOwnPropertyDescriptor(detail, field)
      if (!property) continue
      if (!Object.hasOwn(property, 'value') || !fields[field](property.value)) {
        throw new AuditWriteError()
      }
      safe[field] = property.value
    }
    return safe
  } catch {
    throw new AuditWriteError()
  }
}

export interface AuditInput {
  requestId: string
  actor: AuditActor
  action: AuditAction
  scope: Scope
  target: { kind: string; id?: string }
  outcome: AuditOutcome
  detail?: unknown
}

export function createAuditEvent(
  input: AuditInput,
  now: () => number = Date.now,
  newId: () => string = () => crypto.randomUUID(),
): AuditEvent {
  try {
    const event: AuditEvent = {
      id: newId(),
      at: new Date(now()).toISOString(),
      request_id: input.requestId,
      actor_kind: input.actor.kind,
      actor_id: input.actor.id ?? null,
      actor_label: input.actor.label ?? null,
      action: input.action,
      scope_kind: input.scope.kind,
      scope_slug: input.scope.kind === 'portal' ? input.scope.slug : null,
      target_kind: input.target.kind,
      target_id: input.target.id ?? null,
      outcome: input.outcome,
      detail_json: JSON.stringify(redactAuditDetail(input.action, input.detail ?? {})),
    }
    // Explicit null details are malformed, even though omitted details are empty.
    if (input.detail === null) throw new AuditWriteError()
    validateAuditEvent(event)
    return Object.freeze(event)
  } catch {
    throw new AuditWriteError()
  }
}

/** Revalidate at the persistence boundary, including callers that bypass the constructor. */
export function validateAuditEvent(event: AuditEvent): void {
  try {
    if (
      ![event.id, event.request_id, event.target_kind].every(id) ||
      (event.actor_id !== null && !id(event.actor_id)) ||
      (event.target_id !== null && !id(event.target_id)) ||
      !['anonymous', 'user', 'break-glass', 'legacy-key', 'system'].includes(event.actor_kind) ||
      !['intent', 'success', 'denied', 'failure', 'uncertain'].includes(event.outcome) ||
      !(event.scope_kind === 'platform'
        ? event.scope_slug === null
        : event.scope_kind === 'portal' && id(event.scope_slug)) ||
      new Date(event.at).toISOString() !== event.at ||
      (event.actor_label !== null && (typeof event.actor_label !== 'string' ||
        event.actor_label.length > 160 || !/^[\p{L}\p{N} .,'@()_-]+$/u.test(event.actor_label)))
    ) {
      throw new AuditWriteError()
    }
    if (
      event.detail_json.length > 4096 ||
      JSON.stringify(redactAuditDetail(event.action, JSON.parse(event.detail_json))) !==
        event.detail_json
    ) {
      throw new AuditWriteError()
    }
  } catch {
    throw new AuditWriteError()
  }
}

/** Required append errors propagate to the request boundary as a safe typed failure. */
export function appendAudit(store: Pick<AuditStore, 'append'>, event: AuditEvent): void {
  try {
    validateAuditEvent(event)
    store.append(event)
  } catch {
    throw new AuditWriteError()
  }
}
