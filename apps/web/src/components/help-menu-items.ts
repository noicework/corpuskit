/**
 * The destinations behind the header's help control. The desktop menu and the
 * phone sheet both read this one list, so the two surfaces cannot drift.
 */
export const HELP_MENU_LABEL = 'Help'

export type HelpMenuItem = {
  /** Which icon the row draws. */
  key: 'help' | 'how' | 'tour'
  href: string
  label: string
}

/**
 * The guided tour's row comes last, only where the portal offers the tour: it goes to the
 * home page with `?tour=1`, which opens the tour there (the only page that ever opens it).
 */
export function helpMenuItems(slug: string, options: { tour?: boolean } = {}): HelpMenuItem[] {
  const base = `/t/${slug}`
  return [
    { key: 'help', href: `${base}/help`, label: 'Help and documentation' },
    { key: 'how', href: `${base}/how-it-works`, label: 'How this works' },
    ...(options.tour
      ? [{ key: 'tour' as const, href: `${base}?tour=1`, label: 'Take the tour' }]
      : []),
  ]
}
