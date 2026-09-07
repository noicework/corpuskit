/**
 * The Extraction Lab admin panel: profile a document, compare extraction
 * methods against a sandbox knowledge box, and set the routing rules that
 * decide which method a new upload gets.
 *
 * Admin-only surface documented in docs/EXTRACTION-LAB.md. Serves: R26, P4-10.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  CatalogItem,
  ExtractionClass,
  ExtractionMethod,
  ExtractionProfile,
  ExtractionRules,
} from '@research-portal/core'
import {
  compareExtraction,
  type ExtractionCompareEvent,
  type ExtractionMetrics,
  getCatalog,
  getExtractionMethods,
  getResource,
  profileExtraction,
  saveExtractionRules,
} from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * The Extraction Lab (docs/EXTRACTION-LAB.md): profile a document, compare
 * extraction methods in the sandbox box, and set the routing rules. Tokens
 * only - every colour, radius and control comes from the appearance system.
 */
export function ExtractionPanel({ slug, passcode }: { slug: string; passcode: string }) {
  const { data: lab, refetch: refetchLab } = useQuery({
    queryKey: ['extraction-methods', slug],
    queryFn: () => getExtractionMethods(slug, passcode),
  })
  return (
    <div className='space-y-4'>
      <MethodsCard lab={lab} />
      <CompareCard
        slug={slug}
        passcode={passcode}
        methods={lab?.methods ?? []}
        available={lab?.available ?? false}
      />
      <RulesCard
        slug={slug}
        passcode={passcode}
        methods={lab?.methods ?? []}
        rules={lab?.rules ?? null}
        onSaved={() => void refetchLab()}
      />
    </div>
  )
}

const CLASSES: { id: ExtractionClass; label: string; hint: string }[] = [
  { id: 'prose', label: 'Prose', hint: 'Born-digital text with a clean text layer' },
  { id: 'tables', label: 'Table-dense', hint: 'More than eight tabular rows per page' },
  { id: 'garbled-text', label: 'Garbled text', hint: 'A text layer that is bad OCR' },
  { id: 'image-only', label: 'Image-only', hint: 'No usable text layer: scans, figures' },
  { id: 'long-scan', label: 'Long scan', hint: 'Image-only and over 60 pages' },
]

function kindLabel(kind: ExtractionMethod['kind']): string {
  return kind === 'tables'
    ? 'Table-aware'
    : kind === 'visual'
    ? 'Visual (vision model)'
    : 'Platform default'
}

type LabInfo = Awaited<ReturnType<typeof getExtractionMethods>>

function MethodsCard({ lab }: { lab: LabInfo | undefined }) {
  return (
    <div className='rp-card p-5'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-ink'>Extraction methods on the sandbox</h3>
          <p className='mt-1 text-xs text-ink-3'>
            Custom methods are registered on a scratch knowledge box{lab ? ` (${lab.lab})` : ''}
            {' '}
            and applied per upload. The production box is never touched.
          </p>
        </div>
        {lab
          ? (
            <span className={`rp-badge ${lab.available ? 'rp-badge-ok' : 'rp-badge-warn'}`}>
              {lab.available ? 'sandbox ready' : 'sandbox unavailable'}
            </span>
          )
          : null}
      </div>
      {lab && !lab.available
        ? (
          <p className='mt-3 text-xs text-[var(--rp-bad-ink)]'>
            {lab.message ?? 'Bind a lab box (ARAG_KB_<SLUG>_LAB) to enable the lab.'}
          </p>
        )
        : null}
      {lab && lab.methods.length > 0
        ? (
          <ul className='mt-3 grid gap-2 sm:grid-cols-3'>
            {lab.methods.map((m) => (
              <li
                key={m.id}
                className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'
              >
                <p className='text-sm font-medium text-ink'>{m.name}</p>
                <p className='text-xs text-ink-3'>
                  {kindLabel(m.kind)}
                  {m.model ? ` · ${m.model}` : ''}
                </p>
                {m.rules?.length
                  ? <p className='mt-1 line-clamp-2 text-[11px] text-ink-3'>{m.rules[0]}</p>
                  : null}
              </li>
            ))}
          </ul>
        )
        : null}
      {lab && !lab.poppler
        ? (
          <p className='mt-3 text-xs text-ink-3'>
            Poppler is not on this host: profiles fall back to the platform's extracted text.
          </p>
        )
        : null}
    </div>
  )
}

