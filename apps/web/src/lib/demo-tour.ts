import {
  type DemoTourMode,
  type DemoTourScene,
  type DemoTourSceneId,
  type TenantConfig,
} from '@research-portal/core'

/**
 * The guided tour's script: which scenes a portal shows, what each says and where its "Try it"
 * goes. Pure functions, so the dialog and its tests share one reading of `copy.demoTour`.
 */

/** The scenes a portal gets when its copy lists none. Participation is off until it is built. */
export const DEFAULT_SCENE_IDS: readonly DemoTourSceneId[] = [
  'federated',
  'provenance',
  'cited-page',
  'mcp',
  'gaps',
]

type SceneTarget = { kind: 'ask'; question: string } | { kind: 'link'; href: string }

/** The portal path that asks `question` on arrival, the path the hero's suggestions take. */
export function askHref(question: string): string {
  return `/ask?ask=${encodeURIComponent(question)}`
}

/**
 * A scene's built-in words and target. The federated answer tries Ask until the agent page
 * exists; when it lands, this scene's target becomes `/agent?q=<question>&run=1`.
 */
function builtIn(
  id: DemoTourSceneId,
  config: Pick<TenantConfig, 'suggestedQuestions'>,
  firstPdfId: string | null,
  ui: (english: string) => string,
): { title: string; body: string; target: SceneTarget } {
  const suggested = config.suggestedQuestions.map((question) => question.text)
  const first = suggested[0] ?? ui('What are the main findings in this collection?')
  const second = suggested[1] ?? first
  switch (id) {
    case 'federated':
      return {
        title: ui('Ask across every collection'),
        body: ui(
          'One question, answered across several research collections at once. Each claim carries a numbered citation, and the answer names the collections it drew on.',
        ),
        target: { kind: 'ask', question: first },
      }
    case 'provenance':
      return {
        title: ui('See how an answer was made'),
        body: ui(
          'The portal shows each stage of an answer as it works, then keeps the sources under it. Open the retrieved sources, then Journey through the context, to read the passages the answer was built from.',
        ),
        target: { kind: 'ask', question: second },
      }
    case 'cited-page':
      return {
        title: ui('Open the PDF at the cited page'),
        body: ui(
          'A citation takes you to the page it came from, with the matched passage marked, not to the top of a file.',
        ),
        target: {
          kind: 'link',
          href: firstPdfId ? `/library/${encodeURIComponent(firstPdfId)}` : '/library',
        },
      }
    case 'mcp':
      return {
        title: ui('Connect an external research tool over MCP'),
        body: ui(
          'The MCP connector gives approved external research tools read-only access to this portal: they can search the collection, request a cited answer, retrieve a document and browse the catalogue. The connection details are on Tools.',
        ),
        target: { kind: 'link', href: '/tools' },
      }
    case 'participation':
      return {
        title: ui('See who took part'),
        body: ui(
          'Each organisation decides whether its collection takes part in a federated answer. The answer shows which collections did.',
        ),
        target: { kind: 'link', href: '/agent' },
      }
    case 'gaps':
      return {
        title: ui('Find the gaps'),
        body: ui(
          'Ask something the collection does not cover and the portal says so, with the closest matches, instead of guessing. Administrators see every gap in Manage, under Insights.',
        ),
        target: {
          kind: 'ask',
          question: ui('What was published on this topic in the last week?'),
        },
      }
  }
}

export type ResolvedScene = {
  id: DemoTourSceneId
  title: string
  body: string
  /** Where "Try it" goes: a portal path, or an `https://` address. */
  href: string
  /** Whether "Try it" asks a question (as against opening a page). */
  asks: boolean
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
