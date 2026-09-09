/** Exact-version recovery for the deployment workflow. Never deletes or restores tenant data. */
const CONFIGS = {
  corpuskit: 'wrangler.jsonc',
  'corpuskit-demo': 'wrangler.demo.jsonc',
} as const
type Worker = keyof typeof CONFIGS
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export interface Snapshot {
  worker: Worker
  accountId: string
  deploymentId: string
  versionId: string
  createdOn: string
}

export type Run = (args: string[]) => Promise<string>

function workerName(value: string): Worker {
  if (value !== 'corpuskit' && value !== 'corpuskit-demo') {
    throw new Error('Unknown release Worker')
  }
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid deployment data')
  }
  return value as Record<string, unknown>
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('Invalid deployment/version ID')
  }
  return value
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid deployment timestamp')
  }
  return value
}

function account(value: string): string {
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new Error('Invalid Cloudflare account ID')
  return value
}

/** Wrangler 4.127.1 deployments list --json returns an oldest-first array, not versions. */
export function activeSnapshot(worker: string, accountId: string, payload: unknown): Snapshot {
  workerName(worker)
  account(accountId)
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('No previous deployment found; refusing an unprotected release')
  }
  const deployments = payload.map((value) => {
    const entry = record(value)
    return { id: entry.id, versions: entry.versions, created_on: timestamp(entry.created_on) }
  }).sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  const current = deployments[0]!
  if (deployments[1]?.created_on === current.created_on) {
    throw new Error('Ambiguous active deployment')
  }
  if (!Array.isArray(current.versions) || current.versions.length !== 1) {
    throw new Error('Expected one active version; split deployments require manual recovery')
  }
  const version = record(current.versions[0])
  if (version.percentage !== 100) throw new Error('Active version does not serve 100% of traffic')
  return {
    worker: workerName(worker),
    accountId,
    deploymentId: id(current.id),
    versionId: id(version.version_id),
    createdOn: current.created_on,
  }
}

export function validateSnapshot(worker: string, accountId: string, value: unknown): Snapshot {
  const data = record(value)
  if (data.worker !== workerName(worker) || data.accountId !== account(accountId)) {
    throw new Error('Snapshot belongs to a different Worker or account')
  }
  return {
    worker: workerName(worker),
    accountId,
    deploymentId: id(data.deploymentId),
    versionId: id(data.versionId),
    createdOn: timestamp(data.createdOn),
  }
}

export async function capture(worker: string, accountId: string, run: Run): Promise<Snapshot> {
  const name = workerName(worker)
  const json = await run([
    'deployments',
    'list',
    '--config',
    CONFIGS[name],
    '--name',
    name,
    '--json',
  ])
  return activeSnapshot(name, accountId, JSON.parse(json))
}

/** Pinned Wrangler deploy prints this only after publishing and attaching its targets. */
export function publishedVersion(output: string): string {
  const plain = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
  const matches = [...plain.matchAll(/^\s*Current Version ID:[ \t]*(.*?)[ \t]*$/gm)]
  if (matches.length !== 1) {
    throw new Error('Publish output must contain exactly one Current Version ID')
  }
  return id(matches[0]?.[1])
}

/** Do not accidentally claim a dashboard/other release between publish and snapshot as ours. */
export async function captureCandidate(
  worker: string,
  accountId: string,
  publishOutput: string,
  run: Run,
): Promise<Snapshot> {
  const expectedVersion = publishedVersion(publishOutput)
  const active = await capture(worker, accountId, run)
  if (active.versionId !== expectedVersion) {
    throw new Error('Active version differs from this publish; candidate ownership is unverified')
  }
  return active
}

