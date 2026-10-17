import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { AssignmentSection } from '../components/AssignmentSection.tsx'
import { SectionHeader } from '../components/ui.tsx'
import { PlatformAdminShell } from './AdminPage.tsx'

export function PeoplePage() {
  const { ui } = usePortalLocale()
  const access = useAccess()
  const scope = { kind: 'platform' as const }
  const allowed = access.can('platform.members.manage', scope)
  return (
    <PlatformAdminShell
      title={ui('People')}
      description={ui('Manage platform access across all portals.')}
    >
      {allowed
        ? (
          <div className='min-w-0 space-y-6 lg:space-y-8' data-people>
            <section className='rp-card min-w-0 p-5 lg:p-6'>
              <SectionHeader
                className='rp-admin-section-head'
                title={ui('People')}
                description={ui(
                  'Owner and Platform administrator roles apply to all present and future portals.',
                )}
              />
              <p className='mt-4 max-w-prose text-sm text-ink-2'>
                {ui(
                  'These are stored local assignments, not a complete list of people with Entra access.',
                )}
              </p>
            </section>
            <AssignmentSection scope={scope} name={ui('the platform')} family='members' />
            <AssignmentSection scope={scope} name={ui('the platform')} family='groups' />
          </div>
        )
        : (
          <p className='mt-8 text-base text-ink-2' data-people-unavailable>
            {ui('This administration page is unavailable.')}
          </p>
        )}
    </PlatformAdminShell>
  )
}
