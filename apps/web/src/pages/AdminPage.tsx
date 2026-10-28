import { OverlapPanel } from './admin/OverlapPanel.tsx'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink } from 'react-router-dom'
import { AppLanguageSwitch, usePortalLocale } from '../lib/portal-locale.tsx'
import { getAdminOverview } from '../api/client.ts'
import { useAccess } from '../components/AccessProvider.tsx'
import { platformBranding } from '../components/PortalAccessGate.tsx'
import { tenantThemeVars, useBodyTheme, useViewerScheme } from '../lib/theme.ts'
import { Button, SectionHeader, Skeleton } from '../components/ui.tsx'
import {
  AlertCircle,
  ArrowLeft,
  Database,
  History,
  RotateCw,
  ShieldCheck,
  Users,
} from '../components/icons.tsx'
import { AddPortal } from './admin/AddPortal.tsx'
import { MigratePanel } from './admin/MigratePanel.tsx'
import { PortalRow } from './admin/PortalRow.tsx'
import { externalLoginUrl, microsoftLoginUrl } from '../api/auth.ts'
import {
  EmergencyAccessProvider,
  usePermissionAdminAccess,
} from '../components/EmergencyAccess.tsx'

export function AdminPageAccess({ children }: { children: ReactNode }) {
  const { state, generation } = useAccess()
  useEffect(() => {
    sessionStorage.removeItem('rp-admin-passcode')
  }, [])
  return (
    <EmergencyAccessProvider key={generation} session={state.session}>
      {children}
    </EmergencyAccessProvider>
  )
}

/** Session reads can refetch. An emergency result is a snapshot, never a session unlock. */
export function useAdminOverview(scope: string) {
  const locale = usePortalLocale()
  const { state, identityKey, generation, controller } = useAccess()
  const auth = state.session
  const { sessionAccess, runExplicit, sessionAllowed, breakGlassEnabled, pending } =
    usePermissionAdminAccess('portal.create', { kind: 'platform' })
  const query = useQuery({
    queryKey: ['admin-overview', identityKey, generation, scope],
    queryFn: () => getAdminOverview(sessionAccess),
    enabled: sessionAllowed,
    retry: false,
  })
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getAdminOverview>>>()
  const [operationError, setOperationError] = useState<string>()
  const refresh = async () => {
    const context = controller.context
    setOperationError(undefined)
    if (sessionAllowed) {
      await query.refetch()
      return
    }
    try {
      const result = await runExplicit(
        locale.ui('Read the knowledge box overview'),
        (access) => getAdminOverview(access),
      )
      controller.assertCurrent(context)
      if (result !== undefined) setSnapshot(result)
    } catch (error) {
      if (context !== controller.context) return
      setOperationError(error instanceof Error ? error.message : 'Could not load the overview.')
    }
  }
  return {
    data: sessionAllowed ? query.data : snapshot,
    isLoading: query.isLoading,
    error: operationError ??
      (query.error ? locale.error(query.error, 'Could not load the overview.') : undefined),
    refresh,
    pending,
    sessionAllowed,
    breakGlassEnabled,
    auth,
  }
}

export function OverviewAccess(
  { overview, returnTo }: { overview: ReturnType<typeof useAdminOverview>; returnTo: string },
) {
  const locale = usePortalLocale()
  const { ui } = locale
  return (
    <section
      className='rp-card space-y-4 p-5 lg:p-6'
      data-admin-unavailable={!overview.data ? true : undefined}
    >
      <SectionHeader
        className='rp-admin-section-head'
        title={ui('Overview')}
        actions={(overview.sessionAllowed || overview.breakGlassEnabled) && (
          <Button
            variant='ghost'
            size='sm'
            leadingIcon={overview.sessionAllowed ? RotateCw : ShieldCheck}
            disabled={overview.pending}
            onClick={() => void overview.refresh()}
          >
            {overview.sessionAllowed ? ui('Refresh overview') : ui('Use emergency access')}
          </Button>
        )}
      />
      {!overview.sessionAllowed && (
        <p className='text-sm text-ink-2'>
          {overview.data
            ? ui('This overview is a snapshot. Each emergency action needs its own confirmation.')
            : ui('You do not have access to this administration page.')}
        </p>
      )}
      {!overview.sessionAllowed && (
        <div className='flex flex-wrap gap-3'>
          {overview.auth?.entraEnabled !== false && (
            <a href={microsoftLoginUrl(returnTo)} className='rp-btn rp-btn-primary'>
              {ui('Sign in with Microsoft')}
            </a>
          )}
          {overview.auth?.externalLogin && (
            <a
              href={externalLoginUrl(overview.auth.externalLogin.startUrl, returnTo)}
              className='rp-btn rp-btn-outline whitespace-normal text-center'
              data-external-login
            >
              {overview.auth.externalLogin.name}
            </a>
          )}
        </div>
      )}
      {overview.error && (
        <p role='alert' className='flex items-start gap-2 text-sm text-[var(--rp-bad-ink)]'>
          <AlertCircle size='sm' className='mt-0.5 shrink-0' />
          {locale.error(overview.error, 'Could not load the overview.')}
        </p>
      )}
    </section>
  )
}

