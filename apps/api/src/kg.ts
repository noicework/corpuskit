import process from 'node:process'
import type { KgImplementEvent, KgProposal, TenantConfig } from '@research-portal/core'
import { KgProposalSchema } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

/**
 * Knowledge-graph strategy: interrogate the corpus, have the box's own model
 * design a graph strategy (entity types for extraction, resource-level and
 * chunk-level label taxonomies), SUGGEST it to the user, and on approval
 * implement it as data-augmentation agents on the box - which then run over
 * existing resources and/or every future ingest.
 */

const KG_SCHEMA = {
  name: 'knowledge_graph_strategy',
  description: 'Design a knowledge graph and labelling strategy for this corpus',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rationale: { type: 'string' },
      entityTypes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
      resourceLabels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
      chunkLabels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
      examples: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            entities: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' }, label: { type: 'string' } },
                required: ['name', 'label'],
              },
            },
            relations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string' },
                  target: { type: 'string' },
                  label: { type: 'string' },
                },
                required: ['source', 'target', 'label'],
              },
            },
          },
          required: ['text', 'entities', 'relations'],
        },
      },
    },
    required: ['rationale', 'entityTypes', 'resourceLabels', 'chunkLabels', 'examples'],
  },
}

/** Last proposal per tenant, persisted so implement can follow a restart. */
export class KgProposalStore {
  private proposals: Record<string, KgProposal> = {}
  private readonly path: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.path = env.KG_PROPOSALS_PATH ?? './data/kg-proposals.json'
    const raw = readJsonSafe<Record<string, unknown>>(this.path, {})
    for (const [slug, value] of Object.entries(raw)) {
      const parsed = KgProposalSchema.safeParse(value)
      if (parsed.success) this.proposals[slug] = parsed.data
    }
  }

  get(slug: string): KgProposal | undefined {
    return this.proposals[slug]
  }

  set(slug: string, proposal: KgProposal): void {
    this.proposals[slug] = proposal
    writeJsonAtomic(this.path, this.proposals)
  }
}

/** Public proposal-store contract for alternate durable runtimes. */
export type KgProposalStoreApi = Pick<KgProposalStore, keyof KgProposalStore>

// Progress Agentic RAG caps /ask queries at 20,000 characters. Keep headroom
// for upstream framing while still showing the model a broad view of large
// corpora instead of only the first few resources.
const KG_PROPOSAL_PROMPT_BUDGET = 18_000
const KG_PROPOSAL_SAMPLE_SIZE = 80

const clip = (value: string, maxLength: number): string => {
  if (maxLength <= 0) return ''
  if (value.length <= maxLength) return value
  if (maxLength === 1) return '…'
  return `${value.slice(0, maxLength - 1)}…`
}

const inventoryLine = (
  resource: { title: string; summary: string },
  sourceIndex: number,
  maxLength: number,
): string => {
  const prefix = `${sourceIndex + 1}. `
  const bodyBudget = maxLength - prefix.length
  if (bodyBudget <= 0) return clip(prefix, maxLength)

  const title = resource.title.trim()
  const summary = resource.summary.trim()
  if (!summary || bodyBudget <= 3) return `${prefix}${clip(title, bodyBudget)}`

  const separator = ' - '
  const textBudget = bodyBudget - separator.length
  const titleBudget = Math.ceil(textBudget * 0.55)
  const summaryBudget = textBudget - titleBudget
  return `${prefix}${clip(title, titleBudget)}${separator}${clip(summary, summaryBudget)}`
}

const representativeResources = <T>(resources: T[], maximum: number) => {
  if (resources.length <= maximum) {
    return resources.map((resource, sourceIndex) => ({
      resource,
      sourceIndex,
    }))
  }

  return Array.from({ length: maximum }, (_, sampleIndex) => {
    const sourceIndex = Math.round(sampleIndex * (resources.length - 1) / (maximum - 1))
    return { resource: resources[sourceIndex]!, sourceIndex }
  })
}

