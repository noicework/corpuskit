import { TenantConfigSchema } from '@research-portal/core'
import type { BindingStoreApi } from '../../api/src/bindings.ts'
import { DEMO_TENANT } from './demo.ts'
import type { DurableTenantStore } from './state.ts'

/** ACMD appearance over the existing CorpusKit documentation collection. */
export const ACMD_DEMO_TENANT = TenantConfigSchema.parse({
  ...DEMO_TENANT,
  slug: 'acmd',
  hostname: 'acmd.corpuskit.org',
  timezone: 'Australia/Melbourne',
  branding: {
    productName: 'ACMD Research Portal',
    organisation: 'Aikenhead Centre for Medical Discovery',
    tagline: 'Engineering the future of healthcare',
    colours: {
      primary: '#212d57',
      accent: '#83d0f5',
      heroFrom: '#ffffff',
      heroTo: '#f5f5f5',
    },
    paletteId: 'acmd',
    typography: 'custom',
    headingFontUrl: '/brands/acmd/montserrat-latin.woff2',
    bodyFontUrl: '/brands/acmd/montserrat-latin.woff2',
    logoUrl: '/brands/acmd/logo.png',
    heroImageUrl: '/brands/acmd/research.jpeg',
    shape: 'soft',
    density: 'comfortable',
  },
})

/**
 * Seed only this demo; later appearance edits or a dedicated KB are preserved. The shared
 * binding is copied only when the store can seal new credentials.
 */
export async function initialiseAcmdDemo(
  tenants: Pick<DurableTenantStore, 'get' | 'seed'>,
  bindings: Pick<BindingStoreApi, 'get' | 'set' | 'encryptionStatus'>,
  environment: string | undefined,
): Promise<void> {
  if (environment !== 'demo') return
  if (!tenants.get('acmd')) tenants.seed(ACMD_DEMO_TENANT)
  if (!bindings.get('acmd') && bindings.encryptionStatus().writable) {
    const documentation = bindings.get('demo')
    if (documentation) await bindings.set('acmd', documentation)
  }
}
