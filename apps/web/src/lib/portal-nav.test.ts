import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { portalNavigation } from './portal-nav.ts'

const items = ['library', 'ask', 'graph', 'tools', 'investigations', 'generate', 'assessment']
  .map((id) => ({ id }))

describe('portalNavigation', () => {
  it('keeps every built-in item and adds nothing without a layout', () => {
    expect(portalNavigation(items, undefined)).toEqual({ items, links: [] })
    expect(portalNavigation(items, {})).toEqual({ items, links: [] })
  })

  it('hides the items the layout names and appends its links after the rest', () => {
    const links = [
      { label: 'Events', href: 'https://example.org/events' },
      { label: 'People', href: '/people' },
    ]
    const result = portalNavigation(items, { nav: { hide: ['graph', 'generate'], links } })
    expect(result.items.map((item) => item.id)).toEqual([
      'library',
      'ask',
      'tools',
      'investigations',
      'assessment',
    ])
    expect(result.links).toEqual(links)
  })

  it('never hides an item the reader could not open anyway, nor adds one back', () => {
    const permitted = items.filter((item) => item.id !== 'generate')
    expect(
      portalNavigation(permitted, { nav: { hide: ['tools'] } }).items.map((item) => item.id),
    ).toEqual(['library', 'ask', 'graph', 'investigations', 'assessment'])
  })
})
