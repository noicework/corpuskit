import { z } from 'zod'
import type { OperatorEnvelope } from './principal.ts'

/** Leaves room for the operator: prefix in the audit actor identifier. */
export const OperatorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,150}$/)
  .refine((id) => !id.includes('://'))

type OperatorEnvironment = Record<string, string | undefined>
export type OperatorAuthentication =
  | { kind: 'absent' }
  | { kind: 'verified'; id: string }
  | { kind: 'rejected' }

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
