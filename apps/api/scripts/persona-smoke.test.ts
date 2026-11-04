import { expect } from '@std/expect'
import { selectedJourneys, smokeTarget } from './persona-smoke.ts'

Deno.test('persona smoke selects the real demo corpus journey', () => {
  const journeys = selectedJourneys('demo')
  expect(journeys).toHaveLength(1)
  expect(journeys[0]?.searchTerm).toBe('citations')
  expect(journeys[0]?.goodAsk).toBe('How can I check the sources and confidence of an answer?')
})

Deno.test('persona smoke refuses empty and unknown selections instead of a false 0/0 pass', () => {
  for (const selection of ['', ' , ', 'typo', 'demo,typo']) {
    expect(() => selectedJourneys(selection)).toThrow()
  }
  expect(selectedJourneys(' marine, demo ').map((journey) => journey.slug)).toEqual([
    'marine',
    'demo',
  ])
})

Deno.test('remote persona smoke defaults to and only accepts the dedicated demo corpus', () => {
  expect(smokeTarget().base).toBe('https://demo.corpuskit.org')
  expect(smokeTarget().tenants.map((tenant) => tenant.slug)).toEqual(['demo'])
  expect(smokeTarget('https://demo.corpuskit.org/', 'demo').base).toBe('https://demo.corpuskit.org')
  for (
    const [base, tenants] of [
      ['https://corpuskit.org', 'marine'],
      ['https://corpuskit.org', 'demo'],
      ['https://demo.corpuskit.org', 'marine'],
      ['https://demo.corpuskit.org', 'demo,marine'],
      ['https://demo.corpuskit.org.evil.example', 'demo'],
      ['http://demo.corpuskit.org', 'demo'],
      ['https://demo.corpuskit.org/t/marine', 'demo'],
      ['https://user@demo.corpuskit.org', 'demo'],
      ['https://demo.corpuskit.org?tenant=marine', 'demo'],
      ['', 'demo'],
    ]
  ) expect(() => smokeTarget(base, tenants)).toThrow()
})

Deno.test('local smoke fixtures can still use the seeded showcase journeys', () => {
  expect(smokeTarget('http://127.0.0.1:8791', 'marine,grains').tenants).toHaveLength(2)
  expect(smokeTarget('http://localhost:8792', 'marine').base).toBe('http://localhost:8792')
})
