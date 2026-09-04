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
}

const ANONYMOUS: AuthSession = { authenticated: false, user: null }

export async function getAuthSession(): Promise<AuthSession> {
  const response = await fetch('/auth/me', { headers: { accept: 'application/json' } })
  if (!response.ok) return ANONYMOUS
  const value: unknown = await response.json().catch(() => null)
  if (!value || typeof value !== 'object' || !('authenticated' in value)) return ANONYMOUS
  const session = value as Partial<AuthSession>
  return {
    authenticated: session.authenticated === true && Boolean(session.user),
    user: session.user ?? null,
  }
}

export function microsoftLoginUrl(returnTo = `${location.pathname}${location.search}`): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
}
