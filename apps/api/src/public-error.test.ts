/**
 * Loop 8 (review loop 8 D8-07): a platform failure is
 * described in the portal's own words. The vendor name, the endpoint host,
 * the knowledge-box UUID and the upstream validation body are server-log
 * detail; none of them reaches a user-facing payload, whether the provider
 * throws or reports the failure as a stream event.
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type {
  AskEvent,
  CatalogPage,
  FacetCounts,
  Labelset,
  Question,
  ResourceSummary,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import { AragApiError, type RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { tenantsWithNeuro } from './fixtures/neuro-tenant.ts'
import {
  ANSWER_SERVICE_PROBLEM,
  BAD_DOCUMENT_LINK_MESSAGE,
  leaksInternalDetail,
  publicErrorMessage,
  publicSseEvent,
  publicStreamErrorMessage,
  SERVICE_BUSY_MESSAGE,
} from './public-error.ts'

/** The exact string loop 8 saw rendered into the answer card. */
const RAW = 'Agentic RAG API 422 for https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/' +
  '991906b6-1f55-4916-aa2e-33e566956ce3/ask: {"detail":[{"type":"value_error","loc":["body",' +
  '"resource_filters"],"msg":"Value error, resource id filter \'9dd53383\' should be a valid ' +
  'UUID"}]}'

describe('internal detail is recognised wherever it hides (D8-07)', () => {
  it('flags a host, a UUID, an endpoint path and the vendor name', () => {
    expect(leaksInternalDetail(RAW)).toBe(true)
    expect(leaksInternalDetail('https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/x'))
      .toBe(true)
    expect(leaksInternalDetail('991906b6-1f55-4916-aa2e-33e566956ce3')).toBe(true)
    expect(leaksInternalDetail('8565cc8f77a444608d6fded78f602c79')).toBe(true)
    expect(leaksInternalDetail('Nuclia rejected the request')).toBe(true)
    expect(leaksInternalDetail('Agentic RAG API 500')).toBe(true)
    expect(leaksInternalDetail('the x-nuclia-serviceaccount header is missing')).toBe(true)
    expect(leaksInternalDetail('    at ask (file:///app/apps/api/src/app.ts:1:1)')).toBe(true)
  })

  it('passes the wording the portal writes itself', () => {
    expect(leaksInternalDetail(ANSWER_SERVICE_PROBLEM)).toBe(false)
    expect(leaksInternalDetail(BAD_DOCUMENT_LINK_MESSAGE)).toBe(false)
    expect(leaksInternalDetail(SERVICE_BUSY_MESSAGE)).toBe(false)
    expect(leaksInternalDetail('The answer service had a problem (HTTP 422) - please try again.'))
      .toBe(false)
  })
})

describe('a provider error becomes portal wording (D8-07)', () => {
  it('names a bad document link rather than the platform', () => {
    expect(publicStreamErrorMessage(RAW)).toBe(BAD_DOCUMENT_LINK_MESSAGE)
    expect(
      publicErrorMessage(
        new AragApiError(
          422,
          'https://zone.rag.progress.cloud/api/v1/kb/x',
          '{"detail":[{"msg":"Value error, resource id filter \'9dd53383\' should be a valid UUID"}]}',
        ),
      ),
    )
      .toBe(BAD_DOCUMENT_LINK_MESSAGE)
  })

  it('keeps the status but nothing else of an upstream failure', () => {
    const message = publicErrorMessage(
      new AragApiError(500, 'https://zone.rag.progress.cloud/api/v1/kb/abc/ask', 'boom'),
    )
    expect(message).toBe('The answer service had a problem (HTTP 500) - please try again.')
    expect(leaksInternalDetail(message)).toBe(false)
  })

  it('says the service is busy for platform back-pressure', () => {
    const busy = new AragApiError(
      429,
      'https://zone.rag.progress.cloud/api/v1/kb/abc/ask',
      '{"detail":{"message":"Too many messages pending to ingest.","try_after":1,' +
        '"back_pressure_type":"processing"}}',
    )
    expect(publicErrorMessage(busy)).toBe(SERVICE_BUSY_MESSAGE)
  })

  it('falls back to the generic wording for anything it cannot place', () => {
    expect(publicErrorMessage(new TypeError('fetch failed'))).toBe(ANSWER_SERVICE_PROBLEM)
    expect(publicErrorMessage('not an error')).toBe(ANSWER_SERVICE_PROBLEM)
    expect(publicStreamErrorMessage('')).toBe(ANSWER_SERVICE_PROBLEM)
  })

  it('rewrites an error event and leaves every other event alone', () => {
    const rewritten = publicSseEvent({ type: 'error', message: RAW }, 'test') as {
      type: string
      message: string
    }
    expect(rewritten.type).toBe('error')
    expect(rewritten.message).toBe(BAD_DOCUMENT_LINK_MESSAGE)
    const delta = { type: 'delta', text: 'Retention was 71.1%.' }
    expect(publicSseEvent(delta, 'test')).toBe(delta)
  })

  it('is a no-op on wording it has already produced', () => {
    const once = publicStreamErrorMessage(RAW)
    expect(publicStreamErrorMessage(once)).toBe(once)
    expect(publicStreamErrorMessage(
      'The answer service had a problem (HTTP 502) - please try ' +
        'again.',
    )).toBe('The answer service had a problem (HTTP 502) - please try again.')
  })
})

