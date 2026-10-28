import type { Context } from 'hono'
import { z } from 'zod'
import { acceptsSiteFeedback, type TenantConfig } from '@research-portal/core'
import {
  addressKey,
  admitAll,
  rateLimited,
  releaseAll,
  SlidingWindowLimiter,
} from './rate-limit.ts'

// ---------------------------------------------------------------------------
// Reader feedback about a portal: a message, an optional reply address and the page it was sent
// from. A portal opts in (`siteFeedback: true`), and the deployment supplies where it goes (a
// notifier, the Worker's email binding). Each message is kept before it is sent, so a failed
// delivery never loses it, and is personal data: bounded, aged out after `SITE_FEEDBACK_DAYS`
// and erased with the portal.
// ---------------------------------------------------------------------------

export const SITE_FEEDBACK_CATEGORIES = ['general', 'answer', 'problem', 'suggestion'] as const
export type SiteFeedbackCategory = typeof SITE_FEEDBACK_CATEGORIES[number]

/** Messages kept per portal; the newest win. */
export const SITE_FEEDBACK_KEEP = 500
/** Days a message is kept. */
export const SITE_FEEDBACK_DAYS = 90
export const SITE_FEEDBACK_MESSAGE_MAX = 4000
export const SITE_FEEDBACK_EMAIL_MAX = 254
const PAGE_PATH_MAX = 1024
const PAGE_URL_MAX = 2048
const MAX_BODY_BYTES = 24_000
const NOTIFICATION_ID_MAX = 500
const DAY_MS = 24 * 3600 * 1000

/** Messages one address may send one portal in ten minutes. */
export const SITE_FEEDBACK_PER_ADDRESS = 5
/** Messages one portal accepts in an hour, from every address together. */
export const SITE_FEEDBACK_PER_PORTAL = 60

const CATEGORY_LABELS: Record<SiteFeedbackCategory, string> = {
  general: 'General feedback',
  answer: 'Answer quality',
  problem: 'A problem with the portal',
  suggestion: 'An idea for improvement',
}

const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })

/** A same-origin path, never a query string or fragment: those can carry what a reader typed. */
const pagePathSchema = z.string().max(PAGE_PATH_MAX).regex(/^\/(?!\/)[^?#\\\s]*$/)
  .refine((path) => !hasControlCharacter(path))

const bodySchema = z.object({
  message: z.string().trim().min(1).max(SITE_FEEDBACK_MESSAGE_MAX),
  email: z.string().trim().email().max(SITE_FEEDBACK_EMAIL_MAX).optional(),
  category: z.enum(SITE_FEEDBACK_CATEGORIES),
  pagePath: pagePathSchema,
  /** The honeypot: hidden from people, so only a form-filling bot sends it. */
  website: z.string().max(500).optional(),
}).strict()

export interface SiteFeedbackRecord {
  id: string
  /** The portal it was sent to. */
  slug: string
  createdAt: string
  category: SiteFeedbackCategory
  message: string
  /** Where the reader asked to be answered, when they said. */
  email?: string
  /** The page it was sent from: the portal's origin and the path, nothing after it. */
  pageUrl: string
  delivery: 'pending' | 'sent' | 'failed'
  /** The provider's id for the notification, once it acknowledged one. */
  notificationId?: string
}

const recordSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  category: z.enum(SITE_FEEDBACK_CATEGORIES),
  message: z.string().min(1).max(SITE_FEEDBACK_MESSAGE_MAX),
  email: z.string().max(SITE_FEEDBACK_EMAIL_MAX).optional(),
  pageUrl: z.string().url().max(PAGE_URL_MAX),
  delivery: z.enum(['pending', 'sent', 'failed']),
  notificationId: z.string().max(NOTIFICATION_ID_MAX).optional(),
}).strict()

