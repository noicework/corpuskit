import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useOutletContext } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  acceptsSiteFeedback,
  type AccessibilityContact,
  type TenantConfig,
} from '@research-portal/core'
import { ExternalMark } from '../components/LayoutLink.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// The accessibility statement, at /t/:slug/accessibility and linked from the
// footer of every portal. The default copy below says what is tested and how.
// It claims no conformance, names no test date and no tool: those belong to
// the people who run a portal, who replace the sections through
// `config.accessibility.sections` and supply the contact through
// `config.accessibility.contact`. Without a contact the page has no contact
// section at all; it never invents an address.
// ---------------------------------------------------------------------------

export type StatementSection = { heading: string; paragraphs: string[] }

/** The default statement: Australian English, no conformance claim, no date, no tool. */
export const DEFAULT_ACCESSIBILITY_SECTIONS: readonly StatementSection[] = [
  {
    heading: 'What has been tested',
    paragraphs: [
      'The portal is checked against the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA. The checks cover the pages a reader uses: the home page, search, ask, the library and the document reader, investigations, generated briefings, the knowledge map, the help pages and this statement.',
      "Each page is checked in light and dark mode, at phone and desktop widths, with the browser's text size raised and with the text spacing a reader may set for themselves. The checks are repeated as the portal changes, so this page describes the portal as it is built now rather than at a single moment.",
    ],
  },
  {
    heading: 'How it is tested',
    paragraphs: [
      'Two kinds of check are used together. Automated checks scan every page for the problems a machine can find, such as an image without a text alternative, text with too little contrast against its background, a form field without a label or a page without a proper heading.',
      'Manual checks then cover what a machine cannot judge. The whole portal is used with the keyboard alone, read with a screen reader and zoomed to four times its normal size. Focus is checked to be visible on every control and never lost behind the header, motion is checked to stop when a reader asks for reduced motion, and a streamed answer is checked to be announced once it is complete rather than word by word.',
    ],
  },
  {
    heading: 'Where the portal depends on its documents',
    paragraphs: [
      "Much of what the portal shows comes from the research collection it holds. A document published without a text layer, tags or image descriptions is shown as it was published, and the portal cannot add what the file does not carry. Where the portal has extracted a document's text, that text is offered beside the file so a screen reader can read it.",
      'Summaries, key takeaways and answers are written from the documents and checked for their structure and labelling. Their reading level follows the documents they draw on, so a passage quoted from a technical paper reads as the paper does.',
    ],
  },
]

/** The heading of the contact section, which follows the sections whenever a contact is set. */
export const CONTACT_HEADING = 'Tell us about an access problem'

/** The sections a portal shows: its own when it has written them, the default otherwise. */
export function statementSections(
  config: Pick<TenantConfig, 'accessibility'>,
): readonly StatementSection[] {
  return config.accessibility?.sections ?? DEFAULT_ACCESSIBILITY_SECTIONS
}

/** A stable anchor for a heading: its letters and digits, or its position when it has none. */
export function sectionId(heading: string, index: number): string {
  const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `section-${slug}` : `section-${index + 1}`
}

export const CONTACT_ID = 'section-contact'

function P({ children }: { children: ReactNode }) {
  return <p className='text-base leading-relaxed text-ink-2'>{children}</p>
}

/** A link inside running prose: accent ink and an underline, so it reads as a link. */
function ProseLink(
  { href, external, children }: { href: string; external?: boolean; children: ReactNode },
) {
  return (
    <a
      href={href}
      rel={external ? 'noopener' : undefined}
      className='rp-focus inline-flex min-h-6 items-center rounded-[var(--rp-radius-btn)] font-medium underline underline-offset-2 [overflow-wrap:anywhere]'
      style={{ color: 'var(--rp-accent-fg)' }}
    >
      {children}
      {external ? <ExternalMark /> : null}
    </a>
  )
}

