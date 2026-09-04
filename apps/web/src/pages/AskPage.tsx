import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AskEvent, AskStage, Citation, ScoredResource } from '@research-portal/core'
import {
  addWatch,
  deleteServerSession,
  getFollowUpQuestions,
  getServerSession,
  getSourceVerdicts,
  getSubqueries,
  getSuggestedQuestions,
  listServerSessions,
  putServerSession,
  sendAnswerFeedback,
  streamAsk,
} from '../api/client.ts'
import { AnswerMarkdown } from '../components/AnswerMarkdown.tsx'
import { citationHref, ContextJourney, EvidenceDisclosure } from '../components/AnswerStream.tsx'
import { CurrencyNote } from '../components/CurrencyNote.tsx'
import {
  type EvidenceSource,
  evidenceSummary,
  EvidenceTable,
  type EvidenceVerdictInfo,
} from '../components/EvidenceTable.tsx'
import { PipelinePanel } from '../components/PipelinePanel.tsx'
import { AnswerQualityDisclosure, type QualityScores } from '../components/QualityGauge.tsx'
import { LiveStatus } from '../components/ui.tsx'
import { useCompactViewport } from '../components/useViewMode.ts'
import { isThinlyGrounded } from '../lib/confidence.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'
import {
  type StageStatuses,
  StageTimeline,
  statusesFor,
  useAnswerPhase,
} from '../components/StageTimeline.tsx'

// ---------------------------------------------------------------------------
// Local types + localStorage persistence
// ---------------------------------------------------------------------------

type ChatMessage = {
  id: string
  author: 'USER' | 'AGENT'
  text: string
  citations: Citation[]
  sources: ScoredResource[]
  usage?: {
    inputTokens: number
    outputTokens: number
    firstChunkSec?: number
    totalSec?: number
  }
  quality?: QualityScores
  error?: string
  pending?: boolean
  /** How the platform interpreted/rephrased the question (first turn only). */
  interpretedQuery?: string
  /** Platform learning id for this answer - target for feedback. */
  learningId?: string
  feedbackGood?: boolean
  feedbackSubmitted?: boolean
  /** Sub-questions the platform researched alongside this (deep research mode). */
  subqueries?: string[]
  /** Set once the self-heal "re-answer deeply" suggestion has been actioned. */
  healDismissed?: boolean
  /** Marks an answer produced by re-asking a thinly-grounded answer deeply. */
  deepBadge?: boolean
  /** True when this answer already used full-document (deep) grounding. */
  wasDeep?: boolean
  /** True when the corpus could not answer and guidance was shown instead of a real answer. */
  refused?: boolean
  /** Per-source AI relevance verdicts, once judged - persisted so the Evidence table doesn't re-judge on reload. */
  verdicts?: Record<string, EvidenceVerdictInfo>
}

type ChatSession = {
  id: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** User-set name, overriding the auto-title derived from the first question. */
  title?: string
}

const SESSION_CAP = 20

function storageKey(slug: string): string {
  return `rp-chat-${slug}`
}

/**
 * Defensively parses a legacy/malformed `quality` field: older sessions were
 * saved before `quality` existed on `ChatMessage` at all, so anything that
 * isn't a well-shaped `{ number|null, number|null, number|null }` object
 * falls back to `undefined` rather than throwing or leaving bad data around
 * for `TrustSignals` to trip over.
 */
function migrateQuality(raw: unknown): QualityScores | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<QualityScores>
  const isScoreOrNull = (v: unknown): v is number | null => v === null || typeof v === 'number'
  if (
    !isScoreOrNull(value.answerRelevance) || !isScoreOrNull(value.groundedness) ||
    !isScoreOrNull(value.contextRelevance)
  ) {
    return undefined
  }
  return {
    answerRelevance: value.answerRelevance,
    groundedness: value.groundedness,
    contextRelevance: value.contextRelevance,
  }
}

/**
 * Defensively rebuilds a message from localStorage: older sessions were
 * saved before `sources` (and later `quality`) existed on `ChatMessage`, so
 * any missing/malformed field falls back to an empty array/undefined rather
 * than throwing or leaving bad data around for later code to trip over.
 */
function migrateMessage(raw: unknown): ChatMessage {
  const message = raw as Partial<ChatMessage> | null | undefined
  return {
    id: typeof message?.id === 'string' ? message.id : makeId(),
    author: message?.author === 'USER' ? 'USER' : 'AGENT',
    text: typeof message?.text === 'string' ? message.text : '',
    citations: Array.isArray(message?.citations) ? message.citations : [],
    sources: Array.isArray(message?.sources) ? message.sources : [],
    usage: message?.usage,
    quality: migrateQuality(message?.quality),
    error: typeof message?.error === 'string' ? message.error : undefined,
    pending: false,
    interpretedQuery: typeof message?.interpretedQuery === 'string'
      ? message.interpretedQuery
      : undefined,
    learningId: typeof message?.learningId === 'string' ? message.learningId : undefined,
    feedbackGood: typeof message?.feedbackGood === 'boolean' ? message.feedbackGood : undefined,
    feedbackSubmitted: typeof message?.feedbackSubmitted === 'boolean'
      ? message.feedbackSubmitted
      : undefined,
    subqueries: Array.isArray(message?.subqueries)
      ? message.subqueries.filter((item): item is string => typeof item === 'string')
      : undefined,
    healDismissed: typeof message?.healDismissed === 'boolean' ? message.healDismissed : undefined,
    deepBadge: typeof message?.deepBadge === 'boolean' ? message.deepBadge : undefined,
    wasDeep: typeof message?.wasDeep === 'boolean' ? message.wasDeep : undefined,
    refused: typeof message?.refused === 'boolean' ? message.refused : undefined,
    verdicts: message?.verdicts && typeof message.verdicts === 'object'
      ? message.verdicts as Record<string, EvidenceVerdictInfo>
      : undefined,
  }
}

function migrateSession(raw: unknown): ChatSession | null {
  const session = raw as Partial<ChatSession> | null | undefined
  if (!session || typeof session.id !== 'string') return null
  return {
    id: session.id,
    createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now(),
    updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
    messages: Array.isArray(session.messages) ? session.messages.map(migrateMessage) : [],
    title: typeof session.title === 'string' && session.title.trim().length > 0
      ? session.title
      : undefined,
  }
}

function loadSessions(slug: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(storageKey(slug))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(migrateSession)
      .filter((session): session is ChatSession => session !== null)
  } catch {
    return []
  }
}

