/**
 * An observed return to the page withdraws authority until the session is read again, which
 * remounts the page (`AccessProvider`). When that check confirms the same authority, the person
 * gets their place back: the control that had focus takes it again once the new page renders it,
 * instead of focus falling to the top of the document (accessibility audit, 28 Oct 2026).
 *
 * The control is found again by its id, or else by what it is (tag, role, link target, name and
 * label) and which occurrence of that it was. Occurrences are counted only once the page holds
 * as many of them as it did before, so a page still loading never hands focus to the wrong one.
 */

/** Where focus was when the person came back. */
export interface FocusAnchor {
  readonly id: string
  readonly tag: string
  readonly signature: string
  readonly occurrence: number
  readonly count: number
}

/** The access gate keeps its own focus rules: its heading takes focus on an outcome. */
const GATE = '[data-access-state]'

/** How long a remounted page has to render the control before the person keeps focus as it is. */
const RESTORE_MS = 5000

function signature(element: Element): string {
  const name = (element.getAttribute('aria-label') ?? element.textContent ?? '')
    .replace(/\s+/g, ' ').trim()
  return JSON.stringify([
    element.getAttribute('role'),
    element.getAttribute('href'),
    element.getAttribute('name'),
    name,
  ])
}

function matching(doc: Document, tag: string, wanted: string): Element[] {
  return [...doc.body.getElementsByTagName(tag)].filter((element) =>
    !element.closest(GATE) && signature(element) === wanted
  )
}

/** The focused control on the page, or null when focus is on the document itself or the gate. */
export function focusAnchor(doc: Document): FocusAnchor | null {
  const element = doc.activeElement
  if (!element || element === doc.body || element.closest(GATE)) return null
  const tag = element.tagName
  const wanted = signature(element)
  const same = matching(doc, tag, wanted)
  return {
    id: element.id,
    tag,
    signature: wanted,
    occurrence: same.indexOf(element),
    count: same.length,
  }
}

/** The control the anchor describes on the page as it is now, if it has rendered. */
export function findAnchor(doc: Document, anchor: FocusAnchor): HTMLElement | null {
  const byId = anchor.id ? doc.getElementById(anchor.id) : null
  if (byId instanceof HTMLElement && byId.tagName === anchor.tag && !byId.closest(GATE)) return byId
  const same = matching(doc, anchor.tag, anchor.signature)
  if (same.length !== anchor.count) return null
  const found = same[anchor.occurrence]
  return found instanceof HTMLElement ? found : null
}

/**
 * Focus the anchor's control once the page renders it, while `current()` holds. The person
 * acting first (focusing, clicking, pressing a key or scrolling) ends the attempt, as does the
 * time limit. Returns a function that ends it.
 */
export function restoreFocus(
  doc: Document,
  anchor: FocusAnchor,
  current: () => boolean,
): () => void {
  const view = doc.defaultView
  if (!view) return () => {}
  let frame = 0
  const events = ['focusin', 'pointerdown', 'keydown', 'wheel'] as const
  const stop = () => {
    observer.disconnect()
    if (frame) view.cancelAnimationFrame(frame)
    view.clearTimeout(timer)
    for (const event of events) doc.removeEventListener(event, stop, true)
  }
  const attempt = () => {
    frame = 0
    if (!current() || (doc.activeElement && doc.activeElement !== doc.body)) return stop()
    const element = findAnchor(doc, anchor)
    if (!element) return
    stop()
    element.focus()
  }
  const observer = new MutationObserver(() => {
    if (!frame) frame = view.requestAnimationFrame(attempt)
  })
  observer.observe(doc.body, { childList: true, subtree: true })
  const timer = view.setTimeout(stop, RESTORE_MS)
  for (const event of events) doc.addEventListener(event, stop, { capture: true, passive: true })
  attempt()
  return stop
}
