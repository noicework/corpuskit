import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { AgentConfig } from '@research-portal/retrieval'
import {
  AgentRestartError,
  carriesLabelset,
  isLabelOpFor,
  planLabelsetRebuild,
  type SavedLabelset,
} from './labelsets.ts'

const FILTER = {
  field_types: ['FILE', 'LINK', 'TEXT'],
  apply_to_agent_generated_fields: false,
  contains: [],
  rag_strategies: [],
}

const topicLabeller: AgentConfig = {
  id: 'task-topic',
  task: 'labeler',
  title: 'topic-labeller',
  model: 'chatgpt-azure-4o-mini',
  on: 1,
  filter: FILTER,
  operations: [
    {
      label: {
        ident: 'topic',
        description: 'Classify by research topic',
        labels: [{ label: 'stock-assessment', description: 'old text' }],
        multiple: false,
      },
    },
  ],
  enabled: true,
}

const kindLabeller: AgentConfig = {
  id: 'task-kind',
  task: 'labeler',
  title: 'kind-labeller',
  model: 'chatgpt-azure-4o-mini',
  filter: FILTER,
  operations: [{ label: { ident: 'kind', labels: [{ label: 'pdf' }], multiple: false } }],
  enabled: true,
}

const summariser: AgentConfig = {
  id: 'task-ask',
  task: 'ask',
  title: 'summariser',
  model: 'chatgpt-azure-4o-mini',
  filter: FILTER,
  operations: [{ ask: { question: 'Summarise', destination: 'summary', json: false } }],
  enabled: true,
}

const SAVED: SavedLabelset = {
  id: 'topic',
  title: 'Topic',
  multiple: true,
  labels: [
    { title: 'stock-assessment', text: 'Surveys and models of a fished population.' },
    { title: 'marine-sustainability', text: '' },
  ],
}

describe('isLabelOpFor / carriesLabelset', () => {
  it('matches only a label operation whose ident is the saved set', () => {
    expect(isLabelOpFor(topicLabeller.operations[0], 'topic')).toBe(true)
    expect(isLabelOpFor(topicLabeller.operations[0], 'kind')).toBe(false)
    expect(isLabelOpFor(summariser.operations[0], 'topic')).toBe(false)
    expect(isLabelOpFor(null, 'topic')).toBe(false)
    expect(isLabelOpFor({ label: null }, 'topic')).toBe(false)
  })

  it('an agent carries a set when any of its operations labels into it', () => {
    expect(carriesLabelset(topicLabeller, 'topic')).toBe(true)
    expect(carriesLabelset(kindLabeller, 'topic')).toBe(false)
    expect(carriesLabelset(summariser, 'topic')).toBe(false)
  })
})

describe('planLabelsetRebuild', () => {
  it('returns no steps when no agent carries the set', () => {
    expect(planLabelsetRebuild([kindLabeller, summariser], SAVED)).toEqual([])
    expect(planLabelsetRebuild([], SAVED)).toEqual([])
  })

  it('rebuilds only the carrying labeller, replacing just its label op', () => {
    const steps = planLabelsetRebuild([summariser, topicLabeller, kindLabeller], SAVED)
    expect(steps).toHaveLength(1)
    const [step] = steps
    expect(step!.deleteId).toBe('task-topic')
    expect(step!.previous).toBe(topicLabeller)
    expect(step!.start).toEqual({
      task: 'labeler',
      title: 'topic-labeller',
      model: 'chatgpt-azure-4o-mini',
      on: 1,
      filter: FILTER,
      operations: [
        {
          label: {
            ident: 'topic',
            description: 'Classify by research topic',
            labels: [
              {
                label: 'stock-assessment',
                description: 'Surveys and models of a fished population.',
              },
              { label: 'marine-sustainability', description: '' },
            ],
            multiple: true,
          },
        },
      ],
    })
  })

  it('keeps the filter object identical, not a copy with drift', () => {
    const [step] = planLabelsetRebuild([topicLabeller], SAVED)
    expect(step!.start.filter).toBe(FILTER)
  })

  it('leaves every other operation of a multi-op agent untouched', () => {
    const askOp = { ask: { question: 'What is the key finding?', destination: 'finding' } }
    const otherLabelOp = { label: { ident: 'kind', labels: [{ label: 'pdf' }], multiple: false } }
    const combined: AgentConfig = {
      ...topicLabeller,
      id: 'task-combined',
      operations: [askOp, topicLabeller.operations[0]!, otherLabelOp],
    }
    const [step] = planLabelsetRebuild([combined], SAVED)
    expect(step!.start.operations).toHaveLength(3)
    expect(step!.start.operations[0]).toBe(askOp)
    expect(step!.start.operations[2]).toBe(otherLabelOp)
    const replaced = step!.start.operations[1] as {
      label: { labels: unknown[]; multiple: boolean }
    }
    expect(replaced.label.multiple).toBe(true)
    expect(replaced.label.labels).toHaveLength(2)
  })

  it('omits filter and on when the agent never had them', () => {
    const bare: AgentConfig = { ...topicLabeller, id: 'bare', filter: undefined, on: undefined }
    const [step] = planLabelsetRebuild([bare], SAVED)
    expect('filter' in step!.start).toBe(false)
    expect('on' in step!.start).toBe(false)
  })

  it('rebuilds every carrying agent, in listing order', () => {
    const second: AgentConfig = { ...topicLabeller, id: 'task-topic-2', title: 'topic-b' }
    const steps = planLabelsetRebuild([topicLabeller, kindLabeller, second], SAVED)
    expect(steps.map((s) => s.deleteId)).toEqual(['task-topic', 'task-topic-2'])
  })

  it('never mutates the input agents', () => {
    const before = JSON.stringify(topicLabeller)
    planLabelsetRebuild([topicLabeller], SAVED)
    expect(JSON.stringify(topicLabeller)).toBe(before)
  })
})

describe('AgentRestartError', () => {
  it('names the removed agent and carries its previous configuration', () => {
    const err = new AgentRestartError(topicLabeller, new Error('422 already running'))
    expect(err.previous).toBe(topicLabeller)
    expect(err.message).toContain('topic-labeller')
    expect(err.message).toContain('task-topic')
    expect(err.message).toContain('422 already running')
  })
})
