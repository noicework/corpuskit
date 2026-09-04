import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { DEFAULT_RESEARCH_ENRICHMENT, type Enrichment } from '@research-portal/core'
import {
  baselineMerchandising,
  extractPageSummary,
  fallbackTitle,
  looksLikeFilenameTitle,
  overlayEnrichment,
  sourceNameFor,
} from './merchandise.ts'

/**
 * Merchandising selection + fallback: a resource is never shown as a raw
 * filename. Stage 1 cleans the filename to a fallback and demotes the raw name;
 * stage 2 overlays a generated enrichment when one exists.
 */

describe('looksLikeFilenameTitle', () => {
  for (const t of ['1981-071-DLD.pdf', '2003-067-DLD', '2018-190.pdf', 'report.docx']) {
    it(`flags "${t}" as a filename/code`, () => expect(looksLikeFilenameTitle(t)).toBe(true))
  }
  for (const t of ['White spot disease in farmed prawns', 'Abalone stock assessment 2024']) {
    it(`does not flag the real title "${t}"`, () => expect(looksLikeFilenameTitle(t)).toBe(false))
  }
})

describe('sourceNameFor', () => {
  it('keeps a filename/code as the muted source name', () => {
    expect(sourceNameFor('1981-071-DLD.pdf')).toBe('1981-071-DLD.pdf')
  })
  it('returns undefined for a real human title (nothing to demote)', () => {
    expect(sourceNameFor('Abalone stock assessment 2024')).toBeUndefined()
  })
})

describe('fallbackTitle', () => {
  it('formats a funder-style project code', () => {
    expect(fallbackTitle('1981-071-DLD.pdf')).toBe('Project 1981-071')
    expect(fallbackTitle('2003-067-DLD')).toBe('Project 2003-067')
  })
  it('strips a file extension and tidies separators otherwise', () => {
    expect(fallbackTitle('annual_research_review.pdf')).toBe('annual research review')
  })
})

describe('baselineMerchandising (no enrichment yet)', () => {
  it('never shows a raw filename as the title; demotes it to sourceName', () => {
    const m = baselineMerchandising('1981-071-DLD.pdf', '1981-071-DLD.pdf')
    expect(m.title).toBe('Project 1981-071')
    expect(m.title).not.toContain('.pdf')
    expect(m.sourceName).toBe('1981-071-DLD.pdf')
    expect(m.enriched).toBe(false)
  })

  it('drops a summary that is merely the filename', () => {
    const m = baselineMerchandising('1981-071-DLD.pdf', '1981-071-DLD.pdf')
    // Falls back to the title rather than echoing the filename.
    expect(m.summary).toBe('Project 1981-071')
  })

  it('keeps a real title and real summary untouched, no source name', () => {
    const m = baselineMerchandising('Prawn disease review', 'A study of white spot disease.')
    expect(m.title).toBe('Prawn disease review')
    expect(m.summary).toBe('A study of white spot disease.')
    expect(m.sourceName).toBeUndefined()
  })

  it('collapses a junk/empty raw title to Untitled resource', () => {
    expect(baselineMerchandising('', '').title).toBe('Untitled resource')
  })
})

describe('overlayEnrichment (generated enrichment wins)', () => {
  const base = baselineMerchandising('1981-071-DLD.pdf', undefined)
  const enrichment: Enrichment = {
    schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
    generatedAt: '2026-08-28T00:00:00.000Z',
    data: {
      title: 'Echo-sounder and radar training for professional fishers',
      summary: 'A 1985 NSW Department of Agriculture course program on electronic fishing aids.',
      keyTakeaways: ['Covers echosounders, sonar, radar and radio', 'Financial assistance offered'],
      quotesOfInterest: ['"Participants receive financial assistance"'],
    },
  }

  it('replaces the fallback title with the generated title', () => {
    const m = overlayEnrichment(base, enrichment)
    expect(m.title).toBe('Echo-sounder and radar training for professional fishers')
    expect(m.enriched).toBe(true)
  })

  it('carries the generated summary, takeaways and quotes', () => {
    const m = overlayEnrichment(base, enrichment)
    expect(m.summary).toContain('1985 NSW Department of Agriculture')
    expect(m.keyTakeaways?.length).toBe(2)
    expect(m.quotesOfInterest?.length).toBe(1)
  })

  it('preserves the raw source name for secondary display', () => {
    expect(overlayEnrichment(base, enrichment).sourceName).toBe('1981-071-DLD.pdf')
  })

  it('returns the baseline untouched when there is no enrichment', () => {
    expect(overlayEnrichment(base, undefined)).toEqual(base)
  })

  it('keeps the fallback title if the enrichment title is empty', () => {
    const empty: Enrichment = {
      schemaId: 'research-summary',
      generatedAt: 'x',
      data: { title: '' },
    }
    expect(overlayEnrichment(base, empty).title).toBe('Project 1981-071')
    expect(overlayEnrichment(base, empty).enriched).toBe(false)
  })
})

describe('extractPageSummary (reuse the platform DA page-summary field)', () => {
  it('finds the da-pagesummary field text among extracted texts', () => {
    const texts = [
      {
        fieldId: 'texts/da-pagesummary-f-file',
        text: 'This document outlines a series of courses.',
      },
      { fieldId: 'files/file', text: 'raw OCR noise ...' },
    ]
    expect(extractPageSummary(texts)).toBe('This document outlines a series of courses.')
  })

  it('returns undefined when no DA summary field is present', () => {
    expect(extractPageSummary([{ fieldId: 'generics/title', text: '1997-410-DLD.pdf' }]))
      .toBeUndefined()
  })
})