// ---------------------------------------------------------------------------
// End to end: the payload a reader's browser actually receives.
// ---------------------------------------------------------------------------

const resource: ResourceSummary = {
  id: 'res-1',
  title: 'Retention of brivaracetam in the real world',
  summary: 'A twelve-month retention cohort.',
  type: 'pdf',
  topicIds: [],
  keyFacts: [],
}

/** Only the surface the ask and docs-ask routes touch, failing the way loop 8 saw. */
class FailingProvider implements RetrievalProvider {
  constructor(private readonly mode: 'yield' | 'throw') {}

  listResources(): Promise<ResourceSummary[]> {
    return Promise.resolve([resource])
  }
  resource(): Promise<ResourceSummary | null> {
    return Promise.resolve(resource)
  }
  search(_tenant: TenantConfig, query: string): Promise<SearchResults> {
    return Promise.resolve({
      query,
      resources: [{ ...resource, relevance: 0.9, citedCount: 0 }],
      relatedQuestions: [],
    })
  }
  suggest(): Promise<Question[]> {
    return Promise.resolve([])
  }
  // deno-lint-ignore require-await
  async *ask(): AsyncIterable<AskEvent> {
    if (this.mode === 'throw') {
      throw new AragApiError(
        500,
        'https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/' +
          '991906b6-1f55-4916-aa2e-33e566956ce3/ask',
        '{"detail":"Internal Server Error"}',
      )
    }
    yield { type: 'error', message: RAW }
  }
  catalog(): Promise<CatalogPage> {
    return Promise.resolve({ total: 0, items: [] })
  }
  topicResources(): Promise<ResourceSummary[]> {
    return Promise.resolve([])
  }
  facets(): Promise<FacetCounts> {
    return Promise.resolve({})
  }
  labelsets(): Promise<Labelset[]> {
    return Promise.resolve([])
  }
}

const freshTenants = () => tenantsWithNeuro()

async function askPayload(mode: 'yield' | 'throw'): Promise<string> {
  const app = buildApp({ provider: new FailingProvider(mode), tenants: freshTenants() })
  const response = await app.request('/api/t/neuro/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'What is the twelve-month retention of brivaracetam?',
      resourceId: '9dd53383',
    }),
  })
  expect(response.status).toBe(200)
  return await response.text()
}

describe('no upstream detail reaches the reader payload (D8-07)', () => {
  it('sanitises an error the provider reports as a stream event', async () => {
    const body = await askPayload('yield')
    expect(leaksInternalDetail(body)).toBe(false)
    expect(body).not.toContain('rag.progress.cloud')
    expect(body).not.toContain('991906b6-1f55-4916-aa2e-33e566956ce3')
    expect(body).not.toContain('Agentic RAG')
    expect(body).toContain(BAD_DOCUMENT_LINK_MESSAGE)
  })

  it('sanitises an error the provider throws', async () => {
    const body = await askPayload('throw')
    expect(leaksInternalDetail(body)).toBe(false)
    expect(body).toContain('The answer service had a problem (HTTP 500)')
  })
})
