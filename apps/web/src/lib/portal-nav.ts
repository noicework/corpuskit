import type { LayoutLink, PortalLayout } from '@research-portal/core'

/**
 * The header's destinations: the built-in items the reader may open, less those the portal's
 * layout hides, followed by the links the layout adds. Without a layout, the built-in items
 * alone, as before.
 */
export function portalNavigation<T extends { id: string }>(
  items: readonly T[],
  layout: PortalLayout | undefined,
): { items: T[]; links: LayoutLink[] } {
  const hidden = new Set<string>(layout?.nav?.hide ?? [])
  return {
    items: items.filter((item) => !hidden.has(item.id)),
    links: layout?.nav?.links ?? [],
  }
}
