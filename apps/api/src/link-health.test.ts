import { PublicHttpClient } from './public-http.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { expect } from '@std/expect'
import { checkLink, classifyLink, runLinkChecks } from './link-health.ts'
import { LinkHealthStore } from './link-health-store.ts'

Deno.test('link classifier distinguishes absence, restricted access and temporary faults', () => {
  for (const code of [200, 204, 301, 302, 304]) expect(classifyLink(code)).toBe('ok')
  for (const code of [404, 410]) expect(classifyLink(code)).toBe('broken')
  for (const code of [401, 403]) expect(classifyLink(code)).toBe('restricted')
  for (const code of [400, 408, 429, 500, 503]) expect(classifyLink(code)).toBe('temporary')
})

Deno.test('local queue remembers ignores, isolates portals and erases records', () => {
  const directory = Deno.makeTempDirSync()
  const database = new LocalRbacDatabase(`${directory}/queue.sqlite`)
  try {
    const store = new LinkHealthStore(database)
    const row = {
      id: 'link',
      url: 'https://example.test/gone',
      title: 'Research',
      status: 'broken' as const,
      firstFailed: '2026-10-01T00:00:00Z',
      lastChecked: '2026-10-02T00:00:00Z',
      attempts: 2,
      ignored: true,
    }
    store.put('first', row)
    expect(new LinkHealthStore(database).list('first')).toEqual([row])
    expect(store.list('second')).toEqual([])
    expect(store.erase('first')).toBe(1)
    expect(store.list('first')).toEqual([])
    expect(store.erase('first')).toBe(0)
    database.exec('INSERT INTO link_health (slug, payload) VALUES (?, ?)', 'empty-portal', '[]')
    expect(store.erase('empty-portal')).toBe(1)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('refresh carries an ignored URL to its replacement resource and removes stale reviews', async () => {
  const store = new LinkHealthStore()
  const row = {
    id: 'ignored',
    resourceId: 'old-resource',
    url: 'https://example.test/page',
    title: 'Research',
    status: 'broken' as const,
    firstFailed: '2026-10-01T00:00:00Z',
    lastChecked: '2026-10-02T00:00:00Z',
    attempts: 2,
    ignored: true,
  }
  store.put('first', row)
  store.put('first', {
    ...row,
    id: 'stale',
    resourceId: 'removed',
    url: 'https://example.test/removed',
    ignored: false,
  })
  const result = await runLinkChecks(store, 'first', [{
    url: row.url,
    resourceId: 'replacement',
    title: 'Updated research',
  }])
  expect(result.checked).toBe(0)
  expect(store.list('first')).toEqual([{
    ...row,
    resourceId: 'replacement',
    sourceId: undefined,
    title: 'Updated research',
  }])
  await runLinkChecks(store, 'first', [])
  expect(store.list('first')[0]?.resourceId).toBeUndefined()
  await runLinkChecks(store, 'first', [{
    url: row.url,
    resourceId: 're-added',
    title: 'Research again',
  }])
  expect(store.list('first')[0]?.resourceId).toBe('re-added')
  expect(store.list('first')[0]?.ignored).toBe(true)
})

Deno.test('a timed-out re-check clears an earlier HTTP code and keeps the failure history', async () => {
  class TimeoutClient extends PublicHttpClient {
    override request(): Promise<Response> {
      return Promise.reject(new DOMException('Deadline exceeded', 'TimeoutError'))
    }
  }
  const previous = {
    id: 'link',
    url: 'https://example.test/page',
    title: 'Research',
    status: 'broken' as const,
    httpStatus: 410,
    firstFailed: '2026-10-01T00:00:00Z',
    lastChecked: '2026-10-02T00:00:00Z',
    attempts: 2,
    ignored: false,
  }
  const result = await checkLink(previous, previous, new TimeoutClient())
  expect(result.status).toBe('timeout')
  expect(result.httpStatus).toBeUndefined()
  expect(result.attempts).toBe(3)
  expect(result.firstFailed).toBe(previous.firstFailed)
})

Deno.test('an ignore decision survives in-flight checks and their attempts are counted together', async () => {
  const store = new LinkHealthStore()
  const row = {
    id: 'link',
    url: 'https://example.test/page',
    title: 'Research',
    status: 'broken' as const,
    firstFailed: '2026-10-01T00:00:00Z',
    lastChecked: '2026-10-02T00:00:00Z',
    attempts: 1,
    ignored: false,
  }
  store.put('first', row)
  class PendingClient extends PublicHttpClient {
    entered = Promise.withResolvers<void>()
    finished = Promise.withResolvers<Response>()
    override request(): Promise<Response> {
      this.entered.resolve()
      return this.finished.promise
    }
  }
  const first = new PendingClient(), second = new PendingClient()
  const targets = [{ url: row.url, title: row.title }]
  const one = runLinkChecks(store, 'first', targets, undefined, first)
  const two = runLinkChecks(store, 'first', targets, undefined, second)
  await Promise.all([first.entered.promise, second.entered.promise])
  store.put('first', { ...row, ignored: true })
  first.finished.reject(new Error('Connection unavailable'))
  second.finished.reject(new Error('Connection unavailable'))
  await Promise.all([one, two])
  const saved = store.list('first')
  expect(saved).toHaveLength(1)
  expect(saved[0]?.ignored).toBe(true)
  expect(saved[0]?.attempts).toBe(3)
  expect(saved[0]?.firstFailed).toBe(row.firstFailed)
})
