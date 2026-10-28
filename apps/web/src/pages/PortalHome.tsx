import { ResourceProvenanceLabel } from '../components/ResourceProvenanceLabel.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { createContext, useContext, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import {
  type HomeSection,
  layoutHrefTarget,
  type LayoutImage,
  type PortalLayout,
  type ResourceSummary,
  type TenantConfig,
} from '@research-portal/core'
import { getCatalog, getResource } from '../api/client.ts'
import {
  SectionHeader as SystemSectionHeader,
  Skeleton,
  TypeBadge,
  typeLabel,
} from '../components/ui.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { ArrowRight, File, FileText, Globe, MessageSquare } from '../components/icons.tsx'
import { EXTERNAL_LINK_NOTE, ExternalMark, LayoutAnchor } from '../components/LayoutLink.tsx'
import { ExplorePage, Hero, TopicRows, useAskNavigation } from './ExplorePage.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

type LayoutHome = NonNullable<PortalLayout['home']>
/** Whether this home's cards end in an arrow (`home.cardArrows`, true unless set false). */
const CardArrows = createContext(true)
const RESOURCE_ICONS = { document: FileText, pdf: FileText, video: File, web: Globe } as const
/** What a home row's card shows: a full summary, or a catalogue item with fewer fields. */
type CardResource =
  & Pick<ResourceSummary, 'id' | 'title' | 'type'>
  & Partial<Pick<ResourceSummary, 'summary'>>
type SectionOf<K extends HomeSection['kind']> = Extract<HomeSection, { kind: K }>

/** The portal's home: its own composition when its layout sets one, otherwise Explore. */
export function HomePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const home = config.branding.layout?.home
  return home ? <PortalHome config={config} home={home} /> : <ExplorePage />
}

/**
 * A home page composed by the portal's layout: the hero with the ask, then each section in the
 * order the layout lists them. Every word comes from the layout and renders as plain text.
 */
export function PortalHome({ config, home }: { config: TenantConfig; home: LayoutHome }) {
  const ask = useAskNavigation(config.slug)
  const hasRecent = home.sections.some((section) => section.kind === 'recent')
  return (
    <CardArrows.Provider value={home.cardArrows !== false}>
      <main>
        <Hero config={config} onAsk={ask} hero={home.hero ?? {}} showRecent={!hasRecent} />
        {home.sections.map((section, index) => (
          <HomeSectionView
            key={`${index}-${section.kind}`}
            config={config}
            section={section}
            id={`home-section-${index}`}
            onAsk={ask}
          />
        ))}
      </main>
    </CardArrows.Provider>
  )
}

function HomeSectionView(
  { config, section, id, onAsk }: {
    config: TenantConfig
    section: HomeSection
    id: string
    onAsk: (text: string) => void
  },
) {
  switch (section.kind) {
    case 'cards':
      return <CardsSection slug={config.slug} section={section} id={id} />
    case 'resources':
      return <FeaturedSection slug={config.slug} section={section} id={id} />
    case 'recent':
      return <RecentSection slug={config.slug} section={section} id={id} />
    case 'questions':
      return <QuestionsSection section={section} id={id} onAsk={onAsk} />
    case 'about':
      return <AboutSection slug={config.slug} section={section} id={id} />
    case 'topics':
      return <TopicRows config={config} emptyState={false} />
  }
}

/** Plain text in paragraphs: a blank line starts a new one, a single line break is kept. */
function Paragraphs({ text, className = '' }: { text: string; className?: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((paragraph, index) => (
        <p key={index} className={`whitespace-pre-line ${className}`}>{paragraph.trim()}</p>
      ))}
    </>
  )
}

function SectionHeader(
  { id, heading, intro, more }: {
    id: string
    heading: string
    intro?: string
    more?: { href: string; slug: string }
  },
) {
  const { ui } = usePortalLocale()
  return (
    <div>
      <SystemSectionHeader
        title={<span id={id} className='rp-display break-words text-xl'>{heading}</span>}
        actions={more
          ? (
            <LayoutAnchor
              href={more.href}
              slug={more.slug}
              className='rp-link-standalone shrink-0 text-sm font-medium'
            >
              {ui('See all')}
              <ArrowRight size='sm' className='shrink-0' />
            </LayoutAnchor>
          )
          : undefined}
      />
      {intro
        ? (
          <div className='rp-measure mt-3 space-y-3'>
            <Paragraphs text={intro} className='text-base leading-relaxed text-ink-2' />
          </div>
        )
        : null}
    </div>
  )
}

