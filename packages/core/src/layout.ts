import { z } from 'zod'

// ---------------------------------------------------------------------------
// Portal layout: an optional, per-portal composition of the header links, the
// footer and the home page. Absent, every portal renders its built-in chrome
// and Explore. Every string renders as plain text, never as HTML or Markdown.
// ---------------------------------------------------------------------------

/** Upper bounds on every list and string in a layout, enforced by the schema below. */
export const LAYOUT_LIMITS = {
  /** Custom header links, after the built-in items. */
  navLinks: 6,
  footerColumns: 4,
  footerColumnLinks: 8,
  heroQuestions: 6,
  sections: 10,
  cards: 12,
  resources: 12,
  recent: 12,
  questions: 8,
  aboutLinks: 4,
  linkLabel: 48,
  href: 2000,
  heading: 120,
  intro: 400,
  heroBody: 400,
  cardTitle: 100,
  cardBody: 300,
  question: 200,
  aboutBody: 2000,
  footerNote: 240,
  alt: 200,
} as const

/** Uploaded layout images per portal (`/api/admin/t/:slug/branding/image/:name`). */
export const MAX_LAYOUT_IMAGES = 24

/** An uploaded layout image's name: lower-case letters, digits and hyphens, at most 40. */
export const LAYOUT_IMAGE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Built-in header items a portal may leave out of its navigation. Their routes still work. */
export const HIDEABLE_NAV_ITEMS = [
  'graph',
  'tools',
  'investigations',
  'generate',
  'assessment',
] as const
export type HideableNavItem = typeof HIDEABLE_NAV_ITEMS[number]

/**
 * Where a portal path resolves: under `/t/:slug`. Resolving against a fixed base lets the URL
 * parser apply its own dot-segment rules (`..`, `%2e%2e`), so a path that would climb out of the
 * portal is caught however it is spelled.
 */
const PORTAL_BASE = 'https://portal.invalid/t/portal'

/**
 * Whether `href` is a link a layout may carry: an absolute `https://` URL with a host and no
 * credentials, or a portal path that starts with a single `/` and stays inside the portal
 * (`/library`, `/search?q=soil`, `/entity/Example`). Anything else is refused, including
 * `javascript:`, `data:`, `http:`, protocol-relative `//host` and backslashes.
 */
export function isLayoutHref(href: string): boolean {
  if (href.length === 0 || href.length > LAYOUT_LIMITS.href) return false
  // Whitespace, controls and backslashes have no place in a link a person typed for a portal.
  // deno-lint-ignore no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(href)) return false
  if (href.startsWith('/')) {
    if (href.startsWith('//')) return false
    let url: URL
    try {
      url = new URL(PORTAL_BASE + href)
    } catch {
      return false
    }
    return url.origin === 'https://portal.invalid' &&
      (url.pathname === '/t/portal' || url.pathname.startsWith('/t/portal/'))
  }
  if (!/^https:\/\//i.test(href)) return false
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname !== '' && url.username === '' &&
    url.password === ''
}

/** A layout link's destination: a route inside the portal, or an external `https://` address. */
export function layoutHrefTarget(
  href: string,
  slug: string,
): { external: false; to: string } | { external: true; url: string } | null {
  if (!isLayoutHref(href)) return null
  return href.startsWith('/')
    ? { external: false, to: `/t/${encodeURIComponent(slug)}${href === '/' ? '' : href}` }
    : { external: true, url: href }
}

/** One line of plain text: no line breaks or control characters. */
const line = (max: number) =>
  z.string().trim().min(1, 'must not be empty').max(max, `must be at most ${max} characters`)
    // deno-lint-ignore no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must be one line of plain text')

/** Plain text that may hold line breaks (a blank line starts a new paragraph). */
const paragraphs = (max: number) =>
  z.string().trim().min(1, 'must not be empty').max(max, `must be at most ${max} characters`)
    .refine(
      // deno-lint-ignore no-control-regex
      (value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.replace(/\r\n/g, '\n')),
      'must be plain text',
    )

const list = <T extends z.ZodTypeAny>(item: T, max: number, what: string) =>
  item.array().max(max, `must hold at most ${max} ${what}`)

export const LayoutHrefSchema = z.string().refine(
  isLayoutHref,
  'must be an https:// address or a portal path starting with "/", such as "/library"',
)

export const LayoutLinkSchema = z.object({
  label: line(LAYOUT_LIMITS.linkLabel),
  href: LayoutHrefSchema,
}).strict()
export type LayoutLink = z.infer<typeof LayoutLinkSchema>

/**
 * An image uploaded to the portal (`POST /api/admin/t/:slug/branding/image/:name`), named by
 * `asset`. `alt` describes it for people who cannot see it; an empty `alt` marks it decorative.
 * `url` is written by the server when it serves the configuration (the asset's versioned
 * address), and any value sent in is discarded. A reference to an image that was never uploaded,
 * or has since been deleted, is left out of the served configuration rather than drawn broken.
 */
export const LayoutImageSchema = z.object({
  asset: z.string().regex(LAYOUT_IMAGE_NAME, 'must name an uploaded image, such as "banner"'),
  alt: z.string().trim().max(LAYOUT_LIMITS.alt, `must be at most ${LAYOUT_LIMITS.alt} characters`)
    // deno-lint-ignore no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must be one line of plain text'),
  url: z.string().max(LAYOUT_LIMITS.href).optional(),
}).strict()
export type LayoutImage = z.infer<typeof LayoutImageSchema>

const heading = line(LAYOUT_LIMITS.heading)
const intro = paragraphs(LAYOUT_LIMITS.intro).optional()

export const HomeSectionSchema = z.discriminatedUnion('kind', [
  /** Cards linking anywhere in the portal or beyond it, each with an optional image. */
  z.object({
    kind: z.literal('cards'),
    heading,
    intro,
    cards: list(
      z.object({
        title: line(LAYOUT_LIMITS.cardTitle),
        body: paragraphs(LAYOUT_LIMITS.cardBody).optional(),
        href: LayoutHrefSchema,
        image: LayoutImageSchema.optional(),
      }).strict(),
      LAYOUT_LIMITS.cards,
      'cards',
    ).min(1, 'must hold at least one card'),
  }).strict(),
  /**
   * Chosen items from the knowledge box, in this order. An id that no longer resolves, or that
   * the reader may not see, is left out.
   */
  z.object({
    kind: z.literal('resources'),
    heading,
    intro,
    resourceIds: list(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'must be a resource id'),
      LAYOUT_LIMITS.resources,
      'resources',
    ).min(1, 'must hold at least one resource'),
    moreHref: LayoutHrefSchema.optional(),
  }).strict(),
  /** The most recently added items. */
  z.object({
    kind: z.literal('recent'),
    heading,
    limit: z.number().int().min(1).max(LAYOUT_LIMITS.recent).optional(),
  }).strict(),
  /** Questions that open Ask with the question already sent. */
  z.object({
    kind: z.literal('questions'),
    heading,
    intro,
    questions: list(line(LAYOUT_LIMITS.question), LAYOUT_LIMITS.questions, 'questions')
      .min(1, 'must hold at least one question'),
  }).strict(),
  /** A passage about the portal or its community. A blank line in `body` starts a paragraph. */
  z.object({
    kind: z.literal('about'),
    heading,
    body: paragraphs(LAYOUT_LIMITS.aboutBody),
    image: LayoutImageSchema.optional(),
    links: list(LayoutLinkSchema, LAYOUT_LIMITS.aboutLinks, 'links').optional(),
  }).strict(),
  /** The built-in topic rows from Explore, unchanged. */
  z.object({ kind: z.literal('topics') }).strict(),
])
export type HomeSection = z.infer<typeof HomeSectionSchema>

