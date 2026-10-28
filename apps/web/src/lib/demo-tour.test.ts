import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { DEFAULT_SCENE_IDS, needsFirstPdf, resolveScenes, startsOnArrival } from './demo-tour.ts'

const english = (text: string) => text

const config: Pick<TenantConfig, 'suggestedQuestions' | 'copy'> = {
  suggestedQuestions: [
    { id: 'q1', text: 'Which talks cover upgrades?' },
    { id: 'q2', text: 'What changed last year?' },
  ],
}

Deno.test('the built-in script shows every scene but participation, each with one click', () => {
  const scenes = resolveScenes(config, 'pdf-1', english)
  expect(scenes.map((scene) => scene.id)).toEqual(DEFAULT_SCENE_IDS)
  expect(scenes.map((scene) => scene.href)).toEqual([
    '/ask?ask=Which%20talks%20cover%20upgrades%3F',
    '/ask?ask=What%20changed%20last%20year%3F',
    '/library/pdf-1',
    '/tools',
    '/ask?ask=What%20was%20published%20on%20this%20topic%20in%20the%20last%20week%3F',
  ])
  expect(scenes.map((scene) => scene.asks)).toEqual([true, true, false, false, true])
  expect(scenes.every((scene) => scene.title && scene.body)).toBe(true)
  // The button names what it does; a question is carried beside it.
  expect(scenes.map((scene) => scene.action)).toEqual([
    'Ask this question',
    'Ask this question',
    'Open the document',
    'Open Tools',
    'Ask this question',
  ])
  expect(scenes[0]!.question).toBe('Which talks cover upgrades?')
  expect(scenes[3]!.question).toBeUndefined()
})

Deno.test('a collection without a PDF opens the library, and a portal without questions asks a stock one', () => {
  expect(resolveScenes(config, null, english)[2]!.href).toBe('/library')
  const bare = resolveScenes({ suggestedQuestions: [] }, null, english)
  expect(bare[0]!.href).toBe(
    '/ask?ask=What%20are%20the%20main%20findings%20in%20this%20collection%3F',
  )
  expect(bare[1]!.href).toBe(bare[0]!.href)
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
          ],
        },
      },
    },
    'pdf-1',
    english,
  )
  expect(scenes.map((scene) => [scene.id, scene.title, scene.href, scene.asks])).toEqual([
    ['gaps', 'Ask the unanswerable', '/ask?ask=What%20is%20on%20next%20year%3F', true],
    ['participation', 'See who took part', '/agent', false],
    ['cited-page', 'Open the PDF at the cited page', '/library/report-7?page=4', false],
    ['mcp', 'Connect an external research tool over MCP', 'https://example.org/agents', false],
    ['federated', 'Federate', '/ask?ask=Which%20talks%20cover%20upgrades%3F', true],
  ])
  expect(scenes[3]!.body).toBe('Our own agent guide.')
  expect(scenes.map((scene) => scene.action)).toEqual([
    'Ask this question',
    'Open the answer',
    'Open the document',
    'Open the link',
    'Ask this question',
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