function ContactDetails({ contact }: { contact: AccessibilityContact }) {
  const { ui } = usePortalLocale()
  const rows: { label: string; value: ReactNode }[] = []
  if (contact.email) {
    rows.push({
      label: ui('Email'),
      value: <ProseLink href={`mailto:${contact.email}`}>{contact.email}</ProseLink>,
    })
  }
  if (contact.phone) {
    rows.push({
      label: ui('Phone'),
      value: (
        <ProseLink href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}>{contact.phone}</ProseLink>
      ),
    })
  }
  if (contact.url) {
    rows.push({
      label: ui('Website'),
      value: <ProseLink href={contact.url} external>{contact.url}</ProseLink>,
    })
  }
  if (!rows.length) return null
  return (
    <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-base leading-relaxed'>
      {rows.map((row) => (
        <div key={row.label} className='contents'>
          <dt className='font-semibold text-ink'>{row.label}</dt>
          <dd className='min-w-0 text-ink-2'>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ContactSection(
  { contact, productName, feedbackOffered }: {
    contact: AccessibilityContact
    productName: string
    feedbackOffered: boolean
  },
) {
  const who = contact.name ?? 'the people who run this portal'
  return (
    <section id={CONTACT_ID} aria-labelledby={`${CONTACT_ID}-heading`} className='scroll-mt-24'>
      <h2 id={`${CONTACT_ID}-heading`} className='rp-display text-xl text-ink'>
        {CONTACT_HEADING}
      </h2>
      <div className='rp-measure rp-prose mt-3 space-y-3.5'>
        <P>
          If any part of {productName}{' '}
          is hard to use, or you need something from it in another format, contact{' '}
          {who}. Please say which page you were on and what happened, so the problem can be found
          quickly.
        </P>
        <ContactDetails contact={contact} />
        {contact.note ? <P>{contact.note}</P> : null}
        {feedbackOffered
          ? (
            <P>
              You can also send a message from inside the portal. Choose Send feedback in the
              header, or in the menu on a phone, and say that it is about access.
            </P>
          )
          : null}
      </div>
    </section>
  )
}

function OnThisPage({ entries }: { entries: { id: string; heading: string }[] }) {
  const { ui } = usePortalLocale()
  return (
    <nav aria-label={ui('On this page')} className='space-y-0.5'>
      <p className='rp-eyebrow px-2 text-ink-3'>{ui('On this page')}</p>
      <ul className='mt-1.5 space-y-0.5'>
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              className='rp-link-standalone rp-focus flex w-full justify-start rounded-[var(--rp-radius-btn)] px-2 py-1.5 text-sm text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-ink'
            >
              {entry.heading}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * The statement itself, from the portal's configuration alone. `feedbackOffered` says whether
 * this reader sees the Send feedback control, so the page mentions it only when it is there.
 */
export function AccessibilityStatement(
  { config, feedbackOffered = false }: { config: TenantConfig; feedbackOffered?: boolean },
) {
  const { ui } = usePortalLocale()
  const productName = config.branding.productName
  const sections = statementSections(config)
  const contact = config.accessibility?.contact
  const entries = [
    ...sections.map((section, index) => ({
      id: sectionId(section.heading, index),
      heading: section.heading,
    })),
    ...(contact ? [{ id: CONTACT_ID, heading: CONTACT_HEADING }] : []),
  ]

  return (
    <main className='rp-shell py-8 lg:py-10' data-testid='accessibility-statement'>
      <div className='mb-6'>
        <p className='rp-eyebrow text-ink-3'>{ui('About this portal')}</p>
        <h1 className='rp-display mt-1 text-2xl text-ink sm:text-3xl'>{ui('Accessibility')}</h1>
        <p className='rp-measure mt-2 text-base leading-relaxed text-ink-2'>
          {productName}{' '}
          is meant to work for everyone, including people who read with a screen reader, move
          through a page with the keyboard alone, magnify the screen or use voice control. This page
          says what has been tested and how, and where the portal still depends on the documents it
          holds.
        </p>
      </div>

      <div className='grid grid-cols-1 gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10 2xl:grid-cols-[16rem_minmax(0,1fr)]'>
        <aside className='hidden lg:block'>
          <div className='lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)]'>
            <OnThisPage entries={entries} />
          </div>
        </aside>

        <div className='min-w-0 space-y-8 lg:space-y-10'>
          {sections.map((section, index) => {
            const id = sectionId(section.heading, index)
            return (
              <section key={id} id={id} aria-labelledby={`${id}-heading`} className='scroll-mt-24'>
                <h2 id={`${id}-heading`} className='rp-display text-xl text-ink'>
                  {section.heading}
                </h2>
                <div className='rp-measure rp-prose mt-3 space-y-3.5'>
                  {section.paragraphs.map((paragraph, paragraphIndex) => (
                    <P key={paragraphIndex}>{paragraph}</P>
                  ))}
                </div>
              </section>
            )
          })}
          {contact
            ? (
              <ContactSection
                contact={contact}
                productName={productName}
                feedbackOffered={feedbackOffered}
              />
            )
            : null}
        </div>
      </div>
    </main>
  )
}

/** The route: the statement for the portal the layout resolved. */
export function AccessibilityPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const access = useAccess()
  // The same condition the layout uses to show the Send feedback control.
  const feedbackOffered = acceptsSiteFeedback(config) &&
    access.can('portal.ask', { kind: 'portal', slug: config.slug })
  return <AccessibilityStatement config={config} feedbackOffered={feedbackOffered} />
}
