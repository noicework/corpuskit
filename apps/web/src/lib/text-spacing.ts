/**
 * Readers may set their own text spacing (WCAG 1.4.12) with a bookmarklet, an extension or a user
 * stylesheet. The `rp-clamp-*` rules cut card text at a line count, so wider letters and words
 * leave fewer words in those lines (accessibility audit, 28 Oct 2026). While the reader's
 * spacing applies, the clamps let go and show the whole text
 * (`:root[data-text-spacing='custom']` in `styles.css`).
 *
 * A hidden probe pins both properties to zero, so only the reader's own `!important` rules can
 * move them, however they arrive. Their arrival or removal changes the probe's width, which a
 * ResizeObserver sees even for a stylesheet that never touches the DOM.
 */

/** The part of a computed style the check reads. */
export interface ProbeStyle {
  readonly fontSize: string
  readonly letterSpacing: string
  readonly wordSpacing: string
}

/** Below this share of the font size a spacing is rounding, not a reader's setting. */
const THRESHOLD_EM = 0.02

/**
 * Whether the probe's pinned letter or word spacing has been widened. Line height and paragraph
 * spacing are not read: a clamp counts lines, so neither changes which words it shows.
 */
export function readerSpacing(style: ProbeStyle): boolean {
  const size = parseFloat(style.fontSize) || 16
  // `normal` parses as NaN, which is no added spacing.
  const widened = (value: string) => (parseFloat(value) || 0) > size * THRESHOLD_EM
  return widened(style.letterSpacing) || widened(style.wordSpacing)
}

/**
 * Keep `data-text-spacing="custom"` on the root element while the reader's own letter or word
 * spacing applies. Returns a function that stops watching and removes the probe.
 */
export function watchTextSpacing(doc: Document = document): () => void {
  const root = doc.documentElement
  const probe = doc.createElement('span')
  probe.className = 'rp-spacing-probe'
  probe.setAttribute('aria-hidden', 'true')
  // A letter pair and a space, so both letter and word spacing change its width.
  probe.textContent = 'W W'
  doc.body.append(probe)
  const check = () => {
    const view = doc.defaultView
    if (!view) return
    if (readerSpacing(view.getComputedStyle(probe))) root.dataset.textSpacing = 'custom'
    else delete root.dataset.textSpacing
  }
  check()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
  observer?.observe(probe)
  return () => {
    observer?.disconnect()
    probe.remove()
    delete root.dataset.textSpacing
  }
}
