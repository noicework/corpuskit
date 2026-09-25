import {
  PLATFORM_ROLES,
  PORTAL_ROLES,
  type Role,
  RoleSchema,
  type Scope,
  ScopeSchema,
} from '@research-portal/core'
import { z } from 'zod'
import { currentAuthority, type RequestContext } from './access-lifecycle.ts'
import { assertResponseCurrent, authorityFetch, finishResponse } from './break-glass.ts'

export type AssignmentFamily = 'members' | 'groups'
export type MemberInput = {
  subjectKind: 'active-oid' | 'pending-email'
  subjectId: string
  role: Role
  source?: 'entra' | 'external'
}
export type GroupInput = { subjectId: string; role: Role }
const rowSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectKind: z.enum(['active-oid', 'pending-email', 'group']),
  subjectId: z.string().min(1),
  source: z.enum(['entra', 'external']).default('entra'),
  scope: ScopeSchema,
  role: RoleSchema,
  emailProvenance: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
export type RoleAssignment = z.infer<typeof rowSchema>
export interface AssignmentList {
  items: RoleAssignment[]
  capability?: 'enabled' | 'disabled'
}
const messages = {
  invalid_input: 'Check the identity and role, then try again.',
  email_conflict: 'This email is already linked to another assignment. Check the existing member.',
  assignment_conflict: 'This person already has a local assignment. Edit their existing role.',
  last_owner:
    'This change would remove the final active owner. Keep an owner with active access before trying again.',
  unconfirmed: 'The change could not be confirmed. Refresh this view before trying again.',
} as const
export class AssignmentError extends Error {
  constructor(readonly status = 0, readonly code: keyof typeof messages = 'unconfirmed') {
    super(messages[code])
    this.name = 'AssignmentError'
  }
  get correctable() {
    return this.status === 400 || this.status === 409
  }
}

function base(scope: Scope, family: AssignmentFamily) {
  ScopeSchema.parse(scope)
  return scope.kind === 'portal'
    ? `/api/admin/t/${encodeURIComponent(scope.slug)}/${family}`
    : `/api/admin/${family === 'members' ? 'people' : 'groups'}`
}
function parseRow(value: unknown, scope: Scope, family: AssignmentFamily, id?: string) {
  const row = rowSchema.parse(value)
  const roles: readonly string[] = scope.kind === 'portal' ? PORTAL_ROLES : PLATFORM_ROLES
  if (
    row.scope.kind !== scope.kind ||
    (scope.kind === 'portal' && (row.scope.kind !== 'portal' || row.scope.slug !== scope.slug)) ||
    (family === 'groups' ? row.subjectKind !== 'group' : row.subjectKind === 'group') ||
    !roles.includes(row.role) || (id !== undefined && row.id !== id)
  ) throw new AssignmentError()
  return row
}
async function request<T>(
  scope: Scope,
  family: AssignmentFamily,
  init: RequestInit,
  context: RequestContext,
  parse: (value: unknown) => T,
  id?: string,
): Promise<T> {
  const authority = context.authority ?? currentAuthority()
  if (context.context) authority?.assertCurrent(context.context)
  if (
    authority &&
    !authority.can(scope.kind === 'portal' ? 'members.manage' : 'platform.members.manage', scope)
  ) throw new AssignmentError(403)
  const response = await authorityFetch(
    base(scope, family) + (id === undefined ? '' : `/${encodeURIComponent(id)}`),
    { ...init, cache: 'no-store' },
    context,
  )
  try {
    const value: unknown = await response.json()
    assertResponseCurrent(response)
    if (!response.ok) {
      const code = z.object({
        error: z.enum(['invalid_input', 'email_conflict', 'assignment_conflict', 'last_owner']),
      }).safeParse(value)
      throw new AssignmentError(
        response.status,
        code.success && [400, 409].includes(response.status) ? code.data.error : 'unconfirmed',
      )
    }
    try {
      return parse(value)
    } catch {
      throw new AssignmentError(response.status)
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new AssignmentError(response.status)
    throw error
  } finally {
    finishResponse(response)
  }
}
export function listAssignments(
  scope: Scope,
  family: AssignmentFamily,
  context: RequestContext = {},
): Promise<AssignmentList> {
  return request(scope, family, {}, context, (value) => {
    const result = (family === 'groups'
      ? z.object({ items: z.array(z.unknown()), capability: z.enum(['enabled', 'disabled']) })
        .strict()
      : z.object({ items: z.array(z.unknown()) }).strict()).parse(value)
    const items = result.items.map((item) =>
      parseRow(item, scope, family)
    )
    if (new Set(items.map((row) => row.id)).size !== items.length) throw new AssignmentError()
    return { ...result, items }
  })
}
export function createAssignment(
  scope: Scope,
  family: AssignmentFamily,
  input: MemberInput | GroupInput,
  context: RequestContext = {},
) {
  const role = scope.kind === 'portal' ? z.enum(PORTAL_ROLES) : z.enum(PLATFORM_ROLES)
  const data =
    (family === 'groups' ? z.object({ subjectId: z.string().min(1), role }).strict() : z.object({
      subjectKind: z.enum(['active-oid', 'pending-email']),
      subjectId: z.string().min(1),
      role,
      source: z.enum(['entra', 'external']).optional(),
    }).strict()).parse(input)
  return request(
    scope,
    family,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) },
    context,
    (value) => parseRow(value, scope, family),
  )
}
export function changeAssignment(
  scope: Scope,
  family: AssignmentFamily,
  id: string,
  role: Role,
  context: RequestContext = {},
) {
  const data = {
    role: (scope.kind === 'portal' ? z.enum(PORTAL_ROLES) : z.enum(PLATFORM_ROLES)).parse(role),
  }
  return request(
    scope,
    family,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
    context,
    (value) => parseRow(value, scope, family, id),
    id,
  )
}
export function removeAssignment(
  scope: Scope,
  family: AssignmentFamily,
  id: string,
  context: RequestContext = {},
) {
  return request(
    scope,
    family,
    { method: 'DELETE' },
    context,
    (value) => parseRow(value, scope, family, id),
    id,
  )
}

export async function changeAccessMode(
  slug: string,
  accessMode: 'public' | 'authenticated' | 'restricted',
  context: RequestContext = {},
) {
  const scope = ScopeSchema.parse({ kind: 'portal', slug })
  const mode = z.enum(['public', 'authenticated', 'restricted']).parse(accessMode)
  const authority = context.authority ?? currentAuthority()
  if (context.context) authority?.assertCurrent(context.context)
  if (authority && !authority.can('behaviour.write', scope)) throw new AssignmentError(403)
  const response = await authorityFetch(`/api/admin/t/${encodeURIComponent(slug)}/access`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessMode: mode }),
  }, context)
  try {
    const value: unknown = await response.json()
    assertResponseCurrent(response)
    if (!response.ok) throw new AssignmentError(response.status)
    const parsed = z.object({ slug: z.literal(slug), accessMode: z.literal(mode) }).strict()
      .safeParse(value)
    if (!parsed.success) throw new AssignmentError(response.status)
    return parsed.data
  } catch (error) {
    if (error instanceof SyntaxError) throw new AssignmentError(response.status)
    throw error
  } finally {
    finishResponse(response)
  }
}