function saveSessions(slug: string, sessions: ChatSession[], deletedIds?: Set<string>) {
  try {
    // Merge with what is currently stored: another tab may have added or
    // updated sessions since this tab mounted. In-memory wins for ids we
    // hold; stored-only ids are kept unless this tab deleted them.
    const stored = loadSessions(slug)
    const mine = new Map(sessions.map((s) => [s.id, s]))
    const merged = [
      ...sessions,
      ...stored.filter((s) => !mine.has(s.id) && !(deletedIds?.has(s.id))),
    ]
    merged.sort((a, b) => b.updatedAt - a.updatedAt)
    localStorage.setItem(storageKey(slug), JSON.stringify(merged.slice(0, SESSION_CAP)))
  } catch {
    // localStorage unavailable or full - sessions simply won't persist this run.
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function relativeAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function sessionTitle(session: ChatSession): string {
  if (session.title && session.title.trim().length > 0) return session.title
  const first = session.messages.find((message) => message.author === 'USER')
  if (!first || first.text.trim().length === 0) return 'New conversation'
  return first.text.length > 60 ? `${first.text.slice(0, 60)}…` : first.text
}

// ---------------------------------------------------------------------------
// Answer rendering: block structure comes from the shared AnswerMarkdown
// component; the inline pass here adds **bold** spans and linked citation
// markers on top of it.
// ---------------------------------------------------------------------------

/**
 * Replaces `[n]` markers in a plain-text run with superscript, accent-
 * coloured links to the matching citation's deep link. Run AFTER other
 * inline parsing (bold) has already split the text into nodes, so this only
 * ever sees plain text segments - never markup.
 */
function renderCitationMarkers(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
  keyPrefix: string,
): ReactNode[] {
  const segments = text.split(/(\[\d+\])/g)
  return segments.map((segment, index) => {
    const match = /^\[(\d+)\]$/.exec(segment)
    const citationIndex = match?.[1] ? Number(match[1]) : null
    const citation = citationIndex === null
      ? undefined
      : citations.find((item) => item.index === citationIndex)

    if (citation) {
      const matchedPassage = sources.find((source) => source.id === citation.resourceId)
        ?.matchedPassage
      return (
        <sup key={`${keyPrefix}-${index}`}>
          <Link
            to={citationHref(slug, citation.resourceId, matchedPassage)}
            className='font-semibold no-underline'
            style={{ color: 'var(--rp-accent)' }}
            title={`Source ${citationIndex} - ${citation.title}; click to open, or find it in the Evidence table below`}
          >
            [{citationIndex}]
          </Link>
        </sup>
      )
    }
    return <span key={`${keyPrefix}-${index}`}>{segment}</span>
  })
}

function renderInline(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
  keyPrefix: string,
): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.flatMap((part, index): ReactNode[] =>
    part.startsWith('**') && part.endsWith('**')
      ? [<strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>]
      : renderCitationMarkers(part, citations, sources, slug, `${keyPrefix}-${index}`)
  )
}

function renderMarkdown(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
): ReactNode {
  return (
    <AnswerMarkdown
      text={text}
      renderInline={(run, keyPrefix) => renderInline(run, citations, sources, slug, keyPrefix)}
    />
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  function startEdit(session: ChatSession) {
    setEditingId(session.id)
    setDraftTitle(sessionTitle(session))
  }

  function commitEdit() {
    const trimmed = draftTitle.trim()
    if (editingId && trimmed.length > 0) onRename(editingId, trimmed)
    setEditingId(null)
  }

  return (
    <div className='flex h-full flex-col'>
      <button
        type='button'
        onClick={onNew}
        className='rp-btn rp-btn-primary w-full'
      >
        + New session
      </button>

      <nav
        aria-label='Chat sessions'
        className='rp-scroll mt-4 flex-1 space-y-1.5 overflow-y-auto pr-1'
      >
        {sessions.length === 0
          ? <p className='px-1 py-2 text-xs text-ink-3'>No sessions yet.</p>
          : sessions.map((session) => {
            const isActive = session.id === activeSessionId
            const isEditing = editingId === session.id
            if (isEditing) {
              return (
                <form
                  key={session.id}
                  onSubmit={(event) => {
                    event.preventDefault()
                    commitEdit()
                  }}
                  className='px-1 py-1'
                >
                  <input
                    type='text'
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    aria-label='Session name'
                    autoFocus
                    className='rp-input h-9 text-sm'
                  />
                </form>
              )
            }
            return (
              <div key={session.id} className='group relative'>
                <button
                  type='button'
                  onClick={() => onSelect(session.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className={`w-full rounded-[var(--rp-radius)] px-3 py-2.5 ${
                    isActive ? 'pr-14' : 'pr-8'
                  } text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    isActive ? 'bg-surface shadow-sm' : 'hover:bg-[var(--rp-surface-2)]'
                  }`}
                  style={{ outlineColor: 'var(--rp-accent)' }}
                >
                  <p className='rp-clamp-2 text-sm font-medium text-ink'>
                    {sessionTitle(session)}
                  </p>
                  <p className='mt-0.5 text-xs text-ink-3'>
                    {session.messages.length}{' '}
                    {session.messages.length === 1 ? 'message' : 'messages'}
                    {' · '}
                    {relativeAge(session.updatedAt)}
                  </p>
                </button>
                {isActive
                  ? (
                    <button
                      type='button'
                      onClick={(event) => {
                        event.stopPropagation()
                        startEdit(session)
                      }}
                      aria-label={`Rename "${sessionTitle(session)}"`}
                      title='Rename session'
                      className='rp-focus absolute right-8 top-1.5 flex h-6 w-6 items-center justify-center rounded-none text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-[var(--rp-surface-2)] hover:text-ink group-hover:opacity-100 focus-visible:opacity-100'
                    >
                      ✎
                    </button>
                  )
                  : null}
                <button
                  type='button'
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(session.id)
                  }}
                  aria-label={`Delete "${sessionTitle(session)}"`}
                  title='Delete session'
                  className='rp-focus absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-[var(--rp-radius-btn)] text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-bad-ink)] group-hover:opacity-100 focus-visible:opacity-100'
                >
                  <svg
                    viewBox='0 0 20 20'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.7'
                    strokeLinecap='round'
                    aria-hidden='true'
                    className='h-4 w-4'
                  >
                    <path d='M5.5 5.5l9 9M14.5 5.5l-9 9' />
                  </svg>
                </button>
              </div>
            )
          })}
      </nav>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function UserBubble({
  message,
  onAskSubquery,
}: {
  message: ChatMessage
  onAskSubquery: (subquery: string) => void
}) {
  return (
    <div className='flex flex-col items-end gap-1.5'>
      <div
        className='max-w-[85%] rounded-[calc(var(--rp-radius)+4px)] rounded-tr-sm px-4 py-3 text-sm leading-relaxed text-ink sm:max-w-[70%]'
        style={{ backgroundColor: 'var(--rp-wash)' }}
      >
        {message.text}
      </div>
      {message.subqueries && message.subqueries.length > 0
        ? (
          <div className='flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[70%]'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-ink-3'>
              Searched for
            </p>
            <div className='flex flex-wrap justify-end gap-1.5'>
              {message.subqueries.map((subquery, index) => (
                <button
                  key={index}
                  type='button'
                  onClick={() => onAskSubquery(subquery)}
                  className='rp-chip text-[11px]'
                >
                  {subquery}
                </button>
              ))}
            </div>
          </div>
        )
        : null}
    </div>
  )
}

/**
 * Small ghost thumbs-up/thumbs-down pair for the platform's learning loop.
 * Hidden entirely when the message has no `learningId` (nothing to attach
 * feedback to). Once either button is used the row collapses to a quiet
 * "thanks" line; a negative rating additionally offers a one-line detail
 * field that re-posts the same feedback with free text attached.
 */
function FeedbackControl({
  message,
  onFeedback,
}: {
  message: ChatMessage
  onFeedback: (good: boolean, text?: string) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState('')
  const [detailSent, setDetailSent] = useState(false)

  if (!message.learningId) return null

  async function handleRate(good: boolean) {
    setError(null)
    setBusy(true)
    const ok = await onFeedback(good)
    setBusy(false)
    if (!ok) setError('Could not send feedback - try again.')
  }

  async function handleDetailSend() {
    if (detail.trim().length === 0) return
    setError(null)
    setBusy(true)
    const ok = await onFeedback(false, detail.trim())
    setBusy(false)
    if (ok) setDetailSent(true)
    else setError('Could not send feedback - try again.')
  }

  if (message.feedbackSubmitted) {
    return (
      <div className='flex flex-col items-start gap-1.5'>
        <p className='text-xs text-ink-3'>Thanks - feedback sent to the platform.</p>
        {message.feedbackGood === false && !detailSent
          ? (
            <div className='flex items-center gap-1.5'>
              <input
                type='text'
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                placeholder='What was wrong? (optional)'
                disabled={busy}
                className='rp-input h-7 w-48 text-xs'
              />
              <button
                type='button'
                onClick={handleDetailSend}
                disabled={busy || detail.trim().length === 0}
                className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
              >
                Send
              </button>
            </div>
          )
          : null}
        {error ? <p className='text-xs text-[var(--rp-bad-ink)]'>{error}</p> : null}
      </div>
    )
  }

  return (
    <div className='flex items-center gap-0.5'>
      <ActionIcon
        label='Helpful answer'
        onClick={() => handleRate(true)}
        disabled={busy}
        path={ICON_THUMB_UP}
      />
      <ActionIcon
        label='Not a helpful answer'
        onClick={() => handleRate(false)}
        disabled={busy}
        path={ICON_THUMB_DOWN}
      />
      {error ? <p className='text-xs text-[var(--rp-bad-ink)]'>{error}</p> : null}
    </div>
  )
}

/**
 * Icon-only action used across the answer footer row. Colour lives in classes
 * rather than an inline style: an inline colour beats any hover rule, which is
 * why these buttons previously had no hover state at all.
 */
function ActionIcon(
  { label, onClick, disabled, active, path, filled }: {
    label: string
    onClick: () => void
    disabled?: boolean
    active?: boolean
    path: string
    filled?: boolean
  },
) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`rp-focus flex h-9 w-9 items-center justify-center rounded-none transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 ${
        active
          ? 'text-[var(--rp-accent)] bg-[color-mix(in_srgb,var(--rp-accent)_12%,transparent)]'
          : 'text-ink-3 hover:bg-surface-2 hover:text-ink'
      }`}
    >
      <svg
        viewBox='0 0 24 24'
        fill={filled ? 'currentColor' : 'none'}
        stroke='currentColor'
        strokeWidth='1.7'
        strokeLinecap='round'
        strokeLinejoin='round'
        className='h-[1.15rem] w-[1.15rem]'
        aria-hidden='true'
      >
        <path d={path} />
      </svg>
    </button>
  )
}

const ICON_THUMB_UP =
  'M7 10.5v9H4.5a1 1 0 01-1-1v-7a1 1 0 011-1H7zm0 0l4-7a2 2 0 012 2v3h4.6a2 2 0 011.96 2.44l-1.3 6A2 2 0 0116.3 19.5H7'
const ICON_THUMB_DOWN =
  'M17 13.5v-9h2.5a1 1 0 011 1v7a1 1 0 01-1 1H17zm0 0l-4 7a2 2 0 01-2-2v-3H6.4a2 2 0 01-1.96-2.44l1.3-6A2 2 0 017.7 4.5H17'
const ICON_RETRY = 'M4.5 9.5a8 8 0 1113 8M4.5 4.5v5h5'
const ICON_COPY = 'M9 9h9.5v9.5H9zM6 15H4.5V4.5H15V6'
const ICON_WATCH =
  'M12 5c-5 0-8 4.6-8.6 6.4a1.8 1.8 0 000 1.2C4 14.4 7 19 12 19s8-4.6 8.6-6.4a1.8 1.8 0 000-1.2C20 9.6 17 5 12 5z M12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z'

/** Copies the answer text, confirming in place rather than with a toast. */
function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be refused; the button simply does not confirm.
    }
  }

  if (text.trim().length === 0) return null
  return (
    <ActionIcon
      label={copied ? 'Answer copied' : 'Copy the answer'}
      onClick={() => void copy()}
      active={copied}
      path={copied ? 'M5 12.5l4.5 4.5L19 7.5' : ICON_COPY}
    />
  )
}

