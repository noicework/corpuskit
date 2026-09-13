import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import { createAuditEvent } from '../apps/api/src/audit.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { BrandingSchema } from '@research-portal/core'
import { googleFontsUrl, tenantThemeVars } from '../apps/web/src/lib/theme.ts'

const logs = '.planning/logs/04-17-02'
function seed(directory: string) {
  const db = openLocalRbac({ DATA_DIR: directory })
  for (const slug of ['marine', 'grains']) {
    for (let i = 0; i < 30; i++) {
      db.rbac.audit.append(createAuditEvent({
        requestId: `export-${slug}-${i}`,
        actor: { kind: 'user', id: 'export-subject', label: '@formula' },
        action: 'maintenance.run',
        scope: { kind: 'portal', slug },
        target: { kind: 'portal', id: slug },
        outcome: 'success',
        detail: { count: i },
      }, () => Date.UTC(2026, 8, 12, 0, 0, i)))
    }
  }
  return db
}
async function click(page: Page, text: string) {
  await page.evaluate((text) => {
    const el = [...document.querySelectorAll<HTMLElement>('button')].find((el) =>
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
async function sinks(page: Page) {
  await page.evaluate(() => {
    const calls: { created: number; clicked: number; revoked: number; files: string[] } = {
      created: 0,
      clicked: 0,
      revoked: 0,
      files: [],
    }
    Object.assign(globalThis, { auditSinks: calls })
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL,
      click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (blob) => {
      calls.created++
      return create(blob)
    }
    URL.revokeObjectURL = (url) => {
      calls.revoked++
      revoke(url)
    }
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        calls.clicked++
        calls.files.push(this.download)
        return
      }
      click.call(this)
    }
  })
}
const counts = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as {
      auditSinks: { created: number; clicked: number; revoked: number; files: string[] }
    }).auditSinks
  )
