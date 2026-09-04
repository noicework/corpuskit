import { expect } from '@std/expect'
import { type AuthConfig, authConfigured, handleAuthRequest } from './auth.ts'

const config: AuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  tenantId: 'tenant-id',
  sessionSecret: 'session-secret-with-more-than-thirty-two-bytes',
}

Deno.test('auth configuration fails closed when any credential is absent', () => {
  expect(authConfigured(config)).toBe(true)
  expect(authConfigured({ ...config, clientSecret: undefined })).toBe(false)
  expect(authConfigured({ ...config, sessionSecret: undefined })).toBe(false)
  expect(authConfigured({ ...config, sessionSecret: 'too-short' })).toBe(false)
})

Deno.test('/auth/me reports an anonymous session without calling Entra', async () => {
  const response = await handleAuthRequest(new Request('https://corpuskit.test/auth/me'), config)
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ authenticated: false, user: null })
  expect(response?.headers.get('cache-control')).toBe('no-store')
})

Deno.test('/auth/logout expires the encrypted session cookie', async () => {
  const response = await handleAuthRequest(
    new Request('https://corpuskit.test/auth/logout'),
    config,
  )
  expect(response?.status).toBe(302)
  expect(response?.headers.get('location')).toBe('/')
  expect(response?.headers.get('set-cookie')).toContain('__Secure-corpuskit_session=;')
  expect(response?.headers.get('set-cookie')).toContain('Max-Age=0')
})

Deno.test('/auth/logout clears a session across every corpuskit.org portal', async () => {
  const response = await handleAuthRequest(
    new Request('https://marine.corpuskit.org/auth/logout'),
    { ...config, cookieDomain: 'corpuskit.org' },
  )
  expect(response?.headers.get('set-cookie')).toContain('Domain=corpuskit.org')
})
