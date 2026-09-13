import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary,
  sourcePath,
} from './support/rbac-fixture.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import { createAuditEvent } from '../apps/api/src/audit.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { BrandingSchema } from '@research-portal/core'
import { googleFontsUrl, tenantThemeVars } from '../apps/web/src/lib/theme.ts'

const logs = Deno.env.get('RBAC_AUDIT_LOG_ROOT') ?? '.planning/logs/04-16-01'
const routeLogs = Deno.env.get('RBAC_AUDIT_LOG_ROOT') ?? '.planning/logs/04-16-02'
const source = `
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {BrowserRouter} from 'react-router-dom'
import {BrandingSchema} from '@research-portal/core'
import {AccessProvider} from '${sourcePath('apps/web/src/components/AccessProvider.tsx')}'
import {AuditPanel} from '${sourcePath('apps/web/src/pages/admin/AuditPanel.tsx')}'
import {tenantThemeVars,useBodyTheme,useTenantFonts} from '${
  sourcePath('apps/web/src/lib/theme.ts')
}'
const params=new URLSearchParams(location.search), platform=params.has('platform'),dark=params.has('dark')
const scope=Object.freeze(platform?{kind:'platform'}:{kind:'portal',slug:'marine'})
function Fixture(){const branding=BrandingSchema.parse({productName:'Marine research',organisation:'Research',tagline:'Research',colours:{primary:'#17372d',accent:'#e0ba63',heroFrom:'#17372d',heroTo:'#234f45'},paletteId:dark?'observatory':'default',shape:dark?'soft':'square',density:'spacious',typography:'lexend-zilla'});useBodyTheme(branding);useTenantFonts(branding);return <div className='rp-tenant min-h-screen bg-app text-ink' style={tenantThemeVars(branding)}><header className='border-b border-line bg-surface p-6'>CorpusKit</header><main className='rp-shell py-6'><h1 className='rp-display text-2xl'>Audit records</h1><div className='mt-6'><AuditPanel scope={scope} name='Marine research'/></div></main></div>}
createRoot(document.getElementById('root')).render(<StrictMode><BrowserRouter><AccessProvider slug={platform?null:'marine'}><Fixture/></AccessProvider></BrowserRouter></StrictMode>)
`
function seed(directory: string) {
  const db = openLocalRbac({ DATA_DIR: directory })
  for (const slug of ['marine', 'grains']) {
    for (let i = 0; i < 30; i++) {
      db.rbac.audit.append(createAuditEvent({
        requestId: `request-${slug}-${String(i).padStart(3, '0')}-${'x'.repeat(120)}`,
        actor: { kind: 'system' },
        action: 'maintenance.run',
        scope: { kind: 'portal', slug },
        target: { kind: 'portal', id: slug },
        outcome: 'success',
        detail: { count: i, secret: 'discarded' },
      }, () => Date.UTC(2026, 8, 12, 0, 0, i)))
    }
  }
  db.rbac.audit.append(
    createAuditEvent({
      requestId: 'platform-event',
      actor: { kind: 'system' },
      action: 'maintenance.run',
      scope: { kind: 'platform' },
      target: { kind: 'platform' },
      outcome: 'success',
      detail: { count: 1 },
    }, () => Date.UTC(2026, 8, 12)),
  )
  return db
}
async function click(page: Page, text: string) {
  await page.evaluate((text) => {
    const el = [...document.querySelectorAll<HTMLElement>('button,a,summary')].find((el) =>
      el.textContent?.trim() === text && el.getBoundingClientRect().width > 0
    )
    if (!el) throw new Error(`Missing ${text}`)
    el.focus()
    el.click()
  }, { args: [text] })
}
async function input(page: Page, label: string, value: string) {
  await page.evaluate((label, value) => {
    const el = document.querySelector(`[aria-label="${label}"]`)! as HTMLInputElement
    Object.getOwnPropertyDescriptor(
      el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }, { args: [label, value] })
}
async function ready(page: Page) {
  await page.waitForSelector('[data-audit-results]')
}
async function capture(page: Page, name: string, width: number, target = '[data-audit-results]') {
  if (target === '[data-audit-results]') target = '[data-audit-results] [role=status]'
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async (target) => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
    document.querySelector(target)!.scrollIntoView({ block: 'start' })
  }, { args: [target] })
  await captureBoundary(page, logs, name, width)
  expect(
    await page.evaluate((target) => {
      const r = document.querySelector(target)!.getBoundingClientRect()
      return r.top >= 0 && r.top < innerHeight
    }, { args: [target] }),
  ).toBe(true)
  const tokens = await page.evaluate(() => {
    const el = document.querySelector('.rp-input')!
    const css = getComputedStyle(el)
    const surface = document.querySelector('.rp-tenant') ?? document.body
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:absolute;visibility:hidden;border-radius:var(--rp-radius-input);color:var(--rp-ink);height:calc(2.25rem * var(--rp-density-ctl,1))'
    surface.append(probe)
    const expected = getComputedStyle(probe)
    const colour = expected.color, radius = expected.borderRadius, controlHeight = expected.height
    probe.remove()
    return {
      radius: css.borderRadius,
      expected: radius,
      colour: css.color,
      expectedColour: colour,
      buttonHeight: getComputedStyle(document.querySelector('button[type=submit]')!).height,
      controlHeight,
      font: css.fontFamily,
      height: css.height,
      density: getComputedStyle(surface).getPropertyValue('--rp-density'),
    }
  })
  await Deno.writeTextFile(`${logs}/${name}-tokens.json`, JSON.stringify(tokens, null, 2))
  expect(tokens.font.toLowerCase()).toContain('zilla slab')
  expect(tokens.radius).toBe(tokens.expected.trim())
  expect(tokens.colour).toBe(tokens.expectedColour)
  expect(Math.abs(parseFloat(tokens.buttonHeight) - parseFloat(tokens.controlHeight))).toBeLessThan(
    1,
  )
}