/** Global knowledge box connections. Each emergency operation needs a fresh request. */
export function AdminPage() {
  return (
    <AdminPageAccess>
      <AdminContent />
    </AdminPageAccess>
  )
}

export function PlatformAdminShell(
  { title, description, children }: { title: string; description: string; children: ReactNode },
) {
  const { ui } = usePortalLocale()
  // Callers supply the already-localised application heading, never a tenant/source title.
  useEffect(() => {
    document.title = `${title} | CorpusKit`
  }, [title])
  const { scheme } = useViewerScheme()
  useBodyTheme(platformBranding, scheme)
  const access = useAccess()
  const navigation = useRef<HTMLElement>(null)
  useEffect(() => {
    navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [])
  const links = [
    {
      to: '/admin',
      label: 'Knowledge boxes',
      icon: Database,
      allowed: access.can('portal.create', { kind: 'platform' }),
    },
    {
      to: '/admin/people',
      label: 'People',
      icon: Users,
      allowed: access.can('platform.members.manage', { kind: 'platform' }),
    },
    {
      to: '/admin/audit',
      label: 'Audit',
      icon: History,
      allowed: access.can('audit.read', { kind: 'platform' }) ||
        access.can('audit.export', { kind: 'platform' }),
    },
  ].filter((link) => link.allowed)
  return (
    <main
      className='rp-tenant min-h-screen bg-app text-ink'
      style={tenantThemeVars(platformBranding, scheme)}
      data-platform-scheme={scheme}
    >
      <div className='rp-shell min-w-0 py-8 lg:py-10'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <p className='rp-eyebrow text-ink-3'>{ui('Research portal')}</p>
            <h1 className='rp-display mt-1 break-words text-2xl text-ink sm:text-3xl'>{title}</h1>
            <p className='mt-1 max-w-prose text-sm text-ink-2'>{description}</p>
          </div>
          <div className='flex flex-wrap items-center gap-3'>
            <div className='[&_button]:min-h-11 [&_button]:min-w-11'>
              <AppLanguageSwitch />
            </div>
            <Link to='/' className='rp-link-standalone'>
              <ArrowLeft size='sm' />
              {ui('Back to portals')}
            </Link>
          </div>
        </div>
        <div
          className={`mt-6 min-w-0 gap-6 lg:gap-8 ${
            links.length > 0 ? 'lg:grid lg:grid-cols-[12rem_minmax(0,1fr)]' : ''
          }`}
        >
          {links.length > 0 && (
            <nav
              ref={navigation}
              className='rp-admin-platform-tabs mb-6 flex min-w-0 gap-2 overflow-x-auto pb-2 lg:mb-0 lg:flex-col lg:self-start lg:overflow-visible lg:pb-0'
              aria-label={ui('Platform administration')}
            >
              {links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end
                  className={({ isActive }) =>
                    `rp-btn shrink-0 whitespace-nowrap lg:justify-start ${
                      isActive ? 'rp-btn-primary' : 'rp-btn-ghost'
                    }`}
                >
                  <link.icon size='sm' />
                  {ui(link.label)}
                </NavLink>
              ))}
            </nav>
          )}
          <div className='min-w-0'>{children}</div>
        </div>
      </div>
    </main>
  )
}

function AdminContent() {
  const { ui } = usePortalLocale()
  const authority = useAccess()
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  const overview = useAdminOverview('platform')
  const { data, isLoading } = overview
  return (
    <PlatformAdminShell
      title={ui('Knowledge boxes')}
      description={ui(
        "Connect, replace or revert each portal's knowledge box. For content, appearance and behaviour, open a portal's own management workspace.",
      )}
    >
      {isLoading && (
        <div className='mb-6 space-y-3'>
          <Skeleton className='h-16 w-full' />
          <Skeleton className='h-16 w-full' />
          <Skeleton className='h-16 w-full' />
        </div>
      )}

      <OverviewAccess overview={overview} returnTo='/admin' />

      {data && (
        <div className='mt-6 space-y-6 lg:space-y-8' data-admin-overview>
          {authority.can('portal.create', { kind: 'platform' }) && <OverlapPanel />}
          <AddPortal />

          <div className='space-y-4'>
            {data.map((row) => (
              <PortalRow
                key={row.tenant.slug}
                row={row}
                expanded={expandedSlug === row.tenant.slug}
                onToggleExpanded={() =>
                  setExpandedSlug((prev) => (prev === row.tenant.slug ? null : row.tenant.slug))}
              />
            ))}
          </div>

          {(authority.can('platform.settings.write', { kind: 'platform' }) ||
            !overview.sessionAllowed) && <MigratePanel rows={data} />}
        </div>
      )}
    </PlatformAdminShell>
  )
}
