import type { AskEvent, ResourceSummary, TenantConfig } from '@research-portal/core'
import { DoubleProvider } from './double-provider.ts'

/** Every portal owns a different planted document, including when queried through one instance. */
export class PortalMarkerProvider extends DoubleProvider {
  private readonly portals = new Map<string, ResourceSummary>()
  plant(slug: string): { resource: ResourceSummary; marker: string } {
    const marker = `boundarytoken${crypto.randomUUID().replace(/[0-9-]/g, 'x')}`
    const text = `The boundary note records the validation token ${marker}.`
    const resource: ResourceSummary = {
      id: crypto.randomUUID(),
      title: `Boundary note ${marker}`,
      summary: text,
      type: 'document',
      topicIds: [],
      keyFacts: [text],
    }
    this.portals.set(slug, resource)
    return { resource, marker }
  }
  override listResources(tenant: TenantConfig) {
    const resource = this.portals.get(tenant.slug)
    return Promise.resolve(resource ? [resource] : [])
  }
  override async resource(tenant: TenantConfig, id: string) {
    return (await this.listResources(tenant)).find((r) => r.id === id) ?? null
  }
  override async search(tenant: TenantConfig, query: string) {
    return {
      query,
      resources: (await this.listResources(tenant)).map((r) => ({
        ...r,
        relevance: 1,
        citedCount: 1,
        matchedPassage: r.summary,
      })),
      relatedQuestions: [],
    }
  }
  override async catalog(tenant: TenantConfig) {
    const resources = await this.listResources(tenant)
    return {
      items: resources.map((r) => ({
        id: r.id,
        title: r.title,
        topicIds: r.topicIds,
        status: 'processed' as const,
      })),
      total: resources.length,
    }
  }
  override async *ask(tenant: TenantConfig, _query: string): AsyncIterable<AskEvent> {
    const resource = this.portals.get(tenant.slug)
    if (!resource) {
      yield { type: 'done', refused: true, text: 'No boundary note was found.' }
      return
    }
    yield {
      type: 'sources',
      resources: [{ ...resource, relevance: 1, citedCount: 1, matchedPassage: resource.summary }],
    }
    yield { type: 'delta', text: `${resource.summary} [1]` }
    yield {
      type: 'citation',
      citation: {
        index: 1,
        resourceId: resource.id,
        title: resource.title,
        passage: resource.summary,
      },
    }
    yield { type: 'quality', answerRelevance: 5, groundedness: 5, contextRelevance: 5 }
    yield { type: 'done', refused: false, text: `${resource.summary} [1]` }
  }
}
