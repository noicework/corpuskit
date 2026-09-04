export interface AuthConfig {
  clientId: string
  clientSecret: string
  tenantId: string
  sessionSecret: string
  redirectUri?: string
  adminEmails?: string
  cookieDomain?: string
}

export interface AuthUser {
  id: string
  tenantId: string
  name: string
  email: string
  roles: string[]
  isAdmin: boolean
}

interface OidcState {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  expiresAt: number
}

interface SessionPayload extends AuthUser {
  expiresAt: number
}

interface OpenIdConfiguration {
  issuer: string
  jwks_uri: string
  token_endpoint: string
  authorization_endpoint: string
}

interface IdTokenClaims {
  aud?: string | string[]
  exp?: number
  iat?: number
  iss?: string
  nbf?: number
  nonce?: string
  oid?: string
  sub?: string
  tid?: string
  name?: string
  email?: string
  preferred_username?: string
  roles?: string[]
}

const STATE_COOKIE = '__Secure-corpuskit_oidc'
const SESSION_COOKIE = '__Secure-corpuskit_session'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function authConfigured(config: Partial<AuthConfig>): config is AuthConfig {
  return Boolean(
    config.clientId && config.clientSecret && config.tenantId && config.sessionSecret &&
      textEncoder.encode(config.sessionSecret).byteLength >= 32,
  )
}

export async function authUser(request: Request, config: AuthConfig): Promise<AuthUser | null> {
  const token = cookie(request, SESSION_COOKIE)
  if (!token) return null
  const session = await unseal<SessionPayload>(token, config.sessionSecret, SESSION_COOKIE)
  if (!session || session.expiresAt <= Date.now()) return null
  const { expiresAt: _expiresAt, ...user } = session
  return user
}

export async function handleAuthRequest(
  request: Request,
  config: AuthConfig,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname === '/auth/login' && request.method === 'GET') {
    return beginLogin(url, config)
  }
  if (url.pathname === '/auth/callback' && request.method === 'GET') {
    return finishLogin(request, url, config)
  }
  if (url.pathname === '/auth/me' && request.method === 'GET') {
    const user = await authUser(request, config)
    return json({ authenticated: Boolean(user), user }, 200)
  }
  if (url.pathname === '/auth/logout' && (request.method === 'GET' || request.method === 'POST')) {
    return new Response(null, {
      status: 302,
      headers: {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': clearCookie(SESSION_COOKIE, config.cookieDomain),
      },
    })
  }
  if (url.pathname.startsWith('/auth/')) return json({ error: 'not_found' }, 404)
  return null
}

async function beginLogin(url: URL, config: AuthConfig): Promise<Response> {
  const metadata = await openIdConfiguration(config.tenantId)
  const verifier = randomToken(48)
  const nonce = randomToken(32)
  const state = randomToken(32)
  const redirectUri = config.redirectUri || `${url.origin}/auth/callback`
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'), url, config.cookieDomain)
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        textEncoder.encode(verifier),
      ),
    ),
  )
  const sealed = await seal<OidcState>(
    {
      state,
      nonce,
      verifier,
      returnTo,
      expiresAt: Date.now() + 10 * 60_000,
    },
    config.sessionSecret,
    STATE_COOKIE,
  )

  const authorize = new URL(metadata.authorization_endpoint)
  authorize.searchParams.set('client_id', config.clientId)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('response_mode', 'query')
  authorize.searchParams.set('scope', 'openid profile email')
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('nonce', nonce)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'cache-control': 'no-store',
      'set-cookie': setCookie(STATE_COOKIE, sealed, 10 * 60, config.cookieDomain),
    },
  })
}

async function finishLogin(request: Request, url: URL, config: AuthConfig): Promise<Response> {
  if (url.searchParams.get('error')) {
    return authError('Microsoft sign-in was cancelled or could not be completed.')
  }
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const stateToken = cookie(request, STATE_COOKIE)
  if (!code || !returnedState || !stateToken) {
    return authError('The sign-in response was incomplete.')
  }

  const state = await unseal<OidcState>(stateToken, config.sessionSecret, STATE_COOKIE)
  if (!state || state.expiresAt <= Date.now() || !(await valuesEqual(state.state, returnedState))) {
    return authError('The sign-in request expired or could not be verified.')
  }

  const metadata = await openIdConfiguration(config.tenantId)
  const redirectUri = config.redirectUri || `${url.origin}/auth/callback`
  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: state.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      scope: 'openid profile email',
    }),
  })
  if (!tokenResponse.ok) {
    console.error(
      JSON.stringify({ message: 'Entra token exchange failed', status: tokenResponse.status }),
    )
    return authError('Microsoft sign-in could not be completed.')
  }
  const tokenBody = await tokenResponse.json() as { id_token?: unknown }
  if (typeof tokenBody.id_token !== 'string') {
    return authError('Microsoft did not return an identity token.')
  }

  let claims: IdTokenClaims
  try {
    claims = await verifyIdToken(tokenBody.id_token, metadata, config, state.nonce)
  } catch (error) {
    console.error(
      JSON.stringify({ message: 'Entra identity token rejected', error: String(error) }),
    )
    return authError('The Microsoft identity response could not be verified.')
  }

  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase()
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role) => typeof role === 'string')
    : []
  const adminEmails = new Set(
    String(config.adminEmails || '').split(',').map((item) => item.trim().toLowerCase()).filter(
      Boolean,
    ),
  )
  const user: AuthUser = {
    id: String(claims.oid || claims.sub),
    tenantId: String(claims.tid),
    name: String(claims.name || email || 'Microsoft user'),
    email,
    roles,
    isAdmin: roles.includes('CorpusKit.Admin') || adminEmails.has(email),
  }
  const session = await seal<SessionPayload>(
    { ...user, expiresAt: Date.now() + 8 * 60 * 60_000 },
    config.sessionSecret,
    SESSION_COOKIE,
  )
  const headers = new Headers({
    location: state.returnTo,
    'cache-control': 'no-store',
  })
  headers.append(
    'set-cookie',
    setCookie(SESSION_COOKIE, session, 8 * 60 * 60, config.cookieDomain),
  )
  headers.append('set-cookie', clearCookie(STATE_COOKIE, config.cookieDomain))
  return new Response(null, { status: 302, headers })
}

