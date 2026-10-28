import { Link } from 'react-router-dom'
import { useAccess } from './AccessProvider.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'

export function AnswerRecordLink({ slug, answerId }: { slug: string; answerId?: string | null }) {
  const access = useAccess()
  const { ui } = usePortalLocale()
  if (!answerId || !access.can('content.write', { kind: 'portal', slug })) return null
  return (
    <Link className='rp-btn rp-btn-outline rp-btn-sm' to={`/t/${slug}/answer-records/${answerId}`}>
      {ui('Answer record')}
    </Link>
  )
}
