import { useEffect, useRef, useState } from 'react'
import type { Intent } from '@research-portal/core'
import type { RouteDecision } from '../api/client.ts'

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (pending && !decision) {
    return (
      <span className='inline-flex items-center gap-1.5 text-xs text-ink-3' role='status'>
        <span
          className='inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-[var(--rp-accent)]'
          aria-hidden='true'
        />
        Choosing the retrieval configuration…
      </span>
    )
  }
  if (!decision) return null
  const intent = intents.find((i) => i.id === decision.intent)
  const label = intent?.label ?? decision.intent
  const stage = decision.stage === 'rule'
    ? 'rule'
    : decision.stage === 'classifier'
    ? `classified · ${Math.round(decision.confidence * 100)}%`
    : decision.stage === 'override'
    ? 'chosen by you'
    : 'default'
  return (
    <div ref={ref} className='relative inline-flex items-center gap-1.5'>
      <button
        type='button'
        onClick={() => onOverride && setOpen((v) => !v)}
        title={`${decision.rationale} · ${decision.configuration}${
          decision.rule ? ` · rule /${decision.rule}/` : ''
        }`}
        aria-haspopup={onOverride ? 'menu' : undefined}
        aria-expanded={onOverride ? open : undefined}
        className='rp-chip rp-focus inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs'
      >
        <svg
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.8'
          strokeLinecap='round'
          strokeLinejoin='round'
          className='h-3.5 w-3.5'
          style={{ color: 'var(--rp-brand-fg)' }}
          aria-hidden='true'
        >
          <path d='M4 7h6l3 5 3-5h4M4 17h6l3-5 3 5h4' />
        </svg>
        <span className='font-medium text-ink'>{label}</span>
        <span className='text-ink-3'>· {stage}</span>
        {onOverride
          ? (
            <svg
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              className='h-3 w-3 text-ink-3'
              aria-hidden='true'
            >
              <path d='M6 9l6 6 6-6' />
            </svg>
          )
          : null}
      </button>
      {
        /* The rationale can run to a sentence; it truncates with an ellipsis
        * and the full text rides on the title, so it never cuts mid-word. */
      }
      <span
        className='hidden min-w-0 max-w-[48ch] truncate text-xs text-ink-3 sm:inline'
        title={decision.rationale}
      >
        {decision.rationale}
      </span>
      {open && onOverride
        ? (
          <ul
            role='menu'
            className='rp-card absolute left-0 top-8 z-20 w-72 p-1 shadow-lg'
          >
            {intents.map((i) => (
              <li key={i.id} role='none'>
                <button
                  type='button'
                  role='menuitem'
                  onClick={() => {
                    setOpen(false)
                    if (i.id !== decision.intent) onOverride(i.id)
                  }}
                  className={`rp-focus flex w-full flex-col items-start rounded-[var(--rp-radius-btn)] px-2.5 py-1.5 text-left text-sm hover:bg-[var(--rp-wash)] ${
                    i.id === decision.intent ? 'bg-[var(--rp-wash)]' : ''
                  }`}
                >
                  <span className='font-medium text-ink'>{i.label}</span>
                  <span className='text-xs text-ink-3'>{i.description}</span>
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
export function intentSummary(intent: Intent): string {
  const r = intent.retrieval
  const a = intent.answer
  const parts = [
    r.features.join(' + '),
    `top ${r.topK}`,
    r.reranker === 'noop' ? 'no rerank' : 'reranked',
    r.only.length > 0
      ? `only ${r.only.map((l) => l.label).join(', ')}`
      : r.exclude.length > 0
      ? `excl. ${r.exclude.map((l) => l.label).join(', ')}`
      : 'all research',
    a.strategy === 'full'
      ? 'full text'
      : a.strategy === 'neighbours'
      ? `±${a.neighbours ?? 2} paragraphs`
      : 'no expansion',
    a.graph ? 'graph' : '',
    a.promptVariant !== 'default' ? `${a.promptVariant} prompt` : '',
    a.prequeries.length > 0
      ? `${a.prequeries.length} mandatory sub-question${a.prequeries.length > 1 ? 's' : ''}`
      : '',
    a.minScore > 0.35 ? `cite ≥ ${Math.round(a.minScore * 100)}%` : '',
    a.sortByPublished ? 'newest first' : '',
  ].filter(Boolean)
  return parts.join(' · ')
}
