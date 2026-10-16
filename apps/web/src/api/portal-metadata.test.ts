import { expect } from '@std/expect'
import { DEFAULT_PALETTES } from '@research-portal/core'
import { readSafePortalMetadata, retryTenantConfig } from './portal-metadata.ts'
import { safePortalProjection } from '../../../api/src/lifecycle-policy.ts'
import { TenantConfigSchema } from '@research-portal/core'

const palette = DEFAULT_PALETTES.corpuskit.palette
const safe = {
  slug: 'marine',
  status: 'suspended',
  accessMode: 'restricted',
  branding: {
    productName: 'Research portal',
    organisation: 'Research institute',
    colours: {
      primary: palette.brandSurface,
      accent: palette.accent,
      heroFrom: palette.heroFrom,
      heroTo: palette.heroTo,
    },
    tagline: 'Private content must never be retained',
  },
  suggestedQuestions: ['Private question'],
  resources: 10,
  limits: { asksPerDay: 100 },
}

Deno.test('paused portal metadata retains only public branding and status', async () => {
  const result = await readSafePortalMetadata(
    Response.json({
      ...safe,
      error: 'portal_suspended',
    }, { status: 423 }),
    'marine',
  )
  expect(result.status).toBe('suspended')
  expect(result.branding.productName).toBe('Research portal')
  expect(JSON.stringify(result)).not.toContain('Private')
  expect(result).not.toHaveProperty('limits')
  expect(result).not.toHaveProperty('resources')
})

Deno.test('safe logo width survives projection and parsing without discovery or switcher state', async () => {
  const config = TenantConfigSchema.parse({
    ...safe,
    branding: { ...safe.branding, logoMaxWidth: 300, showPortalSwitcher: false },
    searchPlaceholder: 'Private search',
    topics: [],
    suggestedQuestions: [],
    entityTypes: [],
    relationTypes: [],
  })
  const projection = safePortalProjection(config, '/logo.svg')
  const metadata = await readSafePortalMetadata(Response.json(projection), 'marine')
  expect(metadata.branding.logoMaxWidth).toBe(300)
  expect(metadata.branding.logoUrl).toBe('/logo.svg')
  expect(projection.branding).not.toHaveProperty('showPortalSwitcher')
  expect(metadata).not.toHaveProperty('topics')
  expect(JSON.stringify(metadata)).not.toContain('Private')
  for (const width of [79, 641, '300']) {
    await expect(readSafePortalMetadata(
      Response.json({
        ...projection,
        branding: { ...projection.branding, logoMaxWidth: width },
      }),
      'marine',
    )).rejects.toThrow()
  }
})

Deno.test('old active metadata remains compatible and unknown lifecycle states fail closed', async () => {
  expect(
    (await readSafePortalMetadata(Response.json({ ...safe, status: undefined }), 'marine'))
      .status,
  ).toBe('active')
  const plainBrand = await readSafePortalMetadata(
    Response.json({
      ...safe,
      branding: { ...safe.branding, logoUrl: null, paletteId: null, colourScheme: null },
    }),
    'marine',
  )
  expect(plainBrand.branding.logoUrl).toBeUndefined()
  expect(plainBrand.branding.paletteId).toBeUndefined()
  expect(plainBrand.branding.colourScheme).toBeUndefined()
  const lightOnly = await readSafePortalMetadata(
    Response.json({ ...safe, branding: { ...safe.branding, colourScheme: 'light' } }),
    'marine',
  )
  expect(lightOnly.branding.colourScheme).toBe('light')
  const lightDefault = await readSafePortalMetadata(
    Response.json({ ...safe, branding: { ...safe.branding, defaultColourScheme: 'light' } }),
    'marine',
  )
  expect(lightDefault.branding.defaultColourScheme).toBe('light')
  await expect(readSafePortalMetadata(Response.json({ ...safe, status: 'invalid' }), 'marine'))
    .rejects.toThrow()
})

Deno.test('safe metadata rejects mismatched portals and every other failed response', async () => {
  for (const status of [401, 403, 404, 500]) {
    await expect(readSafePortalMetadata(
      Response.json({
        ...safe,
        error: 'portal_suspended',
      }, { status }),
      'marine',
    )).rejects.toThrow()
  }
  for (
    const body of [
      safe,
      { ...safe, error: 'portal_read_only' },
      { ...safe, error: 'portal_suspended', status: 'active' },
      { ...safe, error: 'portal_suspended', slug: 'other' },
    ]
  ) {
    await expect(readSafePortalMetadata(Response.json(body, { status: 423 }), 'marine'))
      .rejects.toThrow()
  }
})

Deno.test('the portal config read retries transient failures but never an access or hosting answer', () => {
  for (const status of [401, 403, 404, 423]) {
    expect(retryTenantConfig(0, { status })).toBe(false)
  }
  for (const error of [{ status: 502 }, { status: 500 }, new TypeError('network'), null]) {
    expect(retryTenantConfig(0, error)).toBe(true)
    expect(retryTenantConfig(2, error)).toBe(true)
    expect(retryTenantConfig(3, error)).toBe(false)
  }
})
