import { AnswerRecordLink } from '../components/AnswerRecordLink.tsx'
import { portalError } from '../lib/locale-messages.ts'
import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { exportResearchFile, researchExportAuthority } from '../lib/research-export.ts'
import { useAccess } from '../components/AccessProvider.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { portalStarterQuestions } from '../lib/tenant-copy.ts'
import {
  createResearchStorageContext,
  readResearchDraft,
  registerResearchCleanup,
  type ResearchStorageContext,
  researchStorageCurrent,
  writeResearchDraft,
} from '../lib/research-storage.ts'
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AskEvent, AskStage, Citation, ScoredResource } from '@research-portal/core'
import {
  addWatch,
  ApiError,
  deleteServerSession,
  getFollowUpQuestions,
  getServerSession,
  getSourceVerdicts,
  getSubqueries,
  getSuggestedQuestions,
  listServerSessions,
  putServerSession,
  type RouteDecision,
  sendAnswerFeedback,
  streamAsk,
} from '../api/client.ts'
import { secondsUntilRetry } from '../lib/ask-budget.ts'
import { answerHtml, escapeHtml, referenceListHtml } from '../lib/answer-export.ts'
import { recordOpen } from '../api/usage-events.ts'
import { citationLink, ContextJourney, EvidenceDisclosure } from '../components/AnswerStream.tsx'
import { CompareConfigurations } from '../components/CompareConfigurations.tsx'
import { CurrencyNote } from '../components/CurrencyNote.tsx'
import { RouteChip } from '../components/RouteChip.tsx'
import {
  type EvidenceSource,
  evidenceSummary,
  EvidenceTable,
  type EvidenceVerdictInfo,
} from '../components/EvidenceTable.tsx'
import { PipelinePanel } from '../components/PipelinePanel.tsx'
import { AnswerQualityDisclosure, type QualityScores } from '../components/QualityGauge.tsx'
import {
  Button,
  ExportNotice,
  IconButton,
  LiveStatus,
  savedFileNotice,
  useExportNotice,
} from '../components/ui.tsx'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash,
} from '../components/icons.tsx'
import { useCompactViewport } from '../components/useViewMode.ts'
import { isThinlyGrounded } from '../lib/confidence.ts'
import type { AnswerAudit } from '../lib/answer-marks.ts'
import { applyAnswerEvent } from '../lib/answer-trust.ts'
import { AnswerText, AuditBadge, TruncatedNotice } from '../components/AnswerInline.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'
import type { Intent } from '@research-portal/core'
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
  answerId?: string
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
  /** The error was the server asking us to wait (HTTP 429): retry after this many seconds. */
  rateLimited?: boolean
  retryAfterSec?: number
  pending?: boolean
  /** How the platform interpreted/rephrased the question (first turn only). */
  interpretedQuery?: string
  /** The routed intent found nothing usable and the general configuration answered instead. */
  fallback?: { from: string; to: string | null; reason: string }
  /** No citation could be tied to a passage; the sources are the ones consulted (D8-01). */
  unlinked?: boolean
  /** Platform learning id for this answer - target for feedback. */
  answerRecordId?: string
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
  /** The generation stopped mid-sentence; the incomplete tail was cut back to the last complete sentence. */
  truncated?: boolean
  /** What the post-answer audit checked against the cited texts, once it has run. */
  audit?: AnswerAudit
  /**
   * The text is complete but the figure gate has not passed it yet: how
   * many figures are being checked. Cleared by `done`; never persisted.
   */
  checking?: number
  /**
   * The first sentence, checked against a retrieved paper's text while
   * the rest still streams: every figure it states was found beside its
   * claim in that paper. Cleared by `done`; never persisted.
   */
  verified?: { sentence: string; title: string }
  /** The intent-routing decision this answer ran under (docs/INTENT-ROUTING.md). */
  route?: RouteDecision
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
    answerId: typeof message?.answerId === 'string' ? message.answerId : undefined,
    answerRecordId: typeof message?.answerRecordId === 'string'
      ? message.answerRecordId
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
    truncated: typeof message?.truncated === 'boolean' ? message.truncated : undefined,
    audit: migrateAudit(message?.audit),
    verdicts: message?.verdicts && typeof message.verdicts === 'object'
      ? message.verdicts as Record<string, EvidenceVerdictInfo>
      : undefined,
  }
}

function migrateAudit(raw: unknown): AnswerAudit | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<AnswerAudit>
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : []
  if (typeof value.figuresChecked !== 'number') return undefined
  const count = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined
  return {
    figuresChecked: value.figuresChecked,
    figuresUnsupported: strings(value.figuresUnsupported),
    yearsUnsupported: strings(value.yearsUnsupported),
    contraindicationsUnsupported: strings(value.contraindicationsUnsupported),
    sentencesChecked: count(value.sentencesChecked),
    sentencesCited: count(value.sentencesCited),
    denominatorsMissing: strings(value.denominatorsMissing),
    attributionsCorrected: strings(value.attributionsCorrected),
    sentencesRemoved: count(value.sentencesRemoved),
    figuresRemoved: strings(value.figuresRemoved),
    figuresRescued: strings(value.figuresRescued),
    sentencesReplaced: count(value.sentencesReplaced),
    figuresSecondhandRemoved: strings(value.figuresSecondhandRemoved),
    denominatorsCorrected: strings(value.denominatorsCorrected),
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

function loadSessions(storage: ResearchStorageContext): ChatSession[] {
  try {
    const parsed = readResearchDraft(storage)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(migrateSession)
      .filter((session): session is ChatSession => session !== null)
  } catch {
    return []
  }
}

/** True when at least one assistant turn carries an answer rather than a transport error. */
export function hasAnsweredTurn(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) =>
    message.author === 'AGENT' && !message.pending && !message.error &&
    message.text.trim().length > 0
  )
}

