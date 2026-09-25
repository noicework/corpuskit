import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { platformShellResponse } from '../apps/api/src/platform-shell.ts'

Deno.test('browser portal links read runtime shell configuration without a bundle rebuild', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'platform-domain-e2e-' })
  const entry = `${directory}/entry.ts`
  const bundle = `${directory}/entry.js`
  await Deno.writeTextFile(
    entry,
    `
    import { portalHref } from ${JSON.stringify(`${Deno.cwd()}/apps/web/src/lib/portal-url.ts`)};
    for (const domain of ['research.example.test', 'other.example.test']) {
      const link = document.createElement('a');
      link.id = domain.split('.')[0];
      link.href = portalHref('marine', { hostname: 'marine.' + domain });
      link.textContent = 'Open portal';
      document.body.append(link);
    }
  `,
  )
  const build = await new Deno.Command('esbuild', {
    args: [entry, '--bundle', '--format=esm', `--outfile=${bundle}`],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!build.success) throw new Error(new TextDecoder().decode(build.stderr))
  const script = await Deno.readFile(bundle)
  // This isolated browser fixture uses the real shell marker and navigation module,
  // with no external scripts, fonts, API services or retrieval calls.
  const sourceShell = await Deno.readTextFile('apps/web/index.html')
  const meta = sourceShell.match(/<meta name="corpuskit-platform-domain"[^>]+>/)?.[0]
  expect(meta).toBeDefined()
  const shell =
    `<!doctype html><head>${meta}</head><body><script type="module" src="/entry.js"></script></body>`
  let domain = 'research.example.test'
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
    if (new URL(request.url).pathname === '/entry.js') {
      return new Response(script, { headers: { 'content-type': 'text/javascript' } })
    }
    return platformShellResponse(
      new Response(shell, { headers: { 'content-type': 'text/html' } }),
      domain,
    )
  })
  const browser = await launch({
    args: [
      '--host-resolver-rules=MAP research.example.test 127.0.0.1, MAP other.example.test 127.0.0.1',
      '--no-proxy-server',
    ],
  })
  try {
    const port = (server.addr as Deno.NetAddr).port
    for (
      const [configured, host, target, expected] of [
        [
          'research.example.test',
          'research.example.test',
          'research',
          'https://marine.research.example.test/t/marine',
        ],
        ['other.example.test', 'research.example.test', 'research', '/t/marine'],
        [
          'other.example.test',
          'other.example.test',
          'other',
          'https://marine.other.example.test/t/marine',
        ],
      ]
    ) {
      domain = configured!
      const page = await browser.newPage(`http://${host}:${port}/`)
      try {
        await page.waitForSelector(`#${target}`)
        expect(
          await page.evaluate((id: string) => document.getElementById(id)?.getAttribute('href'), {
            args: [target!],
          }),
        ).toBe(expected)
        expect(
          await page.evaluate(() =>
            document.querySelector<HTMLMetaElement>('meta[name="corpuskit-platform-domain"]')
              ?.content
          ),
        ).toBe(configured)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
    await server.shutdown()
    await Deno.remove(directory, { recursive: true })
  }
})
