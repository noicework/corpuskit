import { expect } from '@std/expect'
import { AuthorityController } from '../../api/access-lifecycle.ts'
import { sessionFixture } from '../../api/auth.test.ts'
import { UploadQueue, uploadQueueFor } from './upload-store.ts'

/** A signed-in curator, who may add content to the portal. */
function curator(id = 'one', permissions = ['portal.read', 'portal.ask', 'content.write']) {
  const base = sessionFixture('marine', id)
  return {
    ...base,
    effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'curator' }] },
    portalAccess: { ...base.portalAccess, permissions, effectiveRole: 'curator' },
  }
}

/** An upload double: each call waits until the test answers it. */
function uploads() {
  const calls: { name: string; resolve: (id: string) => void; reject: (e: Error) => void }[] = []
  const upload =
    ((_slug: string, _access: unknown, file: File) =>
      new Promise<{ id: string }>((resolve, reject) => {
        calls.push({ name: file.name, resolve: (id) => resolve({ id }), reject })
      })) as unknown as ConstructorParameters<typeof UploadQueue>[3]
  return { calls, upload }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** A panel's access; the upload double never sends through it. */
const allowed = { request: () => Promise.reject(new Error('not sent in these tests')) }
const file = (name: string) => new File(['content'], name)

Deno.test('queued files upload one at a time, and each row reports its own outcome', async () => {
  const authority = new AuthorityController(() => 'browser')
  authority.setSession(curator(), 'marine')
  const { calls, upload } = uploads()
  const queue = new UploadQueue(authority.context.identityKey!, 'marine', authority, upload)
  queue.attach(allowed)
  queue.add([file('a.pdf'), file('b.pdf'), new File([], 'empty.txt')])
  await tick()
  expect(calls.map((call) => call.name)).toEqual(['a.pdf'])
  expect(queue.snapshot().map((row) => row.status)).toEqual(['uploading', 'queued', 'failed'])
  calls[0]!.resolve('res-a')
  await tick()
  expect(calls.map((call) => call.name)).toEqual(['a.pdf', 'b.pdf'])
  calls[1]!.reject(new Error('That file is too large to upload.'))
  await tick()
  expect(queue.snapshot().map((row) => [row.status, row.resourceId ?? row.error])).toEqual([
    ['processing', 'res-a'],
    ['failed', 'That file is too large to upload.'],
    ['failed', 'That file is empty - choose another file.'],
  ])
  queue.clearFinished()
  expect(queue.snapshot().map((row) => row.name)).toEqual(['a.pdf'])
})

Deno.test('nothing is sent while access is checked, and waiting files go on for the same person', async () => {
  const authority = new AuthorityController(() => 'browser')
  authority.setSession(curator(), 'marine')
  const { calls, upload } = uploads()
  const queue = new UploadQueue(authority.context.identityKey!, 'marine', authority, upload)
  queue.attach(allowed)
  authority.invalidate('refresh', 'loading')
  queue.add([file('a.pdf')])
  await tick()
  expect(calls).toEqual([])
  authority.setSession(curator(), 'marine')
  await tick()
  expect(calls.map((call) => call.name)).toEqual(['a.pdf'])
})

Deno.test('waiting files pause while no panel is attached and resume when one returns', async () => {
  const authority = new AuthorityController(() => 'browser')
  authority.setSession(curator(), 'marine')
  const { calls, upload } = uploads()
  const queue = new UploadQueue(authority.context.identityKey!, 'marine', authority, upload)
  const detach = queue.attach(allowed)
  queue.add([file('a.pdf'), file('b.pdf')])
  await tick()
  // The page is redrawn while the first file uploads: the next one waits for the new panel.
  detach()
  calls[0]!.resolve('res-a')
  await tick()
  expect(calls.map((call) => call.name)).toEqual(['a.pdf'])
  expect(queue.snapshot().map((row) => row.status)).toEqual(['processing', 'queued'])
  queue.attach(allowed)
  await tick()
  expect(calls.map((call) => call.name)).toEqual(['a.pdf', 'b.pdf'])
})

Deno.test('a queue belongs to one identity: another identity never receives it', () => {
  const authority = new AuthorityController(() => 'browser')
  authority.setSession(curator(), 'marine')
  const first = uploadQueueFor(authority, 'marine')!
  expect(uploadQueueFor(authority, 'marine')).toBe(first)
  authority.invalidate('refresh', 'loading')
  expect(uploadQueueFor(authority, 'marine')).toBe(null)
  authority.setSession(curator('two'), 'marine')
  const second = uploadQueueFor(authority, 'marine')!
  expect(second).not.toBe(first)
  expect(second.identityKey).not.toBe(first.identityKey)
  authority.setSession(curator(), 'marine')
  // The first person's queue was dropped when the second asked for theirs.
  expect(uploadQueueFor(authority, 'marine')).not.toBe(first)
})

Deno.test('an emergency queue sends through its confirmation, whatever the session may do', async () => {
  const authority = new AuthorityController(() => 'browser')
  authority.setSession(curator('one', ['portal.read', 'portal.ask']), 'marine')
  const { calls, upload } = uploads()
  const queue = new UploadQueue('emergency', 'marine', authority, upload, true)
  let confirmations = 0
  queue.add([file('a.pdf')], (_label, action) => {
    confirmations++
    return action({ request: () => Promise.reject(new Error('unused')) })
  })
  await tick()
  expect(confirmations).toBe(1)
  expect(calls.map((call) => call.name)).toEqual(['a.pdf'])
})
