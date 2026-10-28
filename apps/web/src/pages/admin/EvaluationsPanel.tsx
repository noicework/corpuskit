import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  EvaluationInput,
  EvaluationRun,
  EvaluationSchedule,
  EvaluationSet,
} from '@research-portal/core'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { assertResponseCurrent } from '../../api/break-glass.ts'

const blankQuestion = () => ({
  query: '',
  expectedSources: '',
  expectedFacts: '',
  shouldDecline: false,
})
export function EvaluationsPanel({ slug }: { slug: string }) {
  const authority = useAccess()
  return (
    <EvaluationEditor
      key={`${slug}:${authority.identityKey}:${authority.generation}`}
      slug={slug}
    />
  )
}

function EvaluationEditor({ slug }: { slug: string }) {
  const locale = usePortalLocale()
  const { ui } = locale
  const percent = (value: number | null) =>
    value === null ? ui('Not measured') : `${locale.number(Math.round(value * 100))}%`
  const score = (value: number | null) =>
    value === null
      ? ui('Not returned')
      : `${locale.number(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 5`
  const { sessionAccess } = usePermissionAdminAccess('behaviour.write', { kind: 'portal', slug })
  const authority = useAccess()
  const cache = useQueryClient()
  const base = `/api/admin/t/${encodeURIComponent(slug)}/evaluations`
  const context = authority.controller.context
  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await sessionAccess.request(`${base}${path}`, init)
    const data = await response.json()
    assertResponseCurrent(response)
    authority.controller.assertCurrent(context)
    if (!response.ok) {
      const messages: Record<string, string> = {
        ask_quota_exceeded: 'The portal has too few asks remaining today for this run.',
        confirmation_required:
          'The saved set changed. Refresh it and confirm the current ask count.',
        evaluation_already_running:
          'An evaluation is already running on this portal. Try again after it finishes.',
      }
      throw new Error(messages[data.error] ?? data.message ?? 'Evaluation request failed.')
    }
    return data as T
  }
  const key = ['evaluations', slug, authority.identityKey, authority.generation]
  const sets = useQuery({
    queryKey: key,
    queryFn: () =>
      request<{
        sets: EvaluationSet[]
        schedules: Omit<EvaluationSchedule, 'owner'>[]
        asksToday: number
        asksPerDay: number | null
      }>(''),
    retry: false,
  })
  const [selected, setSelected] = useState<string>('')
  const [name, setName] = useState('')
  const [topK, setTopK] = useState(5)
  const [questions, setQuestions] = useState([blankQuestion()])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [cadence, setCadence] = useState<'off' | '1' | '7'>('off')
  const current = sets.data?.sets.find((set) => set.id === selected)
  const runs = useQuery({
    queryKey: [...key, selected, 'runs'],
    queryFn: () => request<EvaluationRun[]>(`/${selected}/runs`),
    enabled: !!current,
    retry: false,
  })
  const choose = (set?: EvaluationSet) => {
    setSelected(set?.id ?? '')
    setName(set?.name ?? '')
    setTopK(set?.topK ?? 5)
    setQuestions(
      set?.questions.map((q) => ({
        ...q,
        expectedSources: q.expectedSources.join(', '),
        expectedFacts: q.expectedFacts.join('\n'),
      })) ?? [blankQuestion()],
    )
    setConfirming(false)
    const schedule = sets.data?.schedules.find((s) => s.setId === set?.id)
    setCadence(schedule ? String(schedule.everyDays) as '1' | '7' : 'off')
    setError('')
    setMessage('')
  }
  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
    } catch (error) {
      if (context === authority.controller.context) {
        setError(error instanceof Error ? error.message : 'The evaluation could not be completed.')
      }
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: key })
  }
  const save = () =>
    act(async () => {
      const input: EvaluationInput = {
        name,
        topK,
        questions: questions.map((q) => ({
          query: q.query,
          shouldDecline: q.shouldDecline,
          expectedSources: q.expectedSources.split(',').map((v) => v.trim()).filter(Boolean),
          expectedFacts: q.expectedFacts.split('\n').map((v) => v.trim()).filter(Boolean),
        })),
      }
      const set = await request<EvaluationSet>(`/${selected || crypto.randomUUID()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      await refresh()
      choose(set)
      setMessage('Evaluation set saved.')
    })
  const run = () =>
    act(async () => {
      if (!current) return
      setConfirming(false)
      await request<EvaluationRun>(`/${current.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmedAsks: current.questions.length,
          updatedAt: current.updatedAt,
        }),
      })
      await refresh()
      setMessage('Evaluation run finished. Review the results below.')
    })
  const schedule = () =>
    act(async () => {
      if (!current) return
      await request(`/${current.id}/schedule`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          everyDays: cadence === 'off' ? null : Number(cadence),
          confirmedAsks: current.questions.length,
          updatedAt: current.updatedAt,
        }),
      })
      await refresh()
      setMessage(
        cadence === 'off'
          ? 'Schedule turned off.'
          : 'Schedule confirmed. It runs on the next due maintenance pass.',
      )
    })
  const download = (run: EvaluationRun) =>
    act(async () => {
      const response = await sessionAccess.request(`${base}/${run.setId}/runs/${run.id}/csv`)
      const blob = await response.blob()
      assertResponseCurrent(response)
      authority.controller.assertCurrent(context)
      if (!response.ok) throw new Error('The CSV could not be downloaded.')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'evaluation.csv'
      link.click()
      URL.revokeObjectURL(url)
      setMessage('Evaluation CSV downloaded.')
    })
  return (
    <section className='rp-card min-w-0 space-y-5 p-5 lg:p-6' data-evaluations>
      <SectionHeader
        className='rp-admin-section-head'
        title={ui('Evaluation sets')}
        description={ui(
          'Measure this portal’s retrieval, citations, answer quality and declines over time.',
        )}
      />
      <p className='text-sm text-ink-2'>
        {ui('Each question uses up to one portal ask. Runs share the daily ask cap.')}{' '}
        {sets.data && (sets.data.asksPerDay === null
          ? ui('Today: {used} asks.', { used: sets.data.asksToday })
          : ui('Today: {used} of {cap} asks.', {
            used: sets.data.asksToday,
            cap: sets.data.asksPerDay,
          }))}
      </p>
      <p role='status' aria-live='polite'>
        {busy ? ui('Working. A run can take several minutes.') : ui(message)}
      </p>
      {(error || sets.isError || runs.isError) && (
        <p role='alert' className='text-[var(--rp-bad-ink)]'>
          {locale.error(error, 'Evaluation data could not be loaded. Try refreshing the page.')}
        </p>
      )}
      {sets.isLoading && <p role='status'>{ui('Loading evaluation sets…')}</p>}
      {sets.data?.sets.length === 0 && (
        <p>{ui('No evaluation sets yet. Define questions below to begin.')}</p>
      )}
      <label className='block space-y-2'>
        <span className='text-sm font-semibold'>{ui('Evaluation set')}</span>
        <select
          className='rp-input w-full'
          value={selected}
          disabled={busy}
          onChange={(e) => choose(sets.data?.sets.find((set) => set.id === e.target.value))}
        >
          <option value=''>{ui('New evaluation set')}</option>
          {sets.data?.sets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
        </select>
      </label>
      <form
        className='min-w-0 space-y-5'
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <fieldset disabled={busy} className='min-w-0 space-y-4'>
          <legend className='sr-only'>{ui('Evaluation definition')}</legend>
          <label className='block space-y-2'>
            <span className='text-sm font-semibold'>{ui('Set name')}</span>
            <input
              className='rp-input w-full'
              required
              maxLength={120}
              name='evaluation-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className='block space-y-2'>
            <span className='text-sm font-semibold'>{ui('Retrieval top k')}</span>
            <input
              className='rp-input w-full'
              type='number'
              min={1}
              max={50}
              required
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
            />
          </label>
          {questions.map((question, index) => (
            <fieldset
              key={index}
              className='min-w-0 space-y-3 border border-line p-4 [border-radius:var(--rp-radius)]'
            >
              <legend className='px-2 font-semibold'>
                {ui('Question {number}', { number: index + 1 })}
              </legend>
              <label className='block space-y-2'>
                <span className='text-sm'>{ui('Question')}</span>
                <textarea
                  className='rp-input w-full'
                  required
                  maxLength={2000}
                  name={`question-${index}`}
                  value={question.query}
                  onChange={(e) =>
                    setQuestions(
                      questions.map((q, i) => i === index ? { ...q, query: e.target.value } : q),
                    )}
                />
              </label>
              <label className='flex min-h-11 items-center gap-3'>
                <input
                  type='checkbox'
                  className='rp-focus size-6 shrink-0'
                  checked={question.shouldDecline}
                  onChange={(e) =>
                    setQuestions(
                      questions.map((q, i) =>
                        i === index ? { ...q, shouldDecline: e.target.checked } : q
                      ),
                    )}
                />
                <span>{ui('Should decline as unanswerable')}</span>
              </label>
              <label className='block space-y-2'>
                <span className='text-sm'>
                  {ui('Expected source resource IDs, separated by commas')}
                </span>
                <input
                  className='rp-input w-full'
                  required={!question.shouldDecline}
                  name={`sources-${index}`}
                  value={question.expectedSources}
                  onChange={(e) =>
                    setQuestions(
                      questions.map((q, i) =>
                        i === index ? { ...q, expectedSources: e.target.value } : q
                      ),
                    )}
                />
              </label>
              <label className='block space-y-2'>
                <span className='text-sm'>{ui('Expected facts, one per line (optional)')}</span>
                <textarea
                  className='rp-input w-full'
                  value={question.expectedFacts}
                  onChange={(e) =>
                    setQuestions(
                      questions.map((q, i) =>
                        i === index ? { ...q, expectedFacts: e.target.value } : q
                      ),
                    )}
                />
              </label>
              <Button
                className='max-w-full whitespace-normal'
                type='button'
                variant='ghost'
                disabled={questions.length === 1}
                onClick={() =>
                  setQuestions(questions.filter((_, i) => i !== index))}
              >
                {ui('Remove question {number}', { number: index + 1 })}
              </Button>
            </fieldset>
          ))}
          <div className='flex flex-wrap gap-3'>
            <Button
              className='max-w-full whitespace-normal'
              type='button'
              variant='outline'
              disabled={questions.length >= 20}
              onClick={() => setQuestions([...questions, blankQuestion()])}
            >
              {ui('Add question')}
            </Button>
            <Button className='max-w-full whitespace-normal' type='submit'>
              {ui('Save evaluation set')}
            </Button>
          </div>
        </fieldset>
      </form>
      {current && (
        <div className='space-y-3 border-t border-line pt-4'>
          <p>
            {ui('Run the saved set: {count} asks. Save edits before running.', {
              count: current.questions.length,
            })}
          </p>
          {!confirming
            ? (
              <Button
                className='max-w-full whitespace-normal'
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {ui('Run saved set')}
              </Button>
            )
            : (
              <div className='space-y-3' role='group' aria-label={ui('Confirm evaluation run')}>
                <p role='status'>
                  {ui(
                    'This run will use up to {count} asks from this portal’s daily cap. Continue?',
                    { count: current.questions.length },
                  )}
                </p>
                <div className='flex flex-wrap gap-3'>
                  <Button
                    className='max-w-full whitespace-normal'
                    disabled={busy}
                    onClick={() => void run()}
                  >
                    {ui('Confirm {count} asks', { count: current.questions.length })}
                  </Button>
                  <Button
                    className='max-w-full whitespace-normal'
                    variant='outline'
                    onClick={() => setConfirming(false)}
                  >
                    {ui('Cancel run')}
                  </Button>
                </div>
              </div>
            )}
        </div>
      )}
      {current && (
        <div className='space-y-3 border-t border-line pt-4'>
          <h3 className='text-lg font-semibold'>{ui('Optional schedule')}</h3>
          <p className='text-sm text-ink-2'>
            {ui(
              'Each scheduled run uses up to {count} asks from this portal’s daily cap. A current local administrator assignment is required. Editing the set pauses the schedule until it is confirmed again.',
              { count: current.questions.length },
            )}
          </p>
          <label className='block space-y-2'>
            <span className='text-sm font-semibold'>
              {ui('Repeat on the daily maintenance pass')}
            </span>
            <select
              className='rp-input w-full'
              value={cadence}
              disabled={busy}
              onChange={(e) => setCadence(e.target.value as 'off' | '1' | '7')}
            >
              <option value='off'>{ui('Off')}</option>
              <option value='1'>{ui('Daily')}</option>
              <option value='7'>{ui('Weekly')}</option>
            </select>
          </label>
          <Button
            className='max-w-full whitespace-normal'
            variant='outline'
            disabled={busy}
            onClick={() => void schedule()}
          >
            {cadence === 'off'
              ? ui('Turn schedule off')
              : ui('Confirm schedule: up to {count} asks per run', {
                count: current.questions.length,
              })}
          </Button>
          {sets.data?.schedules.filter((s) => s.setId === current.id).map((s) => (
            <p key={s.setId} role='status' className='text-sm'>
              {s.updatedAt === current.updatedAt
                ? ui('Next due: {date}.', {
                  date: locale.date(s.nextAt, { dateStyle: 'short', timeStyle: 'short' }),
                })
                : ui('Definition changed. Confirm the schedule again to resume.')}
            </p>
          ))}
        </div>
      )}
      {current && (
        <div className='min-w-0 space-y-4' data-evaluation-runs>
          <h3 className='text-lg font-semibold'>{ui('Run history')}</h3>
          <details>
            <summary className='rp-focus min-h-11 cursor-pointer py-3'>
              {ui('How scores are measured')}
            </summary>
            <p className='text-sm text-ink-2'>
              {ui(
                'Retrieval: any expected source in top k. Citation precision: distinct cited sources that are expected or verified by the ask path. Facts: literal phrase coverage, for reviewer guidance. REMi scores are returned by the ask path; missing scores remain unmeasured. Errors are reported separately.',
              )}
            </p>
          </details>
          {runs.data?.length === 0 && <p>{ui('No runs yet.')}</p>}
          {runs.data?.map((run, index, history) => (
            <article
              key={run.id}
              className='min-w-0 space-y-3 border border-line p-4 [border-radius:var(--rp-radius)]'
              data-evaluation-run
            >
              <h4 className='font-semibold'>
                <time dateTime={run.startedAt}>
                  {locale.date(run.startedAt, { dateStyle: 'short', timeStyle: 'short' })}
                </time>
              </h4>
              <p className='text-sm'>
                <span className='rp-badge'>{ui(run.status)}</span>{' '}
                {ui('{recorded} of {total} questions recorded. Errors: {errors}. Top k: {k}.', {
                  recorded: run.results.length,
                  total: run.definition.questions.length,
                  errors: run.summary.errors,
                  k: run.definition.topK,
                })}
              </p>
              <dl className='grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4'>
                {[
                  ['Retrieval hit rate', percent(run.summary.retrievalHitRate)],
                  ['Citation precision', percent(run.summary.citationPrecision)],
                  ['Decline correctness', percent(run.summary.declineCorrectness)],
                  ['Expected fact coverage', percent(run.summary.factCoverage)],
                  ['REMi answer relevance', score(run.summary.answerRelevance)],
                  ['REMi groundedness', score(run.summary.groundedness)],
                  ['REMi context relevance', score(run.summary.contextRelevance)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className='text-sm text-ink-2'>{ui(label!)}</dt>
                    <dd className='font-semibold'>{value}</dd>
                  </div>
                ))}
              </dl>
              {history[index + 1] && (
                <p className='text-sm'>
                  {ui(
                    'Previous run retrieval: {retrieval}; citation precision: {citations}. Compare the saved definitions when questions change.',
                    {
                      retrieval: percent(history[index + 1]!.summary.retrievalHitRate),
                      citations: percent(history[index + 1]!.summary.citationPrecision),
                    },
                  )}
                </p>
              )}
              <Button
                className='max-w-full whitespace-normal'
                variant='outline'
                disabled={busy}
                onClick={() => void download(run)}
              >
                {ui('Download CSV')}
              </Button>
              <details className='min-w-0'>
                <summary className='rp-focus min-h-11 cursor-pointer py-3'>
                  {ui('Per-question results')}
                </summary>
                <ol className='space-y-4'>
                  {run.results.map((result, i) => (
                    <li key={i} className='break-words [overflow-wrap:anywhere]'>
                      <p className='font-semibold'>{i + 1}. {result.question.query}</p>
                      <p>
                        {result.ok
                          ? ui(
                            'Retrieval: {retrieval}; citations: {citations}; decline: {decline}.',
                            {
                              retrieval: ui(
                                result.retrievalHit === null
                                  ? 'not measured'
                                  : result.retrievalHit
                                  ? 'hit'
                                  : 'miss',
                              ),
                              citations: percent(result.citationPrecision),
                              decline: ui(result.declineCorrect ? 'correct' : 'incorrect'),
                            },
                          )
                          : locale.error(result.detail, 'The evaluation could not be completed.')}
                      </p>
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
