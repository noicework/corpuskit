import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { acquireWriterLock, installShutdown } from '../apps/api/src/local-runtime.ts'
import { runSystemMaintenance, syncSource } from '../apps/api/src/scheduler.ts'
import { SourceStore } from '../apps/api/src/stores.ts'
import { SuggestionStore } from '../apps/api/src/interrogate.ts'
import { EnrichmentStore } from '../apps/api/src/enrichments.ts'
import { readJsonSafe, writeJsonAtomic } from '../apps/api/src/persist.ts'
import { FileBrandingStore } from '../apps/api/src/branding-store.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import type { TenantStoreApi } from '../apps/api/src/tenants.ts'
import { localOwnedStores } from '../apps/api/src/local-owned-stores.ts'
import { BindingStore } from '../apps/api/src/bindings.ts'
import { acquireStorageLocks, localStoragePaths } from '../apps/api/src/local-storage.ts'

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
    stdin: mode === 'nested-writer' ? 'piped' : 'inherit',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
}

function realServer(dataDir: string, env: Record<string, string> = {}, permissions: string[] = []) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '-A',
      `--deny-read=${ROOT}.env`,
      ...permissions,
      `${ROOT}apps/api/src/server.ts`,
    ],
    cwd: ROOT,
    env: {
      DATA_DIR: dataDir,
      TENANTS_PATH: `${dataDir}/tenants.json`,
      BINDINGS_PATH: `${dataDir}/bindings.json`,
      KG_PROPOSALS_PATH: `${dataDir}/kg-proposals.json`,
      BRANDING_PATH: `${dataDir}/branding`,
      RBAC_PATH: `${dataDir}/rbac.sqlite`,
      PORT: '0',
      HOST: '127.0.0.1',
      LOCAL_SCHEDULER_ENABLED: 'false',
      SHUTDOWN_GRACE_SECONDS: '2',
      WRITER_LOCK_WAIT_SECONDS: '0.2',
      SHOWCASE_PORTALS: '',
      ...env,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
}

