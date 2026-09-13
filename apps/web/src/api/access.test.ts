import { expect } from '@std/expect'
import {
  AssignmentError,
  changeAccessMode,
  changeAssignment,
  createAssignment,
  listAssignments,
  removeAssignment,
} from './access.ts'
import { AuthorityController } from './access-lifecycle.ts'

const scope = { kind: 'portal', slug: 'marine' } as const
const row = {
  id: 'assignment-1',
  tenantId: 'tenant-1',
  subjectKind: 'pending-email',
  subjectId: 'pending@example.test',
  scope,
  role: 'viewer',
  emailProvenance: 'pending@example.test',
  createdAt: 1,
  updatedAt: 2,
}

Deno.test('access mode transport sends only the mode and validates the saved scope and value', async () => {
  const original = globalThis.fetch
  const calls: { path: string; method: string | undefined; body: unknown }[] = []
  globalThis.fetch = (input, init) => {
    calls.push({ path: String(input), method: init?.method, body: init?.body })
    return Promise.resolve(Response.json({ slug: 'marine', accessMode: 'restricted' }))
  }
  try {
    expect(await changeAccessMode('marine', 'restricted')).toEqual({
      slug: 'marine',
      accessMode: 'restricted',
    })
    expect(calls).toEqual([{
      path: '/api/admin/t/marine/access',
      method: 'PATCH',
      body: '{"accessMode":"restricted"}',
    }])
    for (
      const value of [{ slug: 'other', accessMode: 'restricted' }, {
        slug: 'marine',
        accessMode: 'public',
      }, { slug: 'marine', accessMode: 'unknown' }]
    ) {
      globalThis.fetch = () => Promise.resolve(Response.json(value))
      await expect(changeAccessMode('marine', 'restricted')).rejects.toThrow(AssignmentError)
    }
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: 'audit_write_failed' }, { status: 500 }))
    await expect(changeAccessMode('marine', 'restricted')).rejects.toThrow('could not be confirmed')
    const authority = new AuthorityController(() => 'test')
    await expect(changeAccessMode('marine', 'restricted', { authority })).rejects.toThrow(
      AssignmentError,
    )
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('assignment transport uses exact family paths and strict mutation bodies', async () => {
  const original = globalThis.fetch
  const calls: { path: string; method: string; body: unknown }[] = []
  globalThis.fetch = (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: init?.body })
    return Promise.resolve(Response.json(init?.method ? row : { items: [row] }))
  }
  try {
    expect((await listAssignments(scope, 'members')).items).toEqual([row])
    await createAssignment(scope, 'members', {
      subjectKind: 'pending-email',
      subjectId: row.subjectId,
      role: 'viewer',
    })
    await changeAssignment(scope, 'members', row.id, 'curator')
    await removeAssignment(scope, 'members', row.id)
    expect(calls).toEqual([
      { path: '/api/admin/t/marine/members', method: 'GET', body: undefined },
      {
        path: '/api/admin/t/marine/members',
        method: 'POST',
        body: JSON.stringify({
          subjectKind: 'pending-email',
          subjectId: row.subjectId,
          role: 'viewer',
        }),
      },
      {
        path: '/api/admin/t/marine/members/assignment-1',
        method: 'PATCH',
        body: '{"role":"curator"}',
      },
      { path: '/api/admin/t/marine/members/assignment-1', method: 'DELETE', body: undefined },
    ])
    globalThis.fetch = (input, init) => {
      calls.push({ path: String(input), method: init?.method ?? 'GET', body: init?.body })
      return Promise.resolve(
        Response.json({ ...row, scope: { kind: 'platform' }, role: 'owner', subjectKind: 'group' }),
      )
    }
    await createAssignment({ kind: 'platform' }, 'groups', { subjectId: 'group-1', role: 'owner' })
    expect(calls.at(-1)).toEqual({
      path: '/api/admin/groups',
      method: 'POST',
      body: '{"subjectId":"group-1","role":"owner"}',
    })
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('assignment responses reject malformed, wrong-scope, wrong-family and wrong-role rows', async () => {
  const original = globalThis.fetch
  try {
    for (
      const value of [
        [],
        { items: null },
        { items: [{ ...row, scope: { kind: 'portal', slug: 'other' } }] },
        { items: [{ ...row, subjectKind: 'group' }] },
        { items: [{ ...row, role: 'owner' }] },
      ]
    ) {
      globalThis.fetch = () => Promise.resolve(Response.json(value))
      await expect(listAssignments(scope, 'members')).rejects.toThrow(AssignmentError)
    }
    globalThis.fetch = () => Promise.resolve(Response.json({ items: [] }))
    await expect(listAssignments(scope, 'groups')).rejects.toThrow(AssignmentError)
    globalThis.fetch = () => Promise.resolve(Response.json({ items: [], capability: 'disabled' }))
    expect((await listAssignments(scope, 'groups')).capability).toBe('disabled')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('assignment failures retain typed status and safe conflict feedback', async () => {
  const original = globalThis.fetch
  try {
    for (
      const [status, code] of [[400, 'invalid_input'], [409, 'email_conflict'], [
        409,
        'assignment_conflict',
      ], [409, 'last_owner']] as const
    ) {
      globalThis.fetch = () => Promise.resolve(Response.json({ error: code }, { status }))
      try {
        await removeAssignment(scope, 'members', row.id)
        throw new Error('Expected refusal')
      } catch (error) {
        expect(error).toBeInstanceOf(AssignmentError)
        expect((error as AssignmentError).status).toBe(status)
        expect((error as AssignmentError).code).toBe(code)
      }
    }
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: '<private detail>' }, { status: 500 }))
    await expect(removeAssignment(scope, 'members', row.id)).rejects.toThrow(
      'The change could not be confirmed',
    )
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('obsolete assignment callbacks cannot dispatch', async () => {
  const authority = new AuthorityController(() => 'test')
  const context = authority.context
  authority.invalidate('changed')
  await expect(listAssignments(scope, 'members', { authority, context })).rejects.toThrow(
    'Access changed',
  )
})
