/**
 * The name of the surface a portal path lands on, for the browser tab.
 *
 * Nine of eleven pages used to set the same generic title, which made tabs
 * and bookmarks indistinguishable (review loop 6
 * D6-14). Each page's own heading supplies the name here, so a reader with
 * the library, an answer and a briefing open can tell them apart, and a
 * bookmark says what it points at.
 */

type TitleUi = (message: string) => string
const englishTitle: TitleUi = (message) => message

/** The surface names, keyed by the path segment under `/t/:slug`. */
const SURFACES: [RegExp, string][] = [
  [/^ask(?:\/|$)/, 'Ask'],
  [/^search(?:\/|$)/, 'Search'],
  [/^library\/[^/]+/, 'Document'],
  [/^library(?:\/|$)/, 'Library'],
  [/^investigations\/[^/]+/, 'Investigation'],
  [/^investigations(?:\/|$)/, 'Investigations'],
  [/^agentic(?:\/|$)/, 'Agentic'],
  [/^generate(?:\/|$)/, 'Generate'],
  [/^assessment(?:\/|$)/, 'Assessment'],
  [/^graph(?:\/|$)/, 'Knowledge graph'],
  [/^tools(?:\/|$)/, 'Tools'],
  [/^help(?:\/|$)/, 'Help'],
  [/^how-it-works(?:\/|$)/, 'How this works'],
  [/^taxonomy(?:\/|$)/, 'Taxonomy'],
  [/^manage(?:\/|$)/, 'Manage'],
]

/**
 * The surface name for a portal path, or undefined on the portal home (and
 * on any path this does not recognise), where the product name stands
 * alone. An entity page is named for its entity, which is the only thing
 * that distinguishes one from another.
 */
export function surfaceName(pathname: string, ui: TitleUi = englishTitle): string | undefined {
  const rest = /^\/t\/[^/]+\/?(.*)$/.exec(pathname)?.[1] ?? ''
  const trimmed = rest.replace(/\/+$/, '')
  if (!trimmed) return undefined
  const entity = /^entity\/(.+)$/.exec(trimmed)
  if (entity?.[1]) {
    try {
      return decodeURIComponent(entity[1]).replace(/\+/g, ' ').trim() || ui('Entity')
    } catch {
      return ui('Entity')
    }
  }
  const surface = SURFACES.find(([pattern]) => pattern.test(trimmed))?.[1]
  return surface ? ui(surface) : undefined
}

/**
 * "Library | Southern Waters Research Portal", or the product name on the home page. A page's
 * own subject (a document's title, the library's search and filters) goes in front, so tabs of
 * the same surface differ: "Kelp forest recovery | Document | Southern Waters Research Portal".
 */
export function pageTitle(
  pathname: string,
  productName: string,
  ui: TitleUi = englishTitle,
  subject?: string | null,
): string {
  const surface = surfaceName(pathname, ui)
  const named = surface ? `${surface} | ${productName}` : productName
  const lead = subject?.trim()
  return lead ? `${lead} | ${named}` : named
}
