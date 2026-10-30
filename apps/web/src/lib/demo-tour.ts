import {
  type DemoTourMode,
  type DemoTourScene,
  type DemoTourSceneId,
  participatesInFederation,
  type TenantConfig,
} from '@research-portal/core'
import type { MessageValues } from './locale-messages.ts'

/**
 * The guided tour's script: which scenes a portal shows, what each says and where its button
 * goes. Pure functions, so the dialog and its tests share one reading of `copy.demoTour`.
 */

/**
 * The scenes a portal gets when its copy lists none. Participation, provenance and the gaps
 * scene stay available to a portal that lists them.
 */
export const DEFAULT_SCENE_IDS: readonly DemoTourSceneId[] = [
  'federated',
  'cited-page',
  'graph',
  'mcp',
]

/** The portal's own words, with `{name}` values filled in: the locale's `ui`. */
export type TourUi = (english: string, values?: MessageValues) => string

/** What the script needs to know about the portal it introduces. */
export type TourConfig = Pick<TenantConfig, 'copy' | 'entityTypes'> & {
  branding: Pick<TenantConfig['branding'], 'productName' | 'organisation'>
  /** As readers are served it: whether the portal takes part, and its peers' names only. */
  federation?: { participates?: boolean; peers?: readonly unknown[] }
}

type SceneTarget = { kind: 'ask'; question: string } | {
  kind: 'link'
  href: string
  /** What the button says, where the page's name alone would not do ("View a publication"). */
  label?: string
}

/** The portal path that asks `question` on arrival, the path the hero's suggestions take. */
export function askHref(question: string): string {
  return `/ask?ask=${encodeURIComponent(question)}`
}

/**
 * Whether this portal's answers draw on research partners too, so the welcome may say so: it
 * takes part in federated ask (the default, unless its owner has opted out) and has at least
 * one peer collection to draw on.
 */
export function federatedAsk(config: TourConfig): boolean {
  return participatesInFederation(config) && (config.federation?.peers?.length ?? 0) > 0
}

/** "Topic", "Research Method" and "EEG" read mid-sentence as "topic", "research method", "EEG". */
function midSentence(label: string): string {
  return label.split(' ').map((word) => {
    const second = word.charAt(1)
    return second && second === second.toLowerCase() ? word.toLowerCase() : word
  }).join(' ')
}

/** "a, b and c": the Graph's kinds of thing as the portal configured them. */
export function graphKinds(config: Pick<TenantConfig, 'entityTypes'>, ui: TourUi): string {
  const labels = config.entityTypes.map((type) => midSentence(type.label)).filter(Boolean)
  if (labels.length === 0) return ui('topics, entities and the documents that connect them')
  if (labels.length === 1) return labels[0]!
  return ui('{most} and {last}', {
    most: labels.slice(0, -1).join(', '),
    last: labels[labels.length - 1]!,
  })
}

/**
 * A scene's built-in words and target. The words promise only what the button then shows: the
 * answer steps open Ask for the reader's own question, and a collection without a PDF opens
 * the Library.
 */
function builtIn(
  id: DemoTourSceneId,
  config: TourConfig,
  firstPdfId: string | null,
  ui: TourUi,
): { title: string; body: string; target: SceneTarget } {
  const portal = config.branding.productName
  // The built-in steps send the reader to Ask to put their own question; a portal that sets a
  // `question` for a step sends that question instead, and the dialog shows it beside the button.
  const ask: SceneTarget = { kind: 'link', href: '/ask', label: ui('Ask a question') }
  switch (id) {
    case 'federated':
      return {
        title: ui('Find answers and sources'),
        body: ui(
          '{portal} answers your questions and provides citations for any claims made, linking you directly to the relevant source material.\n\nYou can also use conventional search, or browse the collection through the Graph and the Library.',
          { portal },
        ),
        target: ask,
      }
    case 'provenance':
      return {
        title: ui('See where an answer came from'),
        body: ui(
          'Under an answer, "Show retrieved sources" opens the sources that were found and the passages that matched. "Journey through the context" walks through those sources one at a time.',
        ),
        target: ask,
      }
    case 'cited-page':
      return {
        title: ui('Follow the evidence'),
        body: ui(
          'When an answer provides a citation, you can jump straight into the source document, view the passage, and ask further questions there.',
        ),
        target: firstPdfId
          ? {
            kind: 'link',
            href: `/library/${encodeURIComponent(firstPdfId)}`,
            label: ui('View a publication'),
          }
          : { kind: 'link', href: '/library', label: ui('Browse the Library') },
      }
    case 'graph':
      return {
        title: ui('Visualise connections'),
        body: ui('The Graph maps links between {kinds}.', { kinds: graphKinds(config, ui) }),
        target: { kind: 'link', href: '/graph', label: ui('Open Graph') },
      }
    case 'mcp':
      return {
        title: ui('Bring your own tools'),
        body: ui(
          'You can connect your own AI agent to {portal} through its Model Context Protocol (MCP) connector for powerful, granular queries.',
          { portal },
        ),
        target: { kind: 'link', href: '/tools', label: ui('Open Tools') },
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
export function actionLabel(target: SceneTarget, ui: TourUi): string {
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
  config: TourConfig,
  firstPdfId: string | null,
  ui: TourUi,
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

// ---- Open across a remount --------------------------------------------------------------
//
// The page remounts when a fresh read of the session finds the person's access changed (the
// access layer starts a new generation), which would close the tour. So while the tour is open,
// the step it is on is kept for the tab; a remount opens it again at that step, and closing it
// forgets.

const OPEN_KEY = 'rp_demo_tour_open'

function tab(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** The step the tour was open at in this tab, or null when it was not open. */
export function tourProgress(slug: string): number | null {
  try {
    const raw = tab()?.getItem(`${OPEN_KEY}:${slug}`)
    const step = raw === null || raw === undefined ? NaN : Number(raw)
    return Number.isInteger(step) && step >= 0 ? step : null
  } catch {
    return null
  }
}

export function rememberTourProgress(slug: string, step: number): void {
  try {
    tab()?.setItem(`${OPEN_KEY}:${slug}`, String(step))
  } catch {
    // No tab storage: the tour simply closes on a remount.
  }
}

export function forgetTourProgress(slug: string): void {
  try {
    tab()?.removeItem(`${OPEN_KEY}:${slug}`)
  } catch {
    // Nothing was kept.
  }
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
