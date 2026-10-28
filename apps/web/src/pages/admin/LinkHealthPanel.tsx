import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import {
  checkPortalLinks,
  deleteAdminResource,
  getLinkHealth,
  type PortalLinkCheck,
  reviewPortalLink,
} from '../../api/client.ts'
import { errorMessage } from './shared.ts'

const labels = {
  broken: 'Broken link',
  restricted: 'Access restricted',
  temporary: 'Temporary failure',
  timeout: 'Timed out',
  blocked: 'Unsafe address blocked',
  ok: 'Available',
} as const

function LinkHealthContent({ slug }: { slug: string }) {
  const { ui, date, number, error: localError } = usePortalLocale()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const queryClient = useQueryClient()
  const key = ['admin-link-health', slug, authority.generation]
  const query = useQuery({
    queryKey: key,
    queryFn: () => getLinkHealth(slug, access.sessionAccess),
    enabled: access.sessionAllowed,
    retry: false,
  })
  const [snapshot, setSnapshot] = useState<PortalLinkCheck[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [retiring, setRetiring] = useState<PortalLinkCheck | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const heading = useRef<HTMLSpanElement>(null)
  const rows = access.sessionAllowed ? query.data : snapshot
  const refresh = async () => {
    const result = await access.runExplicit(
      ui('Read link health'),
      (auth) => getLinkHealth(slug, auth),
    )
    assertCurrent()
    if (result === undefined) return
    if (access.sessionAllowed) queryClient.setQueryData(key, result)
    else setSnapshot(result)
  }
  const perform = async (
    action: 'check' | 'recheck' | 'ignore' | 'retire' | 'read',
    row?: PortalLinkCheck,
  ) => {
    setBusy(true)
    setError(null)
    try {
      if (action === 'read') await refresh()
      else {
        const result = await access.runExplicit(ui('Manage link health'), async (auth) => {
          if (action === 'check') {
            const result = await checkPortalLinks(slug, auth)
            assertCurrent()
            setStatus(
              ui(
                'Checked {checked} links; {failed} need review; {deferred} left for the next run.',
                result,
              ),
            )
          } else if (action === 'retire') {
            await deleteAdminResource(slug, auth, row!.resourceId!)
            assertCurrent()
            setStatus(ui('Resource retired.'))
          } else {
            await reviewPortalLink(slug, auth, row!.id, action)
            assertCurrent()
            setStatus(
              ui(
                action === 'ignore'
                  ? 'Link ignored. This decision is remembered.'
                  : 'Link re-checked.',
              ),
            )
          }
          return true
        })
        assertCurrent()
        if (result === undefined) return
        setRetiring(null)
        await refresh()
        if (action === 'retire') {
          await queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] })
        }
      }
      heading.current?.focus()
    } catch (err) {
      if (context === authority.controller.context) {
        setError(errorMessage(err, 'Could not complete the link review. Please retry.', localError))
      }
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }
  const visible = (rows ?? []).filter((row) =>
    showIgnored ? row.ignored : !row.ignored && row.status !== 'ok'
  )
  return (
    <section className='rp-card min-w-0 p-5 lg:p-6' data-link-health aria-busy={busy}>
      <SectionHeader
        className='rp-manage-section-head'
        title={<span className='rp-focus' ref={heading} tabIndex={-1}>{ui('Link health')}</span>}
        description={ui(
          'Website sources and document origin links are checked daily. Restricted access and temporary failures need review before a resource is retired.',
        )}
        actions={
          <Button
            variant='outline'
            disabled={busy || access.pending}
            onClick={() => void perform('check')}
          >
            {ui(busy ? 'Checking links...' : 'Check links now')}
          </Button>
        }
      />
      <p className='mt-3 text-sm text-ink-2' role='status' aria-live='polite'>
        {status || (query.isLoading ? ui('Loading link reviews...') : '')}
      </p>
      {(error || query.isError) && (
        <p role='alert' className='mt-3 text-sm text-[var(--rp-bad-ink)]'>
          {error ?? ui('Could not load link reviews.')}
        </p>
      )}
      <div className='mt-3 flex flex-wrap gap-3'>
        <Button
          variant='ghost'
          disabled={busy}
          aria-pressed={showIgnored}
          onClick={() => setShowIgnored(!showIgnored)}
        >
          {ui(showIgnored ? 'Show review queue' : 'Show ignored links')}
        </Button>
        <Button variant='ghost' disabled={busy} onClick={() => void perform('read')}>
          {ui('Reload reviews')}
        </Button>
      </div>
      {rows && !visible.length && (
        <p className='mt-4 text-sm text-ink-2'>
          {ui(
            showIgnored
              ? 'No ignored links.'
              : 'No links need review. Run a check to review current links.',
          )}
        </p>
      )}
      <ul className='mt-4 divide-y divide-line'>
        {visible.map((row) => (
          <li
            key={row.id}
            className='min-w-0 py-4'
            data-link-review={row.resourceId ?? row.sourceId}
          >
            <p className='break-words font-medium text-ink [overflow-wrap:anywhere]'>{row.title}</p>
            <p className='mt-1 break-words text-sm text-ink-2 [overflow-wrap:anywhere]'>
              {row.url}
            </p>
            <p className='mt-2 text-sm text-ink-2'>
              {ui(labels[row.status])}
              {row.httpStatus ? ` (HTTP ${row.httpStatus})` : ''}
              {row.ignored ? ` - ${ui('Ignored')}` : ''}
            </p>
            <dl className='mt-2 grid grid-cols-1 gap-2 text-sm text-ink-2 sm:grid-cols-3'>
              <div>
                <dt>{ui('First failed')}</dt>
                <dd className='break-words'>
                  {row.firstFailed
                    ? date(row.firstFailed, {
                      year: 'numeric',
                      month: 'numeric',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                    : ui('None')}
                </dd>
              </div>
              <div>
                <dt>{ui('Last checked')}</dt>
                <dd className='break-words'>
                  {date(row.lastChecked, {
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </dd>
              </div>
              <div>
                <dt>{ui('Attempts')}</dt>
                <dd>{number(row.attempts)}</dd>
              </div>
            </dl>
            <div className='mt-3 flex flex-wrap gap-3'>
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => void perform('recheck', row)}
              >
                {ui('Re-check')}
              </Button>
              {!row.ignored && (
                <Button
                  variant='ghost'
                  disabled={busy}
                  onClick={() => void perform('ignore', row)}
                >
                  {ui('Ignore')}
                </Button>
              )}
              {row.resourceId && (
                <Button
                  variant='danger-outline'
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    setRetiring(row)
                  }}
                >
                  {ui('Retire resource')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {retiring && (
        <ConfirmActionDialog
          title={ui('Retire resource?')}
          description={
            <>
              <p>{retiring.title}</p>
              <p className='mt-3'>
                {ui(
                  'This permanently deletes the resource from the library. A broken origin link does not necessarily mean its research is no longer useful.',
                )}
              </p>
            </>
          }
          confirmLabel={ui('Retire resource')}
          cancelLabel={ui('Keep resource')}
          busy={busy}
          busyLabel={ui('Retiring resource...')}
          error={error}
          onCancel={() => setRetiring(null)}
          onConfirm={() => void perform('retire', retiring)}
        />
      )}
    </section>
  )
}

export function LinkHealthPanel(props: { slug: string }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <LinkHealthContent key={`${props.slug}:${authority.generation}`} {...props} />
}