Deno.test('audit component reads real scoped events, filters, snapshots and failure clearing', async () => {
  const fixture = await buildComponentFixture({ entrySource: source }),
    server = startTestServer({ componentFixture: fixture, identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    await page.bringToFront()
    await ready(page)
    await assertCurrentBuild(page)
    await input(page, 'Action', 'maintenance.run')
    await input(page, 'Events per page', '25')
    await click(page, 'Apply filters')
    await ready(page)
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .not.toContain('grains')
    const first = server.requests.filter((r) => r.path.includes('/audit?')).at(-1)!.path
    expect(first).toContain('limit=25')
    expect(first).not.toContain('cursor=')
    await click(page, 'Next events page')
    await ready(page)
    expect(server.requests.filter((r) => r.path.includes('/audit?')).at(-1)!.path).toContain(
      'cursor=',
    )
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-audit-results] [role=status]')!.textContent
      ),
    ).toContain('5 events')
    await click(page, 'Apply filters')
    await ready(page)
    db.database.exec('UPDATE audit_query_snapshots SET expires_at = 0')
    await click(page, 'Next events page')
    await page.waitForSelector('[role=alert]')
    expect(await page.$('[data-audit-results]')).toBeNull()
    await click(page, 'Restart events')
    await ready(page)
    server.setResponseStatus('/api/admin/t/marine/audit', 500)
    await click(page, 'Apply filters')
    await page.waitForSelector('[role=alert]')
    expect(await page.$('[data-audit-results]')).toBeNull()
    server.setResponseStatus('/api/admin/t/marine/audit', null)
    await click(page, 'Try again')
    await ready(page)
    await input(page, 'From (UTC)', 'invalid')
    await click(page, 'Apply filters')
    expect(await page.$('[data-audit-results]')).toBeNull()
    await page.waitForSelector('[role=alert]')
    await click(page, 'Clear filters')
    await ready(page)
    expect(
      await page.evaluate(async () =>
        (await fetch('/api/admin/t/marine/audit?scope=grains')).status
      ),
    ).toBe(400)
    for (const status of [400, 429]) {
      server.setResponseStatus('/api/admin/t/marine/audit', status)
      await click(page, 'Apply filters')
      await page.waitForSelector('[role=alert]')
      const count = server.requests.filter((r) => r.path.includes('/audit?')).length
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(count)
      expect(await page.$('[data-audit-results]')).toBeNull()
      server.setResponseStatus('/api/admin/t/marine/audit', null)
      await click(page, 'Try again')
      await ready(page)
    }
    // A presentation-only hostile detail double still starts with the real signed read.
    // The server redaction contract is checked separately above and by route tests.
    await page.evaluate(() => {
      const original = globalThis.fetch
      let first = true
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (!first || !String(input).startsWith('/api/admin/t/marine/audit')) return response
        first = false
        const value = await response.json()
        value.items[0].detail_json = JSON.stringify({ text: '<img src=x onerror=alert(1)>' })
        return Response.json(value)
      }
    })
    await click(page, 'Apply filters')
    await ready(page)
    await click(page, 'Event details')
    expect(await page.evaluate(() => document.querySelector('details[open] pre')?.textContent))
      .toContain('<img src=x onerror=alert(1)>')
    expect(await page.$('details img')).toBeNull()
    for (const platform of [false, true]) {
      for (const dark of [false, true]) {
        await page.goto(
          `${server.url}/__test/rbac-component?${platform ? 'platform&' : ''}${dark ? 'dark' : ''}`,
        )
        await ready(page)
        await input(page, 'Action', 'maintenance.run')
        await click(page, 'Apply filters')
        await ready(page)
        const text = await page.evaluate(() =>
          document.querySelector('[data-audit-results]')!.textContent
        )
        expect(text?.includes('grains')).toBe(platform)
        expect(text).not.toContain('discarded')
        for (const width of [1440, 390]) {
          await capture(
            page,
            `${platform ? 'platform' : 'portal'}-${dark ? 'dark' : 'light'}-${width}-filters`,
            width,
            '[aria-label="Audit filters"]',
          )
          await capture(
            page,
            `${platform ? 'platform' : 'portal'}-${dark ? 'dark' : 'light'}-${width}-events`,
            width,
          )
          await click(page, 'Event details')
          await capture(
            page,
            `${platform ? 'platform' : 'portal'}-${dark ? 'dark' : 'light'}-${width}-detail`,
            width,
            'details[open]',
          )
          await click(page, 'Event details')
        }
      }
    }
    await page.goto(`${server.url}/__test/rbac-component`)
    await ready(page)
    await input(page, 'Request ID', 'no-matching-event')
    await click(page, 'Apply filters')
    await ready(page)
    expect(await page.evaluate(() => document.body.textContent)).toContain(
      'No events match these filters',
    )
    await capture(page, 'empty', 390)
    // An old request may complete after a newer A -> B -> A filter selection.
    await input(page, 'Request ID', '')
    await page.evaluate(() => {
      const original = globalThis.fetch
      let first = true
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (first && String(input).startsWith('/api/admin/t/marine/audit')) {
          first = false
          await new Promise<void>((resolve) => {
            Object.assign(globalThis, { releaseAudit: resolve })
          })
        }
        return response
      }
    })
    await click(page, 'Apply filters')
    await page.waitForFunction(() => 'releaseAudit' in globalThis)
    db.rbac.audit.append(
      createAuditEvent({
        requestId: 'newer-filter-event',
        actor: { kind: 'system' },
        action: 'maintenance.run',
        scope: { kind: 'portal', slug: 'marine' },
        target: { kind: 'portal', id: 'marine' },
        outcome: 'success',
        detail: { count: 999 },
      }),
    )
    await input(page, 'Request ID', 'no-matching-event')
    await click(page, 'Apply filters')
    await input(page, 'Request ID', '')
    await click(page, 'Apply filters')
    await ready(page)
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .toContain('newer-filter-event')
    await page.evaluate(() => {
      ;(globalThis as unknown as { releaseAudit: () => void }).releaseAudit()
    })
    await page.evaluate(() => new Promise((r) => setTimeout(r, 100)))
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .toContain('newer-filter-event')
    await click(page, 'Event details')
    const losing = server.delayResponse('/api/admin/t/marine/audit')
    await click(page, 'Apply filters')
    await losing.entered
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('[data-audit-reader]'))
    losing.release()
    expect(await page.$('details[open]')).toBeNull()
    const before = server.requests.filter((r) => r.path.includes('/audit?')).length
    await page.goto(`${server.url}/__test/rbac-component`)
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Audit records')
    await page.evaluate(() => new Promise((r) => setTimeout(r, 150)))
    expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(before)
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('audit production navigation mounts immutable portal and platform scopes', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/admin`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[aria-label="Platform administration"]')
    expect(await page.$('[aria-label="Platform administration"] a[href="/admin/audit"]'))
      .not.toBeNull()
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('a[href="/admin/audit"]')!.focus()
    )
    await page.keyboard.press('Enter')
    await ready(page)
    await assertCurrentBuild(page)
    await page.evaluate(() => {
      const summary = [...document.querySelectorAll<HTMLElement>('summary')].find((el) =>
        el.getBoundingClientRect().width > 0
      )!
      summary.focus()
    })
    await page.keyboard.press('Enter')
    expect(await page.$('details[open]')).not.toBeNull()
    await page.keyboard.press('Enter')
    expect(await page.$('details[open]')).toBeNull()
    expect(server.requests.some((r) => r.path.startsWith('/api/admin/audit?'))).toBe(true)
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .toContain('grains')
    await page.goto(`${server.url}/t/marine/manage?tab=audit`)
    await ready(page)
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-manage-tab=audit]')?.getAttribute('aria-current')
      ),
    ).toBe('true')
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .not.toContain('grains')
    for (const platform of [false, true]) {
      for (const dark of [false, true]) {
        server.tenants.patchBranding('marine', {
          paletteId: dark ? 'observatory' : 'default',
          shape: dark ? 'soft' : 'square',
          density: 'spacious',
          typography: 'lexend-zilla',
        })
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [dark ? 'dark' : 'light'],
        })
        await page.goto(`${server.url}${platform ? '/admin/audit' : '/t/marine/manage?tab=audit'}`)
        await ready(page)
        if (platform) await platformTheme(page, dark)
        for (const width of [1440, 390]) {
          const name = `${platform ? 'platform' : 'portal'}-${dark ? 'dark' : 'light'}-${width}`
          await routeCapture(page, `${name}-chrome`, width, 'h1')
          await routeCapture(page, `${name}-filters`, width, '[aria-label="Audit filters"]')
          await routeCapture(page, `${name}-events`, width, '[data-audit-results] [role=status]')
          await click(page, 'Event details')
          await routeCapture(page, `${name}-details`, width, 'details[open]')
          await click(page, 'Event details')
          await input(page, 'Request ID', 'no-matching-event')
          await click(page, 'Apply filters')
          await ready(page)
          await routeCapture(page, `${name}-empty`, width, '[data-audit-results]')
          const path = platform ? '/api/admin/audit' : '/api/admin/t/marine/audit'
          const held = server.delayResponse(path)
          await click(page, 'Clear filters')
          await held.entered
          await routeCapture(page, `${name}-loading`, width, '[data-audit-reader] [role=status]')
          held.release()
          await ready(page)
          server.setResponseStatus(path, 500)
          await click(page, 'Apply filters')
          await page.waitForSelector('[data-audit-reader] [role=alert]')
          await routeCapture(page, `${name}-error`, width, '[data-audit-reader] [role=alert]')
          server.setResponseStatus(path, null)
          await click(page, 'Try again')
          await ready(page)
        }
      }
    }
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
  }
})

async function platformTheme(page: Page, dark: boolean) {
  const branding = BrandingSchema.parse({
    productName: 'CorpusKit',
    organisation: 'Research platform',
    tagline: 'Research access',
    colours: { primary: '#193a50', accent: '#66b7d0', heroFrom: '#193a50', heroTo: '#193a50' },
    paletteId: dark ? 'observatory' : 'default',
    shape: dark ? 'soft' : 'square',
    density: 'spacious',
    typography: 'lexend-zilla',
  })
  // Apply the existing appearance contract as fixture configuration to the neutral platform shell.
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
async function routeCapture(page: Page, name: string, width: number, selector: string) {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async (selector) => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
    if (selector === 'h1') scrollTo(0, 0)
    else {
      const target = document.querySelector(selector)!.getBoundingClientRect()
      const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
      scrollTo(0, Math.max(0, scrollY + target.top - header - 24))
    }
  }, { args: [selector] })
  await captureBoundary(page, routeLogs, name, width)
  expect(
    await page.evaluate((selector) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return r.top >= 0 && r.top < innerHeight
    }, { args: [selector] }),
  ).toBe(true)
}

Deno.test('audit navigation keeps read and export independent without speculative event requests', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/admin/audit`)
  try {
    await page.bringToFront()
    await ready(page)
    await click(page, 'Event details')
    // A reduced permission snapshot tests independent grants without inventing a D1 role.
    await page.evaluate(() => {
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (!String(input).startsWith('/auth/me')) return response
        const value = await response.json()
        value.platformPermissions = value.platformPermissions.filter((p: string) =>
          p === 'audit.export'
        )
        if (value.portalAccess) {
          value.portalAccess.permissions = value.portalAccess.permissions.filter((p: string) =>
            p === 'portal.read' || p === 'audit.export'
          )
        }
        return Response.json(value)
      }
    })
    const count = server.requests.filter((r) => r.path.includes('/audit?')).length
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-audit-export-only]')
    expect(await page.$('details[open]')).toBeNull()
    expect(await page.$('[data-audit-reader]')).toBeNull()
    expect(await page.$('[aria-label="Platform administration"] a[href="/admin/audit"]')).not
      .toBeNull()
    await navigate(page, '/t/marine/manage?tab=audit')
    await page.waitForSelector('[data-audit-export-only]')
    expect(await page.$('[data-manage-tab=audit][aria-current=true]')).not.toBeNull()
    expect(await page.$('[data-audit-reader]')).toBeNull()
    expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(count)
    await navigate(page, '/admin/audit')
    await page.waitForSelector('[data-audit-export-only]')
    expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(count)
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
  }
})
async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState({}, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [path] })
}

