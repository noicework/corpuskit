import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getTenants } from '../api/client.ts'
import { getAuthSession, microsoftLoginUrl } from '../api/auth.ts'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { portalHref } from '../lib/portal-url.ts'

function CorpusMark() {
  return (
    <span className='mk-mark' aria-hidden='true'>
      <span />
      <span />
      <span />
    </span>
  )
}

function MicrosoftMark() {
  return (
    <svg viewBox='0 0 24 24' className='h-4 w-4' aria-hidden='true'>
      <path fill='#f25022' d='M2 2h9v9H2z' />
      <path fill='#7fba00' d='M13 2h9v9h-9z' />
      <path fill='#00a4ef' d='M2 13h9v9H2z' />
      <path fill='#ffb900' d='M13 13h9v9h-9z' />
    </svg>
  )
}

function Arrow() {
  return (
    <svg viewBox='0 0 20 20' fill='none' className='h-4 w-4' aria-hidden='true'>
      <path d='M4 10h11m-4-4 4 4-4 4' stroke='currentColor' strokeWidth='1.7' />
    </svg>
  )
}

export function TenantPicker() {
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: getTenants })
  const session = useQuery({ queryKey: ['auth-session'], queryFn: getAuthSession })
  const user = session.data?.user

  useEffect(() => {
    document.title = 'CorpusKit | Knowledge people can use'
  }, [])

  return (
    <main className='mk-site'>
      <header className='mk-nav'>
        <a href='/' className='mk-brand rp-focus' aria-label='CorpusKit home'>
          <CorpusMark />
          <span>CorpusKit</span>
        </a>
        <nav aria-label='Primary' className='flex items-center gap-2 sm:gap-4'>
          <a href='#how-it-works' className='mk-nav-link rp-focus'>How it works</a>
          {user
            ? (
              <a href='#portals' className='mk-login rp-focus'>
                <span className='max-w-36 truncate'>{user.name || user.email}</span>
                <Arrow />
              </a>
            )
            : (
              <a href={microsoftLoginUrl('/')} className='mk-login rp-focus'>
                <MicrosoftMark />
                <span>Sign in</span>
              </a>
            )}
        </nav>
      </header>

      <section className='mk-hero'>
        <div className='mk-hero-copy'>
          <p className='mk-kicker'>A home for serious knowledge</p>
          <h1>Turn a corpus into a place people can use.</h1>
          <p className='mk-intro'>
            CorpusKit gives research organisations a clear, credible portal for their documents,
            evidence and expertise - with answers that always lead back to the source.
          </p>
          <div className='mt-8 flex flex-wrap items-center gap-3'>
            <a
              href={user ? '#portals' : microsoftLoginUrl('/')}
              className='mk-cta-primary rp-focus'
            >
              {user ? 'Open your portals' : 'Continue with Microsoft 365'}
              {!user && <MicrosoftMark />}
              {user && <Arrow />}
            </a>
            <a href='#how-it-works' className='mk-cta-secondary rp-focus'>See how it works</a>
          </div>
        </div>

        <div className='mk-corpus' aria-label='Documents become structured, cited answers'>
          <div className='mk-corpus-label'>Inside a CorpusKit portal</div>
          <div className='mk-document mk-document-a'>
            <span>RESEARCH PAPER · 042</span>
            <strong>Climate resilience in coastal fisheries</strong>
            <i />
            <i />
            <i />
          </div>
          <div className='mk-document mk-document-b'>
            <span>TECHNICAL REPORT · 118</span>
            <strong>Regional adoption and outcomes</strong>
            <i />
            <i />
          </div>
          <div className='mk-thread' aria-hidden='true'>
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className='mk-answer'>
            <span className='mk-answer-kicker'>Grounded answer</span>
            <p>Three findings recur across the evidence, with regional variation.</p>
            <div>
              <b>[1]</b>
              <b>[2]</b>
              <b>[3]</b> View cited passages
            </div>
          </div>
        </div>
      </section>

      <section className='mk-proof' aria-label='Product principles'>
        <div>
          <strong>01</strong>
          <span>Every answer is cited</span>
        </div>
        <div>
          <strong>02</strong>
          <span>Your structure, not a generic chatbot</span>
        </div>
        <div>
          <strong>03</strong>
          <span>One trusted portal for every audience</span>
        </div>
      </section>

      <section id='how-it-works' className='mk-section mk-process'>
        <div className='mk-section-heading'>
          <p className='mk-kicker'>From archive to active knowledge</p>
          <h2>Keep the rigour. Remove the friction.</h2>
        </div>
        <div className='mk-process-grid'>
          <article>
            <span>Collect</span>
            <h3>Bring the whole evidence base together.</h3>
            <p>Documents, reports and source systems become one governed corpus.</p>
          </article>
          <article>
            <span>Structure</span>
            <h3>Make the organisation’s knowledge visible.</h3>
            <p>Topics, entities and relationships create paths through complex material.</p>
          </article>
          <article>
            <span>Use</span>
            <h3>Help people find, understand and act.</h3>
            <p>Search and cited answers turn a collection into a dependable service.</p>
          </article>
        </div>
      </section>

      <section id='portals' className='mk-section mk-portals'>
        <div className='mk-section-heading'>
          <p className='mk-kicker'>{user ? 'Signed in' : 'Live on CorpusKit'}</p>
          <h2>{user ? 'Your portals' : 'Explore public portals'}</h2>
          <p>
            {user
              ? `Welcome back, ${user.name || user.email}. Choose where you want to work.`
              : 'See how organisations are making research easier to navigate and use.'}
          </p>
        </div>

        <div className='mk-portal-grid'>
          {tenants.isLoading
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
                message={tenants.error instanceof Error
                  ? tenants.error.message
                  : 'Could not load portals.'}
                onRetry={() => void tenants.refetch()}
              />
            )
            : null}
          {tenants.data?.map((tenant, index) => (
            <a
              key={tenant.slug}
              href={portalHref(tenant.slug, { hostname: tenant.hostname })}
              className='mk-portal-card rp-focus'
            >
              <span className='mk-portal-index'>0{index + 1}</span>
              <div>
                <p>{tenant.organisation}</p>
                <h3>{tenant.productName}</h3>
                <span>{tenant.tagline}</span>
              </div>
              <span className='mk-portal-open'>
                Open portal <Arrow />
              </span>
            </a>
          ))}
        </div>

        {!user && (
          <div className='mk-signin-strip'>
            <div>
              <strong>Already part of a CorpusKit organisation?</strong>
              <span>Use your Microsoft 365 account to see your portals.</span>
            </div>
            <a href={microsoftLoginUrl('/')} className='mk-cta-primary rp-focus'>
              <MicrosoftMark /> Sign in with Microsoft
            </a>
          </div>
        )}
      </section>

      <footer className='mk-footer'>
        <a href='/' className='mk-brand rp-focus'>
          <CorpusMark />
          <span>CorpusKit</span>
        </a>
        <p>Knowledge people can use.</p>
        {user
          ? <a href='/auth/logout' className='mk-nav-link rp-focus'>Sign out</a>
          : <a href={microsoftLoginUrl('/')} className='mk-nav-link rp-focus'>Microsoft sign in</a>}
      </footer>
    </main>
  )
}