/** A stored message, or null for anything that is not one. */
export function parseSiteFeedbackRecord(value: unknown): SiteFeedbackRecord | null {
  const parsed = recordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The oldest moment a message may have been received and still be kept at `now`. */
export function siteFeedbackCutoff(now: number): number {
  return now - SITE_FEEDBACK_DAYS * DAY_MS
}

/**
 * The messages a portal keeps at `now`: within the window, newest first (ties by id, as the
 * Durable Object's table orders them), at most the cap.
 */
export function retainedSiteFeedback(
  records: readonly SiteFeedbackRecord[],
  now: number,
): SiteFeedbackRecord[] {
  const cutoff = siteFeedbackCutoff(now)
  return records.filter((record) => Date.parse(record.createdAt) >= cutoff)
    .sort((a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    )
    .slice(0, SITE_FEEDBACK_KEEP)
}

export interface SiteFeedbackStoreApi {
  /** Keep a message, replacing the one with its id, then drop what ages out or passes the cap. */
  save(slug: string, record: SiteFeedbackRecord): void
  /** The portal's messages, newest first, at most `limit`. */
  recent(slug: string, limit: number): SiteFeedbackRecord[]
  /** Remove every portal's messages older than the window; how many went. */
  purgeExpired(): number
  /** Remove the portal's messages (see `PortalErasure`). */
  erase(slug: string): number
}

/** Delivers one message; resolves to the provider's id for it, or rejects. */
export type SiteFeedbackNotifier = (
  portal: Pick<TenantConfig, 'slug' | 'branding'>,
  record: SiteFeedbackRecord,
) => Promise<string>

export interface SiteFeedbackRouteOptions {
  /** The portal readers can see under the slug, or undefined. */
  portal(slug: string): TenantConfig | undefined
  store: SiteFeedbackStoreApi
  notifier?: SiteFeedbackNotifier
  /** The client address the runtime reported, never a header the caller chose. */
  clientAddress(c: Context): string | undefined
  now?: () => number
}

/** Whether the portal takes feedback on this deployment: it opted in and it can be delivered. */
export function siteFeedbackAvailable(
  config: Pick<TenantConfig, 'siteFeedback'>,
  notifier: SiteFeedbackNotifier | undefined,
): boolean {
  return notifier !== undefined && acceptsSiteFeedback(config)
}

/** Read a small JSON body without trusting Content-Length or buffering an arbitrary upload. */
async function feedbackBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length')
  if (length && Number(length) > MAX_BODY_BYTES) throw new RangeError('body_too_large')
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new RangeError('body_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/**
 * `POST /api/t/:slug/site-feedback`. A portal that has not opted in, or a deployment with nowhere
 * to deliver, answers 404 as for a route that does not exist. Only a page of the portal's own
 * origin may post, as JSON, so another site cannot send mail through it from a visitor's browser.
 */
export function siteFeedbackHandler(options: SiteFeedbackRouteOptions) {
  const now = options.now ?? Date.now
  const perAddress = new SlidingWindowLimiter({
    limit: SITE_FEEDBACK_PER_ADDRESS,
    windowMs: 10 * 60_000,
    now,
  })
  const perPortal = new SlidingWindowLimiter({
    limit: SITE_FEEDBACK_PER_PORTAL,
    windowMs: 60 * 60_000,
    now,
  })
  return async (c: Context) => {
    c.header('Cache-Control', 'no-store')
    const config = options.portal(c.req.param('slug') ?? '')
    if (!config || !siteFeedbackAvailable(config, options.notifier)) {
      return c.json({ error: 'not_found' }, 404)
    }
    const notify = options.notifier!
    const request = c.req.raw
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    let originHost: string | null = null
    try {
      originHost = origin ? new URL(origin).host : null
    } catch { /* An unreadable origin is refused below. */ }
    // The host, not the scheme: a proxy that ends TLS in front of the local server forwards
    // plain HTTP for a page the browser loaded over HTTPS.
    if (
      originHost !== url.host || request.headers.get('sec-fetch-site') === 'cross-site'
    ) {
      return c.json({ error: 'feedback_origin_not_allowed' }, 403)
    }
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return c.json({ error: 'invalid_request' }, 415)
    }
    // Both or neither: one address that keeps sending is held at its own limit before it can
    // spend the portal's, and an address limit alone could be dodged by spreading addresses.
    const address = addressKey(options.clientAddress(c))
    const admitted = admitAll([
      { limiter: perAddress, key: `${address}|${config.slug}` },
      { limiter: perPortal, key: config.slug },
    ])
    if (!admitted.allowed) return rateLimited(c, admitted.retryAfterSec)
    // A request that keeps nothing gives the portal its turn back, so junk cannot keep readers
    // out. The sender's own bucket keeps it, to slow the junk down.
    const refuse = (response: Response) => {
      releaseAll(admitted.receipt, (entry) => entry.limiter === perPortal)
      return response
    }
    let raw: unknown
    try {
      raw = await feedbackBody(request)
    } catch (error) {
      return refuse(
        error instanceof RangeError
          ? c.json({ error: 'request_too_large' }, 413)
          : c.json({ error: 'invalid_request' }, 400),
      )
    }
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) return refuse(c.json({ error: 'invalid_request' }, 400))
    if (parsed.data.website?.trim()) return refuse(c.json({ ok: true }, 202))
    const { website: _website, pagePath, ...input } = parsed.data
    const record: SiteFeedbackRecord = {
      id: crypto.randomUUID(),
      slug: config.slug,
      createdAt: new Date(now()).toISOString(),
      category: input.category,
      message: input.message,
      ...(input.email ? { email: input.email } : {}),
      pageUrl: `${url.origin}${pagePath}`,
      delivery: 'pending',
    }
    // Kept before it is sent, so a failed delivery never loses it.
    options.store.save(config.slug, record)
    // Once the notifier has answered, the reader's answer follows it: a status that could not be
    // recorded must not ask them to send a message again that has already gone.
    const settle = (outcome: Pick<SiteFeedbackRecord, 'delivery' | 'notificationId'>) => {
      try {
        options.store.save(config.slug, { ...record, ...outcome })
      } catch {
        console.error(JSON.stringify({
          message: 'site feedback delivery was not recorded',
          id: record.id,
          delivery: outcome.delivery,
        }))
      }
    }
    let notificationId: string
    try {
      notificationId = await notify(config, record)
    } catch {
      settle({ delivery: 'failed' })
      console.error(JSON.stringify({ message: 'site feedback was not delivered', id: record.id }))
      return c.json({ error: 'site_feedback_failed', id: record.id }, 502)
    }
    settle({ delivery: 'sent', notificationId: notificationId.slice(0, NOTIFICATION_ID_MAX) })
    return c.json({ ok: true, id: record.id }, 201)
  }
}

/**
 * `GET /api/admin/t/:slug/site-feedback`: the portal's kept messages, newest first, for when a
 * delivery failed or a notification went astray. Answers whether or not the portal still takes
 * feedback, since what it kept stays until it ages out or the portal is erased.
 */
export function siteFeedbackHistoryHandler(
  options: Pick<SiteFeedbackRouteOptions, 'portal' | 'store'>,
) {
  return (c: Context) => {
    c.header('Cache-Control', 'no-store')
    const config = options.portal(c.req.param('slug') ?? '')
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const requested = Number(c.req.query('limit') ?? 50)
    const limit = Number.isInteger(requested) ? Math.min(100, Math.max(1, requested)) : 50
    return c.json({ feedback: options.store.recent(config.slug, limit) })
  }
}

// --- Email delivery (the Worker's `send_email` binding) ----------------------

export interface SiteFeedbackEmail {
  to: string
  from: { email: string; name: string }
  replyTo?: string
  subject: string
  text: string
  html: string
}

/** The options form of Cloudflare Email Service's `send_email` binding. */
export interface SiteFeedbackEmailBinding {
  send(message: SiteFeedbackEmail): Promise<{ messageId: string }>
}

/** The email settings, by variable name; see docs/HOSTING.md, "Reader feedback". */
export const SITE_FEEDBACK_ENV = {
  binding: 'SITE_FEEDBACK_EMAIL_BINDING',
  from: 'SITE_FEEDBACK_FROM',
  to: 'SITE_FEEDBACK_TO',
} as const
export const DEFAULT_SITE_FEEDBACK_BINDING = 'SITE_FEEDBACK_EMAIL'

const emailAddress = z.string().trim().email().max(SITE_FEEDBACK_EMAIL_MAX)
const bindingName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export interface SiteFeedbackEmailConfig {
  /** The name of the `send_email` binding to send with. */
  binding: string
  from: string
  to: string
}

/** The email settings, or null unless both addresses are set and valid. */
export function siteFeedbackEmailConfig(
  env: Record<string, string | undefined>,
): SiteFeedbackEmailConfig | null {
  const binding = env[SITE_FEEDBACK_ENV.binding]?.trim() || DEFAULT_SITE_FEEDBACK_BINDING
  const from = emailAddress.safeParse(env[SITE_FEEDBACK_ENV.from])
  const to = emailAddress.safeParse(env[SITE_FEEDBACK_ENV.to])
  if (!bindingName.test(binding) || !from.success || !to.success) return null
  return { binding, from: from.data, to: to.data }
}

/** Whether a runtime value is a `send_email` binding this module can send with. */
export function isSiteFeedbackEmailBinding(value: unknown): value is SiteFeedbackEmailBinding {
  return typeof value === 'object' && value !== null &&
    typeof (value as { send?: unknown }).send === 'function'
}

/**
 * One start-up warning when reader feedback is partly configured: an address is set, but the
 * addresses or the binding are not usable. Never includes a value.
 */
export function siteFeedbackWarning(
  env: Record<string, string | undefined>,
  hasBinding: (name: string) => boolean,
): string | null {
  const touched = Object.values(SITE_FEEDBACK_ENV).some((name) => env[name]?.trim())
  if (!touched) return null
  const config = siteFeedbackEmailConfig(env)
  if (!config) {
    return `Reader feedback is off: ${SITE_FEEDBACK_ENV.from} and ${SITE_FEEDBACK_ENV.to} must ` +
      `both be email addresses, and ${SITE_FEEDBACK_ENV.binding} a binding name`
  }
  return hasBinding(config.binding)
    ? null
    : `Reader feedback is off: there is no send_email binding named by ${SITE_FEEDBACK_ENV.binding}`
}

/** A portal-authored name, safe for an email header: one line, bounded. */
function headerText(value: string, max: number): string {
  const line = [...value].map((character) => hasControlCharacter(character) ? ' ' : character)
    .join('').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

/**
 * Email each message to the deployment's address. Both the sender and the recipient come from
 * deployment configuration, never from the reader; the reader's address is only the reply-to.
 */
export function siteFeedbackEmailNotifier(
  binding: SiteFeedbackEmailBinding,
  config: Pick<SiteFeedbackEmailConfig, 'from' | 'to'>,
): SiteFeedbackNotifier {
  return async (portal, record) => {
    const name = headerText(portal.branding.productName, 60) || portal.slug
    const category = CATEGORY_LABELS[record.category]
    const text = [
      `Feedback from ${name}`,
      '',
      `Reference: ${record.id}`,
      `Received: ${record.createdAt}`,
      `About: ${category}`,
      `Page: ${record.pageUrl}`,
      `Reply to: ${record.email ?? 'Not given'}`,
      '',
      record.message,
    ].join('\n')
    const result = await binding.send({
      to: config.to,
      from: { email: config.from, name: `${name} feedback` },
      ...(record.email ? { replyTo: record.email } : {}),
      subject: `${name} feedback: ${category}`,
      text,
      html: `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif">${
        escapeHtml(text)
      }</pre>`,
    })
    if (!result?.messageId) throw new Error('The email provider did not acknowledge the message')
    return result.messageId
  }
}
