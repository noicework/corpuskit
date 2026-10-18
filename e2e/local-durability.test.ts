import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { acquireWriterLock, installShutdown } from '../apps/api/src/local-runtime.ts'
import { runSystemMaintenance, syncSource } from '../apps/api/src/scheduler.ts'
import { SourceStore, WatchStore } from '../apps/api/src/stores.ts'
import { SuggestionStore } from '../apps/api/src/interrogate.ts'
import { EnrichmentStore } from '../apps/api/src/enrichments.ts'
import { readJsonSafe, writeJsonAtomic } from '../apps/api/src/persist.ts'
import { FileBrandingStore } from '../apps/api/src/branding-store.ts'
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
  return Deno.makeTempDirSync()
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

async function untilLine(
  process: Deno.ChildProcess,
  token: string,
  stream: 'stdout' | 'stderr' = 'stdout',
) {
  const reader = process[stream].getReader()
  const decoder = new TextDecoder()
  let log = ''
  const timer = setTimeout(() => process.kill('SIGKILL'), 20_000)
  try {
    while (!log.includes(token)) {
      const part = await reader.read()
      if (part.done) throw new Error(`Process ended before ${token}: ${log}`)
      log += decoder.decode(part.value, { stream: true })
    }
    return log
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

async function fixtureMain(mode: string, dir: string) {
  if (mode === 'branding-upgrade') {
    const randomUUID = crypto.randomUUID.bind(crypto)
    crypto.randomUUID = () => {
      // Stop at the first atomic file allocation, before a replacement can commit. This is
      // deliberately after any earlier legacy removals in the production put() sequence.
      Deno.stdout.writeSync(new TextEncoder().encode('branding.before-commit\n'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      return randomUUID()
    }
    new FileBrandingStore(`${dir}/branding`).put('portal', 'logo', {
      bytes,
      contentType: 'image/webp',
      version: 'new',
    })
    return
  }
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
    const branding = new FileBrandingStore(`${dir}/branding`)
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
      branding.put('portal', 'logo', {
        bytes,
        contentType: generation % 2 ? 'image/png' : 'image/jpeg',
        version: String(generation),
      })
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
    { hostname: '127.0.0.1', port: 0, onListen: () => {} },
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
      PORT: '0',
      HOST: '127.0.0.1',
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
      const listening = await untilLine(first, 'Listening on http://', 'stderr')
      const port = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(listening)?.[1]
      expect(port).toBeDefined()
      const response = await fetch(`http://127.0.0.1:${port}/auth/me`)
      expect(response.status).toBe(200)
      await response.text()
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
          'scheduler_stopping',
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
      expect(log.indexOf('"phase":"scheduler_stopping"'))
        .toBeLessThan(log.indexOf('"phase":"scheduler_stopped"'))
      expect(log.indexOf('"phase":"units_aborted"'))
        .toBeLessThan(log.indexOf('"phase":"scheduler_stopped"'))
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

  Deno.test('SIGKILL during the first branding replacement preserves the legacy logo until commit', async () => {
    const dir = directory()
    const root = `${dir}/branding`
    Deno.mkdirSync(root)
    Deno.writeFileSync(`${root}/portal-logo.png`, bytes)
    const process = child('branding-upgrade', dir)
    let alive = true
    try {
      await untilLine(process, 'branding.before-commit')
      process.kill('SIGKILL')
      await process.output()
      alive = false
      const asset = new FileBrandingStore(root).get('portal', 'logo')
      expect(asset).not.toBeNull()
      expect(asset!.bytes).toEqual(bytes)
      expect(asset!.contentType).toBe('image/png')
      expect(() => Deno.statSync(`${root}/assets/portal/logo.json`)).toThrow(Deno.errors.NotFound)
      new FileBrandingStore(root).put('portal', 'logo', {
        bytes: new Uint8Array([9, 8, 7]),
        contentType: 'image/webp',
        version: 'resumed',
      })
      expect(new FileBrandingStore(root).get('portal', 'logo')?.bytes).toEqual(
        new Uint8Array([9, 8, 7]),
      )
      expect(() => Deno.statSync(`${root}/portal-logo.png`)).toThrow(Deno.errors.NotFound)
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
    Deno.mkdirSync(`${dir}/branding`)
    Deno.writeFileSync(`${dir}/branding/portal-logo.png`, bytes)
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const process = child('crash', dir)
        await untilLine(process, 'crash.ready')
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 3))
        process.kill('SIGKILL')
        await process.output()
        expect(store.list('portal').length).toBe(1)
        const asset = new FileBrandingStore(`${dir}/branding`).get('portal', 'logo')
        expect(asset).not.toBeNull()
        expect(asset!.bytes.length).toBe(bytes.length)
        expect(asset!.bytes.every((byte) => byte === 83)).toBe(true)
        const suggestions = [...Deno.readDirSync(`${dir}/suggestions`)]
        expect(suggestions.some((entry) => entry.name.includes('.corrupt-'))).toBe(false)
      }
    } finally {
      Deno.removeSync(dir, { recursive: true })
    }
  })
}
