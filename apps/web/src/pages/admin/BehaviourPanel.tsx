import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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

/**
 * Ask system prompt editor. Loads the current prompt (if any), lets the
 * librarian override it, and saves straight back through the admin API.
 */
function AskPromptEditor({ slug, passcode }: { slug: string; passcode: string }) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const { data } = useQuery({
    queryKey: ['admin-prompts', slug],
    queryFn: () => getPrompts(slug, passcode),
  })

  useEffect(() => {
    if (data && !loaded) {
      setValue(data.ask ?? '')
      setImages(data.images ?? false)
      setLoaded(true)
    }
  }, [data, loaded])

  const onSave = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await savePrompts(slug, passcode, { ask: value.trim() || undefined, images })
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
      <textarea
        className='rp-input mt-3'
        rows={8}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='Leave empty to use the default analyst prompt.'
      />
      <label className='mt-3 flex items-center gap-2 text-sm text-ink-2'>
        <input
          type='checkbox'
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
          disabled={busy}
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
function SearchConfigsBlock({ slug, passcode }: { slug: string; passcode: string }) {
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string[] | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const { data, refetch, isLoading, isError } = useQuery({
    queryKey: ['admin-search-configs', slug],
    queryFn: () => getSearchConfigs(slug, passcode),
  })

  const onEnsure = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await ensureSearchConfigs(slug, passcode)
      setCreated(result.created)
      setMessage({
        tone: 'ok',
        text: result.created.length > 0
          ? `Created ${result.created.length} ${
            result.created.length === 1 ? 'configuration' : 'configurations'
          }.`
          : 'All default configurations already exist.',
      })
      await refetch()
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
          disabled={busy}
          onClick={() => void onEnsure()}
          className='rp-btn rp-btn-outline'
        >
          {busy ? 'Creating…' : 'Create default configurations'}
        </button>
      </div>

      {created && created.length > 0 && (
        <ul className='mt-3 flex flex-wrap gap-1.5'>
          {created.map((name) => <li key={name} className='rp-chip'>{name}</li>)}
        </ul>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}
      <IntentsTable
        slug={slug}
        passcode={passcode}
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
export function BehaviourPanel({ slug, passcode }: { slug: string; passcode: string }) {
  return (
    <div className='space-y-4'>
      <AskPromptEditor slug={slug} passcode={passcode} />
      <SearchConfigsBlock slug={slug} passcode={passcode} />
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
  { slug, passcode, live, loading, error }: {
    slug: string
    passcode: string
    live: Record<string, unknown> | null
    loading: boolean
    error: boolean
  },
) {
  const { data: config } = useQuery({
    queryKey: ['tenant-config', slug],
    queryFn: () => getTenantConfig(slug),
  })
  const { data: routing } = useQuery({
    queryKey: ['admin-routing', slug],
    queryFn: () => getRouting(slug, passcode),
    refetchInterval: 30_000,
  })
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
          : <p className='text-xs text-ink-3'>No routing decisions logged yet.</p>}
      </div>
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
