import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { type TenantConfig, TenantConfigSchema } from '@research-portal/core'
import {
  AccessibilityStatement,
  CONTACT_HEADING,
  DEFAULT_ACCESSIBILITY_SECTIONS,
  sectionId,
  statementSections,
} from './AccessibilityPage.tsx'
import { EXTERNAL_LINK_NOTE } from '../components/LayoutLink.tsx'
import { pageTitle } from '../lib/page-title.ts'

const pageSource = await Deno.readTextFile(new URL('./AccessibilityPage.tsx', import.meta.url))
const routerSource = await Deno.readTextFile(new URL('../main.tsx', import.meta.url))

const config: TenantConfig = TenantConfigSchema.parse({
  slug: 'example',
  branding: {
    productName: 'Example Research Portal',
    organisation: 'Example Research Alliance',
    tagline: 'Research for example readers',
    colours: { primary: '#123456', accent: '#345678', heroFrom: '#123456', heroTo: '#234567' },
  },
  searchPlaceholder: 'Search the research',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
})

const render = (value: TenantConfig, feedbackOffered = false) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AccessibilityStatement config={value} feedbackOffered={feedbackOffered} />
    </MemoryRouter>,
  )

/** The words a reader sees: the markup with its tags stripped. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const defaultCopy = DEFAULT_ACCESSIBILITY_SECTIONS.flatMap((section) => [
  section.heading,
  ...section.paragraphs,
]).join('\n')

describe('Accessibility statement page', () => {
  it('is routed at /t/:slug/accessibility and names itself in the tab', () => {
    expect(routerSource).toContain(
      "<Route path='accessibility' element={<AccessibilityPage />} />",
    )
    expect(pageTitle('/t/example/accessibility', 'Example Research Portal')).toBe(
      'Accessibility | Example Research Portal',
    )
  })

  it('has one h1, a heading for every section and a landmark for each', () => {
    const html = render(config)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('>Accessibility</h1>')
    const headings = [...html.matchAll(/<h2 id="([^"]+)"[^>]*>([^<]+)<\/h2>/g)]
    expect(headings.map((match) => match[2])).toEqual(
      DEFAULT_ACCESSIBILITY_SECTIONS.map((section) => section.heading),
    )
    for (const [, id] of headings) {
      const sectionIdValue = id!.replace(/-heading$/, '')
      expect(html).toContain(`<section id="${sectionIdValue}" aria-labelledby="${id}"`)
      expect(html).toContain(`href="#${sectionIdValue}"`)
    }
    expect(html).toContain('<nav aria-label="On this page"')
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html).not.toMatch(/<h[4-6]\b/)
  })

  it('says what is tested and how, and claims no conformance, date or tool', () => {
    expect(defaultCopy).toContain('Web Content Accessibility Guidelines (WCAG) 2.2 at level AA')
    expect(defaultCopy).toMatch(/Automated checks/)
    expect(defaultCopy).toMatch(/Manual checks/)
    expect(defaultCopy).not.toMatch(/conform|compliant|compliance|fully accessible/i)
    expect(defaultCopy).not.toMatch(/\b(?:19|20)\d\d\b/)
    expect(defaultCopy).not.toMatch(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/,
    )
    expect(defaultCopy).not.toMatch(/axe|lighthouse|wave|pa11y|sightline|nvda|jaws|voiceover/i)
    // Nothing named that belongs to a particular organisation.
    expect(defaultCopy).not.toMatch(/example|corpuskit|progress/i)
  })

  it('reads in the house style', () => {
    const copy = `${defaultCopy}\n${CONTACT_HEADING}`
    expect(copy).not.toContain('—')
    expect(copy).not.toContain('&')
    expect(copy).not.toMatch(/\b(?:color|organization|center|customize|optimize)\b/)
    for (const section of DEFAULT_ACCESSIBILITY_SECTIONS) {
      // Single-clause headings, with no punctuation inside them.
      expect(section.heading).not.toMatch(/[:,;.?!]/)
      // No one-line punchy paragraphs: every paragraph carries at least two sentences.
      for (const paragraph of section.paragraphs) {
        expect(paragraph.match(/[.!?](?:\s|$)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('leaves the contact section out cleanly when no contact is configured', () => {
    const html = render(config)
    expect(html).not.toContain(CONTACT_HEADING)
    expect(html).not.toContain('mailto:')
    expect(html).not.toContain('tel:')
    expect(html).not.toContain('#section-contact')
    expect(text(html)).not.toMatch(/contact|get in touch/i)
    expect(statementSections(config)).toBe(DEFAULT_ACCESSIBILITY_SECTIONS)
  })

  it('renders the configured contact as plain text with working links', () => {
    const html = render({
      ...config,
      accessibility: {
        contact: {
          name: "the Example Research Alliance's <b>digital</b> team",
          email: 'access@example.org',
          phone: '+61 3 0000 0000',
          url: 'https://example.org/accessibility',
          note: 'We aim to reply within five working days.',
        },
      },
    })
    expect(html).toContain(`>${CONTACT_HEADING}</h2>`)
    expect(html).toContain(
      '<section id="section-contact" aria-labelledby="section-contact-heading"',
    )
    expect(html).toContain('href="#section-contact"')
    expect(html).toContain(
      'contact the Example Research Alliance&#x27;s &lt;b&gt;digital&lt;/b&gt; team.',
    )
    expect(html).toContain('href="mailto:access@example.org"')
    expect(html).toContain('href="tel:+61300000000"')
    expect(html).toContain('>+61 3 0000 0000</a>')
    expect(html).toContain('href="https://example.org/accessibility" rel="noopener"')
    expect(html).toContain(EXTERNAL_LINK_NOTE)
    expect(html).toContain('We aim to reply within five working days.')
    expect(html).toContain('>Email</dt>')
    expect(html).toContain('>Phone</dt>')
    expect(html).toContain('>Website</dt>')
    // Only the details that are set appear.
    const emailOnly = render({ ...config, accessibility: { contact: { email: 'a@example.org' } } })
    expect(emailOnly).toContain('mailto:a@example.org')
    expect(emailOnly).not.toContain('>Phone</dt>')
    expect(emailOnly).not.toContain('>Website</dt>')
    expect(emailOnly).toContain('contact the people who run this portal.')
  })

  it('mentions Send feedback only where the reader has it', () => {
    const contact = { email: 'access@example.org' }
    expect(render({ ...config, accessibility: { contact } }, false)).not.toContain('Send feedback')
    expect(render({ ...config, accessibility: { contact } }, true)).toContain('Send feedback')
    // Never without a contact section to sit in.
    expect(render(config, true)).not.toContain('Send feedback')
  })

  it("replaces the default sections with the portal's own and keeps the contact after them", () => {
    const html = render({
      ...config,
      accessibility: {
        sections: [
          { heading: 'Our testing', paragraphs: ['We test every release.', 'Twice.'] },
          { heading: '試験', paragraphs: ['<script>alert(1)</script>'] },
        ],
        contact: { email: 'access@example.org' },
      },
    })
    expect(html).not.toContain(DEFAULT_ACCESSIBILITY_SECTIONS[0]!.heading)
    const headings = [...html.matchAll(/<h2 id="([^"]+)"[^>]*>([^<]+)<\/h2>/g)]
    expect(headings.map((match) => match[2])).toEqual(['Our testing', '試験', CONTACT_HEADING])
    expect(headings.map((match) => match[1])).toEqual([
      'section-our-testing-heading',
      'section-2-heading',
      'section-contact-heading',
    ])
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(sectionId('What has been tested', 0)).toBe('section-what-has-been-tested')
    expect(sectionId('---', 4)).toBe('section-5')
  })

  it('draws from the appearance tokens only and keeps every target at 24px or more', () => {
    expect(pageSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(pageSource).not.toMatch(/\b(?:rgb|hsl)a?\(/)
    expect(pageSource).not.toMatch(/\b(?:text-white|bg-white|text-black)\b/)
    expect(pageSource).toContain('var(--rp-accent-fg)')
    expect(pageSource).toContain('var(--rp-radius-btn)')
    expect(pageSource).toContain('rp-focus')
    expect(pageSource).toContain('min-h-6')
    expect(pageSource).toContain('rp-measure')
  })
})
