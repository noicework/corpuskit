import {
  type DemoTourMode,
  type DemoTourScene,
  type DemoTourSceneId,
  type TenantConfig,
} from '@research-portal/core'

/**
 * The guided tour's script: which scenes a portal shows, what each says and where its button
 * goes. Pure functions, so the dialog and its tests share one reading of `copy.demoTour`.
 */

/**
 * The scenes a portal gets when its copy lists none: the evidence arc first (an answer, its
 * sources, the cited page, what happens without evidence), then the connector, whose audience
 * is narrowest. Participation is off until it is built.
 */
export const DEFAULT_SCENE_IDS: readonly DemoTourSceneId[] = [
  'federated',
  'provenance',
  'cited-page',
  'gaps',
  'mcp',
]

type SceneTarget = { kind: 'ask'; question: string } | {
  kind: 'link'
  href: string
  /** What the button says, where the page's name alone would not do ("Open a PDF"). */
  label?: string
}

/** The portal path that asks `question` on arrival, the path the hero's suggestions take. */
export function askHref(question: string): string {
  return `/ask?ask=${encodeURIComponent(question)}`
}

/**
 * A scene's built-in words and target. The words promise only what the button then shows: a
 * portal without a suggested question opens Ask empty rather than sending a question the
 * reader never saw, and the gaps scene asks nothing unless the portal sets a question it
 * knows the collection cannot answer. The first scene becomes the agent page's composed
 * answer, through its copy, once that page exists.
 */
function builtIn(
  id: DemoTourSceneId,
  config: Pick<TenantConfig, 'suggestedQuestions'>,
  firstPdfId: string | null,
  ui: (english: string) => string,
): { title: string; body: string; target: SceneTarget } {
  const suggested = config.suggestedQuestions.map((question) => question.text)
  const ask = (text: string | undefined): SceneTarget =>
    text ? { kind: 'ask', question: text } : { kind: 'link', href: '/ask' }
  switch (id) {
    case 'federated':
      return {
        title: ui('Get a cited answer'),
        body: ui('Ask in your own words. Each numbered citation links to its source.'),
        target: ask(suggested[0]),
      }
    case 'provenance':
      return {
        title: ui('See where an answer came from'),
        body: ui(
          'Under an answer, "Show retrieved sources" opens the sources that were found and the passages that matched. "Journey through the context" walks through those sources one at a time.',
        ),
        target: ask(suggested[1] ?? suggested[0]),
      }
    case 'cited-page':
      return {
        title: ui('Check the page behind a citation'),
        body: ui(
          'When a citation points to a page in a PDF, it opens the PDF at that page with the matched passage highlighted and quoted.',
        ),
        target: firstPdfId
          ? {
            kind: 'link',
            href: `/library/${encodeURIComponent(firstPdfId)}`,
            label: ui('Open a PDF'),
          }
          : { kind: 'link', href: '/library' },
      }
    case 'mcp':
      return {
        title: ui('Connect a research tool'),
        body: ui(
          'If your research tool supports MCP, it can search this collection and request cited answers. The Tools page has the connection details and says whether you need an access key.',
        ),
        target: { kind: 'link', href: '/tools' },
      }
    case 'participation':
      return {
        title: ui('See which collections were used'),
        body: ui(
          'An answer that draws on more than one collection also lists any it could not reach.',
        ),
        target: { kind: 'link', href: '/agent', label: ui('Open the answer page') },
      }
    case 'gaps':
      return {
        title: ui('Spot weak or missing evidence'),
        body: ui(
          'If the research collection cannot support an answer, Ask shows "No direct evidence found" and lists the closest matches, which it did not use. Treat a low-confidence answer as a lead and check its sources.',
        ),
        target: { kind: 'link', href: '/ask' },
      }
  }
}