function saveSessions(
  storage: ResearchStorageContext,
  sessions: ChatSession[],
  deletedIds?: Set<string>,
) {
  try {
    // Merge with what is currently stored: another tab may have added or
    // updated sessions since this tab mounted. In-memory wins for ids we
    // hold; stored-only ids are kept unless this tab deleted them.
    const stored = loadSessions(storage)
    const mine = new Map(sessions.map((s) => [s.id, s]))
    const merged = [
      ...sessions,
      ...stored.filter((s) => !mine.has(s.id) && !(deletedIds?.has(s.id))),
    ]
    merged.sort((a, b) => b.updatedAt - a.updatedAt)
    writeResearchDraft(storage, merged.slice(0, SESSION_CAP))
  } catch {
    // localStorage unavailable or full - sessions simply won't persist this run.
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function relativeAge(timestamp: number, ui: ResearchUi = englishResearchUi): string {
  const diffMs = Date.now() - timestamp
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return ui('just now')
  if (minutes < 60) return ui('{count}m ago', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return ui('{count}h ago', { count: hours })
  const days = Math.round(hours / 24)
  return ui('{count}d ago', { count: days })
}

function sessionTitle(session: ChatSession, ui: ResearchUi = englishResearchUi): string {
  if (session.title && session.title.trim().length > 0) return session.title
  const first = session.messages.find((message) => message.author === 'USER')
  if (!first || first.text.trim().length === 0) return ui('New conversation')
  return first.text.length > 60 ? `${first.text.slice(0, 60)}…` : first.text
}

/** Restored automatic sidebar titles stay short; the reading heading keeps the whole question. */
export function sessionHeading(
  session: Pick<ChatSession, 'messages' | 'title'>,
  ui: ResearchUi = englishResearchUi,
): string {
  const automaticTitle = sessionTitle({
    id: '',
    createdAt: 0,
    updatedAt: 0,
    messages: session.messages,
  }, ui)
  const name = session.title?.trim()
  if (name && name !== automaticTitle) return name
  return session.messages.find((message) => message.author === 'USER')?.text || automaticTitle
}

// ---------------------------------------------------------------------------
// Answer rendering: the shared AnswerText (components/AnswerInline.tsx) reads
// the answer the same way Search does - markers, marks and the hedge.
// ---------------------------------------------------------------------------

/** Where else the reader finds a cited source on this page. */
const CITATION_HINT = 'click to open, or find it in the Evidence table below'

function renderMarkdown(message: ChatMessage, slug: string): ReactNode {
  return (
    <AnswerText
      bodyClassName='rp-prose rp-measure text-base text-ink-2'
      text={message.text}
      answerId={message.answerId}
      citations={message.citations}
      sources={message.sources}
      slug={slug}
      audit={message.audit}
      streaming={message.pending === true}
      citationHint={CITATION_HINT}
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
  const { ui } = usePortalLocale()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  function startEdit(session: ChatSession) {
    setEditingId(session.id)
    setDraftTitle(sessionTitle(session, ui))
  }

  function commitEdit() {
    const trimmed = draftTitle.trim()
    if (editingId && trimmed.length > 0) onRename(editingId, trimmed)
    setEditingId(null)
  }

  return (
    <div className='flex h-full flex-col'>
      <Button onClick={onNew} leadingIcon={Plus} className='w-full'>
        {ui('New session')}
      </Button>

      <nav
        aria-label={ui('Chat sessions')}
        className='rp-scroll mt-4 flex-1 space-y-1.5 overflow-y-auto pr-1'
      >
        {sessions.length === 0
          ? <p className='px-1 py-2 text-xs text-ink-3'>{ui('No sessions yet.')}</p>
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
                    aria-label={ui('Session name')}
                    autoFocus
                    className='rp-input text-sm'
                  />
                </form>
              )
            }
            return (
              <div
                key={session.id}
                className={`rounded-[var(--rp-radius)] ${isActive ? 'bg-surface shadow-sm' : ''}`}
              >
                <button
                  type='button'
                  onClick={() => onSelect(session.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className='rp-focus w-full rounded-[var(--rp-radius)] px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
                >
                  <p className='rp-clamp-2 text-sm font-medium text-ink'>
                    {sessionTitle(session, ui)}
                  </p>
                  <p className='mt-0.5 text-xs text-ink-3'>
                    {session.messages.length}{' '}
                    {session.messages.length === 1 ? ui('message') : ui('messages')}
                    {' · '}
                    {relativeAge(session.updatedAt, ui)}
                  </p>
                </button>
                <div className='rp-answer-session-actions flex justify-end px-1 pb-1'>
                  {isActive
                    ? (
                      <IconButton
                        onClick={(event) => {
                          event.stopPropagation()
                          startEdit(session)
                        }}
                        label={ui('Rename "{value1}"', { value1: sessionTitle(session, ui) })}
                        icon={Pencil}
                        size='sm'
                      />
                    )
                    : null}
                  <IconButton
                    onClick={(event) => {
                      event.stopPropagation()
                      onDelete(session.id)
                    }}
                    label={ui('Delete "{value1}"', { value1: sessionTitle(session, ui) })}
                    icon={Trash}
                    variant='danger'
                    size='sm'
                  />
                </div>
              </div>
            )
          })}
      </nav>
    </div>
  )
}

/** A whole question is the reading title; its collapsed height follows the actual type. */
export function QuestionHeading({ question, actions, onExpandedChange }: {
  question: string
  actions?: ReactNode
  onExpandedChange?: (expanded: boolean) => void
}) {
  const { ui } = usePortalLocale()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    setExpanded(false)
    onExpandedChange?.(false)
  }, [question])

  useEffect(() => {
    const heading = headingRef.current
    if (!heading) return
    const measure = () => {
      const style = getComputedStyle(heading)
      const lineHeight = Number.parseFloat(style.lineHeight) ||
        Number.parseFloat(style.fontSize) * 1.2
      // Glyphs can extend past a line box without adding another line of text.
      setOverflows(Math.round(heading.scrollHeight / lineHeight) > 4)
    }
    let active = true
    measure()
    void document.fonts?.ready.then(() => {
      if (active) measure()
    })
    const observer = new ResizeObserver(measure)
    observer.observe(heading)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [question])

  return (
    <div className='min-w-0 basis-full'>
      <h1
        id='ask-question-heading'
        ref={headingRef}
        className={`rp-answer-question rp-display text-xl text-ink lg:text-3xl ${
          expanded ? '' : 'rp-answer-question-clamped'
        }`}
      >
        {question}
      </h1>
      {overflows || actions
        ? (
          <div className='rp-answer-question-actions mt-1 flex items-center gap-2'>
            {overflows
              ? (
                <Button
                  variant='ghost'
                  size='sm'
                  aria-expanded={expanded}
                  aria-controls='ask-question-heading'
                  onClick={() => {
                    const next = !expanded
                    setExpanded(next)
                    onExpandedChange?.(next)
                  }}
                >
                  {expanded ? ui('Collapse question') : ui('Show full question')}
                  <ChevronDown size='sm' className={expanded ? 'rotate-180' : ''} />
                </Button>
              )
              : null}
            {actions}
          </div>
        )
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

export function UserBubble({
  message,
  onAskSubquery,
  showQuestion = true,
}: {
  message: ChatMessage
  onAskSubquery: (subquery: string) => void
  showQuestion?: boolean
}) {
  const { ui } = usePortalLocale()
  const subqueries = message.subqueries ?? []
  const chips = (
    <div className='flex flex-wrap justify-end gap-1.5'>
      {subqueries.map((subquery, index) => (
        <button
          key={index}
          type='button'
          onClick={() => onAskSubquery(subquery)}
          className='rp-chip rp-answer-chip text-2xs'
        >
          {subquery}
        </button>
      ))}
    </div>
  )
  if (!showQuestion && subqueries.length === 0) return null
  return (
    /* scroll-mt: below `lg` the title bar is sticky over the thread, so a
     * bubble scrolled to the top would otherwise slide under it. */
    <div className='flex scroll-mt-16 flex-col items-end gap-1.5 lg:scroll-mt-0'>
      {showQuestion
        ? (
          <div
            className='max-w-[85%] rounded-[calc(var(--rp-radius)+4px)] rounded-tr-sm px-4 py-3 text-sm leading-relaxed text-ink sm:max-w-[70%]'
            style={{ backgroundColor: 'var(--rp-wash)' }}
          >
            {message.text}
          </div>
        )
        : null}
      {subqueries.length > 0
        ? (
          <div className='flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[70%]'>
            {
              /* On a phone the prequery stack filled the whole first screen
              * and pushed the answer below the fold - so there it sits
              * behind a one-line disclosure; from `sm` up the chips show. */
            }
            <details className='w-full sm:hidden'>
              <summary className='rp-answer-disclosure cursor-pointer gap-2 text-right text-2xs font-medium uppercase tracking-wide text-ink-3'>
                {ui('Searched for {count} sub-questions', { count: subqueries.length })}
                <ChevronDown size='sm' className='shrink-0' />
              </summary>
              <div className='mt-1.5'>{chips}</div>
            </details>
            <div className='hidden flex-col items-end gap-1 sm:flex'>
              <p className='text-2xs font-medium uppercase tracking-wide text-ink-3'>
                {ui('Searched for')}
              </p>
              {chips}
            </div>
          </div>
        )
        : null}
    </div>
  )
}

type FeedbackStatus = { text: string; error?: boolean }

export function FeedbackStatusMessage({ status }: { status: FeedbackStatus | null }) {
  return (
    <p
      role='status'
      aria-live='polite'
      aria-atomic='true'
      className={`${status ? 'mt-2 ' : ''}text-xs ${
        status?.error ? 'text-[var(--rp-bad-ink)]' : 'text-ink-3'
      }`}
    >
      {status?.text ?? ''}
    </p>
  )
}

/** Rating stays in the toolbar; any follow-up detail sits below it. */
export function FeedbackControl({ message, onFeedback, onStatus }: {
  message: ChatMessage
  onFeedback: (good: boolean, text?: string) => Promise<boolean>
  onStatus: (status: FeedbackStatus | null) => void
}) {
  const { ui } = usePortalLocale()
  const [busy, setBusy] = useState(false)
  if (!message.learningId) return null

  async function handleRate(good: boolean) {
    if (busy || message.feedbackSubmitted) return
    onStatus(null)
    setBusy(true)
    const ok = await onFeedback(good)
    setBusy(false)
    onStatus(
      ok
        ? { text: ui('Thanks - your feedback was sent.') }
        : { text: ui('Could not send feedback - try again.'), error: true },
    )
  }

  return (
    <>
      <IconButton
        label={ui('Helpful answer')}
        icon={ThumbsUp}
        onClick={() => void handleRate(true)}
        aria-disabled={busy || message.feedbackSubmitted}
        aria-pressed={message.feedbackSubmitted && message.feedbackGood === true}
      />
      <IconButton
        label={ui('Not a helpful answer')}
        icon={ThumbsDown}
        onClick={() => void handleRate(false)}
        aria-disabled={busy || message.feedbackSubmitted}
        aria-pressed={message.feedbackSubmitted && message.feedbackGood === false}
      />
    </>
  )
}

function FeedbackDetail({ message, onFeedback, onStatus }: {
  message: ChatMessage
  onFeedback: (good: boolean, text?: string) => Promise<boolean>
  onStatus: (status: FeedbackStatus | null) => void
}) {
  const { ui } = usePortalLocale()
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState('')
  const [detailSent, setDetailSent] = useState(false)
  if (!message.feedbackSubmitted || message.feedbackGood !== false || detailSent) return null

  async function sendDetail() {
    if (busy || !detail.trim()) return
    setBusy(true)
    onStatus(null)
    const ok = await onFeedback(false, detail.trim())
    setBusy(false)
    if (ok) setDetailSent(true)
    onStatus(
      ok
        ? { text: ui('Thanks - your feedback was sent.') }
        : { text: ui('Could not send feedback - try again.'), error: true },
    )
  }

  return (
    <div className='mt-2 space-y-2 text-xs text-ink-3'>
      <div className='flex min-w-0 items-center gap-2'>
        <input
          type='text'
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          placeholder={ui('What was wrong? (optional)')}
          aria-label={ui('What was wrong with this answer? (optional)')}
          readOnly={busy}
          className='rp-input min-w-0 flex-1 text-xs'
        />
        <Button
          variant='ghost'
          size='sm'
          leadingIcon={Send}
          onClick={() => void sendDetail()}
          aria-disabled={busy || !detail.trim()}
        >
          {ui('Send')}
        </Button>
      </div>
      <p>{ui("This portal's curators can read what you write.")}</p>
    </div>
  )
}

/** Copies the answer text, confirming in place rather than with a toast. */
/**
 * What the post-answer audit checked: every figure found beside its claim
 * in a cited passage (quiet, green), or how many were not (amber, with the
 * figures named in the tooltip and marked inline in the prose).
 */
/**
 * The state between the last streamed word and the gated text: the answer
 * reads complete but has not been checked, and this says so in the badge's
 * own place, with the number of figures under check. Replaced by the audit
 * badge on `done`.
 */
function CheckingBadge({ figures }: { figures?: number }) {
  const { ui } = usePortalLocale()
  // Text on screen before the check has run is unchecked text, and the
  // reader is told so from the first token, not only once the audit
  // starts: streamed prose used to appear as the answer and then be
  // withdrawn (D5-08).
  const label = figures === undefined
    ? ui('Unchecked - still streaming, the check follows')
    : figures === 0
    ? ui('Checking the answer against the cited papers')
    : figures === 1
    ? ui('Checking 1 figure against the cited papers')
    : ui('Checking {count} figures against the cited papers', { count: figures })
  return (
    <div className='mt-3 flex items-center gap-2' role='status' aria-live='polite'>
      <span className='rp-badge rp-badge-quiet inline-flex items-center gap-1.5'>
        <span className='rp-stage-spin inline-block h-3 w-3 rounded-full border-[1.5px] border-current border-t-transparent opacity-70' />
        {label}
      </span>
    </div>
  )
}

export function CopyAnswer({ text }: { text: string }) {
  const { ui } = usePortalLocale()
  const [copied, setCopied] = useState(false)
  const resetCopy = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetCopy.current) clearTimeout(resetCopy.current)
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (resetCopy.current) clearTimeout(resetCopy.current)
      resetCopy.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be refused; the button simply does not confirm.
    }
  }

  if (text.trim().length === 0) return null
  return (
    <>
      <IconButton
        label={ui('Copy the answer')}
        onClick={() => void copy()}
        icon={copied ? Check : Copy}
      />
      <span role='status' aria-live='polite' aria-atomic='true' className='sr-only'>
        {copied ? ui('Answer copied') : ''}
      </span>
    </>
  )
}

/**
 * Saves the question behind an answer as a watch so the tenant sees a
 * "changed" badge in Search when new results turn up for it later. Purely
 * local UI state - a page reload simply lets the user watch it again.
 */
function WatchControl(
  { question, slug, lifetime }: { question: string; slug: string; lifetime: AbortSignal },
) {
  const { ui } = usePortalLocale()
  const access = useAccess()
  const context = access.controller.context
  const current = () =>
    !lifetime.aborted && access.controller.context === context &&
    access.controller.can('portal.watch', { kind: 'portal', slug })
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')

  if (!current() || question.trim().length === 0) return null

  async function handleWatch() {
    if (!current()) return
    setStatus('busy')
    try {
      await addWatch(slug, question, lifetime)
      if (current()) setStatus('done')
    } catch {
      if (current()) setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <p className='text-xs text-ink-3'>
        {ui('In your Watches - a change badge appears in Search when results change.')}
      </p>
    )
  }

  return (
    <div className='flex items-center gap-1.5'>
      <Button
        variant='ghost'
        size='sm'
        leadingIcon={Eye}
        onClick={handleWatch}
        disabled={status === 'busy'}
      >
        {status === 'busy' ? ui('Adding to Watches') : ui('Add to Watches')}
      </Button>
      {status === 'error'
        ? (
          <p className='text-xs text-[var(--rp-bad-ink)]'>
            {ui('Could not add it to Watches - try again.')}
          </p>
        )
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

/**
 * The failed-answer state. A rate limit is not "something went wrong": the
 * portal is busy, the server said how long to wait, and the card counts that
 * down and retries by itself - the reader can also retry at once. The copy
 * is the same sentence the Search page uses (`RATE_LIMIT_MESSAGE`).
 */
function AnswerErrorCard({ message, rateLimited, retryAfterSec, onRetry }: {
  message: string
  rateLimited: boolean
  retryAfterSec?: number
  onRetry: () => void
}) {
  const { ui, error: localError } = usePortalLocale()
  const wait = Math.max(1, retryAfterSec ?? (secondsUntilRetry() || RETRY_FALLBACK_SEC))
  const [left, setLeft] = useState(rateLimited ? wait : 0)
  const onRetryRef = useRef(onRetry)
  onRetryRef.current = onRetry
  useEffect(() => {
    if (!rateLimited) return
    setLeft(wait)
    const started = Date.now()
    const timer = setInterval(() => {
      const remaining = wait - Math.floor((Date.now() - started) / 1000)
      if (remaining <= 0) {
        clearInterval(timer)
        setLeft(0)
        onRetryRef.current()
      } else {
        setLeft(remaining)
      }
    }, 250)
    return () => clearInterval(timer)
  }, [rateLimited, wait])
  return (
    <div
      role='status'
      className='rounded-[calc(var(--rp-radius)+4px)] border p-3 sm:p-5'
      style={rateLimited
        ? { borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }
        : { borderColor: 'var(--rp-bad-line)', background: 'var(--rp-bad-bg)' }}
    >
      <p
        className='text-sm font-medium'
        style={{ color: rateLimited ? 'var(--rp-warn-ink)' : 'var(--rp-bad-ink)' }}
      >
        {rateLimited ? ui('The portal is busy') : ui('Something went wrong')}
      </p>
      <p
        className='mt-1 text-sm'
        style={{ color: rateLimited ? 'var(--rp-warn-ink)' : 'var(--rp-bad-ink)' }}
      >
        {localError(message, 'The answer service is unavailable.')}
      </p>
      <div className='mt-3 flex flex-wrap items-center gap-3'>
        <button
          type='button'
          onClick={onRetry}
          className={rateLimited ? 'rp-btn rp-btn-outline' : 'rp-btn rp-btn-danger'}
        >
          <RotateCcw size='sm' />
          {rateLimited ? ui('Retry now') : ui('Retry')}
        </button>
        {rateLimited && left > 0
          ? (
            <span
              className='text-sm tabular-nums'
              style={{ color: 'var(--rp-warn-ink)' }}
              aria-live='polite'
            >
              {ui('Retrying in {seconds} s', { seconds: left })}
            </span>
          )
          : null}
      </div>
    </div>
  )
}

/** When a 429 carries no Retry-After, wait this long before the automatic retry. */
const RETRY_FALLBACK_SEC = 15

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
  intents,
  onReroute,
  canInspectDiagnostics = false,
  canGenerate,
  canAsk,
  lifetime,
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
  /** The portal's intents, for the route chip and compare mode. */
  intents: Intent[]
  /** Re-ask this answer's question under another intent. */
  onReroute: (intentId: string) => void
  /** Developer-facing widgets (pipeline, tokens) show only to administrators. */
  canInspectDiagnostics?: boolean
  canGenerate: boolean
  canAsk: boolean
  lifetime: AbortSignal
}) {
  const { ui, error: localError } = usePortalLocale()
  const access = useAccess()
  const authority = access.controller.context
  const current = () => !lifetime.aborted && access.controller.context === authority
  const verdictAbort = useRef<AbortController | null>(null)
  useEffect(() => () => verdictAbort.current?.abort(), [lifetime])
  const [showPipeline, setShowPipeline] = useState(false)
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus | null>(
    message.feedbackSubmitted ? { text: ui('Thanks - your feedback was sent.') } : null,
  )
  const [compare, setCompare] = useState<[string, string] | null>(null)
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
    if (
      judging || !current() || !access.controller.can('portal.generate', { kind: 'portal', slug })
    ) return
    const abort = new AbortController()
    verdictAbort.current = abort
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
        AbortSignal.any([abort.signal, lifetime]),
      )
      if (abort.signal.aborted || !current()) return
      const next: Record<string, EvidenceVerdictInfo> = {}
      for (const item of result.verdicts) {
        next[item.id] = { verdict: item.verdict, relevance: item.relevance }
      }
      onVerdicts(next)
    } catch {
      // Judging is advisory - a failure just leaves the table without verdicts.
    } finally {
      if (!abort.signal.aborted && current()) setJudging(false)
    }
  }

  // Must sit above every early return in this component: a hook after a
  // conditional return changes the hook count between renders (React #310).
  const phase = useAnswerPhase(message.text.length > 0, true)

  if (message.error && !message.text.trim()) {
    return (
      <AnswerErrorCard
        message={message.error}
        rateLimited={message.rateLimited === true}
        retryAfterSec={message.retryAfterSec}
        onRetry={onRetry}
      />
    )
  }

  // Offer the deep re-answer whenever an answer is genuinely thinly grounded -
  // the SAME low-confidence signal that paints the red banner (isThinlyGrounded
  // delegates to assessConfidence), so a low-confidence answer always carries
  // the offer and a healthy one never does. Gate on the message state too: not
  // while streaming, not once dismissed, and not on an answer that was already
  // deep (nothing deeper to escalate to).
  const groundedness = message.quality?.groundedness
  const offerDeepReanswer = canGenerate && !message.pending && !message.healDismissed &&
    !message.wasDeep &&
    !message.deepBadge && isThinlyGrounded(message.quality, message.audit)
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
    type: source.type,
    matchedField: source.matchedField,
  }))

  // What the collapsed evidence panel says about itself: enough to decide
  // whether to open it ("7 sources · 3 cited · 1980-2010") without unfurling a
  // wall of raw passages under every answer.
  // "n cited" is the bound set: the resources a marker in the final text
  // actually points at, whether or not retrieval listed them.
  const citedSourceCount = new Set(message.citations.map((citation) => citation.resourceId)).size

  const secondaryTools = (
    <div className='flex flex-wrap items-center gap-2'>
      <AuditBadge audit={message.audit} />
      <WatchControl question={question} slug={slug} lifetime={lifetime} />
      {canAsk && canInspectDiagnostics &&
          intents.filter((intent) => intent.answer.surfaces.includes('ask')).length >
            1 &&
          question.trim().length > 0
        ? (
          <Button
            variant='ghost'
            size='sm'
            onClick={() => {
              const askable = intents.filter((intent) => intent.answer.surfaces.includes('ask'))
              const current = message.route?.intent ?? askable[0]!.id
              const other = askable.find((intent) => intent.id !== current)?.id ??
                current
              setCompare((prev) => prev ? null : [current, other])
            }}
            aria-pressed={compare !== null}
            title={ui(
              'Run this question through two retrieval configurations side by side',
            )}
          >
            {ui('Compare configurations')}
          </Button>
        )
        : null}
    </div>
  )

  // A refusal gets its own structured "no evidence" state instead of the
  // normal answer body - the guidance sentence the platform generated, what
  // WAS retrieved (unjudged, so the user sees raw scores rather than another
  // AI opinion), and next actions rather than a dead end.
  if (!message.pending && message.refused) {
    return (
      <div className={ANSWER_CARD}>
        <div className='mb-2 rp-answer-tail' style={tailStyle(TAIL_QUALITY)}>
          <span className='rp-badge rp-badge-quiet'>{ui('No direct evidence found')}</span>
        </div>

        {message.text.length > 0 ? renderMarkdown(message, slug) : null}

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
                title={ui('closest matches, not used')}
                anchorPrefix={message.id}
              />
            </div>
          )
          : null}

        <div
          className='rp-answer-tail mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3'
          style={tailStyle(TAIL_ACTIONS)}
        >
          <WatchControl question={question} slug={slug} lifetime={lifetime} />
        </div>

        {subqueries.length > 0
          ? (
            <div className='mt-3 flex flex-wrap gap-1.5'>
              {subqueries.map((subquery, index) => (
                <button
                  key={index}
                  type='button'
                  onClick={() => onAskSubquery(subquery)}
                  className='rp-chip rp-answer-chip text-2xs'
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
            <span className='rp-badge rp-badge-quiet'>{ui('Deep re-answer')}</span>
          </div>
        )
        : null}
      {canInspectDiagnostics && intents.length > 0 && (message.route || message.pending)
        ? (
          <div className='mb-2 flex flex-wrap items-center gap-2'>
            <RouteChip
              decision={message.route}
              intents={intents}
              pending={message.pending}
              onOverride={onReroute}
            />
            {message.fallback
              ? (
                <span
                  className='rp-badge rp-badge-warn'
                  title={message.fallback.reason}
                >
                  {ui('Answered from')} {message.fallback.to
                    ? intents.find((i) => i.id === message.fallback?.to)?.label ??
                      message.fallback.to
                    : ui('the general configuration')} -{' '}
                  {intents.find((i) => i.id === message.fallback?.from)?.label ??
                    message.fallback.from} {ui('found nothing usable')}
                </span>
              )
              : null}
          </div>
        )
        : null}

      {phase !== 'answer' && message.pending
        ? (
          <StageTimeline
            statuses={stageStatuses ?? {}}
            exiting={phase === 'handoff'}
            reading={message.sources.map((source) => source.title)}
          />
        )
        : message.text.length > 0
        ? (
          <div
            className={message.pending ? 'rp-answer-in rp-answer-checking' : 'rp-answer-in'}
            aria-busy={message.pending ? true : undefined}
          >
            {renderMarkdown(message, slug)}
          </div>
        )
        : null}

      {message.pending && message.verified && phase === 'answer' && message.text.length > 0
        ? (
          <p
            className='rp-answer-verified mt-2 text-xs leading-relaxed text-ink-3'
            role='status'
            data-testid='first-sentence-verified'
          >
            <span className='font-medium text-[var(--rp-ok-ink)]'>
              {ui('First sentence verified')}
            </span>{' '}
            {ui('against')} <span className='italic'>{message.verified.title}</span>
          </p>
        )
        : null}
      {message.pending && phase === 'answer' && message.text.length > 0
        ? <CheckingBadge figures={message.checking} />
        : null}

      {
        /* The confidence headline, the REMi mini-meters and the thin-grounding
          offer used to stack here as three full-width blocks. On a phone that
          was most of a screen of chrome after every answer, so they now live
          together behind one control on the actions row below - a control that
          stays loud and labelled while the news is bad, so folding them away
          never softens a poorly grounded answer. See AnswerQualityDisclosure. */
      }

      {message.truncated && !message.pending
        ? (
          <TruncatedNotice
            onAskAgain={() => onAskSubquery?.(question)}
            className='rp-answer-tail mt-3'
            style={tailStyle(TAIL_NOTICE)}
          />
        )
        : null}

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
              {ui('The answer was cut short -')}{' '}
              {localError(message.error, 'The answer service is unavailable.')}
            </p>
            <button
              type='button'
              onClick={onRetry}
              className='rp-btn rp-btn-outline rp-btn-sm shrink-0'
            >
              <RotateCcw size='sm' />
              {ui('Retry')}
            </button>
          </div>
        )
        : null}

      {!message.pending
        ? (
          <div className='rp-answer-tail mt-3' style={tailStyle(TAIL_ACTIONS)}>
            <div className='rp-answer-toolbar flex items-center justify-between gap-2'>
              <AnswerQualityDisclosure
                quality={message.quality}
                audit={message.audit}
                {...(offerDeepReanswer ? { onReanswerDeeply } : {})}
                sparselyGrounded={isSparselyGrounded && evidenceSources.length > 0}
              />
              <div className='rp-answer-actions ml-auto flex shrink-0 items-center'>
                {canAsk
                  ? (
                    <FeedbackControl
                      message={message}
                      onFeedback={onFeedback}
                      onStatus={setFeedbackStatus}
                    />
                  )
                  : null}
                <CopyAnswer text={message.text} />
                {canAsk && question.trim().length > 0
                  ? (
                    <IconButton
                      label={ui('Ask this again')}
                      icon={RotateCcw}
                      onClick={() => onAskSubquery(question)}
                    />
                  )
                  : null}
              </div>
            </div>
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              {secondaryTools}
              <AnswerRecordLink slug={slug} answerId={message.answerRecordId} />
            </div>
            <FeedbackStatusMessage status={feedbackStatus} />
            {canAsk
              ? (
                <FeedbackDetail
                  message={message}
                  onFeedback={onFeedback}
                  onStatus={setFeedbackStatus}
                />
              )
              : null}
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
      {canAsk && canInspectDiagnostics && compare
        ? (
          <CompareConfigurations
            slug={slug}
            question={question}
            intents={intents}
            initial={compare}
            onClose={() => setCompare(null)}
          />
        )
        : null}
      {
        /* The answer streams before its sources and citations have settled, so
          the reader would otherwise stare at a finished answer with nothing
          beneath it for a few seconds. Say what is happening instead - and
          show the sources as soon as they exist rather than holding them until
          every post-answer step has completed. */
      }
      {message.pending && message.text.length > 0 && message.sources.length === 0 &&
          message.citations.length === 0
        ? (
          <div
            className='rp-answer-tail mt-4 flex items-center gap-2.5 border-t border-line pt-3 text-xs text-ink-3'
            role='status'
            aria-live='polite'
          >
            <span
              className='inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-[var(--rp-accent)]'
              aria-hidden='true'
            />
            <span>{ui('Retrieving evidence…')}</span>
            <span
              className='rp-shimmer h-3 w-28 rounded-[var(--rp-radius)] bg-surface-3'
              aria-hidden='true'
            />
          </div>
        )
        : null}
      {message.sources.length > 0 || message.citations.length > 0
        ? (
          <div
            className='rp-answer-tail mt-4 border-t border-line pt-3'
            style={tailStyle(TAIL_SOURCES)}
          >
            <EvidenceDisclosure
              regionId={`${message.id}-evidence`}
              open={showEvidence}
              onToggle={() => setShowEvidence((prev) => !prev)}
              label={ui('retrieved sources')}
              summary={evidenceSummary(evidenceSources, citedSourceCount, ui)}
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
                          const source = message.sources.find((source) =>
                            source.id === citation.resourceId
                          )
                          return (
                            <Link
                              key={citation.index}
                              to={citationLink(slug, citation, source)}
                              onClick={() =>
                                recordOpen(
                                  slug,
                                  { answerId: message.answerId },
                                  citation.resourceId,
                                  citation.index,
                                )}
                              onAuxClick={(e) => {
                                if (e.button === 1) {
                                  recordOpen(
                                    slug,
                                    { answerId: message.answerId },
                                    citation.resourceId,
                                    citation.index,
                                  )
                                }
                              }}
                              title={citation.headline
                                ? `${citation.title} - ${citation.headline}`
                                : citation.title}
                              className='rp-chip rp-answer-chip h-auto py-1'
                            >
                              <span
                                className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold'
                                style={{
                                  backgroundColor: 'var(--rp-accent)',
                                  color: 'var(--rp-on-accent)',
                                }}
                              >
                                {citation.index}
                              </span>
                              <span className='flex min-w-0 flex-col leading-tight sm:max-w-[16rem]'>
                                <span className='truncate'>{citation.title}</span>
                                {citation.headline
                                  ? (
                                    <span className='truncate text-2xs font-normal text-ink-3'>
                                      {citation.headline}
                                    </span>
                                  )
                                  : null}
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
                      answerId={message.answerId}
                      unlinked={message.unlinked}
                      anchorPrefix={message.id}
                      collapsible={false}
                    />
                  )
                  : null}

                {canInspectDiagnostics && (message.sources.length > 0 || message.usage)
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
                            className='rp-btn rp-btn-ghost rp-btn-sm'
                          >
                            <ChevronDown size='sm' className={showPipeline ? 'rotate-180' : ''} />
                            {showPipeline ? ui('Hide the pipeline') : ui('Show the pipeline')}
                          </button>
                        )
                        : null}
                      {message.usage
                        ? (
                          <p className='text-xs text-ink-3'>
                            {ui('{input} in / {output} out tokens', {
                              input: message.usage.inputTokens,
                              output: message.usage.outputTokens,
                            })}
                          </p>
                        )
                        : null}
                    </div>
                  )
                  : null}

                <div id={`${message.id}-pipeline`} hidden={!showPipeline}>
                  {canInspectDiagnostics && showPipeline
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
// with the Word-namespaced <head>). The answer body and the reference list
// come from lib/answer-export.ts, which runs the page's own block parser.
// ---------------------------------------------------------------------------

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
 * question, the answer rendered through the page's own Markdown block parser
 * (headings, lists, tables; `[n]` markers as superscripts), a numbered
 * reference list in marker order built from the citation metadata (authors,
 * journal, year, DOI, portal link), and the REMi quality line when the
 * platform scored the answer. `resourceUrl` makes the portal links absolute
 * so they resolve from the saved document.
 */
export function sessionToWordHtml(
  portalName: string,
  title: string,
  messages: ChatMessage[],
  resourceUrl: (resourceId: string) => string,
  ui: ResearchUi = englishResearchUi,
  language = 'en',
): string {
  const dateLine = new Date().toLocaleDateString(language === 'ja' ? 'ja-JP' : 'en-AU', {
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
        return `<p><em>${escapeHtml(ui('Answer unavailable'))} - ${
          escapeHtml(
            portalError(
              language === 'ja' ? 'ja' : 'en',
              message.error,
              'The answer service is unavailable.',
            ),
          )
        }</em></p>`
      }
      const bodyHtml = answerHtml(message.text, message.citations)
      const citationsHtml = referenceListHtml(message.citations, message.sources, resourceUrl, ui)
      const qualityHtml = message.quality
        ? `<p><em>${escapeHtml(ui('Answer relevance'))} ${
          formatScore(message.quality.answerRelevance)
        } &middot; ${escapeHtml(ui('Groundedness'))} ${
          formatScore(message.quality.groundedness)
        } &middot; ${escapeHtml(ui('Context relevance'))} ${
          formatScore(message.quality.contextRelevance)
        }</em></p>`
        : ''
      return `${bodyHtml}${citationsHtml}${qualityHtml}`
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
h3 { font-size: 11.5pt; margin-top: 12pt; margin-bottom: 4pt; }
h4 { font-size: 11pt; margin-top: 10pt; margin-bottom: 4pt; }
p, li { margin: 6pt 0; font-size: 11pt; }
ol, ul { margin: 6pt 0 6pt 18pt; }
table { border-collapse: collapse; margin: 8pt 0; }
th, td { border: 1px solid #999999; padding: 3pt 6pt; font-size: 10.5pt; vertical-align: top; }
blockquote { margin: 6pt 0 6pt 12pt; color: #444444; }
sup { font-size: 8pt; }
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
  const { ui, language } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const access = useAccess()
  const storage = useMemo(() => createResearchStorageContext(access.controller, config.slug), [
    access.controller,
    access.generation,
    config.slug,
  ])

  const permits = (
    permission: 'portal.ask' | 'portal.generate' | 'portal.export' | 'behaviour.write',
  ) =>
    researchStorageCurrent(storage) &&
    access.controller.can(permission, { kind: 'portal', slug: config.slug })
  const canAsk = permits('portal.ask')
  const canGenerate = permits('portal.generate')
  const canExport = permits('portal.export')
  const canInspectDiagnostics = permits('behaviour.write')
  // Monotonic selection lifetime also rejects A-to-B-to-A callbacks.
  const sessionLifetime = useRef(new AbortController())
  const retireSession = () => {
    sessionLifetime.current.abort()
    sessionLifetime.current = new AbortController()
    abortRef.current?.abort()
    followUpAbortRef.current?.abort()
  }

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions(storage))
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
  const [questionExpanded, setQuestionExpanded] = useState(false)
  useEffect(() => {
    setSubHeaderHidden(false)
  }, [questionExpanded])

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
  const sessionButtonRef = useRef<HTMLButtonElement | null>(null)
  // Guards the `?ask=` handoff from Explore against a double-send (React 18
  // Strict Mode replays effects) and resets whenever the tenant changes.
  const askHandledRef = useRef(false)
  // Debounced per-session background sync to the server, keyed by session id.
  const syncTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useLayoutEffect(() => {
    const clear = () => {
      retireSession()
      abortRef.current?.abort()
      followUpAbortRef.current?.abort()
      for (const timer of syncTimersRef.current.values()) clearTimeout(timer)
      syncTimersRef.current.clear()
      deletedIdsRef.current.clear()
      setSessions([])
      setMessages([])
      setDraft('')
      setActiveSessionId(null)
      setFollowUps(null)
    }
    const unregister = registerResearchCleanup(storage, clear)
    return () => {
      unregister()
      clear()
    }
  }, [storage])
  const composerRef = useRef<HTMLFormElement | null>(null)
  /** The element that actually scrolls below `lg` - see the wrapper's comment. */
  const scrollWrapRef = useRef<HTMLDivElement | null>(null)
  const subHeaderRef = useRef<HTMLDivElement | null>(null)

  /**
   * Below `lg` the composer is a pinned bar and the layout is a single column;
   * from `lg` up the sessions rail is beside the thread and the composer is an
   * ordinary block. A media query rather than a resize listener, because the
   * three things it drives (the pinned bar, the shorter placeholder, the hidden
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

  const { data: storedSuggestions } = useQuery({
    queryKey: ['suggested-questions', config.slug],
    queryFn: () => getSuggestedQuestions(config.slug),
  })
  const suggestions = storedSuggestions && portalStarterQuestions(config, storedSuggestions)

  /**
   * Fire-and-forget push of one session to the server, debounced so a burst
   * of edits (streaming deltas, renames) collapses into a single request.
   * Anonymous public history also persists locally. Signed history stays in
   * memory when server sync fails; it is never copied into browser storage.
   */
  function scheduleServerSync(session: ChatSession) {
    if (!permits('portal.ask')) return
    const timers = syncTimersRef.current
    const existing = timers.get(session.id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(session.id)
      if (!permits('portal.ask')) return
      void putServerSession(config.slug, {
        id: session.id,
        title: sessionTitle(session, ui),
        updatedAt: new Date(session.updatedAt).toISOString(),
        messages: session.messages,
      }).catch(() => {
        // Anonymous history can persist locally; signed history remains ephemeral.
      })
    }, 1500)
    timers.set(session.id, timer)
  }

  useEffect(() => {
    if (!isCompact) setShowSidebar(false)
  }, [isCompact])

  // The sessions dialog traps keyboard focus and returns it to its opener.
  useEffect(() => {
    if (!showSidebar || !isCompact) return
    const drawer = sidebarDrawerRef.current
    drawer?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setShowSidebar(false)
      if (event.key !== 'Tab' || !drawer) return
      const controls = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
      ))
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      sessionButtonRef.current?.focus()
    }
  }, [showSidebar, isCompact])

  // Re-load sessions if the tenant slug changes, then merge in any
  // server-side sessions this browser doesn't have locally yet (or that are
  // newer on the server) - background, silent-fail so offline use is
  // unaffected.
  useEffect(() => {
    if (!canAsk) return
    const localSessions = loadSessions(storage)
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
        if (cancelled || !researchStorageCurrent(storage)) return
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
        if (cancelled || !researchStorageCurrent(storage)) return
        setSessions((prev) => {
          if (!researchStorageCurrent(storage)) return []
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
          saveSessions(storage, merged, deletedIdsRef.current)
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
  }, [config.slug, storage, canAsk])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  // Explore's hero hands a question off here via `?ask=`. Consume it once:
  // strip the param from the URL and auto-send it as a new message, but
  // never while a stream is already running - the effect simply retries on
  // the next isStreaming change since the ref isn't set until it succeeds.
  useEffect(() => {
    const ask = searchParams.get('ask')
    if (
      !permits('portal.ask') || !ask || ask.trim().length === 0 || askHandledRef.current ||
      isStreaming
    ) return
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

  /**
   * Drop a session that never received an answer - the pending turn may have
   * been saved when the question was sent, and an error card is not a
   * research-trail entry.
   */
  function forgetSession(sessionId: string) {
    setSessions((prev) => {
      if (!researchStorageCurrent(storage)) return []
      const existing = prev.find((session) => session.id === sessionId)
      if (!existing || hasAnsweredTurn(existing.messages)) return prev
      const next = prev.filter((session) => session.id !== sessionId)
      deletedIdsRef.current.add(sessionId)
      saveSessions(storage, next, deletedIdsRef.current)
      const timer = syncTimersRef.current.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        syncTimersRef.current.delete(sessionId)
      }
      return next
    })
    if (activeSessionId === sessionId) {
      // Keep the thread on screen; a retry starts a fresh trail entry.
      setActiveSessionId(null)
    }
  }

  function persist(nextMessages: ChatMessage[], sessionId: string) {
    setSessions((prev) => {
      if (!researchStorageCurrent(storage)) return []
      const existing = prev.find((session) => session.id === sessionId)
      const now = Date.now()
      const updatedSession: ChatSession = existing
        ? { ...existing, messages: nextMessages, updatedAt: now }
        : { id: sessionId, createdAt: now, updatedAt: now, messages: nextMessages }
      const rest = prev.filter((session) => session.id !== sessionId)
      const next = [updatedSession, ...rest].slice(0, SESSION_CAP)
      saveSessions(storage, next, deletedIdsRef.current)
      scheduleServerSync(updatedSession)
      return next
    })
  }

  function startNewSession() {
    if (isStreaming) return
    retireSession()
    setActiveSessionId(null)
    setMessages([])
    setFollowUps(null)
    setShowSidebar(false)
  }

  function deleteSession(id: string) {
    if (!permits('portal.ask')) return
    if (isStreaming) return
    deletedIdsRef.current.add(id)
    setSessions((prev) => {
      if (!researchStorageCurrent(storage)) return []
      const next = prev.filter((session) => session.id !== id)
      saveSessions(storage, next, deletedIdsRef.current)
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
      retireSession()
      setActiveSessionId(null)
      setMessages([])
      setFollowUps(null)
    }
  }

  function selectSession(id: string) {
    if (isStreaming) return
    const session = sessions.find((item) => item.id === id)
    if (!session) return
    retireSession()
    setActiveSessionId(id)
    setMessages(session.messages.map((message) => ({ ...message, pending: false })))
    // Follow-ups belong to the answer they were generated from, and a restored
    // session's last answer was generated in another sitting.
    setFollowUps(null)
    setShowSidebar(false)
  }

  /** Sets a custom session name, overriding the auto-title, and syncs it to the server. */
  function renameSession(id: string, title: string) {
    if (!permits('portal.ask')) return
    setSessions((prev) => {
      if (!researchStorageCurrent(storage)) return []
      const next = prev.map((session) => session.id === id ? { ...session, title } : session)
      saveSessions(storage, next, deletedIdsRef.current)
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
    if (!permits('portal.generate')) return
    const lifetime = sessionLifetime.current.signal
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
        AbortSignal.any([controller.signal, lifetime]),
      )
      if (controller.signal.aborted || lifetime.aborted || !permits('portal.generate')) return
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
    options?: {
      depth?: 'default' | 'deep'
      prequeries?: string[]
      deepBadge?: boolean
      /** A decision already made (an override from the route chip). */
      route?: RouteDecision
    },
  ) {
    if (!permits('portal.ask') || (options?.depth === 'deep' && !permits('portal.generate'))) return
    const lifetime = sessionLifetime.current.signal
    // A new answer retires the last answer's follow-ups the moment it starts,
    // and closes the previous stream if its trailing quality scores are
    // still arriving (the composer is released on `done`, not at close).
    followUpAbortRef.current?.abort()
    followUpAbortRef.current = null
    abortRef.current?.abort()
    setFollowUps(null)
    const answerId = makeId()
    // baseMessages ends with the question being asked (as a USER message) - the
    // request sends that as `query`, so prior turns exclude it here.
    // Each earlier answer carries the resources it cited, so a figure the
    // follow-up repeats is checked against those papers and they are
    // retrieved again (D3-06).
    const contextTurns = baseMessages
      .slice(0, -1)
      .filter((message) => !message.error)
      .map((message) => {
        const resourceIds = [...new Set(message.citations.map((c) => c.resourceId))].slice(0, 12)
        // The passages the cited papers were quoted for: a follow-up that
        // reshapes or leans on this answer reads them again (D4-06, D4-07).
        const passages = message.sources
          .filter((s) => resourceIds.includes(s.id) && (s.matchedPassage ?? '').trim().length > 0)
          .map((s) => (s.matchedPassage ?? '').slice(0, 2000))
          .slice(0, 12)
        return {
          author: message.author,
          text: message.text,
          ...(resourceIds.length > 0 ? { resourceIds } : {}),
          ...(passages.length > 0 ? { passages } : {}),
        }
      })

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

    const current = () =>
      !lifetime.aborted && abortRef.current === controller && permits('portal.ask')

    function update(mutate: (message: ChatMessage) => ChatMessage) {
      if (!current()) return
      working = working.map((message) => message.id === answerId ? mutate(message) : message)
      setMessages(working)
    }

    // Routing: which stored configuration answers this question. A choice
    // already made (the route chip's override) is passed as the intent;
    // otherwise the server routes inside the ask itself - rules at once,
    // the classifier beside retrieval rather than ahead of it - and reports
    // the decision as a `route` event, so no round trip precedes the answer.
    const route = options?.route
    const autoRoute = !route && (config.intents?.length ?? 0) > 0 && contextTurns.length === 0
    if (route) update((message) => ({ ...message, route }))

    try {
      await streamAsk(
        config.slug,
        {
          query,
          context: contextTurns,
          depth: options?.depth,
          prequeries: options?.prequeries,
          ...(route ? { intent: route.intent } : {}),
          ...(autoRoute ? { route: 'auto' as const } : {}),
        },
        (event: AskEvent) => {
          if (!current()) return
          switch (event.type) {
            case 'route':
              update((message) => ({ ...message, route: event.decision }))
              break
            case 'verified':
              update((message) => ({
                ...message,
                verified: { sentence: event.sentence, title: event.title },
              }))
              break
            case 'stage':
              if (event.status === 'started') {
                setActiveStage(event.stage)
              } else {
                setSeenStages((prev) => new Set(prev).add(event.stage))
              }
              // The streamed text is on screen but not yet checked: say so
              // where the audit badge will land, with the count of figures
              // under check, until `done` carries the gated text (D2-17).
              if (event.stage === 'auditing') {
                const figures = event.status === 'started' ? (event.figures ?? 0) : undefined
                update((message) => ({ ...message, checking: figures }))
              }
              break
            // The answer itself - text, citations, sources, quality, audit - is
            // folded exactly as Search folds it (lib/answer-trust.ts), so one
            // stream gives both pages the same confidence and the same marks.
            case 'sources':
            case 'delta':
            case 'citation':
            case 'quality':
            case 'audit':
              update((message) => applyAnswerEvent(message, event))
              break
            case 'answer-record':
              update((message) => ({ ...message, answerRecordId: event.answerId }))
              break
            case 'learning':
              update((message) => ({ ...message, learningId: event.id }))
              break
            case 'interpreted':
              update((message) => ({ ...message, interpretedQuery: event.query }))
              break
            case 'fallback':
              // A fresh answer follows on another configuration: whatever
              // the first attempt streamed (its decline copy, its sources)
              // is discarded so the two never read as one answer.
              update((message) => ({
                ...applyAnswerEvent(message, event),
                fallback: { from: event.from, to: event.to, reason: event.reason },
              }))
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
            case 'done':
              update((message) => ({
                // event.text is the deterministically citation-bound answer
                // (the model's own [n] markers stripped and replaced with
                // markers spliced at the platform's own char-offsets) - it
                // replaces the streamed text so the final prose, the
                // evidence table badges and the click-through targets all
                // agree on what each [n] means. Falls back to the streamed
                // text when absent (e.g. a refusal, which carries no citations).
                ...applyAnswerEvent(message, event),
                pending: false,
                checking: undefined,
                verified: undefined,
              }))
              // The answer is complete here; the quality scores follow on
              // the same stream a few seconds later. The composer is
              // released now rather than at stream close so the reader is
              // never made to wait on the judge - and the trail entry is
              // saved now too, so the sessions rail lists it with the answer
              // rather than when the tail closes the stream (D2-19). The
              // close-time save below carries the scores in.
              setIsStreaming(false)
              setActiveStage(null)
              if (hasAnsweredTurn(working)) persist(working, sessionId)
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
      if (!current()) return
      if (controller.signal.aborted) {
        update((existing) =>
          existing.text.length > 0
            ? { ...existing, pending: false }
            : { ...existing, pending: false, error: ui('Stopped before an answer arrived.') }
        )
      } else if (thrown instanceof ApiError && thrown.status === 429) {
        // The server asked us to wait: the card counts down and retries.
        update((existing) => ({
          ...existing,
          pending: false,
          error: thrown.message,
          rateLimited: thrown.code !== 'ask_quota_exceeded',
          retryAfterSec: thrown.retryAfterSec,
        }))
      } else {
        const message = thrown instanceof Error
          ? thrown.message
          : ui('We could not complete this answer - try again.')
        update((existing) => ({ ...existing, pending: false, error: message }))
      }
    } finally {
      if (current()) {
        setIsStreaming(false)
        setActiveStage(null)
        setSeenStages(new Set())
        abortRef.current = null
        // A trail entry is an answer, not a failed transport: a session whose
        // only assistant turns are errors is not saved (and is dropped again
        // if an earlier save of the pending turn already wrote it).
        if (hasAnsweredTurn(working)) persist(working, sessionId)
        else forgetSession(sessionId)
        // After the answer, never during it - and never after a Stop, which is
        // the reader saying they have finished with this question.
        if (!controller.signal.aborted) {
          void requestFollowUps(working.find((message) => message.id === answerId), query)
        }
      }
    }
  }

  async function send(query: string) {
    const trimmed = query.trim()
    if (!permits('portal.ask') || trimmed.length === 0 || isStreaming) return
    const lifetime = sessionLifetime.current.signal

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

    if (deepResearch && permits('portal.generate')) {
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
        const result = await getSubqueries(
          config.slug,
          trimmed,
          AbortSignal.any([mappingController.signal, lifetime]),
        )
        subqueries = Array.isArray(result.questions) ? result.questions : []
      } catch {
        subqueries = []
      }
      if (lifetime.aborted || !permits('portal.generate')) return
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
    if (!permits('portal.ask')) return
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
    if (!permits('portal.ask') || !permits('portal.generate')) return
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

  /** Re-ask the same question under another intent, chosen from the route chip. */
  function reroute(question: string, forMessageId: string, intentId: string) {
    if (!permits('portal.ask') || isStreaming || !question.trim()) return
    const intent = (config.intents ?? []).find((i) => i.id === intentId)
    if (!intent) return
    const isDefault = intentId === config.defaultIntent
    const route: RouteDecision = {
      intent: intentId,
      confidence: 1,
      stage: 'override',
      rationale: ui('{label}: chosen by you', { label: intent.label }),
      configuration: isDefault ? 'portal-ask' : `portal-intent-${intentId}`,
      entities: messages.find((m) => m.id === forMessageId)?.route?.entities ?? [],
    }
    const userMessage: ChatMessage = {
      id: makeId(),
      author: 'USER',
      text: question,
      citations: [],
      sources: [],
    }
    const baseMessages = [...messages, userMessage]
    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)
    setMessages(baseMessages)
    void runAsk(question, baseMessages, sessionId, { route })
  }

  /**
   * Posts feedback for the platform's learning loop and, on success, marks
   * the message so the UI collapses to a quiet "thanks" state. Returns
   * whether it succeeded so the (per-message) control can show its own
   * unobtrusive error text on failure without crashing anything.
   */
  async function sendFeedback(messageId: string, good: boolean, text?: string): Promise<boolean> {
    if (!permits('portal.ask')) return false
    const lifetime = sessionLifetime.current.signal
    const message = messages.find((item) => item.id === messageId)
    const sessionId = activeSessionId
    if (!message?.learningId || !sessionId) return false
    try {
      await sendAnswerFeedback(
        config.slug,
        { learningId: message.learningId, good, text },
        lifetime,
      )
      if (lifetime.aborted || !permits('portal.ask')) return false
      setMessages((prev) => {
        if (lifetime.aborted || !permits('portal.ask')) return prev
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
    if (!sessionId || !permits('portal.generate')) return
    const lifetime = sessionLifetime.current.signal
    setMessages((prev) => {
      if (lifetime.aborted || !permits('portal.generate')) return prev
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
  const { notice: exportNotice, announce: announceExport } = useExportNotice()
  const exportNoticeLifetime = useRef<AbortSignal | null>(null)
  async function exportSession() {
    if (!permits('portal.export') || isStreaming || !hasAnsweredTurn(messages)) return
    const authority = researchExportAuthority(access.controller, config.slug)
    const lifetime = sessionLifetime.current.signal
    const title = currentSessionTitle()
    try {
      const filename = await exportResearchFile({ ...authority, signal: lifetime }, () => ({
        parts: [
          '\uFEFF',
          sessionToWordHtml(
            config.branding.productName,
            title,
            messages,
            (resourceId) =>
              `${globalThis.location.origin}/t/${config.slug}/library/${
                encodeURIComponent(resourceId)
              }`,
            ui,
            language,
          ),
        ],
        type: 'application/msword',
        filename: `${slugOrDate(title)}.doc`,
      }))
      if (!lifetime.aborted && permits('portal.export')) {
        exportNoticeLifetime.current = lifetime
        announceExport(savedFileNotice(filename, ui('Word document'), ui))
      }
    } catch {
      // An obsolete or incomplete export has no file or success notice.
    }
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

  const firstQuestion = messages.find((message) => message.author === 'USER')
  const headingText = sessionHeading({
    messages,
    title: sessions.find((session) => session.id === activeSessionId)?.title,
  }, ui)
  const isEmpty = messages.length === 0
  const lastMessage = messages[messages.length - 1]
  // The latest settled answer and the question it answered, for the wide
  // display's sources rail. The rail is a layout affordance: the same
  // sources still sit in the answer's own evidence disclosure.
  const railAnswerIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.author === 'AGENT' && !m.pending && m.sources.length > 0) return i
    }
    return -1
  })()
  const railAnswer = railAnswerIndex >= 0 ? messages[railAnswerIndex] : undefined
  const railQuestion = railAnswerIndex > 0 ? messages[railAnswerIndex - 1]?.text ?? '' : ''
  const railSources: EvidenceSource[] = (railAnswer?.sources ?? []).map((source) => ({
    id: source.id,
    title: source.title,
    passage: source.matchedPassage,
    score: source.relevance,
    matchedPage: source.matchedPage,
    referenceChunk: source.referenceChunk,
    published: source.published,
    sourceName: source.sourceName,
    type: source.type,
    matchedField: source.matchedField,
  }))
  const liveMessage = isStreaming
    ? ui('Answer in progress')
    : lastMessage?.author === 'AGENT' && !lastMessage.pending
    ? lastMessage.error && !lastMessage.text.trim()
      ? (lastMessage.rateLimited
        ? ui('The portal is busy - retrying shortly')
        : ui('Answer unavailable'))
      // Said once, when the answer settles - never per streamed chunk - with what came back,
      // so a screen reader hears the sources and citations that appear with it (WCAG 4.1.3).
      : `${ui('Answer complete')} ${
        ui('{retrieved} sources retrieved, {cited} cited.', {
          retrieved: lastMessage.sources.length,
          cited: lastMessage.citations.length,
        })
      }`
    : ''

  return (
    <main
      aria-label={ui('Ask')}
      className='rp-answer-page mx-auto flex h-[calc(100dvh-var(--rp-header-h,126px))] max-w-[100rem] flex-col gap-3 px-4 pt-4 pb-0 sm:px-6 sm:pt-6 lg:flex-row lg:gap-6 lg:pb-6 2xl:gap-8'
    >
      <aside
        aria-label={ui('Chat sessions')}
        className='hidden w-64 min-w-0 max-w-[22%] shrink-0 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-3 lg:flex 2xl:w-72'
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

      {showSidebar && isCompact
        ? (
          <div
            role='dialog'
            aria-modal='true'
            aria-label={ui('Sessions')}
            className='fixed inset-0 z-[60] flex lg:hidden'
          >
            <button
              type='button'
              aria-label={ui('Close sessions')}
              onClick={() => setShowSidebar(false)}
              className='rp-scrim flex-1'
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
          // A control reached by Tab scrolls into view above the pinned composer, not under it
          // (WCAG 2.4.11): at 200% zoom the bar takes about a third of the screen.
          style={isCompact
            ? { scrollPaddingBottom: composerHeight + keyboardInset + 12 }
            : undefined}
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
                style={isCompact && !questionExpanded && subHeaderHidden
                  ? { transform: 'translateY(-100%)' }
                  : undefined}
                className={`z-20 mb-6 shrink-0 bg-[var(--rp-app)] pb-2 transition-transform duration-300 ease-out motion-reduce:transition-none lg:static lg:bg-transparent lg:pb-0 ${
                  questionExpanded ? 'relative' : 'sticky top-0'
                }`}
              >
                <QuestionHeading
                  question={headingText}
                  onExpandedChange={setQuestionExpanded}
                  actions={canExport
                    ? (
                      <button
                        type='button'
                        onClick={exportSession}
                        disabled={isStreaming || !hasAnsweredTurn(messages)}
                        title={isStreaming
                          ? ui('Export is available once the answer has finished')
                          : ui(
                            'Save this research trail as a Word document with a numbered reference list',
                          )}
                        className='rp-btn rp-btn-ghost rp-btn-sm shrink-0 disabled:cursor-not-allowed'
                      >
                        <Download size='sm' />
                        {ui('Export')}
                      </button>
                    )
                    : null}
                />
                <ExportNotice
                  notice={canExport &&
                      exportNoticeLifetime.current === sessionLifetime.current.signal
                    ? exportNotice
                    : null}
                />
              </div>
            )
            : null}

          <section
            aria-label={ui('Conversation')}
            className='rp-scroll flex-1 pb-4 lg:overflow-y-auto'
          >
            {isEmpty
              ? (
                <div className='space-y-6 py-4 sm:py-8'>
                  <div className='max-w-2xl'>
                    <h1 className='rp-display text-2xl text-ink sm:text-3xl'>{ui('Ask')}</h1>
                    <p className='mt-2 text-sm leading-relaxed text-ink-2 sm:text-base'>
                      {ui("Ask a question and get an answer grounded in this portal's research.")}
                    </p>
                  </div>
                  {suggestions && suggestions.length > 0
                    ? (
                      <div>
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
                              <ArrowRight size='sm' className='rp-suggest-arrow' />
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
                <div className='space-y-4'>
                  {messages.map((message, index) =>
                    message.author === 'USER'
                      ? (
                        <UserBubble
                          key={message.id}
                          message={message}
                          showQuestion={message.id !== firstQuestion?.id ||
                            headingText !== message.text}
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
                          intents={config.intents ?? []}
                          canInspectDiagnostics={canInspectDiagnostics}
                          canGenerate={canGenerate}
                          canAsk={canAsk}
                          lifetime={sessionLifetime.current.signal}
                          onReroute={(intentId) =>
                            reroute(
                              messages[index - 1]?.author === 'USER'
                                ? messages[index - 1]?.text ?? ''
                                : '',
                              message.id,
                              intentId,
                            )}
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
                  {canGenerate && followUps && followUps.messageId === lastMessage?.id &&
                      !isStreaming
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
                          {ui('Ask next')}
                        </p>
                        <div className='mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap'>
                          {followUps.questions.map((question, index) => (
                            <button
                              key={question}
                              type='button'
                              onClick={() => void send(question)}
                              style={tailStyle(index + 1)}
                              className='rp-answer-tail rp-answer-followup rp-focus flex items-center gap-2 rounded-[var(--rp-radius-btn)] border border-line bg-surface px-3 py-2 text-left text-[0.8125rem] leading-snug font-medium text-[var(--rp-ink-2)] transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)] sm:max-w-[24rem]'
                            >
                              <span className='min-w-0'>{question}</span>
                              <ArrowRight size='sm' className='ml-auto shrink-0 text-ink-3' />
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
                    ref={sessionButtonRef}
                    onClick={() => setShowSidebar(true)}
                    className='rp-btn rp-btn-outline rp-btn-sm'
                  >
                    <History size='sm' />
                    {ui('Sessions')}
                  </button>
                )
                : null}
              {canGenerate
                ? (
                  <button
                    type='button'
                    onClick={() => {
                      if (permits('portal.generate')) setDeepResearch((prev) => !prev)
                    }}
                    disabled={isStreaming}
                    aria-pressed={deepResearch}
                    className='rp-btn rp-btn-outline rp-btn-sm'
                  >
                    <Search size='sm' />
                    {ui('Deep research')}
                  </button>
                )
                : null}
              {
                /* One-off explanation, and it wraps onto a line of its own at
                * 390px - a row the pinned bar would then charge to the thread
                * every time deep research is on. The chip's active state says
                * the same thing on a phone. */
              }
              {canGenerate && deepResearch
                ? (
                  <span className='hidden text-xs text-ink-3 lg:inline'>
                    {ui('Maps sub-questions before answering - slower, more thorough.')}
                  </span>
                )
                : null}
            </div>
            <div className='rp-field flex items-end gap-2 rounded-[calc(var(--rp-radius)+4px)] border bg-surface p-2 shadow-sm'>
              <label htmlFor='ask-composer' className='sr-only'>
                {ui('Ask a question')}
              </label>
              <textarea
                id='ask-composer'
                aria-describedby='ask-composer-hint'
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!canAsk || isStreaming}
                rows={1}
                placeholder={isCompact
                  ? ui('Ask a question')
                  : ui('Ask a question about this research')}
                className='rp-answer-composer max-h-40 min-w-0 flex-1 resize-none rounded-[var(--rp-radius)] border-0 bg-transparent px-2 py-2 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none disabled:opacity-60 lg:px-3'
              />
              {isStreaming
                ? (
                  <button
                    type='button'
                    onClick={stop}
                    className='rp-btn rp-btn-outline shrink-0'
                  >
                    {ui('Stop')}
                  </button>
                )
                : (
                  <button
                    type='submit'
                    disabled={!canAsk || draft.trim().length === 0}
                    className='rp-btn rp-btn-primary shrink-0'
                  >
                    {ui('Send')}
                  </button>
                )}
            </div>
            {
              /* Physical-keyboard guidance. On a phone there is no Shift+Enter
              * to give, and the row would cost the thread its own height in a
              * bar that is already pinned over it. A fine pointer keeps it at any
              * width, so a desktop reader zoomed to 200% still sees it (WCAG
              * 3.3.2); the field names it as its description either way. */
            }
            <p
              id='ask-composer-hint'
              className='mt-1.5 hidden px-1 text-xs text-ink-3 lg:block pointer-fine:block'
            >
              {ui('Enter to send · Shift+Enter for a new line')}
            </p>
          </form>
        </div>
      </div>

      {
        /* From `xl` up the right third of a wide display, which used to sit
        * empty beside a 75ch answer column, carries the latest answer's
        * sources. It scrolls on its own; the thread keeps its scrollbar. */
      }
      {railAnswer && railSources.length > 0
        ? (
          <aside
            aria-label={ui('Sources for the latest answer')}
            className='hidden min-h-0 w-80 min-w-0 max-w-[28%] shrink-0 flex-col xl:flex 2xl:w-96'
          >
            <div className='rp-scroll min-h-0 flex-1 overflow-y-auto rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-3'>
              {/* The table's own "Sources found" heading names the rail; the aside's label names the landmark. */}
              <div>
                <EvidenceTable
                  slug={config.slug}
                  question={railQuestion}
                  sources={railSources}
                  citations={railAnswer.citations}
                  answerId={railAnswer.answerId}
                  unlinked={railAnswer.unlinked}
                  verdicts={railAnswer.verdicts}
                  anchorPrefix={`rail-${railAnswer.id}`}
                  collapsible={false}
                />
              </div>
            </div>
          </aside>
        )
        : null}
    </main>
  )
}
