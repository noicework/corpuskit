import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  assignCitationIndices,
  parseCitationRanges,
  spliceCitationMarkers,
  stripInlineMarkers,
} from './citations.ts'

const titleFor = (id: string): string | undefined =>
  ({ 'res-a': 'Report A', 'res-b': 'Report B', 'res-c': 'Report C' })[id]

describe('stripInlineMarkers', () => {
  it('removes bracketed 1-3 digit markers and any leading space', () => {
    expect(stripInlineMarkers('Yields rose 12% [1]. Rainfall fell [22].')).toBe(
      'Yields rose 12%. Rainfall fell.',
    )
  })

  it('removes grouped markers like [2, 1, 19] the model writes despite the prompt', () => {
    expect(stripInlineMarkers('Risk assessments help [2, 1, 19]. See also [4,7].')).toBe(
      'Risk assessments help. See also.',
    )
  })

  it('leaves a 4-digit bracket (e.g. a year) untouched', () => {
    expect(stripInlineMarkers('Published in [2026].')).toBe('Published in [2026].')
    expect(stripInlineMarkers('Surveys ran over [2020, 2021].')).toBe(
      'Surveys ran over [2020, 2021].',
    )
  })

  it('is a no-op on text with no markers', () => {
    expect(stripInlineMarkers('No citations here.')).toBe('No citations here.')
  })
})

describe('parseCitationRanges', () => {
  it('extracts resourceId and end offset from each range pair', () => {
    const map = { 'res-a/text/body/0-20': [[0, 20], [40, 55]] }
    expect(parseCitationRanges(map)).toEqual([
      { resourceId: 'res-a', end: 20 },
      { resourceId: 'res-a', end: 55 },
    ])
  })

  it('skips DA-generated fields', () => {
    const map = { 'res-a/text/da-summary/0-10': [[0, 10]] }
    expect(parseCitationRanges(map)).toEqual([])
  })

  it('skips malformed entries without throwing', () => {
    const map = {
      'res-a/text/body/x': [[0, 10]],
      'res-b/text/body/y': 'not-an-array',
      'res-c/text/body/z': [[0, 'nope'], [5]],
    } as unknown as Record<string, unknown>
    expect(parseCitationRanges(map)).toEqual([{ resourceId: 'res-a', end: 10 }])
  })
})

describe('assignCitationIndices', () => {
  it('numbers resources 1..N in citations-map key order, deduped', () => {
    const map = {
      'res-b/text/body/0-5': [[0, 5]],
      'res-a/text/body/10-15': [[10, 15]],
      'res-b/text/body/20-25': [[20, 25]],
    }
    expect(assignCitationIndices(map, titleFor)).toEqual([
      { index: 1, resourceId: 'res-b', title: 'Report B' },
      { index: 2, resourceId: 'res-a', title: 'Report A' },
    ])
  })

  it('falls back to the resource id when no title resolves', () => {
    const map = { 'res-z/text/body/0-5': [[0, 5]] }
    expect(assignCitationIndices(map, titleFor)).toEqual([
      { index: 1, resourceId: 'res-z', title: 'res-z' },
    ])
  })
})

describe('spliceCitationMarkers', () => {
  it('zero citations: strips any hallucinated markers, returns no citations', () => {
    const raw = 'Yields rose sharply [1] according to the report.'
    const result = spliceCitationMarkers(raw, {}, titleFor)
    expect(result.citations).toEqual([])
    expect(result.text).toBe('Yields rose sharply according to the report.')
  })

  it('model numbering matches platform order: markers land at the platform offsets', () => {
    // Model wrote [1] for res-a and [2] for res-b, and the platform's map
    // agrees on that same order (res-a first, res-b second).
    const raw = 'Rainfall was average [1]. Yields still rose [2].'
    const averageEnd = raw.indexOf('average') + 'average'.length
    const roseEnd = raw.indexOf('rose') + 'rose'.length
    const map = {
      'res-a/text/body/0': [[0, averageEnd]],
      'res-b/text/body/0': [[0, roseEnd]],
    }
    const result = spliceCitationMarkers(raw, map, titleFor)
    expect(result.citations).toEqual([
      { index: 1, resourceId: 'res-a', title: 'Report A' },
      { index: 2, resourceId: 'res-b', title: 'Report B' },
    ])
    // The model's own markers are gone; the spliced text carries the
    // authoritative numbers in the right order, and every [n] in the output
    // resolves to a citation that exists.
    const markers = [...result.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    expect(markers).toEqual([1, 2])
    expect(result.text).toContain('average[1]')
    expect(result.text).toContain('rose[2]')
  })

  it('model numbering diverges from platform order: the platform order wins', () => {
    // The model labelled the "rose" claim as [1] and the "average" claim as
    // [2] - but the platform's citations map keys res-a (the "average"
    // source) FIRST, so the authoritative numbering must be the reverse of
    // what the model itself wrote.
    const raw = 'Yields still rose [1]. Rainfall was average [2].'
    const roseEnd = raw.indexOf('rose') + 'rose'.length
    const averageEnd = raw.indexOf('average') + 'average'.length
    const map = {
      // res-a is keyed first even though its claim appears second in the text.
      'res-a/text/body/0': [[0, averageEnd]],
      'res-b/text/body/0': [[0, roseEnd]],
    }
    const result = spliceCitationMarkers(raw, map, titleFor)
    expect(result.citations).toEqual([
      { index: 1, resourceId: 'res-a', title: 'Report A' },
      { index: 2, resourceId: 'res-b', title: 'Report B' },
    ])
    // res-b's marker sits right after "rose" and must read [2] (platform
    // numbering), even though the model itself wrote [1] there.
    const roseMarkerPos = result.text.indexOf('rose') + 'rose'.length
    expect(result.text.slice(roseMarkerPos, roseMarkerPos + 3)).toBe('[2]')
    // res-a's marker sits right after "average" and must read [1].
    const averageMarkerPos = result.text.indexOf('average') + 'average'.length
    expect(result.text.slice(averageMarkerPos, averageMarkerPos + 3)).toBe('[1]')
  })

  it('citations with and without offsets: only offset-bearing ones get a marker', () => {
    const raw = 'A synthesised claim with no single supporting sentence.'
    const map = {
      // res-a has a real offset; res-b appears in the map (so it must still
      // get a stable index for the evidence table) but with no numeric range.
      'res-a/text/body/0': [[0, 10]],
      'res-b/text/body/0': [],
    }
    const result = spliceCitationMarkers(raw, map, titleFor)
    expect(result.citations).toEqual([
      { index: 1, resourceId: 'res-a', title: 'Report A' },
      { index: 2, resourceId: 'res-b', title: 'Report B' },
    ])
    expect(result.text).toContain('[1]')
    expect(result.text).not.toContain('[2]')
  })

  it('multiple ranges for the same resource all carry its one index', () => {
    const raw = 'First point noted. Second point noted too.'
    const map = { 'res-a/text/body/0': [[0, 18], [19, 43]] }
    const result = spliceCitationMarkers(raw, map, titleFor)
    expect(result.citations).toEqual([{ index: 1, resourceId: 'res-a', title: 'Report A' }])
    const markers = [...result.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    expect(markers).toEqual([1, 1])
  })

  it('offsets past the end of the text are clamped, not thrown', () => {
    const raw = 'Short answer.'
    const map = { 'res-a/text/body/0': [[0, 9999]] }
    const result = spliceCitationMarkers(raw, map, titleFor)
    expect(result.text).toBe('Short answer.[1]')
  })
})
