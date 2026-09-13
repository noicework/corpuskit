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
  // Final review reuses the mature signed persona journeys without weakening
  // their assertions. Optional extra captures restore both scroll and text size.
  const expanded = Deno.env.get('RBAC_EXPAND_VISUALS')?.split(',')
  if (expanded?.some((prefix) => directory.includes(prefix))) {
    const root = '.planning/logs/04-19-01'
    const source = directory.replace('.planning/logs/', '').replaceAll('/', '-')
    const saved = await page.evaluate(() => {
      const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
      const anchor = [
        ...document.querySelectorAll<HTMLElement>(
          'main h1,main h2,main h3,main button,main input,main textarea,[role=dialog]',
        ),
      ]
        .find((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.top >= header && r.top < innerHeight
        })
      anchor?.setAttribute('data-expanded-anchor', '')
      return {
        font: document.documentElement.style.fontSize,
        x: scrollX,
        y: scrollY,
        offset: anchor?.getBoundingClientRect().top ?? 0,
      }
    })
    try {
      for (const font of [16, 22]) {
        await page.evaluate(async (font, saved) => {
          document.documentElement.style.fontSize = `${font}px`
          await document.fonts.ready
          const anchor = document.querySelector('[data-expanded-anchor]')
          scrollTo({
            left: saved.x,
            top: anchor ? scrollY + anchor.getBoundingClientRect().top - saved.offset : saved.y,
            behavior: 'instant',
          })
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }, { args: [font, saved] })
        const expandedMetrics = await page.evaluate(() => ({
          width: innerWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          font: getComputedStyle(document.documentElement).fontSize,
        }))
        const path = `${root}/journey-${source}-${name}-${font}.png`
        await Deno.mkdir(root, { recursive: true })
        await Deno.writeFile(path, await page.screenshot())
        await Deno.writeTextFile(
          path.replace(/\.png$/, '.json'),
          JSON.stringify(
            {
              surface: `journey-${source}-${name}`,
              source: `${directory}/${name}.png`,
              path,
              width,
              font,
              metrics: expandedMetrics,
              viewed: false,
            },
            null,
            2,
          ),
        )
        expect(expandedMetrics.width).toBe(width)
        expect(expandedMetrics.scrollWidth).toBeLessThanOrEqual(expandedMetrics.clientWidth + 1)
      }
    } finally {
      await page.evaluate((saved) => {
        document.documentElement.style.fontSize = saved.font
        document.querySelector('[data-expanded-anchor]')?.removeAttribute('data-expanded-anchor')
        scrollTo(saved.x, saved.y)
      }, { args: [saved] })
    }
  }
}
