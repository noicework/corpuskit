import process from 'node:process'
import { regionalBase } from '@research-portal/retrieval'
import type { KbBinding } from '@research-portal/retrieval'

/**
 * Account-level operations (create knowledge boxes, mint service-account
 * tokens) using the account NUA key. Available only when ARAG_NUA_KEY and
 * ARAG_ACCOUNT are configured server-side; never exposed to the client.
 */
export function accountOpsAvailable(): boolean {
  return Boolean(process.env.ARAG_NUA_KEY && process.env.ARAG_ACCOUNT)
}

async function accountApi<T = unknown>(
  zone: string,
  path: string,
  body?: unknown,
  method?: string,
): Promise<{ status: number; json: T | null; text: string }> {
  const res = await fetch(`${regionalBase(zone)}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      'x-nuclia-nuakey': `Bearer ${process.env.ARAG_NUA_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: T | null = null
  try {
    json = JSON.parse(text) as T
  } catch {
    // non-JSON body
  }
  return { status: res.status, json, text }
}

/**
 * Create a knowledge box and mint a service-account token for it.
 * Idempotent on the KB: an existing KB with the same slug is reused.
 */
export async function createKnowledgeBox(
  zone: string,
  kbSlug: string,
  title: string,
): Promise<KbBinding> {
  const account = process.env.ARAG_ACCOUNT
  if (!accountOpsAvailable() || !account) {
    throw new Error('Account credentials are not configured on this server')
  }

  const list = await accountApi<unknown>(zone, `/account/${account}/kbs`)
  const rows: { id?: string; slug?: string }[] = Array.isArray(list.json)
    ? (list.json as { id?: string; slug?: string }[])
    : ((list.json as { kbs?: { id?: string; slug?: string }[] } | null)?.kbs ?? [])
  let kbId = rows.find((k) => k.slug === kbSlug)?.id

  if (!kbId) {
    const created = await accountApi<{ id?: string }>(zone, `/account/${account}/kbs`, {
      slug: kbSlug,
      title,
      zone,
    })
    kbId = created.json?.id
    if (!kbId) {
      throw new Error(
        `Could not create knowledge box (${created.status}): ${created.text.slice(0, 200)}`,
      )
    }
  }

  const saPath = `/account/${account}/kb/${kbId}/service_accounts`
  const listed = await accountApi<{ id?: string; title?: string }[]>(zone, saPath)
  let saId = (Array.isArray(listed.json) ? listed.json : []).find(
    (s) => s.title === 'research-portal-api',
  )?.id
  if (!saId) {
    const createdSa = await accountApi<{ id?: string }>(zone, saPath, {
      title: 'research-portal-api',
      role: 'SOWNER',
    })
    saId = createdSa.json?.id
    if (!saId) {
      throw new Error(
        `Could not create service account (${createdSa.status}): ${createdSa.text.slice(0, 200)}`,
      )
    }
  }

  const expires = Math.floor(Date.now() / 1000) + 364 * 24 * 60 * 60
  const key = await accountApi<{ token?: string }>(
    zone,
    `/account/${account}/kb/${kbId}/service_account/${saId}/keys`,
    { expires },
  )
  if (!key.json?.token) {
    throw new Error(`Could not mint KB token (${key.status}): ${key.text.slice(0, 200)}`)
  }

  return { baseUrl: `${regionalBase(zone)}/kb/${kbId}`, token: key.json.token, kbId }
}

/**
 * Switch on the box's hidden-resources feature (a KB-level setting, only
 * writable with the account key). Undocumented on the account PATCH but
 * verified live - the config change shows in GET /kb/{kbid} afterwards.
 */
export async function enableHiddenResources(zone: string, kbId: string): Promise<void> {
  const account = process.env.ARAG_ACCOUNT
  if (!accountOpsAvailable() || !account) {
    throw new Error('Hidden resources need the account key configured on this server')
  }
  const res = await accountApi(
    zone,
    `/account/${account}/kb/${kbId}`,
    { hidden_resources_enabled: true },
    'PATCH',
  )
  if (res.status >= 400) {
    throw new Error(`The platform refused to enable hidden resources (${res.status})`)
  }
}
