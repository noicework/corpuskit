import { type FormEvent, type ReactNode, useMemo, useRef, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import {
  type AskEvent,
  type Citation,
  DOC_PAGES,
  type DocPage,
  docPageById,
  docPagesByCategory,
} from '@research-portal/core'
import { streamDocsAsk } from '../api/client.ts'
import { ConfidenceIndicator, type QualityScores } from '../components/QualityGauge.tsx'
import { LiveStatus } from '../components/ui.tsx'
import { normaliseAnswerBullets } from '../lib/answer-text.ts'
import { parseDocBlocks } from '../lib/resource-view.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// The docs Markdown surface: block structure comes from the shared
// `parseDocBlocks` parser (so `*`/`-`/numbered lists, sub-bullets, mixed
// intro-plus-list blocks and headings all render properly, in authored pages
// and streamed help answers alike), with the docs page's own styling on top.
// When a citation resolver is supplied, `[n]` markers become links to the
// cited help page.
// ---------------------------------------------------------------------------

function renderInline(
  text: string,
  keyPrefix: string,
  citation?: (index: number) => ReactNode,
): ReactNode[] {
  // Split on bold spans first, then citation markers within the plain segments.
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, boldIndex): ReactNode[] => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return [<strong key={`${keyPrefix}-b${boldIndex}`}>{part.slice(2, -2)}</strong>]
    }
    if (!citation) return [<span key={`${keyPrefix}-t${boldIndex}`}>{part}</span>]
    return part.split(/(\[\d+\])/g).map((segment, segIndex) => {
      const match = /^\[(\d+)\]$/.exec(segment)
      const node = match?.[1] ? citation(Number(match[1])) : null
      return node ?? <span key={`${keyPrefix}-t${boldIndex}-${segIndex}`}>{segment}</span>
    })
  })
}

/** One accent-dot bullet row - the docs page's unordered list treatment. */
function DotBullet({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <li className='flex gap-2.5 text-[0.9375rem] leading-relaxed text-ink-2'>
      <span
        aria-hidden='true'
        className={`mt-2 shrink-0 rounded-full ${small ? 'h-1 w-1' : 'h-1.5 w-1.5'}`}
        style={{ backgroundColor: 'var(--rp-accent)' }}
      />
      <span>{children}</span>
    </li>
  )
}