export type ResolvedScene = {
  id: DemoTourSceneId
  title: string
  body: string
  /** Where the scene's button goes: a portal path, or an `https://` address. */
  href: string
  /** Whether the button asks a question (as against opening a page). */
  asks: boolean
  /** The question the button sends, shown beside it so the reader knows what they are asking. */
  question?: string
  /** What the button says: the action and its object, never a bare "it". */
  action: string
}

/**
 * The button's words name what it does and where: "Ask this question", "Open Tools". A portal
 * path the tour knows gets its page's name; any other link is simply opened.
 */
export function actionLabel(
  target: SceneTarget,
  ui: (english: string) => string,
): string {
  if (target.kind === 'ask') return ui('Ask this question')
  if (target.label) return target.label
  const path = target.href.split(/[?#]/)[0] ?? ''
  if (path === '/tools') return ui('Open Tools')
  if (path === '/library') return ui('Open the Library')
  if (path.startsWith('/library/')) return ui('Open the document')
  if (path === '/ask' || path.startsWith('/ask/')) return ui('Open Ask')
  if (path.startsWith('/manage')) return ui('Open Manage')
  return target.href.startsWith('/') ? ui('Open the page') : ui('Open the link')
}

/**
 * The scenes the tour shows, with the portal's words and targets over the built-in ones. A
 * listed scene with `href` goes there; with `question` it asks that; with neither it keeps its
 * built-in target.
 */
export function resolveScenes(
  config: Pick<TenantConfig, 'suggestedQuestions' | 'copy'>,
  firstPdfId: string | null,
  ui: (english: string) => string,
): ResolvedScene[] {
  const listed: readonly DemoTourScene[] = config.copy?.demoTour?.scenes ??
    DEFAULT_SCENE_IDS.map((id) => ({ id }))
  return listed.map((scene) => {
    const base = builtIn(scene.id, config, firstPdfId, ui)
    const target: SceneTarget = scene.href
      ? { kind: 'link', href: scene.href }
      : scene.question
      ? { kind: 'ask', question: scene.question }
      : base.target
    return {
      id: scene.id,
      title: scene.title ?? base.title,
      body: scene.body ?? base.body,
      href: target.kind === 'ask' ? askHref(target.question) : target.href,
      asks: target.kind === 'ask',
      ...(target.kind === 'ask' ? { question: target.question } : {}),
      action: actionLabel(target, ui),
    }
  })
}

/** Whether the cited-page scene needs the collection's first PDF found for it. */
export function needsFirstPdf(config: Pick<TenantConfig, 'copy'>): boolean {
  const listed: readonly DemoTourScene[] = config.copy?.demoTour?.scenes ??
    DEFAULT_SCENE_IDS.map((id) => ({ id }))
  return listed.some((scene) => scene.id === 'cited-page' && !scene.href)
}

// ---- Once per browser ---------------------------------------------------------------------

const DONE_KEY = 'rp_demo_tour_done'

/** The browser's own storage, or null where it is refused (a private window, a cleared site). */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Whether this browser has already had the tour open, by itself or on request. */
export function isTourDone(): boolean {
  try {
    return storage()?.getItem(DONE_KEY) === '1'
  } catch {
    // Without storage every visit is a first visit, so an automatic tour plays again; better
    // than never playing it.
    return false
  }
}

export function markTourDone(): void {
  try {
    storage()?.setItem(DONE_KEY, '1')
  } catch {
    // Private mode: nothing to remember with.
  }
}

/**
 * Whether the home page opens the tour by itself on this visit. `?tour=1` opens it on any
 * portal that offers the tour at all, so a deep link into the demo works; `?tour=0` never
 * does. Otherwise only `auto` opens it, and only once per browser. The question is only ever
 * asked by the home page, so an automatic tour never opens over an answer in progress.
 */
export function startsOnArrival(mode: DemoTourMode, search: string, done: boolean): boolean {
  if (mode === 'off') return false
  const forced = new URLSearchParams(search).get('tour')
  if (forced === '1') return true
  if (forced === '0') return false
  return mode === 'auto' && !done
}
