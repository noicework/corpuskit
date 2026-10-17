import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Branding } from '@research-portal/core'
import { PortalFooter } from './PortalFooter.tsx'
import { EXTERNAL_LINK_NOTE } from './LayoutLink.tsx'

const source = await Deno.readTextFile(new URL('PortalFooter.tsx', import.meta.url))
/** The slim footer's markup only, so the doc comment explaining a rule cannot satisfy it. */
const markup = source.slice(
  source.indexOf('function SlimFooter'),
  source.indexOf('function LayoutFooter'),
)
const layoutMarkup = source.slice(source.indexOf('function LayoutFooter'))
const tenantLayoutSource = await Deno.readTextFile(
  new URL('../pages/TenantLayout.tsx', import.meta.url),
)

const branding: Branding = {
  productName: 'Example Portal',
  organisation: 'Example User Group',
  tagline: 'Talks and slides from the community',
  colours: { primary: '#123456', accent: '#345678', heroFrom: '#123456', heroTo: '#234567' },
}

const render = (value: Branding) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PortalFooter branding={value} slug='example' />
    </MemoryRouter>,
  )

describe('PortalFooter', () => {
  it('renders from the tenant branding rather than a per-slug content table', () => {
    expect(source).toContain('branding: Branding')
    expect(source).not.toMatch(/Record<string,\s*FooterContent>/)
    expect(tenantLayoutSource).toContain(
      '<PortalFooter branding={config.branding} slug={config.slug} />',
    )
  })

  it('invents nothing about the organisation it belongs to', () => {
    // Link columns, legal pages, social accounts and an Acknowledgement of
    // Country belong to a real organisation. A footer that generates them is
    // asserting something the portal does not know.
    expect(markup).not.toContain('href')
    expect(markup).not.toContain('<svg')
    expect(markup).not.toMatch(/acknowledge/i)
    expect(markup).not.toMatch(/subscribe/i)
    // The fuller footer links only what the layout supplies, and CorpusKit only when asked.
    expect(layoutMarkup).not.toMatch(/acknowledge/i)
    expect(layoutMarkup).not.toMatch(/subscribe/i)
    expect(render(branding)).not.toContain('<a')
  })

  it('paints on the brand surface through the appearance tokens', () => {
    for (const part of [markup, layoutMarkup]) {
      expect(part).toContain('bg-[var(--rp-primary)]')
      expect(part).toContain('text-[var(--rp-on-primary)]')
      // A palette need not pair white with its brand colour.
      expect(part).not.toContain('text-white')
    }
  })

  it('stacks on narrow viewports and guards its flex items against overflow', () => {
    expect(markup).toContain('flex-col')
    expect(markup).toContain('sm:flex-row')
    expect(markup.match(/min-w-0/g)?.length).toBe(2)
    expect(layoutMarkup).toContain('grid-cols-1')
    expect(layoutMarkup).toContain('md:flex-row')
  })

  it('keeps the slim footer when the layout sets no footer', () => {
    const slim = render(branding)
    const withHomeOnly = render({ ...branding, layout: { home: { sections: [] } } })
    expect(withHomeOnly).toBe(slim)
    expect(slim).toContain('Example User Group')
    expect(slim).not.toContain('<nav')
  })

  it("renders the layout's columns, note and powered-by line as plain text", () => {
    const html = render({
      ...branding,
      layout: {
        footer: {
          columns: [
            {
              heading: 'Explore',
              links: [{ label: 'Library', href: '/library' }, { label: 'Ask', href: '/ask' }],
            },
            {
              heading: 'Community',
              links: [{ label: '<b>Join</b>', href: 'https://example.org/join' }],
            },
          ],
          note: 'Example User Group is run by volunteers.',
          poweredBy: true,
        },
      },
    })
    expect(html).toContain('<footer')
    expect(html).toContain('<nav aria-label="Footer"')
    expect(html).toContain('>Explore</h2>')
    expect(html).toContain('href="/t/example/library"')
    expect(html).toContain('href="/t/example/ask"')
    // External links say so, and the label is text, never markup.
    expect(html).toContain('href="https://example.org/join" rel="noopener"')
    expect(html).toContain('&lt;b&gt;Join&lt;/b&gt;')
    expect(html).toContain(EXTERNAL_LINK_NOTE)
    expect(html).toContain('Example User Group is run by volunteers.')
    expect(html).toContain('href="https://corpuskit.org" rel="noopener"')
    expect(html).toContain('Powered by CorpusKit')
    // The organisation, product name and tagline stay.
    expect(html).toContain('Example Portal')
    expect(html).toContain('Talks and slides from the community')
    expect(html).toContain('Example User Group</p>')
  })

  it('links its credits in the closing row, beside the note it leaves as it was', () => {
    const html = render({
      ...branding,
      layout: {
        footer: {
          note: 'Private demonstration. Reproduced courtesy of Example User Group.',
          credits: [{
            label: 'Powered by Progress Agentic RAG',
            href: 'https://www.progress.com/agentic-rag',
          }],
          poweredBy: true,
        },
      },
    })
    expect(html).toContain('Private demonstration. Reproduced courtesy of Example User Group.')
    expect(html).toContain('href="https://www.progress.com/agentic-rag" rel="noopener"')
    expect(html).toContain('Powered by Progress Agentic RAG')
    expect(html).toContain(EXTERNAL_LINK_NOTE)
    // The credit sits after the note and before "Powered by CorpusKit".
    const note = html.indexOf('Private demonstration.')
    const credit = html.indexOf('Powered by Progress Agentic RAG')
    expect(note).toBeLessThan(credit)
    expect(credit).toBeLessThan(html.indexOf('Powered by CorpusKit'))
  })

  it('leaves out "Powered by CorpusKit" unless the layout asks for it', () => {
    const html = render({ ...branding, layout: { footer: { note: 'A note.' } } })
    expect(html).toContain('A note.')
    expect(html).not.toContain('corpuskit.org')
    expect(html).not.toContain('<nav')
  })
})
