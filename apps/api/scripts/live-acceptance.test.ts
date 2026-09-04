import {
  type AcceptanceSweepOptions,
  parseTenantSlugs,
  runAcceptanceSweep,
} from './live-acceptance.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`)
  }
}

type ResponseOverride = (url: URL, call: number) => Response | undefined

function fixtureFetcher(
  override?: ResponseOverride,
): NonNullable<AcceptanceSweepOptions['fetcher']> {
  const calls = new Map<string, number>()
  return (input) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const key = `${url.pathname}${url.search}`
    const call = (calls.get(key) ?? 0) + 1
    calls.set(key, call)
    const overridden = override?.(url, call)
    if (overridden) return Promise.resolve(overridden)

    if (url.pathname === '/') {
      return Promise.resolve(
        new Response('<script type="module" src="/app.js?v=abc123"></script>', { status: 200 }),
      )
    }

    const endpoint = url.pathname.split('/').slice(4).join('/')
    const bodies: Record<string, unknown> = {
      config: { branding: { productName: 'Fisheries Research' } },
      counters: { resources: 12, paragraphs: 30, sentences: 80, indexMb: 1.5 },
      catalog: { items: [], total: 12 },
      facets: { topic: { fisheries: 12 } },
      labelsets: [
        { id: 'topic', title: 'Topic', multiple: true, labels: ['fisheries'] },
      ],
      'graph/relations': {
        nodes: [
          { id: 'abalone', group: url.searchParams.has('includeBuiltin') ? 'SPECIES' : 'Species' },
          { id: 'reef', group: 'Habitats' },
        ],
        edges: [{ source: 'abalone', target: 'reef', label: 'lives in' }],
      },
      search: {
        query: url.searchParams.get('q'),
        resources: [{ id: 'one' }],
        relatedQuestions: [],
      },
      suggest: [{ id: 'question-1', text: 'What is known about abalone?' }],
      'docs/search': {
        query: url.searchParams.get('q'),
        resources: [{ id: 'help-one' }],
        relatedQuestions: [],
      },
    }
    return Promise.resolve(Response.json(bodies[endpoint], { status: 200 }))
  }
}

Deno.test('parseTenantSlugs accepts comma or whitespace separators and removes duplicates', () => {
  assertEquals(parseTenantSlugs('marine, grains\nmarine'), ['marine', 'grains'])
})

Deno.test('parseTenantSlugs rejects empty or unsafe tenant values', () => {
  for (const value of ['', '../admin', 'MARINE']) {
    let message = ''
    try {
      parseTenantSlugs(value)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(message.length > 0, `Expected ${JSON.stringify(value)} to be rejected`)
  }
})

Deno.test('runAcceptanceSweep validates the public shell and each tenant endpoint', async () => {
  const results = await runAcceptanceSweep({
    baseUrl: 'https://portal.example.test',
    tenantSlugs: ['marine'],
    fetcher: fixtureFetcher(),
    attempts: 1,
  })

  assertEquals(results.length, 11)
  assert(results.every((result) => result.ok), JSON.stringify(results))
})

Deno.test('runAcceptanceSweep retries transient failures before reporting success', async () => {
  const results = await runAcceptanceSweep({
    baseUrl: 'https://portal.example.test',
    tenantSlugs: ['marine'],
    fetcher: fixtureFetcher((url, call) => {
      if (url.pathname.endsWith('/counters') && call < 3) {
        return new Response('unavailable', { status: 503, statusText: 'Unavailable' })
      }
      return undefined
    }),
    attempts: 3,
    retryDelayMs: 1,
    sleep: () => Promise.resolve(),
  })

  const counters = results.find((result) => result.name.endsWith('corpus counters'))
  assert(counters?.ok, JSON.stringify(counters))
  assertEquals(counters.attempts, 3)
})

Deno.test('runAcceptanceSweep reports independent contract regressions together', async () => {
  const results = await runAcceptanceSweep({
    baseUrl: 'https://portal.example.test',
    tenantSlugs: ['marine'],
    fetcher: fixtureFetcher((url) => {
      if (url.pathname.endsWith('/config')) return Response.json({ branding: {} })
      if (url.pathname.endsWith('/graph/relations') && url.searchParams.has('includeBuiltin')) {
        return Response.json({
          nodes: [
            { id: 'abalone', group: 'Species' },
            { id: 'reef', group: 'Habitats' },
          ],
          edges: [{ source: 'abalone', target: 'reef', label: 'lives in' }],
        })
      }
      return undefined
    }),
    attempts: 1,
  })

  assertEquals(
    results.filter((result) => !result.ok).map((result) => result.name),
    ['marine: config branding', 'marine: built-in NER graph'],
  )
})
