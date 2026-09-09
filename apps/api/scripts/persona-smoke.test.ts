import { expect } from '@std/expect'
import { selectedJourneys } from './persona-smoke.ts'

Deno.test('persona smoke selects the real demo corpus journey', () => {
  const journeys = selectedJourneys('demo')
  expect(journeys).toHaveLength(1)
  expect(journeys[0]?.searchTerm).toBe('citations')
  expect(journeys[0]?.goodAsk).toBe('How can I check the sources and confidence of an answer?')
})

Deno.test('persona smoke refuses empty and unknown selections instead of a false 0/0 pass', () => {
  for (const selection of ['', ' , ', 'typo', 'opax,typo']) {
    expect(() => selectedJourneys(selection)).toThrow()
  }
  expect(selectedJourneys(' opax, demo ').map((journey) => journey.slug)).toEqual(['opax', 'demo'])
})
