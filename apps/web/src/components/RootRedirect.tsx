import { useEffect } from 'react'

/**
 * The runtime serves the dedicated marketing document at `/`. This redirect is
 * a fallback for hosts that serve the SPA entry point directly.
 */
export function RootRedirect() {
  useEffect(() => {
    globalThis.location.replace('/home.html')
  }, [])

  return (
    <main className='min-h-screen bg-[#f2efe7] p-8 text-[#1c1c19]'>
      <a href='/home.html'>Open the CorpusKit homepage</a>
    </main>
  )
}
