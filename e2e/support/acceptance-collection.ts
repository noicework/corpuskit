import type {
  CatalogPage,
  ResourceSummary,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import type { SearchOptions } from '../../packages/retrieval/src/provider.ts'
import type { BuildAppOptions } from '../../apps/api/src/app.ts'
import { DoubleProvider } from './double-provider.ts'

/** Test-only tenant collections shared by readers and the management double. */
export class AcceptanceCollection extends DoubleProvider {
  private portals = new Map<string, Map<string, { resource: ResourceSummary; text: string }>>()
  readonly writes: { method: string; slug: string; id: string; text?: string }[] = []
  failCreate = false
  private sequence = 0

  private box(slug: string) {
    let box = this.portals.get(slug)
    if (!box) this.portals.set(slug, box = new Map())
    return box
  }

  plant(slug: string, id: string, title: string, text: string, hidden = false) {
    this.box(slug).set(id, {
      resource: {
        id,
        title,
        summary: text,
        type: 'web',
        topicIds: ['stock-assessment'],
        keyFacts: [],
        ...(hidden ? { hidden: true } : {}),
      },
      text,
    })
  }

  override listResources(tenant: TenantConfig): Promise<ResourceSummary[]> {
    return Promise.resolve(
      [...this.box(tenant.slug).values()].map((entry) => entry.resource).filter((r) => !r.hidden),
    )
  }

  override resource(tenant: TenantConfig, id: string, options?: { hidden?: boolean }) {
    const resource = this.box(tenant.slug).get(id)?.resource
    return Promise.resolve(resource && (!resource.hidden || options?.hidden) ? resource : null)
  }

  override async catalog(tenant: TenantConfig): Promise<CatalogPage> {
    const resources = await this.listResources(tenant)
    return {
      items: resources.map((r) => ({ ...r, status: 'processed' as const })),
      total: resources.length,
    }
  }

  override async search(
    tenant: TenantConfig,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResults> {
    const resources = await this.listResources(tenant)
    return {
      query,
      resources: resources.filter((r) =>
        !options?.resourceIds || options.resourceIds.includes(r.id)
      )
        .map((r) => ({ ...r, relevance: 0.6, citedCount: 0, matchedPassage: r.summary })),
      relatedQuestions: [],
    }
  }

  override async topicResources(tenant: TenantConfig, topicId: string, limit = 10) {
    return (await this.listResources(tenant)).filter((r) => r.topicIds.includes(topicId)).slice(
      0,
      limit,
    )
  }

  /** Only supported methods exist; an unexpected management call fails the test. */
  management(): NonNullable<BuildAppOptions['management']> {
    const methods = {
      counters: async (tenant: TenantConfig) => ({
        resources: this.box(tenant.slug).size,
        paragraphs: 12,
        sentences: 24,
        indexMb: 1,
      }),
      resourceCount: async (tenant: TenantConfig) => this.box(tenant.slug).size,
      recentResources: async (tenant: TenantConfig) =>
        [...this.box(tenant.slug).values()].map(({ resource }) => ({
          ...resource,
          status: 'processed',
        })),
      corpusHealth: async () => [],
      agentConfigs: async () => [],
      thumbnailResponse: async () => new Response(null, { status: 404 }),
      createText: async (
        tenant: TenantConfig,
        input: { title: string; body: string; hidden?: boolean },
      ) => {
        if (this.failCreate) throw new Error('Fixture indexing refused')
        const id = `document-${++this.sequence}`
        this.plant(tenant.slug, id, input.title, input.body, input.hidden)
        this.writes.push({ method: 'createText', slug: tenant.slug, id, text: input.body })
        return { id }
      },
      resourceFull: async (tenant: TenantConfig, id: string) => {
        const entry = this.box(tenant.slug).get(id)
        if (!entry) throw new Error('Fixture document not found')
        return {
          title: entry.resource.title,
          kind: 'text',
          texts: [{ fieldId: 'body', body: entry.text }],
          topicIds: entry.resource.topicIds,
        }
      },
      patchResourceClassifications: async () => {},
      deleteResource: async (tenant: TenantConfig, id: string) => {
        this.box(tenant.slug).delete(id)
        this.writes.push({ method: 'deleteResource', slug: tenant.slug, id })
      },
      setResourceHidden: async (tenant: TenantConfig, id: string, hidden: boolean) => {
        const entry = this.box(tenant.slug).get(id)
        if (!entry) throw new Error('Fixture document not found')
        if (hidden) entry.resource.hidden = true
        else delete entry.resource.hidden
        this.writes.push({ method: 'setResourceHidden', slug: tenant.slug, id })
      },
    }
    return methods as unknown as NonNullable<BuildAppOptions['management']>
  }
}

export const ORIGINAL_TEXT =
  'Coastal habitat surveys record the condition of sheltered nursery sites. ' +
  'Field teams count juvenile shellfish, describe the seagrass cover and check the water temperature. ' +
  'The same survey route is followed each season so readers can compare observations over time. ' +
  'The report explains the sampling method, the weather on each visit and the limits of the evidence. ' +
  'These findings support local habitat monitoring and help researchers plan repeat surveys. ' +
  'Further work will compare the sheltered sites with nearby exposed areas before any management change is proposed.'

export const UPDATED_TEXT = ORIGINAL_TEXT +
  ' Revised nursery observations include additional sheltered sites and corrected field notes.'