async function untilLine(
  process: Deno.ChildProcess,
  token: string | RegExp,
  stream: 'stdout' | 'stderr' = 'stdout',
) {
  const reader = process[stream].getReader()
  const decoder = new TextDecoder()
  let log = ''
  const timer = setTimeout(() => process.kill('SIGKILL'), 20_000)
  try {
    while (typeof token === 'string' ? !log.includes(token) : !token.test(log)) {
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
  if (mode === 'nested-writer') {
    const paths = localStoragePaths({
      DATA_DIR: dir,
      TENANTS_PATH: `${dir}/../external-tenants.json`,
      BINDINGS_PATH: `${dir}/bindings.json`,
    })
    const release = await acquireStorageLocks(paths, 0)
    const targets = [`${paths.DATA_DIR}/sources/portal.json`, paths.TENANTS_PATH]
    for (const path of targets) {
      Deno.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      Deno.writeTextFileSync(`${path}.tmp-01234567-abc`, 'in-flight bytes')
    }
    console.log('nested-writer.ready')
    // Let the parent server boot while this process holds its locks before committing.
    await new Response(Deno.stdin.readable).text()
    for (const path of targets) Deno.renameSync(`${path}.tmp-01234567-abc`, path)
    release()
    return
  }
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
  const enrichments = new EnrichmentStore(dir)
  const owned = localOwnedStores(dir, database, rbac.audit)
  // Match server.ts: #102 attaches audited mutation wrappers to the shared scheduler stores.
  owned.attach({
    bindings: new BindingStore({ BINDINGS_PATH: `${dir}/bindings.json` }),
    sources,
    enrichments,
  })
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen: () => {} },
    () => new Response('ok'),
  )
  const running = runSystemMaintenance(
    provider,
    {
      rbac,
      sources,
      watches: owned.watches,
      enrichments,
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
  Deno.test("real server boot preserves a nested writer's in-flight files and external sibling", async () => {
    const root = Deno.realPathSync(directory())
    const nested = `${root}/agent-b`
    const writer = child('nested-writer', nested)
    let server: Deno.ChildProcess | undefined
    let writerStopped = false
    let serverStopped = false
    let inputClosed = false
    try {
      await untilLine(writer, 'nested-writer.ready')
      const orphan = `${root}/orphan.json.tmp-01234567-abc`
      Deno.writeTextFileSync(orphan, 'orphan')
      server = realServer(root)
      await untilLine(server, 'Listening on http://', 'stderr')
      const targets = [`${nested}/sources/portal.json`, `${root}/external-tenants.json`]
      for (const path of targets) {
        expect(Deno.readTextFileSync(`${path}.tmp-01234567-abc`)).toBe('in-flight bytes')
      }
      expect(() => Deno.statSync(orphan)).toThrow(Deno.errors.NotFound)
      await writer.stdin.close()
      inputClosed = true
      const committed = await writer.output()
      writerStopped = true
      expect(committed.success, new TextDecoder().decode(committed.stderr)).toBe(true)
      for (const path of targets) expect(Deno.readTextFileSync(path)).toBe('in-flight bytes')
      server.kill('SIGINT')
      const stopped = await server.output()
      serverStopped = true
      expect(stopped.success, new TextDecoder().decode(stopped.stderr)).toBe(true)
    } finally {
      if (!writerStopped) {
        try {
          writer.kill('SIGKILL')
        } catch {
          // The writer may already have exited after a failed rename.
        }
        if (!inputClosed) await writer.stdin.close().catch(() => {})
        await writer.output()
      }
      if (server && !serverStopped) {
        try {
          server.kill('SIGKILL')
        } catch {
          // A failed startup may already have exited.
        }
        await server.output()
      }
      Deno.removeSync(root, { recursive: true })
    }
  })

  Deno.test('real server boots through unreadable sweep directories and undeletable orphan files', async () => {
    const root = Deno.realPathSync(directory())
    const unreadable = `${root}/lost+found`
    const undeletable = `${root}/busy.json.tmp-01234567-abc`
    const healthy = `${root}/healthy.json.tmp-01234567-abc`
    Deno.mkdirSync(unreadable)
    Deno.writeTextFileSync(undeletable, 'private contents')
    Deno.writeTextFileSync(healthy, 'orphan')
    const process = realServer(root, {}, [
      `--deny-read=${unreadable}`,
      `--deny-write=${undeletable}`,
    ])
    let stopped = false
    try {
      const startup = await untilLine(process, 'Listening on http://', 'stderr')
      const diagnostics = startup.split('\n').filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'storage.sweep_failed')
      expect(diagnostics).toEqual(expect.arrayContaining([
        { event: 'storage.sweep_failed', kind: 'directory', code: 'ENOTCAPABLE' },
        {
          event: 'storage.sweep_failed',
          kind: 'temp',
          file: 'busy.json.tmp-01234567-abc',
          code: 'ENOTCAPABLE',
        },
      ]))
      expect(diagnostics).toHaveLength(2)
      expect(JSON.stringify(diagnostics)).not.toContain(root)
      expect(JSON.stringify(diagnostics)).not.toContain('private contents')
      expect(Deno.readTextFileSync(undeletable)).toBe('private contents')
      expect(() => Deno.statSync(healthy)).toThrow(Deno.errors.NotFound)
      process.kill('SIGINT')
      const result = await process.output()
      stopped = true
      expect(result.success, new TextDecoder().decode(result.stderr)).toBe(true)
    } finally {
      if (!stopped) {
        try {
          process.kill('SIGKILL')
        } catch {
          // A failed startup may already have exited.
        }
        await process.output()
      }
      Deno.removeSync(root, { recursive: true })
    }
  })

  for (const shareFile of [false, true]) {
    Deno.test(
      shareFile
        ? 'real servers sharing one external file exclude each other and name the held path'
        : 'real servers with distinct external files in one shared folder both start',
      async () => {
        const root = Deno.realPathSync(directory())
        const running = new Set<Deno.ChildProcess>()
        const tenants = (name: string) =>
          `${root}/shared/${shareFile ? 'shared' : name}-tenants.json`
        const launch = (name: string) => {
          const child = new Deno.Command(Deno.execPath(), {
            args: ['run', '-A', 'apps/api/src/server.ts'],
            cwd: ROOT,
            env: {
              DATA_DIR: `${root}/${name}`,
              TENANTS_PATH: tenants(name),
              BINDINGS_PATH: `${root}/shared/${name}-bindings.json`,
              KG_PROPOSALS_PATH: `${root}/shared/${name}-kg.json`,
              BRANDING_PATH: `${root}/${name}/branding`,
              PORT: '0',
              HOST: '127.0.0.1',
              LOCAL_SCHEDULER_ENABLED: 'false',
              SHUTDOWN_GRACE_SECONDS: '2',
              WRITER_LOCK_WAIT_SECONDS: '0.2',
              SHOWCASE_PORTALS: '',
            },
            stdout: 'piped',
            stderr: 'piped',
          }).spawn()
          running.add(child)
          return child
        }
        const listeningPort = async (child: Deno.ChildProcess) => {
          const log = await untilLine(child, 'Listening on http://', 'stderr')
          const port = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1]
          expect(port).toBeDefined()
          return port!
        }
        try {
          const first = launch('a')
          const firstPort = await listeningPort(first)
          const second = launch('b')
          if (shareFile) {
            // A missing fence would start the second server; fail promptly rather than hang.
            const deadline = setTimeout(() => second.kill('SIGKILL'), 10_000)
            let result: Deno.CommandOutput
            try {
              result = await second.output()
              running.delete(second)
            } finally {
              clearTimeout(deadline)
            }
            expect(result.success).toBe(false)
            expect(new TextDecoder().decode(result.stderr))
              .toContain(`${tenants('b')}.writer.lock writer lock is still held`)
          } else {
            const secondPort = await listeningPort(second)
            for (const port of [firstPort, secondPort]) {
              const response = await fetch(`http://127.0.0.1:${port}/auth/me`)
              expect(response.status).toBe(200)
              await response.text()
            }
          }
          for (const child of running) {
            child.kill('SIGINT')
            const result = await child.output()
            running.delete(child)
            expect(result.success, new TextDecoder().decode(result.stderr)).toBe(true)
          }
        } finally {
          for (const child of running) {
            try {
              child.kill('SIGKILL')
            } catch {
              // A failed startup may already have exited.
            }
            await child.output()
          }
          Deno.removeSync(root, { recursive: true })
        }
      },
    )
  }

  for (const store of ['tenants', 'branding', 'rbac']) {
    Deno.test(`real servers with different DATA_DIR roots fence shared ${store} and name the held path`, async (t) => {
      for (const firstRole of ['custom', 'default']) {
        await t.step(`${firstRole} root starts first`, async () => {
          const root = Deno.realPathSync(directory())
          const running = new Set<Deno.ChildProcess>()
          const inherited = Deno.env.toObject()
          for (
            const key of [
              'DATA_DIR',
              'TENANTS_PATH',
              'BINDINGS_PATH',
              'KG_PROPOSALS_PATH',
              'BRANDING_PATH',
              'RBAC_PATH',
            ]
          ) {
            delete inherited[key]
          }
          const launch = (role: string) => {
            const child = new Deno.Command(Deno.execPath(), {
              args: [
                'run',
                `--config=${ROOT}deno.json`,
                '--allow-net',
                '--allow-env',
                '--allow-read',
                '--allow-write',
                '--allow-run',
                '--allow-sys',
                // Keep the actual path defaults, unaffected by a developer's repo-root .env.
                `--deny-read=${ROOT}.env`,
                `${ROOT}apps/api/src/server.ts`,
              ],
              cwd: root,
              clearEnv: true,
              env: {
                ...inherited,
                PORT: '0',
                HOST: '127.0.0.1',
                LOCAL_SCHEDULER_ENABLED: 'false',
                SHUTDOWN_GRACE_SECONDS: '2',
                WRITER_LOCK_WAIT_SECONDS: '0.2',
                SHOWCASE_PORTALS: '',
                BINDINGS_PATH: `./${role}/bindings.json`,
                ...(role === 'custom' ? { DATA_DIR: './a' } : {}),
                ...(store !== 'tenants' ? { TENANTS_PATH: `./${role}/tenants.json` } : {}),
                ...(store === 'branding'
                  ? {
                    ...(role === 'custom' ? { BRANDING_PATH: './data/branding' } : {}),
                  }
                  : {}),
                ...(store === 'rbac' && role === 'custom'
                  ? { RBAC_PATH: './data/rbac.sqlite' }
                  : {}),
              },
              stdout: 'piped',
              stderr: 'piped',
            }).spawn()
            running.add(child)
            return child
          }
          try {
            const first = launch(firstRole)
            await untilLine(first, 'Listening on http://', 'stderr')
            const second = launch(firstRole === 'custom' ? 'default' : 'custom')
            const startup = await untilLine(
              second,
              /server.writer_lock|Listening on http:/,
              'stderr',
            )
            const held = store === 'tenants'
              ? `${root}/data/tenants.json.writer.lock`
              : store === 'branding'
              ? `${root}/data/branding/.writer.lock`
              : `${root}/data/rbac.sqlite.writer.lock`
            expect(startup).toContain(`${held} writer lock is still held`)
            expect(startup).not.toContain('Listening on http:')
            const refused = await second.output()
            running.delete(second)
            expect(refused.success).toBe(false)
            first.kill('SIGINT')
            const stopped = await first.output()
            running.delete(first)
            expect(stopped.success, new TextDecoder().decode(stopped.stderr)).toBe(true)
          } finally {
            for (const child of running) {
              try {
                child.kill('SIGKILL')
              } catch {
                // A failed startup may already have exited.
              }
              await child.output()
            }
            Deno.removeSync(root, { recursive: true })
          }
        })
      }
    })
  }

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
