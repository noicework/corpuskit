import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary,
  sourcePath,
} from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'
import { AuthorityController } from '../apps/web/src/api/access-lifecycle.ts'

Deno.test('assignment notice generation matches exactly one complete signed refresh', async () => {
  const server = startTestServer({ apiOnly: true, identity: { role: 'portal-admin' } })
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => original(new URL(String(input), server.url), init)
  try {
    const controller = new AuthorityController(() => 'fixture-browser')
    await controller.refresh('marine')
    const origin = controller.context
    const pending = controller.refresh('marine')
    expect(controller.context.generation).toBe(origin.generation + 1)
    expect(controller.status).toBe('loading')
    await pending
    expect(controller.context.generation).toBe(origin.generation + 2)
    expect(controller.context.identityKey).toBe(origin.identityKey)
    await controller.refresh('grains')
    await controller.refresh('marine')
    expect(controller.context.generation).toBeGreaterThan(origin.generation + 2)
    server.setResponseStatus('/auth/me', 500)
    await expect(controller.refresh('marine')).rejects.toThrow('Access could not be checked')
    expect(controller.status).toBe('unavailable')
  } finally {
    globalThis.fetch = original
    await server.close()
  }
})

async function click(page: Page, text: string) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.trim() === text
    )
    if (!button) throw new Error(`Missing button ${text}`)
    button.focus()
    button.click()
  }, { args: [text] })
}
async function input(page: Page, selector: string, value: string) {
  await page.evaluate((selector, value) => {
    const element = document.querySelector(selector) as HTMLInputElement
    const prototype = element.tagName === 'SELECT'
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    )
  }, { args: [selector, value] })
}
async function rowAction(page: Page, subject: string, action: string) {
  await page.evaluate((subject, action) => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-assignment-id]')].find((r) =>
      r.querySelector('p')?.textContent === subject
    )
    const button = [...row!.querySelectorAll('button')].find((b) => b.textContent === action)!
    button.focus()
    button.click()
  }, { args: [subject, action] })
}
const memberLogs = Deno.env.get('RBAC_MEMBERS_LOG_ROOT') ?? '.planning/logs/04-12'

async function capture(
  page: Page,
  directory: string,
  name: string,
  width: number,
  selector: string,
) {
  await page.setViewportSize({ width, height: 960 })
  await page.evaluate(async (selector) => {
    document.documentElement.style.fontSize = '22px'
    await document.fonts.ready
    document.querySelector(selector)!.scrollIntoView({ block: 'center' })
  }, { args: [selector] })
  await captureBoundary(page, directory, name, width)
  expect(
    await page.evaluate((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect()
      return rect.top >= 0 && rect.top < innerHeight
    }, { args: [selector] }),
  ).toBe(true)
}
const componentSource = `
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BrandingSchema, PORTAL_ROLES, PLATFORM_ROLES } from '@research-portal/core'
import { AccessProvider, useAccess } from '${
  sourcePath('apps/web/src/components/AccessProvider.tsx')
}'
import { AssignmentEditor } from '${sourcePath('apps/web/src/components/AssignmentEditor.tsx')}'
import { listAssignments, createAssignment, changeAssignment, removeAssignment, AssignmentError } from '${
  sourcePath('apps/web/src/api/access.ts')
}'
import { tenantThemeVars, useBodyTheme, useTenantFonts } from '${
  sourcePath('apps/web/src/lib/theme.ts')
}'
const platform = new URLSearchParams(location.search).has('platform')
const scope = platform ? {kind:'platform'} : {kind:'portal',slug:'marine'}
function Fixture() {
 const access = useAccess()
 const branding = BrandingSchema.parse({ productName:'Marine research', organisation:'Research', tagline:'Research access', colours:{ primary:'#17372d',accent:'#e0ba63',heroFrom:'#17372d',heroTo:'#234f45'}, paletteId:new URLSearchParams(location.search).get('palette') === 'dark' ? 'observatory' : 'default', shape:'soft', density:'spacious', typography:'lexend-zilla'})
 useBodyTheme(branding); useTenantFonts(branding)
 const options = {authority:access.controller,context:access.controller.context}
 const allowed = access.can(platform ? 'platform.members.manage':'members.manage',scope)
 const rows = useQuery({queryKey:['fixture-members'],queryFn:({signal})=>listAssignments(scope,'members',{...options,signal}),enabled:allowed})
 async function mutate(fn) { try {await fn()} catch(e) {if(e instanceof AssignmentError && e.correctable) throw e; if(access.controller.context === options.context) await access.refresh(); throw e} if(access.controller.context === options.context) await access.refresh() }
 return <div className='rp-tenant min-h-screen bg-app text-ink' style={tenantThemeVars(branding)}><header className='border-b border-line bg-surface p-6'>CorpusKit</header><main className='rp-shell py-6'><h1 className='rp-display text-2xl'>${'Local access'}</h1><section className='rp-card mt-6 min-w-0 p-6'><h2 className='rp-display mb-4 text-xl'>Members</h2>{allowed && rows.data ? <AssignmentEditor scope={scope} scopeName={platform ? 'Platform' : 'Marine research'} family='members' roles={platform ? PLATFORM_ROLES:PORTAL_ROLES} items={rows.data.items} onCreate={(value)=>mutate(()=>createAssignment(scope,'members',value,options))} onChange={(id,role)=>mutate(()=>changeAssignment(scope,'members',id,role,options))} onRemove={(id)=>mutate(()=>removeAssignment(scope,'members',id,options))}/> : <p>Checking access...</p>}</section></main></div>
}
createRoot(document.getElementById('root')).render(<StrictMode><BrowserRouter><AccessProvider slug={platform ? null : 'marine'}><Fixture/></AccessProvider></BrowserRouter></StrictMode>)
`

