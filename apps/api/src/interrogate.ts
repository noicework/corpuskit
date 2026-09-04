import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { type GraphStrategyInput, replaceGraphStrategy } from './kg.ts'

// ---------------------------------------------------------------------------
// Knowledge-box interrogation: examine what the box holds and how it is set
// up, then propose discrete, individually actionable suggestions - new or
// extended labelsets, new entity types, extra worked examples. The librarian
// implements or ignores each with one click.
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string
  kind: 'labelset' | 'label-addition' | 'entity-type' | 'graph-example'
  title: string
  detail: string
  status: 'pending' | 'implemented' | 'ignored'
  createdAt: string
  /** Payload interpreted per kind. */
  labelset?: { id: string; title: string; paragraphs: boolean; labels: string[] }
  labels?: { labelsetId: string; labels: string[] }
  entityType?: { label: string; description: string }
  example?: {
    text: string
    entities: { name: string; label: string }[]
    relations: { source: string; target: string; label: string }[]
  }
}

const DATA_DIR = process.env.DATA_DIR ?? './data'

export class SuggestionStore {
  private pathFor(slug: string): string {
    const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
    return join(DATA_DIR, 'suggestions', `${safe}.json`)
  }

  list(slug: string): Suggestion[] {
    try {
      return JSON.parse(readFileSync(this.pathFor(slug), 'utf8')) as Suggestion[]
    } catch {
      return []
    }
  }

  replacePending(slug: string, fresh: Suggestion[]): Suggestion[] {
    // A new interrogation supersedes old pending suggestions but keeps the
    // decision history (implemented/ignored) for context.
    const kept = this.list(slug).filter((s) => s.status !== 'pending').slice(-40)
    const next = [...fresh, ...kept]
    this.persist(slug, next)
    return next
  }

  setStatus(slug: string, id: string, status: 'implemented' | 'ignored'): Suggestion | null {
    const all = this.list(slug)
    const found = all.find((s) => s.id === id)
    if (!found) return null
    found.status = status
    this.persist(slug, all)
    return found
  }

  private persist(slug: string, all: Suggestion[]): void {
    const path = this.pathFor(slug)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(all, null, 2))
  }
}

/** Public suggestion-store contract for alternate durable runtimes. */
export type SuggestionStoreApi = Pick<SuggestionStore, keyof SuggestionStore>

const INTERROGATION_SCHEMA = {
  name: 'setup_suggestions',
  description: 'Discrete improvement suggestions for how this knowledge box is organised',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['labelset', 'label-addition', 'entity-type', 'graph-example'],
            },
            title: { type: 'string' },
            detail: { type: 'string' },
            labelsetTitle: { type: 'string' },
            paragraphLevel: { type: 'boolean' },
            labels: { type: 'array', items: { type: 'string' } },
            targetLabelset: { type: 'string' },
            entityLabel: { type: 'string' },
            entityDescription: { type: 'string' },
            exampleText: { type: 'string' },
            exampleEntities: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' }, label: { type: 'string' } },
                required: ['name', 'label'],
              },
            },
            exampleRelations: {
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
          required: [
            'kind',
            'title',
            'detail',
            'labelsetTitle',
            'paragraphLevel',
            'labels',
            'targetLabelset',
            'entityLabel',
            'entityDescription',
            'exampleText',
            'exampleEntities',
            'exampleRelations',
          ],
        },
      },
    },
    required: ['suggestions'],
  },
}

const slugifyId = (raw: string) =>
  raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

/**
 * Interrogate the box: gather its current setup and content shape, ask the
 * platform's own generative model for discrete improvements, and store them
 * as pending suggestions.
 */
