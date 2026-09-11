import { z } from 'zod'

export const PRINCIPAL_HEADER = 'x-corpuskit-principal'
const maximumHeaderBytes = 8192
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/)

/** D4 wire fields only. Original session facts travel separately in trusted internal context. */
export const PrincipalEnvelopeSchema = z.object({
  v: z.literal(1),
  aud: z.enum(['corpuskit', 'corpuskit-demo', 'corpuskit-demos']),
  tid: identifier,
  oid: identifier,
  email: z.string().max(254),
  name: z.string().max(512),
  roles: z.array(z.string().min(1).max(256)).max(1024),
  groups: z.array(identifier).max(1024),
  /** Seconds since Unix epoch. This is transport issuance, not original claim age. */
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type PrincipalEnvelope = z.infer<typeof PrincipalEnvelopeSchema>
export interface PrincipalVerificationConfig {
  sessionSecret: string
  audience: string
  tenantId: string
}
export type PrincipalRejectionCode =
  | 'size'
  | 'encoding'
  | 'signature'
  | 'schema'
  | 'audience'
  | 'tenant'
  | 'freshness'
  | 'configuration'
export type PrincipalVerification =
  | { kind: 'anonymous' }
  | { kind: 'verified'; envelope: PrincipalEnvelope }
  | { kind: 'rejected'; code: PrincipalRejectionCode }

export class PrincipalSigningError extends Error {
  constructor(readonly code: PrincipalRejectionCode) {
    super(`Principal signing failed: ${code}`)
    this.name = 'PrincipalSigningError'
  }
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(
    /\//g,
    '_',
  )
}
function decode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null
  try {
    const bytes = Uint8Array.from(
      atob(value.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    )
    return encode(bytes) === value ? bytes : null
  } catch {
    return null
  }
}

function validSecret(secret: string): boolean {
  return typeof secret === 'string' && encoder.encode(secret).byteLength >= 32
}

/** Empty salt is fixed across Worker and Deno; HKDF info separates this key from cookies. */
async function signingKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encoder.encode('corpuskit-principal-v1'),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

/** Trusted ingress supplies the exact D4 fields after session verification. */
export async function signPrincipal(
  payload: PrincipalEnvelope,
  sessionSecret: string,
): Promise<string> {
  if (!validSecret(sessionSecret)) throw new PrincipalSigningError('configuration')
  const parsed = PrincipalEnvelopeSchema.safeParse(payload)
  if (!parsed.success) throw new PrincipalSigningError('schema')
  const bytes = encoder.encode(JSON.stringify(parsed.data))
  // Bound before base64 conversion as well as after it; large claim arrays cannot spread unbounded bytes.
  if (bytes.byteLength > maximumHeaderBytes) throw new PrincipalSigningError('size')
  const body = encode(bytes)
  if (body.length + 1 + 43 > maximumHeaderBytes) throw new PrincipalSigningError('size')
  const signature = await crypto.subtle.sign('HMAC', await signingKey(sessionSecret), bytes)
  return `${body}.${encode(new Uint8Array(signature))}`
}

/** Missing means anonymous. Every present invalid envelope has an explicit typed rejection. */
export async function verifyPrincipal(
  header: string | null,
  config: PrincipalVerificationConfig,
  now = Date.now(),
): Promise<PrincipalVerification> {
  if (header === null) return { kind: 'anonymous' }
  const reject = (code: PrincipalRejectionCode): PrincipalVerification => ({
    kind: 'rejected',
    code,
  })
  if (encoder.encode(header).byteLength > maximumHeaderBytes) return reject('size')
  const segments = header.split('.')
  if (segments.length !== 2) return reject('encoding')
  const bytes = decode(segments[0]!)
  const signature = decode(segments[1]!)
  if (!bytes || !signature || signature.byteLength !== 32) return reject('encoding')
  if (!validSecret(config.sessionSecret)) return reject('configuration')
  try {
    if (
      !await crypto.subtle.verify('HMAC', await signingKey(config.sessionSecret), signature, bytes)
    ) return reject('signature')
  } catch {
    return reject('configuration')
  }
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    return reject('encoding')
  }
  const parsed = PrincipalEnvelopeSchema.safeParse(value)
  if (!parsed.success) return reject('schema')
  const envelope = parsed.data
  if (envelope.aud !== config.audience) return reject('audience')
  if (envelope.tid !== config.tenantId) return reject('tenant')
  const age = now - envelope.iat * 1000
  if (!Number.isSafeInteger(now) || age > 60_000 || age < -30_000) return reject('freshness')
  return { kind: 'verified', envelope }
}

/** Clone first so callers can safely sanitise immutable inbound request headers. */
export function stripIdentityHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input)
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase()
    if (
      lower === PRINCIPAL_HEADER || lower.startsWith('x-corpuskit-sso-') ||
      lower.startsWith('x-sso-')
    ) headers.delete(name)
  }
  return headers
}
