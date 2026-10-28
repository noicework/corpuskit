import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAccess } from '../components/AccessProvider.tsx'
import { AgentAnswer } from '../components/AgentAnswer.tsx'
import { AgentAnswerExportButton } from '../components/AgentAnswerExport.tsx'
import { AgentSources } from '../components/AgentSources.tsx'
import { AgentSteps } from '../components/AgentSteps.tsx'
import { ArrowRight, Check } from '../components/icons.tsx'
import { LiveStatus } from '../components/ui.tsx'
import { useAgentAnnouncements, useAgentAsk } from '../components/useAgentAsk.ts'
import { getTenants } from '../api/client.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { citationNumbers, stepTotal } from '../lib/agent-ask-state.ts'
import { runtimeHostPortal } from '../lib/portal-url.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

/**
 * Seed questions for the empty page. The portal's own suggested questions are written for one
 * collection, so a question only one collection can answer would send a reader across all of
 * them for nothing; these span the kinds of research the collections hold between them.
 */
const EXAMPLE_QUESTIONS = [
  'How is a warmer climate changing pest and disease pressure?',
  'What triggers movement controls between growing areas?',
  'Which management changes does the research recommend for hot seasons?',
]

/**
 * Agent ask (docs/AGENT-ASK.md): one question, answered by the portal's retrieval agent or
 * composed by the portal across every collection the reader may use, watched step by step.
 * Route `/t/:slug/agent?q=<question>&run=1`: `q` prefills the question, `run=1` sends it at once.
 */
