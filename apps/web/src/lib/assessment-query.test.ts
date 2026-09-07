import { expect } from '@std/expect'
import { buildAssessmentBrief, buildAssessmentQuery, isUsableTopic } from './assessment-query.ts'

Deno.test('a typed topic feeds the same query template as a tile (P8-05)', () => {
  const fromTile = buildAssessmentQuery('Autoimmune encephalitis')
  const fromText = buildAssessmentQuery('  Autoimmune encephalitis ')
  expect(fromText).toBe(fromTile)
  expect(fromTile).toContain('Autoimmune encephalitis: the findings, figures')
})

Deno.test('the retrieval text reads like the results it should retrieve, not like an instruction (D1-20)', () => {
  const query = buildAssessmentQuery('Clinical Trials')
  expect(query).not.toMatch(/quiz|generate|questions/i)
  const brief = buildAssessmentBrief('Clinical Trials', 5, 'intermediate')
  // Three spare, so five survive the portal's quote check (D6-09, D7-11).
  expect(brief).toContain('8 multiple-choice questions at intermediate depth')
  expect(brief).toContain('at least 5 must be answerable from a passage you quote verbatim')
  expect(brief).toContain('within Clinical Trials')
})

Deno.test('intermediate and advanced depths ask for numeric or comparative stems (P8-11)', () => {
  expect(buildAssessmentBrief('Dravet syndrome', 3, 'foundational')).not.toContain('comparison')
  expect(buildAssessmentBrief('Dravet syndrome', 3, 'intermediate')).toContain(
    'numeric or comparative stems',
  )
  expect(buildAssessmentBrief('Dravet syndrome', 10, 'advanced')).toContain('confidence interval')
})

Deno.test('topic usability guards the free-text box', () => {
  expect(isUsableTopic('')).toBe(false)
  expect(isUsableTopic('ab')).toBe(false)
  expect(isUsableTopic('SCN1A')).toBe(true)
  expect(isUsableTopic('x'.repeat(121))).toBe(false)
})
