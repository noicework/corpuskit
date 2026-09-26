import { Link } from 'react-router-dom'
import { useAccess } from './AccessProvider.tsx'

/** Where "Add documents" leads: the Manage content tab, scrolled to its open add panel. */
export function addDocumentsPath(slug: string): string {
  return `/t/${encodeURIComponent(slug)}/manage?tab=content#add-documents`
}

/**
 * The primary "Add documents" action, shown only to people who may add content to this portal.
 * Pages place it where adding documents is the natural next step: the library, the Manage
 * overview and any view of an empty collection.
 */
export function AddDocumentsLink({ slug, variant = 'primary', className = '' }: {
  slug: string
  variant?: 'primary' | 'outline'
  className?: string
}) {
  const access = useAccess()
  if (!access.can('content.write', { kind: 'portal', slug })) return null
  return (
    <Link
      to={addDocumentsPath(slug)}
      className={`rp-btn rp-btn-${variant} ${className}`.trim()}
      data-add-documents
    >
      <svg
        aria-hidden='true'
        viewBox='0 0 24 24'
        className='h-4 w-4'
        fill='none'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
      >
        <path d='M12 5v14M5 12h14' />
      </svg>
      Add documents
    </Link>
  )
}
