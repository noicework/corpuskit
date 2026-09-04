import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  DEFAULT_RESEARCH_ENRICHMENT,
  enrichmentJsonSchema,
  EnrichmentSchema,
  enrichmentString,
  parseEnrichmentData,
} from './index.ts'

/**
 * The default enrichment schema (title/summary/key takeaways/quotes) and the
 * pure helpers that derive its JSON schema and coerce a generated object into
 * clean, renderable data - the merchandising foundation displayed everywhere.
 */

describe('enrichmentJsonSchema', () => {
  const schema = enrichmentJsonSchema(DEFAULT_RESEARCH_ENRICHMENT)

  it('derives an OpenAI-function-style schema with one property per field', () => {
    const props = schema.parameters.properties as Record<string, { type: string }>
    expect(Object.keys(props).sort()).toEqual(
      ['keyTakeaways', 'quotesOfInterest', 'summary', 'title'],
    )
  })

  it('types list/quote fields as string arrays and title/summary as strings', () => {
    const props = schema.parameters.properties as Record<string, { type: string; items?: unknown }>
    expect(props.title?.type).toBe('string')
    expect(props.summary?.type).toBe('string')
    expect(props.keyTakeaways?.type).toBe('array')
    expect(props.quotesOfInterest?.type).toBe('array')
  })

  it('requires exactly the load-bearing display fields (title, summary)', () => {
    expect((schema.parameters.required as string[]).sort()).toEqual(['summary', 'title'])
  })

  it('produces a function name free of hyphens (schema-name constraint)', () => {
    expect(schema.name).toBe('research_summary')
  })
})

describe('parseEnrichmentData', () => {
  it('coerces a well-formed object, trimming strings and dropping empty list items', () => {
    const data = parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, {
      title: '  Prawn disease management  ',
      summary: 'A study of white spot.',
      keyTakeaways: ['Finding one', '', '  Finding two  '],
      quotesOfInterest: ['"A verbatim quote"'],
    })
    expect(data.title).toBe('Prawn disease management')
    expect(data.keyTakeaways).toEqual(['Finding one', 'Finding two'])
    expect(data.quotesOfInterest).toEqual(['"A verbatim quote"'])
  })

  it('fills missing fields with empty defaults rather than throwing', () => {
    const data = parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, { title: 'Only a title' })
    expect(data.summary).toBe('')
    expect(data.keyTakeaways).toEqual([])
    expect(data.quotesOfInterest).toEqual([])
  })

  it('drops unknown keys and survives a non-object input', () => {
    expect(parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, null).title).toBe('')
    const data = parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, { title: 'T', bogus: 1 })
    expect('bogus' in data).toBe(false)
  })

  it('coerces a non-array list field to an empty array', () => {
    const data = parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, { keyTakeaways: 'not an array' })
    expect(data.keyTakeaways).toEqual([])
  })

  it('produces data that validates as a stored Enrichment', () => {
    const data = parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, { title: 'T', summary: 'S' })
    const parsed = EnrichmentSchema.safeParse({
      schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
      generatedAt: new Date().toISOString(),
      data,
    })
    expect(parsed.success).toBe(true)
  })
})

describe('enrichmentString (programmatic field selection by kind)', () => {
  const data = parseEnrichmentData(DEFAULT_RESEARCH_ENRICHMENT, {
    title: 'A real title',
    summary: 'A real summary.',
  })

  it('reads the title-kind field without a hardcoded key', () => {
    expect(enrichmentString(DEFAULT_RESEARCH_ENRICHMENT, data, 'title')).toBe('A real title')
  })

  it('reads the summary-kind field without a hardcoded key', () => {
    expect(enrichmentString(DEFAULT_RESEARCH_ENRICHMENT, data, 'summary')).toBe('A real summary.')
  })

  it('returns empty string when the value is absent', () => {
    expect(enrichmentString(DEFAULT_RESEARCH_ENRICHMENT, {}, 'title')).toBe('')
  })
})
