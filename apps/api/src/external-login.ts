import { z } from 'zod'
import { appendAudit, type AuditStore, createAuditEvent } from './audit.ts'
import type { SqlExecutor } from './rbac-state.ts'

export interface ExternalLoginConfig {
  issuer?: string
  jwk?: string
  audience?: string
  name?: string
  startUrl?: string
}

export function externalLoginConfig(env: Record<string, string | undefined>): ExternalLoginConfig {
  return {
    issuer: env.EXTERNAL_LOGIN_ISSUER,
    jwk: env.EXTERNAL_LOGIN_JWK,
    audience: env.WORKER_NAME,
    name: env.EXTERNAL_LOGIN_NAME,
    startUrl: env.EXTERNAL_LOGIN_START_URL,
  }
}

export function externalLoginConfigured(config?: ExternalLoginConfig): boolean {
  return Boolean(config?.issuer && config.jwk)
}

export function externalLoginPresentation(config?: ExternalLoginConfig) {
  if (!externalLoginConfigured(config) || !config?.startUrl) return null
  try {
    const url = new URL(config.startUrl)
    if (
      url.username || url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) return null
    return { name: config.name || 'Continue with your organisation account', startUrl: url.href }
  } catch {
    return null
  }
}

export const EXTERNAL_LOGIN_FAILURES = [
  'configuration',
  'encoding',
  'header',
  'signature',
  'claims',
  'issuer',
  'audience',
  'lifetime',
  'email',
  'replay',
  'storage',
  'session',
] as const
export type ExternalLoginFailure = typeof EXTERNAL_LOGIN_FAILURES[number]
export class ExternalLoginError extends Error {
  constructor(readonly reason: ExternalLoginFailure) {
    super('External sign-in rejected')
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1).refine((value) =>
    Array.from(value).length <= 128 && !/\p{Cc}/u.test(value)
  ),
  email: z.string().email().max(254),
  email_verified: z.literal(true),
  name: z.string().max(512).optional(),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  jti: z.string().min(16),
})

function decode(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) {
    throw new ExternalLoginError('encoding')
  }
  const bytes = Uint8Array.from(
    atob(part.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  )
  if (
    btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(
      /\//g,
      '_',
    ) !== part
  ) {
    throw new ExternalLoginError('encoding')
  }
  return bytes
}

/** No discovery or key fetching: only the deployment's pinned public key can verify assertions. */
export async function verifyExternalAssertion(
  token: string | null,
  config: ExternalLoginConfig,
  now = Date.now(),
) {
  if (!externalLoginConfigured(config) || !config.audience) {
    throw new ExternalLoginError('configuration')
  }
  if (!token || token.length > 8192) throw new ExternalLoginError('encoding')
  const parts = token.split('.')
  if (parts.length !== 3) throw new ExternalLoginError('encoding')
  let header: Record<string, unknown>
  let payload: unknown
  let signature: Uint8Array<ArrayBuffer>
  try {
    header = JSON.parse(decoder.decode(decode(parts[0]!)))
    payload = JSON.parse(decoder.decode(decode(parts[1]!)))
    signature = decode(parts[2]!)
  } catch {
    throw new ExternalLoginError('encoding')
  }
  if (
    !header || header.alg !== 'EdDSA' || header.typ !== 'JWT' || header.crit !== undefined ||
    header.b64 !== undefined
  ) {
    throw new ExternalLoginError('header')
  }
  let key: CryptoKey
  try {
    const jwk = JSON.parse(config.jwk!)
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || 'd' in jwk) {
      throw new Error('Invalid public key')
    }
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    throw new ExternalLoginError('configuration')
  }
  try {
    if (
      !await crypto.subtle.verify(
        'Ed25519',
        key,
        signature,
        encoder.encode(`${parts[0]}.${parts[1]}`),
      )
    ) {
      throw new Error('Invalid signature')
    }
  } catch {
    throw new ExternalLoginError('signature')
  }
  const parsed = claimsSchema.safeParse(payload)
  if (!parsed.success) {
    const emailFailure = parsed.error.issues.some((issue) =>
      ['email', 'email_verified'].includes(String(issue.path[0]))
    )
    throw new ExternalLoginError(emailFailure ? 'email' : 'claims')
  }
  const claims = parsed.data
  if (claims.iss !== config.issuer) throw new ExternalLoginError('issuer')
  if (claims.aud !== config.audience) throw new ExternalLoginError('audience')
  if (
    !Number.isSafeInteger(now) || claims.exp < claims.iat || claims.exp - claims.iat > 120 ||
    now / 1000 < claims.iat - 30 || now / 1000 > claims.exp
  ) throw new ExternalLoginError('lifetime')
  // JSON can represent unpaired surrogates; UTF-8 would collapse those identities on storage.
  if (decoder.decode(encoder.encode(claims.sub)) !== claims.sub) {
    throw new ExternalLoginError('claims')
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(JSON.stringify([claims.iss, claims.jti])),
  )
  return {
    ...claims,
    email: claims.email.toLowerCase(),
    replayKey: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
  }
}

/** Reject ambiguous paths at every percent-decoding layer, including browser backslash handling. */
export function externalReturnTo(value: string | null): string {
  // A Location header carries visible ASCII only; anything else must arrive percent-encoded.
  if (!value || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) return '/'
  let decoded = value
  for (let depth = 0; depth <= value.length; depth++) {
    if (
      !decoded.startsWith('/') || decoded.startsWith('//') ||
      decoded.includes('\\') || [...decoded].some((char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    ) return '/'
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return value
      decoded = next
    } catch {
      return '/'
    }
  }
  return '/'
}

/** The unique insert is atomic on SQLite, including separate adapters and Worker isolates. */
export class ExternalLoginReplayStore {
  constructor(private readonly database: SqlExecutor) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS external_login_replays (replay_key TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL)',
    )
    database.exec(
      'CREATE INDEX IF NOT EXISTS external_login_replays_by_expiry ON external_login_replays(expires_at)',
    )
  }
  consume(key: string, expiresAt: number, now = Date.now()): boolean {
    if (
      !/^[0-9a-f]{64}$/.test(key) || !Number.isSafeInteger(expiresAt) || expiresAt < now ||
      expiresAt > now + 150_000
    ) return false
    this.database.exec('DELETE FROM external_login_replays WHERE expires_at < ?', now)
    return this.database.all(
      'INSERT INTO external_login_replays (replay_key,expires_at) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING replay_key',
      key,
      expiresAt,
    ).length === 1
  }
}

export function auditExternalLoginFailure(audit: AuditStore, reason: ExternalLoginFailure): void {
  appendAudit(
    audit,
    createAuditEvent({
      requestId: crypto.randomUUID(),
      actor: { kind: 'anonymous' },
      action: 'auth.external.denied',
      scope: { kind: 'platform' },
      target: { kind: 'session' },
      outcome: 'denied',
      detail: { externalReason: reason },
    }),
  )
}
