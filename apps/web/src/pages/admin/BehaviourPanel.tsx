import { messageFor } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ensureSearchConfigs,
  getPrompts,
  getRouting,
  getSearchConfigs,
  getTenantConfig,
  savePrompts,
} from '../../api/client.ts'
import { intentSummary } from '../../components/RouteChip.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { Bookmark, ChevronDown, Plus, RotateCw } from '../../components/icons.tsx'

type Prompts = Awaited<ReturnType<typeof getPrompts>>
type Routing = Awaited<ReturnType<typeof getRouting>>

function validPrompts(value: Prompts): Prompts {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    (value.ask !== undefined && typeof value.ask !== 'string') ||
    (value.images !== undefined && typeof value.images !== 'boolean') ||
    (value.uncitedAnswers !== undefined && !['show', 'refuse'].includes(value.uncitedAnswers))
  ) throw new AdminAccessError()
  return value
}

function validConfigs(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminAccessError()
  return value
}

function validRouting(value: Routing): Routing {
  if (
    !value || !Array.isArray(value.recent) || !Number.isFinite(value.summary?.total) ||
    !value.summary?.byIntent || !value.summary?.byStage
  ) throw new AdminAccessError()
  for (const counts of [value.summary.byIntent, value.summary.byStage]) {
    validConfigs(counts)
    if (Object.values(counts).some((count) => !Number.isFinite(count))) throw new AdminAccessError()
  }
  return value
}

/**
 * Ask system prompt editor. Loads the current prompt (if any), lets the
 * librarian override it, and saves straight back through the admin API.
 */
function AskPromptEditor({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess(
    'behaviour.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [value, setValue] = useState('')
  const [images, setImages] = useState(false)
  // D8-01: an answer no citation could be tied to is shown with its sources consulted unless
  // the portal refuses such answers.
  const [showUnlinked, setShowUnlinked] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const { data, isError } = useQuery({
    queryKey: ['admin-prompts', slug],
    queryFn: async () => validPrompts(await getPrompts(slug, sessionAccess)),
    enabled: sessionAllowed,
    retry: false,
  })

  useEffect(() => {
    if (data && !loaded) {
      setValue(data.ask ?? '')
      setImages(data.images ?? false)
      setShowUnlinked(data.uncitedAnswers !== 'refuse')
      setLoaded(true)
    }
  }, [data, loaded])

  const onLoad = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Load the current ask prompt'),
        async (access) => validPrompts(await getPrompts(slug, access)),
      )
      assertCurrent()
      if (result === undefined) return
      setValue(result.ask ?? '')
      setImages(result.images ?? false)
      setShowUnlinked(result.uncitedAnswers !== 'refuse')
      setLoaded(true)
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not load the prompt.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  const onSave = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(ui('Save the ask prompt'), async (access) => {
        const saved = await savePrompts(slug, access, {
          ask: value.trim() || undefined,
          images,
          uncitedAnswers: showUnlinked ? 'show' : 'refuse',
        })
        if (saved?.ok !== true) throw new AdminAccessError()
        return true
      })
      assertCurrent()
      if (result === undefined) return
      setMessage(
        messageFor('ok', ({ ui }) => ui('Saved - the new prompt applies to the next answer.')),
      )
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save the prompt.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <section className='rp-card min-w-0 p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        title={ui('Ask system prompt')}
        description={ui(
          'Used for every grounded answer on this portal. Leave empty for the default analyst prompt.',
        )}
        actions={
          <Button
            data-behaviour-read='prompts'
            disabled={busy}
            onClick={() => void onLoad()}
            variant='ghost'
            size='sm'
            leadingIcon={RotateCw}
          >
            {loaded ? ui('Reload current prompt') : ui('Load current prompt')}
          </Button>
        }
      />
      {!loaded && (
        <p className='mt-3 text-sm text-ink-3'>
          {isError
            ? ui('Could not load the current prompt.')
            : ui('Load the current prompt before editing.')}
        </p>
      )}
      <textarea
        data-behaviour-prompt
        aria-label={ui('Ask system prompt')}
        disabled={busy || !loaded}
        className='rp-input mt-4 w-full'
        rows={8}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={ui('Leave empty to use the default analyst prompt.')}
      />
      <label className='rp-check mt-3 text-sm text-ink-2'>
        <input
          type='checkbox'
          disabled={busy || !loaded}
          checked={images}
          onChange={(e) => setImages(e.target.checked)}
        />
        {ui('Ground answers on page and table images')}
      </label>
      <p className='mt-1 text-xs text-ink-3'>
        {ui(
          'Uses visual content (page images, tables) as extra context when answering - useful for PDF-heavy corpora.',
        )}
      </p>
      <label className='rp-check mt-3 text-sm text-ink-2'>
        <input
          type='checkbox'
          data-behaviour-unlinked
          disabled={busy || !loaded}
          checked={showUnlinked}
          onChange={(e) => setShowUnlinked(e.target.checked)}
        />
        {ui('Show answers that cannot be linked to specific passages')}
      </label>
      <p className='mt-1 text-xs text-ink-3'>
        {ui(
          'Such an answer carries a note and lists the sources consulted. Turn this off to decline instead. An answer is always declined when nothing relevant was found.',
        )}
      </p>
      <div className='mt-3 flex items-center gap-3'>
        <Button
          data-behaviour-save
          disabled={busy || !loaded}
          onClick={() => void onSave()}
          leadingIcon={Bookmark}
        >
          {busy ? ui('Saving…') : ui('Save prompt')}
        </Button>
      </div>
      {message && <MessagePanel message={message} className='mt-3' />}
    </section>
  )
}

