import type { EffectiveRoles, Role, Scope } from '@research-portal/core'

export interface AuthUser {
  id: string
  tenantId: string
  name: string
  email: string
  roles: string[]
  isAdmin: boolean
}

export interface AuthSession {
  authenticated: boolean
  user: AuthUser | null
  effectiveRoles?: EffectiveRoles
  provenance?: { source: 'app-role' | 'group' | 'local'; scope: Scope; role: Role }[]
  claimAgeSeconds?: number | null
  groupMappings?:
    | 'enabled'
    | 'disabled'
    | 'complete'
    | 'absent'
    | 'malformed'
    | 'overage'
    | 'unverified'
  coarseAdminEligible?: boolean
  breakGlassEnabled?: boolean
}

const ANONYMOUS: AuthSession = {
  authenticated: false,
  user: null,
  coarseAdminEligible: false,
  breakGlassEnabled: false,
}

export async function getAuthSession(): Promise<AuthSession> {
  const response = await fetch('/auth/me', { headers: { accept: 'application/json' } }).catch(() =>
    null
  )
  if (!response?.ok) return ANONYMOUS
  const value: unknown = await response.json().catch(() => null)
  if (!value || typeof value !== 'object' || !('authenticated' in value)) return ANONYMOUS
  const session = value as Partial<AuthSession>
  if (typeof session.authenticated !== 'boolean') return ANONYMOUS
  return {
    authenticated: session.authenticated === true && Boolean(session.user),
    user: session.user ?? null,
    effectiveRoles: session.effectiveRoles,
    provenance: session.provenance,
    claimAgeSeconds: session.claimAgeSeconds,
    groupMappings: session.groupMappings,
    coarseAdminEligible: session.authenticated === true && Boolean(session.user) &&
      session.coarseAdminEligible === true,
    breakGlassEnabled: session.breakGlassEnabled === true,
  }
}

export function microsoftLoginUrl(returnTo = `${location.pathname}${location.search}`): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
}
