import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GridDensity, ViewToggle } from './ViewControls.tsx'

describe('resource view controls', () => {
  it('exposes the selected layout through a pressed segment', () => {
    const markup = renderToStaticMarkup(
      createElement(ViewToggle, { value: 'list', onChange: () => {} }),
    )
    expect(markup).toContain('class="rp-seg shrink-0')
    expect(markup).toMatch(/aria-pressed="false"[^>]*>grid<\/button>/)
    expect(markup).toMatch(/aria-pressed="true"[^>]*>list<\/button>/)
    expect(markup).not.toContain('background-color:var(--rp-primary)')
  })

  it('names the range with a visible label and omits it from list view', () => {
    const props = { value: 4, onChange: () => {}, view: 'grid' as const }
    const markup = renderToStaticMarkup(createElement(GridDensity, props))
    const labelFor = /<label for="([^"]+)"/.exec(markup)?.[1]
    expect(labelFor).toBeTruthy()
    expect(markup).toContain(`id="${labelFor}"`)
    expect(markup).toContain('>Cards across the grid</label>')
    expect(markup).toContain('type="range"')
    expect(renderToStaticMarkup(createElement(GridDensity, { ...props, view: 'list' }))).toBe('')
  })
})