export async function runInterrogation(
  management: AragProvider,
  config: TenantConfig,
  store: SuggestionStoreApi,
): Promise<Suggestion[]> {
  const [labelsets, strategy, resources] = await Promise.all([
    management.labelsets(config).catch(() => []),
    management.graphStrategy(config).catch(() => null),
    management.listResources(config).catch(() => []),
  ])

  const setup = [
    'Current labelsets:',
    ...labelsets.map((ls) => `- ${ls.id} (${ls.title}): ${ls.labels.join(', ')}`),
    '',
    'Current knowledge-graph entity types:',
    ...(strategy?.entityDefs ?? []).map((d) => `- ${d.label}: ${d.description ?? ''}`),
    '',
    `Corpus sample (${resources.length} resources):`,
    ...resources.slice(0, 40).map((r) => `- ${r.title}: ${r.summary.slice(0, 140)}`),
  ].join('\n')

  const prompt = [
    'You are auditing how a research knowledge box is organised. Based on the current setup ' +
    'and the content sample below, propose 3 to 8 DISCRETE improvements, each independently ' +
    'actionable. Allowed kinds:',
    "- 'labelset': a NEW labelset that is missing (set labelsetTitle, paragraphLevel, labels 4-8).",
    "- 'label-addition': labels missing from an EXISTING labelset (set targetLabelset to its id, labels 1-5).",
    "- 'entity-type': a NEW knowledge-graph entity type the corpus clearly contains (set entityLabel, entityDescription).",
    "- 'graph-example': ONE worked example teaching a relation the graph misses - text must be a realistic sentence " +
    'from this domain, exampleEntities tag names with EXISTING or proposed entity types, exampleRelations link those exact names.',
    'Every suggestion needs a short title and a detail sentence explaining the benefit. ' +
    'Fill only the fields relevant to the kind; set unused string fields to "", unused arrays ' +
    'to [], and paragraphLevel to false unless labelling passages. ' +
    'Do not suggest things that already exist. Australian English.',
    '',
    setup,
  ].join('\n')

  const result = await management.askStructured(config, INTERROGATION_SCHEMA, prompt)
  const raw = (result.object as { suggestions?: unknown }).suggestions
  const items = Array.isArray(raw) ? raw : []
  const existingLabelsetIds = new Set(labelsets.map((ls) => ls.id))
  const fresh: Suggestion[] = []
  for (const item of items) {
    const s = item as Record<string, unknown>
    const kind = s.kind as Suggestion['kind']
    const base = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      title: String(s.title ?? '').slice(0, 160),
      detail: String(s.detail ?? '').slice(0, 500),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }
    if (!base.title) continue
    if (kind === 'labelset' && typeof s.labelsetTitle === 'string' && Array.isArray(s.labels)) {
      const id = slugifyId(s.labelsetTitle)
      if (!id || existingLabelsetIds.has(id)) continue
      fresh.push({
        ...base,
        kind,
        labelset: {
          id,
          title: s.labelsetTitle,
          paragraphs: s.paragraphLevel === true,
          labels: (s.labels as unknown[]).map(String).filter(Boolean).slice(0, 10),
        },
      })
    } else if (
      kind === 'label-addition' && typeof s.targetLabelset === 'string' && Array.isArray(s.labels)
    ) {
      if (!existingLabelsetIds.has(s.targetLabelset)) continue
      fresh.push({
        ...base,
        kind,
        labels: {
          labelsetId: s.targetLabelset,
          labels: (s.labels as unknown[]).map(String).filter(Boolean).slice(0, 8),
        },
      })
    } else if (kind === 'entity-type' && typeof s.entityLabel === 'string') {
      fresh.push({
        ...base,
        kind,
        entityType: {
          label: s.entityLabel.slice(0, 60),
          description: String(s.entityDescription ?? '').slice(0, 400),
        },
      })
    } else if (kind === 'graph-example' && typeof s.exampleText === 'string') {
      fresh.push({
        ...base,
        kind,
        example: {
          text: s.exampleText.slice(0, 1500),
          entities: (Array.isArray(s.exampleEntities) ? s.exampleEntities : [])
            .map((e) => e as { name?: string; label?: string })
            .filter((e) => e.name && e.label)
            .map((e) => ({ name: String(e.name), label: String(e.label) })),
          relations: (Array.isArray(s.exampleRelations) ? s.exampleRelations : [])
            .map((r) => r as { source?: string; target?: string; label?: string })
            .filter((r) => r.source && r.target && r.label)
            .map((r) => ({
              source: String(r.source),
              target: String(r.target),
              label: String(r.label),
            })),
        },
      })
    }
  }
  return store.replacePending(config.slug, fresh)
}

/** Execute one suggestion against the live box. Returns a human summary. */
export async function implementSuggestion(
  management: AragProvider,
  config: TenantConfig,
  suggestion: Suggestion,
): Promise<string> {
  if (suggestion.kind === 'labelset' && suggestion.labelset) {
    await management.createLabelset(config, {
      id: suggestion.labelset.id,
      title: suggestion.labelset.title,
      multiple: true,
      labels: suggestion.labelset.labels,
      kind: suggestion.labelset.paragraphs ? 'PARAGRAPHS' : 'RESOURCES',
    })
    return `Labelset "${suggestion.labelset.title}" created with ${suggestion.labelset.labels.length} labels.`
  }
  if (suggestion.kind === 'label-addition' && suggestion.labels) {
    const labelsets = await management.labelsets(config)
    const target = labelsets.find((ls) => ls.id === suggestion.labels?.labelsetId)
    if (!target) throw new Error('The target labelset no longer exists.')
    const merged = [...new Set([...target.labels, ...suggestion.labels.labels])]
    await management.createLabelset(config, {
      id: target.id,
      title: target.title,
      multiple: target.multiple,
      labels: merged,
      kind: target.kind === 'PARAGRAPHS' ? 'PARAGRAPHS' : 'RESOURCES',
    })
    return `Added ${suggestion.labels.labels.length} labels to "${target.title}".`
  }
  if (
    (suggestion.kind === 'entity-type' && suggestion.entityType) ||
    (suggestion.kind === 'graph-example' && suggestion.example)
  ) {
    const strategy = await management.graphStrategy(config)
    if (!strategy) {
      throw new Error('No knowledge graph agent is registered - implement one first.')
    }
    const input: GraphStrategyInput = {
      entityTypes: [...strategy.entityDefs.map((d) => ({
        label: d.label,
        description: d.description,
      }))],
      examples: [...strategy.examples],
      applyExisting: false,
    }
    if (suggestion.kind === 'entity-type' && suggestion.entityType) {
      if (!input.entityTypes.some((t) => t.label === suggestion.entityType?.label)) {
        input.entityTypes.push(suggestion.entityType)
      }
    }
    if (suggestion.kind === 'graph-example' && suggestion.example) {
      // The example may tag entities with a type the strategy lacks - add it.
      for (const entity of suggestion.example.entities) {
        if (!input.entityTypes.some((t) => t.label === entity.label)) {
          input.entityTypes.push({ label: entity.label })
        }
      }
      if (!input.examples.some((e) => e.text === suggestion.example?.text)) {
        input.examples.push(suggestion.example)
      }
    }
    let failure: string | null = null
    for await (const event of replaceGraphStrategy(management, config, input)) {
      if (event.type === 'error') failure = event.message
    }
    if (failure) throw new Error(failure)
    return suggestion.kind === 'entity-type'
      ? `Entity type "${suggestion.entityType?.label}" added to the extraction strategy.`
      : 'Worked example added - the extractor now learns this relation.'
  }
  throw new Error('This suggestion cannot be implemented automatically.')
}
