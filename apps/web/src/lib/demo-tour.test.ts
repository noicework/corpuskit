import { expect } from '@std/expect'
import {
  DEFAULT_SCENE_IDS,
  federatedAsk,
  forgetTourProgress,
  graphKinds,
  needsFirstPdf,
  rememberTourProgress,
  resolveScenes,
  startsOnArrival,
  tourProgress,
} from './demo-tour.ts'

const english = (text: string, values?: Readonly<Record<string, string | number>>) =>
  text.replace(
    /\{(\w+)\}/g,
    (whole, key: string) => values && key in values ? String(values[key]) : whole,
  )

const config = {
  branding: { productName: 'Example Portal', organisation: 'Example User Group' },
  entityTypes: [
    { id: 'topic', label: 'Topic', colour: '#123456' },
    { id: 'region', label: 'Region', colour: '#123456' },
    { id: 'author', label: 'Author', colour: '#123456' },
  ],
}

Deno.test('the built-in script: answers, the evidence, the Graph and your own tools', () => {
  const scenes = resolveScenes(config, 'pdf-1', english)
  expect(scenes.map((scene) => scene.id)).toEqual(DEFAULT_SCENE_IDS)
  expect(scenes.map((scene) => [scene.title, scene.href, scene.action])).toEqual([
    ['Find answers and sources', '/ask', 'Ask a question'],
    ['Follow the evidence', '/library/pdf-1', 'View a publication'],
    ['Visualise connections', '/graph', 'Open Graph'],
    ['Bring your own tools', '/tools', 'Open Tools'],
  ])
  expect(scenes[0]!.body.startsWith('Example Portal answers your questions')).toBe(true)
  expect(scenes[0]!.question).toBeUndefined()
  expect(scenes[2]!.body).toBe('The Graph maps links between topic, region and author.')
  expect(scenes[3]!.body).toContain(
    'to Example Portal through its Model Context Protocol (MCP) connector',
  )
})

Deno.test('a collection without a PDF browses the Library, and a Graph without kinds says so', () => {
  const noPdf = resolveScenes(config, null, english)[1]!
  expect([noPdf.href, noPdf.action]).toEqual(['/library', 'Browse the Library'])
  const bare = resolveScenes({ ...config, entityTypes: [] }, null, english)
  expect(bare[2]!.body).toBe(
    'The Graph maps links between topics, entities and the documents that connect them.',
  )
  expect(graphKinds({ entityTypes: [{ id: 'e', label: 'EEG', colour: '#000' }] }, english)).toBe(
    'EEG',
  )
})

Deno.test("a portal's scene list, words and targets replace the built-in ones", () => {
  const scenes = resolveScenes(
    {
      ...config,
      copy: {
        demoTour: {
          scenes: [
            { id: 'gaps', title: 'Ask the unanswerable', question: 'What is on next year?' },
            { id: 'participation' },
            { id: 'cited-page', href: '/library/report-7?page=4' },
            { id: 'mcp', href: 'https://example.org/agents', body: 'Our own agent guide.' },
            { id: 'federated', title: 'Federate' },
            { id: 'provenance' },
          ],
        },
      },
    },
    'pdf-1',
    english,
  )
  expect(scenes.map((scene) => [scene.id, scene.title, scene.href, scene.asks])).toEqual([
    ['gaps', 'Ask the unanswerable', '/ask?ask=What%20is%20on%20next%20year%3F', true],
    ['participation', 'See which collections were used', '/agent', false],
    ['cited-page', 'Follow the evidence', '/library/report-7?page=4', false],
    ['mcp', 'Bring your own tools', 'https://example.org/agents', false],
    ['federated', 'Federate', '/ask', false],
    ['provenance', 'See where an answer came from', '/ask', false],
  ])
  expect(scenes[3]!.body).toBe('Our own agent guide.')
  expect(scenes.map((scene) => scene.action)).toEqual([
    'Ask this question',
    'Open the answer page',
    'Open the document',
    'Open the link',
    'Ask a question',
    'Ask a question',
  ])
})

Deno.test('the first PDF is looked up only for a cited-page scene without its own link', () => {
  expect(needsFirstPdf({})).toBe(true)
  expect(needsFirstPdf({ copy: { demoTour: { scenes: [{ id: 'mcp' }] } } })).toBe(false)
  expect(
    needsFirstPdf({ copy: { demoTour: { scenes: [{ id: 'cited-page', href: '/library/x' }] } } }),
  )
    .toBe(false)
  expect(needsFirstPdf({ copy: { demoTour: { scenes: [{ id: 'cited-page' }] } } })).toBe(true)
})

Deno.test('only auto opens the tour by itself, once, and a link can force or forbid it', () => {
  expect(startsOnArrival('off', '', false)).toBe(false)
  expect(startsOnArrival('off', '?tour=1', false)).toBe(false)
  expect(startsOnArrival('request', '', false)).toBe(false)
  expect(startsOnArrival('request', '?tour=1', true)).toBe(true)
  expect(startsOnArrival('auto', '', false)).toBe(true)
  expect(startsOnArrival('auto', '', true)).toBe(false)
  expect(startsOnArrival('auto', '?tour=0', false)).toBe(false)
  expect(startsOnArrival('auto', '?q=x&tour=1', true)).toBe(true)
})

Deno.test('the welcome names research partners only where the portal takes part and has peers', () => {
  const peer = { id: 'peer-1', label: 'Partner collection', kind: 'arag-kb' }
  expect(federatedAsk(config)).toBe(false)
  expect(federatedAsk({ ...config, federation: { peers: [] } })).toBe(false)
  expect(federatedAsk({ ...config, federation: { peers: [peer] } })).toBe(true)
  expect(federatedAsk({ ...config, federation: { participates: true, peers: [peer] } })).toBe(true)
  expect(federatedAsk({ ...config, federation: { participates: false, peers: [peer] } })).toBe(
    false,
  )
})

Deno.test('an open tour is remembered for the tab by step, and forgotten when it closes', () => {
  // Deno has tab storage only under a location; without one the helpers must simply do nothing.
  expect(tourProgress('example')).toBe(null)
  rememberTourProgress('example', 2)
  forgetTourProgress('example')
  expect(tourProgress('example')).toBe(null)
})
