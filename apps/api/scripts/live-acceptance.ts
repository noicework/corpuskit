type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type Sleep = (milliseconds: number) => Promise<void>

export interface AcceptanceCheckResult {
  name: string
  ok: boolean
  attempts: number
  error?: string
}

export interface AcceptanceSweepOptions {
  baseUrl: string
  tenantSlugs: string[]
  fetcher?: Fetcher
  attempts?: number
  retryDelayMs?: number
  timeoutMs?: number
  sleep?: Sleep
}

interface AcceptanceCheck {
  name: string
  run: () => Promise<void>
}

const DEFAULT_BASE_URL = 'https://your-portal.example.com'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isConfig = (value: unknown): boolean =>
  isRecord(value) && isRecord(value.branding) && isNonEmptyString(value.branding.productName)

const isCounters = (value: unknown): boolean =>
  isRecord(value) &&
  isNonNegativeInteger(value.resources) &&
  value.resources > 0 &&
  isNonNegativeInteger(value.paragraphs) &&
  isNonNegativeInteger(value.sentences) &&
  isNonNegativeNumber(value.indexMb)

const isCatalog = (value: unknown): boolean =>
  isRecord(value) && Array.isArray(value.items) && isNonNegativeInteger(value.total)

const isFacets = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  const labelsets = Object.values(value)
  return labelsets.length > 0 && labelsets.every((labelset) => {
    if (!isRecord(labelset)) return false
    const counts = Object.values(labelset)
    return counts.length > 0 && counts.every(isNonNegativeInteger)
  })
}

const isLabelsets = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((labelset) =>
    isRecord(labelset) &&
    isNonEmptyString(labelset.id) &&
    isNonEmptyString(labelset.title) &&
    typeof labelset.multiple === 'boolean' &&
    Array.isArray(labelset.labels)
  )

const hasGraphShape = (value: unknown): value is Record<string, unknown> & {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
} =>
  isRecord(value) &&
  Array.isArray(value.nodes) &&
  value.nodes.length > 0 &&
  value.nodes.every((node) =>
    isRecord(node) && isNonEmptyString(node.id) && isNonEmptyString(node.group)
  ) &&
  Array.isArray(value.edges) &&
  value.edges.length > 0 &&
  value.edges.every((edge) =>
    isRecord(edge) &&
    isNonEmptyString(edge.source) &&
    isNonEmptyString(edge.target) &&
    isNonEmptyString(edge.label)
  )

const isGraph = (value: unknown): boolean => hasGraphShape(value)

const isGraphWithBuiltinNer = (value: unknown): boolean =>
  hasGraphShape(value) &&
  value.nodes.some((node) => typeof node.group === 'string' && /^[A-Z][A-Z0-9_]*$/.test(node.group))

const isSearchResults = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value.query) &&
  Array.isArray(value.resources) &&
  value.resources.length > 0 &&
  Array.isArray(value.relatedQuestions)

const isSuggestions = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((suggestion) => isRecord(suggestion) && isNonEmptyString(suggestion.text))

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const delay: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function parseTenantSlugs(value: string): string[] {
  const slugs = [...new Set(value.split(/[\s,]+/).map((slug) => slug.trim()).filter(Boolean))]
  if (slugs.length === 0) throw new Error('ACCEPTANCE_TENANTS must name at least one tenant')

  for (const slug of slugs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new Error(`Invalid tenant slug: ${slug}`)
    }
  }
  return slugs
}

function normaliseBaseUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('ACCEPTANCE_BASE_URL must use HTTP or HTTPS')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/$/, '')
}