export const PortalLayoutSchema = z.object({
  nav: z.object({
    links: list(LayoutLinkSchema, LAYOUT_LIMITS.navLinks, 'links').optional(),
    hide: list(z.enum(HIDEABLE_NAV_ITEMS), HIDEABLE_NAV_ITEMS.length, 'items').optional(),
  }).strict().optional(),
  footer: z.object({
    columns: list(
      z.object({
        heading: line(LAYOUT_LIMITS.linkLabel),
        links: list(LayoutLinkSchema, LAYOUT_LIMITS.footerColumnLinks, 'links')
          .min(1, 'must hold at least one link'),
      }).strict(),
      LAYOUT_LIMITS.footerColumns,
      'columns',
    ).optional(),
    note: line(LAYOUT_LIMITS.footerNote).optional(),
    poweredBy: z.boolean().optional(),
  }).strict().optional(),
  home: z.object({
    hero: z.object({
      heading: line(LAYOUT_LIMITS.heading).optional(),
      body: paragraphs(LAYOUT_LIMITS.heroBody).optional(),
      image: LayoutImageSchema.optional(),
      questions: list(line(LAYOUT_LIMITS.question), LAYOUT_LIMITS.heroQuestions, 'questions')
        .optional(),
    }).strict().optional(),
    sections: list(HomeSectionSchema, LAYOUT_LIMITS.sections, 'sections'),
  }).strict().optional(),
}).strict()
export type PortalLayout = z.infer<typeof PortalLayoutSchema>

/**
 * The layout with every image reference passed through `map`: what it returns replaces the
 * reference, and `undefined` removes it. The server uses it to discard image addresses sent in and
 * to write the served ones.
 */
export function mapLayoutImages(
  layout: PortalLayout,
  map: (image: LayoutImage) => LayoutImage | undefined,
): PortalLayout {
  const image = <T extends { image?: LayoutImage }>(holder: T): T => {
    if (!holder.image) return holder
    const { image: original, ...rest } = holder
    const mapped = map(original)
    return (mapped ? { ...rest, image: mapped } : rest) as T
  }
  const home = layout.home
  return {
    ...layout,
    ...(home
      ? {
        home: {
          ...home,
          ...(home.hero ? { hero: image(home.hero) } : {}),
          sections: home.sections.map((section) =>
            section.kind === 'cards'
              ? { ...section, cards: section.cards.map(image) }
              : section.kind === 'about'
              ? image(section)
              : section
          ),
        },
      }
      : {}),
  }
}

/** Every uploaded image name the layout refers to. */
export function layoutImageNames(layout: PortalLayout): string[] {
  const names = new Set<string>()
  mapLayoutImages(layout, (image) => {
    names.add(image.asset)
    return image
  })
  return [...names]
}

/** A layout's validation failures as one readable sentence, naming where each one is. */
export function describeLayoutIssues(error: z.ZodError, prefix = 'layout'): string {
  const issues = error.issues.slice(0, 5).map((issue) => {
    const path = [prefix, ...issue.path].reduce<string>(
      (out, part) => typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part,
      '',
    )
    const message = issue.code === 'unrecognized_keys'
      ? `unknown field ${issue.keys.map((key) => `"${key}"`).join(', ')}`
      : issue.message
    return `${path}: ${message}`
  })
  const more = error.issues.length - issues.length
  return issues.join('; ') + (more > 0 ? `; and ${more} more` : '') + '.'
}
