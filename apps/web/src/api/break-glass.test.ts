import { expect } from '@std/expect'
function assertEquals(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected)
}
async function assertRejects(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action()
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected rejection')
}
import {
  AdminAccessError,
  adminFetch,
  runWithEmergencyAccess,
  sessionAccess,
} from './break-glass.ts'
import { getAdminOverview, migrateKb, uploadAdminFile } from './client.ts'
import { getAuthSession } from './auth.ts'

Deno.test('one confirmation dispatches once and cannot retain access', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (_input, init) => {
    calls++
    assertEquals(new Headers(init?.headers).get('x-admin-passcode'), 'test-only-input')
    return Promise.resolve(new Response('{}'))
  }
  try {
    let retained = sessionAccess
    await runWithEmergencyAccess('test-only-input', async (access) => {
      retained = access
      await access.request('/api/admin/overview')
      await assertRejects(() => access.request('/api/admin/overview'))
    })
    await assertRejects(() => retained.request('/api/admin/overview'))
    assertEquals(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('session access sends no credentials and all legacy strings fail before fetch', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (_input, init) => {
    calls++
    assertEquals(new Headers(init?.headers).has('x-admin-passcode'), false)
    return Promise.resolve(new Response('[]'))
  }
  try {
    await getAdminOverview(sessionAccess)
    for (const legacy of ['', 'microsoft-sso', 'old-stored-value']) {
      await assertRejects(() => getAdminOverview(legacy as never))
    }
    await assertRejects(() =>
      adminFetch(sessionAccess, '/api/admin/overview', {
        headers: { 'x-admin-passcode': 'old-stored-value' },
      })
    )
    assertEquals(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('browser source inventory contains no credential bridge, persistence or query leases', async () => {
  async function inspect(directory: URL): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = new URL(entry.name + (entry.isDirectory ? '/' : ''), directory)
      if (entry.isDirectory) await inspect(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        const source = await Deno.readTextFile(path)
        expect(source, path.pathname).not.toMatch(/microsoft-sso|AdminAccessInput|input\.passcode/)
        expect(source, path.pathname).not.toMatch(
          /(?:sessionStorage|localStorage)\.(?:getItem|setItem)[^\n]*(?:passcode|credential)/i,
        )
        expect(source, path.pathname).not.toMatch(/queryKey:[^\n]*\b(?:passcode|credential)\b/i)
        if (entry.name !== 'EmergencyAccess.tsx' && entry.name !== 'break-glass.ts') {
          expect(source, path.pathname).not.toMatch(
            /passcode\s*[?:]\s*string|credential\s*[?:]\s*string/,
          )
          expect(source, path.pathname).not.toMatch(/['"]x-admin-passcode['"]\s*[: ,)]/)
        }
      }
    }
  }
  await inspect(new URL('../', import.meta.url))
})

Deno.test('JSON, multipart and SSE share the same budget and cancellation', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = (_input, init) => {
    calls++
    assertEquals(new Headers(init?.headers).get('x-admin-passcode'), 'test-only-input')
    return Promise.resolve(
      new Response(
        calls === 1
          ? '{"id":"file"}'
          : 'data: {"type":"done","copied":1,"skipped":0,"errors":0}\n\n',
      ),
    )
  }
  try {
    await runWithEmergencyAccess('test-only-input', async (access) => {
      await uploadAdminFile('demo', access, new File(['x'], 'example.txt'))
      await assertRejects(() => getAdminOverview(access))
    })
    await runWithEmergencyAccess('test-only-input', async (access) => {
      await migrateKb('a', 'b', access, () => {})
      await assertRejects(() => getAdminOverview(access))
    })
    controller.abort()
    await assertRejects(() =>
      runWithEmergencyAccess(
        'test-only-input',
        (access) => access.request('/api/admin/overview', { signal: controller.signal }),
      )
    )
    assertEquals(calls, 2)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('failures expose safe diagnostics with no retry or credential lease', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => {
    calls++
    throw new Error('transport reflected test-only-input')
  }
  try {
    const error = await assertRejects(() =>
      runWithEmergencyAccess('test-only-input', (access) => access.request('/api/admin/overview'))
    )
    assertEquals(String(error).includes('test-only-input'), false)
    assertEquals(calls, 1)
    await runWithEmergencyAccess('test-only-input', async (access) => {
      await Promise.resolve()
      await assertRejects(() => access.request('/api/admin/overview'))
    })
    assertEquals(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('failed and malformed capability responses fail closed', async () => {
  const original = globalThis.fetch
  try {
    for (const value of [null, {}, { authenticated: false, breakGlassEnabled: 'true' }]) {
      globalThis.fetch = () => Promise.resolve(Response.json(value))
      assertEquals((await getAuthSession()).breakGlassEnabled, false)
      assertEquals((await getAuthSession()).coarseAdminEligible, false)
    }
    globalThis.fetch = () => Promise.reject(new Error('network'))
    assertEquals((await getAuthSession()).breakGlassEnabled, false)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('multipart, refused and locked responses have a safe single dispatch', async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    const form = new FormData()
    form.set('file', new File(['example'], 'file.txt'))
    for (const status of [200, 401, 403, 429, 500]) {
      globalThis.fetch = (_input, init) => {
        calls++
        assertEquals(init?.body, form)
        assertEquals(new Headers(init?.headers).has('content-type'), false)
        assertEquals(init?.redirect, 'error')
        return Promise.resolve(
          new Response('test-only-input', {
            status,
            headers: { 'retry-after': '125' },
          }),
        )
      }
      const operation = () =>
        runWithEmergencyAccess(
          'test-only-input',
          (access) => adminFetch(access, '/api/admin/upload', { method: 'POST', body: form }),
        )
      if (status === 200) await (await operation()).text()
      else {
        const error = await assertRejects(operation)
        expect(error).toBeInstanceOf(AdminAccessError)
        assertEquals((error as AdminAccessError).status, status)
        assertEquals((error as AdminAccessError).retryAfter, 125)
        assertEquals(String(error).includes('test-only-input'), false)
      }
    }
    assertEquals(calls, 5)
    for (const url of ['https://other.invalid/api/admin/a', '/api/admin/../../auth/me']) {
      await assertRejects(() =>
        runWithEmergencyAccess('test-only-input', (access) => access.request(url))
      )
    }
    assertEquals(calls, 5)
  } finally {
    globalThis.fetch = original
  }
})
