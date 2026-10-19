import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { AUDIT_TIMEOUT_MS, executeAudited } from './audit-execution.ts'
import { syncSource } from './scheduler.ts'
import type { SourceStoreApi } from './stores.ts'

/** Exercise a real deadline release while the provider ignores cancellation. */
export async function checkLateSourceCheckpoint(t: Deno.TestContext, sources: SourceStoreApi) {
  for (const lateCount of [1, 5]) {
    for (const overlap of [false, true]) {
      await t.step(`${lateCount} late pages, overlap=${overlap}`, async () => {
        const config = { slug: 'checkpoint' } as TenantConfig
        const source = sources.add(
          config.slug,
          `https://example.org/${lateCount}-${overlap}/news`,
          true,
          10,
        )
        const baseline = lateCount === 5
          ? Array.from({ length: 4999 }, (_, i) => `https://example.org/saved-${i}`)
          : []
        const itemCount = baseline.length ? 8000 : 0
        sources.update(config.slug, source.id, { synced: baseline, itemCount })
        const late = Array.from({ length: lateCount }, (_, i) => `https://example.org/late-${i}`)
        const newer = Array.from({ length: 6 }, (_, i) => `https://example.org/new-${i}`)
        if (overlap) newer[0] = late[0]!
        let links = late
        const original = globalThis.fetch
        globalThis.fetch = async (input) =>
          new Response(
            String(input) === source.url
              ? links.map((url) => `<a href="${url}">Article</a>`).join('')
              : `<html><title>Article</title><main><p>${
                'fisheries stock assessment evidence '.repeat(40)
              }</p></main></html>`,
            { headers: { 'content-type': 'text/html' } },
          )
        const started = Promise.withResolvers<void>()
        const resume = Promise.withResolvers<void>()
        let expire!: () => void
        let producer: Promise<unknown> | undefined
        const released = executeAudited({
          audit: { append: () => {} },
          input: {
            requestId: 'late-checkpoint',
            actor: { kind: 'system' },
            action: 'maintenance.source.sync',
            scope: { kind: 'portal', slug: config.slug },
            target: { kind: 'source', id: source.id },
            detail: {},
          },
          schedule: (callback, ms) => {
            expect(ms).toBe(AUDIT_TIMEOUT_MS)
            expire = callback
            return () => {}
          },
          run: (signal) =>
            producer = syncSource(
              {
                createText: async (_config: TenantConfig, input: { originUrl: string }) => {
                  if (input.originUrl === late.at(-1)) {
                    started.resolve()
                    await resume.promise
                  }
                  return { id: input.originUrl }
                },
              } as unknown as AragProvider,
              sources,
              config,
              source,
              () => {},
              signal,
            ),
        })
        try {
          await started.promise
          expect(AUDIT_TIMEOUT_MS).toBe(120_000)
          expire()
          await expect(released).rejects.toThrow('deadline_exceeded')
          links = newer
          await syncSource(
            {
              createText: async () => ({ id: 'new' }),
            } as unknown as AragProvider,
            sources,
            config,
            source,
            () => {},
          )
          resume.resolve()
          await expect(producer).rejects.toThrow()
          const saved = sources.find(config.slug, source.id)!
          const merged = [...new Set([...baseline, ...late, ...newer])].slice(-5000)
          expect(saved.synced).toEqual(merged)
          expect(saved.itemCount).toBe(itemCount + late.length + newer.length - Number(overlap))
        } finally {
          resume.resolve()
          await producer?.catch(() => {})
          await released.catch(() => {})
          globalThis.fetch = original
        }
      })
    }
  }
}
