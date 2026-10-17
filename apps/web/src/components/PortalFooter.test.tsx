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

  it('uses contrast-safe secondary text and display product names in both footer variants', () => {
    const full: Branding = {
      ...branding,
      layout: {
        footer: {
          columns: [{ heading: 'Explore', links: [{ label: 'Library', href: '/library' }] }],
          note: 'A bounded note.',
          credits: [{ label: 'Research partner', href: 'https://example.org' }],
          poweredBy: true,
        },
      },
    }
    for (const html of [render(branding), render(full)]) {
      expect(html).toMatch(/<p class="[^"]*rp-display[^"]*text-2xl[^"]*">Example Portal<\/p>/)
      expect(html).toMatch(
        /<p class="[^"]*text-\[var\(--rp-on-primary-2\)\][^"]*">Talks and slides from the community<\/p>/,
      )
      expect(html).not.toMatch(/text-\[var\(--rp-on-primary\)\]\/\d+/)
    }
    const html = render(full)
    expect(html).toMatch(
      /<h2 class="[^"]*text-\[var\(--rp-on-primary-2\)\][^"]*">Explore<\/h2>/,
    )
    expect(html).toMatch(/<p class="[^"]*max-w-prose[^"]*">A bounded note\.<\/p>/)
    const closing = html.slice(html.indexOf('mt-12'))
    expect(closing).toContain('text-xs')
    expect(closing).toContain('text-[var(--rp-on-primary-2)]')
    const credits = closing.match(/<ul role="list"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? ''
    expect(credits).toContain('text-[var(--rp-on-primary-2)]')
    expect(credits).not.toContain('rp-layout-footer-link')
  })

  it('gives every footer link a fixed rem target floor at each pointer size', () => {
    const html = render({
      ...branding,
      layout: {
        footer: {
          columns: [{ heading: 'Explore', links: [{ label: 'Go', href: '/library' }] }],
          credits: [{ label: 'A', href: 'https://example.org' }],
          poweredBy: true,
        },
      },
    })
    const links = [...html.matchAll(/<a\b[^>]*class="([^"]*)"/g)]
    expect(links).toHaveLength(3)
    for (const [, classes] of links) {
      expect(classes).toContain('min-h-[2.75rem]')
      expect(classes).toContain('min-w-[2.75rem]')
      expect(classes).toContain('lg:min-h-[1.5rem]')
      expect(classes).toContain('lg:min-w-[1.5rem]')
      expect(classes).toContain('[@media(pointer:coarse)]:min-h-[2.75rem]')
      expect(classes).toContain('[@media(pointer:coarse)]:min-w-[2.75rem]')
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

  for (const count of [0, 1, 2]) {
    for (const poweredBy of [false, true]) {
      it(`groups ${count} credits with poweredBy ${poweredBy} in order and without stray separators`, () => {
        const credits = [
          { label: '<b>Research & evidence</b>', href: 'https://example.org/research' },
          { label: 'Browse evidence', href: '/library' },
        ].slice(0, count)
        const html = render({
          ...branding,
          layout: { footer: { note: 'Portal note.', credits, poweredBy } },
        })
        const list = html.match(/<ul role="list"[^>]*>([\s\S]*?)<\/ul>/)
        const total = count + Number(poweredBy)
        if (!total) {
          expect(list).toBeNull()
          expect(html).not.toContain('·')
          return
        }
        expect(list).not.toBeNull()
        const content = list![1]!
        expect(content.match(/<li\b/g) ?? []).toHaveLength(total)
        expect(content.match(/<a\b/g) ?? []).toHaveLength(total)
        const items = [...content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)]
        const separator = '<span aria-hidden="true" class="hidden shrink-0 md:inline">·</span>'
        expect(content.split(separator)).toHaveLength(total)
        expect(list![0]).toContain('flex-col items-start')
        expect(list![0]).toContain('md:flex-row md:flex-nowrap')
        expect(list![0]).not.toMatch(/(?:class="|\s)flex-wrap(?:\s|")/)
        for (const [index, item] of items.entries()) {
          const body = item[1]!
          if (index === 0) expect(body).not.toContain(separator)
          else expect(body.startsWith(separator + '<a ')).toBe(true)
          expect(body).not.toMatch(/<\/a>\s*<span[^>]*>·/)
        }
        expect(html.indexOf('Example User Group')).toBeLessThan(html.indexOf('Portal note.'))
        expect(html.indexOf('Portal note.')).toBeLessThan(list!.index!)
        if (count) {
          expect(content).toContain('&lt;b&gt;Research &amp; evidence&lt;/b&gt;')
          expect(content).not.toContain('<b>Research')
          expect(content).toContain(EXTERNAL_LINK_NOTE)
        }
        if (count === 2) {
          expect(content).toContain('href="/t/example/library"')
          expect(content.indexOf('Research &amp; evidence')).toBeLessThan(
            content.indexOf('Browse evidence'),
          )
        }
        if (poweredBy) {
          expect(content).toContain('href="https://corpuskit.org" rel="noopener"')
          expect(content).toContain(EXTERNAL_LINK_NOTE)
          if (count) {
            expect(content.indexOf(count === 2 ? 'Browse evidence' : 'Research &amp; evidence'))
              .toBeLessThan(content.indexOf('Powered by CorpusKit'))
          }
        } else {
          expect(content).not.toContain('corpuskit.org')
        }
      })
    }
  }

  it('leaves out "Powered by CorpusKit" unless the layout asks for it', () => {
    const html = render({ ...branding, layout: { footer: { note: 'A note.' } } })
    expect(html).toContain('A note.')
    expect(html).not.toContain('corpuskit.org')
    expect(html).not.toContain('<nav')
  })
})
