const REQUIRED = ['ARAG_ZONE', 'SESSION_SECRET']

export function workerSecrets(source: string): Record<string, string> {
  const parsed = parseDotEnv(source)
  return Object.fromEntries(
    Object.entries(parsed).filter(([name, value]) => value && isWorkerSecret(name)),
  )
}

export function missingWorkerSecrets(secrets: Record<string, string>): string[] {
  const missing = REQUIRED.filter((name) => !secrets[name])
  if (
    !secrets.ENTRA_CLIENT_SECRET &&
    !(secrets.EXTERNAL_LOGIN_ISSUER && secrets.EXTERNAL_LOGIN_JWK)
  ) {
    missing.push('ENTRA_CLIENT_SECRET or EXTERNAL_LOGIN_ISSUER + EXTERNAL_LOGIN_JWK')
  }
  const hasKnowledgeBox = Object.keys(secrets).some((name) =>
    /^ARAG_KB_[A-Z0-9]+$/.test(name) && secrets[`${name}_TOKEN`]
  )
  if (!hasKnowledgeBox) missing.push('ARAG_KB_<SLUG> + token')
  return missing
}

/** Names only, never values: settings that must not leave this machine in their current form. */
export function unsafeWorkerSecrets(secrets: Record<string, string>): string[] {
  const unsafe: string[] = []
  if (secrets.EXTERNAL_LOGIN_JWK !== undefined && !publicEd25519Jwk(secrets.EXTERNAL_LOGIN_JWK)) {
    unsafe.push('EXTERNAL_LOGIN_JWK must be an Ed25519 public JWK without private key material')
  }
  return unsafe
}

function publicEd25519Jwk(value: string): boolean {
  let jwk: unknown
  try {
    jwk = JSON.parse(value)
  } catch {
    return false
  }
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false
  const fields = jwk as Record<string, unknown>
  // An OKP private JWK carries `d`; the other members are private parts of other key types.
  const privateMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']
  return fields.kty === 'OKP' && fields.crv === 'Ed25519' && typeof fields.x === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(fields.x) && privateMembers.every((member) => !(member in fields))
}

function isWorkerSecret(name: string): boolean {
  return name === 'ARAG_ZONE' || name === 'ADMIN_PASSCODE' ||
    name === 'ENTRA_CLIENT_SECRET' || name === 'ENTRA_ADMIN_EMAILS' ||
    name === 'SESSION_SECRET' || name === 'BINDING_KEY' || name === 'OPERATOR_API_KEY' ||
    name === 'EXTERNAL_LOGIN_ISSUER' || name === 'EXTERNAL_LOGIN_JWK' ||
    name === 'EXTERNAL_LOGIN_NAME' || name === 'EXTERNAL_LOGIN_START_URL' ||
    name === 'RATE_LIMIT_ASK_PER_MIN' ||
    name === 'RATE_LIMIT_ESTATE_PER_MIN' || name === 'CLOUDFLARE_ACCOUNT_ID' ||
    name === 'CLOUDFLARE_DOMAINS_TOKEN' || /^ARAG_KB_[A-Z0-9_]+$/.test(name)
}

function parseDotEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const name = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }
  return values
}

if (import.meta.main) {
  const source = await Deno.readTextFile('.env')
  const secrets = workerSecrets(source)
  const missing = missingWorkerSecrets(secrets)
  if (missing.length) {
    throw new Error(`Refusing incomplete production secret upload: ${missing.join(', ')}`)
  }
  const unsafe = unsafeWorkerSecrets(secrets)
  if (unsafe.length) {
    throw new Error(`Refusing unsafe production secret upload: ${unsafe.join(', ')}`)
  }

  await Deno.mkdir('.wrangler', { recursive: true })
  const tempPath = await Deno.makeTempFile({ dir: '.wrangler', prefix: 'corpuskit-secrets-' })
  try {
    await Deno.writeTextFile(tempPath, JSON.stringify(secrets), { mode: 0o600 })
    const command = new Deno.Command('npx', {
      args: [
        '-y',
        'wrangler@4.127.1',
        'secret',
        'bulk',
        tempPath,
        '--config',
        'wrangler.jsonc',
      ],
      stdin: 'null',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const result = await command.spawn().status
    if (!result.success) throw new Error(`Wrangler exited with status ${result.code}`)
  } finally {
    await Deno.remove(tempPath).catch(() => {})
  }
}
