const REQUIRED = ['ARAG_ZONE', 'ENTRA_CLIENT_SECRET', 'SESSION_SECRET']

export function workerSecrets(source: string): Record<string, string> {
  const parsed = parseDotEnv(source)
  return Object.fromEntries(
    Object.entries(parsed).filter(([name, value]) => value && isWorkerSecret(name)),
  )
}

function isWorkerSecret(name: string): boolean {
  return name === 'ARAG_ZONE' || name === 'ADMIN_PASSCODE' ||
    name === 'ENTRA_CLIENT_SECRET' || name === 'ENTRA_ADMIN_EMAILS' ||
    name === 'SESSION_SECRET' || name === 'RATE_LIMIT_ASK_PER_MIN' ||
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
  const missing = REQUIRED.filter((name) => !secrets[name])
  const hasKnowledgeBox = Object.keys(secrets).some((name) =>
    /^ARAG_KB_[A-Z0-9]+$/.test(name) && secrets[`${name}_TOKEN`]
  )
  if (missing.length || !hasKnowledgeBox) {
    const details = [...missing, ...(!hasKnowledgeBox ? ['ARAG_KB_<SLUG> + token'] : [])]
    throw new Error(`Refusing incomplete production secret upload: ${details.join(', ')}`)
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
