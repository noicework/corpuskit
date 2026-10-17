import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { Intent } from '@research-portal/core'
import type { RouteDecision } from '../api/client.ts'
import { ChevronDown, Workflow } from './icons.tsx'

/**
 * The routing decision, made visible: which intent answered, why, and a menu
 * to re-ask under any other intent. Tokens only - no hard-coded colours.
 */
export function RouteChip(
  { decision, intents, onOverride, pending = false }: {
    decision: RouteDecision | undefined
    intents: Intent[]
    onOverride?: (intentId: string) => void
    /** Routing still in progress. */
    pending?: boolean
  },
) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLUListElement | null>(null)
  const menuId = useId()
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function menuKey(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') {
      triggerRef.current?.focus()
      setOpen(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
      ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  if (pending && !decision) {
    return (
      <span className='inline-flex items-center gap-1.5 text-xs text-ink-3' role='status'>
        <span
          className='inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-[var(--rp-accent-fg)]'
          aria-hidden='true'
        />
        {ui('Choosing the retrieval configuration…')}
      </span>
    )
  }
  if (!decision) return null
  const intent = intents.find((i) => i.id === decision.intent)
  const label = intent?.label ?? decision.intent
  const stage = decision.stage === 'rule'
    ? ui('rule')
    : decision.stage === 'classifier'
    ? ui('classified · {percent}%', { percent: Math.round(decision.confidence * 100) })
    : decision.stage === 'override'
    ? ui('chosen by you')
    : ui('default')
  const title = `${decision.rationale} · ${decision.configuration}${
    decision.rule ? ` · rule /${decision.rule}/` : ''
  }`
  const content = (
    <>
      <Workflow size='sm' className='shrink-0 text-[var(--rp-brand-fg)]' />
      <span className='min-w-0 break-words font-medium text-ink'>{label}</span>
      <span className='min-w-0 text-ink-3'>· {stage}</span>
      {onOverride ? <ChevronDown size='sm' className='shrink-0 text-ink-3' /> : null}
    </>
  )
  return (
    <div ref={ref} className='relative inline-flex max-w-full items-center gap-1.5'>
      {onOverride
        ? (
          <button
            ref={triggerRef}
            id={`${menuId}-trigger`}
            type='button'
            onClick={() => setOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setOpen(true)
              }
            }}
            title={title}
            aria-haspopup='menu'
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            className='rp-btn rp-btn-sm rp-btn-outline min-w-0'
          >
            {content}
          </button>
        )
        : <span title={title} className='rp-tag flex min-w-0 items-center gap-1.5'>{content}</span>}
      <span
        className='hidden min-w-0 max-w-[48ch] truncate text-xs text-ink-3 sm:inline'
        title={decision.rationale}
      >
        {decision.rationale}
      </span>
      {open && onOverride
        ? (
          <ul
            ref={menuRef}
            id={menuId}
            role='menu'
            aria-labelledby={`${menuId}-trigger`}
            onKeyDown={menuKey}
            className='rp-card rp-shadow-lg absolute left-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] p-1'
          >
            {intents.map((item) => (
              <li key={item.id} role='none'>
                <button
                  type='button'
                  role='menuitemradio'
                  aria-checked={item.id === decision.intent}
                  onClick={() => {
                    setOpen(false)
                    triggerRef.current?.focus()
                    if (item.id !== decision.intent) onOverride(item.id)
                  }}
                  className={`rp-focus flex min-h-[2.75rem] w-full flex-col items-start rounded-[var(--rp-radius-btn)] px-2.5 py-1.5 text-left text-sm hover:bg-[var(--rp-wash)] ${
                    item.id === decision.intent ? 'bg-[var(--rp-wash)]' : ''
                  }`}
                >
                  <span className='font-medium text-ink'>{item.label}</span>
                  <span className='text-xs text-ink-3'>{item.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )
        : null}
    </div>
  )
}

/** One line summarising an intent's retrieval policy, for compare mode and the Manage table. */
export function intentSummary(intent: Intent, ui: ResearchUi = englishResearchUi): string {
  const r = intent.retrieval
  const a = intent.answer
  const parts = [
    r.features.join(' + '),
    ui('top {count}', { count: r.topK }),
    r.reranker === 'noop' ? ui('no rerank') : ui('reranked'),
    r.only.length > 0
      ? ui('only {labels}', { labels: r.only.map((l) => l.label).join(', ') })
      : r.exclude.length > 0
      ? ui('excl. {labels}', { labels: r.exclude.map((l) => l.label).join(', ') })
      : ui('all research'),
    a.strategy === 'full'
      ? ui('full text')
      : a.strategy === 'neighbours'
      ? ui('±{count} paragraphs', { count: a.neighbours ?? 2 })
      : ui('no expansion'),
    a.graph ? ui('graph') : '',
    a.promptVariant !== 'default' ? ui('{variant} prompt', { variant: a.promptVariant }) : '',
    a.prequeries.length > 0
      ? ui(
        a.prequeries.length > 1
          ? '{count} mandatory sub-questions'
          : '{count} mandatory sub-question',
        { count: a.prequeries.length },
      )
      : '',
    a.minScore > 0.35 ? ui('cite ≥ {percent}%', { percent: Math.round(a.minScore * 100) }) : '',
    a.sortByPublished ? ui('newest first') : '',
  ].filter(Boolean)
  return parts.join(' · ')
}
