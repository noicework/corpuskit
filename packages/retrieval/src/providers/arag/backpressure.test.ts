import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'
import { AragApiError } from './client.ts'

/**
 * Ingestion back-pressure hardening. The platform returns HTTP 429 with a
 * `back_pressure_type`/`try_after` body when its processing queue is full -
 * an expected, transient condition under load, not a hard failure. This
 * covers: (1) AragApiError recognises and parses that shape distinctly from
 * every other error, and (2) createLink/createText retry across it a bounded
 * number of times before giving up with a typed, still-recognisable error -
 * never a bare unattributed failure.
 */

const TENANT: TenantConfig = {
  slug: 'marine',
  branding: {
    productName: 'Southern Waters Research Portal',
    organisation: 'Southern Waters Research Institute',
    tagline: 'Fisheries research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The platform's real back-pressure body, as seen live - try_after in the very near past/future
 *  so the retry's wait floors out at the minimum rather than slowing the test down. */
function backpressureResponse(): Response {
  return jsonResponse(
    {
      detail: {
        message: 'Too many messages pending to ingest. Retry after 1700000000',
        try_after: Math.floor(Date.now() / 1000),
        back_pressure_type: 'processing',
      },
    },
    429,
  )
}

function providerWithFetch(fetchImpl: typeof fetch): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl,
  })
}

// -----------------------------------------------------------------------
// AragApiError - back-pressure detection/parsing.
// -----------------------------------------------------------------------

describe('AragApiError - back-pressure detection', () => {
  it('parses a 429 back-pressure body into a typed .backpressure field', () => {
    const detail = JSON.stringify({
      detail: {
        message: 'Too many messages pending to ingest. Retry after 1700000000',
        try_after: 1700000000,
        back_pressure_type: 'processing',
      },
    })
    const err = new AragApiError(429, 'https://example.test/resources', detail)
    expect(err.backpressure).not.toBeNull()
    expect(err.backpressure?.tryAfter).toBe(1700000000)
    expect(err.backpressure?.kind).toBe('processing')
    expect(err.retryable).toBe(true)
  })

  it('does not treat an ordinary 429 (no back-pressure shape) as retryable', () => {
    const err = new AragApiError(429, 'https://example.test/resources', 'rate limited')
    expect(err.backpressure).toBeNull()
    expect(err.retryable).toBe(false)
  })

  it('does not treat a non-429 error as back-pressure, even with a matching body', () => {
    const detail = JSON.stringify({
      detail: { message: 'boom', try_after: 1700000000, back_pressure_type: 'processing' },
    })
    const err = new AragApiError(500, 'https://example.test/resources', detail)
    expect(err.backpressure).toBeNull()
    expect(err.retryable).toBe(false)
  })
})

// -----------------------------------------------------------------------
// createLink / createText - bounded retry across back-pressure.
// -----------------------------------------------------------------------

describe('createLink - back-pressure retry', () => {
  it('retries once and succeeds when the platform clears the queue', async () => {
    let calls = 0
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      expect(method).toBe('POST')
      expect(url).toContain('/resources')
      calls += 1
      if (calls === 1) return Promise.resolve(backpressureResponse())
      return Promise.resolve(jsonResponse({ uuid: 'created-1' }))
    })

    const result = await provider.createLink(TENANT, { url: 'https://example.org/report' })

    expect(calls).toBe(2)
    expect(result.id).toBe('created-1')
  })

  it('gives up after the retry budget and throws the typed back-pressure error', async () => {
    let calls = 0
    const provider = providerWithFetch(() => {
      calls += 1
      return Promise.resolve(backpressureResponse())
    })

    let caught: unknown
    try {
      await provider.createLink(TENANT, { url: 'https://example.org/report' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AragApiError)
    expect((caught as AragApiError).backpressure).not.toBeNull()
    expect((caught as AragApiError).retryable).toBe(true)
    // First attempt plus the bounded retry budget (2) - never unbounded.
    expect(calls).toBe(3)
  })
})

describe('createText - back-pressure retry', () => {
  it('retries once and succeeds when the platform clears the queue', async () => {
    let calls = 0
    const provider = providerWithFetch(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(backpressureResponse())
      return Promise.resolve(jsonResponse({ uuid: 'created-2' }))
    })

    const result = await provider.createText(TENANT, { title: 'A report', body: 'Body text' })

    expect(calls).toBe(2)
    expect(result.id).toBe('created-2')
  })

  it('gives up after the retry budget and throws the typed back-pressure error, never a bare failure', async () => {
    let calls = 0
    const provider = providerWithFetch(() => {
      calls += 1
      return Promise.resolve(backpressureResponse())
    })

    let caught: unknown
    try {
      await provider.createText(TENANT, { title: 'A report', body: 'Body text' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AragApiError)
    expect((caught as AragApiError).backpressure).not.toBeNull()
    expect(calls).toBe(3)
  })

  it('does not retry a genuine, non-back-pressure error', async () => {
    let calls = 0
    const provider = providerWithFetch(() => {
      calls += 1
      return Promise.resolve(jsonResponse({ detail: 'bad request' }, 400))
    })

    let caught: unknown
    try {
      await provider.createText(TENANT, { title: 'A report', body: 'Body text' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AragApiError)
    expect((caught as AragApiError).backpressure).toBeNull()
    // No retry budget spent on a plain error - one attempt only.
    expect(calls).toBe(1)
  })
})
