import { expect } from '@std/expect'
import { showcasePortals } from '../../api/src/tenants.ts'
import { portalIndexingMode } from '../../api/src/search-files.ts'

for (const filename of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
  Deno.test(`${filename} excludes credential-bearing request URLs from invocation logs`, async () => {
    const config = JSON.parse(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    )
    expect(config.observability.logs.invocation_logs).toBe(false)
    expect(config.observability.logs.enabled).toBe(true)
  })
}

for (const filename of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
  Deno.test(`${filename} serves the seeded showcase portals, which are off by default`, async () => {
    const config = JSON.parse(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    )
    expect([...showcasePortals(config.vars)].sort()).toEqual(['grains', 'marine'])
  })
}

for (const filename of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
  Deno.test(`${filename} keeps its portals out of search engines`, async () => {
    const config = JSON.parse(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    )
    expect(config.vars.PORTAL_INDEXING).toBe('deny')
    expect(portalIndexingMode(config.vars.PORTAL_INDEXING)).toBe('deny')
  })
}
