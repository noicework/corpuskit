import { PORTAL_ROLES, type PortalRole, PortalRoleSchema } from '@research-portal/core'
import { z } from 'zod'
import { currentAuthority, type RequestContext } from './access-lifecycle.ts'
import { assertResponseCurrent, authorityFetch, finishResponse } from './break-glass.ts'

const time = z.string().refine((value) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
)
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/)
const labelSchema = z.string().min(1).max(80).refine((value) =>
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
)
const summarySchema = z.object({
  id: identifier,
  label: labelSchema,
  prefix: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  createdAt: time,
  revokedAt: time.nullable(),
  role: PortalRoleSchema,
  expiresAt: time.nullable(),
  status: z.enum(['active', 'expired', 'revoked', 'unproven_creator', 'creator_no_access']),
  inactiveReason: z.enum([
    'active',
    'expired',
    'revoked',
    'unproven_creator',
    'creator_no_access',
    'creator_claims_expired',
  ]),
  effectiveRole: PortalRoleSchema.nullable(),
  legacy: z.boolean(),
  upgradeable: z.boolean(),
}).strict().refine((row) =>
  (row.status === 'active' ? row.effectiveRole !== null : row.effectiveRole === null) &&
  (row.inactiveReason === 'creator_claims_expired'
    ? row.status === 'creator_no_access'
    : row.status === row.inactiveReason) &&
  (!row.legacy || (row.role === 'viewer' && !row.upgradeable && row.expiresAt === null)) &&
  (row.status === 'revoked' ? row.revokedAt !== null : row.revokedAt === null) &&
  (row.effectiveRole === null ||
    PORTAL_ROLES.indexOf(row.effectiveRole) <= PORTAL_ROLES.indexOf(row.role))
)
export type KeySummary = z.infer<typeof summarySchema>
export type KeyInput = { label: string; role: PortalRole; expiresAt?: string }
export const keyUnconfirmed =
  'The change could not be confirmed. Refresh the key list before trying again.'
export class KeyError extends Error {
  constructor(readonly correctable = false, message = keyUnconfirmed) {
    super(message)
    this.name = 'KeyError'
  }
}
function manager(slug: string, options: RequestContext) {
  const authority = options.authority ?? currentAuthority()
  if (options.context) authority?.assertCurrent(options.context)
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(slug) || !authority?.session?.user ||
    !authority.can('keys.manage', { kind: 'portal', slug })
  ) throw new KeyError()
  return authority
}
export function keyRoles(slug: string, options: RequestContext): readonly PortalRole[] {
  const authority = manager(slug, options)
  const ceiling = authority.session?.portalAccess?.effectiveRole
  return ceiling ? PORTAL_ROLES.slice(0, PORTAL_ROLES.indexOf(ceiling) + 1) : []
}
async function request<T>(
  slug: string,
  init: RequestInit,
  options: RequestContext,
  parse: (value: unknown) => T,
  id?: string,
): Promise<T> {
  manager(slug, options)
  let response: Response | undefined
  try {
    response = await authorityFetch(
      `/api/t/${encodeURIComponent(slug)}/mcp/keys${
        id === undefined ? '' : `/${encodeURIComponent(id)}`
      }`,
      { ...init, cache: 'no-store' },
      options,
    )
    const value: unknown = await response.json()
    assertResponseCurrent(response)
    if (!response.ok) {
      if (response.status === 400) {
        throw new KeyError(true, 'Check the label, role and future expiry, then try again.')
      }
      if (response.status === 409) {
        throw new KeyError(
          true,
          'The active key limit has been reached. Revoke an unused key before creating another.',
        )
      }
      throw new KeyError()
    }
    const result = parse(value)
    assertResponseCurrent(response)
    return result
  } catch (error) {
    if (error instanceof KeyError || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    throw new KeyError()
  } finally {
    if (response) finishResponse(response)
  }
}
export function listKeys(slug: string, options: RequestContext = {}): Promise<KeySummary[]> {
  return request(slug, {}, options, (value) => {
    const rows = z.array(summarySchema).parse(value)
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new KeyError()
    return rows
  })
}
/** The result belongs only to the caller's mounted one-time view, never a query/mutation cache. */
export async function createKey(slug: string, input: KeyInput, options: RequestContext = {}) {
  const parsed = z.object({
    label: z.string().trim().pipe(labelSchema),
    role: PortalRoleSchema,
    expiresAt: time.optional(),
  }).strict().safeParse(input)
  if (
    !parsed.success || (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= Date.now()) ||
    !keyRoles(slug, options).includes(parsed.data.role)
  ) throw new KeyError(true, 'Check the label, role and future expiry, then try again.')
  return request(
    slug,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    },
    options,
    (value) => {
      const result = z.object({
        key: z.string().regex(/^ck_[A-Za-z0-9_-]{43}$/),
        credential: summarySchema,
      }).strict().parse(value)
      if (
        result.credential.role !== parsed.data.role ||
        result.credential.prefix !== result.key.slice(0, 15) ||
        result.credential.effectiveRole !== parsed.data.role || !result.credential.upgradeable ||
        result.credential.revokedAt !== null ||
        result.credential.label !== parsed.data.label || result.credential.status !== 'active' ||
        result.credential.legacy || result.credential.expiresAt !== (parsed.data.expiresAt ?? null)
      ) throw new KeyError()
      return result
    },
  )
}
export function revokeKey(slug: string, id: string, options: RequestContext = {}) {
  if (!identifier.safeParse(id).success) return Promise.reject(new KeyError())
  return request(
    slug,
    { method: 'DELETE' },
    options,
    (value) => z.object({ ok: z.literal(true) }).strict().parse(value),
    id,
  )
}
