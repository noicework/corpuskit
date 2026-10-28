import { expect } from '@std/expect'
import type { ResourceSummary, TenantConfig } from '@research-portal/core'
import type { ListResourcesOptions } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { TenantStore } from './tenants.ts'
import { EnrichmentStore } from './enrichments.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'

// The title index the header search suggests from: every document's display title in one small
// list, read from the cached catalogue within a reader's bound.

function portalApp(provider: DoubleProvider) {
  const directory = Deno.makeTempDirSync({ prefix: 'title-index-' })
  const db = new LocalRbacDatabase(':memory:')
  const rbac = new RbacState(db)
  rbac.migrate()
  const app = buildApp({
    provider,
    tenants: new TenantStore({
      TENANTS_PATH: `${directory}/tenants.json`,
      SHOWCASE_PORTALS: 'marine,grains',
    }),
    enrichments: new EnrichmentStore(directory),
    rbac,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    audit: rbac.audit,
    breakGlass: rbac.breakGlassService({}),
    requestContext: () => ({
      requestId: crypto.randomUUID(),
      session: null,
      clientIp: '192.0.2.1',
      coarseAdminEligible: false,
    }),
    rateLimitAskPerMin: 0,
    rateLimitAnonPortalAskPerMin: 0,
  })
  return {
    app,
    close: () => {
      db.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

/** A catalogue that records how it was read, and never answers a read that wants all of it. */
class RecordingCatalogue extends DoubleProvider {
  reads: (ListResourcesOptions | undefined)[] = []

  override listResources(
    tenant: TenantConfig,
    options?: ListResourcesOptions,
  ): Promise<ResourceSummary[]> {
    this.reads.push(options)
    if (!options?.bounded) return new Promise(() => {})
    return super.listResources(tenant)
  }
}

Deno.test('the title index lists each document with only the fields a suggestion shows', async () => {
  const provider = new RecordingCatalogue()
  const portal = portalApp(provider)
  try {
    const response = await portal.app.request('/api/t/marine/titles')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [
        {
          id: 'res-1',
          title: 'Abalone stock health in southern waters',
          type: 'pdf',
          topicIds: ['stock-assessment', 'marine-sustainability'],
        },
        {
          id: 'res-2',
          title: 'Marine heatwave impacts on rock lobster',
          type: 'web',
          topicIds: ['fisheries-policy'],
        },
      ],
    })
    // A reader's read: bounded, so a slow box answers with what it has rather than hanging.
    expect(provider.reads).toEqual([{ bounded: true }])
  } finally {
    portal.close()
  }
})
