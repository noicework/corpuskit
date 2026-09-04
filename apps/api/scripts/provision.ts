/**
 * Provision the portal's knowledge boxes on Progress Agentic RAG.
 *
 * For each tenant: resolve (or create) its knowledge box, mint a
 * service-account token if the .env has none, push the topic labelset,
 * upload every seed document from content/seed/<tenant>/, poll until
 * processed, and append the resulting bindings to the repo-root .env.
 *
 * Idempotent - safe to re-run; existing KBs, tokens and resources are
 * left alone. Usage: deno task provision [-- grains marine]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { regionalBase } from '@research-portal/retrieval'
import { loadRootEnv } from '../src/load-env.ts'
import { tenantSummaries } from '../src/tenants.ts'
import { tenantConfig } from '../src/tenants.ts'

loadRootEnv()

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ENV_PATH = resolve(ROOT, '.env')

const zone = requireEnv('ARAG_ZONE')
const account = requireEnv('ARAG_ACCOUNT')
const nuaKey = requireEnv('ARAG_NUA_KEY')
const base = regionalBase(zone)

interface ManifestEntry {
  tenant: string
  file: string
  title: string
  topic: string
  published: string
  type: string
  summary: string
  keyFacts: string[]
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing ${name} - add it to ${ENV_PATH}`)
    process.exit(1)
  }
  return value
}

async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; kbToken?: string } = {},
): Promise<{ status: number; json: T | null; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.kbToken) headers['x-nuclia-serviceaccount'] = `Bearer ${init.kbToken}`
  else headers['x-nuclia-nuakey'] = `Bearer ${nuaKey}`
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let json: T | null = null
  try {
    json = JSON.parse(text) as T
  } catch {
    // non-JSON response body
  }
  return { status: res.status, json, text }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function resolveKb(slug: string): Promise<string> {
  const kbSlug = `research-portal-${slug}`
  const list = await api<unknown>(`/account/${account}/kbs`)
  const rows: { id?: string; slug?: string }[] = Array.isArray(list.json)
    ? (list.json as { id?: string; slug?: string }[])
    : ((list.json as { kbs?: { id?: string; slug?: string }[] } | null)?.kbs ?? [])
  const existing = rows.find((k) => k.slug === kbSlug)
  if (existing?.id) {
    console.log(`  knowledge box exists: ${existing.id}`)
    return existing.id
  }
  const created = await api<{ id?: string }>(`/account/${account}/kbs`, {
    body: { slug: kbSlug, title: `Research Portal - ${slug.toUpperCase()}`, zone },
  })
  if (!created.json?.id) {
    throw new Error(
      `Could not create knowledge box (${created.status}): ${created.text.slice(0, 300)}`,
    )
  }
  console.log(`  knowledge box created: ${created.json.id}`)
  return created.json.id
}

async function mintToken(kb: string): Promise<string> {
  const saPath = `/account/${account}/kb/${kb}/service_accounts`
  const listed = await api<{ id?: string; title?: string }[]>(saPath)
  let saId = (Array.isArray(listed.json) ? listed.json : []).find(
    (s) => s.title === 'research-portal-api',
  )?.id
  if (!saId) {
    const created = await api<{ id?: string }>(saPath, {
      body: { title: 'research-portal-api', role: 'SOWNER' },
    })
    saId = created.json?.id
    if (!saId) {
      throw new Error(
        `Could not create service account (${created.status}): ${created.text.slice(0, 300)}`,
      )
    }
  }
  const expires = Math.floor(Date.now() / 1000) + 364 * 24 * 60 * 60
  const key = await api<{ token?: string }>(
    `/account/${account}/kb/${kb}/service_account/${saId}/keys`,
    { body: { expires } },
  )
  if (!key.json?.token) {
    throw new Error(`Could not mint KB token (${key.status}): ${key.text.slice(0, 300)}`)
  }
  console.log('  service-account token minted')
  return key.json.token
}

async function pushLabelset(kb: string, token: string, slug: string): Promise<void> {
  const config = tenantConfig(slug)
  if (!config) return
  const body = {
    title: 'Topic',
    color: '#556b5f',
    multiple: false,
    kind: ['RESOURCES'],
    labels: config.topics.map((t) => ({ title: t.id })),
  }
  for (const method of ['POST', 'PUT'] as const) {
    const res = await api(`/kb/${kb}/labelset/topic`, { method, body, kbToken: token })
    if (res.status < 300) {
      console.log('  topic labelset configured')
      return
    }
  }
  console.warn('  warning: could not configure topic labelset (continuing)')
}

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n/)
  return match ? markdown.slice(match[0].length) : markdown
}

async function uploadSeeds(kb: string, token: string, slug: string): Promise<string[]> {
  const manifestPath = resolve(ROOT, 'content/seed/manifest.json')
  if (!existsSync(manifestPath)) {
    console.warn('  no content/seed/manifest.json yet - skipping seeding')
    return []
  }
  const manifest = (JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[]).filter(
    (entry) => entry.tenant === slug,
  )
  const uploaded: string[] = []
  for (const entry of manifest) {
    // entry.file is the repo-relative path, e.g. "content/seed/grains/foo.md".
    const fileName = entry.file.split('/').at(-1) ?? entry.file
    const resourceSlug = fileName.replace(/\.md$/, '')
    const existing = await api(`/kb/${kb}/slug/${resourceSlug}`, { kbToken: token })
    if (existing.status === 200) {
      console.log(`  = ${fileName} (already uploaded)`)
      continue
    }
    const markdown = readFileSync(resolve(ROOT, entry.file), 'utf8')
    const created = await api<{ uuid?: string; id?: string }>(`/kb/${kb}/resources`, {
      kbToken: token,
      body: {
        slug: resourceSlug,
        title: entry.title,
        texts: { body: { body: stripFrontmatter(markdown), format: 'MARKDOWN' } },
        usermetadata: { classifications: [{ labelset: 'topic', label: entry.topic }] },
        extra: {
          metadata: {
            summary: entry.summary,
            keyFacts: entry.keyFacts,
            topic: entry.topic,
            type: 'document',
            published: entry.published,
          },
        },
      },
    })
    const rid = created.json?.uuid ?? created.json?.id
    if (!rid) {
      console.error(`  ! ${entry.file} failed (${created.status}): ${created.text.slice(0, 200)}`)
      continue
    }
    console.log(`  + ${entry.file} uploaded (${rid})`)
    uploaded.push(rid)
  }
  return uploaded
}

async function waitProcessed(kb: string, token: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000
  const pending = new Set(ids)
  while (pending.size > 0 && Date.now() < deadline) {
    for (const id of [...pending]) {
      const res = await api<{ metadata?: { status?: string } }>(
        `/kb/${kb}/resource/${id}?show=basic`,
        { kbToken: token },
      )
      const status = res.json?.metadata?.status
      if (status === 'PROCESSED') pending.delete(id)
      if (status === 'ERROR') {
        console.error(`  ! resource ${id} failed processing`)
        pending.delete(id)
      }
    }
    if (pending.size > 0) {
      console.log(`  waiting for processing (${pending.size} remaining)...`)
      await sleep(5000)
    }
  }
  if (pending.size > 0) console.warn(`  ${pending.size} resources still processing - check later`)
  else console.log('  all resources processed')
}

async function main() {
  const requested = process.argv.slice(2)
  const slugs = requested.length > 0 ? requested : tenantSummaries().map((tenant) => tenant.slug)
  const newEnvLines: string[] = []
  for (const slug of slugs) {
    console.log(`\nProvisioning tenant: ${slug}`)
    const upper = slug.toUpperCase()
    const kb = process.env[`ARAG_KB_${upper}`] ?? (await resolveKb(slug))
    let token = process.env[`ARAG_KB_${upper}_TOKEN`]
    if (!token) {
      token = await mintToken(kb)
      newEnvLines.push(`ARAG_KB_${upper}=${kb}`, `ARAG_KB_${upper}_TOKEN=${token}`)
    }
    await pushLabelset(kb, token, slug)
    const uploaded = await uploadSeeds(kb, token, slug)
    if (uploaded.length > 0) await waitProcessed(kb, token, uploaded)
  }
  if (newEnvLines.length > 0) {
    appendFileSync(ENV_PATH, `\n${newEnvLines.join('\n')}\n`)
    console.log(`\nAppended ${newEnvLines.length} binding lines to .env`)
  }
  console.log('\nProvisioning complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
