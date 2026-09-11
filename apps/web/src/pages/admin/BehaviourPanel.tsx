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
import { useAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'

type Prompts = Awaited<ReturnType<typeof getPrompts>>
type Routing = Awaited<ReturnType<typeof getRouting>>

function validPrompts(value: Prompts): Prompts {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    (value.ask !== undefined && typeof value.ask !== 'string') ||
    (value.images !== undefined && typeof value.images !== 'boolean')
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
  const { runExplicit, sessionAccess, coarseAdminEligible } = useAdminAccess()
  const [value, setValue] = useState('')
  const [images, setImages] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const { data, isError } = useQuery({
    queryKey: ['admin-prompts', slug],
    queryFn: async () => validPrompts(await getPrompts(slug, sessionAccess)),
    enabled: coarseAdminEligible,
    retry: false,
  })

  useEffect(() => {
    if (data && !loaded) {
      setValue(data.ask ?? '')
      setImages(data.images ?? false)
      setLoaded(true)
    }
  }, [data, loaded])

  const onLoad = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        'Load the current ask prompt',
        async (access) => validPrompts(await getPrompts(slug, access)),
      )
      if (result === undefined) return
      setValue(result.ask ?? '')
      setImages(result.images ?? false)
      setLoaded(true)
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not load the prompt.') })
    } finally {
      setBusy(false)
    }
  }

  const onSave = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit('Save the ask prompt', async (access) => {
        const saved = await savePrompts(slug, access, { ask: value.trim() || undefined, images })
        if (saved?.ok !== true) throw new AdminAccessError()
        return true
      })
      if (result === undefined) return
      setMessage({ tone: 'ok', text: 'Saved - the new prompt applies to the next answer.' })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save the prompt.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Ask system prompt</h3>
      <p className='mt-1 text-xs text-ink-3'>
        Used for every grounded answer on this portal. Leave empty for the default analyst prompt.
      </p>
      <button
        type='button'
        data-behaviour-read='prompts'
        disabled={busy}
        onClick={() => void onLoad()}
        className='rp-btn rp-btn-outline mt-3'
      >
        {loaded ? 'Reload current prompt' : 'Load current prompt'}
      </button>
      {!loaded && (
        <p className='mt-3 text-sm text-ink-3'>
          {isError
            ? 'Could not load the current prompt.'
            : 'Load the current prompt before editing.'}
        </p>
      )}
      <textarea
        data-behaviour-prompt
        aria-label='Ask system prompt'
        disabled={busy || !loaded}
        className='rp-input mt-3'
        rows={8}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='Leave empty to use the default analyst prompt.'
      />
      <label className='mt-3 flex items-center gap-2 text-sm text-ink-2'>
        <input
          type='checkbox'
          disabled={busy || !loaded}
          checked={images}
          onChange={(e) => setImages(e.target.checked)}
        />
        Ground answers on page and table images
      </label>
      <p className='mt-1 text-xs text-ink-3'>
        Uses visual content (page images, tables) as extra context when answering - useful for
        PDF-heavy corpora.
      </p>
      <div className='mt-3 flex items-center gap-3'>
        <button
          type='button'
          data-behaviour-save
          disabled={busy || !loaded}
          onClick={() => void onSave()}
          className='rp-btn rp-btn-primary'
        >
          {busy ? 'Saving…' : 'Save prompt'}
        </button>
      </div>
      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}

