import { AppLanguageSwitch, usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getTenants } from '../api/client.ts'
import { microsoftLoginUrl } from '../api/auth.ts'
import { useAccess } from '../components/AccessProvider.tsx'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { portalHref } from '../lib/portal-url.ts'
import { ArrowRight, LogOut } from '../components/icons.tsx'
import { platformBranding } from '../components/PortalAccessGate.tsx'
import { tenantThemeVars, useBodyTheme, useViewerScheme } from '../lib/theme.ts'

function CorpusMark() {
  return (
    <span className='flex w-7 shrink-0 -skew-x-12 flex-col gap-1' aria-hidden='true'>
      <span className='h-1.5 w-5 rounded-[var(--rp-radius-btn)] bg-[var(--rp-brand-fg)]' />
      <span className='ml-1 h-1.5 w-5 rounded-[var(--rp-radius-btn)] bg-[var(--rp-accent)]' />
      <span className='ml-2 h-1.5 w-5 rounded-[var(--rp-radius-btn)] bg-[var(--rp-brand-fg)]' />
    </span>
  )
}

function MicrosoftMark() {
  return (
    <svg
      viewBox='0 0 24 24'
      className='h-5 w-5 shrink-0 rounded-[var(--rp-radius-btn)] bg-[var(--rp-logo-plate)] p-0.5'
      aria-hidden='true'
    >
      <path fill='#f25022' d='M2 2h9v9H2z' />
      <path fill='#7fba00' d='M13 2h9v9h-9z' />
      <path fill='#00a4ef' d='M2 13h9v9H2z' />
      <path fill='#ffb900' d='M13 13h9v9h-9z' />
    </svg>
  )
}