Deno.test('member component uses signed assignment CRUD, conflict feedback and accessible confirmations', async () => {
  const fixture = await buildComponentFixture({ entrySource: componentSource })
  const server = startTestServer({ componentFixture: fixture, identity: { role: 'portal-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/__test/rbac-component`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-assignment-editor]')
    await assertCurrentBuild(page)
    await click(page, 'Add member')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLSelectElement>('[data-assignment-role]')!.value
      ),
    ).toBe('viewer')
    await input(page, '[data-assignment-subject]', 'new@example.test')
    await click(page, 'Add member')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-editor] form') &&
      document.body.textContent?.includes('new@example.test')
    )
    await rowAction(page, 'new@example.test', 'Edit role')
    await input(page, '[data-assignment-role]', 'analyst')
    await click(page, 'Save role')
    await page.waitForFunction(() => !document.querySelector('[data-assignment-editor] form'))
    await page.waitForSelector('[data-assignment-editor]')
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-assignment-id]')].find((r) =>
          r.textContent?.includes('new@example.test')
        )!.textContent
      ),
    ).toContain('Analyst')
    await click(page, 'Add member')
    await input(page, '[data-assignment-subject]', 'new@example.test')
    await click(page, 'Add member')
    await page.waitForSelector('[role=alert]')
    expect(await page.evaluate(() => document.querySelector('[role=alert]')!.textContent))
      .toContain('already has a local assignment')
    expect(server.requests.some((r) => r.method === 'POST' && r.status === 409)).toBe(true)
    expect(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-assignment-subject')),
    ).toBe(true)
    await click(page, 'Close member form')
    for (const scheme of ['light', 'dark']) {
      await page.goto(`${server.url}/__test/rbac-component?palette=${scheme}`)
      await page.bringToFront()
      await page.waitForSelector('[data-assignment-editor]')
      for (const width of [1440, 390]) {
        await capture(page, `${memberLogs}-01`, `members-${scheme}-${width}`, width, 'h2')
      }
      await click(page, 'Add member')
      await input(
        page,
        '[data-assignment-subject]',
        'a-long-pending-person-with-research-responsibilities@organisation.example.test',
      )
      for (const width of [1440, 390]) {
        await capture(page, `${memberLogs}-01`, `form-${scheme}-${width}`, width, 'form h3')
      }
      await click(page, 'Close member form')
      await rowAction(page, 'new@example.test', 'Remove member')
      await page.waitForSelector('dialog[open]')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Keep member')
      await page.keyboard.down('Shift')
      await page.keyboard.press('Tab')
      await page.keyboard.up('Shift')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Remove member')
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Keep member')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `${memberLogs}-01`,
          `confirm-${scheme}-${width}`,
          width,
          'dialog h2',
        )
      }
      const tokens = await page.evaluate(() => {
        const d = getComputedStyle(document.querySelector('dialog')!),
          body = getComputedStyle(document.body)
        return {
          radius: d.borderRadius,
          token: body.getPropertyValue('--rp-radius').trim(),
          colour: d.color,
          body: body.color,
        }
      })
      expect(tokens.radius).not.toBe('0px')
      expect(tokens.colour).toBe(tokens.body)
      await page.keyboard.press('Escape')
      expect(await page.$('dialog')).toBeNull()
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        'Remove member new@example.test',
      )
    }
    await rowAction(page, 'new@example.test', 'Remove member')
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('dialog button:last-child')!.click()
    )
    await page.waitForFunction(() => !document.body.textContent?.includes('new@example.test'))
    await page.waitForSelector('[data-assignment-editor]')
    expect(server.requests.filter((r) => r.method === 'DELETE').every((r) => r.status === 200))
      .toBe(true)
    expect(server.requests.some((r) => r.path.includes('/groups') || r.path.includes('/mcp/keys')))
      .toBe(false)
    server.setIdentity(fixtureSession({ oid: 'fixture-owner-one' }))
    server.setAssignment({ kind: 'platform' }, 'fixture-owner-two', null)
    await page.goto(`${server.url}/__test/rbac-component?platform=1`)
    await page.waitForSelector('[data-assignment-editor]')
    await click(page, 'Add platform member')
    expect(
      await page.evaluate(() =>
        document.querySelector<HTMLSelectElement>('[data-assignment-role]')!.value
      ),
    ).toBe('platform-admin')
    await click(page, 'Close member form')
    await rowAction(page, 'fixture-owner-one', 'Remove member')
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('dialog button:last-child')!.click()
    )
    await page.waitForSelector('dialog [role=alert]')
    expect(await page.evaluate(() => document.querySelector('dialog')!.textContent)).toContain(
      'final active owner',
    )
    expect(server.requests.some((r) => r.method === 'DELETE' && r.status === 409)).toBe(true)
  } finally {
    await page.close()
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('Manage Access scopes member CRUD and discards authority after self-downgrade', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-manage-shell]')
    expect(await page.$('[data-manage-tab=access]')).not.toBeNull()
    await page.waitForSelector('[data-assignment-editor]')
    await assertCurrentBuild(page)
    await click(page, 'Add member')
    await input(page, '[data-assignment-subject]', 'portal-pending@example.test')
    await click(page, 'Add member')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-editor] form') &&
      document.querySelector('[data-assignment-editor]')?.textContent?.includes(
        'portal-pending@example.test',
      )
    )
    await click(page, 'Add member')
    await input(page, 'form select', 'active-oid')
    await input(
      page,
      '[data-assignment-subject]',
      'researcher-with-a-very-long-object-id-for-layout-verification-and-independent-scope',
    )
    await click(page, 'Add member')
    await page.waitForFunction(() =>
      !document.querySelector('[data-assignment-editor] form') &&
      document.querySelector('[data-assignment-editor]')?.textContent?.includes(
        'researcher-with-a-very-long',
      )
    )
    for (const scheme of ['light', 'dark']) {
      server.tenants.patchBranding('marine', {
        paletteId: scheme === 'dark' ? 'observatory' : 'default',
        shape: scheme === 'dark' ? 'soft' : 'square',
        density: 'comfortable',
        typography: 'lexend-zilla',
      })
      await page.evaluate((scheme) => localStorage.setItem('rp-scheme', scheme), { args: [scheme] })
      await page.goto(`${server.url}/t/marine/manage?tab=access`)
      await page.waitForSelector('[data-assignment-editor]')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `${memberLogs}-02`,
          `access-${scheme}-${width}`,
          width,
          '[data-access-panel] h2',
        )
        expect(
          await page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="Manage sections"]')!
              .getBoundingClientRect()
            const active = document.querySelector('[data-manage-tab=access]')!
              .getBoundingClientRect()
            return active.left >= nav.left - 1 && active.right <= nav.right + 1
          }),
        ).toBe(true)
      }
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-assignment-id]')].find((row) =>
          row.textContent?.includes('researcher-with-a-very-long')
        )!
        row.setAttribute('data-fixture-long-identity', '')
      })
      for (const width of [1440, 390]) {
        await capture(
          page,
          `${memberLogs}-02`,
          `long-id-${scheme}-${width}`,
          width,
          '[data-fixture-long-identity] p',
        )
      }
      await rowAction(page, 'portal-pending@example.test', 'Edit role')
      for (const width of [1440, 390]) {
        await capture(page, `${memberLogs}-02`, `edit-${scheme}-${width}`, width, 'form h3')
      }
      await input(page, '[data-assignment-role]', 'analyst')
      await click(page, 'Save role')
      await page.waitForFunction(() =>
        !document.querySelector('[data-assignment-editor] form') &&
        !!document.querySelector('[data-assignment-editor]')
      )
      await rowAction(page, 'portal-pending@example.test', 'Remove member')
      for (const width of [1440, 390]) {
        await capture(
          page,
          `${memberLogs}-02`,
          `remove-${scheme}-${width}`,
          width,
          'dialog h2',
        )
      }
      await page.keyboard.press('Escape')
    }
    await rowAction(page, 'portal-pending@example.test', 'Remove member')
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('dialog button:last-child')!.click()
    )
    await page.waitForFunction(() =>
      !!document.querySelector('[data-assignment-editor]') &&
      !document.body.textContent?.includes('portal-pending@example.test')
    )
    await page.waitForFunction(() => document.activeElement?.tagName === 'H1')
    await rowAction(page, 'e2e-portal-admin', 'Edit role')
    await input(page, '[data-assignment-role]', 'viewer')
    const ownId = await page.evaluate(() =>
      [...document.querySelectorAll('[data-assignment-id]')].find((row) =>
        row.querySelector('p')?.textContent === 'e2e-portal-admin'
      )!.getAttribute('data-assignment-id')
    )
    const downgrade = server.delayResponse(`/api/admin/t/marine/members/${ownId}`)
    await click(page, 'Save role')
    await downgrade.entered
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[data-manage-tab=content]')!.click()
    )
    downgrade.release()
    await page.waitForFunction(() => !document.querySelector('[data-manage-shell]'))
    expect(await page.$('[data-assignment-editor]')).toBeNull()
    expect(await page.$('dialog')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'researcher-with-a-very-long',
    )
    expect(
      server.requests.filter((r) => r.path.includes('/groups')).every((r) =>
        r.method === 'GET' && r.status === 200
      ),
    ).toBe(true)
    expect(server.requests.some((r) => r.path.includes('/mcp/keys'))).toBe(false)
  } catch (error) {
    await Deno.writeTextFile(
      `${memberLogs}-02/failure.json`,
      JSON.stringify(
        {
          requests: server.requests,
          text: await page.evaluate(() => document.body.innerText),
        },
        null,
        2,
      ),
    )
    await Deno.writeFile(`${memberLogs}-02/failure.png`, await page.screenshot())
    throw error
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('Access has independent section permissions and no forbidden member reads', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-assignment-editor]')
    for (const permission of ['keys.manage', 'behaviour.write', 'members.manage']) {
      await page.goto(`${server.url}/t/marine/manage?tab=access`)
      await page.waitForSelector('[data-assignment-editor]')
      const before = server.requests.length
      await page.evaluate((permission) => {
        const original = fetch
        globalThis.fetch = async (input, init) => {
          const response = await original(input, init)
          if (!String(input).startsWith('/auth/me')) return response
          const snapshot = await response.json()
          snapshot.portalAccess.permissions = snapshot.portalAccess.permissions.filter((
            p: string,
          ) => p === 'portal.read' || p === 'portal.ask' || p === permission)
          return Response.json(snapshot)
        }
        dispatchEvent(new Event('focus'))
      }, { args: [permission] })
      await page.waitForSelector('[data-access-panel]')
      expect(await page.$('[data-manage-tab=access]')).not.toBeNull()
      if (permission === 'members.manage') await page.waitForSelector('[data-assignment-editor]')
      else {
        await page.waitForFunction(() => !document.querySelector('[data-assignment-editor]'))
        expect(server.requests.slice(before).filter((r) => r.path.includes('/members')))
          .toHaveLength(0)
      }
      const groupRequests = server.requests.slice(before).filter((r) => r.path.includes('/groups'))
      if (permission === 'members.manage') {
        await page.waitForSelector('[data-assignment-section=groups] [data-assignment-editor]')
        expect(groupRequests.every((r) => r.method === 'GET' && r.status === 200)).toBe(true)
      } else expect(groupRequests).toHaveLength(0)
      expect(server.requests.slice(before).some((r) => r.path.includes('/mcp/keys'))).toBe(false)
    }
    for (const role of ['viewer', 'curator']) {
      server.setIdentity(fixtureSession({ oid: `fixture-${role}` }))
      const before = server.requests.length
      await page.goto(`${server.url}/t/marine/manage?tab=access`)
      await page.waitForFunction(() =>
        !!(document.querySelector('[data-access-state=denied]') ||
          document.querySelector('[data-route-unavailable]') ||
          document.querySelector('[data-manage-shell]'))
      )
      expect(await page.$('[data-assignment-editor]')).toBeNull()
      expect(await page.$('[data-manage-tab=access]')).toBeNull()
      expect(
        server.requests.slice(before).some((r) =>
          r.path.includes('/members') || r.path.includes('/groups')
        ),
      ).toBe(false)
    }
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})

