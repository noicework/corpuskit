import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  EmergencyAccessProvider,
  useAdminAccess,
} from '../../apps/web/src/components/EmergencyAccess.tsx'
import { type AuthSession, getAuthSession, microsoftLoginUrl } from '../../apps/web/src/api/auth.ts'
import { googleFontsUrl, tenantThemeVars, useBodyTheme } from '../../apps/web/src/lib/theme.ts'
import { BrandingSchema } from '@research-portal/core'

declare const __EMERGENCY_FIXTURE_BUILD__: string
const params = new URLSearchParams(location.search)
const branding = BrandingSchema.parse({
  productName: 'CorpusKit',
  organisation: 'Example research',
  tagline: 'Research administration',
  colours: { primary: '#17372d', accent: '#e0ba63', heroFrom: '#17372d', heroTo: '#234f45' },
  paletteId: params.get('palette') === 'observatory' ? 'observatory' : 'default',
  shape: 'soft',
  density: 'spacious',
  typography: 'lexend-zilla',
})

function ActionFixture() {
  const { runExplicit, breakGlassEnabled, coarseAdminEligible } = useAdminAccess()
  const [outcome, setOutcome] = useState('idle')
  function run() {
    void runExplicit('Refresh the portal resource count', async (access) => {
      const result = await access.request('/api/admin/__test/emergency-action', { method: 'POST' })
      await result.json()
      if (params.get('scenario') === 'batch') {
        await access.request('/api/admin/__test/emergency-action')
      }
      return true
    }).then((result) => setOutcome(result ? 'completed' : 'cancelled')).catch(() =>
      setOutcome('failed')
    )
  }
  return (
    <section className='rp-card p-6'>
      <h2 className='rp-display text-xl'>Portal resources</h2>
      <p className='my-4 text-sm text-ink-2'>Refresh the resource count for this portal.</p>
      <div className='flex flex-wrap gap-4'>
        <a className='rp-btn rp-btn-ghost' href={microsoftLoginUrl()}>Sign in with Microsoft</a>
        {breakGlassEnabled && !coarseAdminEligible
          ? (
            <button
              type='button'
              id='emergency-entry'
              className='rp-btn rp-btn-primary'
              onClick={run}
            >
              Use emergency access
            </button>
          )
          : null}
        {coarseAdminEligible
          ? (
            <button
              type='button'
              id='session-action'
              className='rp-btn rp-btn-primary'
              onClick={run}
            >
              Refresh resource count
            </button>
          )
          : null}
      </div>
      <p data-outcome={outcome} className='mt-4 text-sm text-ink-2'>
        {outcome === 'completed' ? 'Resource count refreshed.' : 'One request per action.'}
      </p>
    </section>
  )
}

function Fixture() {
  const [session, setSession] = useState<AuthSession>()
  const [mounted, setMounted] = useState(true)
  useBodyTheme(branding)
  useEffect(() => {
    const font = document.createElement('link')
    font.rel = 'stylesheet'
    font.href = googleFontsUrl('lexend-zilla')
    document.head.append(font)
    const refresh = () => {
      void getAuthSession().then(setSession)
    }
    refresh()
    addEventListener('fixture-refresh-capability', refresh)
    const unmount = () => setMounted(false)
    addEventListener('fixture-unmount', unmount)
    return () => {
      font.remove()
      removeEventListener('fixture-refresh-capability', refresh)
      removeEventListener('fixture-unmount', unmount)
    }
  }, [])
  return (
    <div
      className='rp-tenant min-h-screen bg-app text-ink'
      style={tenantThemeVars(branding)}
      data-fixture-mounted
      data-fixture-ready={session ? true : undefined}
      data-fixture-build={__EMERGENCY_FIXTURE_BUILD__}
    >
      <header className='border-b border-line bg-surface p-6'>
        <h1 className='rp-display text-xl'>CorpusKit administration</h1>
      </header>
      <main className='p-6'>
        {mounted
          ? (
            <EmergencyAccessProvider session={session}>
              <ActionFixture />
            </EmergencyAccessProvider>
          )
          : null}
      </main>
    </div>
  )
}

createRoot(document.getElementById('emergency-fixture-root')!).render(<Fixture />)
