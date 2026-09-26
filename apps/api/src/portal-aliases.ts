import type { TenantConfig } from '@research-portal/core'
import {
  getPlatformDomain,
  isPlatformHostname,
} from '../../../packages/core/src/platform-domain.ts'

/**
 * Portal host aliases (docs/HOSTING.md): hostnames outside the platform domain that a hosting
 * operator routes to this deployment and registers for one portal. The portal never creates DNS,
 * certificates or routes for them. The alias records live with the portal registry, so the
 * registry's single write both removes a portal and its aliases, and a uniqueness check and the
 * insert it guards happen in one synchronous store call.
 */

export const DEFAULT_MAX_PORTAL_ALIASES = 5
const MAX_PORTAL_ALIASES_CEILING = 100
export const DEFAULT_ALIAS_CACHE_SECONDS = 30
const ALIAS_CACHE_SECONDS_CEILING = 300

/** An alias as the hosting routes return it. */
export interface PortalAlias {
  hostname: string
  primary: boolean
  createdAt: string
}

/** An alias as the portal registry stores it. */
export interface StoredPortalAlias extends PortalAlias {
  slug: string
}

export type AliasRefusal = 'hostname_taken' | 'alias_limit' | 'unknown_tenant'

export type AliasWriteResult =
  | { ok: true; aliases: PortalAlias[] }
  | { ok: false; error: AliasRefusal }

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Normalise a candidate alias hostname, or return null when it cannot be one. The value is
 * trimmed, lower-cased and loses one trailing dot. It must then be a DNS name of at least two
 * labels and at most 253 characters, made only of letters, digits and inner hyphens. Refused
 * outright, rather than decoded or guessed at:
 * - any label with hyphens in its third and fourth places, which covers every punycode (`xn--`)
 *   label and the other reserved encodings;
 * - a numeric last label, which no DNS name has and which covers every IPv4 spelling;
 * - ports, paths, wildcards, IPv6 literals and anything else outside the label alphabet;
 * - the platform domain and every name under it, which the platform routes itself;
 * - `workers.dev` names, which a hosting operator keeps for reaching the deployment directly.
 */
export function aliasHostname(value: unknown, platformDomain: string): string | null {
  if (typeof value !== 'string') return null
  let hostname = value.trim().toLowerCase()
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  if (!hostname || hostname.length > 253) return null
  const labels = hostname.split('.')
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) return null
  if (labels.some((label) => label.slice(2, 4) === '--')) return null
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null
  if (isPlatformHostname(hostname, getPlatformDomain(platformDomain))) return null
  if (hostname === 'workers.dev' || hostname.endsWith('.workers.dev')) return null
  return hostname
}

/** `MAX_PORTAL_ALIASES`: a whole number from 0 to 100, otherwise the default of 5. */
export function maxPortalAliases(value: string | undefined): number {
  return wholeNumber(value, DEFAULT_MAX_PORTAL_ALIASES, MAX_PORTAL_ALIASES_CEILING)
}

/** `ALIAS_CACHE_SECONDS`: a whole number from 0 to 300, otherwise the default of 30. */
export function aliasCacheSeconds(value: string | undefined): number {
  return wholeNumber(value, DEFAULT_ALIAS_CACHE_SECONDS, ALIAS_CACHE_SECONDS_CEILING)
}

function wholeNumber(value: string | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !/^\s*\d{1,6}\s*$/.test(value)) return fallback
  const parsed = Number(value)
  return parsed <= ceiling ? parsed : fallback
}

/** Read the persisted alias list. Anything malformed fails closed, like the rest of the registry. */
export function storedAliases(value: unknown): StoredPortalAlias[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid persisted portal configuration')
  const seen = new Set<string>()
  return value.map((entry) => {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.hostname !== 'string' || typeof entry.slug !== 'string' ||
      typeof entry.primary !== 'boolean' || typeof entry.createdAt !== 'string' ||
      !DNS_NAME.test(entry.hostname) || !entry.slug || seen.has(entry.hostname)
    ) throw new Error('Invalid persisted portal configuration')
    seen.add(entry.hostname)
    return {
      hostname: entry.hostname,
      slug: entry.slug,
      primary: entry.primary,
      createdAt: entry.createdAt,
    }
  })
}
/** One portal's aliases, oldest first. */
export function aliasesFor(aliases: readonly StoredPortalAlias[], slug: string): PortalAlias[] {
  return aliases.filter((alias) => alias.slug === slug)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.hostname.localeCompare(b.hostname))
    .map(({ hostname, primary, createdAt }) => ({ hostname, primary, createdAt }))
}

/** A portal's configuration with its primary alias, if it has one, as the canonical hostname. */
export function withPrimaryAlias(
  config: TenantConfig,
  aliases: readonly StoredPortalAlias[],
): TenantConfig {
  const primary = aliases.find((alias) => alias.slug === config.slug && alias.primary)
  return primary ? { ...config, hostname: primary.hostname } : config
}

