import { type ReactNode, useId, useState } from 'react'
import { Button } from '../../components/ui.tsx'
import { ChevronDown } from '../../components/icons.tsx'

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
  const contentId = useId()
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = openProp ?? internalOpen

  const toggle = () => {
    const next = !open
    if (openProp === undefined) setInternalOpen(next)
    onToggle?.(next)
  }

  return (
    <div className='border-t border-line py-3 first:border-t-0 first:pt-0'>
      <Button
        variant='ghost'
        size='sm'
        onClick={toggle}
        aria-expanded={open}
        aria-controls={contentId}
        className='rp-manage-disclosure w-full text-left'
      >
        <ChevronDown size='sm' className={open ? '' : '-rotate-90'} />
        <span className='text-sm font-semibold text-ink'>{title}</span>
      </Button>
      <div id={contentId} hidden={!open} className='mt-3'>{open && children}</div>
    </div>
  )
}
