import { stageText } from './shared.ts'
import { messageFor } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AnalyseEvent } from '@research-portal/core'
import { analysePortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { Sparkles } from '../../components/icons.tsx'
import type { Message } from './shared.ts'
import { failedJobMessage, StreamedJob } from './streamed-job.ts'

type AnalyseDone = Extract<AnalyseEvent, { type: 'done' }>

/**
 * Follows one analysis stream: every line goes to the live log, and the job
 * settles on the counts or on the reason the server gave for stopping - a
 * refusal to replace a label set this portal did not create among them - in
 * the server's words.
 */
export function followAnalysis(
  job: StreamedJob<AnalyseDone>,
  onLog: (event: AnalyseEvent) => void,
): (event: AnalyseEvent) => void {
  return job.events((event: AnalyseEvent) => {
    onLog(event)
    if (event.type === 'error') job.fail(event)
    else if (event.type === 'done') {
      const counts = [event.topics, event.kinds, event.labelled, event.questions]
      if (counts.every(Number.isFinite)) job.complete(event)
      else job.uncertain()
    }
  })
}

/**
 * Interrogate the knowledge box: the system reads the corpus, designs the
 * topic taxonomy, the graph dimensions and the suggested questions, and
 * applies all of it - live progress below.
 */
function AnalysePanelContent({ slug }: { slug: string }) {
  const { language, ui, error: localError } = usePortalLocale()

  const { runExplicit, sessionAllowed } = usePermissionAdminAccess('behaviour.write', {
    kind: 'portal',
    slug,
  })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const queryClient = useQueryClient()
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<AnalyseEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  const run = async () => {
    setRunning(true)
    setLog([])
    setMessage(null)
    const job = new StreamedJob<AnalyseDone>(assertCurrent, 'Analysis failed - please retry.')
    try {
      const result = await runExplicit(ui('Analyse and configure this portal'), async (access) => {
        await analysePortal(
          slug,
          access,
          followAnalysis(job, (event) => setLog((prev) => [...prev, event])),
        )
        return job.result()
      })
      assertCurrent()
      if (result === undefined) return
      setMessage(messageFor('ok', ({ ui }) =>
        ui(
          'Analysis complete - {topics} topics, {kinds} kinds, {labelled} resources labelled, {questions} suggested questions. The portal now reflects what is in the box.',
          {
            topics: result.topics,
            kinds: result.kinds,
            labelled: result.labelled,
            questions: result.questions,
          },
        )))
      if (sessionAllowed) await queryClient.invalidateQueries()
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            failedJobMessage(job, err, 'Analysis failed - please retry.', localError).text,
        ),
      )
    } finally {
      if (context === authority.controller.context) setRunning(false)
    }
  }

  return (
    <div>
      <SectionHeader
        className='rp-manage-section-head'
        title={ui('Analyse and configure')}
        description={ui(
          'Derives the taxonomy, graph dimensions and suggested questions from the corpus.',
        )}
        actions={
          <Button leadingIcon={Sparkles} disabled={running} onClick={() => void run()}>
            {running ? ui('Analysing…') : ui('Run analysis')}
          </Button>
        }
      />

      {running && (
        <p role='status' className='mt-3 text-sm text-ink-3'>
          {ui(
            'Waiting for the confirmed result. Progress may arrive together when the action finishes.',
          )}
        </p>
      )}
      {log.length > 0 && (
        <ol className='mt-3 max-h-56 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3 text-xs'>
          {log.map((event, index) => (
            <li key={index} className='flex gap-2'>
              {event.type === 'stage' && (
                <span className='font-semibold text-ink'>
                  {stageText(event.label, { language, ui })}
                </span>
              )}
              {event.type === 'item' && (
                <span className='text-ink-2' title={event.detail}>{event.label}</span>
              )}
              {event.type === 'done' && (
                <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>
                  {ui('Finished.')}
                </span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>
                  {localError(event.message, 'The action failed. Please try again.')}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}

export function AnalysePanel(props: { slug: string }) {
  const authority = useAccess()
  const permission = usePermissionAdminAccess('behaviour.write', {
    kind: 'portal',
    slug: props.slug,
  })
  if (
    authority.state.status !== 'ready' ||
    (!permission.sessionAllowed && !permission.breakGlassEnabled)
  ) return null
  return <AnalysePanelContent key={`${props.slug}:${authority.generation}`} {...props} />
}
