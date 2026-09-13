import { useAccess } from '../components/AccessProvider.tsx'
import { PlatformAdminShell } from './AdminPage.tsx'
import { AuditPanel } from './admin/AuditPanel.tsx'

const scope = Object.freeze({ kind: 'platform' as const })

export function AuditPage() {
  const access = useAccess()
  const allowed = access.can('audit.read', scope) || access.can('audit.export', scope)
  return (
    <PlatformAdminShell
      title='Audit'
      description='Review activity across all portals and the platform.'
    >
      {allowed
        ? (
          <div className='mt-8 min-w-0' data-platform-audit>
            <AuditPanel scope={scope} name='the platform' />
          </div>
        )
        : (
          <p className='mt-8 text-base text-ink-2' data-audit-unavailable>
            This administration page is unavailable.
          </p>
        )}
    </PlatformAdminShell>
  )
}
