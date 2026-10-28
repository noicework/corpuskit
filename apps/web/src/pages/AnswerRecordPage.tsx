import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  type AnswerRecord,
  type AnswerRecordPassage,
  AnswerRecordSchema,
} from '@research-portal/core'
import { useAccess } from '../components/AccessProvider.tsx'
import { assertResponseCurrent, authorityFetch } from '../api/break-glass.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'

export function AnswerRecordPage() {
  const { slug = '', id = '' } = useParams()
  const access = useAccess()
  const { ui } = usePortalLocale()
  if (!access.can('content.write', { kind: 'portal', slug })) {
    return (
      <p className='p-6 text-ink-2' role='status'>
        {ui('Answer records are available to curators and portal administrators.')}
      </p>
    )
  }
  return <RecordView key={`${access.generation}:${slug}:${id}`} slug={slug} id={id} />
}

function RecordView({ slug, id }: { slug: string; id: string }) {
  const access = useAccess()
  const { ui } = usePortalLocale()
  const [record, setRecord] = useState<AnswerRecord | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [days, setDays] = useState(90)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const invalidRange = Boolean(from && to && from > to)
  const lifetime = useRef(new AbortController())
  const base = `/api/admin/t/${encodeURIComponent(slug)}/answer-records`
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const load = async () => {
      try {
        const responses = await Promise.all([
          authorityFetch(`${base}/records/${encodeURIComponent(id)}`, {
            signal: controller.signal,
          }),
          authorityFetch(`${base}/retention`, { signal: controller.signal }),
        ])
        const [detail, retention] = responses
        const [value, setting] = await Promise.all([detail.json(), retention.json()])
        if (controller.signal.aborted) return
        if (!retention.ok) throw new Error('The retention setting could not be loaded.')
        setDays(setting.days)
        setRetentionDays(setting.days)
        if (!detail.ok) {
          throw new Error(
            detail.status === 404
              ? 'This answer record has expired or is unavailable.'
              : 'The answer record could not be loaded.',
          )
        }
        setRecord(AnswerRecordSchema.parse(value))
      } catch {
        if (!controller.signal.aborted) {
          setError(ui('The answer record is unavailable. It may have expired.'))
        }
      }
    }
    void load()
    return () => controller.abort()
  }, [base, id])

  const download = async (format: 'json' | 'csv', range: boolean) => {
    setBusy(true)
    setError('')
    setStatus(ui('Preparing export...'))
    const signal = lifetime.current.signal
    try {
      const params = new URLSearchParams({ format })
      if (range) {
        if (!from || !to || from > to) throw new Error('invalid range')
        params.set('from', `${from}T00:00:00.000Z`)
        params.set('to', `${to}T23:59:59.999Z`)
      }
      const parts: string[] = []
      const records: AnswerRecord[] = []
      let cursor: string | null = null
      const seen = new Set<string>()
      do {
        if (cursor) params.set('cursor', cursor)
        const response = await authorityFetch(
          `${base}${range ? '' : `/records/${id}`}/export?${params}`,
          {
            signal,
          },
        )
        if (!response.ok) {
          await response.text()
          throw new Error('export failed')
        }
        if (format === 'csv') {
          const text = await response.text()
          parts.push(parts.length ? text.slice(text.indexOf('\r\n') + 2) : text)
          cursor = response.headers.get('X-Answer-Records-Next')
        } else {
          const result = await response.json()
          records.push(...result.records.map((r: unknown) => AnswerRecordSchema.parse(r)))
          cursor = result.nextCursor
        }
        assertResponseCurrent(response)
        if (cursor && seen.has(cursor)) throw new Error('invalid export cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      signal.throwIfAborted()
      const blob = new Blob(
        [format === 'csv' ? parts.join('') : JSON.stringify(records, null, 2)],
        {
          type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
        },
      )
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `answer-records-${slug}.${format}`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatus(ui('Export ready. Your download has started.'))
    } catch {
      if (!signal.aborted) {
        setError(ui('Export failed. Check the date range and try again.'))
        setStatus('')
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  const saveRetention = async () => {
    setBusy(true)
    setError('')
    setStatus('')
    const signal = lifetime.current.signal
    try {
      const response = await authorityFetch(`${base}/retention`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
        signal,
      })
      await response.json()
      if (!response.ok) throw new Error('save failed')
      assertResponseCurrent(response)
      setRetentionDays(days)
      setStatus(ui('Retention saved. Older answer records have been removed.'))
    } catch {
      if (!signal.aborted) setError(ui('Retention could not be saved.'))
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <main className='min-w-0 space-y-6 p-4 text-ink sm:p-8'>
      <Link className='rp-btn rp-btn-outline' to={`/t/${slug}/ask`}>{ui('Back to Ask')}</Link>
      <header>
        <h1 className='rp-display text-3xl'>{ui('Answer record')}</h1>
        <p className='mt-2 text-ink-2'>
          {ui(
            'Personal data. Access and exports are limited to curators and portal administrators.',
          )}
        </p>
      </header>
      <p role='status' aria-live='polite'>
        {status || (!record && !error ? ui('Loading answer record...') : '')}
      </p>
      {error && (
        <p
          role='alert'
          className='rounded-[var(--rp-radius)] border border-[var(--rp-bad-line)] bg-[var(--rp-bad-bg)] p-3 text-[var(--rp-bad-ink)]'
        >
          {error}
        </p>
      )}
      {record && (
        <>
          <section className='rp-card space-y-3 p-3 sm:p-5' aria-labelledby='record-question'>
            <h2 id='record-question' className='rp-display text-xl'>{ui('Question')}</h2>
            <p className='max-w-prose whitespace-pre-wrap break-words'>{record.question}</p>
            <p className='break-all text-sm text-ink-2'>{record.answerId}</p>
            <p className='text-sm text-ink-2'>
              {record.portal} · {new Date(record.at).toLocaleString('en-AU')} · {record.surface} ·
              {' '}
              {record.status}
            </p>
            {record.truncated && (
              <p role='status'>
                {ui(
                  'This record reached its storage limit. Some evidence text or items were shortened.',
                )}
              </p>
            )}
            <div className='flex flex-wrap gap-2'>
              <button
                type='button'
                className='rp-btn rp-btn-outline'
                disabled={busy}
                onClick={() => void download('json', false)}
              >
                {ui('Export record JSON')}
              </button>
              <button
                type='button'
                className='rp-btn rp-btn-outline'
                disabled={busy}
                onClick={() => void download('csv', false)}
              >
                {ui('Export record CSV')}
              </button>
            </div>
          </section>
          <section className='rp-card p-3 sm:p-5' aria-labelledby='retrieval-queries'>
            <h2 id='retrieval-queries' className='rp-display text-xl'>{ui('Retrieval queries')}</h2>
            <ul className='mt-3 max-w-prose list-disc space-y-2 break-words pl-5'>
              {record.retrievalQueries.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </section>
          <div className='grid min-w-0 gap-6 xl:grid-cols-2'>
            <Passages title={ui('Passages retrieved')} passages={record.retrieved} />
            <Passages title={ui('Passages cited')} passages={record.cited} />
          </div>
          <section className='rp-card space-y-3 p-3 sm:p-5' aria-labelledby='verification'>
            <h2 id='verification' className='rp-display text-xl'>
              {ui('Verification and generation')}
            </h2>
            <p>
              {ui('Citations dropped')}: {record.verification.citationsDropped} ·{' '}
              {ui('Sentences dropped')}: {record.verification.sentencesDropped}
            </p>
            <p>
              {ui('Verification')}:{' '}
              {record.verification.outcome === 'checked' ? ui('Checked') : ui('Not reported')}
            </p>
            <p className='break-words'>
              {ui('Model')}: {record.generation.modelId ?? ui('Not reported by provider')}
            </p>
            <p className='break-words'>
              {ui('Configurations')}:{' '}
              {record.generation.configurationIds.join(', ') || ui('Not reported')}
            </p>
            <p>{ui('Duration')}: {record.timing.durationMs} ms</p>
            <details>
              <summary className='rp-btn rp-btn-outline w-fit'>
                {ui('Quality, timing and verification details')}
              </summary>
              <pre className='mt-3 whitespace-pre-wrap break-all text-sm'>{JSON.stringify({ verification: record.verification, generation: record.generation, quality: record.quality, timing: record.timing }, null, 2)}</pre>
            </details>
          </section>
          <section className='rp-card space-y-3 p-3 sm:p-5' aria-labelledby='record-stores'>
            <h2 id='record-stores' className='rp-display text-xl'>
              {ui('Stores and peers called')}
            </h2>
            {record.calls.map((call, index) => (
              <p key={index} className='break-words'>
                {call.source}
                {call.storeId ? ` / ${call.storeId}` : ''} · {call.operation} · {call.status} ·{' '}
                {call.durationMs} ms
              </p>
            ))}
            {!record.calls.length && <p>{ui('No source calls were reported.')}</p>}
          </section>
        </>
      )}
      <section className='rp-card space-y-3 p-3 sm:p-5' aria-labelledby='range-export'>
        <h2 id='range-export' className='rp-display text-xl'>{ui('Export a date range')}</h2>
        <p className='text-sm text-ink-2'>
          {ui('Dates include the whole day in UTC. Exports contain personal data.')}
        </p>
        <div className='flex flex-wrap items-end gap-3'>
          <label className='min-w-0'>
            {ui('From')}
            <input
              type='date'
              className='rp-input mt-1 block w-full text-sm'
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className='min-w-0'>
            {ui('To')}
            <input
              type='date'
              className='rp-input mt-1 block w-full text-sm'
              value={to}
              min={from || undefined}
              aria-invalid={invalidRange}
              aria-describedby={invalidRange ? 'answer-record-range-error' : undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            type='button'
            className='rp-btn rp-btn-outline'
            disabled={busy || !from || !to || from > to}
            onClick={() => void download('json', true)}
          >
            {ui('Export range JSON')}
          </button>
          <button
            type='button'
            className='rp-btn rp-btn-outline'
            disabled={busy || !from || !to || from > to}
            onClick={() => void download('csv', true)}
          >
            {ui('Export range CSV')}
          </button>
        </div>
        {invalidRange && (
          <p
            id='answer-record-range-error'
            role='alert'
            className='rounded-[var(--rp-radius)] border border-[var(--rp-bad-line)] bg-[var(--rp-bad-bg)] p-3 text-[var(--rp-bad-ink)]'
          >
            {ui('The end date must be on or after the start date.')}
          </p>
        )}
      </section>
      <section className='rp-card space-y-3 p-3 sm:p-5' aria-labelledby='record-retention'>
        <h2 id='record-retention' className='rp-display text-xl'>{ui('Retention')}</h2>
        <p>
          {retentionDays === null ? ui('Not reported') : (
            <>
              {ui('Records expire after')} {retentionDays}{' '}
              {ui('days. The default is 90 days; portal administrators can choose 1 to 365 days.')}
            </>
          )}
        </p>
        {retentionDays !== null && access.can('behaviour.write', { kind: 'portal', slug }) && (
          <form
            className='flex flex-wrap items-end gap-3'
            onSubmit={(event) => {
              event.preventDefault()
              void saveRetention()
            }}
          >
            <label className='min-w-0 max-w-full'>
              {ui('Days to retain answer records')}
              <input
                type='number'
                min='1'
                max='365'
                required
                className='rp-input mt-1 block min-w-0 w-full text-sm'
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </label>
            <button className='rp-btn rp-btn-outline' disabled={busy} type='submit'>
              {ui('Save retention')}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}

function Passages({ title, passages }: { title: string; passages: AnswerRecordPassage[] }) {
  const { ui } = usePortalLocale()
  return (
    <section className='rp-card min-w-0 space-y-4 p-3 sm:p-5' aria-label={title}>
      <h2 className='rp-display text-xl'>{title} ({passages.length})</h2>
      {!passages.length && <p className='text-ink-2'>{ui('No passages were reported.')}</p>}
      {passages.map((p, i) => (
        <article key={i} className='min-w-0 space-y-2 border-t border-[var(--rp-line)] pt-3'>
          <h3 className='break-words font-semibold'>
            {p.citationIndex ? `[${p.citationIndex}] ` : ''}
            {p.title}
          </h3>
          <p className='break-words text-sm text-ink-2'>
            <span className='break-all'>{p.resourceId}</span> · {ui('Page')}:{' '}
            {p.page ?? ui('Unknown')} · {ui('Score')}: {p.score ?? ui('Unknown')} ({p.scoreScope})
          </p>
          <p className='max-w-prose whitespace-pre-wrap break-words text-sm'>
            {p.text || ui('Passage text was not reported.')}
          </p>
        </article>
      ))}
    </section>
  )
}