async function verifyIdToken(
  token: string,
  metadata: OpenIdConfiguration,
  config: AuthConfig,
  expectedNonce: string,
): Promise<IdTokenClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const header = JSON.parse(textDecoder.decode(fromBase64Url(parts[0]!))) as {
    alg?: unknown
    kid?: unknown
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported JWT')
  const jwksResponse = await fetch(metadata.jwks_uri)
  if (!jwksResponse.ok) throw new Error(`JWKS HTTP ${jwksResponse.status}`)
  const jwks = await jwksResponse.json() as { keys?: (JsonWebKey & { kid?: string })[] }
  const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid)
  if (!jwk) throw new Error('Unknown signing key')
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signed = textEncoder.encode(`${parts[0]}.${parts[1]}`)
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromBase64Url(parts[2]!),
    signed,
  )
  if (!verified) throw new Error('Invalid JWT signature')

  const claims = JSON.parse(textDecoder.decode(fromBase64Url(parts[1]!))) as IdTokenClaims
  const now = Math.floor(Date.now() / 1000)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(config.clientId)) throw new Error('Invalid audience')
  if (claims.iss !== metadata.issuer) throw new Error('Invalid issuer')
  if (claims.tid !== config.tenantId) throw new Error('Invalid tenant')
  if (!claims.exp || claims.exp <= now - 60) throw new Error('Expired token')
  if (claims.nbf && claims.nbf > now + 60) throw new Error('Token not active')
  if (!claims.oid && !claims.sub) throw new Error('Missing subject')
  if (!claims.nonce || !(await valuesEqual(claims.nonce, expectedNonce))) {
    throw new Error('Invalid nonce')
  }
  return claims
}

async function openIdConfiguration(tenantId: string): Promise<OpenIdConfiguration> {
  const response = await fetch(
    `https://login.microsoftonline.com/${
      encodeURIComponent(tenantId)
    }/v2.0/.well-known/openid-configuration`,
  )
  if (!response.ok) throw new Error(`OpenID configuration HTTP ${response.status}`)
  const body = await response.json() as Partial<OpenIdConfiguration>
  if (!body.issuer || !body.jwks_uri || !body.token_endpoint || !body.authorization_endpoint) {
    throw new Error('Incomplete OpenID configuration')
  }
  return body as OpenIdConfiguration
}

function safeReturnTo(value: string | null, requestUrl: URL, cookieDomain?: string): string {
  const fallback = new URL('/', requestUrl.origin).toString()
  if (!value || value.length > 2048) return fallback

  let target: URL
  try {
    target = new URL(value, requestUrl.origin)
  } catch {
    return fallback
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') return fallback
  if (target.origin === requestUrl.origin) return target.toString()
  if (!cookieDomain || target.protocol !== 'https:') return fallback
  if (target.username || target.password || (target.port && target.port !== '443')) return fallback
  const hostname = target.hostname.toLowerCase()
  const domain = cookieDomain.toLowerCase()
  if (hostname !== domain && !hostname.endsWith(`.${domain}`)) return fallback
  return target.toString()
}

function setCookie(name: string, value: string, maxAge: number, domain?: string): string {
  const cookieDomain = domain ? `; Domain=${domain}` : ''
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieDomain}`
}

function clearCookie(name: string, domain?: string): string {
  const cookieDomain = domain ? `; Domain=${domain}` : ''
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0${cookieDomain}`
}

function cookie(request: Request, name: string): string | null {
  for (const part of String(request.headers.get('cookie') || '').split(/;\s*/)) {
    const index = part.indexOf('=')
    if (index < 0 || part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1))
    } catch {
      return null
    }
  }
  return null
}

async function seal<T>(value: T, secret: string, purpose: string): Promise<string> {
  const key = await encryptionKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(purpose) },
    key,
    textEncoder.encode(JSON.stringify(value)),
  )
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`
}

async function unseal<T>(token: string, secret: string, purpose: string): Promise<T | null> {
  const [version, ivPart, encryptedPart] = token.split('.')
  if (version !== 'v1' || !ivPart || !encryptedPart) return null
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(ivPart),
        additionalData: textEncoder.encode(purpose),
      },
      await encryptionKey(secret),
      fromBase64Url(encryptedPart),
    )
    return JSON.parse(textDecoder.decode(decrypted)) as T
  } catch {
    return null
  }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function valuesEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', textEncoder.encode(left)),
    crypto.subtle.digest('SHA-256', textEncoder.encode(right)),
  ])
  const aa = new Uint8Array(a)
  const bb = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < aa.length; index += 1) difference |= aa[index]! ^ bb[index]!
  return difference === 0
}

function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function authError(message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in problem</title>` +
      `<body><main><h1>Sign-in problem</h1><p>${
        escapeHtml(message)
      }</p><p><a href="/">Return to CorpusKit</a></p></main></body></html>`,
    {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]!)
}
