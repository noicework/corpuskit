import { expect } from '@std/expect'
import { launch, type Page } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary as captureSnapshot,
  sourcePath,
} from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

async function captureBoundary(page: Page, directory: string, name: string, width: number) {
  // Let the existing 150ms token colour transitions settle before judging contrast.
  await page.evaluate(async () => await new Promise((resolve) => setTimeout(resolve, 200)))
  await captureSnapshot(page, directory, name, width)
}

Deno.test('portal boundary withholds protected requests, recovers and removes revoked content', async () => {
  const server = startTestServer()
  const browser = await launch()
  try {
    server.setAccessMode('marine', 'restricted')
    const delay = server.delayResponse('/auth/me?portal=marine')
    const page = await browser.newPage(`${server.url}/t/marine/library`)
    try {
      await page.waitForSelector('[data-access-state=loading]')
      await delay.entered
      expect(server.requests.filter((r) => r.path.startsWith('/api/'))).toEqual([])
      delay.release()
      await page.waitForSelector('[data-access-state=denied]')
      expect(await page.evaluate(() => document.body.innerText)).toContain('Sign in to')
      expect(
        server.requests.filter((r) =>
          r.path.startsWith('/api/') && r.path !== '/api/t/marine/config'
        ),
      ).toEqual([])
      await page.waitForSelector('[data-safe-metadata=ready]')
      await assertCurrentBuild(page)
      await page.evaluate(() => {
        localStorage.setItem('rp-scheme', 'light')
        dispatchEvent(new Event('focus'))
      })
      await page.waitForSelector('[data-safe-metadata=ready]')
      for (const width of [1440, 390]) {
        await captureBoundary(page, '.planning/logs/04-03-02', `signin-light-${width}`, width)
      }
      server.tenants.patchBranding('marine', { paletteId: 'observatory' })
      server.setAccessMode('marine', 'authenticated')
      await page.evaluate(() => {
        localStorage.setItem('rp-scheme', 'dark')
        dispatchEvent(new Event('focus'))
      })
      await page.waitForSelector('[data-safe-metadata=ready]')
      expect(
        server.requests.filter((r) =>
          r.path.startsWith('/api/') && r.path !== '/api/t/marine/config'
        ),
      ).toEqual([])
      for (const width of [1440, 390]) {
        await captureBoundary(page, '.planning/logs/04-03-02', `signin-dark-${width}`, width)
      }
      server.setAccessMode('marine', 'restricted')
      server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
      await page.evaluate(() => dispatchEvent(new Event('focus')))
      await page.waitForSelector('input[type=search]')
      await page.waitForSelector('a[href="/t/marine/library/res-1"]')
      server.setAssignment({ kind: 'portal', slug: 'marine' }, 'fixture-viewer', null)
      await page.evaluate(() => dispatchEvent(new Event('focus')))
      await page.waitForSelector('[data-access-state=denied]')
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Abalone populations',
      )
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
      for (const palette of ['default', 'observatory'] as const) {
        server.tenants.patchBranding('marine', { paletteId: palette })
        await page.evaluate((scheme) => {
          localStorage.setItem('rp-scheme', scheme)
          dispatchEvent(new Event('focus'))
        }, { args: [palette === 'default' ? 'light' : 'dark'] })
        await page.waitForSelector('[data-safe-metadata=ready]')
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-03-02',
            `denied-${palette}-${width}`,
            width,
          )
        }
      }
      const csp = await fetch(`${server.url}/t/marine`)
      expect(csp.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      await csp.text()
    } finally {
      delay.release()
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

Deno.test('obsolete caches and delayed config never cross identities or portals; scope reads remain independent', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AccessProvider, useAccess, useScopeAccess } from '${
      sourcePath('apps/web/src/components/AccessProvider.tsx')
    }'
import { PortalAccessGate } from '${sourcePath('apps/web/src/components/PortalAccessGate.tsx')}'
import { request } from '${sourcePath('apps/web/src/api/client.ts')}'
const clients = []
function Controls() {
 const access = useAccess(), client = useQueryClient(), navigate = useNavigate()
 useEffect(() => {
  const inspect = () => { document.body.dataset.caches = JSON.stringify(clients.map(c => c.getQueryCache().getAll().map(q => q.state.data))) }
  const refetch = () => client.invalidateQueries({ queryKey: ['private-value'] })
  const grains = () => navigate('/t/grains')
  const deny = () => { void request('/api/admin/overview').catch(() => {}) }
  addEventListener('inspect', inspect); addEventListener('refetch-private', refetch); addEventListener('go-grains', grains); addEventListener('deny', deny)
  return () => { removeEventListener('inspect', inspect); removeEventListener('refetch-private', refetch); removeEventListener('go-grains', grains); removeEventListener('deny', deny) }
 }, [client, navigate])
 return <span data-page-scope={access.slug} />
}
function Scope({ slug }) { const scope = useScopeAccess(slug); return <span data-scope={slug} data-ready={scope.state} data-read={scope.can('portal.read')} /> }
function Panel() {
 const access = useAccess(), client = useQueryClient()
 useEffect(() => { clients.push(client) }, [client])
 const query = useQuery({ queryKey: ['private-value'], queryFn: () => request('/api/t/' + access.slug + '/config') })
 return <main><h1>Research content</h1><p data-private={query.data?.branding.tagline}>{query.data?.branding.tagline}</p><Scope slug='marine' /><Scope slug='grains' /></main>
}
createRoot(document.getElementById('root')).render(<BrowserRouter><AccessProvider slug={undefined}><Controls /><PortalAccessGate><Panel /></PortalAccessGate></AccessProvider></BrowserRouter>)
`,
  })
  const server = startTestServer({ componentFixture: fixture })
  const browser = await launch()
  try {
    for (const slug of ['marine', 'grains']) server.setAccessMode(slug, 'restricted')
    server.tenants.patchBranding('marine', { tagline: 'Marine private marker' })
    server.tenants.patchBranding('grains', { tagline: 'Grains private marker' })
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    server.setAssignment({ kind: 'portal', slug: 'grains' }, 'second-viewer', 'viewer')
    const page = await browser.newPage(`${server.url}/__test/rbac-component`)
    try {
      // The test bundle uses real routing with no test identity endpoint.
      await page.evaluate(() => {
        history.replaceState(null, '', '/t/marine')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForSelector('[data-private="Marine private marker"]')
      await page.waitForSelector('[data-scope=grains][data-ready=ready]')
      expect(
        await page.evaluate(() =>
          document.querySelector('[data-scope=grains]')?.getAttribute('data-read')
        ),
      ).toBe('false')
      expect(
        await page.evaluate(() =>
          document.querySelector('[data-page-scope]')?.getAttribute('data-page-scope')
        ),
      ).toBe('marine')
      const delay = server.delayResponse('/api/t/marine/config')
      await page.evaluate(() => dispatchEvent(new Event('refetch-private')))
      await delay.entered
      server.setIdentity(fixtureSession({ oid: 'second-viewer' }))
      await page.evaluate(() => dispatchEvent(new Event('focus')))
      await page.waitForSelector('[data-access-state=denied]')
      delay.release()
      await page.evaluate(() => dispatchEvent(new Event('inspect')))
      expect(await page.evaluate(() => document.body.dataset.caches)).not.toContain(
        'Marine private marker',
      )
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Marine private marker',
      )
      await page.evaluate(() => dispatchEvent(new Event('go-grains')))
      await page.waitForSelector('[data-private="Grains private marker"]')
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Marine private marker',
      )
      const before = server.requests.filter((r) => r.path === '/api/admin/overview').length
      await page.evaluate(() => dispatchEvent(new Event('deny')))
      await page.waitForSelector('[data-access-state=failed]')
      expect(server.requests.filter((r) => r.path === '/api/admin/overview').length).toBe(
        before + 1,
      )
      await page.evaluate(() => dispatchEvent(new Event('inspect')))
      expect(await page.evaluate(() => document.body.dataset.caches)).not.toContain(
        'private marker',
      )
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
      for (const width of [1440, 390]) {
        await captureBoundary(page, '.planning/logs/04-03-02', `failed-${width}`, width)
      }
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
      for (const width of [1440, 390]) {
        await captureBoundary(page, '.planning/logs/04-03-02', `failed-dark-${width}`, width)
      }
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].find((el) => el.textContent === 'Try again')!
          .click()
      )
      await page.waitForSelector('[data-private="Grains private marker"]')
      for (const status of [503, 200]) {
        server.setResponseStatus('/auth/me?portal=grains', status)
        await page.evaluate(() => dispatchEvent(new Event('focus')))
        await page.waitForSelector('[data-access-state=failed]')
        expect(await page.evaluate(() => document.body.innerText)).not.toContain('private marker')
        server.setResponseStatus('/auth/me?portal=grains', null)
        await page.evaluate(() =>
          [...document.querySelectorAll('button')].find((el) => el.textContent === 'Try again')!
            .click()
        )
        await page.waitForSelector('[data-private="Grains private marker"]')
      }
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
    await fixture.close()
  }
})

Deno.test('signed component fixture reads real authority and denies management; anonymous Ask remains public', async () => {
  const fixture = await buildComponentFixture({
    entrySource: `
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getAuthSession } from '${sourcePath('apps/web/src/api/auth.ts')}'
import { BrandingSchema } from '@research-portal/core'
import { tenantThemeVars, useBodyTheme, useTenantFonts } from '${
      sourcePath('apps/web/src/lib/theme.ts')
    }'
