/**
 * The destinations behind the header's help control. The desktop menu and the
 * phone sheet both read this one list, so the two surfaces cannot drift.
 */
export const HELP_MENU_LABEL = 'Help'

export type HelpMenuItem = {
  /** Which icon the row draws. */
  key: 'help' | 'how'
  href: string
  label: string
}

export function helpMenuItems(slug: string): HelpMenuItem[] {
  const base = `/t/${slug}`
  return [
    { key: 'help', href: `${base}/help`, label: 'Help and documentation' },
    { key: 'how', href: `${base}/how-it-works`, label: 'How this works' },
  ]
}
