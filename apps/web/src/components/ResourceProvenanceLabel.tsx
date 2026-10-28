import { usePortalLocale } from '../lib/portal-locale.tsx'

/** Owner-supplied context, kept separate from the original title and source text. */
export function ResourceProvenanceLabel({ resourceId }: { resourceId: string }) {
  const label = usePortalLocale().resourceLabel?.(resourceId)
  return label ? <span className='rp-tag'>{label}</span> : null
}