function ExternalNote() {
  const { ui } = usePortalLocale()
  return <span className='sr-only'>{ui(EXTERNAL_LINK_NOTE)}</span>
}

/** An uploaded layout image in a fixed-ratio box; a failed load leaves the box's own ground. */
function LayoutPicture(
  { image, className = '', imgClassName = '' }: {
    image: LayoutImage
    className?: string
    imgClassName?: string
  },
) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`relative overflow-hidden bg-surface-2 ${className}`}>
      {image.url && !failed
        ? (
          <img
            src={image.url}
            alt={image.alt}
            loading='lazy'
            decoding='async'
            onError={() => setFailed(true)}
            className={`absolute inset-0 h-full w-full object-cover ${imgClassName}`}
          />
        )
        : <div className='rp-layout-art absolute inset-0' aria-hidden='true' />}
    </div>
  )
}

/**
 * Columns for a wide screen, chosen so the cards fill whole rows where the count allows: six
 * cards make two rows of three rather than a row of four and a row of two.
 */
const CARD_COLUMNS = { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' } as const

export function cardColumns(count: number): keyof typeof CARD_COLUMNS {
  if (count <= 2) return 2
  if (count % 3 === 0) return 3
  if (count % 4 === 0) return 4
  return count === 5 ? 3 : 4
}

function CardsSection(
  { slug, section, id }: { slug: string; section: SectionOf<'cards'>; id: string },
) {
  // Once one card has a picture, the rest get the brand artwork in the same frame, so the grid
  // keeps one rhythm instead of mixing tall and short cards.
  const pictured = section.cards.some((card) => card.image?.url)
  const arrows = useContext(CardArrows)
  return (
    <section aria-labelledby={id} className='rp-shell rp-layout-section'>
      <SectionHeader id={id} heading={section.heading} intro={section.intro} />
      <ul
        className={`mt-8 grid gap-4 sm:grid-cols-2 lg:gap-5 ${
          CARD_COLUMNS[cardColumns(section.cards.length)]
        }`}
      >
        {section.cards.map((card, index) => (
          <li key={`${index}-${card.title}`} className='flex min-w-0'>
            <LayoutAnchor
              href={card.href}
              slug={slug}
              className='rp-card rp-lift rp-focus group flex w-full min-w-0 flex-col overflow-hidden'
              mark={false}
            >
              {pictured
                ? (
                  <LayoutPicture
                    image={card.image?.url ? card.image : { asset: '', alt: '' }}
                    className='aspect-[16/9] w-full'
                    imgClassName='rp-zoom'
                  />
                )
                : null}
              <div className='flex flex-1 flex-col gap-2 p-5 lg:p-6'>
                <h3 className='break-words text-base font-semibold leading-snug tracking-[-0.01em] text-ink'>
                  {card.title}
                </h3>
                {card.body
                  ? (
                    <p className='whitespace-pre-line text-sm leading-relaxed text-ink-2'>
                      {card.body}
                    </p>
                  )
                  : null}
                {arrows
                  ? (
                    <span className='rp-layout-card-arrow mt-auto pt-2 text-[var(--rp-accent-fg)]'>
                      {layoutHrefTarget(card.href, slug)?.external
                        ? <ExternalMark />
                        : <ArrowRight size='sm' className='shrink-0' />}
                    </span>
                  )
                  : layoutHrefTarget(card.href, slug)?.external
                  ? <ExternalNote />
                  : null}
              </div>
            </LayoutAnchor>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Resources in a row that scrolls sideways, like the topic rows further down the page, so the
 * home reads as one system and a short list never leaves a half-empty grid row.
 */
function ResourceRow(
  { slug, items, loading, count }: {
    slug: string
    items: CardResource[]
    loading: boolean
    count: number
  },
) {
  return (
    <div className='rp-scroll-row rp-no-scrollbar -mx-[1.5rem] mt-6 flex gap-3 overflow-x-auto scroll-pl-[1.5rem] px-[1.5rem] pb-4 pt-1 sm:mx-0 sm:scroll-pl-0 sm:px-0'>
      {loading
        ? Array.from({ length: Math.min(count, 6) }).map((_, index) => (
          <div
            key={index}
            className='rp-card w-64 shrink-0 overflow-hidden sm:w-72'
            aria-hidden='true'
          >
            <div className='rp-shimmer aspect-[4/3] w-full bg-surface-3' />
            <div className='space-y-2 border-t border-line p-3.5'>
              <Skeleton className='h-4 w-4/5' />
              <Skeleton className='h-3 w-full' />
            </div>
          </div>
        ))
        : items.map((resource) => (
          <HomeResourceCard key={resource.id} slug={slug} resource={resource} />
        ))}
    </div>
  )
}

/**
 * A resource in a home row. With a platform thumbnail it is the topic rows' card. Without one (a
 * recording, say) it is a text card: a band in the accent wash naming the type, then the title in
 * the display face. Both faces share the thumbnail card's frame, so a row that mixes them stays
 * even, and the text face shows until a thumbnail has actually loaded, so a row of items without
 * thumbnails never shows a run of empty grey boxes.
 */
function HomeResourceCard({ slug, resource }: { slug: string; resource: CardResource }) {
  const { ui } = usePortalLocale()
  const [hasThumbnail, setHasThumbnail] = useState(false)
  const Icon = RESOURCE_ICONS[resource.type]
  const arrows = useContext(CardArrows)
  return (
    <Link
      to={`/t/${slug}/library/${resource.id}`}
      className='rp-card rp-lift rp-focus group relative flex w-64 shrink-0 flex-col overflow-hidden sm:w-72'
    >
      {
        /* The thumbnail card. Until its thumbnail loads it is laid out but hidden, from sight and
         * from screen readers, and gives the text face its size; then the two cross-fade. */
      }
      <div
        className={`flex flex-1 flex-col ${hasThumbnail ? 'rp-anim-fade' : 'invisible'}`}
        aria-hidden={hasThumbnail ? undefined : 'true'}
      >
        <div className='relative aspect-[4/3] w-full overflow-hidden bg-surface-2'>
          <div className='rp-shadow-sm absolute inset-x-6 bottom-0 top-6 overflow-hidden bg-surface'>
            <ResourceThumb
              slug={slug}
              id={resource.id}
              type={resource.type}
              className='rp-zoom'
              imgClassName='object-top'
              onThumbnail={setHasThumbnail}
            />
          </div>
          <span className='absolute left-2 top-2 z-10'>
            <TypeBadge type={resource.type} />
          </span>
        </div>
        <div className='flex flex-1 flex-col gap-1.5 border-t border-line p-3.5'>
          <ResourceProvenanceLabel resourceId={resource.id} />
          <h3 className='rp-clamp-2 text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em] text-ink'>
            {resource.title}
          </h3>
          {resource.summary && resource.summary !== resource.title
            ? <p className='rp-clamp-3 text-sm leading-relaxed text-ink-3'>{resource.summary}</p>
            : null}
        </div>
      </div>
      <div
        className={`absolute inset-0 flex flex-col${hasThumbnail ? ' rp-layout-textcard-out' : ''}`}
        aria-hidden={hasThumbnail ? 'true' : undefined}
      >
        <div className='rp-layout-textcard-band flex items-center gap-2 px-4 py-2.5'>
          <Icon size='sm' className='shrink-0' />
          <span className='rp-eyebrow'>{typeLabel(resource.type, ui)}</span>
        </div>
        <div className='relative flex min-h-0 flex-1 flex-col overflow-hidden p-4'>
          <ResourceProvenanceLabel resourceId={resource.id} />
          <h3 className='rp-display rp-layout-textcard-title rp-clamp-3 break-words text-xl text-ink sm:text-[1.375rem]'>
            {resource.title}
          </h3>
          {arrows
            ? (
              <span
                aria-hidden='true'
                className='rp-layout-card-arrow relative z-10 mt-auto pt-3 text-[var(--rp-accent-fg)]'
              >
                <ArrowRight />
              </span>
            )
            : null}
          <Icon className='rp-layout-textcard-glyph' />
        </div>
      </div>
    </Link>
  )
}

/**
 * The layout's chosen items, in its order. Each is read on its own, so one that no longer
 * resolves, or that this reader may not see, is simply left out; when none is left, so is the
 * section.
 */
function FeaturedSection(
  { slug, section, id }: { slug: string; section: SectionOf<'resources'>; id: string },
) {
  const results = useQueries({
    queries: section.resourceIds.map((resourceId) => ({
      queryKey: ['layout-resource', slug, resourceId],
      queryFn: () => getResource(slug, resourceId),
      // An id that does not resolve for this reader stays left out, rather than being asked for
      // again each time the home page opens.
      retry: false,
      retryOnMount: false,
      staleTime: 5 * 60 * 1000,
    })),
  })
  const loading = results.some((result) => result.isLoading)
  const items = results.flatMap((result) =>
    result.data && result.data.hidden !== true ? [result.data] : []
  )
  if (!loading && items.length === 0) return null
  return (
    <section aria-labelledby={id} className='rp-shell rp-layout-section'>
      <SectionHeader
        id={id}
        heading={section.heading}
        intro={section.intro}
        more={section.moreHref ? { href: section.moreHref, slug } : undefined}
      />
      <ResourceRow slug={slug} items={items} loading={loading} count={section.resourceIds.length} />
    </section>
  )
}

/** The most recently added items, as the recently added list beside the default hero reads them. */
function RecentSection(
  { slug, section, id }: { slug: string; section: SectionOf<'recent'>; id: string },
) {
  const limit = section.limit ?? 6
  const { data, isLoading } = useQuery({
    queryKey: ['recent-documents', slug],
    queryFn: () => getCatalog(slug, { pageSize: 12, sort: 'created', order: 'desc' }),
    staleTime: 5 * 60 * 1000,
  })
  // Only documents the platform has finished with - a pending one has no thumbnail and no real
  // title yet.
  const items: CardResource[] = (data?.items ?? [])
    .filter((item) => item.status === 'processed')
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type ?? 'document',
      summary: item.summary,
    }))
  if (!isLoading && items.length === 0) return null
  return (
    <section aria-labelledby={id} className='rp-shell rp-layout-section'>
      <SectionHeader
        id={id}
        heading={section.heading}
        more={{ href: '/library', slug }}
      />
      <ResourceRow slug={slug} items={items} loading={isLoading} count={limit} />
    </section>
  )
}

function QuestionsSection(
  { section, id, onAsk }: {
    section: SectionOf<'questions'>
    id: string
    onAsk: (text: string) => void
  },
) {
  return (
    <section aria-labelledby={id} className='rp-layout-band'>
      <div className='rp-shell rp-layout-section'>
        <SectionHeader id={id} heading={section.heading} intro={section.intro} />
        <ul className='mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
          {section.questions.map((question, index) => (
            <li key={`${index}-${question}`} className='flex min-w-0'>
              <button
                type='button'
                onClick={() =>
                  onAsk(question)}
                className='rp-suggest-card'
              >
                <MessageSquare className='rp-layout-question-icon shrink-0' />
                <span className='rp-suggest-text min-w-0 break-words'>{question}</span>
                <ArrowRight size='sm' className='rp-suggest-arrow shrink-0' />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function AboutSection(
  { slug, section, id }: { slug: string; section: SectionOf<'about'>; id: string },
) {
  const image = section.image?.url ? section.image : undefined
  return (
    <section aria-labelledby={id} className='rp-shell rp-layout-section'>
      <div
        className={`grid items-center gap-8 lg:gap-14 ${
          image ? 'lg:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,44rem)]' : ''
        }`}
      >
        <div className='min-w-0'>
          <h2 id={id} className='rp-display break-words text-xl text-ink'>
            {section.heading}
          </h2>
          <div className='rp-measure mt-5 space-y-4'>
            <Paragraphs text={section.body} className='rp-prose text-base text-ink-2 sm:text-lg' />
          </div>
          {section.links?.length
            ? (
              <div className='mt-7 flex flex-wrap gap-3'>
                {section.links.map((link, index) => (
                  <LayoutAnchor
                    key={`${index}-${link.href}`}
                    href={link.href}
                    slug={slug}
                    className={`rp-btn ${index === 0 ? 'rp-btn-primary' : 'rp-btn-outline'}`}
                  >
                    {link.label}
                  </LayoutAnchor>
                ))}
              </div>
            )
            : null}
        </div>
        {image
          ? (
            <LayoutPicture
              image={image}
              className='aspect-[16/9] w-full rounded-[var(--rp-radius)] lg:aspect-[3/2]'
            />
          )
          : null}
      </div>
    </section>
  )
}
