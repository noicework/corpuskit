import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { AssignmentSection } from '../components/AssignmentSection.tsx'
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
          <section className='rp-card mt-8 min-w-0 p-6' data-people>
            <p className='max-w-prose text-base text-ink-2'>
              {ui(
                'Owner and Platform administrator roles apply to all present and future portals.',
              )}
            </p>
            <p className='mt-2 max-w-prose text-sm text-ink-2'>
              {ui(
                'These are stored local assignments, not a complete list of people with Entra access.',
              )}
            </p>
            <AssignmentSection scope={scope} name={ui('the platform')} family='members' />
            <AssignmentSection scope={scope} name={ui('the platform')} family='groups' />
          </section>
        )
        : (
          <p className='mt-8 text-base text-ink-2' data-people-unavailable>
            {ui('This administration page is unavailable.')}
          </p>
        )}
    </PlatformAdminShell>
  )
}
