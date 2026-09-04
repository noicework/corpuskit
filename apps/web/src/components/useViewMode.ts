import { useEffect, useState } from 'react'

/** How a resource listing lays its cards out. */
export type ViewMode = 'grid' | 'list'

export const VIEW_MODES: ViewMode[] = ['grid', 'list']

/**
 * Tailwind's `sm` breakpoint (40rem). Matched rather than its complement so the
 * boundary is exactly the one the `sm:` utilities use - `max-width` variants
 * have to guess at a sub-pixel epsilon and drift off it.
 */
const SM_BREAKPOINT = '(min-width: 40rem)'

/**
 * True on viewports narrower than the `sm` breakpoint, i.e. phones.
 *
 * A grid card leads with a 4:3 thumbnail sized to the full column width, which
 * on a 390px phone is roughly a screenful of artwork per resource; a list row
 * shows the same resource with a small A4 thumbnail beside its text. So the
 * listing pages start narrow viewports in list view, and the same flag buys a
 * list row a longer summary clamp where the lines are short.
 */
export function useCompactViewport(): boolean {
  const query = () =>
    typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(SM_BREAKPOINT) : null
  const [compact, setCompact] = useState(() => {
    const media = query()
    // No matchMedia (a non-DOM render) is treated as wide: the grid is the
    // long-standing default and only a known-narrow viewport should override it.
    return media ? !media.matches : false
  })

  useEffect(() => {
    const media = query()
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setCompact(!event.matches)
    // Re-read on mount: the viewport may have changed between the first render
    // and this effect (an orientation flip during hydration, say).
    setCompact(!media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return compact
}

/**
 * The layout a listing should render, and the setter its view toggle drives.
 *
 * Until someone touches the toggle the mode simply follows the viewport, so a
 * phone opens in list and a desktop opens in grid. The moment they pick one it
 * is remembered as an explicit choice and the viewport stops having a say -
 * rotating a phone, or dragging a window across the breakpoint, must never undo
 * what the user just asked for.
 */
export function useViewMode(): {
  view: ViewMode
  setView: (next: ViewMode) => void
  /** Narrow viewport, exposed for callers that lay a card out by width too. */
  compact: boolean
} {
  const compact = useCompactViewport()
  const [picked, setPicked] = useState<ViewMode | null>(null)
  return { view: picked ?? (compact ? 'list' : 'grid'), setView: setPicked, compact }
}