const completed = (page: Page) => page.waitForSelector('[data-audit-export-result]')
async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState({}, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, { args: [path] })
}
async function capture(page: Page, name: string, width: number, target = '[data-audit-export]') {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async (target) => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
    if (target === 'h1') scrollTo(0, 0)
    else {
      const rect = document.querySelector(target)!.getBoundingClientRect(),
        header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
      scrollTo(0, Math.max(0, scrollY + rect.top - header - 24))
    }
  }, { args: [target] })
  await captureBoundary(page, logs, name, width)
}
Deno.test('audit exports use independent grants, truthful pages and no unauthorised requests', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/admin/audit`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-audit-results]')
    await assertCurrentBuild(page)
    await sinks(page)
    await page.evaluate(() => {
      Object.assign(globalThis, { removedAuditPermission: 'audit.export' })
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (!String(input).startsWith('/auth/me')) return response
        const value = await response.json(),
          remove =
            (globalThis as unknown as { removedAuditPermission: string }).removedAuditPermission
        value.platformPermissions = value.platformPermissions.filter((p: string) => p !== remove)
        if (value.portalAccess) {
          value.portalAccess.permissions = value.portalAccess.permissions.filter((p: string) =>
            p !== remove
          )
        }
        return Response.json(value)
      }
    })
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-audit-results]')
    expect(await page.$('[data-audit-export]')).toBeNull()
    expect(server.requests.some((r) => r.path.includes('/audit/export'))).toBe(false)
    const reads = server.requests.filter((r) => r.path.includes('/audit?')).length
    await page.evaluate(() => {
      Object.assign(globalThis, { removedAuditPermission: 'audit.read' })
      dispatchEvent(new Event('focus'))
    })
    await page.waitForSelector('[data-audit-export-only]')
    await page.waitForSelector('[data-audit-export]')
    expect(await page.$('[data-audit-reader]')).toBeNull()
    expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(reads)
    await input(page, 'Actor ID', 'export-subject')
    await input(page, 'Events per page', '25')
    await click(page, 'Apply filters')
    await click(page, 'Export CSV')
    await completed(page)
    expect(
      await page.evaluate(() => document.querySelector('[data-audit-export-result]')!.textContent),
    ).toContain('Partial')
    await click(page, 'Export next CSV page')
    await completed(page)
    expect((await counts(page)).clicked).toBe(2)
    await click(page, 'Export JSON')
    await completed(page)
    expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(reads)
    expect((await counts(page)).files).toEqual([
      'audit-platform-partial.csv',
      'audit-platform-partial.csv',
      'audit-platform-partial.json',
    ])
    await click(page, 'Export next JSON page')
    await completed(page)
    await click(page, 'Export next JSON page')
    await completed(page)
    expect(
      await page.evaluate(() => document.querySelector('[data-audit-export-result]')!.textContent),
    ).toContain('Complete')
    expect((await counts(page)).revoked).toBe((await counts(page)).created)
    await navigate(page, '/t/marine/manage?tab=audit')
    await page.waitForSelector('[data-audit-export-only]')
    expect(await page.$('[data-audit-reader]')).toBeNull()
    expect(server.requests.filter((r) => r.path.includes('/audit?')).length).toBe(reads)
    await click(page, 'Export CSV')
    await completed(page)
    expect((await counts(page)).files.at(-1)).toBe('audit-marine-complete.csv')
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
  }
})
Deno.test('audit export stopped during body parsing and real server denial never publish a file', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/t/marine/manage?tab=audit`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-audit-export]')
    await sinks(page)
    await page.evaluate(() => {
      const original = globalThis.fetch
      let first = true
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (!first || !String(input).startsWith('/api/admin/t/marine/audit/export')) return response
        first = false
        const bytes = new Uint8Array(await response.arrayBuffer())
        let cancelled = false
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, 20))
            Object.assign(globalThis, {
              releaseExportBody: () => {
                if (!cancelled) {
                  controller.enqueue(bytes.slice(20))
                  controller.close()
                }
              },
            })
          },
          pull() {
            Object.assign(globalThis, { exportBodyReading: true })
          },
          cancel() {
            cancelled = true
          },
        })
        return new Response(stream, { status: response.status, headers: response.headers })
      }
    })
    await click(page, 'Export JSON')
    await page.waitForFunction(() => 'exportBodyReading' in globalThis)
    await click(page, 'Stop export')
    await page.evaluate(() => {
      ;(globalThis as unknown as { releaseExportBody: () => void }).releaseExportBody()
    })
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect((await counts(page)).clicked).toBe(0)
    expect(await page.evaluate(() => document.querySelector('[data-audit-export]')!.textContent))
      .toContain('Export stopped.')
    // The backend loses the signed owner's identity while the browser still displays its previous snapshot.
    server.setIdentity(fixtureSession({ oid: 'viewer' }))
    await click(page, 'Export CSV')
    await page.waitForFunction(() => !document.querySelector('[data-audit-export]'))
    expect((await counts(page)).created).toBe(0)
    expect((await counts(page)).clicked).toBe(0)
    expect(
      db.rbac.audit.read({ scope: { kind: 'portal', slug: 'marine' }, action: 'request.denied' })
        .length,
    ).toBeGreaterThan(0)
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
  }
})
Deno.test('audit export cancellation, changed filters, expired and failed continuations discard late files', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/t/marine/manage?tab=audit`)
  const path = '/api/admin/t/marine/audit/export'
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-audit-export]')
    await sinks(page)
    await input(page, 'Actor ID', 'export-subject')
    await input(page, 'Events per page', '25')
    await click(page, 'Apply filters')
    await click(page, 'Export JSON')
    await completed(page)
    expect((await counts(page)).clicked).toBe(1)
    db.database.exec('UPDATE audit_query_snapshots SET expires_at = 0')
    await click(page, 'Export next JSON page')
    await page.waitForSelector('[data-audit-export] [role=alert]')
    expect(await page.$('[data-audit-export-result]')).toBeNull()
    expect((await counts(page)).clicked).toBe(1)
    await click(page, 'Restart export')
    await completed(page)
    for (const status of [500, 429]) {
      const before = (await counts(page)).clicked
      server.setResponseStatus(path, status)
      await click(page, 'Export next JSON page')
      await page.waitForSelector('[data-audit-export] [role=alert]')
      expect((await counts(page)).clicked).toBe(before)
      expect(await page.$('[data-audit-export-result]')).toBeNull()
      server.setResponseStatus(path, null)
      await click(page, 'Restart export')
      await completed(page)
    }
    for (const mode of ['stop', 'filter', 'scope', 'identity']) {
      const before = (await counts(page)).clicked, held = server.delayResponse(path)
      await click(page, 'Export CSV')
      await held.entered
      if (mode === 'stop') await click(page, 'Stop export')
      if (mode === 'filter') await input(page, 'Request ID', 'changed-filter')
      if (mode === 'scope') {
        await navigate(page, '/admin/audit')
        await page.waitForSelector('[data-platform-audit]')
      }
      if (mode === 'identity') {
        server.setIdentity(fixtureSession({ oid: 'viewer' }))
        await page.evaluate(() => dispatchEvent(new Event('focus')))
        await page.waitForFunction(() => !document.querySelector('[data-audit-export]'))
      }
      held.release()
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 120)))
      expect((await counts(page)).clicked).toBe(before)
      expect(await page.$('[data-audit-export-result]')).toBeNull()
      if (mode === 'scope') {
        await navigate(page, '/t/marine/manage?tab=audit')
        await page.waitForSelector('[data-audit-export]')
      }
    }
    expect((await counts(page)).created).toBe((await counts(page)).revoked)
  } finally {
    db.database.close()
    await page.close()
    await browser.close()
    await server.close()
  }
})
Deno.test('audit export states retain both scope chrome at light dark wide and 390px with large text', async () => {
  const server = startTestServer({ identity: { role: 'owner' } }),
    db = seed(server.directory),
    browser = await launch(),
    page = await browser.newPage(`${server.url}/admin/audit`)
  try {
    await page.bringToFront()
    for (const platform of [false, true]) {
      for (const dark of [false, true]) {
        const branding = BrandingSchema.parse({
          productName: 'CorpusKit',
          organisation: 'Research platform',
          tagline: 'Research access',
          colours: {
            primary: '#193a50',
            accent: '#66b7d0',
            heroFrom: '#193a50',
            heroTo: '#193a50',
          },
          paletteId: dark ? 'observatory' : 'default',
          shape: dark ? 'soft' : 'square',
          density: 'spacious',
          typography: 'lexend-zilla',
        })
        server.tenants.patchBranding('marine', branding)
        await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), {
          args: [dark ? 'dark' : 'light'],
        })
        await page.goto(`${server.url}${platform ? '/admin/audit' : '/t/marine/manage?tab=audit'}`)
        await page.waitForSelector('[data-audit-export]')
        await assertCurrentBuild(page)
        await sinks(page)
        if (platform) {
          await page.evaluate((vars, url) => {
            document.body.classList.add('rp-tenant')
            for (const [key, value] of Object.entries(vars)) {
              document.body.style.setProperty(
                key === 'colorScheme' ? 'color-scheme' : key,
                String(value),
              )
            }
            const link = document.createElement('link')
            link.rel = 'stylesheet'
            link.href = url
            document.head.append(link)
          }, { args: [tenantThemeVars(branding), googleFontsUrl('lexend-zilla')] })
        }
        await input(page, 'Actor ID', 'export-subject')
        await input(page, 'Events per page', '25')
        await click(page, 'Apply filters')
        for (const width of [1440, 390]) {
          const name = `${platform ? 'platform' : 'portal'}-${dark ? 'dark' : 'light'}-${width}`
          await capture(page, `${name}-chrome`, width, 'h1')
          await click(page, 'Export CSV')
          await completed(page)
          await capture(page, `${name}-partial`, width)
          const path = platform ? '/api/admin/audit/export' : '/api/admin/t/marine/audit/export'
          const held = server.delayResponse(path)
          await click(page, 'Export next CSV page')
          await held.entered
          await capture(page, `${name}-pending`, width)
          await click(page, 'Stop export')
          held.release()
          await capture(page, `${name}-stopped`, width)
          await input(page, 'Actor ID', 'no-matching-actor')
          await click(page, 'Apply filters')
          await click(page, 'Export JSON')
          await completed(page)
          await capture(page, `${name}-complete`, width)
          server.setResponseStatus(path, 410)
          await click(page, 'Export JSON')
          await page.waitForSelector('[data-audit-export] [role=alert]')
          await capture(page, `${name}-expired`, width)
          server.setResponseStatus(path, null)
          await input(page, 'Actor ID', 'export-subject')
          await click(page, 'Apply filters')
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
