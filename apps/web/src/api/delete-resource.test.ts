import { expect } from '@std/expect'
import { ApiError, deleteAdminResource } from './client.ts'
import { sessionAccess } from './break-glass.ts'
import { deletedNotice } from '../components/DeleteDocument.tsx'

const component = await Deno.readTextFile(
  new URL('../components/DeleteDocument.tsx', import.meta.url),
)
const recent = await Deno.readTextFile(new URL('../pages/admin/RecentList.tsx', import.meta.url))
const document = await Deno.readTextFile(
  new URL('../pages/ResourceDetailPage.tsx', import.meta.url),
)

async function answering(response: Response, work: () => Promise<unknown>) {
  const original = globalThis.fetch
  const sent: { url: string; method: string }[] = []
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET' })
    return Promise.resolve(response)
  }
  try {
    return { result: await work(), sent }
  } catch (error) {
    return { error, sent }
  } finally {
    globalThis.fetch = original
  }
}

Deno.test('a delete is one DELETE of the document in its own portal', async () => {
  const { result, sent } = await answering(
    Response.json({ ok: true }),
    () => deleteAdminResource('marine', sessionAccess, 'doc/1'),
  )
  expect(result).toEqual({ ok: true })
  expect(sent).toEqual([{ url: '/api/admin/t/marine/resources/doc%2F1', method: 'DELETE' }])
})

Deno.test('a document already gone, a refused delete and an unfinished clean-up each say what happened', async () => {
  const gone = await answering(
    Response.json({ error: 'not_found' }, { status: 404 }),
    () => deleteAdminResource('marine', sessionAccess, 'doc-1'),
  )
  expect(gone.error).toBeInstanceOf(ApiError)
  expect((gone.error as ApiError).status).toBe(404)
  for (
    const [status, error, message] of [
      [
        502,
        'delete_failed',
        'The document could not be deleted. Try again shortly.',
      ],
      [
        500,
        'cleanup_incomplete',
        'The document was deleted, but some of what the portal kept for it could not be cleared. Try again to finish.',
      ],
      [
        409,
        'add_in_progress',
        'Documents are still being added to this portal, so this one cannot be deleted yet. Try again in a moment.',
      ],
    ] as const
  ) {
    const answer = await answering(
      Response.json({ error, message }, { status }),
      () => deleteAdminResource('marine', sessionAccess, 'doc-1'),
    )
    expect(answer.error, error).toMatchObject({ status, code: error, message })
  }
  // A success the client cannot read as one is not taken as one.
  const odd = await answering(
    Response.json({ deleted: true }),
    () => deleteAdminResource('marine', sessionAccess, 'doc-1'),
  )
  expect(odd.error).toBeInstanceOf(Error)
})

Deno.test('the delete announcement names the document and whether it was already gone', () => {
  expect(deletedNotice('Stock report', 'deleted')).toBe('Deleted “Stock report”.')
  expect(deletedNotice('Stock report', 'already-deleted')).toBe(
    '“Stock report” had already been deleted.',
  )
})

Deno.test('the delete confirmation names the document, says it is permanent and what it takes with it', () => {
  expect(component).toContain("title='Delete document'")
  expect(component).toContain('Delete <strong')
  expect(component).toContain('{title}</strong>?')
  expect(component).toContain('This cannot be undone.')
  expect(component).toContain('It is removed from the Library, from search and from answers.')
  expect(component).toContain('Investigations that cite it keep the passages people saved')
  expect(component).toContain("cancelLabel='Keep document'")
  expect(component).toContain("busyLabel='Deleting document...'")
})

Deno.test('a delete answer is published only while the authority that sent it is current', () => {
  // The explicit-action path, then the same context check before anything is shown or refreshed.
  expect(component).toContain("usePermissionAdminAccess('content.write', { kind: 'portal', slug })")
  expect(component).toContain('await runExplicit(')
  const answered = component.indexOf('await runExplicit(')
  const checked = component.indexOf('authority.controller.assertCurrent(context)', answered)
  const published = component.indexOf('setEnded(outcome)', answered)
  expect(checked).toBeGreaterThan(answered)
  expect(published).toBeGreaterThan(checked)
  // It is reported once the dialog has closed, after the same check again.
  const reported = component.indexOf('onDeleted(ended)')
  expect(component.lastIndexOf('authority.controller.assertCurrent(context)', reported))
    .toBeGreaterThan(component.indexOf('if (!ended) return'))
  // A document already gone is reported, after the same check.
  expect(component).toContain('err.status === 404')
  expect(component).toContain("outcome = 'already-deleted'")
})

Deno.test('delete is offered in Recent additions for every row, and on the document page only with content.write', () => {
  expect(recent).toContain('<DeleteDocumentButton')
  expect(recent).toContain("r.status === 'pending' && !r.stuck")
  expect(document).toContain(
    "if (!access.can('content.write', { kind: 'portal', slug })) return null",
  )
  expect(document).toContain('navigate(`/t/${slug}/library`')
})