function Markdown({
  text,
  citation,
}: {
  text: string
  citation?: (index: number) => ReactNode
}) {
  const blocks = parseDocBlocks(text)
  return (
    <div className='space-y-3.5'>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <h3 key={index} className='pt-1 font-display text-base font-semibold text-ink'>
                {renderInline(block.text, `h${index}`, citation)}
              </h3>
            )
          case 'list': {
            if (block.ordered) {
              return (
                <ol key={index} className='list-decimal space-y-1.5 pl-5 marker:text-ink-3'>
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} className='text-[0.9375rem] leading-relaxed text-ink-2'>
                      {renderInline(item.text, `ol${index}-${itemIndex}`, citation)}
                      {item.children.length > 0
                        ? (
                          <ul className='mt-1.5 space-y-1.5 pl-1'>
                            {item.children.map((child, childIndex) => (
                              <DotBullet key={childIndex} small>
                                {renderInline(
                                  child,
                                  `ol${index}-${itemIndex}-c${childIndex}`,
                                  citation,
                                )}
                              </DotBullet>
                            ))}
                          </ul>
                        )
                        : null}
                    </li>
                  ))}
                </ol>
              )
            }
            return (
              <ul key={index} className='space-y-1.5 pl-1'>
                {block.items.map((item, itemIndex) => (
                  <DotBullet key={itemIndex}>
                    {renderInline(item.text, `li${index}-${itemIndex}`, citation)}
                    {item.children.length > 0
                      ? (
                        <ul className='mt-1.5 space-y-1.5'>
                          {item.children.map((child, childIndex) => (
                            <DotBullet key={childIndex} small>
                              {renderInline(
                                child,
                                `li${index}-${itemIndex}-c${childIndex}`,
                                citation,
                              )}
                            </DotBullet>
                          ))}
                        </ul>
                      )
                      : null}
                  </DotBullet>
                ))}
              </ul>
            )
          }
          case 'quote':
            return (
              <blockquote
                key={index}
                className='border-l-2 border-line pl-3 text-[0.9375rem] italic leading-relaxed text-ink-2'
              >
                {renderInline(block.text, `q${index}`, citation)}
              </blockquote>
            )
          case 'code':
            return (
              <pre
                key={index}
                className='overflow-x-auto rounded-[var(--rp-radius)] bg-surface-2 p-3 text-xs leading-relaxed text-ink-2'
              >
                <code>{block.text}</code>
              </pre>
            )
          case 'table':
            return (
              <div key={index} className='overflow-x-auto'>
                <table className='w-full border-collapse text-sm'>
                  <thead>
                    <tr>
                      {block.headers.map((header, i) => (
                        <th
                          key={i}
                          className='border-b border-line px-3 py-2 text-left font-semibold text-ink'
                        >
                          {renderInline(header, `t${index}-h${i}`, citation)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            className='border-b border-line px-3 py-2 align-top text-ink-2'
                          >
                            {renderInline(cell, `t${index}-${r}-${c}`, citation)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return (
              <p key={index} className='text-[0.9375rem] leading-relaxed text-ink-2'>
                {renderInline(block.text, `p${index}`, citation)}
              </p>
            )
        }
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The Help assistant - a single-turn, streamed, cited answer scoped to the docs.
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<string, string> = {
  preprocessing: 'Reading your question…',
  retrieval: 'Searching the documentation…',
  generating: 'Writing the answer…',
  validating: 'Checking it…',
}

type AnswerState = {
  text: string
  citations: Citation[]
  quality?: QualityScores
  pending: boolean
  refused: boolean
  error?: string
}

function DocsAssistant({ slug }: { slug: string }) {
  const [draft, setDraft] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AnswerState | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Map a citation to the help page whose title matches, so a source chip in an
  // answer links straight to the relevant documentation page.
  const pageByTitle = useMemo(
    () => new Map(DOC_PAGES.map((page) => [page.title.toLowerCase(), page])),
    [],
  )

  function citationNode(citations: Citation[]) {
    return (index: number): ReactNode => {
      const citation = citations.find((item) => item.index === index)
      if (!citation) return null
      const page = pageByTitle.get(citation.title.toLowerCase())
      const label = (
        <sup className='font-semibold' style={{ color: 'var(--rp-accent-fg)' }}>[{index}]</sup>
      )
      return page
        ? (
          <Link
            key={`c${index}`}
            to={`/t/${slug}/help/${page.id}`}
            title={citation.title}
            className='no-underline'
          >
            {label}
          </Link>
        )
        : <span key={`c${index}`} title={citation.title}>{label}</span>
    }
  }

  async function run(query: string) {
    const trimmed = query.trim()
    if (trimmed.length === 0 || streaming) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setQuestion(trimmed)
    setDraft('')
    setStreaming(true)
    setStage(null)
    let state: AnswerState = { text: '', citations: [], pending: true, refused: false }
    setAnswer(state)
    const update = (patch: Partial<AnswerState>) => {
      state = { ...state, ...patch }
      setAnswer(state)
    }
    try {
      await streamDocsAsk(slug, { query: trimmed }, (event: AskEvent) => {
        switch (event.type) {
          case 'stage':
            setStage(event.status === 'started' ? STAGE_LABELS[event.stage] ?? null : null)
            break
          case 'delta':
            update({ text: state.text + event.text })
            break
          case 'citation':
            if (!state.citations.some((c) => c.index === event.citation.index)) {
              update({ citations: [...state.citations, event.citation] })
            }
            break
          case 'quality':
            update({
              quality: {
                answerRelevance: event.answerRelevance,
                groundedness: event.groundedness,
                contextRelevance: event.contextRelevance,
              },
            })
            break
          case 'done':
            update({
              text: event.text ?? state.text,
              pending: false,
              refused: Boolean(event.refused),
            })
            break
          case 'error':
            update({ pending: false, error: event.message })
            break
        }
      }, controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) {
        update({
          pending: false,
          error: err instanceof Error ? err.message : 'The help assistant could not answer.',
        })
      }
    } finally {
      setStreaming(false)
      setStage(null)
      abortRef.current = null
      update({ pending: false })
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(draft)
  }

  return (
    <section
      aria-label='Ask the documentation'
      className='rp-card overflow-hidden p-5 sm:p-6'
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <h2 className='font-display text-lg font-semibold text-ink'>How do I…?</h2>
        <p className='text-xs text-ink-3'>Answers drawn only from this documentation</p>
      </div>
      <form onSubmit={handleSubmit} className='mt-3'>
        <div className='flex flex-col gap-2 sm:flex-row'>
          <label htmlFor='docs-ask' className='sr-only'>
            Ask a question about using the portal
          </label>
          <input
            id='docs-ask'
            type='search'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder='e.g. How do I ask a question and see its sources?'
            className='rp-input h-11 min-w-0 flex-1'
          />
          {streaming
            ? (
              <button
                type='button'
                onClick={() => abortRef.current?.abort()}
                className='rp-btn rp-btn-outline h-11 shrink-0'
              >
                Stop
              </button>
            )
            : (
              <button
                type='submit'
                disabled={draft.trim().length === 0}
                className='rp-btn rp-btn-primary h-11 shrink-0'
              >
                Ask
              </button>
            )}
        </div>
      </form>

      <LiveStatus
        message={streaming ? 'Answer in progress' : answer && !answer.pending ? 'Answer ready' : ''}
      />

      {answer
        ? (
          <div className='mt-4 border-t border-line pt-4'>
            <p className='mb-2 text-sm font-medium text-ink'>{question}</p>

            {answer.pending && stage
              ? (
                <p className='mb-2 flex items-center gap-2 text-xs font-medium text-ink-3'>
                  <span
                    aria-hidden='true'
                    className='h-1.5 w-1.5 animate-pulse rounded-full'
                    style={{ backgroundColor: 'var(--rp-accent)' }}
                  />
                  {stage}
                </p>
              )
              : null}

            {answer.error
              ? (
                <div
                  className='rounded-[var(--rp-radius)] border p-3 text-sm'
                  style={{
                    borderColor: 'var(--rp-bad-line)',
                    background: 'var(--rp-bad-bg)',
                    color: 'var(--rp-bad-ink)',
                  }}
                >
                  {answer.error}
                </div>
              )
              : answer.text.length > 0
              ? (
                <Markdown
                  text={normaliseAnswerBullets(answer.text)}
                  citation={citationNode(answer.citations)}
                />
              )
              : answer.pending
              ? (
                <p className='flex items-center gap-2 text-sm text-ink-3'>
                  <span className='rp-dots' aria-hidden='true'>
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className='sr-only'>Working</span>
                </p>
              )
              : null}

            {!answer.pending && !answer.refused && answer.quality
              ? (
                <div className='mt-3'>
                  <ConfidenceIndicator quality={answer.quality} />
                </div>
              )
              : null}

            {!answer.refused && answer.citations.length > 0
              ? (
                <div className='mt-4 flex flex-wrap gap-1.5'>
                  {answer.citations.map((citation) => {
                    const page = pageByTitle.get(citation.title.toLowerCase())
                    const chip = (
                      <>
                        <span
                          className='inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-[var(--rp-on-accent)]'
                          style={{ backgroundColor: 'var(--rp-accent)' }}
                        >
                          {citation.index}
                        </span>
                        <span className='max-w-[12rem] truncate'>{citation.title}</span>
                      </>
                    )
                    return page
                      ? (
                        <Link
                          key={citation.index}
                          to={`/t/${slug}/help/${page.id}`}
                          className='rp-chip'
                        >
                          {chip}
                        </Link>
                      )
                      : <span key={citation.index} className='rp-chip'>{chip}</span>
                  })}
                </div>
              )
              : null}
          </div>
        )
        : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The documentation sidebar (table of contents).
// ---------------------------------------------------------------------------

function DocsNav({ slug, activeId }: { slug: string; activeId: string }) {
  const groups = useMemo(() => docPagesByCategory(), [])
  return (
    <nav aria-label='Documentation' className='space-y-5'>
      {groups.map((group) => (
        <div key={group.category}>
          <p className='rp-eyebrow px-2 text-ink-3'>{group.category}</p>
          <ul className='mt-1.5 space-y-0.5'>
            {group.pages.map((page) => {
              const isActive = page.id === activeId
              return (
                <li key={page.id}>
                  <Link
                    to={`/t/${slug}/help/${page.id}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`rp-focus block rounded-[var(--rp-radius-btn)] px-2 py-1.5 text-sm transition-colors duration-150 ${
                      isActive
                        ? 'font-medium text-ink'
                        : 'text-ink-2 hover:bg-[var(--rp-surface-2)] hover:text-ink'
                    }`}
                    style={isActive ? { backgroundColor: 'var(--rp-wash)' } : {}}
                  >
                    {page.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// The article.
// ---------------------------------------------------------------------------

function sectionAnchor(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function Article({ page }: { page: DocPage }) {
  return (
    <article className='rp-measure'>
      <header>
        <h1 className='font-display text-3xl font-semibold tracking-tight text-ink'>
          {page.title}
        </h1>
        <p className='mt-2 text-base leading-relaxed text-ink-2'>{page.summary}</p>
      </header>
      <div className='mt-8 space-y-8'>
        {page.sections.map((section) => (
          <section
            key={section.heading}
            id={sectionAnchor(section.heading)}
            className='scroll-mt-24'
          >
            <h2 className='font-display text-xl font-semibold text-ink'>{section.heading}</h2>
            <div className='mt-3'>
              <Markdown text={section.body} />
            </div>
          </section>
        ))}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DocsPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const { pageId } = useParams<{ pageId: string }>()
  const slug = config.slug

  const activePage = (pageId ? docPageById(pageId) : undefined) ?? DOC_PAGES[0]
  const [navOpen, setNavOpen] = useState(false)

  if (!activePage) {
    return (
      <main className='rp-shell py-12'>
        <p className='text-sm text-ink-2'>No documentation is available.</p>
      </main>
    )
  }

  return (
    <main className='rp-shell py-6 sm:py-8 lg:py-10'>
      <div className='mb-6'>
        <p className='rp-eyebrow text-ink-3'>Help</p>
        <h1 className='mt-1 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl'>
          {config.branding.productName} documentation
        </h1>
        <p className='mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-2'>
          Everything you need to use the portal - and a help assistant that answers your questions
          from these pages only.
        </p>
      </div>

      <div className='mb-8'>
        <DocsAssistant slug={slug} />
      </div>

      {/* Mobile: collapsible table of contents. */}
      <div className='mb-4 lg:hidden'>
        <button
          type='button'
          onClick={() => setNavOpen((open) => !open)}
          aria-expanded={navOpen}
          className='rp-btn rp-btn-outline h-10 w-full justify-between'
        >
          <span>Browse the documentation</span>
          <svg
            viewBox='0 0 20 20'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.7'
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
            className={`h-4 w-4 transition-transform duration-150 ${navOpen ? 'rotate-180' : ''}`}
          >
            <path d='M5 7.5l5 5 5-5' />
          </svg>
        </button>
        {navOpen
          ? (
            <div className='mt-3 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'>
              <DocsNav slug={slug} activeId={activePage.id} />
            </div>
          )
          : null}
      </div>

      <div className='grid grid-cols-1 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 2xl:grid-cols-[17rem_minmax(0,1fr)]'>
        <aside className='hidden lg:block'>
          <div className='pb-6 lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)] lg:max-h-[calc(100dvh_-_var(--rp-header-h,_4rem)_-_var(--spacing)_*_8)] lg:overflow-y-auto'>
            <DocsNav slug={slug} activeId={activePage.id} />
          </div>
        </aside>
        <div className='min-w-0'>
          <Article page={activePage} />
        </div>
      </div>
    </main>
  )
}