/** Search configurations block: create the platform defaults and inspect what's there. */
function SearchConfigsBlock({ slug }: { slug: string }) {
  const { runExplicit, sessionAccess, coarseAdminEligible } = useAdminAccess()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string[] | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null)

  const { data: sessionData, refetch, isLoading, isError } = useQuery({
    queryKey: ['admin-search-configs', slug],
    queryFn: async () => validConfigs(await getSearchConfigs(slug, sessionAccess)),
    enabled: coarseAdminEligible,
    retry: false,
  })
  const data = coarseAdminEligible ? sessionData : snapshot

  const onLoad = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        'Load search configurations',
        async (access) => validConfigs(await getSearchConfigs(slug, access)),
      )
      if (result === undefined) return
      if (coarseAdminEligible) queryClient.setQueryData(['admin-search-configs', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not load search configurations.'),
      })
    } finally {
      setBusy(false)
    }
  }

  const onEnsure = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit('Create default search configurations', async (access) => {
        const saved = await ensureSearchConfigs(slug, access)
        if (
          saved?.ok !== true || !Array.isArray(saved.created) ||
          saved.created.some((name) => typeof name !== 'string')
        ) throw new AdminAccessError()
        return saved
      })
      if (result === undefined) return
      setCreated(result.created)
      setMessage({
        tone: 'ok',
        text: result.created.length > 0
          ? `Created ${result.created.length} ${
            result.created.length === 1 ? 'configuration' : 'configurations'
          }.`
          : 'All default configurations already exist.',
      })
      if (coarseAdminEligible) await refetch()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not create the default configurations.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rp-card mt-4 p-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-ink'>Search configurations</h3>
          <p className='mt-1 text-xs text-ink-3'>
            The named retrieval configurations this portal's search and ask calls draw on.
          </p>
        </div>
        <button
          type='button'
          data-behaviour-ensure
          disabled={busy}
          onClick={() => void onEnsure()}
          className='rp-btn rp-btn-outline h-auto whitespace-normal py-2'
        >
          {busy ? 'Creating…' : 'Create default configurations'}
        </button>
      </div>

      <button
        type='button'
        data-behaviour-read='configs'
        disabled={busy}
        onClick={() => void onLoad()}
        className='rp-btn rp-btn-outline mt-3 h-auto whitespace-normal py-2'
      >
        Refresh search configurations
      </button>
      {!data && !isLoading && (
        <p className='mt-3 text-sm text-ink-3'>
          Load search configurations to inspect the current settings.
        </p>
      )}

      {created && created.length > 0 && (
        <ul className='mt-3 flex flex-wrap gap-1.5'>
          {created.map((name) => <li key={name} className='rp-chip'>{name}</li>)}
        </ul>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}
      <IntentsTable
        slug={slug}
        live={data ?? null}
        loading={isLoading}
        error={isError}
      />

      <details className='mt-4'>
        <summary className='cursor-pointer text-xs font-medium text-ink-2'>
          View raw configuration JSON
        </summary>
        <div className='mt-2 max-h-80 overflow-auto rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'>
          {isLoading && <p className='text-xs text-ink-3'>Loading…</p>}
          {isError && <p className='text-xs text-ink-3'>Could not load search configurations.</p>}
          {data && (
            <pre className='whitespace-pre-wrap break-all text-xs text-ink-2'>
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </div>
  )
}

/**
 * Behaviour: the portal's grounded-answer system prompt and its search
 * configurations. Both are platform-facing settings, not content.
 */
export function BehaviourPanel({ slug }: { slug: string }) {
  return (
    <div className='space-y-4'>
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
  const { runExplicit, sessionAccess, coarseAdminEligible } = useAdminAccess()
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
    enabled: coarseAdminEligible,
    retry: false,
    refetchInterval: coarseAdminEligible ? 30_000 : false,
  })
  const routing = coarseAdminEligible ? sessionRouting : snapshot
  const onLoad = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        'Load routing activity',
        async (access) => validRouting(await getRouting(slug, access)),
      )
      if (result === undefined) return
      if (coarseAdminEligible) queryClient.setQueryData(['admin-routing', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not load routing activity.') })
    } finally {
      setBusy(false)
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
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h4 className='text-sm font-semibold text-ink'>Intent routing</h4>
        {summary && summary.total > 0
          ? (
            <p className='text-xs text-ink-3'>
              {summary.total} decisions ·{' '}
              {Object.entries(summary.byStage).map(([k, v]) => `${v} ${k}`).join(', ')}
            </p>
          )
          : (
            <p className='text-xs text-ink-3'>
              {routing
                ? 'No routing decisions logged yet.'
                : 'Load routing activity to view decisions.'}
            </p>
          )}
      </div>
      <button
        type='button'
        data-behaviour-read='routing'
        disabled={busy}
        onClick={() => void onLoad()}
        className='rp-btn rp-btn-outline my-3'
      >
        Refresh routing activity
      </button>
      {message && <MessagePanel message={message} className='mt-3' />}
      <div className='mt-2 overflow-x-auto'>
        <table className='w-full text-left text-xs'>
          <thead className='text-ink-3'>
            <tr>
              <th className='py-1.5 pr-3 font-medium'>Intent</th>
              <th className='py-1.5 pr-3 font-medium'>Configuration</th>
              <th className='py-1.5 pr-3 font-medium'>Policy</th>
              <th className='py-1.5 font-medium'>On the box</th>
              <th className='py-1.5 pl-3 text-right font-medium'>Routed</th>
            </tr>
          </thead>
          <tbody>
            {intents.map((intent) => (
              <tr key={intent.id} className='border-t border-line align-top'>
                <td className='py-2 pr-3'>
                  <span className='font-medium text-ink'>{intent.label}</span>
                  <span className='block text-ink-3'>{intent.description}</span>
                </td>
                <td className='py-2 pr-3 font-mono text-[11px] text-ink-2'>
                  {names(intent.id, intent.answer.surfaces).map((n) => (
                    <span key={n} className='block'>{n}</span>
                  ))}
                </td>
                <td className='py-2 pr-3 text-ink-2'>{intentSummary(intent)}</td>
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
                            : 'text-ink-3'
                        }`}
                      >
                        {st}
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
