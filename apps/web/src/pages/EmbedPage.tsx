import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AgentAskEvent, AgentSource, TenantConfig } from '@research-portal/core'
import { getTenantConfig, streamAgentAsk, streamAsk } from '../api/client.ts'
import { readSafePortalMetadata } from '../api/portal-metadata.ts'
import { useAccess } from '../components/AccessProvider.tsx'
import { platformBranding } from '../components/PortalAccessGate.tsx'
import { AnswerText, AuditBadge, TruncatedNotice } from '../components/AnswerInline.tsx'
import { AnswerMarkdown } from '../components/AnswerMarkdown.tsx'
import { citationLink } from '../components/AnswerStream.tsx'
import { Button } from '../components/ui.tsx'
import {
  createPortalLocale,
  localisePortalConfig,
  PortalLocaleContext,
  usePortalLocale,
  usePortalLocaleState,
} from '../lib/portal-locale.tsx'
import {
  tenantThemeVars,
  useBodyTheme,
  useTenantFonts,
  useTextScale,
  useViewerScheme,
} from '../lib/theme.ts'
import { applyAnswerEvent, EMPTY_ANSWER, type StreamedAnswer } from '../lib/answer-trust.ts'

type AgentCitation = Extract<AgentAskEvent, { type: 'citation' }> & {
  passage?: string
  resourceId?: string
}
type AgentAnswer = {
  text: string
  citations: AgentCitation[]
  sources: AgentSource[]
  failed: boolean
}
const EMPTY_AGENT: AgentAnswer = { text: '', citations: [], sources: [], failed: false }
const external = {
  target: '_blank',
  rel: 'noopener noreferrer',
  'aria-describedby': 'embed-new-tab',
} as const

/** A small agent answer renderer. Shares Ask's markdown; the agent page owns its richer UI. */
function PartnerAnswer({ answer }: { answer: AgentAnswer }) {
  const { ui } = usePortalLocale()
  const href = (citation: AgentCitation) => {
    const source = answer.sources.find((item) => item.id === citation.sourceId)
    return citation.url ??
      (source?.portal && citation.resourceId
        ? `/t/${encodeURIComponent(source.portal)}/library/${
          encodeURIComponent(citation.resourceId)
        }`
        : undefined)
  }
  return (
    <>
      <AnswerMarkdown
        text={answer.text}
        renderInline={(run, key) =>
          run.replace(/[ \t]+(?=\[[^\]\n]+\])/g, '\u2060').split(/(\[[^\]\n]+\])/g).map(
            (part, index) => {
              const citation = answer.citations.find((item) => `[${item.marker}]` === part)
              return citation
                ? (
                  <sup key={`${key}-${index}`}>
                    <a
                      className='rp-focus rp-embed-citation rounded-[var(--rp-radius-chip)] px-0.5 font-semibold text-accent-fg no-underline'
                      href={`#embed-source-${citation.marker}`}
                      onClick={(event) => {
                        if (
                          event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
                        ) return
                        const card = document.getElementById(`embed-source-${citation.marker}`)
                        if (!card) return
                        event.preventDefault()
                        card.focus({ preventScroll: true })
                        card.scrollIntoView({ block: 'nearest' })
                      }}
                      aria-label={ui('Source {index}, {title}', {
                        index: citation.marker,
                        title: citation.title,
                      })}
                    >
                      {part}
                    </a>
                  </sup>
                )
                : <span key={`${key}-${index}`}>{part}</span>
            },
          )}
      />
      {answer.failed && <p role='status'>{ui('Some partner collections could not be searched.')}
      </p>}
      <ol className='mt-5 space-y-4' aria-label={ui('Sources')}>
        {answer.citations.map((citation) => {
          const url = href(citation)
          const source = answer.sources.find((item) => item.id === citation.sourceId)
          return (
            <li
              key={citation.marker}
              id={`embed-source-${citation.marker}`}
              tabIndex={-1}
              className='rp-card rp-focus scroll-m-3 p-3'
            >
              <p className='text-xs text-ink-2'>{source?.label}</p>
              {url
                ? (
                  <a
                    className='rp-focus rp-embed-link text-accent-fg underline'
                    href={url}
                    {...external}
                  >
                    [{citation.marker}] {citation.title}
                  </a>
                )
                : <p>[{citation.marker}] {citation.title}</p>}
              {citation.passage && (
                <blockquote className='mt-2 text-sm text-ink-2'>{citation.passage}</blockquote>
              )}
            </li>
          )
        })}
      </ol>
    </>
  )
}

