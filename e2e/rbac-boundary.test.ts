import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import {
  assertCurrentBuild,
  buildComponentFixture,
  captureBoundary,
  sourcePath,
} from './support/rbac-fixture.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

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