interface MethodResult {
  method: ExtractionMethod
  metrics: ExtractionMetrics
  textPreview: string
  ask?: { question: string; answer: string; citations: number }
}

function CompareCard(
  { slug, passcode, methods, available }: {
    slug: string
    passcode: string
    methods: ExtractionMethod[]
    available: boolean
  },
) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<CatalogItem | null>(null)
  const [profile, setProfile] = useState<{ profile: ExtractionProfile; filename: string } | null>(
    null,
  )
  const [selected, setSelected] = useState<string[]>([])
  const [question, setQuestion] = useState('')
  const [stage, setStage] = useState<string | null>(null)
  const [results, setResults] = useState<MethodResult[]>([])
  const [done, setDone] = useState<
    {
      recommended: string | null
      reason: string
      purged: number
      yields: Record<string, number>
    } | null
  >(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (selected.length === 0 && methods.length > 0) setSelected(methods.map((m) => m.id))
  }, [methods, selected.length])
  const looksLikeId = /^[0-9a-f]{32}$/i.test(query.trim())
  const { data: matches } = useQuery({
    queryKey: ['lab-pick', slug, query],
    queryFn: () => getCatalog(slug, { query, pageSize: 8 }),
    enabled: query.trim().length >= 3 && !looksLikeId,
  })
  // Supplements and media are folded into their article in the library
  // listing, so a pasted resource id reaches them directly.
  const { data: byId } = useQuery({
    queryKey: ['lab-pick-id', slug, query],
    queryFn: () => getResource(slug, query.trim()),
    enabled: looksLikeId,
    retry: false,
  })
  const candidates: CatalogItem[] = looksLikeId
    ? (byId
      ? [{ id: byId.id, title: byId.title, status: 'processed', topicIds: byId.topicIds }]
      : [])
    : (matches?.items ?? [])
  const visionPages =
    profile && selected.some((id) => methods.find((m) => m.id === id)?.kind === 'visual')
      ? profile.profile.pages
      : 0

  async function onProfile(item: CatalogItem) {
    setPicked(item)
    setProfile(null)
    setResults([])
    setDone(null)
    setMessage(null)
    try {
      setProfile(await profileExtraction(slug, passcode, item.id))
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not profile the document.') })
    }
  }

  async function onRun() {
    if (!picked || selected.length === 0) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setResults([])
    setDone(null)
    setMessage(null)
    try {
      await compareExtraction(slug, passcode, {
        resourceId: picked.id,
        methods: selected,
        ...(question.trim() ? { question: question.trim() } : {}),
      }, (event: ExtractionCompareEvent) => {
        if (event.type === 'stage') setStage(event.label)
        else if (event.type === 'profile') {
          setProfile({ profile: event.profile, filename: event.filename })
        } else if (event.type === 'method') {
          setResults((prev) => [
            ...prev.filter((r) => r.method.id !== event.method.id),
            { method: event.method, metrics: event.metrics, textPreview: event.textPreview },
          ])
        } else if (event.type === 'ask') {
          setResults((prev) =>
            prev.map((r) =>
              r.method.id === event.method.id
                ? {
                  ...r,
                  ask: {
                    question: event.question,
                    answer: event.answer,
                    citations: event.citations,
                  },
                }
                : r
            )
          )
        } else if (event.type === 'error') {
          setMessage({
            tone: 'error',
            text: event.method ? `${event.method}: ${event.message}` : event.message,
          })
        } else if (event.type === 'done') {
          setDone({
            recommended: event.recommended,
            reason: event.reason,
            purged: event.purged,
            yields: event.yields,
          })
          setStage(null)
        }
      }, controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) {
        setMessage({ tone: 'error', text: errorMessage(err, 'The comparison failed.') })
      }
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  const ordered = [...results].sort((a, b) =>
    methods.findIndex((m) => m.id === a.method.id) - methods.findIndex((m) => m.id === b.method.id)
  )
  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Profile and compare</h3>
      <p className='mt-1 text-xs text-ink-3'>
        Pick a document from the library, profile it, then run it through the methods and compare
        the text, tables, a judge's score and the same question asked of each extraction.
      </p>
      <div className='mt-3 flex flex-col gap-2 sm:flex-row'>
        <input
          type='search'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Find a document by title, or paste a resource id…'
          className='rp-input h-9 flex-1'
          aria-label='Find a document'
        />
      </div>
      {candidates.length > 0 && !picked
        ? (
          <ul className='mt-2 divide-y divide-line rounded-[var(--rp-radius)] border border-line'>
            {candidates.map((item) => (
              <li key={item.id}>
                <button
                  type='button'
                  onClick={() => void onProfile(item)}
                  className='rp-focus block w-full px-3 py-2 text-left text-sm text-ink-2 hover:bg-[var(--rp-wash)]'
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        )
        : null}
      {picked
        ? (
          <div className='mt-3 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'>
            <div className='flex flex-wrap items-start justify-between gap-2'>
              <p className='text-sm font-medium text-ink'>{picked.title}</p>
              <button
                type='button'
                onClick={() => {
                  setPicked(null)
                  setProfile(null)
                  setResults([])
                  setDone(null)
                }}
                className='text-xs text-ink-3 hover:text-ink'
              >
                Change
              </button>
            </div>
            {profile
              ? <ProfileCard profile={profile.profile} filename={profile.filename} />
              : <p className='mt-2 text-xs text-ink-3'>Profiling…</p>}
          </div>
        )
        : null}
      {picked && profile
        ? (
          <div className='mt-3 space-y-3'>
            <fieldset className='flex flex-wrap gap-3'>
              <legend className='rp-eyebrow text-ink-3'>Methods</legend>
              {methods.map((m) => (
                <label key={m.id} className='flex items-center gap-2 text-sm text-ink-2'>
                  <input
                    type='checkbox'
                    checked={selected.includes(m.id)}
                    onChange={() =>
                      setSelected((prev) =>
                        prev.includes(m.id)
                          ? prev.filter((x) =>
                            x !== m.id
                          )
                          : [...prev, m.id]
                      )}
                    className='h-4 w-4 rounded-[var(--rp-radius-input)] border-line'
                    style={{ accentColor: 'var(--rp-accent)' }}
                  />
                  {m.name} <span className='text-xs text-ink-3'>({kindLabel(m.kind)})</span>
                </label>
              ))}
            </fieldset>
            <input
              type='text'
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder='Question to ask of each extraction (optional; defaults to the main result and its numbers)'
              className='rp-input h-9 w-full'
              aria-label='Question for the before and after ask'
            />
            <div className='flex flex-wrap items-center gap-3'>
              <button
                type='button'
                disabled={busy || !available || selected.length === 0}
                onClick={() => void onRun()}
                className='rp-btn rp-btn-primary'
              >
                {busy ? 'Running…' : 'Run comparison'}
              </button>
              {visionPages > 0
                ? (
                  <span className='text-xs text-ink-3'>
                    Vision will read {visionPages} page{visionPages === 1 ? '' : 's'}.
                  </span>
                )
                : null}
              {stage ? <span className='text-xs text-ink-3' role='status'>{stage}…</span> : null}
            </div>
          </div>
        )
        : null}
      {message && <MessagePanel message={message} className='mt-3' />}
      {ordered.length > 0
        ? (
          <div className='mt-4 grid gap-3 lg:grid-cols-3'>
            {ordered.map((r) => (
              <ResultColumn
                key={r.method.id}
                result={r}
                yieldVsDefault={done?.yields[r.method.id] ?? r.metrics.yieldVsDefault}
                recommended={done?.recommended === r.method.name}
              />
            ))}
          </div>
        )
        : null}
      {done
        ? (
          <p className='mt-3 text-xs text-ink-3'>
            {done.recommended
              ? (
                <>
                  <span className='font-medium text-ink-2'>
                    Recommended for this document: {done.recommended}.
                  </span>{' '}
                  {done.reason}
                </>
              )
              : done.reason} Sandbox copies purged: {done.purged}.
          </p>
        )
        : null}
    </div>
  )
}

function ProfileCard({ profile, filename }: { profile: ExtractionProfile; filename: string }) {
  const cls = CLASSES.find((c) => c.id === profile.class)
  const cells: [string, string][] = [
    ['Pages', String(profile.pages)],
    ['Chars / page', String(profile.charsPerPage)],
    ['Fonts', String(profile.fonts)],
    ['Image-only pages', String(profile.imageOnlyPages)],
    ['Table rows / page', String(profile.tableRowsPerPage)],
    ['Word plausibility', `${Math.round(profile.dictionaryHitRate * 100)}%`],
    ['Size', `${(profile.bytes / 1e6).toFixed(1)} MB`],
    ['Profiled by', profile.source],
  ]
  return (
    <div className='mt-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='rp-badge'>{cls?.label ?? profile.class}</span>
        <span className='text-xs text-ink-3'>{cls?.hint}</span>
      </div>
      <dl className='mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4'>
        {cells.map(([k, v]) => (
          <div key={k}>
            <dt className='text-ink-3'>{k}</dt>
            <dd className='tabular-nums text-ink-2'>{v}</dd>
          </div>
        ))}
      </dl>
      <p className='mt-1 truncate text-[11px] text-ink-3'>{filename}</p>
    </div>
  )
}

function ResultColumn(
  { result, yieldVsDefault, recommended }: {
    result: MethodResult
    yieldVsDefault: number | null
    recommended: boolean
  },
) {
  const m = result.metrics
  return (
    <div
      className={`min-w-0 rounded-[var(--rp-radius)] border p-3 ${
        recommended ? 'border-[var(--rp-accent)] bg-[var(--rp-wash)]' : 'border-line bg-surface-2'
      }`}
    >
      <div className='flex items-start justify-between gap-2'>
        <div>
          <p className='text-sm font-medium text-ink'>{result.method.name}</p>
          <p className='text-xs text-ink-3'>{kindLabel(result.method.kind)}</p>
        </div>
        {recommended ? <span className='rp-badge rp-badge-ok'>recommended</span> : null}
      </div>
      <dl className='mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs'>
        <dt className='text-ink-3'>Judge score</dt>
        <dd className='tabular-nums text-ink-2'>
          {m.judgeScore === null ? 'n/a' : `${m.judgeScore} / 5`}
        </dd>
        <dt className='text-ink-3'>Chars / page</dt>
        <dd className='tabular-nums text-ink-2'>
          {m.charsPerPage}
          {yieldVsDefault !== null && yieldVsDefault !== 1 ? ` (${yieldVsDefault}× default)` : ''}
        </dd>
        <dt className='text-ink-3'>Table rows</dt>
        <dd className='tabular-nums text-ink-2'>{m.tableRows}</dd>
        <dt className='text-ink-3'>Paragraphs</dt>
        <dd className='tabular-nums text-ink-2'>{m.paragraphs}</dd>
        <dt className='text-ink-3'>Word plausibility</dt>
        <dd className='tabular-nums text-ink-2'>{Math.round(m.dictionaryHitRate * 100)}%</dd>
        <dt className='text-ink-3'>Time</dt>
        <dd className='tabular-nums text-ink-2'>
          {m.latencySec} s
          {m.visionPages ? ` · ${m.visionPages} vision page${m.visionPages === 1 ? '' : 's'}` : ''}
        </dd>
      </dl>
      {m.judgeReason ? <p className='mt-2 text-[11px] italic text-ink-3'>{m.judgeReason}</p> : null}
      <details className='mt-2'>
        <summary className='cursor-pointer text-xs text-[var(--rp-accent-fg)]'>
          Extracted text
        </summary>
        <pre className='rp-scroll mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-[var(--rp-radius)] bg-surface p-2 text-[11px] leading-snug text-ink-2'>
          {result.textPreview}
        </pre>
      </details>
      {result.ask
        ? (
          <div className='mt-2 border-t border-line pt-2'>
            <p className='rp-eyebrow text-ink-3'>
              Answer · {result.ask.citations} citation{result.ask.citations === 1 ? '' : 's'}
            </p>
            <p className='mt-1 line-clamp-6 text-xs leading-relaxed text-ink-2'>
              {result.ask.answer}
            </p>
          </div>
        )
        : null}
    </div>
  )
}

function RulesCard(
  { slug, passcode, methods, rules, onSaved }: {
    slug: string
    passcode: string
    methods: ExtractionMethod[]
    rules: ExtractionRules | null
    onSaved: () => void
  },
) {
  const [draft, setDraft] = useState<ExtractionRules>({
    default: 'default',
    rules: [],
    visualPageCap: 60,
  })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  useEffect(() => {
    if (!loaded && (rules || methods.length > 0)) {
      if (rules) setDraft(rules)
      else {
        const tables = methods.find((m) => m.kind === 'tables')?.id
        const visual = methods.find((m) => m.kind === 'visual')?.id
        setDraft({
          default: 'default',
          rules: [
            ...(tables ? [{ when: 'tables' as const, method: tables }] : []),
            ...(visual
              ? [
                { when: 'image-only' as const, method: visual },
                { when: 'garbled-text' as const, method: visual },
              ]
              : []),
            { when: 'long-scan' as const, method: 'default' },
          ],
          visualPageCap: 60,
        })
      }
      setLoaded(true)
    }
  }, [rules, methods, loaded])
  const methodFor = (cls: ExtractionClass) =>
    draft.rules.find((r) => r.when === cls)?.method ?? draft.default
  const setFor = (cls: ExtractionClass, method: string) =>
    setDraft((d) => ({
      ...d,
      rules: [...d.rules.filter((r) => r.when !== cls), { when: cls, method }],
    }))
  async function onSave() {
    setBusy(true)
    setMessage(null)
    try {
      await saveExtractionRules(slug, passcode, draft)
      setMessage({
        tone: 'ok',
        text: 'Routing rules saved. New uploads through the portal and the loader follow them.',
      })
      onSaved()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save the rules.') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Routing rules</h3>
      <p className='mt-1 text-xs text-ink-3'>
        Which method each class of document gets. The visual page cap sends long scans to the
        default method regardless.
      </p>
      <table className='mt-3 w-full text-left text-xs'>
        <thead className='text-ink-3'>
          <tr>
            <th className='py-1.5 pr-3 font-medium'>Profile class</th>
            <th className='py-1.5 font-medium'>Method</th>
          </tr>
        </thead>
        <tbody>
          {CLASSES.map((cls) => (
            <tr key={cls.id} className='border-t border-line'>
              <td className='py-2 pr-3'>
                <span className='font-medium text-ink'>{cls.label}</span>
                <span className='block text-ink-3'>{cls.hint}</span>
              </td>
              <td className='py-2'>
                <select
                  value={methodFor(cls.id)}
                  onChange={(e) => setFor(cls.id, e.target.value)}
                  className='rp-input py-1 text-sm'
                >
                  {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className='mt-3 flex flex-wrap items-center gap-3'>
        <label className='flex items-center gap-2 text-xs text-ink-2'>
          Visual page cap
          <input
            type='number'
            min={1}
            value={draft.visualPageCap ?? 60}
            onChange={(e) =>
              setDraft((d) => ({ ...d, visualPageCap: Math.max(1, Number(e.target.value) || 60) }))}
            className='rp-input w-20 py-1 text-sm'
          />
        </label>
        <button
          type='button'
          disabled={busy}
          onClick={() => void onSave()}
          className='rp-btn rp-btn-primary'
        >
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      </div>
      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}
