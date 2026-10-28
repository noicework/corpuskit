import { LocalRbacDatabase } from './rbac-local.ts'
import { expect } from '@std/expect'
import { classifyLink } from './link-health.ts'
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
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})