export async function proposeKgStrategy(
  management: AragProvider,
  config: TenantConfig,
): Promise<KgProposal> {
  const resources = await management.listResources(config)
  if (resources.length === 0) {
    throw new Error('The knowledge box has no indexed content yet - add some resources first.')
  }
  const sample = representativeResources(resources, KG_PROPOSAL_SAMPLE_SIZE)
  const sampled = sample.length < resources.length
  const scope = sampled
    ? `a representative sample of ${sample.length} of its ${resources.length} resources:`
    : `the complete inventory of its ${resources.length} resources:`
  const introduction =
    `You are designing a knowledge-graph strategy for this knowledge box. Here is ${scope}\n\n`
  const instructions =
    `\n\nDesign: (1) 4 to 7 entity types an extraction agent should pull from this corpus (label ` +
    `in Title Case plus a one-line description of what qualifies, e.g. people, organisations, ` +
    `species, programs, regions, technologies - whatever fits THIS corpus); (2) 4 to 8 ` +
    `resource-level labels (whole-document classifications) with descriptions; (3) 4 to 8 ` +
    `chunk-level labels (classifying individual passages, e.g. finding, recommendation, ` +
    `statistic, definition, methodology) with descriptions; (4) at least SIX few-shot NER ` +
    `examples drawn from this corpus: each has 'text' (one or two real-sounding sentences from ` +
    `the domain), 'entities' (2 to 4 mentions, each {name, label} using ONLY your entity type ` +
    `labels), and 'relations' (1 to 3 {source, target, label} where source and target are ` +
    `entity names from that example's entities list and label is a short verb phrase like ` +
    `'funds', 'affects', 'located in', 'assesses') - these teach the extraction agent how ` +
    `entities RELATE; (5) a two-sentence rationale explaining the strategy in Australian ` +
    `English. Labels in Title Case, no punctuation in labels.`
  const inventoryBudget = KG_PROPOSAL_PROMPT_BUDGET - introduction.length - instructions.length
  const lineBudget = Math.floor((inventoryBudget - (sample.length - 1)) / sample.length)
  const inventory = sample
    .map(({ resource, sourceIndex }) => inventoryLine(resource, sourceIndex, lineBudget))
    .join('\n')
  const prompt = `${introduction}${inventory}${instructions}`
  const { object } = await management.askStructured(config, KG_SCHEMA, prompt)
  const proposal = KgProposalSchema.parse(object)
  // Keep only structurally sound examples: entity labels must come from the
  // defined types and every relation endpoint must be a listed entity.
  const typeLabels = new Set(proposal.entityTypes.map((e) => e.label))
  const validate = (examples: KgProposal['examples']): KgProposal['examples'] =>
    examples
      .map((example) => {
        const entities = example.entities.filter((e) => typeLabels.has(e.label))
        const names = new Set(entities.map((e) => e.name))
        const relations = example.relations.filter(
          (r) => names.has(r.source) && names.has(r.target),
        )
        return { ...example, entities, relations }
      })
      .filter((example) =>
        example.text.trim() && example.entities.length >= 2 && example.relations.length >= 1
      )
  proposal.examples = validate(proposal.examples)
  // The graph agent needs at least six few-shot examples to learn relations -
  // top up with a second, examples-only generation pass when short.
  if (proposal.examples.length < 6) {
    const topUpPrompt =
      `Write ${8 - proposal.examples.length} few-shot NER training examples for this corpus. ` +
      `Entity types (use ONLY these labels): ${
        proposal.entityTypes.map((e) => `${e.label} (${e.description})`).join('; ')
      }. Each example: 'text' - one or two realistic domain sentences; 'entities' - 2 to 4 ` +
      `{name, label} mentions from the text; 'relations' - 1 to 3 {source, target, label} ` +
      `where source and target are names from the entities list and label is a short verb ` +
      `phrase. Return rationale as 'top-up' and entityTypes, resourceLabels and chunkLabels ` +
      `as empty arrays - only the examples matter in this pass.`
    try {
      const { object: extra } = await management.askStructured(config, KG_SCHEMA, topUpPrompt)
      const parsed = KgProposalSchema.safeParse(extra)
      if (parsed.success) {
        proposal.examples = [...proposal.examples, ...validate(parsed.data.examples)].slice(0, 10)
      }
    } catch {
      // keep what we have
    }
  }
  return proposal
}