function EmbedAsk({ config, view }: { config: TenantConfig; view: string | null }) {
  const { ui, error: localError } = usePortalLocale()
  const access = useAccess()
  const canFederate = config.agentAsk === true &&
    (view ?? config.embedding?.defaultView) === 'federated'
  const [partners, setPartners] = useState(canFederate)
  const [query, setQuery] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<StreamedAnswer>(EMPTY_ANSWER)
  const [agent, setAgent] = useState<AgentAnswer>(EMPTY_AGENT)
  const [usedPartners, setUsedPartners] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const context = access.controller.context
  useEffect(() => () => abort.current?.abort(), [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim() || busy) return
    const controller = new AbortController()
    abort.current = controller
    setQuestion(query.trim())
    setAnswer(EMPTY_ANSWER)
    setAgent(EMPTY_AGENT)
    setUsedPartners(partners && canFederate)
    setError('')
    setBusy(true)
    let completed = false
    try {
      if (partners && canFederate) {
        const passages = new Map<string, { text: string; resourceId?: string }>()
        await streamAgentAsk(config.slug, { query: query.trim() }, (item) => {
          access.controller.assertCurrent(context)
          if (item.type === 'agent-sources') {
            for (const chunk of item.chunks) {
              passages.set(`${item.source.id}:${chunk.id}`, chunk)
            }
          }
          if (item.type === 'error') {
            throw new Error(ui('The answer could not be completed. Try again.'))
          }
          if (item.type === 'done') completed = true
          setAgent((value) => {
            if (item.type === 'agent-start') return { ...value, sources: item.sources }
            if (item.type === 'delta') return { ...value, text: value.text + item.text }
            if (item.type === 'done' && item.text !== undefined) {
              return { ...value, text: item.text }
            }
            if (item.type === 'sources-failed') return { ...value, failed: true }
            if (item.type === 'citation') {
              return {
                ...value,
                citations: [...value.citations, {
                  ...item,
                  passage: passages.get(`${item.sourceId}:${item.chunkId}`)?.text,
                  resourceId: passages.get(`${item.sourceId}:${item.chunkId}`)?.resourceId,
                }],
              }
            }
            return value
          })
        }, controller.signal)
      } else {
        await streamAsk(config.slug, { query: query.trim(), route: 'auto' }, (item) => {
          access.controller.assertCurrent(context)
          if (item.type === 'error') {
            throw new Error(ui('The answer could not be completed. Try again.'))
          }
          if (item.type === 'done') completed = true
          setAnswer((value) => applyAnswerEvent(value, item))
        }, controller.signal)
      }
      if (!completed) throw new Error(ui('The answer could not be completed. Try again.'))
    } catch (cause) {
      if (context !== access.controller.context) return
      if (partners && canFederate) setAgent(EMPTY_AGENT)
      setError(
        controller.signal.aborted
          ? ui('Answer stopped.')
          : localError(cause, 'The answer could not be completed. Try again.'),
      )
    } finally {
      if (context === access.controller.context) setBusy(false)
    }
  }
  return (
    <>
      <form onSubmit={submit} className='mt-6 space-y-4'>
        <label htmlFor='embed-question' className='block font-semibold'>
          {ui('Ask a research question')}
        </label>
        <textarea
          id='embed-question'
          className='rp-input min-h-[7rem] w-full resize-y'
          value={query}
          maxLength={2000}
          required
          onChange={(event) => setQuery(event.target.value)}
        />
        {canFederate && (
          <label className='rp-embed-link flex cursor-pointer items-center gap-3 text-sm'>
            <input
              type='checkbox'
              role='switch'
              checked={partners}
              disabled={busy}
              onChange={(event) => setPartners(event.target.checked)}
              className='rp-focus h-6 w-6 accent-[var(--rp-accent-line)]'
            />
            {ui('Search partner collections too')}
          </label>
        )}
        <div className='flex flex-wrap gap-3'>
          <Button type='submit' disabled={busy || !query.trim()}>{ui('Ask')}</Button>
          {busy && (
            <Button variant='outline' onClick={() => abort.current?.abort()}>{ui('Stop')}</Button>
          )}
        </div>
      </form>
      <p className='mt-4 text-sm text-ink-2' role='status' aria-live='polite'>
        {busy
          ? ui('Searching the collections...')
          : question
          ? error ? '' : ui('Answer ready. Sources follow the answer.')
          : ui('Answers are grounded in the selected collections. Check the cited sources.')}
      </p>
      {error && <p className='mt-3 text-sm text-[var(--rp-bad-ink)]' role='alert'>{error}</p>}
      {question && (
        <section
          aria-label={ui('Answer')}
          aria-busy={busy}
          className='mt-6 border-t border-line pt-5'
        >
          <h2 className='rp-display mb-4 break-words text-xl'>{question}</h2>
          {usedPartners
            ? busy || agent.citations.length
              ? <PartnerAnswer answer={agent} />
              : <p>{ui('No cited answer was available. Try another question.')}</p>
            : (
              <>
                {busy || answer.citations.length || answer.refused
                  ? (
                    <AnswerText
                      {...answer}
                      text={answer.text.replace(/[ \t]+(?=\[\d+\])/g, '\u2060')}
                      slug={config.slug}
                      streaming={busy}
                      citationSourceId={(citation) => `embed-source-${citation.index}`}
                    />
                  )
                  : <p>{ui('No cited answer was available. Try another question.')}</p>}
                <AuditBadge audit={answer.audit} />
                {answer.truncated && (
                  <TruncatedNotice
                    onAskAgain={() => document.getElementById('embed-question')?.focus()}
                  />
                )}
                <ol className='mt-5 space-y-4' aria-label={ui('Sources')}>
                  {answer.citations.map((citation) => (
                    <li
                      key={citation.index}
                      id={`embed-source-${citation.index}`}
                      tabIndex={-1}
                      className='rp-card rp-focus scroll-m-3 p-3'
                    >
                      <a
                        className='rp-focus rp-embed-link text-accent-fg underline'
                        href={citationLink(
                          config.slug,
                          citation,
                          answer.sources.find((source) => source.id === citation.resourceId),
                        )}
                        {...external}
                      >
                        [{citation.index}] {citation.title}
                      </a>
                      <blockquote className='mt-2 text-sm text-ink-2'>
                        {citation.passage}
                      </blockquote>
                    </li>
                  ))}
                </ol>
              </>
            )}
        </section>
      )}
    </>
  )
}

