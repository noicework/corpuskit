import type { AnalyseEvent, Labelset, TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import type { TenantStoreApi } from './tenants.ts'
import { sampleInventory } from './inventory-sample.ts'

/**
 * Corpus analysis: interrogate a knowledge box and derive its portal
 * configuration from what is actually in it - a topic taxonomy, a second
 * "kind" dimension (which powers the co-occurrence knowledge graph),
 * per-resource label assignments, suggested questions and search placeholder.
 * The design comes from the box's own generative model via structured
 * generation, grounded in the corpus; every result is applied live.
 */

const ANALYSE_SCHEMA = {
  name: 'portal_configuration',
  description: 'Design a research portal configuration from the knowledge box corpus inventory',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      topics: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'label', 'description'],
        },
      },
      kinds: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'label', 'description'],
        },
      },
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: { type: 'integer' },
            topicId: { type: 'string' },
            kindId: { type: 'string' },
          },
          required: ['number', 'topicId', 'kindId'],
        },
      },
      suggestedQuestions: { type: 'array', items: { type: 'string' } },
      searchPlaceholder: { type: 'string' },
    },
    required: ['topics', 'kinds', 'assignments', 'suggestedQuestions', 'searchPlaceholder'],
  },
}

interface AnalysisDesign {
  topics: { id: string; label: string; description?: string }[]
  kinds: { id: string; label: string; description?: string }[]
  assignments: { number: number; topicId: string; kindId: string }[]
  suggestedQuestions: string[]
  searchPlaceholder: string
}

const slugify = (raw: string) =>
  raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

/**
 * The label sets analysis would replace that this portal did not create, by
 * id. Writing a label set replaces the whole set on the platform, so a
 * curated `topic` or `kind` on a connected box would be lost to one click.
 *
 * What the portal knows of its own sets: every `topic` label it writes, by
 * analysis or provisioning, is one of the topic ids in its configuration, and
 * analysis records them as soon as the set is written. Nothing is stored for
 * `kind`, so a `kind` set counts as the portal's while `topic` does: a
 * non-empty `topic` set holding only the portal's topic ids. A re-run on a box
 * whose sets came from this portal therefore always passes. A set with no
 * labels has nothing to lose and never blocks.
 */
export function foreignLabelsets(config: TenantConfig, labelsets: readonly Labelset[]): string[] {
  const portalTopics = new Set(config.topics.map((t) => t.id))
  const topic = labelsets.find((ls) => ls.id === 'topic')
  const kind = labelsets.find((ls) => ls.id === 'kind')
  const ownTopic = topic !== undefined && topic.labels.length > 0 &&
    topic.labels.every((label) => portalTopics.has(label))
  const foreign: string[] = []
  if (topic && topic.labels.length > 0 && !ownTopic) foreign.push('topic')
  if (kind && kind.labels.length > 0 && !ownTopic) foreign.push('kind')
  return foreign
}

/** The refusal an admin sees when analysis would replace a label set it did not create. */
export function labelsetExistsMessage(ids: readonly string[]): string {
  const one = ids.length === 1
  const named = ids.map((id) => `'${id}'`).join(' and ')
  return `This knowledge box already has ${one ? 'a ' : ''}${named} label ${
    one ? 'set' : 'sets'
  } that this portal did not create. Running analysis would replace ${
    one ? 'it' : 'them'
  }. Rename or remove ${one ? 'it' : 'them'} in the knowledge box first.`
}

