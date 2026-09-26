import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer, type TestServer } from './support/test-server.ts'
import { assertCurrentBuild } from './support/rbac-fixture.ts'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import { BrandingSchema } from '@research-portal/core'
import { googleFontsUrl, tenantThemeVars } from '../apps/web/src/lib/theme.ts'

const logs = '.planning/logs/04-19-01'

/**
 * The screenshot matrix below captures 68 surfaces at 8 variants each and
 * takes about 22 minutes on a GitHub runner, and its images are only useful
 * when someone sits down to review them. It therefore runs only when asked
 * for, with `E2E_VISUAL_MATRIX=1` (`deno task test:e2e:visual`, or the
 * "Visual matrix" workflow, which keeps the captures as an artefact). Without
 * the flag the three tests report as ignored and the ordinary e2e run stays
 * fast. The overflow and token assertions on the individual surfaces still run
 * in the other e2e files.
 *
 * The wrapper is named `test` on purpose: the formatter keeps a long test
 * title on one line only for calls it recognises as test declarations, so any
 * other name re-indents every test body in this file.
 */
const visualMatrixRequested = Deno.env.get('E2E_VISUAL_MATRIX') === '1'
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore: !visualMatrixRequested, fn })
const matrix = ['light', 'dark'].flatMap((scheme) =>
  [1440, 390].flatMap((width) => [16, 22].map((font) => ({ scheme, width, font })))
)
type Variant = typeof matrix[number]
const manifest: Record<string, unknown>[] = []