Deno.test('member panels discard old scope and identity, and refresh uncertain mutations without replay', async () => {
  const server = startTestServer({ identity: { role: 'portal-admin' } })
  server.setAssignment({ kind: 'portal', slug: 'grains' }, 'e2e-portal-admin', 'portal-admin')
  server.setAssignment({ kind: 'portal', slug: 'grains' }, 'grain-only-person', 'viewer')
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/manage?tab=access`)
  try {
    await page.bringToFront()
    await page.waitForSelector('[data-assignment-editor]')
    await rowAction(page, 'pending@example.test', 'Remove member')
    const delayed = server.delayResponse('/api/admin/t/marine/members')
    await page.evaluate(() => {
      history.pushState({}, '', '/t/grains/manage?tab=access')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForFunction(() =>
      document.querySelector('[data-assignment-editor]')?.textContent?.includes('grain-only-person')
    )
    expect(await page.$('dialog')).toBeNull()
    expect(
      await page.evaluate(() => document.querySelector('[data-assignment-editor]')?.textContent),
    ).not.toContain('pending@example.test')
    await page.evaluate(() => {
      history.pushState({}, '', '/t/marine/manage?tab=access')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await delayed.entered
    await page.evaluate(() => {
      history.pushState({}, '', '/t/grains/manage?tab=access')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForSelector('[data-assignment-editor]')
    delayed.release()
    await page.evaluate(() => {
      history.pushState({}, '', '/t/marine/manage?tab=access')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForFunction(() =>
      document.querySelector('[data-assignment-editor]')?.textContent?.includes(
        'pending@example.test',
      )
    )
    expect(
      await page.evaluate(() => document.querySelector('[data-assignment-editor]')?.textContent),
    ).not.toContain('grain-only-person')
    await page.evaluate(() => {
      const original = fetch
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init)
        if (String(input) === '/api/admin/t/marine/members' && init?.method === 'POST') {
          await response.body?.cancel()
          return Response.json({ error: 'audit_write_failed' }, { status: 500 })
        }
        return response
      }
    })
    const before = server.requests.length
    await click(page, 'Add member')
    await input(page, '[data-assignment-subject]', 'uncertain@example.test')
    await click(page, 'Add member')
    await page.waitForSelector('[data-access-panel] [role=alert]')
    await page.waitForSelector('[data-assignment-editor]')
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-access-panel] [role=alert]')?.textContent
      ),
    ).toContain('The change could not be confirmed')
    expect(server.requests.slice(before).filter((r) => r.method === 'POST')).toHaveLength(1)
    expect(server.requests.slice(before).some((r) => r.path === '/auth/me?portal=marine')).toBe(
      true,
    )
    await click(page, 'Add member')
    await input(page, '[data-assignment-subject]', 'discarded-form@example.test')
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => !document.querySelector('[data-assignment-editor]'))
    expect(await page.$('dialog')).toBeNull()
    expect(await page.evaluate(() => document.body.textContent)).not.toContain(
      'uncertain@example.test',
    )
    server.setIdentity(fixtureSession({ oid: 'e2e-portal-admin' }))
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await page.waitForSelector('[data-assignment-editor]')
    expect(await page.$('[data-access-panel] [role=alert]')).toBeNull()
    expect(await page.$('[data-assignment-subject]')).toBeNull()
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
