import { expect } from '@std/expect'
import { launch } from '@astral/astral'
import { startTestServer } from './support/test-server.ts'
import { assertCurrentBuild, captureBoundary } from './support/rbac-fixture.ts'
import { DoubleProvider } from './support/double-provider.ts'
import { createPortalLocale } from '../apps/web/src/lib/portal-locale.tsx'
import type { BuildAppOptions } from '../apps/api/src/app.ts'
import type { SearchResults, TenantConfig } from '@research-portal/core'
import { EnrichmentStore } from '../apps/api/src/enrichments.ts'
import { SUGGESTED_QUESTIONS_SCHEMA_ID } from '../apps/api/src/suggested-questions.ts'

/** Known catalog keys are authored source values, never translation inputs. */
export class JapaneseResearchProvider extends DoubleProvider {
  constructor() {
    super()
    this.resources = [{
      id: 'Library',
      title: 'Summary {count}',
      summary: 'Library. Original English abstract. 日本語の原文。',
      keyFacts: [],
      type: 'document',
      topicIds: ['stock-assessment'],
      authors: ['Library', 'Summary'],
      journal: 'Summary',
      sourceName: 'Library {name}.txt',
      published: '2026-10-16',
    }]
  }
  override search(_tenant: TenantConfig, query: string): Promise<SearchResults> {
    return Promise.resolve({
      query,
      resources: this.resources.map((resource) => ({
        ...resource,
        relevance: 0.91,
        citedCount: 0,
        matchedPassage: resource.summary,
      })),
      relatedQuestions: [],
    })
  }
  override suggest() {
    return Promise.resolve([])
  }
}