export function EmbedPage() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const access = useAccess()
  const allowed = access.can('portal.read', { kind: 'portal', slug })
  const full = useQuery({
    queryKey: ['tenant-config', slug],
    queryFn: () => getTenantConfig(slug),
    enabled: allowed,
    retry: false,
  })
  const safe = useQuery({
    queryKey: ['safe-embed-metadata', slug, access.generation],
    queryFn: async ({ signal }) =>
      readSafePortalMetadata(
        await fetch(`/api/t/${encodeURIComponent(slug)}/config`, { signal, cache: 'no-store' }),
        slug,
      ),
    enabled: access.state.status === 'ready' && !allowed,
    retry: false,
  }, access.safeClient)
  const explicitLanguage = params.get('lang') === 'ja'
    ? 'ja'
    : params.get('lang') === 'en'
    ? 'en'
    : undefined
  const preferred = usePortalLocaleState(full.data, explicitLanguage)
  const language = preferred.language
  const locale = useMemo(
    () => createPortalLocale(language, preferred.setLanguage, full.data?.copy),
    [language, preferred.setLanguage, full.data?.copy],
  )
  const config = full.data ? localisePortalConfig(full.data, language) : undefined
  const branding = config?.branding ??
    (safe.data ? { ...safe.data.branding, tagline: '' } : platformBranding)
  const { scheme: viewerScheme } = useViewerScheme(branding.defaultColourScheme)
  const scheme = branding.colourScheme === 'light' ? 'light' : viewerScheme
  useTenantFonts(branding)
  useTextScale(branding)
  useBodyTheme(branding, scheme)
  const { ui } = locale
  const parentOrigin = useRef<string | null>(null)
  useEffect(() => {
    document.title = `${ui('Ask')} | ${branding.productName}`
    document.documentElement.lang = language === 'ja' ? 'ja' : 'en-AU'
  }, [branding.productName, language])
  useEffect(() => {
    const focus = () =>
      document.querySelector<HTMLElement>('#embed-question, [data-embed-open]')?.focus()
    const message = (event: MessageEvent) => {
      if (event.source !== globalThis.parent || event.data?.type !== 'corpuskit-embed-focus') return
      parentOrigin.current = event.origin
      focus()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && parentOrigin.current) {
        globalThis.parent.postMessage({ type: 'corpuskit-embed-close' }, parentOrigin.current)
      }
    }
    globalThis.addEventListener('message', message)
    globalThis.addEventListener('keydown', escape)
    if (parentOrigin.current) focus()
    // A fresh access check remounts this page. Tell the launcher when the input is ready again.
    if ((config || safe.data) && globalThis.parent !== document.defaultView) {
      globalThis.parent.postMessage({ type: 'corpuskit-embed-ready' }, '*')
    }
    return () => {
      globalThis.removeEventListener('message', message)
      globalThis.removeEventListener('keydown', escape)
    }
  }, [!!config, !!safe.data])
  const loading = access.state.status === 'loading' || (allowed ? full.isPending : safe.isPending)
  const failed = access.state.status === 'unavailable' || full.isError || safe.isError
  const paused = config?.status === 'suspended' || safe.data?.status === 'suspended'
  const logo = config?.branding &&
    (scheme === 'dark'
      ? config.branding.logoDarkUrl ?? config.branding.logoUrl
      : config.branding.logoUrl)
  return (
    <PortalLocaleContext.Provider value={locale}>
      <main
        className='rp-tenant rp-embed min-h-screen bg-app p-5 text-ink sm:p-8'
        style={tenantThemeVars(branding, scheme)}
        data-colour-scheme={scheme}
        data-embed-page
      >
        <div className='mx-auto w-full max-w-[75ch]'>
          {logo && (
            <img
              src={logo}
              alt=''
              className='mb-5 h-auto max-w-full object-contain'
              style={{ width: config?.branding.logoMaxWidth ?? 240 }}
            />
          )}
          <span id='embed-new-tab' className='sr-only'>{ui('Opens in a new tab')}</span>
          <p className='rp-eyebrow text-ink-2'>{branding.organisation}</p>
          <h1 className='rp-display mt-2 break-words text-3xl'>{branding.productName}</h1>
          <p className='mt-3 text-sm text-ink-2'>{ui('Research assistant')}</p>
          {loading || failed || paused
            ? (
              <p className='mt-6' role='status'>
                {ui(
                  failed
                    ? 'Access could not be checked. Try again.'
                    : paused
                    ? 'This portal is temporarily paused. Contact your portal administrator for help.'
                    : 'Checking access...',
                )}
              </p>
            )
            : allowed && config
            ? (
              config.embedding?.enabled
                ? (
                  <EmbedAsk
                    key={`${slug}:${access.generation}`}
                    config={config}
                    view={params.get('view')}
                  />
                )
                : <p role='status'>{ui('Embedding is disabled for this portal.')}</p>
            )
            : (
              <div className='mt-6' data-embed-private role='status'>
                <h2 className='rp-display text-xl'>
                  {access.state.session?.authenticated
                    ? ui('{name} is unavailable', { name: branding.productName })
                    : ui('This portal requires sign-in.')}
                </h2>
                <p className='mt-3 text-sm text-ink-2'>
                  {ui(
                    access.state.session?.authenticated
                      ? 'You cannot open this portal with your current account.'
                      : 'Open the full portal in a new tab to sign in. Your browser may prevent sign-in inside an embedded frame.',
                  )}
                </p>
              </div>
            )}
          <a
            data-embed-open
            className='rp-focus rp-embed-link mt-6 inline-flex items-center gap-2 text-sm text-accent-fg underline'
            href={`/t/${encodeURIComponent(slug)}/ask`}
            {...external}
          >
            {ui('Open full portal')} <span className='sr-only'>{ui('Opens in a new tab')}</span>
            <span aria-hidden='true'>↗</span>
          </a>
          {(config
            ? !branding.layout?.footer || branding.layout.footer.poweredBy
            : document.querySelector<HTMLMetaElement>('meta[name=corpuskit-embed-credit]')
              ?.content !== 'off') && (
            <p className='mt-5 border-t border-line pt-4 text-xs text-ink-2'>
              <a
                className='rp-focus rp-embed-link inline-flex items-center underline'
                href='https://corpuskit.org'
                {...external}
              >
                {ui('Powered by CorpusKit')}
              </a>
            </p>
          )}
        </div>
      </main>
    </PortalLocaleContext.Provider>
  )
}
