import { usePortalLocale } from '../lib/portal-locale.tsx'
import { Link } from 'react-router-dom'
import { useAccess } from './AccessProvider.tsx'
import { Plus } from './icons.tsx'

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
  const { ui } = usePortalLocale()

  const access = useAccess()
  if (!access.can('content.write', { kind: 'portal', slug })) return null
  return (
    <Link
      to={addDocumentsPath(slug)}
      className={`rp-btn rp-btn-${variant} ${className}`.trim()}
      data-add-documents
    >
      <Plus size='sm' />
      {ui('Add documents')}
    </Link>
  )
}