export function japaneseResearchFixture() {
  const calls: string[] = []
  const management = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      calls.push(String(method))
      switch (method) {
        case 'thumbnailResponse':
          return Promise.resolve(new Response(null, { status: 404 }))
        case 'counters':
          return Promise.resolve({ resources: 1, paragraphs: 1, sentences: 2, indexMb: 0 })
        case 'resourceContent':
          return Promise.resolve({
            id: String(args[1]),
            title: 'Summary {count}',
            kind: 'text',
            texts: [{
              fieldId: 'native_source',
              text: 'Library. Original English evidence. 日本語の原文。',
            }],
            transcript: [],
            files: [],
          })
        case 'resourceExtraction':
          return Promise.resolve({
            text: 'Library. Original English evidence. 日本語の原文。',
            chars: 55,
            paragraphs: 1,
            tableRows: 0,
            status: 'PROCESSED',
          })
        case 'relationsGraph':
          return Promise.resolve({
            nodes: [{ id: 'Library', group: 'Summary', weight: 2 }, {
              id: 'Summary',
              group: 'Summary',
              weight: 1,
            }],
            edges: [{ source: 'Library', target: 'Summary', label: 'Original relation' }],
          })
        case 'graphData':
          return Promise.resolve({
            nodes: [{ id: 'stock-assessment', label: 'Summary', group: 'primary', weight: 1 }],
            edges: [],
          })
        case 'typeahead':
          return Promise.resolve({ entities: ['Library'], titles: ['Summary {count}'] })
        case 'entityGroups':
          return Promise.resolve([{ label: 'Summary', entities: ['Library', 'Summary'] }])
        case 'recentResources':
          return Promise.resolve([])
        case 'invalidate':
          return undefined
        case 'listResources':
          return Promise.resolve([{ id: 'Library', title: 'Summary {count}' }])
        case 'listAgents':
        case 'agentConfigs':
        case 'labelsets':
          return Promise.resolve([])
        default:
          return Promise.reject(new Error(`Unimplemented fixture operation: ${String(method)}`))
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
  const server = startTestServer({
    identity: { role: 'owner' },
    provider: new JapaneseResearchProvider(),
    management,
  })
  server.tenants.patch('marine', {
    languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
    topics: [{
      id: 'stock-assessment',
      label: 'Summary',
      description: 'Original source category.',
    }],
    suggestedQuestions: [],
  })
  // A reviewed empty cache keeps this visual-only journey from starting the
  // reader's normal cold-cache question generation, even against the double.
  new EnrichmentStore(server.directory).put('marine', 'Library', {
    schemaId: SUGGESTED_QUESTIONS_SCHEMA_ID,
    generatedAt: '2026-10-16T00:00:00.000Z',
    data: { questions: [] },
  })
  return { server, calls }
}

Deno.test('research routes retain authored known-key evidence in Japanese and English at wide390 light dark22px', async () => {
  const { server, calls } = japaneseResearchFixture()
  const browser = await launch()
  const page = await browser.newPage(`${server.url}/t/marine/library`)
  try {
    await page.waitForSelector('#library-search')
    await assertCurrentBuild(page)
    for (const language of ['ja', 'en'] as const) {
      const { ui } = createPortalLocale(language)
      await page.evaluate(
        (language) =>
          document.querySelector<HTMLButtonElement>(`button[lang="${language}"]`)!.click(),
        { args: [language] },
      )
      for (const dark of [false, true]) {
        await page.evaluate(
          (label) =>
            document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click(),
          { args: [ui(dark ? 'Switch to dark mode' : 'Switch to light mode')] },
        )
        for (const width of [1440, 390]) {
          for (
            const [route, selector, expected] of [
              ['library', '#library-search', 'Sort'],
              ['library/Library', 'main h1', 'Summarise the key findings'],
              ['ask', 'textarea', 'Ask a question'],
              ['search?q=research&answer=0', '#search-query', 'Hybrid'],
              [
                'generate',
                '#generate-query',
                "Schema-enforced research artifacts, grounded in the portal's content.",
              ],
              ['assessment', '#assessment-topic', 'Choose a knowledge area'],
              ['graph', '[aria-busy]', 'Knowledge map'],
              [
                'taxonomy',
                'main h1',
                'Categories used to classify resources. Counts reflect indexed content.',
              ],
              ['investigations', 'main h1', 'Start investigation'],
              ['tools', 'main h1', 'How to connect an MCP client'],
            ] as const
          ) {
            await page.goto(`${server.url}/t/marine/${route}`)
            await page.waitForSelector(selector)
            if (route === 'library' || route.startsWith('search')) {
              await page.waitForSelector('a[href^="/t/marine/library/Library"]')
            }
            const text = await page.evaluate(() => document.body.innerText)
            expect(text.toLowerCase()).toContain(ui(expected).toLowerCase())
            if (route.startsWith('library') || route.startsWith('search')) {
              expect(text).toContain('Summary {count}')
            }
            if (route === 'generate') {
              expect(
                await page.evaluate(() =>
                  document.querySelector<HTMLTextAreaElement>('#generate-query')!.placeholder
                ),
              ).toBe(ui('e.g. Compare two approaches from the research'))
              expect(text).toContain(ui('{value1} artifacts', { value1: ui('Comparison') }))
            }
            await captureBoundary(
              page,
              '.planning/logs/japanese-research-ui/visual',
              `${language}-${dark ? 'dark' : 'light'}-${width}-${
                route.split('?')[0]!.replaceAll('/', '-')
              }`,
              width,
            )
            if (route === 'library/Library') {
              const back = await page.evaluate((label) => {
                const link = [...document.querySelectorAll<HTMLAnchorElement>('main a')]
                  .find((element) => element.getAttribute('aria-label') === label)!
                return { text: link.innerText, width: link.clientWidth, scroll: link.scrollWidth }
              }, { args: [ui('Back to library')] })
              expect(back.scroll).toBeLessThanOrEqual(back.width + 1)
              if (language === 'ja' && width === 390) expect(back.text).toContain('戻る')
            }
          }
        }
      }
    }
    expect(calls.filter((call) => call === 'askStructured' || call === 'ask')).toEqual([])
    expect(server.providerCalls.filter((call) => call === 'ask')).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await server.close()
  }
})
