import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

const tenant = { slug: 'export-fixture' } as TenantConfig
function provider(repeat = false, malformed = false) {
  const pages: URL[] = []
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input))
    pages.push(url)
    const page = Number(url.searchParams.get('page_number'))
    if (malformed) return Promise.resolve(Response.json({}))
    const resources = Object.fromEntries(
      Array.from({ length: page === 0 || repeat ? 100 : 1 }, (_, index) => {
        const id = `resource-${(repeat ? 0 : page * 100) + index}`
        return [id, {
          id,
          title: 'Research report',
          summary: 'Research findings',
          hidden: index === 0,
          metadata: { status: index === 1 ? 'ERROR' : 'PROCESSED' },
          extra: { metadata: { custom: 'Metadata value' } },
          origin: { url: 'https://research.example.test/source' },
          usermetadata: { classifications: [{ labelset: 'topic', label: 'soil' }] },
          computedmetadata: {
            field_classifications: [{
              classifications: [{ labelset: 'region', label: 'south' }, {
                labelset: 'region',
                label: 'cancelled',
                cancelled_by_user: true,
              }],
            }],
          },
          data: {
            files: {
              document: {
                value: {
                  file: { content_type: 'application/pdf', uri: 'credentialed-storage-url' },
                },
              },
            },
          },
        }]
      }),
    )
    return Promise.resolve(Response.json({ resources }))
  }
  return {
    pages,
    instance: new AragProvider({
      resolveBinding: () => ({
        baseUrl: 'https://export.rag.progress.cloud/api/v1/kb/fixture',
        token: 'binding-secret',
      }),
      fetchImpl,
    }),
  }
}

Deno.test('provider export pages every resource including drafts and failed ingests with labels and file references', async () => {
  const { instance, pages } = provider()
  const rows = []
  for await (const row of instance.exportResources(tenant, new AbortController().signal)) {
    rows.push(row)
  }
  expect(rows.length).toBe(101)
  expect(pages.map((url) => url.searchParams.get('page_number'))).toEqual(['0', '1'])
  expect(pages.every((url) => !url.searchParams.has('hidden'))).toBe(true)
  expect(rows[0]).toMatchObject({
    resource: { hidden: true, originUrl: 'https://research.example.test/source' },
    labels: [{ labelset: 'topic', label: 'soil' }, { labelset: 'region', label: 'south' }],
    files: [{ fieldId: 'document', contentType: 'application/pdf' }],
  })
  expect(rows[1]?.status).toBe('ERROR')
  expect(JSON.stringify(rows)).not.toContain('credentialed-storage-url')
  expect(JSON.stringify(rows)).not.toContain('binding-secret')
})

Deno.test('provider export fails on repeated pages or malformed inventory and respects cancellation', async () => {
  for (const test of [provider(true), provider(false, true)]) {
    await expect((async () => {
      for await (
        const _row of test.instance.exportResources(tenant, new AbortController().signal)
      ) { /* consume */ }
    })()).rejects.toThrow()
  }
  const { instance, pages } = provider()
  const controller = new AbortController()
  controller.abort()
  await expect(instance.exportResources(tenant, controller.signal)[Symbol.asyncIterator]().next())
    .rejects.toBeDefined()
  expect(pages.length).toBe(0)
})
