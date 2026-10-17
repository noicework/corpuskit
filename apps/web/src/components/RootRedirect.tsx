import { useEffect } from 'react'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { ArrowRight } from './icons.tsx'

/**
 * The runtime serves the dedicated marketing document at `/`. This redirect is
 * a fallback for hosts that serve the SPA entry point directly.
 */
export function RootRedirect() {
  const { ui } = usePortalLocale()
  useEffect(() => {
    globalThis.location.replace('/home.html')
  }, [])

  return (
    <main className='min-h-screen bg-app p-8 text-ink'>
      <a className='rp-link-standalone' href='/home.html'>
        {ui('Open the CorpusKit homepage')}
        <ArrowRight size='sm' />
      </a>
    </main>
  )
}