Deno.test('audit scope and identity transitions discard rows, details and late pages', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/t/marine/manage?tab=audit`)
  try {
    await page.bringToFront()
    await ready(page)
    await click(page, 'Event details')
    await navigate(page, '/t/grains/manage?tab=audit')
    await ready(page)
    expect(await page.$('details[open]')).toBeNull()
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .not.toContain('request-marine')
    await input(page, 'Action', 'maintenance.run')
    await input(page, 'Events per page', '25')
    await click(page, 'Apply filters')
    await ready(page)
    await click(page, 'Event details')
    const held = server.delayResponse('/api/admin/t/grains/audit')
    await click(page, 'Next events page')
    await held.entered
    expect(await page.$('details[open]')).toBeNull()
    server.setIdentity(fixtureSession({ oid: 'portal-only' }))
    server.setAssignment({ kind: 'portal', slug: 'marine' }, 'portal-only', 'portal-admin')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('[data-audit-panel]'))
    held.release()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(await page.$('[data-audit-results]')).toBeNull()
    const count = server.requests.filter((r) => r.path.startsWith('/api/admin/audit?')).length
    await navigate(page, '/admin/audit')
    await page.waitForSelector('[data-audit-unavailable]')
    expect(await page.$('[aria-label="Platform administration"] a[href="/admin/audit"]')).toBeNull()
    expect(server.requests.filter((r) => r.path.startsWith('/api/admin/audit?')).length).toBe(count)
    await navigate(page, '/t/marine/manage?tab=audit')
    await ready(page)
    expect(await page.$('[data-manage-tab=audit][aria-current=true]')).not.toBeNull()
    expect(await page.evaluate(() => document.querySelector('[data-audit-results]')!.textContent))
      .not.toContain('request-grains')
    server.setAssignment({ kind: 'portal', slug: 'marine' }, 'portal-only', 'viewer')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('[data-audit-panel]'))
    expect(await page.$('[data-audit-results]')).toBeNull()
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
  }
})
