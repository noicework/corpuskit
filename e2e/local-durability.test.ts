import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { acquireWriterLock, installShutdown } from '../apps/api/src/local-runtime.ts'
import { runSystemMaintenance, syncSource } from '../apps/api/src/scheduler.ts'
import { SourceStore, WatchStore } from '../apps/api/src/stores.ts'
import { SuggestionStore } from '../apps/api/src/interrogate.ts'
import { EnrichmentStore } from '../apps/api/src/enrichments.ts'
import { readJsonSafe, writeAssetAtomic, writeJsonAtomic } from '../apps/api/src/persist.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import type { TenantStoreApi } from '../apps/api/src/tenants.ts'

const ROOT = new URL('../', import.meta.url).pathname
const SCRIPT = new URL(import.meta.url).pathname
const tenant: TenantConfig = {
  slug: 'portal',
  accessMode: 'public',
  branding: {
    productName: 'Test portal',
    organisation: 'Test organisation',
    tagline: 'Test collection',
    colours: { primary: '#000000', accent: '#111111', heroFrom: '#222222', heroTo: '#333333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}
const pages = Array.from({ length: 12 }, (_, index) => `https://example.org/page-${index}`)
const bytes = new Uint8Array(256 * 1024).fill(83)

function directory() {
  Deno.mkdirSync('/tmp/ck-l2a', { recursive: true })
  return Deno.makeTempDirSync({ dir: '/tmp/ck-l2a' })
}

function child(mode: string, dataDir: string) {
  return new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', SCRIPT, mode, dataDir],
    cwd: ROOT,
    env: { DATA_DIR: dataDir },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
}

async function untilLine(process: Deno.ChildProcess, token: string) {
  const reader = process.stdout.getReader()
  const decoder = new TextDecoder()
  let log = ''
  const timer = setTimeout(() => process.kill('SIGKILL'), 20_000)
  try {
    while (!log.includes(token)) {
      const part = await reader.read()
      if (part.done) throw new Error(`Process ended before ${token}: ${log}`)
      log += decoder.decode(part.value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

async function fixtureMain(mode: string, dir: string) {
  if (mode === 'timeout') {
    const releaseLock = await acquireWriterLock(dir, 0)
    const { database } = openLocalRbac({ DATA_DIR: dir })
    installShutdown({
      graceSeconds: 0.2,
      stopScheduler: () => new Promise(() => {}),
      abort: () => {},
      shutdownServer: async () => {},
      closeDatabase: () => database.close(),
      releaseLock,
    })
    console.log('timeout.ready')
    await new Promise(() => {})
  }
  const suggestions = new SuggestionStore(dir)
  if (mode === 'crash') {
    let generation = 0
    console.log('crash.ready')
    while (true) {
      suggestions.replacePending('portal', [{
        id: String(generation++),
        kind: 'entity-type',
        title: 'Test',
        detail: 'Test',
        status: 'pending',
        createdAt: new Date(0).toISOString(),
      }])
      writeAssetAtomic(`${dir}/logo`, generation % 2 ? 'png' : 'jpg', ['png', 'jpg'], bytes)
    }
  }
  const sources = new SourceStore(dir)
  const source = sources.add('portal', 'https://example.org', true)
  const controller = new AbortController()
  const ingested = readJsonSafe<string[]>(`${dir}/ingested.json`, [])
  const provider = {
    createText: async (_config: TenantConfig, input: { originUrl: string }) => {
      ingested.push(input.originUrl)
      writeJsonAtomic(`${dir}/ingested.json`, ingested)
      return { id: input.originUrl }
    },
  } as unknown as AragProvider
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://example.org/') {
      return new Response(pages.map((page) => `<a href="${page}">Page</a>`).join(''), {
        headers: { 'content-type': 'text/html' },
      })
    }
    if (mode === 'sync' && url === pages[7]) {
      console.log('sync.waiting')
      const signal = init?.signal
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return new Response(
      `<html><title>Page</title><main><p>${
        Array.from({ length: 100 }, (_, index) => `research-word-${index}`).join(' ')
      }</p></main></html>`,
      { headers: { 'content-type': 'text/html' } },
    )
  }
  if (mode === 'resume') {
    await syncSource(provider, sources, tenant, source, () => {})
    return
  }
  const releaseLock = await acquireWriterLock(dir, 0)
  const { database, rbac } = openLocalRbac({ DATA_DIR: dir })
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 8795, onListen: () => {} },
    () => new Response('ok'),
  )
  const running = runSystemMaintenance(
    provider,
    {
      rbac,
      sources,
      watches: new WatchStore(),
      enrichments: new EnrichmentStore(dir),
      tenants: { list: () => [{ slug: 'portal' }], get: () => tenant } as unknown as TenantStoreApi,
    },
    undefined,
    ['sync'],
    false,
    { signal: controller.signal },
  ).catch(() => {})
  installShutdown({
    graceSeconds: 2,
    stopScheduler: () => {
      controller.abort()
      return running
    },
    abort: () => controller.abort(),
    shutdownServer: () => server.shutdown(),
    closeDatabase: () => database.close(),
    releaseLock,
  })
  await running
}

if (import.meta.main) {
  await fixtureMain(Deno.args[0]!, Deno.args[1]!)
} else {
  Deno.test('a second real server fails its writer wait; SIGINT releases the persistent fence', async () => {
    const dir = directory()
    const env = {
      DATA_DIR: dir,
      BINDINGS_PATH: `${dir}/bindings.json`,
      TENANTS_PATH: `${dir}/tenants.json`,
      PORT: '8795',
      LOCAL_SCHEDULER_ENABLED: 'false',
      SHUTDOWN_GRACE_SECONDS: '2',
      WRITER_LOCK_WAIT_SECONDS: '0.2',
      SHOWCASE_PORTALS: '',
    }
    const command = () =>
      new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', 'apps/api/src/server.ts'],
        cwd: ROOT,
        env,
        stdout: 'piped',
        stderr: 'piped',
      })
    const first = command().spawn()
    let alive = true
    try {
      await untilLine(first, '"outcome":"acquired"')
      // Wait for the actual listening socket before sending a signal.
      for (let attempt = 0;; attempt++) {
        try {
          const response = await fetch('http://127.0.0.1:8795/auth/me')
          expect(response.status).toBe(200)
          await response.text()
          break
        } catch (error) {
          if (attempt > 100) throw error
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      const start = performance.now()
      const second = await command().output()
      expect(second.success).toBe(false)
      expect(performance.now() - start).toBeLessThan(3000)
      expect(new TextDecoder().decode(second.stderr)).toContain('writer lock is still held')
      first.kill('SIGINT')
      const result = await first.output()
      alive = false
      expect(result.success).toBe(true)
      const log = new TextDecoder().decode(result.stdout)
      for (
        const phase of [
          'scheduler_stopped',
          'units_aborted',
          'http_drained',
          'database_closed',
          'writer_released',
          'complete',
        ]
      ) {
        expect(log).toContain(`"phase":"${phase}"`)
      }
      const release = await acquireWriterLock(dir, 0)
      release()
    } finally {
      if (alive) {
        first.kill('SIGKILL')
        await first.output()
      }
      Deno.removeSync(dir, { recursive: true })
    }
  })

  Deno.test('SIGTERM during an audited sync saves the checkpoint and resumes without duplicate resources', async () => {
    const dir = directory()
    const process = child('sync', dir)
    let alive = true
    try {
      await untilLine(process, 'sync.waiting')
      const sources = new SourceStore(dir)
      // Before cancellation, the five-page checkpoint is already durable.
      expect(sources.list('portal')[0]?.synced?.length).toBe(5)
      const start = performance.now()
      process.kill('SIGTERM')
      const output = await process.output()
      alive = false
      expect(output.success, new TextDecoder().decode(output.stderr)).toBe(true)
      expect(performance.now() - start).toBeLessThan(2000)
      expect(sources.list('portal')[0]?.synced?.length).toBe(7)
      const resumed = await child('resume', dir).output()
      expect(resumed.success, new TextDecoder().decode(resumed.stderr)).toBe(true)
      const ingested = readJsonSafe<string[]>(`${dir}/ingested.json`, [])
      expect(ingested.length).toBe(12)
      expect(new Set(ingested).size).toBe(12)
      expect(sources.list('portal')[0]?.itemCount).toBe(12)
    } finally {
      if (alive) {
        process.kill('SIGKILL')
        await process.output()
      }
      Deno.removeSync(dir, { recursive: true })
    }
  })

  Deno.test('shutdown deadline terminates an uncooperative unit and releases its OS lock', async () => {
    const dir = directory()
    const process = child('timeout', dir)
    let alive = true
    try {
      await untilLine(process, 'timeout.ready')
      const start = performance.now()
      process.kill('SIGTERM')
      const output = await process.output()
      alive = false
      expect(output.success).toBe(false)
      expect(performance.now() - start).toBeLessThan(1000)
      expect(new TextDecoder().decode(output.stdout)).toContain(
        '"phase":"deadline","outcome":"timeout"',
      )
      const release = await acquireWriterLock(dir, 0)
      release()
    } finally {
      if (alive) {
        process.kill('SIGKILL')
        await process.output()
      }
      Deno.removeSync(dir, { recursive: true })
    }
  })

  Deno.test('repeated SIGKILL during suggestion and branding writes preserves complete committed files', async () => {
    const dir = directory()
    const store = new SuggestionStore(dir)
    store.replacePending('portal', [{
      id: 'initial',
      kind: 'entity-type',
      title: 'Test',
      detail: 'Test',
      status: 'pending',
      createdAt: new Date(0).toISOString(),
    }])
    writeAssetAtomic(`${dir}/logo`, 'png', ['png', 'jpg'], bytes)
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const process = child('crash', dir)
        await untilLine(process, 'crash.ready')
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 3))
        process.kill('SIGKILL')
        await process.output()
        expect(store.list('portal').length).toBe(1)
        const assets = [...Deno.readDirSync(dir)].filter((entry) =>
          /^logo\.(png|jpg)$/.test(entry.name)
        )
        expect(assets.length).toBeGreaterThan(0)
        for (const asset of assets) {
          const committed = Deno.readFileSync(`${dir}/${asset.name}`)
          expect(committed.length).toBe(bytes.length)
          expect(committed.every((byte) => byte === 83)).toBe(true)
        }
        const suggestions = [...Deno.readDirSync(`${dir}/suggestions`)]
        expect(suggestions.some((entry) => entry.name.includes('.corrupt-'))).toBe(false)
      }
    } finally {
      Deno.removeSync(dir, { recursive: true })
    }
  })
}
