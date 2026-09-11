import { useAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
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
export function AnalysePanel({ slug }: { slug: string }) {
  const { runExplicit, coarseAdminEligible } = useAdminAccess()
  const queryClient = useQueryClient()
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<AnalyseEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  const run = async () => {
    setRunning(true)
    setLog([])
    setMessage(null)
    try {
      const result = await runExplicit('Analyse and configure this portal', async (access) => {
        let completed = false
        let failed = false
        await analysePortal(slug, access, (event) => {
          setLog((prev) => [...prev, event])
          if (event.type === 'error') failed = true
          if (event.type === 'done') {
            completed = [event.topics, event.kinds, event.labelled, event.questions].every(
              Number.isFinite,
            )
            setMessage({
              tone: 'ok',
              text: `Analysis complete - ${event.topics} topics, ${event.kinds} kinds, ` +
                `${event.labelled} resources labelled, ${event.questions} suggested questions. ` +
                'The portal now reflects what is in the box.',
            })
          }
          if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
        })
        if (!completed || failed) throw new AdminAccessError()
        return true
      })
      if (result === undefined) return
      if (coarseAdminEligible) await queryClient.invalidateQueries()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Analysis failed - please retry.') })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className='mt-6 border-t border-line pt-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-ink'>Analyse and configure</h3>
          <p className='mt-0.5 text-xs text-ink-2'>
            Derives the taxonomy, graph dimensions and suggested questions from the corpus.
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

      {running && (
        <p role='status' className='mt-3 text-sm text-ink-3'>
          Waiting for the confirmed result. Progress may arrive together when the action finishes.
        </p>
      )}
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
