import { expect } from '@std/expect'

for (const filename of ['wrangler.jsonc', 'wrangler.demo.jsonc']) {
  Deno.test(`${filename} excludes credential-bearing request URLs from invocation logs`, async () => {
    const config = JSON.parse(
      await Deno.readTextFile(new URL(`../../../${filename}`, import.meta.url)),
    )
    expect(config.observability.logs.invocation_logs).toBe(false)
    expect(config.observability.logs.enabled).toBe(true)
  })
}
