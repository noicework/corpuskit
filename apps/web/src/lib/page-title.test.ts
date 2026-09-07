import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { pageTitle, surfaceName } from './page-title.ts'

describe('per-route page titles (D6-14)', () => {
  it('names every surface of a portal', () => {
    expect(surfaceName('/t/neuro')).toBeUndefined()
    expect(surfaceName('/t/neuro/')).toBeUndefined()
    expect(surfaceName('/t/neuro/search')).toBe('Search')
    expect(surfaceName('/t/neuro/library')).toBe('Library')
    expect(surfaceName('/t/neuro/library/9cb1d5d7')).toBe('Document')
    expect(surfaceName('/t/neuro/ask')).toBe('Ask')
    expect(surfaceName('/t/neuro/ask/session-1')).toBe('Ask')
    expect(surfaceName('/t/neuro/investigations')).toBe('Investigations')
    expect(surfaceName('/t/neuro/investigations/abc')).toBe('Investigation')
    expect(surfaceName('/t/neuro/generate')).toBe('Generate')
    expect(surfaceName('/t/neuro/assessment')).toBe('Assessment')
    expect(surfaceName('/t/neuro/graph')).toBe('Knowledge graph')
    expect(surfaceName('/t/neuro/tools')).toBe('Tools')
    expect(surfaceName('/t/neuro/help')).toBe('Help')
    expect(surfaceName('/t/neuro/help/trust-and-citations')).toBe('Help')
    expect(surfaceName('/t/neuro/how-it-works')).toBe('How this works')
    expect(surfaceName('/t/neuro/taxonomy')).toBe('Taxonomy')
  })

  it('names an entity page for its entity', () => {
    expect(surfaceName('/t/neuro/entity/Levetiracetam')).toBe('Levetiracetam')
    expect(surfaceName('/t/neuro/entity/anti-LGI1%20encephalitis')).toBe('anti-LGI1 encephalitis')
  })

  it('falls back to the product name alone, never to a broken suffix', () => {
    expect(pageTitle('/t/neuro', 'Neurology Research Portal')).toBe('Neurology Research Portal')
    expect(pageTitle('/t/neuro/library', 'Neurology Research Portal')).toBe(
      'Library | Neurology Research Portal',
    )
    expect(pageTitle('/t/neuro/nowhere', 'Neurology Research Portal')).toBe(
      'Neurology Research Portal',
    )
  })
})
