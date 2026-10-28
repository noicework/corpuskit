import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { pageTitle, surfaceName } from './page-title.ts'
import { createPortalLocale } from './portal-locale.tsx'
import { missingPortalMessages } from './locale-messages.ts'

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
    expect(surfaceName('/t/neuro/accessibility')).toBe('Accessibility')
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

  it('localises only fixed surface labels and keeps authored known keys and braces verbatim', () => {
    const { ui } = createPortalLocale('ja')
    expect(pageTitle('/t/neuro/library', 'Summary {name}', ui)).toBe('ライブラリ | Summary {name}')
    expect(pageTitle('/t/neuro/manage', 'Library', ui)).toBe('管理 | Library')
    expect(pageTitle('/t/neuro/entity/Library', 'Summary {name}', ui)).toBe(
      'Library | Summary {name}',
    )
    expect(pageTitle('/t/neuro/entity/Summary%20%7Bname%7D', 'Library', ui)).toBe(
      'Summary {name} | Library',
    )
    expect(pageTitle('/t/neuro/entity/%E0%A4%A', 'Library', ui)).toBe('エンティティ | Library')
    expect(pageTitle('/t/neuro', 'Summary {name}', ui)).toBe('Summary {name}')
    expect(pageTitle('/t/neuro/unknown', 'Library', ui)).toBe('Library')
    const routes = [
      'ask',
      'search',
      'library/doc',
      'library',
      'investigations/id',
      'investigations',
      'agentic',
      'generate',
      'assessment',
      'graph',
      'tools',
      'help',
      'how-it-works',
      'accessibility',
      'taxonomy',
      'manage',
    ]
    expect(missingPortalMessages(routes.map((route) => surfaceName(`/t/neuro/${route}`)!)))
      .toEqual([])
    // Default callers retain the exact English title contract.
    expect(pageTitle('/t/neuro/manage', 'Library')).toBe('Manage | Library')
  })
})
