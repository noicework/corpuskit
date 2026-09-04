export type AccountMenuTabDirection = 'forward' | 'backward'

type AdminTriggerAttributes = {
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
}

type StandardTriggerAttributes = {
  'aria-haspopup': 'dialog'
}

/**
 * Keeps the non-admin contract explicit: there is no disclosure state or menu
 * relationship for people whose account control still opens the identity
 * dialog directly.
 */
export function accountTriggerAttributes(
  isAdmin: boolean,
  open: boolean,
  menuId: string,
): AdminTriggerAttributes | StandardTriggerAttributes {
  return isAdmin
    ? {
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': menuId,
    }
    : { 'aria-haspopup': 'dialog' }
}

/** The wrapped focus index for a two-way vertical menu. */
export function nextAccountMenuIndex(
  current: number,
  length: number,
  direction: 'next' | 'previous' | 'first' | 'last',
): number {
  if (length <= 0) return -1
  if (direction === 'first') return 0
  if (direction === 'last') return length - 1
  if (direction === 'next') return (current + 1 + length) % length
  return (current <= 0 ? length : current) - 1
}
