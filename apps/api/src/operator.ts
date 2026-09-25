import { OperatorIdSchema } from '@research-portal/core'
import type { PortalRequestContext } from './app.ts'
import { coarseAdminEligibility } from './assignments.ts'
import type { OperatorEnvelope } from './principal.ts'
import { SlidingWindowLimiter } from './rate-limit.ts'

type OperatorEnvironment = Record<string, string | undefined>
export type OperatorAuthentication =
  | { kind: 'absent' }
  | { kind: 'verified'; id: string }
  | { kind: 'rejected' }

/** Invalid operator credentials audited per client address each minute before a 429 applies. */
export const OPERATOR_FAILURE_LIMIT_PER_MIN = 60

/** Canonical, unpadded base64url containing at least 32 bytes. Entropy is supplied at generation. */
function validKey(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z0-9_-]{43,}$/.test(value) || value.length % 4 === 1) return false
  try {
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    return decoded.length >= 32 &&
      btoa(decoded).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') === value
  } catch {
    return false
  }
}

export function configuredOperatorId(env: OperatorEnvironment): string | undefined {
  if (!validKey(env.OPERATOR_API_KEY)) return undefined
  const id = OperatorIdSchema.safeParse(env.OPERATOR_ID ?? 'operator')
  return id.success ? id.data : undefined
}

/**
 * Explains, without either value, why a present operator key leaves the scheme disabled. Callers
 * log it once at startup so a misconfiguration is distinguishable from a caller's wrong key.
 */
export function operatorConfigurationWarning(env: OperatorEnvironment): string | undefined {
  if (!env.OPERATOR_API_KEY) return undefined
  if (!validKey(env.OPERATOR_API_KEY)) {
    return 'OPERATOR_API_KEY is set but is not unpadded base64url encoding at least 32 bytes; ' +
      'the operator credential is disabled'
  }
  if (!OperatorIdSchema.safeParse(env.OPERATOR_ID ?? 'operator').success) {
    return 'OPERATOR_ID is not a valid operator identifier; the operator credential is disabled'
  }
  return undefined
}

export function hasOperatorScheme(request: Request): boolean {
  return /^Operator(?:\s|$)/i.test(request.headers.get('authorization') ?? '')
}

/** Native HMAC verification under a per-call random key avoids data-dependent comparison. */
async function equalKey(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const tag = await crypto.subtle.sign('HMAC', key, encoder.encode(expected))
  return crypto.subtle.verify('HMAC', key, tag, encoder.encode(provided))
}

/** Explicit credentials never fall back to an ambient session or break-glass credential. */
export async function authenticateOperator(
  request: Request,
  env: OperatorEnvironment,
): Promise<OperatorAuthentication> {
  const header = request.headers.get('authorization') ?? ''
  const id = configuredOperatorId(env)
  if (!hasOperatorScheme(request)) {
    // Do not let an operator secret presented as Bearer become an unrelated authority.
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1]
    if (bearer && env.OPERATOR_API_KEY && await equalKey(bearer, env.OPERATOR_API_KEY)) {
      return { kind: 'rejected' }
    }
    return { kind: 'absent' }
  }
  const key = /^Operator ([A-Za-z0-9_-]+)$/i.exec(header)?.[1]
  if (!id || !key || request.headers.has('x-admin-passcode')) return { kind: 'rejected' }
  try {
    return await equalKey(key, env.OPERATOR_API_KEY!)
      ? { kind: 'verified', id }
      : { kind: 'rejected' }
  } catch {
    return { kind: 'rejected' }
  }
}

export function operatorEnvelope(id: string, audience: string, now = Date.now()): OperatorEnvelope {
  return { v: 1, kind: 'operator', aud: audience, id, iat: Math.floor(now / 1000) }
}

/**
 * The only request context a verified operator receives, shared by the Worker's Durable Object
 * and the local server so both ingress paths grant identical authority.
 */
export function operatorRequestContext(
  id: string,
  requestId: string,
  clientIp?: string,
): PortalRequestContext {
  const effectiveRoles = { platformRole: 'platform-admin' as const, portalRoles: [] }
  return {
    requestId,
    operator: { id },
    session: null,
    clientIp,
    effectiveRoles,
    provenance: [],
    groupCapability: 'disabled',
    coarseAdminEligible: coarseAdminEligibility(effectiveRoles),
    user: null,
  }
}

/**
 * Counts invalid operator credentials per client address, so a looping caller cannot grow the
 * audit log without bound. Verified operator requests are never counted.
 */
export function operatorFailureLimiter(now?: () => number): SlidingWindowLimiter {
  return new SlidingWindowLimiter({ limit: OPERATOR_FAILURE_LIMIT_PER_MIN, windowMs: 60_000, now })
}
