import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { type TenantConfig } from '@research-portal/core'
import { createPortalLocale, PortalLocaleContext } from '../../lib/portal-locale.tsx'
import { LogoHeaderPreview } from './AppearancePanel.tsx'

const branding: TenantConfig['branding'] = {
  productName: 'Preview portal',
  organisation: 'Research institute',
  tagline: 'Research',
  colours: { primary: '#3d1a4f', accent: '#8cc63f', heroFrom: '#2a1036', heroTo: '#3d1a4f' },
  logoUrl: '/light.svg',
}

const preview = (
  scheme: 'light' | 'dark',
  extra: Partial<TenantConfig['branding']> = {},
  language: 'en' | 'ja' = 'en',
) =>
  renderToStaticMarkup(
    <PortalLocaleContext.Provider value={createPortalLocale(language)}>
      <LogoHeaderPreview slug='preview' branding={{ ...branding, ...extra }} scheme={scheme} />
    </PortalLocaleContext.Provider>,
  )

Deno.test('logo previews use an explicit light header ground even inside a dark page', () => {
  const light = preview('light')
  expect(light).toContain('--rp-surface:#ffffff')
  expect(light).toContain('src="/light.svg"')
  expect(light).not.toContain('class="rp-logo-plate')
  expect(light).toContain('Light header preview')
})

Deno.test('a missing or identical dark logo uses the light asset on a plate', () => {
  for (const logoDarkUrl of [undefined, '/light.svg']) {
    const dark = preview('dark', { logoDarkUrl })
    expect(dark).toContain('src="/light.svg"')
    expect(dark).toContain('class="rp-logo-plate')
    expect(dark).toContain('the light logo is shown on a light plate in dark mode.')
  }
  expect(preview('light', { paletteId: 'observatory' })).toContain('class="rp-logo-plate')
})

Deno.test('a separate dark logo renders on the dark header without a plate', () => {
  const dark = preview('dark', { logoDarkUrl: '/dark.svg' })
  expect(dark).toContain('src="/dark.svg"')
  expect(dark).not.toContain('class="rp-logo-plate')
  expect(dark).toContain('The separate dark logo is shown on the header ground.')
  expect(preview('light', { logoDarkUrl: '/dark.svg' })).toContain('src="/light.svg"')
  const observatory = preview('light', { paletteId: 'observatory', logoDarkUrl: '/dark.svg' })
  expect(observatory).toContain('src="/dark.svg"')
  expect(observatory).not.toContain('class="rp-logo-plate')
})

Deno.test('logo preview labels and plate guidance are translated to Japanese', () => {
  const dark = preview('dark', {}, 'ja')
  expect(dark).toContain('ダークモードのヘッダープレビュー')
  expect(dark).toContain('通常のロゴを明るい背景のプレートに載せて表示します。')
  expect(dark).not.toContain('Dark header preview')
})