/**
 * Register or update one alias. Idempotent: an alias the portal already has keeps its creation
 * time, and `primary` changes only when it is given. `primary: true` clears every other primary
 * alias of the portal. A hostname registered to another portal, or used as another portal's own
 * hostname (`claimed`), is refused, as is a new alias past `limit`.
 */
export function applyAlias(
  aliases: readonly StoredPortalAlias[],
  input: {
    slug: string
    hostname: string
    primary?: boolean
    limit: number
    createdAt: string
    claimed: (hostname: string) => boolean
  },
): { ok: true; aliases: StoredPortalAlias[] } | { ok: false; error: AliasRefusal } {
  const existing = aliases.find((alias) => alias.hostname === input.hostname)
  if (existing && existing.slug !== input.slug) return { ok: false, error: 'hostname_taken' }
  if (!existing && input.claimed(input.hostname)) return { ok: false, error: 'hostname_taken' }
  if (!existing && aliases.filter((alias) => alias.slug === input.slug).length >= input.limit) {
    return { ok: false, error: 'alias_limit' }
  }
  const primary = input.primary ?? existing?.primary ?? false
  const next = aliases.filter((alias) => alias.hostname !== input.hostname).map((alias) =>
    primary && alias.slug === input.slug && alias.primary ? { ...alias, primary: false } : alias
  )
  next.push({
    hostname: input.hostname,
    slug: input.slug,
    primary,
    createdAt: existing?.createdAt ?? input.createdAt,
  })
  return { ok: true, aliases: next }
}

/** Remove one of a portal's aliases. Another portal's alias of the same name is left alone. */
export function withoutAlias(
  aliases: readonly StoredPortalAlias[],
  slug: string,
  hostname: string,
): StoredPortalAlias[] {
  return aliases.filter((alias) => !(alias.slug === slug && alias.hostname === hostname))
}

/** The registry lookup a request host resolves through. */
export interface HostPortalLookup {
  aliasPortal(hostname: string): string | undefined
}

/**
 * The portal whose registered alias the request host is, or null. Platform hosts, local hosts
 * and IP literals are never aliases and are not looked up.
 */
export function hostPortalFor(
  tenants: HostPortalLookup,
  hostname: string,
  platformDomain: string,
): string | null {
  const candidate = aliasHostname(hostname, platformDomain)
  return candidate ? tenants.aliasPortal(candidate) ?? null : null
}

/** How the edge answers a request that arrives on one portal's alias host. */
export type AliasHostRoute =
  | { kind: 'redirect'; location: string }
  | { kind: 'auth' }
  | { kind: 'api' }
  | { kind: 'page' }
  | { kind: 'not_found'; api: boolean }

/** Platform pages (administration, marketing and documentation) belong to platform hosts only. */
const PLATFORM_PAGE = /^\/(?:admin|about|docs|home)(?:[/.]|$)/

/**
 * Route a request on the alias host of `slug`. Only that portal is served: its pages and API,
 * the sign-in routes, the SPA shell and static assets. Every other portal's pages and API, the
 * platform-scope API and the platform pages are not found. The API checks each route against its
 * permission declaration as well (see `aliasHostAllows`).
 */
export function aliasHostRoute(method: string, url: URL, slug: string): AliasHostRoute {
  const path = url.pathname
  if ((method === 'GET' || method === 'HEAD') && path === '/') {
    return { kind: 'redirect', location: `/t/${slug}${url.search}` }
  }
  if (path.startsWith('/auth/')) return { kind: 'auth' }
  if (path === '/api' || path.startsWith('/api/')) {
    return aliasApiPath(path, slug) ? { kind: 'api' } : { kind: 'not_found', api: true }
  }
  if (path.startsWith('/t/')) {
    return path.slice('/t/'.length).split('/')[0] === slug
      ? { kind: 'page' }
      : { kind: 'not_found', api: false }
  }
  if (PLATFORM_PAGE.test(path)) return { kind: 'not_found', api: false }
  return { kind: 'page' }
}

/** API paths an alias host forwards: this portal's routes, the portal list and health. */
export function aliasApiPath(path: string, slug: string): boolean {
  return path === '/api/health' || path === '/api/tenants' ||
    path === `/api/t/${slug}` || path.startsWith(`/api/t/${slug}/`) ||
    path.startsWith(`/api/admin/t/${slug}/`)
}

/**
 * Per-isolate memory of host lookups, positive and negative, each for at most its time to live.
 * Bounded, so a stream of distinct hosts cannot grow it without limit.
 */
export class HostPortalCache {
  private readonly entries = new Map<string, { slug: string | null; expiresAt: number }>()

  constructor(private readonly maxEntries = 1000) {}

  get(hostname: string, now: number): string | null | undefined {
    const entry = this.entries.get(hostname)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(hostname)
      return undefined
    }
    return entry.slug
  }

  set(hostname: string, slug: string | null, ttlSeconds: number, now: number): void {
    this.entries.delete(hostname)
    if (ttlSeconds <= 0) return
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(hostname, { slug, expiresAt: now + ttlSeconds * 1000 })
  }

  clear(): void {
    this.entries.clear()
  }
}
