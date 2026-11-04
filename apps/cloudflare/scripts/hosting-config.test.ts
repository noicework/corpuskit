import { expect } from '@std/expect'
import { parse as parseJsonc } from '@std/jsonc'
import { showcasePortals } from '../../api/src/tenants.ts'
import { portalIndexingMode } from '../../api/src/search-files.ts'

for (const filename of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
  Deno.test(`${filename} excludes credential-bearing request URLs from invocation logs`, async () => {
    const config = parseJsonc(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    ) as { observability: { logs: { invocation_logs: boolean; enabled: boolean } } }
    expect(config.observability.logs.invocation_logs).toBe(false)
    expect(config.observability.logs.enabled).toBe(true)
  })
}

for (
  const [filename, hosts, samples] of [
    ['wrangler.jsonc', ['corpuskit.org', 'www.corpuskit.org', 'grains.corpuskit.org'], ['grains']],
    ['wrangler.demo.jsonc', ['demo.corpuskit.org'], []],
  ] as const
) {
  Deno.test(`${filename} keeps only its documentation hosts and held sample portal`, async () => {
    const config = parseJsonc(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    ) as { routes: { pattern: string; custom_domain: boolean }[]; vars: Record<string, string> }
    expect(config.routes).toEqual(hosts.map((pattern) => ({ pattern, custom_domain: true })))
    expect([...showcasePortals(config.vars)]).toEqual(samples)
    expect(config.vars.RESERVED_HOSTNAMES).toBeUndefined()
  })
}

for (const filename of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
  Deno.test(`${filename} keeps its portals out of search engines`, async () => {
    const config = parseJsonc(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    ) as { vars: Record<string, string> }
    expect(config.vars.PORTAL_INDEXING).toBe('deny')
    expect(portalIndexingMode(config.vars.PORTAL_INDEXING)).toBe('deny')
  })
}
