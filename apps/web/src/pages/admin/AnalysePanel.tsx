import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AnalyseEvent } from '@research-portal/core'
import { analysePortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Interrogate the knowledge box: the system reads the corpus, designs the
 * topic taxonomy, the graph dimensions and the suggested questions, and
 * applies all of it - live progress below.
 */
export function AnalysePanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<AnalyseEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  const run = async () => {
    setRunning(true)
    setLog([])
    setMessage(null)
    try {
      await analysePortal(slug, passcode, (event) => {
        setLog((prev) => [...prev, event])
        if (event.type === 'done') {
          setMessage({
            tone: 'ok',
            text: `Analysis complete - ${event.topics} topics, ${event.kinds} kinds, ` +
              `${event.labelled} resources labelled, ${event.questions} suggested questions. ` +
              'The portal now reflects what is in the box.',
          })
        }
        if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await queryClient.invalidateQueries()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Analysis failed - please retry.') })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className='mt-5 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <p className='text-sm font-semibold text-ink'>Analyse and configure</p>
          <p className='mt-0.5 text-xs text-ink-3'>
            Interrogates the box and derives the taxonomy, graph dimensions and suggested questions
            from what is actually in it.
          </p>
        </div>
        <button
          type='button'
          disabled={running}
          onClick={() => void run()}
          className='rp-btn rp-btn-primary'
        >
          {running ? 'Analysing…' : 'Run analysis'}
        </button>
      </div>

      {log.length > 0 && (
        <ol className='mt-3 max-h-56 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface p-3 text-xs'>
          {log.map((event, index) => (
            <li key={index} className='flex gap-2'>
              {event.type === 'stage' && (
                <span className='font-semibold text-ink'>{event.label}</span>
              )}
              {event.type === 'item' && (
                <span className='text-ink-2' title={event.detail}>{event.label}</span>
              )}
              {event.type === 'done' && (
                <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>Finished.</span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>{event.message}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}
