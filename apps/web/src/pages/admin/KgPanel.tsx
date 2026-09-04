import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { KgImplementEvent, KgProposal } from '@research-portal/core'
import { deleteAgent, getAgents, implementKg, proposeKg } from '../../api/client.ts'
import { KgStrategyEditor } from './KgStrategyEditor.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

const TASK_BADGE = 'rp-badge rp-badge-quiet'

function ChipGroup({
  title,
  items,
}: {
  title: string
  items: { label: string; description: string }[]
}) {
  if (items.length === 0) return null
  return (
    <div>
      <p className='rp-eyebrow text-ink-3'>{title}</p>
      <div className='mt-1.5 flex flex-wrap gap-1.5'>
        {items.map((item) => (
          <span key={item.label} title={item.description} className='rp-chip'>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Knowledge-graph strategy workflow: interrogate the corpus, propose an
 * entity/label strategy for review, implement it as agents on the box, and
 * manage the agents once installed. `open` should reflect whether the
 * surrounding tab/section is visible, so the agents list is only fetched
 * while it can actually be seen.
 */
export function KgPanel(
  { slug, passcode, open }: { slug: string; passcode: string; open: boolean },
) {
  const queryClient = useQueryClient()
  const [proposing, setProposing] = useState(false)
  const [proposal, setProposal] = useState<KgProposal | null>(null)
  const [applyExisting, setApplyExisting] = useState(true)
  const [includeSummaries, setIncludeSummaries] = useState(true)
  const [includeMemory, setIncludeMemory] = useState(false)
  const [implementing, setImplementing] = useState(false)
  const [log, setLog] = useState<KgImplementEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  const agentsQuery = useQuery({
    queryKey: ['kb-agents', slug],
    queryFn: () => getAgents(slug, passcode),
    enabled: open,
  })

  const onPropose = async () => {
    setProposing(true)
    setMessage(null)
    try {
      const result = await proposeKg(slug, passcode)
      setProposal(result)
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not propose a strategy - please try again.'),
      })
    } finally {
      setProposing(false)
    }
  }

  const onImplement = async () => {
    setImplementing(true)
    setLog([])
    setMessage(null)
    try {
      await implementKg(
        slug,
        passcode,
        { applyExisting, includeSummaries, includeMemory },
        (event) => {
          setLog((prev) => [...prev, event])
          if (event.type === 'done') {
            setMessage({
              tone: 'ok',
              text: `Strategy implemented - ${event.agents} ${
                event.agents === 1 ? 'agent' : 'agents'
              } installed on the box.`,
            })
          }
          if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
        },
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] }),
        queryClient.invalidateQueries({ queryKey: ['kg-strategy', slug] }),
      ])
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Implementation failed - please retry.'),
      })
    } finally {
      setImplementing(false)
    }
  }

  const onRemoveAgent = async (taskId: string) => {
    setMessage(null)
    try {
      await deleteAgent(slug, passcode, taskId)
      await queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not remove the agent.') })
    }
  }

  const agents = agentsQuery.data ?? []

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <p className='text-sm font-semibold text-ink'>Knowledge graph</p>
          <p className='mt-0.5 text-xs text-ink-3'>
            Interrogates the corpus, designs a knowledge-graph strategy, and - once you approve it -
            installs it as agents on the box.
          </p>
        </div>
        <button
          type='button'
          disabled={proposing}
          onClick={() => void onPropose()}
          className='rp-btn rp-btn-primary'
        >
          {proposing ? 'Interrogating the corpus…' : 'Propose strategy'}
        </button>
      </div>

      {proposal && (
        <div className='mt-4 space-y-3 rounded-[var(--rp-radius)] border border-line bg-surface p-4'>
          <p className='text-sm text-ink-2'>{proposal.rationale}</p>

          <ChipGroup title='Entity types' items={proposal.entityTypes} />
          <ChipGroup title='Document labels' items={proposal.resourceLabels} />
          <ChipGroup title='Passage labels' items={proposal.chunkLabels} />

          <div className='flex flex-wrap items-center gap-4 border-t border-line pt-3'>
            <label className='flex items-center gap-2 text-sm text-ink-2'>
              <input
                type='checkbox'
                checked={applyExisting}
                onChange={(e) => setApplyExisting(e.target.checked)}
              />
              Run over existing resources
            </label>
            <label className='flex items-center gap-2 text-sm text-ink-2'>
              <input
                type='checkbox'
                checked={includeSummaries}
                onChange={(e) => setIncludeSummaries(e.target.checked)}
              />
              Generate page summaries
            </label>
            <label className='flex items-center gap-2 text-sm text-ink-2'>
              <input
                type='checkbox'
                checked={includeMemory}
                onChange={(e) => setIncludeMemory(e.target.checked)}
              />
              Conversation memory agent
            </label>
          </div>
          <p className='text-xs text-ink-3'>
            Conversation memory agent: remembers each user's research interests across conversations
            and sharpens future answers.
          </p>

          <button
            type='button'
            disabled={implementing}
            onClick={() => void onImplement()}
            className='rp-btn rp-btn-primary'
          >
            {implementing ? 'Implementing…' : 'Implement strategy'}
          </button>

          {log.length > 0 && (
            <ol className='max-h-56 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface p-3 text-xs'>
              {log.map((event, index) => (
                <li key={index} className='flex gap-2'>
                  {event.type === 'stage' && (
                    <span className='font-semibold text-ink'>{event.label}</span>
                  )}
                  {event.type === 'item' && (
                    <span className='text-ink-2' title={event.detail}>{event.label}</span>
                  )}
                  {event.type === 'done' && (
                    <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>
                      Finished.
                    </span>
                  )}
                  {event.type === 'error' && (
                    <span style={{ color: 'var(--rp-bad-ink)' }}>{event.message}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}

      <div className='mt-4 border-t border-line pt-3'>
        <p className='text-sm font-medium text-ink'>Agents on this box</p>

        {open && agentsQuery.isLoading && <p className='mt-2 text-sm text-ink-3'>Loading…</p>}

        {agentsQuery.isError && <p className='mt-2 text-sm text-ink-3'>Could not load agents.</p>}

        {open && !agentsQuery.isLoading && !agentsQuery.isError && agents.length === 0 && (
          <p className='mt-2 text-sm text-ink-3'>No agents yet - propose a strategy above.</p>
        )}

        {agents.length > 0 && (
          <ul className='mt-2 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {agents.map((agent) => (
              <li
                key={agent.id}
                className='flex items-center justify-between gap-3 bg-surface px-4 py-2.5'
              >
                <span className='flex min-w-0 items-center gap-2.5'>
                  <span className={TASK_BADGE}>{agent.task}</span>
                  <span className='truncate text-sm text-ink'>{agent.title}</span>
                </span>
                <button
                  type='button'
                  onClick={() => void onRemoveAgent(agent.id)}
                  className='shrink-0 text-sm font-medium transition-colors duration-150'
                  style={{ color: 'var(--rp-bad-ink)' }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className='mt-4 border-t border-line pt-3'>
        <p className='text-sm font-medium text-ink'>Current strategy</p>
        <p className='mt-0.5 text-xs text-ink-3'>
          The entity types and worked examples that teach the extraction agent what to pull out -
          fully editable.
        </p>
        <div className='mt-3'>
          <KgStrategyEditor slug={slug} passcode={passcode} />
        </div>
      </div>
    </div>
  )
}