export function TenantPicker() {
  const locale = usePortalLocale()
  const { ui } = locale
  const { scheme } = useViewerScheme()
  useBodyTheme(platformBranding, scheme)
  const access = useAccess()
  const tenants = useQuery({
    queryKey: ['tenants', access.identityKey, access.generation],
    queryFn: getTenants,
    enabled: access.state.status === 'ready',
  })
  const user = access.state.session?.user

  useEffect(() => {
    document.title = ui('CorpusKit | Knowledge people can use')
  }, [ui])

  return (
    <main
      className='rp-tenant min-h-screen bg-app text-ink'
      style={tenantThemeVars(platformBranding, scheme)}
      data-platform-scheme={scheme}
    >
      <header className='rp-shell flex min-h-20 flex-wrap items-center justify-between gap-3 border-b border-line py-4'>
        <a
          href='/'
          className='rp-link-standalone rp-focus rp-display gap-3 text-xl text-ink'
          aria-label={ui('CorpusKit home')}
        >
          <CorpusMark />
          <span>CorpusKit</span>
        </a>
        <nav aria-label={ui('Primary')} className='flex flex-wrap items-center gap-2 sm:gap-4'>
          <AppLanguageSwitch />
          <a
            href='#how-it-works'
            className='rp-link-standalone rp-focus text-sm font-semibold text-ink-2'
          >
            {ui('How it works')}
            <ArrowRight size='sm' />
          </a>
          {user
            ? (
              <a href='#portals' className='rp-btn rp-btn-outline'>
                <span className='max-w-36 truncate'>{user.name || user.email}</span>
                <ArrowRight size='sm' />
              </a>
            )
            : (
              <a href={microsoftLoginUrl('/')} className='rp-btn rp-btn-outline'>
                <MicrosoftMark />
                <span>{ui('Sign in')}</span>
              </a>
            )}
        </nav>
      </header>

      <section className='rp-shell grid items-center gap-8 py-8 lg:grid-cols-2 lg:py-10'>
        <div className='min-w-0'>
          <p className='rp-eyebrow text-ink-3'>{ui('A home for serious knowledge')}</p>
          <h1 className='rp-display mt-3 text-2xl sm:text-3xl'>
            {ui('Turn a corpus into a place people can use.')}
          </h1>
          <p className='rp-measure mt-4 text-base leading-relaxed text-ink-2'>
            {ui(
              'CorpusKit gives research organisations a clear, credible portal for their documents, evidence and expertise - with answers that always lead back to the source.',
            )}
          </p>
          <div className='mt-8 flex flex-wrap items-center gap-3'>
            <a
              href={user ? '#portals' : microsoftLoginUrl('/')}
              className='rp-btn rp-btn-primary rp-btn-lg'
            >
              {user ? ui('Open your portals') : ui('Continue with Microsoft 365')}
              {!user && <MicrosoftMark />}
              {user && <ArrowRight size='sm' />}
            </a>
            <a href='#how-it-works' className='rp-btn rp-btn-outline rp-btn-lg'>
              {ui('See how it works')}
              <ArrowRight size='sm' />
            </a>
          </div>
        </div>

        <div
          className='rp-card min-w-0 space-y-4 p-5 lg:p-6'
          aria-label={ui('Documents become structured, cited answers')}
        >
          <div className='rp-eyebrow text-ink-3'>{ui('Inside a CorpusKit portal')}</div>
          <div className='space-y-3 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border border-line bg-surface-2 p-4'>
            <span className='rp-eyebrow text-ink-3'>{ui('RESEARCH PAPER · 042')}</span>
            <strong className='block text-base font-semibold'>
              {ui('Climate resilience in coastal fisheries')}
            </strong>
            <i className='block h-1 rounded-full bg-[var(--rp-line)]' aria-hidden='true' />
            <i className='block h-1 rounded-full bg-[var(--rp-line)]' aria-hidden='true' />
            <i className='block h-1 rounded-full bg-[var(--rp-line)]' aria-hidden='true' />
          </div>
          <div className='space-y-3 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border border-line bg-surface-2 p-4'>
            <span className='rp-eyebrow text-ink-3'>{ui('TECHNICAL REPORT · 118')}</span>
            <strong className='block text-base font-semibold'>
              {ui('Regional adoption and outcomes')}
            </strong>
            <i className='block h-1 rounded-full bg-[var(--rp-line)]' aria-hidden='true' />
            <i className='block h-1 rounded-full bg-[var(--rp-line)]' aria-hidden='true' />
          </div>
          <div className='space-y-3 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border border-line bg-[var(--rp-wash)] p-4'>
            <span className='rp-eyebrow text-ink-2'>{ui('Grounded answer')}</span>
            <p className='text-base leading-relaxed'>
              {ui('Three findings recur across the evidence, with regional variation.')}
            </p>
            <div className='text-xs text-ink-2'>
              <b className='text-[var(--rp-accent-fg)]'>[1]</b>{' '}
              <b className='text-[var(--rp-accent-fg)]'>[2]</b>{' '}
              <b className='text-[var(--rp-accent-fg)]'>[3]</b> {ui('View cited passages')}
            </div>
          </div>
        </div>
      </section>

      <section
        className='rp-shell grid gap-4 border-y border-line py-6 sm:grid-cols-3'
        aria-label={ui('Product principles')}
      >
        <div className='flex items-center gap-3'>
          <strong className='text-2xs font-semibold text-ink-3'>01</strong>
          <span className='text-sm font-medium'>{ui('Every answer is cited')}</span>
        </div>
        <div className='flex items-center gap-3'>
          <strong className='text-2xs font-semibold text-ink-3'>02</strong>
          <span className='text-sm font-medium'>{ui('Your structure, not a generic chatbot')}</span>
        </div>
        <div className='flex items-center gap-3'>
          <strong className='text-2xs font-semibold text-ink-3'>03</strong>
          <span className='text-sm font-medium'>{ui('One trusted portal for every audience')}</span>
        </div>
      </section>

      <section id='how-it-works' className='rp-shell scroll-mt-6 py-8 lg:py-10'>
        <div className='rp-measure'>
          <p className='rp-eyebrow text-ink-3'>{ui('From archive to active knowledge')}</p>
          <h2 className='rp-display mt-2 text-xl'>{ui('Keep the rigour. Remove the friction.')}</h2>
        </div>
        <div className='mt-6 grid gap-6 lg:grid-cols-3'>
          <article className='rp-card space-y-4 p-5 lg:p-6'>
            <span className='rp-eyebrow text-ink-3'>{ui('Collect')}</span>
            <h3 className='text-base font-semibold'>
              {ui('Bring the whole evidence base together.')}
            </h3>
            <p className='rp-prose text-sm text-ink-2'>
              {ui('Documents, reports and source systems become one governed corpus.')}
            </p>
          </article>
          <article className='rp-card space-y-4 p-5 lg:p-6'>
            <span className='rp-eyebrow text-ink-3'>{ui('Structure')}</span>
            <h3 className='text-base font-semibold'>
              {ui('Make the organisation’s knowledge visible.')}
            </h3>
            <p className='rp-prose text-sm text-ink-2'>
              {ui('Topics, entities and relationships create paths through complex material.')}
            </p>
          </article>
          <article className='rp-card space-y-4 p-5 lg:p-6'>
            <span className='rp-eyebrow text-ink-3'>{ui('Use')}</span>
            <h3 className='text-base font-semibold'>
              {ui('Help people find, understand and act.')}
            </h3>
            <p className='rp-prose text-sm text-ink-2'>
              {ui('Search and cited answers turn a collection into a dependable service.')}
            </p>
          </article>
        </div>
      </section>

      <section id='portals' className='rp-shell scroll-mt-6 py-8 lg:py-10'>
        <div className='rp-measure'>
          <p className='rp-eyebrow text-ink-3'>
            {user ? ui('Signed in') : ui('Live on CorpusKit')}
          </p>
          <h2 className='rp-display mt-2 text-xl'>
            {user ? ui('Your portals') : ui('Explore public portals')}
          </h2>
          <p className='mt-3 text-base leading-relaxed text-ink-2'>
            {user
              ? ui('Welcome back, {name}. Choose where you want to work.', {
                name: user.name || user.email,
              })
              : ui('See how organisations are making research easier to navigate and use.')}
          </p>
        </div>

        <div className='mt-6 grid gap-6 md:grid-cols-2 2xl:grid-cols-3'>
          {access.state.status === 'loading' || tenants.isLoading
            ? (
              <>
                <Skeleton className='h-56' />
                <Skeleton className='h-56' />
              </>
            )
            : null}
          {tenants.isError
            ? (
              <ErrorCard
                message={locale.error(tenants.error, 'Could not load portals.')}
                onRetry={() => void tenants.refetch()}
              />
            )
            : null}
          {access.state.status === 'ready' && tenants.data?.map((tenant, index) => (
            <a
              key={tenant.slug}
              href={portalHref(tenant.slug, { hostname: tenant.hostname })}
              className='rp-card rp-focus flex min-w-0 flex-col gap-4 p-5 no-underline lg:p-6'
            >
              <span className='rp-eyebrow text-ink-3'>0{index + 1}</span>
              <div className='min-w-0 space-y-2'>
                <p className='text-xs text-ink-3'>{tenant.organisation}</p>
                <h3 className='text-base font-semibold'>{tenant.productName}</h3>
                <span className='block text-sm leading-relaxed text-ink-2'>{tenant.tagline}</span>
              </div>
              <span className='mt-auto flex items-center gap-2 text-sm font-semibold text-[var(--rp-accent-fg)]'>
                {ui('Open portal')} <ArrowRight size='sm' />
              </span>
            </a>
          ))}
        </div>

        {!user && (
          <div className='rp-card mt-6 flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between lg:p-6'>
            <div className='space-y-2'>
              <strong className='block text-base font-semibold'>
                {ui('Already part of a CorpusKit organisation?')}
              </strong>
              <span className='block text-sm text-ink-2'>
                {ui('Use your Microsoft 365 account to see your portals.')}
              </span>
            </div>
            <a href={microsoftLoginUrl('/')} className='rp-btn rp-btn-primary rp-btn-lg'>
              <MicrosoftMark /> {ui('Sign in with Microsoft')}
            </a>
          </div>
        )}
      </section>

      <footer className='rp-shell flex flex-wrap items-center justify-between gap-4 border-t border-line py-6'>
        <a href='/' className='rp-link-standalone rp-focus rp-display gap-3 text-xl text-ink'>
          <CorpusMark />
          <span>CorpusKit</span>
        </a>
        <p className='text-xs text-ink-3'>{ui('Knowledge people can use.')}</p>
        {user
          ? (
            <a
              href='/auth/logout'
              className='rp-link-standalone rp-focus text-sm font-semibold text-ink-2'
            >
              <LogOut size='sm' />
              {ui('Sign out')}
            </a>
          )
          : (
            <a
              href={microsoftLoginUrl('/')}
              className='rp-link-standalone rp-focus text-sm font-semibold text-ink-2'
            >
              {ui('Microsoft sign in')}
            </a>
          )}
      </footer>
    </main>
  )
}
