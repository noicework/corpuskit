import { type ReactNode, useState } from 'react'

/**
 * Small collapsible sub-section used inside an expanded portal row. Closed
 * by default (pass `defaultOpen` to start expanded, used for Connection).
 * Uncontrolled unless `open` + `onToggle` are both supplied, in which case
 * a parent can read (and drive) whether this section is showing - used by
 * Intelligence so the knowledge-graph agents query only runs while visible.
 */
export function Section({
  title,
  defaultOpen = false,
  open: openProp,
  onToggle,
  children,
}: {
  title: string
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = openProp ?? internalOpen

  const toggle = () => {
    const next = !open
    if (openProp === undefined) setInternalOpen(next)
    onToggle?.(next)
  }

  return (
    <div className='border-t border-line py-3 first:border-t-0 first:pt-0'>
      <button
        type='button'
        onClick={toggle}
        aria-expanded={open}
        className='flex w-full items-center gap-2 text-left'
      >
        <span aria-hidden='true' className='text-xs text-ink-3'>
          {open ? '▾' : '▸'}
        </span>
        <span className='text-sm font-semibold text-ink'>{title}</span>
      </button>
      {open && <div className='mt-3'>{children}</div>}
    </div>
  )
}
