import { expect } from '@std/expect'
import type { Page } from '@astral/astral'

/** Test-authored source only; there is no HTTP compiler or arbitrary-file route. */
export async function buildComponentFixture({ entrySource }: { entrySource: string }): Promise<{
  directory: string
  close(): Promise<void>
}> {
  await Deno.mkdir('.planning/logs', { recursive: true })
  const directory = await Deno.makeTempDir({ dir: '.planning/logs', prefix: '04-03-component-' })
  try {
    await Deno.writeTextFile(`${directory}/source.tsx`, entrySource)
    const build = await new Deno.Command('esbuild', {
      args: [
        `${directory}/source.tsx`,
        '--bundle',
        '--format=esm',
        '--jsx=automatic',
        `--outfile=${directory}/entry.js`,
        '--alias:@research-portal/core=./packages/core/src/index.ts',
        ...[
          'react',
          'react/jsx-runtime',
          'react-dom',
          'react-dom/client',
          'react-router-dom',
          '@tanstack/react-query',
          'zod',
          'd3-force',
          'three',
          'pdfjs-dist',
        ]
          .map((name) => `--external:${name}`),
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!build.success) throw new Error(new TextDecoder().decode(build.stderr))
    return { directory, close: () => Deno.remove(directory, { recursive: true }) }
  } catch (error) {
    await Deno.remove(directory, { recursive: true })
    throw error
  }
}

export const sourcePath = (path: string) => `${Deno.cwd()}/${path}`

export async function assertCurrentBuild(page: Page): Promise<void> {
  const expected = JSON.parse(await Deno.readTextFile('apps/web/dist/build.json'))
  const actual = await page.evaluate(async () =>
    (await fetch('/build.json', { cache: 'no-store' })).json()
  )
  expect(actual).toEqual(expected)
  const hash = async (bytes: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].join(',')
  const served = await page.evaluate(async () =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          await (await fetch('/app.js', { cache: 'no-store' })).arrayBuffer(),
        ),
      ),
    ].join(',')
  )
  expect(served).toBe(await hash(await Deno.readFile('apps/web/dist/app.js')))
}

export async function captureBoundary(page: Page, directory: string, name: string, width: number) {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
  })
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
    rootFont: getComputedStyle(document.documentElement).fontSize,
    bodyFont: getComputedStyle(document.body).fontFamily,
    headingFont: getComputedStyle(document.querySelector('h1')!).fontFamily,
    primary: getComputedStyle(document.querySelector('.rp-tenant') ?? document.body)
      .getPropertyValue('--rp-primary'),
    radius: getComputedStyle(document.querySelector('.rp-tenant') ?? document.body)
      .getPropertyValue('--rp-radius'),
  }))
  expect(metrics.width).toBe(width)
  expect(metrics.overflow).toBeLessThanOrEqual(1)
  await Deno.mkdir(directory, { recursive: true })
  await Deno.writeFile(`${directory}/${name}.png`, await page.screenshot())
  await Deno.writeTextFile(`${directory}/${name}.json`, JSON.stringify(metrics, null, 2))
}
