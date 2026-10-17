import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { portalLogo } from './TenantLayout.tsx'

describe('portal chrome logo selection', () => {
  const logoUrl = '/api/tenants/marine/logo?v=12'

  it('keeps the light logo without a plate in the light scheme', () => {
    expect(portalLogo({ logoUrl, logoDarkUrl: '/dark.svg' }, 'light')).toEqual({
      src: logoUrl,
      plate: false,
    })
  })

  it('plates a light-only logo in the dark scheme', () => {
    expect(portalLogo({ logoUrl }, 'dark')).toEqual({ src: logoUrl, plate: true })
  })

  it('plates a reused light asset even when its version query differs', () => {
    expect(portalLogo({ logoUrl, logoDarkUrl: '/api/tenants/marine/logo?v=43' }, 'dark'))
      .toEqual({ src: logoUrl, plate: true })
    expect(portalLogo({ logoUrl: '/logo.svg?size=2&v=3', logoDarkUrl: '/logo.svg?size=2' }, 'dark'))
      .toEqual({ src: '/logo.svg?size=2&v=3', plate: true })
  })

  it('uses a distinct dark logo without a plate', () => {
    expect(portalLogo({ logoUrl, logoDarkUrl: '/dark.svg?v=12' }, 'dark')).toEqual({
      src: '/dark.svg?v=12',
      plate: false,
    })
    expect(
      portalLogo({ logoUrl: '/logo.svg?theme=light', logoDarkUrl: '/logo.svg?theme=dark' }, 'dark'),
    )
      .toEqual({ src: '/logo.svg?theme=dark', plate: false })
  })

  it('does not plate a text fallback', () => {
    expect(portalLogo({}, 'dark')).toEqual({ src: undefined, plate: false })
  })
})