/**
 * Saves the question behind an answer as a watch so the tenant sees a
 * "changed" badge in Search when new results turn up for it later. Purely
 * local UI state - a page reload simply lets the user watch it again.
 */
function WatchControl({ question, slug }: { question: string; slug: string }) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')

  if (question.trim().length === 0) return null

  async function handleWatch() {
    setStatus('busy')
    try {
      await addWatch(slug, question)
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <p className='text-xs text-ink-3'>
        Watching - you will see a change badge in Search when results change.
      </p>
    )
  }

  return (
    <div className='flex items-center gap-1.5'>
      <ActionIcon
        label={status === 'busy' ? 'Saving the watch' : 'Watch this question'}
        onClick={handleWatch}
        disabled={status === 'busy'}
        path={ICON_WATCH}
      />
      {status === 'error'
        ? <p className='text-xs text-[var(--rp-bad-ink)]'>Could not save the watch - try again.</p>
        : null}
    </div>
  )
}

/** Cap on how many sources get an AI verdict in one judge call - keeps it fast. */
const MAX_JUDGED = 8

/**
 * One treatment for the whole life of an answer.
 *
 * The card used to be bare padding while it streamed and then gain a border, a
 * fill, a shadow AND a different padding the instant the sources and quality
 * signals landed, so a finished answer visibly snapped into a box under a
 * reader who was still reading it. Nothing about the container changes now -
 * same box, same padding, start to finish - and the parts that arrive at the
 * end fade up into it instead (see `rp-answer-tail` in styles.css).
 *
 * Borderless rather than always-bordered because that is the treatment asked
 * for: the answer is the page's main content, and a chat transcript does not
 * need a card drawn around every turn to be legible. The user bubble opposite
 * it carries the only fill in the thread, which is what makes the two sides
 * readable at a glance.
 */
const ANSWER_CARD = 'py-1'

/**
 * The order the late arrivals fade up in. They are staggered rather than
 * simultaneous so the eye is led down the block - answer, then how much to
 * trust it, then what to do with it, then where it came from - and each index
 * is fixed, so a message missing one of them does not reshuffle the rest.
 */
const TAIL_QUALITY = 0
const TAIL_NOTICE = 1
const TAIL_ACTIONS = 2
const TAIL_SOURCES = 3

/** `--rp-stage-i` is the stagger index the timeline and the tail both ride on. */
function tailStyle(index: number): CSSProperties {
  return { '--rp-stage-i': index } as CSSProperties
}