function createChecks(options: Required<AcceptanceSweepOptions>): AcceptanceCheck[] {
  const request = async (path: string, expected: (value: unknown) => boolean): Promise<void> => {
    const response = await options.fetcher(new URL(path, `${options.baseUrl}/`), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('Response was not valid JSON')
    }
    if (!expected(body)) throw new Error('Response did not match the live API contract')
  }

  const checks: AcceptanceCheck[] = [
    {
      name: 'public app shell',
      run: async () => {
        const response = await options.fetcher(new URL('/', `${options.baseUrl}/`), {
          headers: { accept: 'text/html' },
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs),
        })
        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
        }
        const html = await response.text()
        if (!/\/app\.js\?v=[^"'\s<]+/.test(html)) {
          throw new Error('HTML did not contain the versioned app.js asset')
        }
      },
    },
  ]

  for (const slug of options.tenantSlugs) {
    const tenantPath = `/api/t/${encodeURIComponent(slug)}`
    checks.push(
      {
        name: `${slug}: config branding`,
        run: () => request(`${tenantPath}/config`, isConfig),
      },
      {
        name: `${slug}: corpus counters`,
        run: () => request(`${tenantPath}/counters`, isCounters),
      },
      {
        name: `${slug}: catalogue shape`,
        run: () => request(`${tenantPath}/catalog?pageSize=1`, isCatalog),
      },
      {
        name: `${slug}: facet shape`,
        run: () => request(`${tenantPath}/facets`, isFacets),
      },
      {
        name: `${slug}: labelset shape`,
        run: () => request(`${tenantPath}/labelsets`, isLabelsets),
      },
      {
        name: `${slug}: extracted relations graph`,
        run: () => request(`${tenantPath}/graph/relations`, isGraph),
      },
      {
        name: `${slug}: built-in NER graph`,
        run: () =>
          request(`${tenantPath}/graph/relations?includeBuiltin=true`, isGraphWithBuiltinNer),
      },
      {
        name: `${slug}: research search`,
        run: () => request(`${tenantPath}/search?q=research`, isSearchResults),
      },
      {
        name: `${slug}: suggestions`,
        run: () => request(`${tenantPath}/suggest`, isSuggestions),
      },
      {
        name: `${slug}: documentation search`,
        run: () => request(`${tenantPath}/docs/search?q=search`, isSearchResults),
      },
    )
  }
  return checks
}

async function runCheck(
  check: AcceptanceCheck,
  options: Required<AcceptanceSweepOptions>,
): Promise<AcceptanceCheckResult> {
  let lastError = 'Unknown acceptance failure'
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await check.run()
      return { name: check.name, ok: true, attempts: attempt }
    } catch (error) {
      lastError = errorMessage(error)
      if (attempt < options.attempts) {
        await options.sleep(options.retryDelayMs * attempt)
      }
    }
  }
  return { name: check.name, ok: false, attempts: options.attempts, error: lastError }
}

export async function runAcceptanceSweep(
  input: AcceptanceSweepOptions,
): Promise<AcceptanceCheckResult[]> {
  if (input.tenantSlugs.length === 0) throw new Error('At least one tenant is required')
  const attempts = input.attempts ?? 3
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Acceptance attempts must be a positive integer')
  }

  const options: Required<AcceptanceSweepOptions> = {
    baseUrl: normaliseBaseUrl(input.baseUrl),
    tenantSlugs: input.tenantSlugs,
    fetcher: input.fetcher ?? fetch,
    attempts,
    retryDelayMs: input.retryDelayMs ?? 5_000,
    timeoutMs: input.timeoutMs ?? 30_000,
    sleep: input.sleep ?? delay,
  }
  return await Promise.all(createChecks(options).map((check) => runCheck(check, options)))
}

function annotationValue(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

async function main(): Promise<void> {
  const tenantValue = Deno.env.get('ACCEPTANCE_TENANTS')
  if (!tenantValue) throw new Error('ACCEPTANCE_TENANTS is required')

  const baseUrl = Deno.env.get('ACCEPTANCE_BASE_URL') ?? DEFAULT_BASE_URL
  const tenantSlugs = parseTenantSlugs(tenantValue)
  console.log(`Checking ${baseUrl} for tenants: ${tenantSlugs.join(', ')}`)

  const results = await runAcceptanceSweep({ baseUrl, tenantSlugs })
  for (const result of results) {
    if (result.ok) {
      const retryNote = result.attempts > 1 ? ` after ${result.attempts} attempts` : ''
      console.log(`PASS ${result.name}${retryNote}`)
      continue
    }
    const detail = `${result.name}: ${result.error} (${result.attempts} attempts)`
    console.error(`::error title=Live acceptance failed::${annotationValue(detail)}`)
    console.error(`FAIL ${detail}`)
  }

  const failures = results.filter((result) => !result.ok)
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${results.length} live acceptance checks failed`)
  }
  console.log(`Live acceptance sweep passed (${results.length} checks).`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(errorMessage(error))
    Deno.exit(1)
  }
}
