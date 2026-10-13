import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { EXTERNAL_LINK_NOTE, LayoutAnchor } from './LayoutLink.tsx'

const render = (href: string, options: { nav?: boolean; at?: string } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[options.at ?? '/t/example']}>
      <LayoutAnchor href={href} slug='example' className='link' nav={options.nav}>
        Label
      </LayoutAnchor>
    </MemoryRouter>,
  )

describe('LayoutAnchor', () => {
  it('resolves a portal path under the portal and keeps it in the app', () => {
    const html = render('/search?q=soil')
    expect(html).toContain('<a class="link" href="/t/example/search?q=soil"')
    expect(html).not.toContain('rel=')
    expect(html).not.toContain('sr-only')
  })

  it('marks an external link for sight and for screen readers, with rel="noopener"', () => {
    const html = render('https://example.org/events')
    expect(html).toContain('href="https://example.org/events"')
    expect(html).toContain('rel="noopener"')
    expect(html).not.toContain('target=')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain(`<span class="sr-only">${EXTERNAL_LINK_NOTE}</span>`)
  })

  it('renders nothing for a link the layout rules refuse', () => {
    for (const href of ['javascript:alert(1)', 'http://example.org', '//example.org', '/../x']) {
      expect([href, render(href)]).toEqual([href, ''])
    }
  })

  it('shows a navigation link as current only on exactly its own page', () => {
    expect(render('/people', { nav: true, at: '/t/example/people' })).toContain(
      'class="link rp-navlink-active"',
    )
    expect(render('/people', { nav: true, at: '/t/example/library' })).not.toContain('active')
    // A link into a page with a query never claims the page from the built-in item.
    expect(render('/library?kind=video', { nav: true, at: '/t/example/library' }))
      .not.toContain('aria-current')
  })
})
