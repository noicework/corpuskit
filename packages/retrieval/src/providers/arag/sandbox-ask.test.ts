import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * The Extraction Lab asks its before/after question of a scratch sandbox
 * box that carries none of the portal's stored search configurations.
 * Naming `portal-ask` there 400s ("Search configuration not found"), and the
 * lab's single, freshly uploaded document must ground the answer whatever
 * its retrieval score - so a sandbox ask sends no configuration and a zero
 * score floor (persona finding P4-10).
 */

const LAB: TenantConfig = {
  slug: 'neuro-lab',
  branding: {
    productName: 'Neurology Research Collective',
    organisation: 'Neurology Research Collective',
    tagline: 'Testing',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

function ndjson(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

async function askBodies(opts: { sandbox?: boolean; resourceId?: string }) {
  const bodies: Record<string, unknown>[] = []
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/lab-kb',
      token: 'test-token',
    }),
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/catalog')) {
        return Promise.resolve(
          new Response(JSON.stringify({ resources: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      if (url.endsWith('/ask')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(ndjson([
          {
            item: {
              type: 'retrieval',
              results: {
                resources: {
                  'lab-1': {
                    title: 'Lab upload',
                    fields: { a: { paragraphs: { p1: { score: 0.1, text: 'HR 0.54' } } } },
                  },
                },
              },
            },
          },
          { item: { type: 'answer', text: 'The hazard ratio was 0.54.' } },
        ]))
      }
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
  for await (const _event of provider.ask(LAB, 'What was the hazard ratio?', opts)) {
    // drain
  }
  return bodies
}

describe('sandbox ask', () => {
  it('sends no stored configuration and a zero score floor, keeping the resource filter', async () => {
    const [body] = await askBodies({ sandbox: true, resourceId: 'lab-1' })
    expect(body?.search_configuration).toBeUndefined()
    expect(body?.min_score).toEqual({ semantic: 0, bm25: 0 })
    expect(body?.resource_filters).toEqual(['lab-1'])
  })

  it('a research ask still names the stored configuration and no floor', async () => {
    const [body] = await askBodies({ resourceId: 'lab-1' })
    expect(body?.search_configuration).toBe('portal-ask')
    expect(body?.min_score).toBeUndefined()
  })
})