export function AgentAskPage() {
  const { ui } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const access = useAccess()
  const [searchParams, setSearchParams] = useSearchParams()
  const scope = { kind: 'portal' as const, slug: config.slug }
  const canAsk = access.can('portal.ask', scope)
  const canAskNow = () => access.controller.can('portal.ask', scope)
  // A portal's own hostname serves that portal alone: no directory, no cross-portal route.
  const onPortalHost = runtimeHostPortal() !== ''

  const directory = useQuery({
    queryKey: ['tenants', access.identityKey, access.generation],
    queryFn: getTenants,
    enabled: access.state.status === 'ready' && !onPortalHost,
  })
  const others = useMemo(
    () => (directory.data ?? []).filter((tenant) => tenant.slug !== config.slug),
    [directory.data, config.slug],
  )
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const selectedSlugs = [
    config.slug,
    ...others.filter((tenant) => !excluded.has(tenant.slug)).map((tenant) => tenant.slug),
  ]

  const messages = useMemo(() => ({
    timeout: ui(
      'No answer arrived within five minutes, so the page stopped waiting. The steps and passages found so far are kept. Try again, or ask a narrower question.',
    ),
    unavailable: ui(
      "The portal could not start this answer. Try again in a moment, or use Ask for this portal's collection.",
    ),
    dropped: ui(
      'The connection closed before the answer finished. What arrived is kept on this page. Try again in a moment.',
    ),
    notOffered: ui(
      "Agent ask is not set up on this portal. Use Ask to put your question to this portal's collection.",
    ),
  }), [ui])
  const agent = useAgentAsk({
    slug: config.slug,
    canAsk: canAskNow,
    identityKey: access.identityKey,
    messages,
  })
  const { state, streaming } = agent
  const announcement = useAgentAnnouncements(state, {
    step: (title) => title,
    failed: (labels) =>
      labels.length === 1
        ? ui('{label} could not be searched. The answer uses the other collections.', {
          label: labels[0] ?? '',
        })
        : ui('{count} collections could not be searched. The answer uses the others.', {
          count: labels.length,
        }),
    done: (citations, collections) =>
      citations === 0
        ? ui('Finished. No direct evidence found in the collections searched.')
        : citations === 1
        ? ui('Answer finished: 1 citation from 1 collection.')
        : collections === 1
        ? ui('Answer finished: {citations} citations from 1 collection.', { citations })
        : ui('Answer finished: {citations} citations from {collections} collections.', {
          citations,
          collections,
        }),
    cancelled: ui('Stopped. The steps and passages found so far are kept.'),
  })

  const [draft, setDraft] = useState(() => searchParams.get('q') ?? '')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const lastRunRef = useRef<{ query: string; slugs: string[] } | null>(null)

  function send(question: string) {
    const query = question.trim()
    if (!query || !canAsk || streaming) return
    setDraft(query)
    const run = { query, slugs: selectedSlugs }
    lastRunRef.current = run
    agent.ask(run)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('q', query)
      next.delete('run')
      return next
    }, { replace: true })
  }

  // `run=1` sends the prefilled question once: after access has resolved (an ask before that is
  // dropped), and after the directory has answered or failed, so the question spans every
  // collection it can. A refresh afterwards does not ask again.
  const runHandledRef = useRef(false)
  const directorySettled = access.state.status === 'ready' &&
    (onPortalHost || directory.isSuccess || directory.isError)
  useEffect(() => {
    if (runHandledRef.current || searchParams.get('run') !== '1') return
    const query = searchParams.get('q')?.trim()
    if (!query || !canAsk || !directorySettled) return
    runHandledRef.current = true
    send(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, canAsk, directorySettled])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    send(draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!streaming) send(draft)
    }
  }

  function retry() {
    const last = lastRunRef.current
    if (last) send(last.query)
  }

  const started = state.status !== 'idle'
  const numbers = useMemo(
    () => citationNumbers(state.text, state.citations),
    [state.text, state.citations],
  )
  // From `xl` the steps sit in a rail beside the answer, as the Ask page's sources do; below it
  // they follow the answer in the column, so a phone never carries two copies.
  const wide = useWideViewport()

  return (
    <main
      aria-label={ui('Agent ask')}
      className='rp-agent-page rp-answer-page mx-auto flex h-[calc(100dvh-var(--rp-header-h,126px))] max-w-[100rem] flex-col gap-3 px-4 pt-4 pb-0 sm:px-6 sm:pt-6 lg:flex-row lg:gap-6 lg:pb-6 2xl:gap-8'
      data-agent-page
    >
      {/* min-h-0 keeps a long answer inside the viewport-height main on a phone, as on Ask. */}
      <div className='flex w-full min-w-0 min-h-0 flex-1 flex-col'>
        <LiveStatus message={announcement} />
        <div className='rp-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:overflow-visible'>
          <section
            aria-label={ui('Answer')}
            className='rp-scroll flex-1 pb-4 lg:overflow-y-auto'
          >
            {!started
              ? (
                <div className='space-y-6 py-4 sm:py-8'>
                  <div className='max-w-2xl'>
                    <h1 className='rp-display text-2xl text-ink sm:text-3xl'>
                      {ui('Ask across the collections')}
                    </h1>
                    <p className='mt-2 text-sm leading-relaxed text-ink-2 sm:text-base'>
                      {ui(
                        "Ask a question across all of this portal's collections. An answer can take up to two minutes.",
                      )}
                    </p>
                  </div>
                  <div className='mt-4 grid gap-2.5 sm:grid-cols-2' data-agent-examples>
                    {EXAMPLE_QUESTIONS.map((question) => (
                      <button
                        key={question}
                        type='button'
                        onClick={() => send(ui(question))}
                        disabled={!canAsk}
                        className='rp-suggest-card'
                      >
                        <span className='rp-suggest-text'>{ui(question)}</span>
                        <ArrowRight size='sm' className='rp-suggest-arrow' />
                      </button>
                    ))}
                  </div>
                </div>
              )
              : (
                <div className='space-y-6 py-4'>
                  {/* The question is the page's heading once asked, with Export beside it, as on Ask. */}
                  <div className='flex flex-wrap items-start justify-between gap-3'>
                    <h1
                      className='rp-answer-question rp-display min-w-0 flex-1 text-xl text-ink lg:text-3xl'
                      title={agent.question ?? undefined}
                    >
                      {agent.question}
                    </h1>
                    {agent.record
                      ? (
                        <AgentAnswerExportButton
                          slug={config.slug}
                          portalName={config.branding.productName}
                          turns={[agent.record]}
                          busy={streaming}
                          className='shrink-0'
                        />
                      )
                      : null}
                  </div>
                  {agent.question !== null
                    ? (
                      <AgentAnswer
                        state={state}
                        question={agent.question}
                        elapsedMs={agent.elapsedMs}
                        numbers={numbers}
                        onRetry={retry}
                      />
                    )
                    : null}
                  {!wide
                    ? (
                      <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-3'>
                        <AgentSteps
                          steps={state.steps}
                          status={state.status}
                          now={agent.elapsedMs + startedAtOf(agent)}
                          total={stepTotal(state)}
                        />
                      </div>
                    )
                    : null}
                  <AgentSources
                    sources={state.sources}
                    steps={state.steps}
                    status={state.status}
                    citations={state.citations}
                    numbers={numbers}
                  />
                </div>
              )}
          </section>

          <form
            onSubmit={onSubmit}
            className='sticky bottom-0 z-10 mt-2 shrink-0 border-t border-line bg-[var(--rp-app)] pt-2 pb-2 lg:static lg:border-t-0 lg:bg-transparent lg:pt-0 lg:pb-0'
            data-agent-form
          >
            {!onPortalHost && others.length > 0
              ? (
                <fieldset className='mb-1.5 px-1' data-agent-collections>
                  <legend className='sr-only'>{ui('Portals to include')}</legend>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='rp-chip rp-chip-active rp-agent-target cursor-default'>
                      <Check size='sm' />
                      <span className='min-w-0'>
                        {config.branding.productName}
                        <span className='text-ink-2'>&middot; {ui('this portal')}</span>
                      </span>
                    </span>
                    {others.map((tenant) => {
                      const on = !excluded.has(tenant.slug)
                      return (
                        <button
                          key={tenant.slug}
                          type='button'
                          aria-pressed={on}
                          onClick={() =>
                            setExcluded((prev) => {
                              const next = new Set(prev)
                              if (next.has(tenant.slug)) next.delete(tenant.slug)
                              else next.add(tenant.slug)
                              return next
                            })}
                          className={`rp-chip rp-agent-target ${on ? 'rp-chip-active' : ''}`}
                        >
                          {on ? <Check size='sm' /> : null}
                          <span className='min-w-0'>{tenant.productName}</span>
                        </button>
                      )
                    })}
                    <span className='hidden text-xs text-ink-3 lg:inline'>
                      {ui(
                        'Each organisation decides whether its portal takes part, so a portal selected here may be left out. The collections searched show which took part.',
                      )}
                    </span>
                  </div>
                </fieldset>
              )
              : null}
            <div className='rp-field flex items-end gap-2 rounded-[calc(var(--rp-radius)+4px)] border bg-surface p-2 shadow-sm'>
              <label htmlFor='agent-question' className='sr-only'>
                {ui('Ask a question')}
              </label>
              <textarea
                id='agent-question'
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                maxLength={2000}
                aria-describedby='agent-question-hint'
                placeholder={ui('Ask a question about this research')}
                className='rp-answer-composer max-h-40 min-w-0 flex-1 resize-none rounded-[var(--rp-radius)] border-0 bg-transparent px-2 py-2 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none disabled:opacity-60 lg:px-3'
              />
              {/* One element for Send and Stop, so the focus never leaves it when the state flips. */}
              <button
                type={streaming ? 'button' : 'submit'}
                onClick={streaming ? agent.stop : undefined}
                disabled={!canAsk}
                className={`rp-btn shrink-0 ${streaming ? 'rp-btn-outline' : 'rp-btn-primary'}`}
                data-agent-submit
              >
                {streaming ? ui('Stop') : ui('Send')}
              </button>
            </div>
            <p id='agent-question-hint' className='mt-1.5 hidden px-1 text-xs text-ink-3 lg:block'>
              {ui('Enter to send · Shift+Enter for a new line')}
            </p>
          </form>
        </div>
      </div>

      {started && wide
        ? (
          <aside
            aria-label={ui('Steps')}
            className='hidden min-h-0 w-80 min-w-0 max-w-[28%] shrink-0 flex-col xl:flex 2xl:w-96'
            data-agent-rail
          >
            <div className='rp-scroll min-h-0 flex-1 overflow-y-auto rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-3'>
              <AgentSteps
                steps={state.steps}
                status={state.status}
                now={agent.elapsedMs + startedAtOf(agent)}
                total={stepTotal(state)}
              />
            </div>
          </aside>
        )
        : null}
    </main>
  )
}

/** The clock the steps count against: the moment the question was sent. */
function startedAtOf(agent: { elapsedMs: number }): number {
  return Date.now() - agent.elapsedMs
}

/** Tailwind's `xl` breakpoint (80rem): where the steps move from the column to the rail. */
const XL_BREAKPOINT = '(min-width: 80rem)'

function useWideViewport(): boolean {
  const query = () =>
    typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(XL_BREAKPOINT) : null
  const [wide, setWide] = useState(() => query()?.matches ?? true)
  useEffect(() => {
    const media = query()
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches)
    setWide(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return wide
}
