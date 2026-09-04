import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ensureSearchConfigs, getPrompts, getSearchConfigs, savePrompts } from '../../api/client.ts'
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
