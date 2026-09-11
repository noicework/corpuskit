import { appendAudit, type AuditActor, type AuditStore, createAuditEvent } from './audit.ts'
import type { RbacDatabase } from './rbac-state.ts'

export interface BreakGlassPolicy {
  passcode?: string
  environment?: string
  explicitFlag?: string
}
export interface BreakGlassContext {
  requestId: string
  /** Actual peer metadata supplied internally by the runtime, never forwarding headers. */
  clientIp?: string
  session: { tenantId: string; oid: string } | null
}
export type BreakGlassResult =
  | { ok: true; role: 'owner'; actor: AuditActor }
  | { ok: false; code: 'unavailable' | 'invalid_passcode' | 'locked'; retryAfter?: number }

export function breakGlassEnabled(
  passcodeConfigured: boolean,
  environment?: string,
  explicitFlag?: string,
): boolean {
  return passcodeConfigured && (explicitFlag === 'true' || environment !== 'production')
}

/** Native HMAC verification avoids data-dependent JavaScript comparison. Nothing is persisted. */
async function equalCredential(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const tag = await crypto.subtle.sign('HMAC', key, encoder.encode(expected))
  return crypto.subtle.verify('HMAC', key, tag, encoder.encode(candidate))
}

const windowMs = 600_000

/** Internal service only. Its result belongs to this request and never creates a session. */
export class BreakGlassService {
  readonly enabled: boolean
  constructor(
    private readonly database: RbacDatabase,
    private readonly audit: AuditStore,
    private readonly policy: BreakGlassPolicy,
    private readonly now = Date.now,
  ) {
    this.enabled = breakGlassEnabled(
      Boolean(policy.passcode),
      policy.environment,
      policy.explicitFlag,
    )
  }

  async authorise(request: Request, context: BreakGlassContext): Promise<BreakGlassResult> {
    const credential = request.headers.get('x-admin-passcode')
    const eligible = this.enabled && Boolean(context.clientIp?.trim())
    const matches = eligible && credential !== null &&
      await equalCredential(credential, this.policy.passcode!)
    // All reads and writes after async crypto share one transaction. Concurrent requests
    // therefore see the fifth failure's lock, including requests with a correct credential.
    return this.database.transactionSync(() => {
      const at = this.now()
      const sessionDetail = context.session
        ? { sessionOid: context.session.oid, sessionTenantId: context.session.tenantId }
        : {}
      const record = (
        action: 'break_glass.used' | 'break_glass.failed' | 'break_glass.locked',
        detail: Record<string, unknown>,
      ) =>
        appendAudit(
          this.audit,
          createAuditEvent({
            requestId: context.requestId,
            actor: { kind: 'break-glass' },
            action,
            scope: { kind: 'platform' },
            target: { kind: 'request' },
            outcome: action === 'break_glass.used' ? 'success' : 'denied',
            detail: { ...sessionDetail, ...detail },
          }, () => at),
        )
      if (!eligible) {
        record('break_glass.failed', { code: 'unavailable' })
        return { ok: false, code: 'unavailable' }
      }
      const ip = context.clientIp!
      const lockedUntil = this.database.all<{ locked_until: number }>(
        'SELECT locked_until FROM break_glass_locks WHERE trusted_ip = ?',
        ip,
      )[0]?.locked_until ?? 0
      if (lockedUntil > at) {
        record('break_glass.locked', { code: 'locked', lockedUntil })
        return { ok: false, code: 'locked', retryAfter: Math.ceil((lockedUntil - at) / 1000) }
      }
      this.database.exec(
        'DELETE FROM break_glass_locks WHERE trusted_ip = ? AND locked_until <= ?',
        ip,
        at,
      )
      this.database.exec('DELETE FROM break_glass_attempts WHERE at <= ?', at - windowMs)
      if (matches) {
        record('break_glass.used', {})
        return { ok: true, role: 'owner', actor: { kind: 'break-glass' } }
      }
      this.database.exec(
        'INSERT INTO break_glass_attempts (id,trusted_ip,at) VALUES (?,?,?)',
        crypto.randomUUID(),
        ip,
        at,
      )
      const count = this.database.all<{ n: number }>(
        'SELECT count(*) AS n FROM break_glass_attempts WHERE trusted_ip = ?',
        ip,
      )[0]!.n
      record('break_glass.failed', { code: 'invalid_passcode', count })
      if (count >= 5) {
        const until = at + windowMs
        this.database.exec(
          'INSERT INTO break_glass_locks (trusted_ip,locked_until) VALUES (?,?) ON CONFLICT(trusted_ip) DO UPDATE SET locked_until=excluded.locked_until',
          ip,
          until,
        )
        record('break_glass.locked', { code: 'locked', count, lockedUntil: until })
        return { ok: false, code: 'locked', retryAfter: 600 }
      }
      return { ok: false, code: 'invalid_passcode' }
    })
  }
}
