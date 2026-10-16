import { expect } from '@std/expect'
import { recommendMethod } from '../../../api/src/extraction.ts'
import type { ExtractionClass, ExtractionMethod } from '@research-portal/core'
import { createPortalLocale } from './portal-locale.tsx'
import { extractionReason } from './extraction-copy.ts'

Deno.test('extraction explanation projects every existing recommendation branch without choosing methods', () => {
  const english = createPortalLocale('en'), japanese = createPortalLocale('ja')
  const method = (id: string, kind: ExtractionMethod['kind']): ExtractionMethod => ({
    id,
    kind,
    name: id === 'best' ? 'Summary {name}' : 'Library <method>',
  })
  const cases: { cls: ExtractionClass; results: Parameters<typeof recommendMethod>[1] }[] = [
    {
      cls: 'image-only',
      results: [{
        method: method('best', 'default'),
        metrics: { judgeScore: null, tableRows: 0, chars: 1 },
      }],
    },
    {
      cls: 'prose',
      results: [{
        method: method('best', 'default'),
        metrics: { judgeScore: 4, tableRows: 0, chars: 1 },
      }],
    },
    {
      cls: 'tables',
      results: [{
        method: method('best', 'tables'),
        metrics: { judgeScore: 4, tableRows: 12, chars: 1 },
      }],
    },
    {
      cls: 'tables',
      results: [
        {
          method: method('preferred', 'tables'),
          metrics: { judgeScore: 3.5, tableRows: 12, chars: 1 },
        },
        { method: method('best', 'default'), metrics: { judgeScore: 4, tableRows: 0, chars: 1 } },
      ],
    },
    {
      cls: 'prose',
      results: [
        {
          method: method('preferred', 'default'),
          metrics: { judgeScore: 3.5, tableRows: 0, chars: 1 },
        },
        { method: method('best', 'tables'), metrics: { judgeScore: 4, tableRows: 0, chars: 1 } },
      ],
    },
    {
      cls: 'image-only',
      results: [
        {
          method: method('preferred', 'visual'),
          metrics: { judgeScore: 1, tableRows: 0, chars: 1 },
        },
        { method: method('best', 'default'), metrics: { judgeScore: 5, tableRows: 0, chars: 1 } },
      ],
    },
  ]
  for (const item of cases) {
    const input = structuredClone(item.results)
    const recommendation = recommendMethod(item.cls, item.results)!
    expect(extractionReason(recommendation.reason, english.ui)).toBe(recommendation.reason)
    const translated = extractionReason(recommendation.reason, japanese.ui)
    expect(translated).not.toBe(recommendation.reason)
    expect(translated).toContain('Summary {name}')
    if (recommendation.reason.includes('Library <method>')) {
      expect(translated).toContain('Library <method>')
    }
    expect(item.results).toEqual(input)
  }
  // Unrecognised or authored diagnostic text is retained, including a catalog-key collision.
  expect(extractionReason('Summary', japanese.ui)).toBe('Summary')
  expect(extractionReason('Original {count} <method>', japanese.ui)).toBe(
    'Original {count} <method>',
  )
})