// Only the retrieval/management adapter is synthetic. Identity, grants, routes,
// stores, audit and the SPA are the real local signed test path.
function visualManagement(): NonNullable<BuildAppOptions['management']> {
  return new Proxy({}, {
    get: (_target, method) => () => {
      switch (method) {
        case 'ask':
          return (async function* () {
            yield { type: 'delta', text: 'Coastal research supports fisheries.' }
          })()
        case 'counters':
          return Promise.resolve({ resources: 2, paragraphs: 4, sentences: 8, indexMb: 1 })
        case 'recentResources':
        case 'listResources':
          return Promise.resolve([{
            id: 'res-1',
            title: 'Abalone stock health',
            slug: 'abalone',
            status: 'processed',
          }])
        case 'corpusHealth':
          return Promise.resolve([])
        case 'listAgents':
        case 'agentConfigs':
        case 'labelsets':
          return Promise.resolve([])
        case 'listExtractionMethods':
          return Promise.resolve([{ id: 'default', name: 'Default', kind: 'default' }, {
            id: 'tables',
            name: 'table-aware',
            kind: 'tables',
          }, { id: 'visual', name: 'visual-transcribe', kind: 'visual' }])
        case 'listSearchConfigs':
          return Promise.resolve({})
        case 'graphStrategy':
          return Promise.resolve(null)
        case 'relationsGraph':
          return Promise.resolve({ nodes: [], edges: [] })
        case 'resourceContent':
          return Promise.resolve({
            id: 'res-1',
            title: 'Abalone stock health',
            kind: 'pdf',
            texts: [{ fieldId: 'body', text: 'Marine heatwaves affect abalone populations.' }],
            transcript: [],
            files: [{ fieldId: 'file', contentType: 'application/pdf' }],
          })
        case 'resourceExtraction':
          return Promise.resolve({
            text:
              'Surveys across the southern region recorded a sustained 12% decline in abalone populations since 2019, with marine heatwaves identified as the leading stressor.',
            chars: 156,
            paragraphs: 1,
            tableRows: 0,
            status: 'PROCESSED',
          })
        case 'thumbnailResponse':
          return Promise.resolve(new Response(null, { status: 404 }))
        case 'fileStream':
          return Promise.resolve(new Response('Fixture bytes use the platform text fallback.'))
        case 'uploadFile':
          return Promise.resolve({ id: crypto.randomUUID() })
        case 'patchResourceMeta':
        case 'deleteResource':
          return Promise.resolve()
        case 'invalidate':
          return undefined
        case 'rephrase':
          return Promise.resolve(null)
        case 'askStructured':
          return Promise.resolve({
            object: {
              score: 5,
              reason: 'Complete extraction',
              questions: [],
              suggestions: [],
              topics: [],
              kinds: [],
              assignments: [],
            },
            sources: [],
          })
        default:
          return Promise.reject(
            new Error(`Unsupported visual fixture operation: ${String(method)}`),
          )
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
}

async function click(page: Page, text: string) {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('button,summary,a')].some((el) =>
        el.textContent?.trim().replace(/^[▸▾]\s*/, '').startsWith(text)
      ),
    { args: [text] },
  )
  await page.evaluate((text) => {
    const el = [...document.querySelectorAll<HTMLElement>('button,summary,a')].find((el) =>
      el.textContent?.trim().replace(/^[▸▾]\s*/, '').startsWith(text)
    )!
    el.focus()
  }, { args: [text] })
  await page.keyboard.press('Enter')
}

async function requestStarted(entered: Promise<void>, action: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${action} request did not start`)), 30000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function appearance(page: Page, server: TestServer, variant: Variant, path: string) {
  const branding = BrandingSchema.parse({
    ...server.tenants.get('marine')!.branding,
    paletteId: variant.scheme === 'dark' ? 'observatory' : 'default',
    shape: variant.scheme === 'dark' ? 'soft' : 'square',
    density: variant.scheme === 'dark' ? 'spacious' : 'comfortable',
    typography: 'lexend-zilla',
  })
  server.tenants.patchBranding('marine', branding)
  await page.setViewportSize({ width: variant.width, height: 960 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.goto(`${server.url}${path}`)
  await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
    args: [variant.scheme],
  })
  await page.goto(`${server.url}${path}`)
  await page.waitForFunction(() => !document.body.textContent?.includes('Checking access'))
  if (path.startsWith('/admin')) {
    // Platform has no appearance editor. Exercise its inherited token contract
    // with test-only configuration, as in the preceding platform browser suites.
    await page.evaluate((vars, url) => {
      document.body.classList.add('rp-tenant')
      for (const [key, value] of Object.entries(vars)) {
        document.body.style.setProperty(key === 'colorScheme' ? 'color-scheme' : key, String(value))
      }
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = url
      document.head.append(link)
    }, { args: [tenantThemeVars(branding), googleFontsUrl('lexend-zilla')] })
  }
  await page.evaluate(async (font) => {
    document.documentElement.style.fontSize = `${font}px`
    await document.fonts.ready
    await new Promise((resolve) => setTimeout(resolve, 180))
  }, { args: [variant.font] })
}

async function capture(page: Page, surface: string, variant: Variant, selector = 'h1') {
  if (selector.startsWith('text:')) {
    const text = selector.slice(5)
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('h1,h2,h3,button,p')].some((el) =>
          el.textContent?.trim().startsWith(text)
        ),
      { args: [text] },
    )
    await page.evaluate((text) => {
      document.querySelector('[data-visual-target]')?.removeAttribute('data-visual-target')
      const element = [...document.querySelectorAll('h1,h2,h3,button,p')].find((el) =>
        el.textContent?.trim().startsWith(text)
      )!
      element.setAttribute('data-visual-target', '')
    }, { args: [text] })
    selector = '[data-visual-target]'
  }
  await page.waitForSelector(selector)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((resolve) => setTimeout(resolve, 250))
  })
  await page.evaluate(async (selector) => {
    const element = document.querySelector(selector)!
    element.scrollIntoView({ block: 'start', behavior: 'instant' })
    const target = element.getBoundingClientRect()
    const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
    scrollTo({ top: Math.max(0, scrollY + target.top - header - 80), behavior: 'instant' })
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
  }, { args: [selector] })
  const metrics = await page.evaluate((selector) => {
    const target = document.querySelector(selector)!
    const r = target.getBoundingClientRect()
    const theme = getComputedStyle(document.querySelector('.rp-tenant') ?? document.body)
    const controls = [...document.querySelectorAll<HTMLElement>('button,input,select,textarea')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight
      })
    const tokenChecks = controls.filter((el) => el.matches('.rp-btn,.rp-input')).map((el) => {
      const actual = getComputedStyle(el)
      const probe = document.createElement('span')
      probe.style.cssText = `position:fixed;visibility:hidden;border-radius:var(--rp-radius-${
        el.matches('.rp-btn') ? 'btn' : 'input'
      });font-family:var(--rp-font-body);color:var(--rp-ink);min-height:calc(2.25rem * var(--rp-density-ctl,1))`
      el.parentElement!.append(probe)
      const colourToken = el.matches('.rp-btn-primary') ? '--rp-on-primary' : '--rp-ink'
      const backgroundToken = el.matches('.rp-btn-primary') ? '--rp-primary' : '--rp-surface'
      const checkColour = el.matches('.rp-input,.rp-btn-primary,.rp-btn-outline') &&
        !el.matches(':hover')
      probe.style.color = `var(${colourToken})`
      probe.style.backgroundColor = `var(${backgroundToken})`
      const expected = getComputedStyle(probe)
      const result = {
        actualRadius: actual.borderRadius,
        expectedRadius: expected.borderRadius,
        actualFont: actual.fontFamily,
        expectedFont: expected.fontFamily,
        actualColour: actual.color,
        expectedColour: expected.color,
        actualBackground: actual.backgroundColor,
        expectedBackground: expected.backgroundColor,
        checkColour,
        height: el.getBoundingClientRect().height,
        minimumHeight: el.closest('header')
          ? 0
          : el.style.height === 'auto' || el.classList.contains('h-auto')
          ? Math.min(44, parseFloat(expected.minHeight))
          : parseFloat(expected.minHeight),
      }
      probe.remove()
      return result
    })
    return {
      width: innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      target: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      bodyFont: getComputedStyle(document.body).fontFamily,
      palette: theme.getPropertyValue('--rp-primary'),
      radius: theme.getPropertyValue('--rp-radius'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      tokenChecks,
      labelGrid: [...document.querySelectorAll('input[aria-label^="Label "]')].map((input) => {
        const row = input.parentElement!,
          group = row.parentElement!,
          headings = group.previousElementSibling!
        return {
          row: getComputedStyle(row).gridTemplateColumns,
          headings: getComputedStyle(headings).gridTemplateColumns,
          inputLeft: input.getBoundingClientRect().left,
          definitionLeft: row.querySelector('textarea')?.getBoundingClientRect().left,
          headingLeft: headings.children[1]?.getBoundingClientRect().left,
        }
      }),
      controls: controls.map((el) => ({
        label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 90),
        height: el.getBoundingClientRect().height,
        radius: getComputedStyle(el).borderRadius,
        font: getComputedStyle(el).fontFamily,
      })),
    }
  }, { args: [selector] })
  const name = `${surface}-${variant.scheme}-${variant.width}-${variant.font}`
  await Deno.mkdir(logs, { recursive: true })
  await page.bringToFront()
  await Deno.writeFile(
    `${logs}/${name}.png`,
    await page.screenshot({ captureBeyondViewport: false }),
  )
  manifest.push({
    surface,
    ...variant,
    path: `${logs}/${name}.png`,
    selector,
    metrics,
    viewed: false,
  })
  await Deno.writeTextFile(`${logs}/manifest.json`, JSON.stringify(manifest, null, 2))
  await Deno.writeTextFile(`${logs}/${name}.json`, JSON.stringify(manifest.at(-1), null, 2))
  expect(metrics.width).toBe(variant.width)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.rootFont).toBe(`${variant.font}px`)
  expect(metrics.target.top).toBeGreaterThanOrEqual(0)
  expect(metrics.target.top).toBeLessThan(960)
  expect(metrics.reducedMotion).toBe(true)
  for (const check of metrics.tokenChecks) {
    // Joined search fields deliberately square their internal seam. Their
    // remaining corners still have to resolve to the current shape token.
    expect(
      check.actualRadius.split(' ').every((corner) =>
        corner === check.expectedRadius || corner === '0px'
      ),
    ).toBe(true)
    expect(check.actualRadius.split(' ')).toContain(check.expectedRadius)
    expect(check.actualFont).toBe(check.expectedFont)
    if (check.checkColour) {
      expect(check.actualColour).toBe(check.expectedColour)
      expect(check.actualBackground).toBe(check.expectedBackground)
    }
    expect(check.height + 1).toBeGreaterThanOrEqual(check.minimumHeight)
  }
}

test('visual matrix covers management, reading, access and platform surfaces in both themes widths and text sizes', async () => {
  if (Deno.env.get('RBAC_VISUAL_GROUP')) return
  const server = startTestServer({
    identity: { role: 'owner' },
    management: visualManagement(),
    keyScenarios: true,
  })
  server.setGroupCapability(true)
  server.setAssignment(
    { kind: 'portal', slug: 'marine' },
    'long-identity-' + 'research-'.repeat(12),
    'viewer',
  )
  const browser = await launch()
  const page = await browser.newPage(server.url)
  const selected = Deno.env.get('RBAC_VISUAL_SURFACES')?.split(',')
  const surfaces: { name: string; path: string; selector: string; open?: string[] }[] = [
    { name: 'manage-overview', path: '/t/marine/manage', selector: '[data-manage-counts]' },
    { name: 'manage-chrome', path: '/t/marine/manage', selector: 'h1' },
    { name: 'manage-recent', path: '/t/marine/manage', selector: 'main li button' },
    {
      name: 'manage-add-content',
      path: '/t/marine/manage?tab=content',
      selector: '#link-url-marine',
      open: ['Add link'],
    },
    {
      name: 'manage-sources',
      path: '/t/marine/manage?tab=content',
      selector: '#source-url-marine',
    },
    {
      name: 'manage-health',
      path: '/t/marine/manage?tab=content',
      selector: '[data-admin-health]',
    },
    {
      name: 'manage-insights',
      path: '/t/marine/manage?tab=insights',
      selector: '[data-admin-insights]',
    },
    { name: 'manage-taxonomy', path: '/t/marine/manage?tab=taxonomy', selector: 'h2' },
    {
      name: 'manage-graph',
      path: '/t/marine/manage?tab=graph',
      selector: '[data-graph-read=strategy]',
    },
    {
      name: 'manage-enrichments',
      path: '/t/marine/manage?tab=enrichments',
      selector: '[data-enrichments-export]',
    },
    {
      name: 'manage-behaviour',
      path: '/t/marine/manage?tab=behaviour',
      selector: '[data-behaviour-read=prompts]',
    },
    {
      name: 'manage-extraction',
      path: '/t/marine/manage?tab=extraction',
      selector: '[data-extraction-read]',
    },
    {
      name: 'manage-appearance',
      path: '/t/marine/manage?tab=appearance',
      selector: '[data-appearance-save=shape]',
    },
    { name: 'manage-details', path: '/t/marine/manage?tab=details', selector: 'h2' },
    { name: 'manage-connections', path: '/t/marine/manage?tab=connections', selector: 'h2' },
    {
      name: 'access-members',
      path: '/t/marine/manage?tab=access',
      selector: '[data-assignment-id]',
    },
    {
      name: 'access-groups',
      path: '/t/marine/manage?tab=access',
      selector: '[data-assignment-section=groups]',
    },
    { name: 'access-mode', path: '/t/marine/manage?tab=access', selector: '[data-access-mode]' },
    { name: 'access-keys', path: '/t/marine/manage?tab=access', selector: '[data-keys-panel]' },
    { name: 'portal-audit', path: '/t/marine/manage?tab=audit', selector: '[data-audit-results]' },
    {
      name: 'portal-audit-heading',
      path: '/t/marine/manage?tab=audit',
      selector: '[data-audit-panel] h2',
    },
    {
      name: 'portal-audit-dates',
      path: '/t/marine/manage?tab=audit',
      selector: '[aria-label="From (UTC)"]',
    },
    { name: 'platform-audit-dates', path: '/admin/audit', selector: '[aria-label="From (UTC)"]' },
    { name: 'platform-people', path: '/admin/people', selector: 'h1' },
    { name: 'platform-audit', path: '/admin/audit', selector: '[data-audit-results]' },
    { name: 'platform-estate', path: '/admin', selector: 'h1' },
    { name: 'platform-estate-lower', path: '/admin', selector: '[data-portal-row]:last-child' },
    {
      name: 'platform-people-rows',
      path: '/admin/people',
      selector: '[data-assignment-editor] li',
    },
    { name: 'members-heading', path: '/t/marine/manage?tab=access', selector: 'text:Members' },
    {
      name: 'behaviour-heading',
      path: '/t/marine/manage?tab=behaviour',
      selector: 'text:Ask system prompt',
    },
    {
      name: 'platform-create',
      path: '/admin',
      selector: '#portal-name',
      open: ['Add a knowledge box'],
    },
    {
      name: 'platform-migration',
      path: '/admin',
      selector: '#migrate-from',
      open: ['Migrate resources'],
    },
    { name: 'library', path: '/t/marine/library', selector: 'h1' },
    {
      name: 'search-embedded-ask',
      path: '/t/marine/search?q=abalone',
      selector: '[aria-label="AI answer"]',
    },
    { name: 'document-embedded-ask', path: '/t/marine/library/res-1', selector: '#ask-document' },
    {
      name: 'document-related',
      path: '/t/marine/library/res-1',
      selector: 'text:You might also want',
    },
    { name: 'tools', path: '/t/marine/tools', selector: 'h1' },
    { name: 'ask', path: '/t/marine/ask', selector: 'textarea' },
    { name: 'investigations', path: '/t/marine/investigations', selector: 'h1' },
    { name: 'generate', path: '/t/marine/generate', selector: 'h1' },
    { name: 'assessment', path: '/t/marine/assessment', selector: 'h1' },
    { name: 'docs-embedded-ask', path: '/t/marine/help', selector: '#docs-ask' },
    {
      name: 'graph-actions',
      path: '/t/marine/manage?tab=graph',
      selector: 'text:Propose strategy',
    },
    {
      name: 'behaviour-configs',
      path: '/t/marine/manage?tab=behaviour',
      selector: '[data-behaviour-read=configs]',
    },
    {
      name: 'appearance-colours',
      path: '/t/marine/manage?tab=appearance',
      selector: 'text:Colours',
    },
    {
      name: 'appearance-typography',
      path: '/t/marine/manage?tab=appearance',
      selector: 'text:Typography',
    },
    { name: 'appearance-shape', path: '/t/marine/manage?tab=appearance', selector: 'text:Shape' },
    {
      name: 'appearance-density-actions',
      path: '/t/marine/manage?tab=appearance',
      selector: '[data-appearance-save=density]',
    },
    {
      name: 'portal-audit-filters',
      path: '/t/marine/manage?tab=audit',
      selector: '[aria-label="Audit filters"]',
    },
    { name: 'platform-audit-filters', path: '/admin/audit', selector: 'h1' },
    { name: 'platform-people-add', path: '/admin/people', selector: 'text:Add platform member' },
    {
      name: 'taxonomy-suggestions',
      path: '/t/marine/manage?tab=taxonomy',
      selector: '[data-suggestions-read]',
    },
    {
      name: 'members-long-id',
      path: '/t/marine/manage?tab=access',
      selector: 'text:long-identity-',
    },
    {
      name: 'mode-save-action',
      path: '/t/marine/manage?tab=access',
      selector: 'text:Save access mode',
    },
    { name: 'tools-copy', path: '/t/marine/tools', selector: 'text:Copy connection details' },
    { name: 'assessment-topic', path: '/t/marine/assessment', selector: '#assessment-topic' },
    {
      name: 'appearance-colours-save',
      path: '/t/marine/manage?tab=appearance',
      selector: '[data-appearance-save=colours]',
    },
    {
      name: 'appearance-typography-save',
      path: '/t/marine/manage?tab=appearance',
      selector: '[data-appearance-save=typography]',
    },
    { name: 'search-chrome', path: '/t/marine/search?q=abalone', selector: 'main' },
    { name: 'document-chrome', path: '/t/marine/library/res-1', selector: 'main' },
    { name: 'document-chat-heading', path: '/t/marine/library/res-1', selector: '#chat-heading' },
    { name: 'docs-ask-heading', path: '/t/marine/help', selector: 'text:How do I' },
    {
      name: 'portal-audit-filter-actions',
      path: '/t/marine/manage?tab=audit',
      selector: 'text:Apply filters',
    },
    { name: 'platform-audit-filter-actions', path: '/admin/audit', selector: 'text:Apply filters' },
    {
      name: 'extraction-methods',
      path: '/t/marine/manage?tab=extraction',
      selector: 'text:Extraction methods on the sandbox',
    },
    {
      name: 'extraction-rules-save',
      path: '/t/marine/manage?tab=extraction',
      selector: 'text:Save rules',
    },
    {
      name: 'extraction-routing-middle',
      path: '/t/marine/manage?tab=extraction',
      selector: '[aria-label="Garbled text extraction method"]',
    },
    {
      name: 'enrichment-run-actions',
      path: '/t/marine/manage?tab=enrichments',
      selector: '[data-enrichment-run]',
    },
  ]
  try {
    for (const surface of surfaces.filter((s) => !selected || selected.includes(s.name))) {
      for (const variant of matrix) {
        await appearance(page, server, variant, surface.path)
        for (const text of surface.open ?? []) await click(page, text)
        await capture(page, surface.name, variant, surface.selector)
        if (surface.name === 'library') await assertCurrentBuild(page)
      }
      console.log(`Captured ${surface.name}: ${matrix.length} variants`)
    }
  } catch (error) {
    await Deno.mkdir(logs, { recursive: true })
    await Deno.writeTextFile(
      `${logs}/failure.txt`,
      String(error) + '\n' + await page.evaluate(() => document.body.innerText),
    )
    throw error
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

async function input(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const el = document.querySelector<HTMLInputElement>(selector)!
    const prototype = el.tagName === 'SELECT'
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }, { args: [selector, value] })
}

test('visual state matrix exercises keyboard menus forms confirmations keys exports and safe recovery', async () => {
  if (Deno.env.get('RBAC_VISUAL_SURFACES') || Deno.env.get('RBAC_VISUAL_GROUP') === 'operations') {
    return
  }
  const server = startTestServer({
    identity: { role: 'owner' },
    management: visualManagement(),
    keyScenarios: true,
    breakGlass: true,
  })
  server.setGroupCapability(true)
  const browser = await launch()
  let page = await browser.newPage(server.url)
  try {
    for (const variant of matrix) {
      await appearance(page, server, variant, '/t/marine/library')
      if (variant.width === 390) {
        await (await page.waitForSelector('button[aria-label="Open menu"]')).click()
        await capture(page, 'mobile-navigation', variant, '#mobile-nav-sheet')
      }
      await page.evaluate(
        (width) =>
          document.querySelector<HTMLButtonElement>(
            width === 390
              ? '#mobile-nav-sheet button[title="My account"]'
              : 'header button[title="My account"]',
          )!.focus(),
        { args: [variant.width] },
      )
      await page.keyboard.press('ArrowDown')
      await capture(page, 'account-menu', variant, '[role=menu]')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await capture(page, 'account-profile', variant, '[role=dialog]')
      await page.keyboard.down('Shift')
      await page.keyboard.press('Tab')
      await page.keyboard.up('Shift')
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
        'Sign out',
      )
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        'Close',
      )
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        (width) =>
          width === 390
            ? document.activeElement?.getAttribute('aria-label') === 'Open menu'
            : document.activeElement?.getAttribute('title') === 'My account',
        { args: [variant.width] },
      )
      expect(
        await page.evaluate(
          (width) => document.activeElement?.getAttribute(width === 390 ? 'aria-label' : 'title'),
          {
            args: [variant.width],
          },
        ),
      ).toBe(
        variant.width === 390 ? 'Open menu' : 'My account',
      )

      await appearance(page, server, variant, '/t/marine/manage?tab=access')
      await click(page, 'Add member')
      await capture(page, 'member-editor', variant, '[data-assignment-editor] form')
      await capture(
        page,
        'member-editor-actions',
        variant,
        '[data-assignment-editor] form button[type=submit]',
      )
      await click(page, 'Close member form')
      await click(page, 'Add group mapping')
      await capture(page, 'group-editor', variant, '[data-assignment-editor] form')
      await capture(
        page,
        'group-editor-actions',
        variant,
        '[data-assignment-editor] form button[type=submit]',
      )
      await click(page, 'Keep mapping')
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('[data-access-mode] input[value=restricted]')!
          .click()
      )
      await click(page, 'Save access mode')
      await capture(page, 'mode-confirmation', variant, 'dialog[open]')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))

      await input(page, '[data-key-label]', 'Visual verification')
      await input(page, '[data-key-expiry]', '2000-01-01T12:00')
      await page.evaluate(() =>
        document.querySelector<HTMLInputElement>('[data-key-expiry]')!.focus()
      )
      const editedTimes: string[] = []
      for (let segment = 0; segment < 6; segment++) {
        await page.keyboard.press('ArrowUp')
        editedTimes.push(
          await page.evaluate(() =>
            document.querySelector<HTMLInputElement>('[data-key-expiry]')!.value
          ),
        )
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowRight')
      }
      expect(editedTimes.some((value) => value.slice(11) !== '12:00')).toBe(true)
      await Deno.writeTextFile(
        `${logs}/key-date-editing-${variant.scheme}-${variant.width}-${variant.font}.json`,
        JSON.stringify(editedTimes),
      )
      await input(page, '[data-key-expiry]', '2000-01-01T12:00')
      await click(page, 'Create key')
      await capture(page, 'key-validation-error', variant, '[data-keys-panel] [role=alert]')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert')
      await input(page, '[data-key-expiry]', '')
      await page.evaluate(() => {
        const original = fetch
        globalThis.fetch = async (input, init) => {
          const response = await original(input, init)
          if (String(input).endsWith('/mcp/keys') && init?.method === 'POST' && response.ok) {
            const value = await response.json()
            value.key = 'ck_' + 'z'.repeat(43)
            value.credential.prefix = value.key.slice(0, 15)
            return Response.json(value, { status: 201 })
          }
          return response
        }
      })
      await click(page, 'Create key')
      await page.waitForSelector('[data-one-time-key]')
      await page.evaluate(() => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-key-secret]')!
        field.value = '[Redacted fake key for visual verification]'
        field.style.visibility = 'hidden'
      })
      await capture(page, 'key-one-time-redacted', variant, '[data-one-time-key]')
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-one-time-key]')))
        .toBe(true)
      await page.keyboard.press('Escape')
      expect(await page.$('[data-one-time-key]')).toBeNull()

      for (const platform of [false, true]) {
        await page.close()
        page = await browser.newPage(server.url)
        const path = platform ? '/admin/audit' : '/t/marine/manage?tab=audit'
        const prefix = platform ? 'platform' : 'portal'
        await appearance(page, server, variant, path)
        await page.waitForSelector('[data-audit-results]')
        const endpoint = platform ? '/api/admin/audit/export' : '/api/admin/t/marine/audit/export'
        const pending = server.delayResponse(endpoint)
        await click(page, 'Export JSON')
        await pending.entered
        await capture(page, `${prefix}-export-pending`, variant, '[data-audit-export]')
        await click(page, 'Stop export')
        pending.release()
        await capture(page, `${prefix}-export-cancelled`, variant, '[data-audit-export]')
        expect(
          await page.evaluate(() =>
            document.querySelector('[data-audit-export] [role=status]')?.textContent
          ),
        ).toBe('Export stopped.')
        server.setResponseStatus(endpoint, 500)
        await click(page, 'Export CSV')
        await capture(page, `${prefix}-export-error`, variant, '[data-audit-export] [role=alert]')
        server.setResponseStatus(endpoint, null)
        await page.evaluate(() => {
          HTMLAnchorElement.prototype.click = function () {}
        })
        await click(page, 'Export JSON')
        await page.waitForSelector('[data-audit-export-result]')
        await capture(page, `${prefix}-export-complete`, variant, '[data-audit-export-result]')
      }
      console.log(`Captured interactive states: ${variant.scheme} ${variant.width} ${variant.font}`)
    }
  } catch (error) {
    await Deno.writeTextFile(
      `${logs}/state-failure.txt`,
      String(error) + '\n' + await page.evaluate(() => document.body.innerText),
    )
    throw error
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

test('visual operation states keep typed questions editable and retire extraction and enrichment work', async () => {
  if (Deno.env.get('RBAC_VISUAL_SURFACES') || Deno.env.get('RBAC_VISUAL_GROUP') === 'states') return
  const server = startTestServer({ identity: { role: 'owner' }, management: visualManagement() })
  const browser = await launch()
  const page = await browser.newPage(server.url)
  try {
    for (const variant of matrix) {
      await appearance(page, server, variant, '/t/marine/ask')
      await (await page.waitForSelector('#ask-composer')).click()
      await page.keyboard.type('How do marine heatwaves affect abalone populations?')
      await page.keyboard.down('Shift')
      await page.keyboard.press('Enter')
      await page.keyboard.up('Shift')
      await page.keyboard.type('Compare the evidence across southern waters.')
      const draft = await page.evaluate(() => {
        const field = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
        return {
          value: field.value,
          caret: field.selectionStart,
          focused: field === document.activeElement,
          scroll: field.scrollTop,
          height: field.clientHeight,
          total: field.scrollHeight,
        }
      })
      expect(draft.value).toContain('\nCompare the evidence')
      expect(draft.caret).toBe(draft.value.length)
      expect(draft.focused).toBe(true)
      if (draft.total > draft.height + 1) expect(draft.scroll).toBeGreaterThan(0)
      await Deno.writeTextFile(
        `${logs}/ask-editing-${variant.scheme}-${variant.width}-${variant.font}.json`,
        JSON.stringify(draft, null, 2),
      )
      await capture(page, 'ask-multiline-editor', variant, '#ask-composer')
      await (await page.waitForSelector('#ask-composer')).click()
      await page.evaluate(() => {
        const field = document.querySelector<HTMLTextAreaElement>('#ask-composer')!
        field.select()
      })
      await page.keyboard.type('What affects abalone populations?')
      await page.keyboard.press('Enter')
      await page.waitForSelector('button[aria-label="Copy the answer"]')
      await capture(page, 'ask-answer-actions', variant, 'button[aria-label="Copy the answer"]')

      await appearance(page, server, variant, '/t/marine/manage?tab=extraction')
      await input(page, '[aria-label="Find a document"]', 'Marine')
      await click(page, 'Marine heatwave impacts on rock lobster')
      const comparison = server.delayResponse('/api/admin/t/marine/extraction/compare')
      await click(page, 'Run comparison')
      await requestStarted(comparison.entered, 'Comparison')
      await capture(page, 'extraction-pending', variant, 'text:Running')
      await click(page, 'Overview')
      await page.waitForSelector('[data-manage-counts]')
      comparison.release()
      expect(await page.evaluate(() => document.body.innerText.includes('Judge score'))).toBe(false)
      await capture(page, 'extraction-navigation-cancelled', variant, 'h1')

      await appearance(page, server, variant, '/t/marine/manage?tab=enrichments')
      const enrichment = server.delayResponse('/api/admin/t/marine/enrichments/run')
      await click(page, 'Generate missing')
      await requestStarted(enrichment.entered, 'Enrichment')
      await capture(page, 'enrichment-pending', variant, '[data-enrichment-run]')
      await click(page, 'Overview')
      await page.waitForSelector('[data-manage-counts]')
      enrichment.release()
      expect(await page.$('[data-enrichment-run]')).toBeNull()
      await capture(page, 'enrichment-navigation-cancelled', variant, 'h1')
      console.log(`Captured operation states: ${variant.scheme} ${variant.width} ${variant.font}`)
    }
  } catch (error) {
    await Deno.writeTextFile(
      `${logs}/operations-failure.txt`,
      String(error) + '\n' + await page.evaluate(() => document.body.innerText),
    )
    throw error
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