/** Refuse to overwrite any deployment that appeared after this workflow's candidate snapshot. */
export async function rollback(
  before: Snapshot,
  candidate: Snapshot,
  run: Run,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5_000)),
): Promise<void> {
  validateSnapshot(before.worker, before.accountId, before)
  validateSnapshot(before.worker, before.accountId, candidate)
  if (Date.parse(candidate.createdOn) <= Date.parse(before.createdOn)) {
    throw new Error('Candidate is not newer than the saved deployment')
  }
  if (candidate.versionId === before.versionId) throw new Error('Candidate version did not change')
  const active = await capture(before.worker, before.accountId, run)
  if (active.deploymentId !== candidate.deploymentId || active.versionId !== candidate.versionId) {
    throw new Error('Active deployment changed; refusing to overwrite another release')
  }
  await run([
    'rollback',
    before.versionId,
    '--config',
    CONFIGS[before.worker],
    '--name',
    before.worker,
    '--yes',
    '--message',
    'Automatic recovery: post-deploy verification failed',
  ])
  for (let attempt = 0; attempt < 6; attempt++) {
    const restored = await capture(before.worker, before.accountId, run)
    if (restored.versionId === before.versionId) return
    if (restored.deploymentId !== candidate.deploymentId) {
      throw new Error('Unexpected deployment after rollback; manual verification required')
    }
    if (attempt < 5) await wait()
  }
  throw new Error('Rollback did not restore the exact previous version')
}

/** A healthy response from an older edge version must not pass candidate/recovery verification. */
export async function verifyLive(
  snapshot: Snapshot,
  request: typeof fetch = fetch,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5_000)),
): Promise<void> {
  validateSnapshot(snapshot.worker, snapshot.accountId, snapshot)
  const origin = snapshot.worker === 'corpuskit'
    ? 'https://corpuskit.org'
    : 'https://demo.corpuskit.org'
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await request(`${origin}/api/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) {
        const health = record(await response.json())
        if (health.ok === true && health.version === snapshot.versionId) return
      } else {
        await response.body?.cancel()
      }
    } catch {
      // Edge propagation and temporary network failures get a bounded retry.
    }
    if (attempt < 11) await wait()
  }
  throw new Error('Live health did not confirm the exact expected Worker version')
}

async function wrangler(args: string[]): Promise<string> {
  const result = await new Deno.Command('npx', {
    args: ['-y', 'wrangler@4.127.1', ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!result.success) throw new Error(`Wrangler ${args[0]} failed (exit ${result.code})`)
  return new TextDecoder().decode(result.stdout)
}

if (import.meta.main) {
  const [operation, worker, beforePath, candidatePath] = Deno.args
  if (Deno.env.get('GITHUB_ACTIONS') !== 'true') {
    throw new Error('Release recovery must run in the deployment workflow, not locally')
  }
  if (!worker || !beforePath) throw new Error('Expected operation, Worker and snapshot path')
  const accountId = account(Deno.env.get('CLOUDFLARE_ACCOUNT_ID') ?? '')
  if (operation === 'capture' || operation === 'capture-candidate') {
    const snapshot = operation === 'capture'
      ? await capture(worker, accountId, wrangler)
      : await captureCandidate(
        worker,
        accountId,
        Deno.env.get('WRANGLER_PUBLISH_OUTPUT') ?? '',
        wrangler,
      )
    await Deno.writeTextFile(beforePath, JSON.stringify(snapshot), { createNew: true })
    console.log(`Recorded ${snapshot.worker} version ${snapshot.versionId}`)
  } else if (operation === 'rollback' && candidatePath) {
    const before = validateSnapshot(
      worker,
      accountId,
      JSON.parse(await Deno.readTextFile(beforePath)),
    )
    const candidate = validateSnapshot(
      worker,
      accountId,
      JSON.parse(await Deno.readTextFile(candidatePath)),
    )
    await rollback(before, candidate, wrangler)
    console.log(`Restored ${before.worker} to version ${before.versionId}; tenant state unchanged`)
  } else if (operation === 'verify') {
    const snapshot = validateSnapshot(
      worker,
      accountId,
      JSON.parse(await Deno.readTextFile(beforePath)),
    )
    await verifyLive(snapshot)
    console.log(`Live health confirmed ${snapshot.worker} version ${snapshot.versionId}`)
  } else {
    throw new Error('Expected capture, capture-candidate, rollback or verify operation')
  }
}