function Fixture() {
 const [session, setSession] = useState(null)
 const branding = BrandingSchema.parse({ productName: 'Marine research', organisation: 'Research', tagline: 'Research access', colours: { primary: '#17372d', accent: '#e0ba63', heroFrom: '#17372d', heroTo: '#234f45' },
 paletteId: new URLSearchParams(location.search).get('palette') === 'dark' ? 'observatory' : 'default',
 shape: 'soft', density: 'spacious', typography: 'lexend-zilla' })
 useBodyTheme(branding); useTenantFonts(branding)
 useEffect(() => { void getAuthSession({ slug: 'marine' }).then(setSession) }, [])
 return <div className='rp-tenant min-h-screen bg-app text-ink' style={tenantThemeVars(branding)}>
 <header className='border-b border-line bg-surface p-6'>CorpusKit</header>
 <main className='p-6'><h1 className='rp-display text-3xl'>Marine research</h1>
 <p className='mt-4' data-role={session?.portalAccess?.effectiveRole}>{session ? 'Access checked: ' + session.portalAccess.effectiveRole : 'Checking access...'}</p></main></div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`,
  })
  const server = startTestServer({ componentFixture: fixture })
  const browser = await launch()
  try {
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    for (const palette of ['light', 'dark']) {
      const page = await browser.newPage(`${server.url}/__test/rbac-component?palette=${palette}`)
      try {
        await page.waitForSelector('[data-role=viewer]')
        await assertCurrentBuild(page)
        expect(await page.evaluate(async () => (await fetch('/api/admin/overview')).status)).toBe(
          403,
        )
        for (const width of [1440, 390]) {
          await captureBoundary(
            page,
            '.planning/logs/04-03-01',
            `fixture-${palette}-${width}`,
            width,
          )
        }
      } finally {
        await page.close()
      }
    }
    server.setIdentity(null)
    const page = await browser.newPage(`${server.url}/t/marine/ask`)
    try {
      const answer = await page.evaluate(async () => {
        const response = await fetch('/api/t/marine/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'Abalone stocks?' }),
        })
        return { status: response.status, text: await response.text() }
      })
      expect(answer.status).toBe(200)
      expect(answer.text).toContain('Abalone populations')
      expect(server.providerCalls).toContain('ask')
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
    await fixture.close()
  }
})
