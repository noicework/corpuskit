import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { KgProposal, TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { implementKgStrategy, proposeKgStrategy, replaceGraphStrategy } from './kg.ts'

const TENANT: TenantConfig = {
  slug: 'marine',
  branding: {
    productName: 'Southern Waters Research Portal',
    organisation: 'Southern Waters Research Institute',
    tagline: 'Fisheries research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

const PROPOSAL: KgProposal = {
  rationale: 'Extract the entities and labels researchers use.',
  entityTypes: [{ label: 'Species', description: 'A fishery species' }],
  resourceLabels: [{ label: 'Assessment', description: 'A stock assessment' }],
  chunkLabels: [{ label: 'Finding', description: 'A research finding' }],
  examples: [{
    text: 'Abalone stocks improved after management changes.',
    entities: [
      { name: 'Abalone', label: 'Species' },
      { name: 'stocks', label: 'Species' },
    ],
    relations: [{ source: 'Abalone', target: 'stocks', label: 'has' }],
  }],
}

const COMPLETE_PROPOSAL: KgProposal = {
  ...PROPOSAL,
  examples: Array.from({ length: 6 }, (_, index) => ({
    ...PROPOSAL.examples[0]!,
    text: `${PROPOSAL.examples[0]!.text} Example ${index + 1}.`,
  })),
}

function proposalManagement(
  resources: { id: string; title: string; summary: string }[],
  prompts: string[],
): AragProvider {
  return {
    listResources: () => Promise.resolve(resources),
    askStructured: (_tenant: TenantConfig, _schema: unknown, prompt: string) => {
      prompts.push(prompt)
      return Promise.resolve({ object: structuredClone(COMPLETE_PROPOSAL), citations: [] })
    },
  } as unknown as AragProvider
}

type StartedAgent = Parameters<AragProvider['startAgent']>[1]

function managementDouble(model: string): {
  management: AragProvider
  starts: StartedAgent[]
  answerModelCalls: () => number
} {
  const starts: StartedAgent[] = []
  let answerModelCalls = 0
  const management = {
    augmentationModel: () => Promise.resolve(model),
    generativeModel: () => {
      answerModelCalls += 1
      return Promise.resolve('chatgpt-azure-4o')
    },
    createLabelset: () => Promise.resolve(),
    listAgents: () => Promise.resolve([]),
    labelsets: () => Promise.resolve([]),
    startAgent: (_tenant: TenantConfig, input: StartedAgent) => {
      starts.push(input)
      return Promise.resolve()
    },
    deleteAgent: () => Promise.resolve(),
  } as unknown as AragProvider
  return { management, starts, answerModelCalls: () => answerModelCalls }
}

describe('knowledge-graph proposals', () => {
  it('keeps a representative 981-resource corpus below the upstream query limit', async () => {
    const resources = Array.from({ length: 981 }, (_, index) => ({
      id: `resource-${index + 1}`,
      title: `Resource ${index + 1} ${'title '.repeat(100)}`,
      summary: `Summary ${index + 1} ${'detail '.repeat(100)}`,
    }))
    const prompts: string[] = []

    await proposeKgStrategy(proposalManagement(resources, prompts), TENANT)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.length).toBeLessThanOrEqual(18_000)
    expect(prompts[0]).toContain('a representative sample of 80 of its 981 resources')
    expect(prompts[0]).toContain('1. Resource 1')
    expect(prompts[0]).toContain('981. Resource 981')
  })

  it('uses the complete inventory for a small corpus', async () => {
    const resources = Array.from({ length: 3 }, (_, index) => ({
      id: `resource-${index + 1}`,
      title: `Resource ${index + 1}`,
      summary: `Summary ${index + 1}`,
    }))
    const prompts: string[] = []

    await proposeKgStrategy(proposalManagement(resources, prompts), TENANT)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('the complete inventory of its 3 resources')
    expect(prompts[0]).toContain('1. Resource 1 - Summary 1')
    expect(prompts[0]).toContain('2. Resource 2 - Summary 2')
    expect(prompts[0]).toContain('3. Resource 3 - Summary 3')
  })
})

describe('knowledge-graph data-augmentation agents', () => {
  it('pins bulk agents to the augmentation model and never starts synthetic questions', async () => {
    const { management, starts, answerModelCalls } = managementDouble('cheap-extraction-model')

    for await (
      const _event of implementKgStrategy(management, TENANT, PROPOSAL, {
        applyExisting: true,
        includeSummaries: true,
      })
    ) {
      // Drain the implementation stream.
    }

    expect(answerModelCalls()).toBe(0)
    expect(starts.map((agent) => agent.task)).toEqual([
      'llm-graph',
      'labeler',
      'labeler',
      'ask',
    ])
    expect(starts.every((agent) => agent.model === 'cheap-extraction-model')).toBe(true)
    expect(starts.some((agent) => agent.task === 'synthetic-questions')).toBe(false)
  })

  it('uses the augmentation model when replacing the graph agent', async () => {
    const { management, starts, answerModelCalls } = managementDouble('cheap-extraction-model')
    const example = PROPOSAL.examples[0]!

    for await (
      const _event of replaceGraphStrategy(management, TENANT, {
        entityTypes: PROPOSAL.entityTypes,
        examples: Array.from({ length: 6 }, (_, index) => ({
          ...example,
          text: `${example.text} Example ${index + 1}.`,
        })),
        applyExisting: true,
      })
    ) {
      // Drain the replacement stream.
    }

    expect(answerModelCalls()).toBe(0)
    expect(starts).toHaveLength(1)
    expect(starts[0]?.task).toBe('llm-graph')
    expect(starts[0]?.model).toBe('cheap-extraction-model')
  })
})
