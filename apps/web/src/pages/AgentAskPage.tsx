import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAccess } from '../components/AccessProvider.tsx'
import { AgentAnswer } from '../components/AgentAnswer.tsx'
import { AgentSources } from '../components/AgentSources.tsx'
import { AgentSteps } from '../components/AgentSteps.tsx'
import { Check, Send, X } from '../components/icons.tsx'
import { Button, LiveStatus } from '../components/ui.tsx'
import { useAgentAnnouncements, useAgentAsk } from '../components/useAgentAsk.ts'
import { getTenants } from '../api/client.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { citationNumbers, stepTotal } from '../lib/agent-ask-state.ts'
import { runtimeHostPortal } from '../lib/portal-url.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

/** Questions the empty page offers, generic enough for any corpus of applied research. */
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
    timeout: ui('No answer arrived within five minutes, so the page stopped waiting.'),
    unavailable: ui('The portal could not start the answer. Try again in a moment.'),
    notOffered: ui('Agent ask is not set up on this portal.'),
  }), [ui])
  const agent = useAgentAsk({ slug: config.slug, canAsk: canAskNow, messages })
  const { state, streaming } = agent
  const announcement = useAgentAnnouncements(state, {
    step: (title) => title,
    failed: (labels) =>
      labels.length === 1
        ? ui('{label} could not be searched; the answer comes from the rest.', {
          label: labels[0] ?? '',
        })
        : ui('{count} collections could not be searched; the answer comes from the rest.', {
          count: labels.length,
        }),
    done: (citations, collections) =>
      ui('Answer complete: {citations} citations across {collections} collections.', {
        citations,
        collections,
      }),
    cancelled: ui('Stopped. Everything that had arrived is kept.'),
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
  const askLabel = streaming ? ui('Stop') : ui('Ask')

  return (
    <main
      aria-label={ui('Agent ask')}
      className='rp-agent-page rp-shell py-6 sm:py-8 lg:py-10'
      data-agent-page
    >
      <LiveStatus message={announcement} />
      <div className='rp-agent-layout'>
        <div className='min-w-0'>
          <div className='max-w-3xl'>
            <p className='rp-eyebrow text-ink-3'>{ui('Agent ask')}</p>
            <h1 className='rp-display mt-1 text-2xl text-ink sm:text-3xl'>
              {ui('Ask across the collections')}
            </h1>
            <p className='mt-2 text-sm leading-relaxed text-ink-2 sm:text-base'>
              {ui(
                "Ask a question across all of this portal's collections. Each step, and what each collection returned, is shown while the answer is written. Answers take one to two minutes.",
              )}
            </p>
          </div>

          <form onSubmit={onSubmit} className='mt-6' data-agent-form>
            <label htmlFor='agent-question' className='block text-sm font-medium text-ink'>
              {ui('Your question')}
            </label>
            <div className='rp-field mt-1.5 flex flex-col gap-2 rounded-[var(--rp-radius-input)] border bg-surface p-2 sm:flex-row sm:items-end'>
              <textarea
                id='agent-question'
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                maxLength={2000}
                aria-describedby='agent-question-hint'
                placeholder={ui('Ask one question across every collection')}
                className='rp-agent-composer min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none sm:text-sm'
              />
              <Button
                type={streaming ? 'button' : 'submit'}
                variant={streaming ? 'outline' : 'primary'}
                leadingIcon={streaming ? X : Send}
                onClick={streaming ? agent.stop : undefined}
                disabled={!canAsk}
                className='rp-agent-target shrink-0'
                data-agent-submit
              >
                {askLabel}
              </Button>
            </div>
            <p id='agent-question-hint' className='mt-1.5 text-xs leading-relaxed text-ink-2'>
              {ui('Enter sends; Shift+Enter starts a new line. Up to 2,000 characters.')}
            </p>

            {!onPortalHost && others.length > 0
              ? (
                <fieldset className='mt-4' data-agent-collections>
                  <legend className='text-sm font-medium text-ink'>
                    {ui('Collections to search')}
                  </legend>
                  <div className='mt-2 flex flex-wrap gap-2'>
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
                  </div>
                  <p className='mt-1.5 text-xs leading-relaxed text-ink-2'>
                    {ui(
                      "Each collection's owner decides whether it takes part. The answer lists which did.",
                    )}
                  </p>
                </fieldset>
              )
              : null}
          </form>

          {started && agent.question !== null
            ? (
              <div className='mt-6'>
                <AgentAnswer
                  state={state}
                  question={agent.question}
                  elapsedMs={agent.elapsedMs}
                  numbers={numbers}
                  onRetry={retry}
                />
              </div>
            )
            : (
              <section aria-labelledby='agent-examples-heading' className='mt-6'>
                <h2 id='agent-examples-heading' className='rp-eyebrow text-ink-3'>
                  {ui('Try a question')}
                </h2>
                <ul className='mt-3 flex flex-wrap gap-2'>
                  {EXAMPLE_QUESTIONS.map((question) => (
                    <li key={question} className='min-w-0 max-w-full'>
                      <button
                        type='button'
                        onClick={() => {
                          setDraft(question)
                          textareaRef.current?.focus()
                        }}
                        disabled={!canAsk}
                        className='rp-chip rp-agent-target h-auto whitespace-normal py-1.5 text-left'
                      >
                        {ui(question)}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
        </div>

        <aside
          aria-label={ui('How this answer is being made')}
          className='rp-agent-rail min-w-0 space-y-6'
          data-agent-rail
        >
          <AgentSteps
            steps={state.steps}
            status={state.status}
            now={agent.elapsedMs + startedAtOf(agent)}
            total={stepTotal(state)}
          />
          <AgentSources
            sources={state.sources}
            steps={state.steps}
            status={state.status}
            citations={state.citations}
            numbers={numbers}
          />
        </aside>
      </div>
    </main>
  )
}

/** The clock the steps count against: the moment the question was sent. */
function startedAtOf(agent: { elapsedMs: number }): number {
  return Date.now() - agent.elapsedMs
}