export async function* analyseTenant(
  management: AragProvider,
  tenants: TenantStoreApi,
  config: TenantConfig,
  invalidate: (slug: string) => void,
): AsyncGenerator<AnalyseEvent> {
  yield { type: 'stage', label: 'Reading the corpus' }
  const resources = await management.listResources(config)
  if (resources.length === 0) {
    yield {
      type: 'error',
      message: 'The knowledge box has no indexed content yet - add some resources first.',
    }
    return
  }
  yield {
    type: 'item',
    label: `Found ${resources.length} indexed ${resources.length === 1 ? 'resource' : 'resources'}`,
  }

  // Before the design is paid for or anything is written: never replace a
  // label set this portal did not create.
  let existing: Labelset[]
  try {
    existing = await management.labelsets(config)
  } catch {
    yield {
      type: 'error',
      message: "The knowledge box's label sets could not be read, so analysis made no " +
        'changes. Try again shortly.',
    }
    return
  }
  const foreign = foreignLabelsets(config, existing)
  if (foreign.length > 0) {
    yield { type: 'error', error: 'labelset_exists', message: labelsetExistsMessage(foreign) }
    return
  }

  // The design /ask query has a 20,000-char limit, and asking the model to
  // assign every resource in a single call does not scale (a 1,000+ resource
  // corpus overflowed it, 422 string_too_long). Design the taxonomy from a
  // representative, char-bounded sample instead - the full corpus is labelled
  // separately by the labeller agent (Manage -> Enrichments).
  const INVENTORY_BUDGET = 14_000
  const line = (r: { title: string; summary: string }, i: number) =>
    `${i + 1}. ${r.title} - ${r.summary.slice(0, 180)}`
  const { sample, sampled, inventory } = sampleInventory(resources, line, INVENTORY_BUDGET)
  const prompt = `You are configuring a research portal for this knowledge box. Here is ` +
    (sampled
      ? `a representative sample of ${sample.length} of its ${resources.length} resources:`
      : `the complete inventory of its ${resources.length} resources:`) +
    `\n\n${inventory}\n\n` +
    `Design the portal configuration: (1) 4 to 8 topics that partition this corpus well, each ` +
    `with a kebab-case id, a short label in Australian English and a one-sentence description ` +
    `of what qualifies (the classifier's prompt); (2) 3 to 5 "kinds", each with a description - a ` +
    `second, orthogonal way of classifying the same resources (for example document genre or ` +
    `research approach), also with kebab-case ids; (3) for EVERY numbered resource above, an ` +
    `assignment of exactly one topicId and one kindId; (4) 6 suggested questions a researcher ` +
    `would genuinely ask of this corpus; (5) a short search placeholder listing 3 or 4 corpus ` +
    `themes, e.g. "Search x, y, z…". Use only ids you defined. Cover every resource number ` +
    `from 1 to ${sample.length}.`

  yield { type: 'stage', label: 'Designing taxonomy, graph dimensions and questions' }
  const { object } = await management.askStructured(config, ANALYSE_SCHEMA, prompt)
  const design = object as AnalysisDesign
  if (!Array.isArray(design.topics) || design.topics.length === 0) {
    yield { type: 'error', message: 'The model returned no usable taxonomy - try again.' }
    return
  }
  const topics = design.topics.map((t) => ({
    id: slugify(t.id || t.label),
    label: t.label,
    ...(t.description?.trim() ? { description: t.description.trim() } : {}),
  }))
    .filter((t) => t.id)
  const kinds = (design.kinds ?? []).map((k) => ({
    id: slugify(k.id || k.label),
    label: k.label,
    ...(k.description?.trim() ? { description: k.description.trim() } : {}),
  }))
    .filter((k) => k.id)
  yield {
    type: 'item',
    label: `Designed ${topics.length} topics and ${kinds.length} kinds`,
    detail: `${topics.map((t) => t.label).join(', ')} | ${kinds.map((k) => k.label).join(', ')}`,
  }

  yield { type: 'stage', label: 'Creating taxonomy on the knowledge box' }
  const written = new Set<string>()
  for (
    const [id, title, labels] of [
      ['topic', 'Topic', topics] as const,
      ['kind', 'Kind', kinds] as const,
    ]
  ) {
    try {
      await management.createLabelset(config, {
        id,
        title,
        multiple: false,
        // The description rides on the label so the classifier agent has a
        // prompt per label, not just an id.
        labels: labels.map((l) => ({
          title: l.id,
          ...(l.description ? { text: l.description } : {}),
        })),
      })
      written.add(id)
      yield { type: 'item', label: `Labelset '${id}' configured (${labels.length} labels)` }
    } catch {
      if (id === 'topic') {
        yield {
          type: 'error',
          message: "The 'topic' label set could not be written to the knowledge box, so nothing " +
            "was labelled and the portal's configuration is unchanged. Try again shortly.",
        }
        return
      }
      yield {
        type: 'item',
        label: `Labelset '${id}' could not be written - labelling by topic only`,
      }
    }
  }
  // The topic ids go into the portal's configuration as soon as the set is
  // written, not after labelling: a run cut short must still recognise its
  // own `topic` set next time (foreignLabelsets).
  tenants.patch(config.slug, { topics })
  invalidate(config.slug)

  yield {
    type: 'stage',
    label: sampled ? 'Labelling the sampled resources' : 'Labelling every resource',
  }
  const topicIds = new Set(topics.map((t) => t.id))
  const kindIds = new Set(written.has('kind') ? kinds.map((k) => k.id) : [])
  let labelled = 0
  for (const assignment of design.assignments ?? []) {
    const resource = sample[assignment.number - 1]
    if (!resource) continue
    const topicId = slugify(assignment.topicId)
    const kindId = slugify(assignment.kindId)
    if (!topicIds.has(topicId)) continue
    const classifications = [{ labelset: 'topic', label: topicId }]
    if (kindIds.has(kindId)) classifications.push({ labelset: 'kind', label: kindId })
    try {
      await management.patchResourceClassifications(config, resource.id, classifications)
      labelled += 1
      yield { type: 'item', label: `Labelled: ${resource.title.slice(0, 60)}`, detail: topicId }
    } catch (err) {
      yield {
        type: 'item',
        label: `Could not label: ${resource.title.slice(0, 60)}`,
        detail: err instanceof Error ? err.message.slice(0, 120) : 'failed',
      }
    }
  }

  if (sampled) {
    yield {
      type: 'item',
      label: `Labelled ${labelled} sampled resources`,
      detail:
        `Taxonomy designed from a representative sample - run Enrichments to classify all ${resources.length}`,
    }
  }

  yield { type: 'stage', label: 'Updating the portal configuration' }
  const questions = (design.suggestedQuestions ?? []).slice(0, 8).map((text, i) => ({
    id: `${config.slug}-aq${i + 1}`,
    text,
  }))
  tenants.patch(config.slug, {
    suggestedQuestions: questions,
    searchPlaceholder: design.searchPlaceholder?.trim() || config.searchPlaceholder,
  })
  invalidate(config.slug)

  yield {
    type: 'done',
    topics: topics.length,
    kinds: written.has('kind') ? kinds.length : 0,
    labelled,
    questions: questions.length,
  }
}
