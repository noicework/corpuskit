import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { PlatformAdminShell } from './AdminPage.tsx'
import { AuditPanel } from './admin/AuditPanel.tsx'

const scope = Object.freeze({ kind: 'platform' as const })

export function AuditPage() {
  const { ui } = usePortalLocale()
  const access = useAccess()
  const allowed = access.can('audit.read', scope) || access.can('audit.export', scope)
  return (
    <PlatformAdminShell
      title={ui('Audit')}
      description={ui('Review activity across all portals and the platform.')}
    >
      {allowed
        ? (
          <div className='min-w-0' data-platform-audit>
            <AuditPanel scope={scope} name={ui('the platform')} />
          </div>
        )
        : (
          <p className='text-base text-ink-2' data-audit-unavailable>
            {ui('This administration page is unavailable.')}
          </p>
        )}
    </PlatformAdminShell>
  )
}