export async function* implementKgStrategy(
  management: AragProvider,
  config: TenantConfig,
  proposal: KgProposal,
  opts: { applyExisting: boolean; includeSummaries: boolean; includeMemory?: boolean },
): AsyncGenerator<KgImplementEvent> {
  yield { type: 'stage', label: 'Resolving the data-augmentation model' }
  const model = await management.augmentationModel(config)
  yield {
    type: 'item',
    label: `DA model pinned: ${model}`,
  }

  const slugify = (raw: string) =>
    raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

  yield { type: 'stage', label: 'Creating label taxonomies' }
  try {
    await management.createLabelset(config, {
      id: 'auto-labels',
      title: 'Document labels',
      multiple: true,
      labels: proposal.resourceLabels.map((l) => l.label),
      kind: 'RESOURCES',
    })
    yield { type: 'item', label: `Resource labelset created (${proposal.resourceLabels.length})` }
  } catch {
    yield { type: 'item', label: 'Resource labelset already exists - reusing' }
  }
  try {
    await management.createLabelset(config, {
      id: 'chunk-labels',
      title: 'Passage labels',
      multiple: true,
      labels: proposal.chunkLabels.map((l) => l.label),
      kind: 'PARAGRAPHS',
    })
    yield { type: 'item', label: `Chunk labelset created (${proposal.chunkLabels.length})` }
  } catch {
    yield { type: 'item', label: 'Chunk labelset already exists - reusing' }
  }

  yield { type: 'stage', label: 'Registering agents on the knowledge box' }
  let agents = 0
  const existing = await management.listAgents(config).catch(() => [])
  const existingByTitle = new Map(existing.map((a) => [a.title, a]))
  const tryStart = async function* (
    label: string,
    task: string,
    title: string,
    operations: unknown[],
  ): AsyncGenerator<KgImplementEvent> {
    try {
      await management.startAgent(config, {
        task,
        title,
        operations,
        applyExisting: opts.applyExisting,
        model,
      })
      agents += 1
      yield { type: 'item', label: `${label} agent registered` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed'
      if (/already running/i.test(message)) {
        // The platform runs one labelling agent at a time, and a rejected
        // concurrent start can leave a zombie config - clean it up.
        try {
          const zombie = (await management.listAgents(config)).find((a) => a.title === title)
          if (zombie) await management.deleteAgent(config, zombie.id)
        } catch {
          // best effort
        }
        yield {
          type: 'item',
          label: `${label} deferred - the platform runs one labelling agent at a time. Re-run ` +
            'Implement once the document labeller has finished to register it.',
        }
      } else {
        yield {
          type: 'item',
          label: `${label} agent was rejected by the platform`,
          detail: message.slice(0, 180),
        }
      }
    }
  }

  const kgTitle = `kg-${slugify(config.slug)}`
  const previousGraph = existingByTitle.get(kgTitle)
  if (previousGraph) {
    try {
      await management.deleteAgent(config, previousGraph.id)
      yield { type: 'item', label: 'Replacing the existing knowledge graph agent' }
    } catch {
      // fall through and let the start attempt speak for itself
    }
  }
  if (proposal.examples.length > 0) {
    yield {
      type: 'item',
      label: `Teaching the graph agent with ${proposal.examples.length} NER examples`,
    }
  }
  yield* tryStart('Knowledge graph', 'llm-graph', kgTitle, [{
    graph: {
      ident: 'kg1',
      entity_defs: proposal.entityTypes.map((e) => ({
        label: e.label,
        description: e.description,
      })),
      examples: proposal.examples.map((example) => ({
        text: example.text,
        entities: example.entities,
        relations: example.relations,
      })),
    },
  }])
  const labelsTitle = `labels-${slugify(config.slug)}`
  if (existingByTitle.has(labelsTitle)) {
    agents += 1
    yield { type: 'item', label: 'Document labeller already registered - keeping it' }
  } else {yield* tryStart('Document labeller', 'labeler', labelsTitle, [{
      label: {
        ident: 'kgl1',
        labels: proposal.resourceLabels.map((l) => ({
          label: l.label,
          description: l.description,
        })),
      },
    }])}
  const chunksTitle = `chunks-${slugify(config.slug)}`
  if (existingByTitle.has(chunksTitle)) {
    agents += 1
    yield { type: 'item', label: 'Passage labeller already registered - keeping it' }
  } else {yield* tryStart('Passage labeller', 'labeler', chunksTitle, [{
      label: {
        ident: 'kgl2',
        labels: proposal.chunkLabels.map((l) => ({
          label: l.label,
          description: l.description,
        })),
      },
    }])}
  // Topic/kind classification keeps every future ingest visible to facets,
  // Explore and the coverage line - without it, bulk loads land unorganised.
  const classifyTitle = `classify-${slugify(config.slug)}`
  if (existingByTitle.has(classifyTitle)) {
    agents += 1
    yield { type: 'item', label: 'Topic and kind classifier already registered - keeping it' }
  } else {
    const boxLabelsets = await management.labelsets(config).catch(() => [])
    const classifyOps = ['topic', 'kind']
      .map((ident) => boxLabelsets.find((ls) => ls.id === ident))
      .filter((ls): ls is NonNullable<typeof ls> => ls !== undefined)
      .map((ls) => ({
        label: {
          ident: ls.id,
          labels: ls.labels.map((label) => ({ label, description: '' })),
          multiple: false,
        },
      }))
    if (classifyOps.length > 0) {
      yield* tryStart('Topic and kind classifier', 'labeler', classifyTitle, classifyOps)
    }
  }

  const summariesTitle = `summaries-${slugify(config.slug)}`
  if (opts.includeSummaries && existingByTitle.has(summariesTitle)) {
    agents += 1
    yield { type: 'item', label: 'Page summary generator already registered - keeping it' }
  } else if (opts.includeSummaries) {
    yield* tryStart('Page summary generator', 'ask', summariesTitle, [{
      ask: {
        question:
          'Write a three sentence, plain-language summary of this resource for a research portal card. Australian English.',
        destination: 'pagesummary',
      },
    }])
  }

  if (opts.includeMemory) {
    const memoryTitle = `memory-${slugify(config.slug)}`
    if (existingByTitle.has(memoryTitle)) {
      agents += 1
      yield { type: 'item', label: 'Conversation memory agent already registered - keeping it' }
    } else {
      yield* tryStart('Conversation memory', 'memory', memoryTitle, [{
        memory: {
          ident: `memory-${slugify(config.slug)}`,
          prompt:
            'Remember the research topics, entities and preferences this user has shown interest in, and use them to sharpen future answers.',
        },
      }])
    }
  }

  if (agents === 0) {
    yield { type: 'error', message: 'The platform rejected every agent - nothing was registered.' }
    return
  }
  yield {
    type: 'item',
    label: opts.applyExisting
      ? 'Agents will run over existing resources and every future ingest'
      : 'Agents will run on future ingests only',
  }
  yield { type: 'done', agents }
}

// ---------------------------------------------------------------------------
// Strategy editing: replace the live llm-graph agent's entity types and
// examples with librarian-edited ones. Same one-running-agent-per-type
// constraints as implementKgStrategy - delete the old config, then start the
// replacement with wait-retry.
// ---------------------------------------------------------------------------

const slugifyName = (raw: string) =>
  raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export interface GraphStrategyInput {
  entityTypes: { label: string; description?: string }[]
  examples: {
    text: string
    entities: { name: string; label: string }[]
    relations: { source: string; target: string; label: string }[]
  }[]
  applyExisting: boolean
}

/** Validation errors a librarian can act on; empty when the strategy is sound. */
export function validateGraphStrategy(input: GraphStrategyInput): string[] {
  const problems: string[] = []
  if (input.entityTypes.length === 0) problems.push('Define at least one entity type.')
  const labels = new Set(input.entityTypes.map((t) => t.label))
  if (labels.size !== input.entityTypes.length) {
    problems.push('Entity type names must be unique.')
  }
  if (input.examples.length < 6) {
    problems.push(
      `At least six worked examples are needed for reliable relation extraction (currently ${input.examples.length}).`,
    )
  }
  input.examples.forEach((example, index) => {
    const n = index + 1
    if (!example.text.trim()) problems.push(`Example ${n}: the text is empty.`)
    if (example.entities.length < 2) {
      problems.push(`Example ${n}: needs at least two entities.`)
    }
    if (example.relations.length < 1) {
      problems.push(`Example ${n}: needs at least one relation.`)
    }
    const names = new Set(example.entities.map((e) => e.name))
    for (const entity of example.entities) {
      if (!labels.has(entity.label)) {
        problems.push(
          `Example ${n}: entity "${entity.name}" uses undefined type "${entity.label}".`,
        )
      }
    }
    for (const relation of example.relations) {
      if (!names.has(relation.source) || !names.has(relation.target)) {
        problems.push(
          `Example ${n}: relation "${relation.label}" references an entity not listed in that example.`,
        )
      }
      if (!relation.label.trim()) {
        problems.push(`Example ${n}: a relation is missing its label.`)
      }
    }
  })
  return problems
}

export async function* replaceGraphStrategy(
  management: AragProvider,
  config: TenantConfig,
  input: GraphStrategyInput,
): AsyncGenerator<KgImplementEvent> {
  const problems = validateGraphStrategy(input)
  if (problems.length > 0) {
    yield { type: 'error', message: problems.join(' ') }
    return
  }
  const model = await management.augmentationModel(config)
  const title = `kg-${slugifyName(config.slug)}`

  yield { type: 'stage', label: 'Replacing the knowledge graph agent' }
  const existing = await management.listAgents(config).catch(() => [])
  const current = existing.find((agent) => agent.title === title)
  if (current) {
    try {
      await management.deleteAgent(config, current.id)
      yield { type: 'item', label: 'Previous strategy removed' }
    } catch {
      yield { type: 'item', label: 'Could not remove the previous agent - continuing' }
    }
  }

  const operations = [{
    graph: {
      ident: 'kg1',
      entity_defs: input.entityTypes.map((t) => ({
        label: t.label,
        ...(t.description ? { description: t.description } : {}),
      })),
      examples: input.examples,
    },
  }]

  let registered = false
  for (let attempt = 1; attempt <= 4 && !registered; attempt++) {
    try {
      await management.startAgent(config, {
        task: 'llm-graph',
        title,
        operations,
        applyExisting: input.applyExisting,
        model,
      })
      registered = true
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/already running/i.test(message) && attempt < 4) {
        yield {
          type: 'item',
          label: `An extraction run is still in progress - retrying (${attempt}/3)`,
        }
        await new Promise((resolve) => setTimeout(resolve, 25_000))
        // A rejected concurrent start can leave a zombie config - clear it.
        try {
          const zombie = (await management.listAgents(config)).find((a) => a.title === title)
          if (zombie) await management.deleteAgent(config, zombie.id)
        } catch {
          // nothing to clean
        }
      } else {
        yield {
          type: 'error',
          message: 'The platform rejected the new strategy - the previous agent was removed. ' +
            'Try again shortly.',
        }
        return
      }
    }
  }
  yield {
    type: 'item',
    label: input.applyExisting
      ? 'New strategy registered - re-extracting across existing resources and every future ingest'
      : 'New strategy registered - applies to future ingests',
  }
  yield { type: 'done', agents: 1 }
}