/** Search configurations block: create the platform defaults and inspect what's there. */
function SearchConfigsBlock({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess(
    'behaviour.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string[] | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null)

  const { data: sessionData, refetch, isLoading, isError } = useQuery({
    queryKey: ['admin-search-configs', slug],
    queryFn: async () => validConfigs(await getSearchConfigs(slug, sessionAccess)),
    enabled: sessionAllowed,
    retry: false,
  })
  const data = sessionAllowed ? sessionData : snapshot

  const onLoad = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Load search configurations'),
        async (access) => validConfigs(await getSearchConfigs(slug, access)),
      )
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['admin-search-configs', slug], result)
      else setSnapshot(result)
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            errorMessage(err, 'Could not load search configurations.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  const onEnsure = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Create default search configurations'),
        async (access) => {
          const saved = await ensureSearchConfigs(slug, access)
          if (
            saved?.ok !== true || !Array.isArray(saved.created) ||
            saved.created.some((name) => typeof name !== 'string')
          ) throw new AdminAccessError()
          return saved
        },
      )
      assertCurrent()
      if (result === undefined) return
      setCreated(result.created)
      setMessage(messageFor('ok', ({ ui }) =>
        result.created.length > 0
          ? ui(
            result.created.length === 1
              ? 'Created {count} configuration.'
              : 'Created {count} configurations.',
            { count: result.created.length },
          )
          : ui('All default configurations already exist.')))
      if (sessionAllowed) await refetch()
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            errorMessage(err, 'Could not create the default configurations.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <section className='rp-card min-w-0 p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        title={ui('Search configurations')}
        description={ui(
          "The named retrieval configurations this portal's search and ask calls draw on.",
        )}
        actions={
          <>
            <Button
              data-behaviour-read='configs'
              disabled={busy}
              onClick={() => void onLoad()}
              variant='ghost'
              size='sm'
              leadingIcon={RotateCw}
            >
              {ui('Refresh search configurations')}
            </Button>
            <Button
              data-behaviour-ensure
              disabled={busy}
              onClick={() => void onEnsure()}
              variant='outline'
              size='sm'
              leadingIcon={Plus}
            >
              {busy ? ui('Creating…') : ui('Create default configurations')}
            </Button>
          </>
        }
      />
      {!data && !isLoading && (
        <p className='mt-3 text-sm text-ink-3'>
          {ui('Load search configurations to inspect the current settings.')}
        </p>
      )}

      {created && created.length > 0 && (
        <ul className='mt-3 flex flex-wrap gap-1.5'>
          {created.map((name) => <li key={name} className='rp-tag'>{name}</li>)}
        </ul>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}
      <IntentsTable
        slug={slug}
        live={data ?? null}
        loading={isLoading}
        error={isError}
      />

      <details className='group mt-4'>
        <summary className='rp-btn rp-btn-ghost rp-btn-sm list-none [&::-webkit-details-marker]:hidden'>
          <ChevronDown
            size='sm'
            className='transition-transform duration-150 ease-[var(--rp-ease)] group-open:rotate-180 motion-reduce:transition-none'
          />
          {ui('View raw configuration JSON')}
        </summary>
        <div className='mt-2 max-h-80 overflow-auto rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'>
          {isLoading && <p className='text-xs text-ink-3'>{ui('Loading…')}</p>}
          {isError && (
            <p className='text-xs text-ink-3'>{ui('Could not load search configurations.')}</p>
          )}
          {data && (
            <pre className='whitespace-pre-wrap break-all text-xs text-ink-2'>
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </section>
  )
}

/**
 * Behaviour: the portal's grounded-answer system prompt and its search
 * configurations. Both are platform-facing settings, not content.
 */
function BehaviourPanelContent({ slug }: { slug: string }) {
  return (
    <div className='space-y-6 lg:space-y-8'>
      <AskPromptEditor slug={slug} />
      <SearchConfigsBlock slug={slug} />
    </div>
  )
}

/**
 * Intent-routed configurations: each intent, the stored configuration it
 * selects, the policy in one line, and whether the box currently holds it.
 * Converge is the "create default configurations" action above - it writes
 * every intent configuration too.
 */
function IntentsTable(
  { slug, live, loading, error }: {
    slug: string
    live: Record<string, unknown> | null
    loading: boolean
    error: boolean
  },
) {
  const { ui } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess(
    'behaviour.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const queryClient = useQueryClient()
  const [snapshot, setSnapshot] = useState<Routing | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const { data: config } = useQuery({
    queryKey: ['tenant-config', slug],
    queryFn: () => getTenantConfig(slug),
  })
  const { data: sessionRouting } = useQuery({
    queryKey: ['admin-routing', slug],
    queryFn: async () => validRouting(await getRouting(slug, sessionAccess)),
    enabled: sessionAllowed,
    retry: false,
    refetchInterval: sessionAllowed ? 30_000 : false,
  })
  const routing = sessionAllowed ? sessionRouting : snapshot
  const onLoad = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Load routing activity'),
        async (access) => validRouting(await getRouting(slug, access)),
      )
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['admin-routing', slug], result)
      else setSnapshot(result)
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            errorMessage(err, 'Could not load routing activity.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }
  const intents = config?.intents ?? []
  if (intents.length === 0) return null
  const defaultIntent = config?.defaultIntent
  const names = (id: string, surfaces: string[]) => {
    if (id === defaultIntent) return ['portal-ask', 'portal-search']
    const out: string[] = []
    if (surfaces.includes('ask')) out.push(`portal-intent-${id}`)
    if (surfaces.includes('search')) {
      out.push(surfaces.includes('ask') ? `portal-intent-${id}-find` : `portal-intent-${id}`)
    }
    return out
  }
  const status = (name: string) => {
    if (loading) return 'checking'
    if (error || !live) return 'unknown'
    return name in live ? 'present' : 'missing'
  }
  const summary = routing?.summary
  return (
    <div className='mt-5 border-t border-line pt-4'>
      <SectionHeader
        className='rp-admin-section-head'
        headingLevel={3}
        title={ui('Intent routing')}
        description={summary && summary.total > 0
          ? (
            <>
              {summary.total}
              {ui(' decisions ·')}{' '}
              {Object.entries(summary.byStage).map(([k, v]) => `${v} ${k}`).join(', ')}
            </>
          )
          : routing
          ? ui('No routing decisions logged yet.')
          : ui('Load routing activity to view decisions.')}
        actions={
          <Button
            data-behaviour-read='routing'
            disabled={busy}
            onClick={() => void onLoad()}
            variant='ghost'
            size='sm'
            leadingIcon={RotateCw}
          >
            {ui('Refresh routing activity')}
          </Button>
        }
      />
      {message && <MessagePanel message={message} className='mt-3' />}
      <div
        role='region'
        aria-label={ui('Intent routing')}
        tabIndex={0}
        className='rp-focus mt-4 overflow-x-auto'
      >
        <table className='w-full min-w-[40rem] text-left text-sm'>
          <thead className='text-xs font-semibold text-ink-2'>
            <tr>
              <th scope='col' className='py-2 pr-3'>{ui('Intent')}</th>
              <th scope='col' className='py-2 pr-3'>{ui('Configuration')}</th>
              <th scope='col' className='py-2 pr-3'>{ui('Policy')}</th>
              <th scope='col' className='py-2'>{ui('On the box')}</th>
              <th scope='col' className='py-2 pl-3 text-right'>{ui('Routed')}</th>
            </tr>
          </thead>
          <tbody>
            {intents.map((intent) => (
              <tr key={intent.id} className='border-t border-line align-top'>
                <td className='py-2 pr-3'>
                  <span className='font-medium text-ink'>{intent.label}</span>
                  <span className='block text-ink-3'>{intent.description}</span>
                </td>
                <td className='py-2 pr-3 font-mono text-xs text-ink-2'>
                  {names(intent.id, intent.answer.surfaces).map((n) => (
                    <span key={n} className='block'>{n}</span>
                  ))}
                </td>
                <td className='py-2 pr-3 text-ink-2'>{intentSummary(intent, ui)}</td>
                <td className='py-2'>
                  {names(intent.id, intent.answer.surfaces).map((n) => {
                    const st = status(n)
                    return (
                      <span
                        key={n}
                        className={`block ${
                          st === 'present'
                            ? 'rp-badge rp-badge-ok'
                            : st === 'missing'
                            ? 'rp-badge rp-badge-warn'
                            : 'rp-badge rp-badge-quiet'
                        }`}
                      >
                        {ui(st)}
                      </span>
                    )
                  })}
                </td>
                <td className='py-2 pl-3 text-right tabular-nums text-ink-2'>
                  {summary?.byIntent[intent.id] ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function BehaviourPanel(props: { slug: string }) {
  const authority = useAccess()
  const permission = usePermissionAdminAccess('behaviour.write', {
    kind: 'portal',
    slug: props.slug,
  })
  if (
    authority.state.status !== 'ready' ||
    (!permission.sessionAllowed && !permission.breakGlassEnabled)
  ) return null
  return <BehaviourPanelContent key={`${props.slug}:${authority.generation}`} {...props} />
}