function AnswerCard({
  message,
  slug,
  question,
  subqueries,
  stageStatuses,
  onRetry,
  onFeedback,
  onReanswerDeeply,
  onAskSubquery,
  onVerdicts,
}: {
  message: ChatMessage
  slug: string
  question: string
  subqueries: string[]
  stageStatuses?: StageStatuses
  onRetry: () => void
  onFeedback: (good: boolean, text?: string) => Promise<boolean>
  onReanswerDeeply: () => void
  onAskSubquery: (subquery: string) => void
  onVerdicts: (verdicts: Record<string, EvidenceVerdictInfo>) => void
}) {
  const [showPipeline, setShowPipeline] = useState(false)
  // The sources/evidence block is collapsed by default and this state is
  // per-message (it lives in the card, not the page), so opening one answer's
  // evidence never opens another's. The reader chooses to open it, rather than
  // every answer unfurling a wall of raw passages on arrival.
  const [showEvidence, setShowEvidence] = useState(false)
  // Per-source AI relevance judgement is token-costing, so it does NOT run on
  // every answer. It runs once, lazily, when the reader opens "Journey through
  // the context"; the results fill the evidence table's verdict column and
  // persist onto the message so a reload never re-judges.
  const [judging, setJudging] = useState(false)

  async function requestVerdicts() {
    if (judging) return
    if (message.verdicts && Object.keys(message.verdicts).length > 0) return
    const candidates = message.sources
      .filter((source) => (source.matchedPassage ?? '').trim().length > 0)
      .slice(0, MAX_JUDGED)
    if (candidates.length === 0) return
    setJudging(true)
    try {
      const result = await getSourceVerdicts(
        slug,
        question,
        candidates.map((source) => ({
          id: source.id,
          title: source.title,
          passage: (source.matchedPassage ?? '').trim(),
        })),
      )
      const next: Record<string, EvidenceVerdictInfo> = {}
      for (const item of result.verdicts) {
        next[item.id] = { verdict: item.verdict, relevance: item.relevance }
      }
      onVerdicts(next)
    } catch {
      // Judging is advisory - a failure just leaves the table without verdicts.
    } finally {
      setJudging(false)
    }
  }

  // Must sit above every early return in this component: a hook after a
  // conditional return changes the hook count between renders (React #310).
  const phase = useAnswerPhase(message.text.length > 0, true)

  if (message.error && !message.text.trim()) {
    return (
      <div
        className='rounded-[calc(var(--rp-radius)+4px)] border p-3 sm:p-5'
        style={{ borderColor: 'var(--rp-bad-line)', background: 'var(--rp-bad-bg)' }}
      >
        <p className='text-sm font-medium text-[var(--rp-bad-ink)]'>Something went wrong</p>
        <p className='mt-1 text-sm text-[var(--rp-bad-ink)]'>{message.error}</p>
        <button type='button' onClick={onRetry} className='rp-btn rp-btn-danger mt-3'>
          Retry
        </button>
      </div>
    )
  }

  // Offer the deep re-answer whenever an answer is genuinely thinly grounded -
  // the SAME low-confidence signal that paints the red banner (isThinlyGrounded
  // delegates to assessConfidence), so a low-confidence answer always carries
  // the offer and a healthy one never does. Gate on the message state too: not
  // while streaming, not once dismissed, and not on an answer that was already
  // deep (nothing deeper to escalate to).
  const groundedness = message.quality?.groundedness
  const offerDeepReanswer = !message.pending && !message.healDismissed && !message.wasDeep &&
    !message.deepBadge && isThinlyGrounded(message.quality)
  const isSparselyGrounded = !message.pending && groundedness !== null &&
    groundedness !== undefined &&
    groundedness <= 2

  const evidenceSources: EvidenceSource[] = message.sources.map((source) => ({
    id: source.id,
    title: source.title,
    passage: source.matchedPassage,
    score: source.relevance,
    matchedPage: source.matchedPage,
    referenceChunk: source.referenceChunk,
    published: source.published,
    sourceName: source.sourceName,
  }))

  // What the collapsed evidence panel says about itself: enough to decide
  // whether to open it ("7 sources · 3 cited · 1980-2010") without unfurling a
  // wall of raw passages under every answer.
  const citedSourceCount = message.sources.length > 0
    ? message.sources.filter((source) =>
      message.citations.some((citation) => citation.resourceId === source.id)
    ).length
    : message.citations.length

  // A refusal gets its own structured "no evidence" state instead of the
  // normal answer body - the guidance sentence the platform generated, what
  // WAS retrieved (unjudged, so the user sees raw scores rather than another
  // AI opinion), and next actions rather than a dead end.
  if (!message.pending && message.refused) {
    return (
      <div className={ANSWER_CARD}>
        <div className='mb-2 rp-answer-tail' style={tailStyle(TAIL_QUALITY)}>
          <span className='rp-badge rp-badge-quiet'>No direct evidence found</span>
        </div>

        {message.text.length > 0
          ? renderMarkdown(message.text, message.citations, message.sources, slug)
          : null}

        {evidenceSources.length > 0
          ? (
            <div
              className='rp-answer-tail mt-4 border-t border-line pt-3'
              style={tailStyle(TAIL_SOURCES)}
            >
              <EvidenceTable
                slug={slug}
                question={question}
                sources={evidenceSources}
                title='the closest passages retrieved'
                anchorPrefix={message.id}
              />
            </div>
          )
          : null}

        <div
          className='rp-answer-tail mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3'
          style={tailStyle(TAIL_ACTIONS)}
        >
          <WatchControl question={question} slug={slug} />
        </div>

        {subqueries.length > 0
          ? (
            <div className='mt-3 flex flex-wrap gap-1.5'>
              {subqueries.map((subquery, index) => (
                <button
                  key={index}
                  type='button'
                  onClick={() => onAskSubquery(subquery)}
                  className='rp-chip text-[11px]'
                >
                  {subquery}
                </button>
              ))}
            </div>
          )
          : null}
      </div>
    )
  }

  return (
    <div className={ANSWER_CARD}>
      {
        /* Gated on deepBadge alone. It used to render on `interpretedQuery`
        * too, and interpretedQuery draws nothing here - so an `interpreted`
        * event arriving mid-stream mounted an empty row and pushed the answer
        * the reader was reading 8px down the page. deepBadge is known before
        * the first token, so this row's height never changes after mount. */
      }
      {message.deepBadge
        ? (
          <div className='mb-2 flex flex-wrap items-center gap-2'>
            <span className='rp-badge rp-badge-quiet'>Deep re-answer</span>
          </div>
        )
        : null}

      {phase !== 'answer' && message.pending
        ? <StageTimeline statuses={stageStatuses ?? {}} exiting={phase === 'handoff'} />
        : message.text.length > 0
        ? (
          <div className='rp-answer-in'>
            {renderMarkdown(message.text, message.citations, message.sources, slug)}
          </div>
        )
        : null}

      {
        /* The confidence headline, the REMi mini-meters and the thin-grounding
          offer used to stack here as three full-width blocks. On a phone that
          was most of a screen of chrome after every answer, so they now live
          together behind one control on the actions row below - a control that
          stays loud and labelled while the news is bad, so folding them away
          never softens a poorly grounded answer. See AnswerQualityDisclosure. */
      }

      {message.error && message.text.trim()
        ? (
          <div
            className='rp-answer-tail mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--rp-radius)] border p-3'
            style={{
              ...tailStyle(TAIL_NOTICE),
              borderColor: 'var(--rp-bad-line)',
              background: 'var(--rp-bad-bg)',
            }}
          >
            <p className='text-xs text-[var(--rp-bad-ink)]'>
              The answer was cut short - {message.error}
            </p>
            <button
              type='button'
              onClick={onRetry}
              className='rp-btn rp-btn-outline h-7 shrink-0 px-2 text-xs'
            >
              Retry
            </button>
          </div>
        )
        : null}

      {
        /* Answer-level actions. The quality control leads the right-hand group:
          it is the one thing here that describes the answer rather than acting
          on it, and on the loud states it grows a label leftwards into the row's
          own empty middle, which is exactly where there is room for it. */
      }
      {
        /* Gated on `!message.pending` alone now, where it used to also require a
          learningId or a question. The quality control lives on this row, and it
          has to appear on every finished answer - an answer with neither of
          those would otherwise lose its confidence signal altogether. The
          controls that need a question or a learningId hide themselves. */
      }
      {!message.pending
        ? (
          <div
            className='rp-answer-tail mt-3 flex flex-wrap items-center justify-between gap-3'
            style={tailStyle(TAIL_ACTIONS)}
          >
            <FeedbackControl message={message} onFeedback={onFeedback} />
            <div className='ml-auto flex items-center gap-0.5'>
              <AnswerQualityDisclosure
                quality={message.quality}
                {...(offerDeepReanswer ? { onReanswerDeeply } : {})}
                sparselyGrounded={isSparselyGrounded && evidenceSources.length > 0}
              />
              <CopyAnswer text={message.text} />
              {question.trim().length > 0
                ? (
                  <ActionIcon
                    label='Ask this again'
                    onClick={() => onAskSubquery?.(question)}
                    path={ICON_RETRY}
                  />
                )
                : null}
              <WatchControl question={question} slug={slug} />
            </div>
          </div>
        )
        : null}

      {
        /* Sources and evidence - collapsed by default, opened on the reader's
          choice. Collapsed it still states its case ("7 sources · 3 cited ·
          1980-2010") so the reader can decide without unfurling a wall of raw
          passages under every answer; the prose and its inline [n] markers stay
          fully visible either way. Opened, it is grouped into clear sections
          (sources, the evidence table, then the journey/pipeline tools) so the
          panel stays navigable - and the evidence table opens with it rather
          than asking for a second click on the same evidence. */
      }
      {!message.pending && (message.sources.length > 0 || message.citations.length > 0)
        ? (
          <div
            className='rp-answer-tail mt-4 border-t border-line pt-3'
            style={tailStyle(TAIL_SOURCES)}
          >
            <EvidenceDisclosure
              regionId={`${message.id}-evidence`}
              open={showEvidence}
              onToggle={() => setShowEvidence((prev) => !prev)}
              label='retrieved sources'
              summary={evidenceSummary(evidenceSources, citedSourceCount)}
            >
              <div className='space-y-5'>
                {message.citations.length > 0
                  ? (
                    <div>
                      {
                        /* No "Sources: n" heading - the disclosure summary
                        * immediately above already reports "n cited", and on a
                        * phone every restated line costs a row of screen. */
                      }
                      <div className='flex flex-wrap gap-1.5'>
                        {message.citations.map((citation) => {
                          const matchedPassage = message.sources.find((source) =>
                            source.id === citation.resourceId
                          )?.matchedPassage
                          return (
                            <Link
                              key={citation.index}
                              to={citationHref(slug, citation.resourceId, matchedPassage)}
                              title={citation.title}
                              className='rp-chip'
                            >
                              <span
                                className='inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-white'
                                style={{ backgroundColor: 'var(--rp-accent)' }}
                              >
                                {citation.index}
                              </span>
                              <span className='min-w-0 truncate sm:max-w-[14rem]'>
                                {citation.title}
                              </span>
                            </Link>
                          )
                        })}
                      </div>
                      <CurrencyNote
                        className='mt-3'
                        sources={message.sources.filter((source) =>
                          message.citations.some((citation) => citation.resourceId === source.id)
                        )}
                      />
                    </div>
                  )
                  : null}

                {evidenceSources.length > 0
                  ? (
                    <EvidenceTable
                      slug={slug}
                      question={question}
                      sources={evidenceSources}
                      verdicts={message.verdicts}
                      judging={judging}
                      citations={message.citations}
                      anchorPrefix={message.id}
                      collapsible={false}
                    />
                  )
                  : null}

                {message.sources.length > 0 || message.usage
                  ? (
                    <div className='flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3'>
                      {message.sources.length > 0
                        ? (
                          <ContextJourney
                            slug={slug}
                            sources={message.sources}
                            query={question}
                            onOpen={requestVerdicts}
                          />
                        )
                        : null}
                      {message.sources.length > 0 || message.usage || message.quality
                        ? (
                          <button
                            type='button'
                            onClick={() => setShowPipeline((prev) => !prev)}
                            aria-expanded={showPipeline}
                            aria-controls={`${message.id}-pipeline`}
                            className='rp-focus flex items-center gap-1.5 rounded-none text-xs font-medium text-ink-3 hover:text-ink'
                          >
                            <svg
                              viewBox='0 0 20 20'
                              fill='none'
                              stroke='currentColor'
                              strokeWidth='1.7'
                              strokeLinecap='round'
                              strokeLinejoin='round'
                              aria-hidden='true'
                              className={`h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
                                showPipeline ? 'rotate-90' : ''
                              }`}
                            >
                              <path d='M7 4l6 6-6 6' />
                            </svg>
                            {showPipeline ? 'Hide the pipeline' : 'Show the pipeline'}
                          </button>
                        )
                        : null}
                      {message.usage
                        ? (
                          <p className='text-xs text-ink-3'>
                            {message.usage.inputTokens} in / {message.usage.outputTokens} out tokens
                          </p>
                        )
                        : null}
                    </div>
                  )
                  : null}

                <div id={`${message.id}-pipeline`} hidden={!showPipeline}>
                  {showPipeline
                    ? (
                      <PipelinePanel
                        sources={message.sources}
                        usage={message.usage}
                        quality={message.quality}
                      />
                    )
                    : null}
                </div>
              </div>
            </EvidenceDisclosure>
          </div>
        )
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export - a standalone Word-compatible .doc of the current research trail.
// Mirrors the export idiom in GeneratePage.tsx (a self-contained HTML shell
// with the Word-namespaced <head>), rebuilt locally here since GeneratePage
// doesn't export its helpers.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function slugOrDate(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return slug.length > 0 ? slug.slice(0, 60) : new Date().toISOString().slice(0, 10)
}

function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? 'n/a' : `${score}/5`
}

/**
 * Renders the research trail as clean semantic HTML: one heading per
 * question, the answer text below it, a bracketed citation list of source
 * titles, and the REMi quality line when the platform scored the answer.
 */
function sessionToWordHtml(portalName: string, title: string, messages: ChatMessage[]): string {
  const dateLine = new Date().toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const turnsHtml = messages
    .map((message) => {
      if (message.author === 'USER') {
        return `<h2>${escapeHtml(message.text)}</h2>`
      }
      if (message.error) {
        return `<p><em>Answer unavailable - ${escapeHtml(message.error)}</em></p>`
      }
      const answerHtml = message.text
        .split(/\n{2,}/)
        .filter((block) => block.trim().length > 0)
        .map((block) => `<p>${escapeHtml(block.trim())}</p>`)
        .join('')
      const citationsHtml = message.citations.length > 0
        ? `<p>[${message.citations.map((citation) => escapeHtml(citation.title)).join('; ')}]</p>`
        : ''
      const qualityHtml = message.quality
        ? `<p><em>Answer relevance ${
          formatScore(message.quality.answerRelevance)
        } &middot; Groundedness ${
          formatScore(message.quality.groundedness)
        } &middot; Context relevance ${formatScore(message.quality.contextRelevance)}</em></p>`
        : ''
      return `${answerHtml}${citationsHtml}${qualityHtml}`
    })
    .join('')

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.5; }
h1, h2 { font-family: Arial, Helvetica, sans-serif; color: #111111; }
h1 { font-size: 20pt; margin-bottom: 4pt; }
h2 { font-size: 13pt; margin-top: 18pt; margin-bottom: 6pt; }
p { margin: 6pt 0; font-size: 11pt; }
</style>
</head>
<body>
<h1>${escapeHtml(portalName)}</h1>
<p>${escapeHtml(title)} &middot; ${escapeHtml(dateLine)}</p>
${turnsHtml}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AskPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions(config.slug))
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeStage, setActiveStage] = useState<AskStage | null>(null)
  const [seenStages, setSeenStages] = useState<Set<AskStage>>(() => new Set())
  const stageStatuses = statusesFor(activeStage, seenStages)
  const [showSidebar, setShowSidebar] = useState(false)
  const [deepResearch, setDeepResearch] = useState(false)
  /**
   * Follow-ups for ONE answer - the newest. They are about where this answer
   * leaves the reader, so they belong under the answer they came from and
   * nowhere else; asking the next question clears them and starts again.
   * Null until a generation succeeds with something worth offering, so a
   * failure or an empty result renders nothing at all rather than a placeholder.
   */
  const [followUps, setFollowUps] = useState<{ messageId: string; questions: string[] } | null>(
    null,
  )
  /**
   * Whether the title/Export bar is currently translated out of the way. Only
   * ever true below `lg`; the effect that drives it resets it on the way up to
   * a wide layout so the bar can never be left hidden where it does not move.
   */
  const [subHeaderHidden, setSubHeaderHidden] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  /** In-flight follow-up generation, cancelled the moment a new ask starts. */
  const followUpAbortRef = useRef<AbortController | null>(null)
  /** Sessions deleted in THIS tab - saveSessions must not resurrect them. */
  const deletedIdsRef = useRef(new Set<string>())

  // Leaving the page cancels any in-flight answer stream, and the follow-up
  // generation that trails it.
  useEffect(() => () => {
    abortRef.current?.abort()
    followUpAbortRef.current?.abort()
  }, [])
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const sidebarDrawerRef = useRef<HTMLDivElement | null>(null)
  // Guards the `?ask=` handoff from Explore against a double-send (React 18
  // Strict Mode replays effects) and resets whenever the tenant changes.
  const askHandledRef = useRef(false)
  // Debounced per-session background sync to the server, keyed by session id.
  const syncTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const composerRef = useRef<HTMLFormElement | null>(null)
  /** The element that actually scrolls below `lg` - see the wrapper's comment. */
  const scrollWrapRef = useRef<HTMLDivElement | null>(null)
  const subHeaderRef = useRef<HTMLDivElement | null>(null)

  /**
   * Below `lg` the composer is a pinned bar and the layout is a single column;
   * from `lg` up the sessions rail is beside the thread and the composer is an
   * ordinary block. A media query rather than a resize listener, because the
   * three things it drives (the pinned bar, the dropped placeholder, the hidden
   * keyboard hint) all switch at exactly the breakpoint the CSS uses.
   */
  const [isCompact, setIsCompact] = useState(() =>
    globalThis.matchMedia?.('(max-width: 1023.98px)').matches ?? false
  )
  /**
   * Measured height of the pinned composer. The thread scrolls underneath it,
   * so the auto-scroll has to stop this far short of the bottom or the newest
   * answer lands behind the bar. Measured, never guessed: the bar grows a row
   * when the textarea wraps and shrinks when Stop replaces Send.
   */
  const [composerHeight, setComposerHeight] = useState(0)
  /**
   * How much of the bottom of the layout viewport something is covering -
   * in practice the software keyboard. iOS does not shrink the layout viewport
   * (nor `100dvh`) when the keyboard opens, so a bar anchored to the bottom of
   * the page sits behind it; `visualViewport` is the only thing that reports
   * the genuinely visible area.
   */
  const [keyboardInset, setKeyboardInset] = useState(0)
  /**
   * Below the `sm` breakpoint, where the empty state's suggestion grid is a
   * single column. Distinct from `isCompact`, which is the `lg` boundary this
   * page's whole layout turns on; this is the narrower one the `sm:` utilities
   * use, read from the shared hook so it cannot drift off Tailwind's own value.
   */
  const isNarrow = useCompactViewport()

  useEffect(() => {
    const query = globalThis.matchMedia('(max-width: 1023.98px)')
    const apply = () => setIsCompact(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    const element = composerRef.current
    if (!element) return
    const apply = () => setComposerHeight(Math.round(element.getBoundingClientRect().height))
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * Hide the title/Export bar on the way down, bring it back on the way up.
   *
   * Bound to the wrapper, not to `window`: below `lg` that is the element that
   * actually scrolls (the document itself never does - `main` is a fixed-height
   * flex column), and at `lg` and up the thread's own `section` takes over,
   * which is why this only runs while compact.
   *
   * The three details that separate this from a bar that twitches:
   *
   *  - It measures a RUN in one direction, not a raw delta. The accumulator
   *    resets the moment the direction flips, so 60px of jitter never adds up
   *    to a threshold and only a deliberate movement moves the bar.
   *  - It clamps `scrollTop` into range. iOS rubber-band reports negative
   *    positions at the top and beyond-end ones at the bottom, and a bounce
   *    reads as a direction change that would flap the bar at both extremes.
   *  - Near the top the bar is shown unconditionally, whatever the last
   *    direction was, so it is always where a reader expects to find it.
   *
   * Reveal is deliberately more eager than hide: a reader scrolling up is
   * asking for the bar.
   */
  useEffect(() => {
    if (!isCompact) {
      setSubHeaderHidden(false)
      return
    }
    const scroller = scrollWrapRef.current
    if (!scroller) return

    const HIDE_AFTER = 56
    const REVEAL_AFTER = 28
    const TOP_ZONE = 24

    const clampedTop = () => {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      return Math.min(Math.max(scroller.scrollTop, 0), max)
    }

    let lastY = clampedTop()
    let run = 0
    let direction = 0

    const onScroll = () => {
      const y = clampedTop()
      const delta = y - lastY
      lastY = y
      if (y <= TOP_ZONE) {
        run = 0
        direction = 0
        setSubHeaderHidden(false)
        return
      }
      if (delta === 0) return
      const next = delta > 0 ? 1 : -1
      if (next !== direction) {
        direction = next
        run = 0
      }
      run += Math.abs(delta)
      if (run < (next === 1 ? HIDE_AFTER : REVEAL_AFTER)) return
      run = 0
      setSubHeaderHidden(next === 1)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [isCompact])

  useEffect(() => {
    const viewport = globalThis.visualViewport
    if (!viewport) return
    const apply = () => {
      // documentElement.clientHeight, not innerHeight: on iOS innerHeight
      // tracks the layout viewport too, so the difference against the visual
      // viewport is exactly what the keyboard has taken.
      const covered = document.documentElement.clientHeight - viewport.height - viewport.offsetTop
      // Anything under a keyboard's worth is browser chrome animating (the iOS
      // URL bar collapsing), and reacting to that would make the bar twitch.
      setKeyboardInset(covered > 80 ? Math.round(covered) : 0)
    }
    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
    }
  }, [])

  const { data: suggestions } = useQuery({
    queryKey: ['suggested-questions', config.slug],
    queryFn: () => getSuggestedQuestions(config.slug),
  })

  /**
   * Fire-and-forget push of one session to the server, debounced so a burst
   * of edits (streaming deltas, renames) collapses into a single request.
   * Failures are silent - offline / server-sync-unavailable simply means the
   * localStorage copy (already saved by `persist`) stays the source of truth.
   */
  function scheduleServerSync(session: ChatSession) {
    const timers = syncTimersRef.current
    const existing = timers.get(session.id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(session.id)
      void putServerSession(config.slug, {
        id: session.id,
        title: sessionTitle(session),
        updatedAt: new Date(session.updatedAt).toISOString(),
        messages: session.messages,
      }).catch(() => {
        // Offline or server sync unavailable - the local session already
        // persisted, so the research trail still works fully offline.
      })
    }, 1500)
    timers.set(session.id, timer)
  }

  // The mobile sessions drawer is a dialog: Escape closes it, and focus
  // moves into it on open so keyboard users land in the right place.
  useEffect(() => {
    if (!showSidebar) return
    sidebarDrawerRef.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setShowSidebar(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showSidebar])

  // Re-load sessions if the tenant slug changes, then merge in any
  // server-side sessions this browser doesn't have locally yet (or that are
  // newer on the server) - background, silent-fail so offline use is
  // unaffected.
  useEffect(() => {
    const localSessions = loadSessions(config.slug)
    setSessions(localSessions)
    setActiveSessionId(null)
    setMessages([])
    setFollowUps(null)
    askHandledRef.current = false

    for (const timer of syncTimersRef.current.values()) clearTimeout(timer)
    syncTimersRef.current.clear()

    let cancelled = false
    async function syncFromServer() {
      try {
        const remoteMetas = await listServerSessions(config.slug)
        if (cancelled) return
        const toFetch = remoteMetas.filter((meta) => {
          const local = localSessions.find((session) => session.id === meta.id)
          return !local || Date.parse(meta.updatedAt) > local.updatedAt
        })
        if (toFetch.length === 0) return
        const fetched = await Promise.all(
          toFetch.map((meta) =>
            getServerSession<ChatMessage>(config.slug, meta.id).catch(() => null)
          ),
        )
        if (cancelled) return
        setSessions((prev) => {
          const byId = new Map(prev.map((session) => [session.id, session]))
          for (const remote of fetched) {
            if (!remote) continue
            const updatedAt = Date.parse(remote.updatedAt) || Date.now()
            const existing = byId.get(remote.id)
            if (existing && existing.updatedAt >= updatedAt) continue
            byId.set(remote.id, {
              id: remote.id,
              createdAt: existing?.createdAt ?? updatedAt,
              updatedAt,
              messages: remote.messages.map(migrateMessage),
              title: remote.title.trim().length > 0 ? remote.title : undefined,
            })
          }
          const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, SESSION_CAP)
          saveSessions(config.slug, merged, deletedIdsRef.current)
          return merged
        })
      } catch {
        // Offline or server sync unavailable - local sessions still work.
      }
    }
    void syncFromServer()

    return () => {
      cancelled = true
    }
  }, [config.slug])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  // Explore's hero hands a question off here via `?ask=`. Consume it once:
  // strip the param from the URL and auto-send it as a new message, but
  // never while a stream is already running - the effect simply retries on
  // the next isStreaming change since the ref isn't set until it succeeds.
  useEffect(() => {
    const ask = searchParams.get('ask')
    if (!ask || ask.trim().length === 0 || askHandledRef.current || isStreaming) return
    askHandledRef.current = true
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('ask')
        return next
      },
      { replace: true },
    )
    void send(ask)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isStreaming])

  function persist(nextMessages: ChatMessage[], sessionId: string) {
    setSessions((prev) => {
      const existing = prev.find((session) => session.id === sessionId)
      const now = Date.now()
      const updatedSession: ChatSession = existing
        ? { ...existing, messages: nextMessages, updatedAt: now }
        : { id: sessionId, createdAt: now, updatedAt: now, messages: nextMessages }
      const rest = prev.filter((session) => session.id !== sessionId)
      const next = [updatedSession, ...rest].slice(0, SESSION_CAP)
      saveSessions(config.slug, next, deletedIdsRef.current)
      scheduleServerSync(updatedSession)
      return next
    })
  }

  function startNewSession() {
    if (isStreaming) return
    setActiveSessionId(null)
    setMessages([])
    setFollowUps(null)
    setShowSidebar(false)
  }

  function deleteSession(id: string) {
    if (isStreaming) return
    deletedIdsRef.current.add(id)
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== id)
      saveSessions(config.slug, next, deletedIdsRef.current)
      return next
    })
    const timer = syncTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      syncTimersRef.current.delete(id)
    }
    void deleteServerSession(config.slug, id).catch(() => {
      // Offline or server sync unavailable - it's already gone locally.
    })
    if (activeSessionId === id) {
      setActiveSessionId(null)
      setMessages([])
      setFollowUps(null)
    }
  }

  function selectSession(id: string) {
    if (isStreaming) return
    const session = sessions.find((item) => item.id === id)
    if (!session) return
    setActiveSessionId(id)
    setMessages(session.messages.map((message) => ({ ...message, pending: false })))
    // Follow-ups belong to the answer they were generated from, and a restored
    // session's last answer was generated in another sitting.
    setFollowUps(null)
    setShowSidebar(false)
  }

  /** Sets a custom session name, overriding the auto-title, and syncs it to the server. */
  function renameSession(id: string, title: string) {
    setSessions((prev) => {
      const next = prev.map((session) => session.id === id ? { ...session, title } : session)
      saveSessions(config.slug, next, deletedIdsRef.current)
      const renamed = next.find((session) => session.id === id)
      if (renamed) scheduleServerSync(renamed)
      return next
    })
  }

  /**
   * Questions worth asking next, generated from the answer just given and the
   * passages it retrieved. Deliberately fired AFTER the stream closes and never
   * awaited by anything on the answer path: an answer must never wait on a
   * nicety. Silent on every failure - no spinner, no placeholder, no empty
   * heading - because a follow-up that is not ready is simply not offered.
   */
  async function requestFollowUps(answer: ChatMessage | undefined, question: string) {
    if (!answer || answer.pending || answer.error || answer.refused) return
    if (answer.text.trim().length === 0 || question.trim().length === 0) return
    // The retrieved passages are the only thing a follow-up may be built from,
    // so an answer that arrived without them gets no follow-ups at all.
    const passages = answer.sources
      .map((source) => ({ title: source.title, text: (source.matchedPassage ?? '').trim() }))
      .filter((passage) => passage.text.length > 0)
      .slice(0, 8)
    if (passages.length === 0) return

    const controller = new AbortController()
    followUpAbortRef.current = controller
    try {
      const result = await getFollowUpQuestions(
        config.slug,
        { question, answer: answer.text, passages },
        controller.signal,
      )
      if (controller.signal.aborted) return
      const questions = Array.isArray(result.questions) ? result.questions : []
      if (questions.length > 0) setFollowUps({ messageId: answer.id, questions })
    } catch {
      // Follow-ups are advisory - a failure leaves the answer exactly as it was.
    } finally {
      if (followUpAbortRef.current === controller) followUpAbortRef.current = null
    }
  }

  async function runAsk(
    query: string,
    baseMessages: ChatMessage[],
    sessionId: string,
    options?: { depth?: 'default' | 'deep'; prequeries?: string[]; deepBadge?: boolean },
  ) {
    // A new answer retires the last answer's follow-ups the moment it starts.
    followUpAbortRef.current?.abort()
    followUpAbortRef.current = null
    setFollowUps(null)
    const answerId = makeId()
    // baseMessages ends with the question being asked (as a USER message) - the
    // request sends that as `query`, so prior turns exclude it here.
    const contextTurns = baseMessages
      .slice(0, -1)
      .filter((message) => !message.error)
      .map((message) => ({ author: message.author, text: message.text }))

    let working: ChatMessage[] = [
      ...baseMessages,
      {
        id: answerId,
        author: 'AGENT',
        text: '',
        citations: [],
        sources: [],
        pending: true,
        deepBadge: options?.deepBadge,
        wasDeep: options?.depth === 'deep',
      },
    ]
    setMessages(working)
    setIsStreaming(true)
    setActiveStage(null)
    setSeenStages(new Set())

    const controller = new AbortController()
    abortRef.current = controller

    function update(mutate: (message: ChatMessage) => ChatMessage) {
      working = working.map((message) => message.id === answerId ? mutate(message) : message)
      setMessages(working)
    }

    try {
      await streamAsk(
        config.slug,
        { query, context: contextTurns, depth: options?.depth, prequeries: options?.prequeries },
        (event: AskEvent) => {
          switch (event.type) {
            case 'stage':
              if (event.status === 'started') {
                setActiveStage(event.stage)
              } else {
                setSeenStages((prev) => new Set(prev).add(event.stage))
              }
              break
            case 'sources':
              update((message) => ({ ...message, sources: event.resources }))
              break
            case 'delta':
              update((message) => ({ ...message, text: message.text + event.text }))
              break
            case 'citation':
              update((message) =>
                message.citations.some((citation) => citation.index === event.citation.index)
                  ? message
                  : { ...message, citations: [...message.citations, event.citation] }
              )
              break
            case 'learning':
              update((message) => ({ ...message, learningId: event.id }))
              break
            case 'interpreted':
              update((message) => ({ ...message, interpretedQuery: event.query }))
              break
            case 'searched':
              // The platform auto-decomposed the question into sub-queries it
              // researched alongside the main one - attach them to the
              // preceding USER message (immediately before this answer
              // placeholder in `working`), the same slot deep research fills
              // in before the ask even starts, so they render the same way.
              working = working.map((message, index) =>
                index === working.length - 2 && message.author === 'USER' &&
                  (!message.subqueries || message.subqueries.length === 0)
                  ? { ...message, subqueries: event.queries }
                  : message
              )
              setMessages(working)
              break
            case 'usage':
              update((message) => ({
                ...message,
                usage: {
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  firstChunkSec: event.firstChunkSec,
                  totalSec: event.totalSec,
                },
              }))
              break
            case 'quality':
              update((message) => ({
                ...message,
                quality: {
                  answerRelevance: event.answerRelevance,
                  groundedness: event.groundedness,
                  contextRelevance: event.contextRelevance,
                },
              }))
              break
            case 'done':
              update((message) => ({
                ...message,
                // event.text is the deterministically citation-bound answer
                // (the model's own [n] markers stripped and replaced with
                // markers spliced at the platform's own char-offsets) - it
                // replaces the streamed text so the final prose, the
                // evidence table badges and the click-through targets all
                // agree on what each [n] means. Falls back to the streamed
                // text when absent (e.g. a refusal, which carries no citations).
                text: event.text ?? message.text,
                pending: false,
                refused: event.refused,
              }))
              break
            case 'error':
              update((message) => ({
                ...message,
                pending: false,
                error: event.message,
              }))
              break
          }
        },
        controller.signal,
      )
    } catch (thrown) {
      if (controller.signal.aborted) {
        update((existing) =>
          existing.text.length > 0
            ? { ...existing, pending: false }
            : { ...existing, pending: false, error: 'Stopped before an answer arrived.' }
        )
      } else {
        const message = thrown instanceof Error
          ? thrown.message
          : 'We could not complete this answer - try again.'
        update((existing) => ({ ...existing, pending: false, error: message }))
      }
    } finally {
      setIsStreaming(false)
      setActiveStage(null)
      setSeenStages(new Set())
      abortRef.current = null
      persist(working, sessionId)
      // After the answer, never during it - and never after a Stop, which is
      // the reader saying they have finished with this question.
      if (!controller.signal.aborted) {
        void requestFollowUps(working.find((message) => message.id === answerId), query)
      }
    }
  }

  async function send(query: string) {
    const trimmed = query.trim()
    if (trimmed.length === 0 || isStreaming) return

    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)

    const userMessage: ChatMessage = {
      id: makeId(),
      author: 'USER',
      text: trimmed,
      citations: [],
      sources: [],
    }
    let baseMessages = [...messages, userMessage]
    setMessages(baseMessages)
    setDraft('')

    if (deepResearch) {
      // Map the research space first: a few seconds of structured generation
      // that returns the sub-questions to research alongside the main one.
      // An empty result or a failed call just falls through to a normal deep
      // ask (depth only, no prequeries) - deep research never blocks on this.
      setIsStreaming(true)
      setActiveStage('retrieval')
      // Stop must work during this phase too - give it a controller before
      // the sub-question call, and bail out if the user aborted meanwhile.
      const mappingController = new AbortController()
      abortRef.current = mappingController
      let subqueries: string[] = []
      try {
        const result = await getSubqueries(config.slug, trimmed)
        subqueries = Array.isArray(result.questions) ? result.questions : []
      } catch {
        subqueries = []
      }
      if (mappingController.signal.aborted) {
        setIsStreaming(false)
        setActiveStage(null)
        setSeenStages(new Set())
        return
      }
      if (subqueries.length > 0) {
        baseMessages = baseMessages.map((message) =>
          message.id === userMessage.id ? { ...message, subqueries } : message
        )
        setMessages(baseMessages)
      }
      void runAsk(trimmed, baseMessages, sessionId, { depth: 'deep', prequeries: subqueries })
    } else {
      void runAsk(trimmed, baseMessages, sessionId)
    }
  }

  function retry(forMessageId: string) {
    // Find the user message immediately preceding the failed answer message.
    const index = messages.findIndex((message) => message.id === forMessageId)
    if (index <= 0) return
    const userMessage = messages[index - 1]
    if (!userMessage || userMessage.author !== 'USER') return
    const baseMessages = messages.slice(0, index)
    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)
    setMessages(baseMessages)
    void runAsk(userMessage.text, baseMessages, sessionId)
  }

  /**
   * Self-heal: re-asks the same question as a new turn with `depth: 'deep'`
   * grounding, badged so it's clear it's a deliberate deep re-answer. Marks
   * the thinly-grounded original so its suggestion bar doesn't offer again.
   */
  function reanswerDeeply(question: string, forMessageId: string) {
    if (isStreaming) return
    const marked = messages.map((message) =>
      message.id === forMessageId ? { ...message, healDismissed: true } : message
    )
    const userMessage: ChatMessage = {
      id: makeId(),
      author: 'USER',
      text: question,
      citations: [],
      sources: [],
    }
    const baseMessages = [...marked, userMessage]
    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)
    setMessages(baseMessages)
    void runAsk(question, baseMessages, sessionId, { depth: 'deep', deepBadge: true })
  }

  /**
   * Posts feedback for the platform's learning loop and, on success, marks
   * the message so the UI collapses to a quiet "thanks" state. Returns
   * whether it succeeded so the (per-message) control can show its own
   * unobtrusive error text on failure without crashing anything.
   */
  async function sendFeedback(messageId: string, good: boolean, text?: string): Promise<boolean> {
    const message = messages.find((item) => item.id === messageId)
    const sessionId = activeSessionId
    if (!message?.learningId || !sessionId) return false
    try {
      await sendAnswerFeedback(config.slug, { learningId: message.learningId, good, text })
      setMessages((prev) => {
        const next = prev.map((item) =>
          item.id === messageId ? { ...item, feedbackGood: good, feedbackSubmitted: true } : item
        )
        persist(next, sessionId)
        return next
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Persists per-source AI verdicts onto a message once the Evidence table's
   * one-off judge call resolves, so reopening the session doesn't re-judge.
   */
  function saveVerdicts(messageId: string, verdicts: Record<string, EvidenceVerdictInfo>) {
    const sessionId = activeSessionId
    if (!sessionId) return
    setMessages((prev) => {
      const next = prev.map((item) => item.id === messageId ? { ...item, verdicts } : item)
      persist(next, sessionId)
      return next
    })
  }

  function stop() {
    abortRef.current?.abort()
  }

  /** The active session's display title - a custom rename if set, else the auto-title. */
  function currentSessionTitle(): string {
    const active = sessions.find((session) => session.id === activeSessionId)
    return sessionTitle({
      id: '',
      createdAt: 0,
      updatedAt: 0,
      messages,
      title: active?.title,
    })
  }

  /** Downloads the current research trail as a Word-compatible .doc. */
  function exportSession() {
    const title = currentSessionTitle()
    const html = sessionToWordHtml(config.branding.productName, title, messages)
    const blob = new Blob(['﻿', html], { type: 'application/msword' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${slugOrDate(title)}.doc`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(draft)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  const isEmpty = messages.length === 0
  const lastMessage = messages[messages.length - 1]
  const liveMessage = isStreaming
    ? 'Answer in progress'
    : lastMessage?.author === 'AGENT' && !lastMessage.pending
    ? 'Answer complete'
    : ''

  return (
    <main
      aria-label='Ask'
      className='mx-auto flex h-[calc(100dvh-var(--rp-header-h,126px))] max-w-[100rem] flex-col gap-3 px-4 pt-4 pb-0 sm:px-6 sm:pt-6 lg:flex-row lg:gap-6 lg:pb-6 2xl:gap-8'
    >
      <aside
        aria-label='Chat sessions'
        className='hidden w-64 shrink-0 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-3 lg:flex 2xl:w-72'
      >
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={selectSession}
          onNew={startNewSession}
          onDelete={deleteSession}
          onRename={renameSession}
        />
      </aside>

      {showSidebar
        ? (
          <div
            role='dialog'
            aria-modal='true'
            aria-label='Sessions'
            className='fixed inset-0 z-40 flex lg:hidden'
          >
            <button
              type='button'
              aria-label='Close sessions'
              onClick={() => setShowSidebar(false)}
              className='flex-1 bg-black/30'
            />
            <div
              ref={sidebarDrawerRef}
              tabIndex={-1}
              className='h-full w-72 max-w-[80vw] bg-surface-2 p-3 shadow-xl'
            >
              <SessionList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={selectSession}
                onNew={startNewSession}
                onDelete={deleteSession}
                onRename={renameSession}
              />
            </div>
          </div>
        )
        : null}

      {
        /* min-h-0 is load-bearing on a phone. Stacked as a column, this item's
        * automatic minimum size is its content height, so a long answer grew
        * the column past the viewport-height `main`, took the whole document
        * scrollbar with it and carried the composer off the bottom of the
        * screen. From `lg` up the row axis constrained it and the bug never
        * showed. */
      }
      <div className='flex w-full min-w-0 min-h-0 flex-1 flex-col'>
        <LiveStatus message={liveMessage} />

        {
          /* Below `lg` this wrapper is the scroll container and the composer
          * sticks to its bottom edge, so the thread runs underneath the bar
          * instead of stopping above it. From `lg` up the wrapper is inert and
          * the thread keeps its own scrollbar exactly as before. */
        }
        <div
          ref={scrollWrapRef}
          className='rp-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:overflow-visible'
        >
          {
            /* The title and Export bar. It lives INSIDE the scroll container
            * rather than above it so that below `lg` it can be `sticky` and
            * slide out of the way on the way down: an element that only sits
            * above the scrollport reserves its row whatever you do to it, so
            * translating it there would buy the reader nothing. Sticky, it
            * overlays the thread, and translating it out hands that band back.
            *
            * Only below `lg`. On a wide screen this bar costs a small, constant
            * slice of a tall viewport, a mouse wheel flips direction far more
            * often than a thumb does, and a header that comes and going while
            * you read is worse than the space it returns. From `lg` up it is
            * `static`, untransformed and transparent - exactly what it was.
            *
            * Opaque below `lg` because the thread now passes underneath it. */
          }
          {!isEmpty
            ? (
              <div
                ref={subHeaderRef}
                onFocusCapture={() => setSubHeaderHidden(false)}
                style={isCompact && subHeaderHidden
                  ? { transform: 'translateY(-100%)' }
                  : undefined}
                className='sticky top-0 z-20 mb-6 flex shrink-0 items-center justify-between gap-4 bg-[var(--rp-app)] pb-2 transition-transform duration-300 ease-out motion-reduce:transition-none lg:static lg:bg-transparent lg:pb-0'
              >
                <h1 className='rp-display min-w-0 truncate text-xl text-ink sm:text-2xl'>
                  {currentSessionTitle()}
                </h1>
                <button
                  type='button'
                  onClick={exportSession}
                  className='rp-btn rp-btn-outline shrink-0 gap-2'
                >
                  <svg
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.7'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    className='h-4 w-4'
                    aria-hidden='true'
                  >
                    <path d='M12 4v11m0 0l-4-4m4 4l4-4M5 19h14' />
                  </svg>
                  Export
                </button>
              </div>
            )
            : null}

          <section
            aria-label='Conversation'
            className='rp-scroll flex-1 pb-4 lg:overflow-y-auto'
          >
            {isEmpty
              ? (
                <div className='space-y-4 pt-6 sm:pt-10'>
                  <div className='mx-auto max-w-2xl text-center'>
                    <h1 className='rp-display text-3xl text-ink sm:text-4xl'>Ask</h1>
                    <p className='mt-2 text-sm leading-relaxed text-ink-2 sm:text-base'>
                      Ask a question and get an answer grounded in this portal's research.
                    </p>
                  </div>
                  {suggestions && suggestions.length > 0
                    ? (
                      <div className='pt-3'>
                        {
                          /* Chips on a phone, where a grid of cards would stack into
                          * a wall; proper cards from sm up. */
                        }
                        {
                          /* Four on a phone, six from `sm` up. Six single-column
                          * cards fill a 390px screen outright, so the page opens
                          * as a wall of questions with the composer's own
                          * controls pushed to the very bottom edge; from `sm` the
                          * grid is two columns and six is three tidy rows.
                          *
                          * Sliced, not rendered-and-hidden: a `hidden` card stays
                          * in the accessibility tree and in the tab order, which
                          * is a keyboard trap - and `hidden` on an element
                          * carrying a component class would not have hidden it
                          * anyway, since those set their own `display` later in
                          * the stylesheet. */
                        }
                        <div className='mt-4 grid gap-2.5 sm:grid-cols-2'>
                          {suggestions.slice(0, isNarrow ? 4 : 6).map((question) => (
                            <button
                              key={question.id}
                              type='button'
                              onClick={() => void send(question.text)}
                              className='rp-suggest-card'
                            >
                              <span className='rp-suggest-text'>{question.text}</span>
                              <span aria-hidden='true' className='rp-suggest-arrow'>&rarr;</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                    : null}
                </div>
              )
              : (
                /* Answers hold a readable measure however wide the pane is -
                 * full-width prose on a large display is what the house rules
                 * call the anti-pattern. */
                <div className='max-w-[75ch] space-y-4'>
                  {messages.map((message, index) =>
                    message.author === 'USER'
                      ? (
                        <UserBubble
                          key={message.id}
                          message={message}
                          onAskSubquery={(subquery) => void send(subquery)}
                        />
                      )
                      : (
                        <AnswerCard
                          key={message.id}
                          message={message}
                          slug={config.slug}
                          question={messages[index - 1]?.author === 'USER'
                            ? messages[index - 1]?.text ?? ''
                            : ''}
                          subqueries={messages[index - 1]?.author === 'USER'
                            ? messages[index - 1]?.subqueries ?? []
                            : []}
                          stageStatuses={index === messages.length - 1 ? stageStatuses : undefined}
                          onRetry={() => retry(message.id)}
                          onFeedback={(good, text) => sendFeedback(message.id, good, text)}
                          onReanswerDeeply={() =>
                            reanswerDeeply(
                              messages[index - 1]?.author === 'USER'
                                ? messages[index - 1]?.text ?? ''
                                : '',
                              message.id,
                            )}
                          onAskSubquery={(subquery) => void send(subquery)}
                          onVerdicts={(verdicts) => saveVerdicts(message.id, verdicts)}
                        />
                      )
                  )}
                  {
                    /* Where this answer leaves you. Generated from the answer and the
              * passages behind it, not from the portal's generic openers, so
              * they continue the conversation rather than restarting it; each
              * one is proved answerable from the corpus server-side before it
              * is offered. They arrive after the answer and fade up in place -
              * nothing is reserved for them, so an answer with no follow-ups
              * looks exactly as it did before this existed.
              *
              * Above the scroll anchor, so the anchor's composer-height scroll
              * margin still clears the pinned bar on a phone with these
              * present. */
                  }
                  {followUps && followUps.messageId === lastMessage?.id && !isStreaming
                    ? (
                      <div
                        className='pt-1'
                        role='group'
                        aria-labelledby={`${followUps.messageId}-followups`}
                      >
                        <p
                          id={`${followUps.messageId}-followups`}
                          className='rp-answer-tail rp-eyebrow text-ink-3'
                          style={tailStyle(0)}
                        >
                          Ask next
                        </p>
                        <div className='mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap'>
                          {followUps.questions.map((question, index) => (
                            <button
                              key={question}
                              type='button'
                              onClick={() => void send(question)}
                              style={tailStyle(index + 1)}
                              className='rp-answer-tail rp-focus flex items-center gap-2 rounded-[var(--rp-radius-btn)] border border-line bg-surface px-3 py-2 text-left text-[0.8125rem] leading-snug font-medium text-[var(--rp-ink-2)] transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)] sm:max-w-[24rem]'
                            >
                              <span className='min-w-0'>{question}</span>
                              <span aria-hidden='true' className='ml-auto shrink-0 text-ink-3'>
                                &rarr;
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                    : null}
                </div>
              )}

            {
              /* Auto-scroll anchor. On a phone it has to stop short of the bar
              * the thread runs under, so it carries the measured composer
              * height (plus anything the keyboard is covering) as a scroll
              * margin rather than a hardcoded guess. */
            }
            <div
              ref={threadEndRef}
              style={isCompact ? { scrollMarginBottom: composerHeight + keyboardInset } : undefined}
            />
          </section>

          {
            /* Sticky, not fixed. It stays in flow, so the bar can never be
            * stranded over the thread the way a fixed element was when iOS grew
            * `100dvh` under it; `bottom` only ever lifts it clear of the
            * software keyboard, which the layout viewport does not report. */
          }
          <form
            ref={composerRef}
            onSubmit={handleSubmit}
            className='sticky bottom-0 z-10 mt-2 shrink-0 border-t border-line bg-[var(--rp-app)] pt-2 pb-2 lg:static lg:border-t-0 lg:bg-transparent lg:pt-0 lg:pb-0'
            style={isCompact
              ? {
                bottom: keyboardInset,
                paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
              }
              : undefined}
          >
            <div className='mb-1.5 flex flex-wrap items-center gap-2 px-1'>
              {
                /* Sessions rides with Deep research on a phone: two related
                * controls on one row above the input, rather than a lone button
                * stranded at the top of the page. The sessions rail is always
                * visible from `lg` up, so the button is not needed there.
                *
                * Rendered conditionally rather than hidden with `lg:hidden`:
                * `.rp-chip` sets its own `display` later in the stylesheet than
                * Tailwind's utilities, so the class would not have hidden it. */
              }
              {isCompact
                ? (
                  <button
                    type='button'
                    onClick={() => setShowSidebar(true)}
                    className='rp-chip h-9 sm:h-7'
                  >
                    <svg
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth={1.8}
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      className='h-4 w-4'
                      aria-hidden='true'
                    >
                      <path d='M3 12a9 9 0 1 0 2.6-6.4L3 8' />
                      <path d='M3 3v5h5' />
                      <path d='M12 7.5V12l3.2 1.9' />
                    </svg>
                    Sessions
                  </button>
                )
                : null}
              <button
                type='button'
                onClick={() => setDeepResearch((prev) => !prev)}
                disabled={isStreaming}
                aria-pressed={deepResearch}
                className={`rp-chip h-9 sm:h-7 ${deepResearch ? 'rp-chip-active' : ''}`}
              >
                <svg
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth={1.8}
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  className='h-4 w-4'
                  aria-hidden='true'
                >
                  <circle cx='10.5' cy='11' r='5.8' />
                  <path d='M14.8 15.2L20 20.4' />
                  <path d='M18.6 2.6v3.6M16.8 4.4h3.6' />
                </svg>
                Deep research
              </button>
              {
                /* One-off explanation, and it wraps onto a line of its own at
                * 390px - a row the pinned bar would then charge to the thread
                * every time deep research is on. The chip's active state says
                * the same thing on a phone. */
              }
              {deepResearch
                ? (
                  <span className='hidden text-xs text-ink-3 lg:inline'>
                    Maps sub-questions before answering - slower, more thorough.
                  </span>
                )
                : null}
            </div>
            <div className='flex items-end gap-2 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-2 shadow-sm'>
              <label htmlFor='ask-composer' className='sr-only'>
                Ask a question
              </label>
              {
                /* The placeholder is dropped on a phone (it clipped mid-word
                * across two lines), so the field carries a pencil instead to
                * keep it reading as somewhere to type. The sr-only label above
                * is still what screen readers announce. */
              }
              <span aria-hidden='true' className='shrink-0 pb-2 pl-1 text-ink-3 lg:hidden'>
                <svg
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth={1.8}
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  className='h-[18px] w-[18px]'
                >
                  <path d='M12 20h8' />
                  <path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z' />
                </svg>
              </span>
              <textarea
                id='ask-composer'
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isStreaming}
                rows={1}
                placeholder={isCompact ? undefined : 'Ask a question about this research'}
                className='max-h-40 min-w-0 flex-1 resize-none rounded-[var(--rp-radius)] border-0 bg-transparent px-2 py-2 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none disabled:opacity-60 lg:px-3'
              />
              {isStreaming
                ? (
                  <button
                    type='button'
                    onClick={stop}
                    className='rp-btn rp-btn-outline shrink-0'
                  >
                    Stop
                  </button>
                )
                : (
                  <button
                    type='submit'
                    disabled={draft.trim().length === 0}
                    className='rp-btn rp-btn-primary shrink-0'
                  >
                    Send
                  </button>
                )}
            </div>
            {
              /* Physical-keyboard guidance. On a phone there is no Shift+Enter
              * to give, and the row would cost the thread its own height in a
              * bar that is already pinned over it. */
            }
            <p className='mt-1.5 hidden px-1 text-xs text-ink-3 lg:block'>
              Enter to send &middot; Shift+Enter for a new line
            </p>
          </form>
        </div>
      </div>
    </main>
  )
}
