import { z } from 'zod'
import { PaletteChoiceSchema } from './palettes.ts'

// ---------------------------------------------------------------------------
// Tenant configuration - the single document that drives the whole portal UI.
// ---------------------------------------------------------------------------

/** The named Google Fonts heading/body pairings a portal can choose from. */
export const FontPairingIdSchema = z.enum([
  'albert-barlow',
  'fraunces-poppins',
  'corben-montserrat',
  'bebas-heebo',
  'lexend-zilla',
])
export type FontPairingId = z.infer<typeof FontPairingIdSchema>

/**
 * A portal's typeface choice: a named pairing, 'custom' for uploaded font
 * files, or 'default' for the house faces. Absent means 'default'.
 */
export const TypographyChoiceSchema = z.union([
  FontPairingIdSchema,
  z.literal('custom'),
  z.literal('default'),
])
export type TypographyChoice = z.infer<typeof TypographyChoiceSchema>

/**
 * Shape language: 'square' has no rounding, 'rounded' slightly rounds
 * surfaces, buttons and tags, 'soft' rounds surfaces further and makes
 * buttons and tags pill-shaped. Absent means 'square'.
 */
export const ShapeIdSchema = z.enum(['square', 'rounded', 'soft'])
export type ShapeId = z.infer<typeof ShapeIdSchema>

/**
 * Base text size: scales the root font size so the whole rem-based interface
 * (text and the spacing tied to it) sizes up or down together. Absent means
 * 'default'.
 */
export const TextScaleIdSchema = z.enum(['default', 'smaller', 'larger'])
export type TextScaleId = z.infer<typeof TextScaleIdSchema>

/**
 * Interface density: rescales the spacing rhythm (paddings, gaps, stacks)
 * without touching text sizes. 'compact' fits more on screen, 'comfortable'
 * adds a touch of air, 'spacious' is the airy reading-first setting. Absent
 * means 'default'.
 */
export const DensityIdSchema = z.enum(['compact', 'default', 'comfortable', 'spacious'])
export type DensityId = z.infer<typeof DensityIdSchema>

export const BrandingSchema = z.object({
  /** Own-system product name, e.g. "GrainsIQ Research Portal" - never vendor branding. */
  productName: z.string().min(1),
  organisation: z.string().min(1),
  tagline: z.string().min(1),
  colours: z.object({
    /** All values are CSS colours. */
    primary: z.string(),
    accent: z.string(),
    heroFrom: z.string(),
    heroTo: z.string(),
  }),
  typography: TypographyChoiceSchema.optional(),
  /**
   * Colour palette choice: a stock library palette, or 'default' for the
   * portal's own seeded identity (its legacy `colours`). Absent means
   * 'default', so existing portals render unchanged.
   */
  paletteId: PaletteChoiceSchema.optional(),
  shape: ShapeIdSchema.optional(),
  textScale: TextScaleIdSchema.optional(),
  density: DensityIdSchema.optional(),
  /** Served when an administrator uploaded a logo for this portal. */
  logoUrl: z.string().optional(),
  /** Served when an administrator uploaded a hero image for this portal. */
  heroImageUrl: z.string().optional(),
  /** Wide image behind slim page headers (e.g. the knowledge map). */
  bannerImageUrl: z.string().optional(),
  /** Served when custom heading/body font files are uploaded (typography 'custom'). */
  headingFontUrl: z.string().optional(),
  bodyFontUrl: z.string().optional(),
  /**
   * The portal's seeded brand typefaces, as CSS font stacks (each family must
   * also be loaded in apps/web/index.html). These are what 'default' means for
   * this portal: used when `typography` is absent or 'default', and overridden
   * by any explicit pairing or custom-upload choice made in Manage.
   */
  fonts: z.object({
    /** Body and UI. */
    sans: z.string(),
    /** Headings (.rp-display). */
    display: z.string(),
  }).optional(),
})

/** One face of a font pairing, with the display metrics the theme layer applies. */
export interface PairingHeadingFace {
  family: string
  /** Weight for .rp-display headings. */
  weight: number
  /** Weight .rp-display-bold escalates to (equal to `weight` when the face has one cut). */
  boldWeight: number
  /** Letter-spacing for display headings - display faces want different tracking. */
  tracking: string
  /** Line-height for display headings. */
  leading: string
}

export interface FontPairing {
  id: FontPairingId
  label: string
  heading: PairingHeadingFace
  body: {
    family: string
    /** Base body weight - e.g. 300 for a deliberately light body face. */
    weight: number
  }
  /** Query string for the Google Fonts css2 stylesheet loading both faces. */
  googleQuery: string
}

/**
 * The five heading/body pairings offered in Appearance. The weights requested
 * in `googleQuery` must exist for the face (css2 rejects the whole request
 * otherwise) - Corben ships only 400/700 and Bebas Neue only 400.
 */
export const FONT_PAIRINGS: Record<FontPairingId, FontPairing> = {
  'albert-barlow': {
    id: 'albert-barlow',
    label: 'Albert Sans & Barlow',
    heading: {
      family: 'Albert Sans',
      weight: 600,
      boldWeight: 700,
      tracking: '-0.02em',
      leading: '1.05',
    },
    body: { family: 'Barlow', weight: 400 },
    googleQuery: 'family=Albert+Sans:wght@600;700&family=Barlow:wght@400;500;600;700',
  },
  'fraunces-poppins': {
    id: 'fraunces-poppins',
    label: 'Fraunces & Poppins',
    heading: {
      family: 'Fraunces',
      weight: 700,
      boldWeight: 800,
      tracking: '-0.015em',
      leading: '1.08',
    },
    body: { family: 'Poppins', weight: 400 },
    googleQuery: 'family=Fraunces:wght@700;800&family=Poppins:wght@400;500;600;700',
  },
  'corben-montserrat': {
    id: 'corben-montserrat',
    label: 'Corben & Montserrat',
    heading: { family: 'Corben', weight: 700, boldWeight: 700, tracking: '0em', leading: '1.15' },
    body: { family: 'Montserrat', weight: 400 },
    googleQuery: 'family=Corben:wght@400;700&family=Montserrat:wght@400;500;600;700',
  },
  'bebas-heebo': {
    id: 'bebas-heebo',
    label: 'Bebas Neue & Heebo Light',
    heading: {
      family: 'Bebas Neue',
      weight: 400,
      boldWeight: 400,
      tracking: '0.01em',
      leading: '0.98',
    },
    body: { family: 'Heebo', weight: 300 },
    googleQuery: 'family=Bebas+Neue&family=Heebo:wght@300;400;500;600;700',
  },
  'lexend-zilla': {
    id: 'lexend-zilla',
    label: 'Lexend & Zilla Slab',
    heading: {
      family: 'Lexend',
      weight: 600,
      boldWeight: 700,
      tracking: '-0.012em',
      leading: '1.05',
    },
    body: { family: 'Zilla Slab', weight: 400 },
    googleQuery: 'family=Lexend:wght@600;700&family=Zilla+Slab:wght@400;500;600;700',
  },
}

export const TopicSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})

export const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
})

export const EntityTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  colour: z.string(),
})

/** A lower-case public DNS hostname, without a scheme, path or port. */
export const TenantHostnameSchema = z.string().max(253).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
)

export const TenantSummarySchema = z.object({
  slug: z.string().min(1),
  organisation: z.string().min(1),
  productName: z.string().min(1),
  tagline: z.string().min(1),
  /** Present only when this portal has a working dedicated hostname. */
  hostname: TenantHostnameSchema.optional(),
})

export const TenantConfigSchema = z.object({
  slug: z.string().min(1),
  /** Present only when this portal has a working dedicated hostname. */
  hostname: TenantHostnameSchema.optional(),
  branding: BrandingSchema,
  searchPlaceholder: z.string(),
  topics: TopicSchema.array(),
  suggestedQuestions: QuestionSchema.array(),
  entityTypes: EntityTypeSchema.array(),
  relationTypes: z.string().array(),
})

// ---------------------------------------------------------------------------
// Knowledge box connection status - which backing store a tenant is wired to.
// "demo" = the seeded demo knowledge box shipped with the app; "connected" =
// a knowledge box an administrator connected in the app; "none" = not wired.
// Never carries credentials.
// ---------------------------------------------------------------------------

export const KnowledgeBoxStatusSchema = z.object({
  slug: z.string().min(1),
  status: z.enum(['demo', 'connected', 'none']),
  /** Truncated knowledge box id for display - never the token. */
  kbId: z.string().optional(),
})

/** One row of the admin overview - everything the admin screen shows per tenant. */
export const AdminTenantOverviewSchema = z.object({
  tenant: TenantSummarySchema,
  knowledgeBox: KnowledgeBoxStatusSchema,
  /** Documents currently visible in the bound knowledge box; null when unreachable. */
  resourceCount: z.number().int().nonnegative().nullable(),
  /** True for portals added in-app (removable), false for the seeded pair. */
  custom: z.boolean().optional(),
  /** True when the portal is hidden from the switcher and portal list. */
  disabled: z.boolean().optional(),
})

/** Live knowledge box counters, straight from the platform's /counters. */
export const KbCountersSchema = z.object({
  resources: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative(),
  sentences: z.number().int().nonnegative(),
  indexMb: z.number().nonnegative(),
})

/** A recently added resource with its live processing state. */
export const RecentResourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'processed', 'error']),
  created: z.string().optional(),
  /** Draft resources are hidden from searchers until published. */
  hidden: z.boolean().optional(),
})

/** Progress events streamed by corpus analysis (interrogate the box, derive
 * taxonomy + graph strategy + questions, and apply them). */
export const AnalyseEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), label: z.string() }),
  z.object({ type: z.literal('item'), label: z.string(), detail: z.string().optional() }),
  z.object({
    type: z.literal('done'),
    topics: z.number().int().nonnegative(),
    kinds: z.number().int().nonnegative(),
    labelled: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

/** Progress events streamed by the knowledge-box migration tool. */
export const MigrationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), total: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('item'),
    id: z.string(),
    title: z.string(),
    outcome: z.enum(['copied', 'skipped-exists', 'skipped-unsupported', 'error']),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('done'),
    copied: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

// ---------------------------------------------------------------------------
// Resources - documents, videos and web pages in the tenant's corpus.
// ---------------------------------------------------------------------------

export const ResourceTypeSchema = z.enum(['document', 'pdf', 'video', 'web'])

export const ResourceSummarySchema = z.object({
  id: z.string().min(1),
  /** Merchandised display headline - never a raw filename when a better one exists. */
  title: z.string().min(1),
  summary: z.string().min(1),
  type: ResourceTypeSchema,
  topicIds: z.string().array(),
  keyFacts: z.string().array(),
  /** ISO date the source was published, when known. */
  published: z.string().optional(),
  /** Label in the 'kind' labelset, when classified. */
  kind: z.string().optional(),
  /**
   * The raw source name (original filename/project code, e.g. "1981-071-DLD.pdf").
   * Kept as secondary, muted metadata; never the headline. Absent when the raw
   * title already reads as a real title.
   */
  sourceName: z.string().optional(),
  /** Merchandised key takeaways from the default enrichment, when generated. */
  keyTakeaways: z.string().array().optional(),
  /** Merchandised notable quotes from the default enrichment, when generated. */
  quotesOfInterest: z.string().array().optional(),
  /** True when a generated enrichment (not just a filename fallback) drives title/summary. */
  enriched: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// Enrichments - schema-driven merchandising written onto resources.
//
// A resource carries one or more "enrichments". Each enrichment is produced by
// an enrichment AGENT: a named generator with a JSON schema. The app renders
// whatever fields the schema defines PROGRAMMATICALLY, so a resource is never
// shown as a raw filename. The default "research summary" agent is the first
// enrichment (title, summary, key takeaways, quotes of interest); Phase 2 lets
// users add further agents ("lenses"). The label model applies here too: an
// enrichment has a SCOPE (resource-level or paragraph/block-level) and a
// CARDINALITY (single/exclusive or multiple), mirroring how labels attach.
// ---------------------------------------------------------------------------

/**
 * How a schema field renders. `title`/`summary` are single strings that drive
 * a resource's headline and blurb everywhere; `list`/`quotes` are string
 * arrays (scannable bullets, verbatim quotes). New kinds flow through the
 * programmatic renderer without touching each surface.
 */
export const EnrichmentFieldKindSchema = z.enum(['title', 'summary', 'list', 'quotes'])

export const EnrichmentFieldSchema = z.object({
  /** Stable key in the generated JSON object. */
  key: z.string().min(1),
  /** Human label shown above the field on the resource page and in Management. */
  label: z.string().min(1),
  kind: EnrichmentFieldKindSchema,
  /** Instruction the generator follows for this field - also shown in Management. */
  description: z.string().min(1),
})

/** Resource-level vs paragraph/block-level, mirroring the label model. */
export const EnrichmentScopeSchema = z.enum(['resource', 'paragraph'])
/** Exclusive (one per resource) vs multiple (several lenses), mirroring labels. */
export const EnrichmentCardinalitySchema = z.enum(['single', 'multiple'])

/** A generator agent + its JSON schema - the unit users see and run in Management. */
export const EnrichmentAgentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  scope: EnrichmentScopeSchema,
  cardinality: EnrichmentCardinalitySchema,
  /** True for the default research-summary agent shipped with the portal. */
  isDefault: z.boolean(),
  fields: EnrichmentFieldSchema.array().min(1),
})

/** One generated enrichment stored against a resource. */
export const EnrichmentSchema = z.object({
  /** The agent that produced it (EnrichmentAgent.id). */
  schemaId: z.string().min(1),
  generatedAt: z.string().min(1),
  /** The generated object, keyed by the agent's field keys. */
  data: z.record(z.string(), z.unknown()),
  /** Provenance flag: summary reused the platform's DA page-summary field. */
  usedPageSummary: z.boolean().optional(),
  /**
   * Provenance flag: structured generation returned nothing usable (a
   * pending resource, thin/garbled text, a transient platform error), so
   * this is a graceful-degradation fallback - the page summary (or baseline
   * cleaned name) rather than a full generated title/summary/takeaways/quotes.
   */
  degraded: z.boolean().optional(),
})

export type EnrichmentFieldKind = z.infer<typeof EnrichmentFieldKindSchema>
export type EnrichmentField = z.infer<typeof EnrichmentFieldSchema>
export type EnrichmentScope = z.infer<typeof EnrichmentScopeSchema>
export type EnrichmentCardinality = z.infer<typeof EnrichmentCardinalitySchema>
export type EnrichmentAgent = z.infer<typeof EnrichmentAgentSchema>
export type Enrichment = z.infer<typeof EnrichmentSchema>

/**
 * The default research-summary enrichment agent: the initial resource summary
 * every portal ships with. Its fields drive the merchandised headline (title),
 * blurb (summary) and scannable detail (key takeaways, quotes) on every
 * surface. Rendering is programmatic from `fields`, so extending this schema
 * (or adding a Phase 2 lens) flows through with no per-surface change.
 */
export const DEFAULT_RESEARCH_ENRICHMENT: EnrichmentAgent = {
  id: 'research-summary',
  title: 'Research summary',
  description: 'The default enrichment. Reads each resource and writes a clean, human title, a ' +
    'plain-language summary, the key takeaways and a few notable quotes, so the resource ' +
    'presents as a real research item rather than a raw filename.',
  scope: 'resource',
  cardinality: 'single',
  isDefault: true,
  fields: [
    {
      key: 'title',
      label: 'Title',
      kind: 'title',
      description:
        'A concise, descriptive title for the document in plain language (roughly 4 to 12 ' +
        'words). Never the filename or a project code - say what the document is about.',
    },
    {
      key: 'summary',
      label: 'Summary',
      kind: 'summary',
      description:
        'A plain-language summary of what this document is and what it found or covers, in ' +
        'two to four sentences. Australian English, no jargon where a plain word will do.',
    },
    {
      key: 'keyTakeaways',
      label: 'Key takeaways',
      kind: 'list',
      description:
        'The three to six most important findings, results or points, each as one short, ' +
        'scannable line. Specifics over generalities.',
    },
    {
      key: 'quotesOfInterest',
      label: 'Quotes of interest',
      kind: 'quotes',
      description:
        'Up to three short, verbatim quotes from the document that are genuinely notable. ' +
        'Omit rather than paraphrase; return an empty list if none stand out.',
    },
  ],
}

/** Every enrichment agent the portal offers today (Phase 1: the default only). */
export const ENRICHMENT_AGENTS: EnrichmentAgent[] = [DEFAULT_RESEARCH_ENRICHMENT]

/** Management view of one enrichment agent: the agent, its JSON schema and run coverage. */
export const EnrichmentAgentStatusSchema = z.object({
  agent: EnrichmentAgentSchema,
  /** The exact JSON schema the generator is given - shown to the user in Management. */
  jsonSchema: z.record(z.string(), z.unknown()),
  /** Resources with a generated enrichment for this agent. */
  enrichedCount: z.number().int().nonnegative(),
  /** Displayable resources in the corpus. */
  totalCount: z.number().int().nonnegative(),
  /** How the enrichment is produced today - honest disclosure of the platform path. */
  generationNote: z.string(),
})

/** Progress events streamed while an enrichment agent runs over the corpus. */
export const EnrichmentRunEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), total: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('item'),
    id: z.string(),
    title: z.string(),
    outcome: z.enum(['enriched', 'error']),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('done'),
    enriched: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

export type EnrichmentAgentStatus = z.infer<typeof EnrichmentAgentStatusSchema>
export type EnrichmentRunEvent = z.infer<typeof EnrichmentRunEventSchema>

/**
 * The OpenAI-function-style JSON schema for an agent, used both as the
 * `answer_json_schema` sent to the query-time generator and as the schema
 * shown to the user in Management. Derived from `fields` so the two can never
 * drift.
 */
export function enrichmentJsonSchema(
  agent: EnrichmentAgent,
): { name: string; description: string; parameters: Record<string, unknown> } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const field of agent.fields) {
    properties[field.key] = field.kind === 'list' || field.kind === 'quotes'
      ? { type: 'array', items: { type: 'string' }, description: field.description }
      : { type: 'string', description: field.description }
    // Title and summary are the load-bearing display fields - always required.
    if (field.kind === 'title' || field.kind === 'summary') required.push(field.key)
  }
  return {
    name: agent.id.replace(/-/g, '_'),
    description: agent.description,
    parameters: { type: 'object', additionalProperties: false, properties, required },
  }
}

/**
 * Coerce a raw generated object into clean, schema-conformant enrichment data:
 * string fields to trimmed strings, list/quote fields to arrays of trimmed
 * non-empty strings. Unknown keys are dropped; missing fields become '' or [].
 * Pure and total, so a partial or slightly malformed model response never
 * throws on a user-facing path.
 */
export function parseEnrichmentData(
  agent: EnrichmentAgent,
  raw: unknown,
): Record<string, unknown> {
  const source = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const field of agent.fields) {
    const value = source[field.key]
    if (field.kind === 'list' || field.kind === 'quotes') {
      out[field.key] = Array.isArray(value)
        ? value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
        : []
    } else {
      out[field.key] = typeof value === 'string' ? value.trim() : ''
    }
  }
  return out
}

/** The value of the first field of a given kind - programmatic, no hardcoded keys. */
export function enrichmentString(
  agent: EnrichmentAgent,
  data: Record<string, unknown>,
  kind: EnrichmentFieldKind,
): string {
  const field = agent.fields.find((f) => f.kind === kind)
  if (!field) return ''
  const value = data[field.key]
  return typeof value === 'string' ? value.trim() : ''
}

/** The array value of the first list/quotes field of a given kind - programmatic. */
export function enrichmentList(
  agent: EnrichmentAgent,
  data: Record<string, unknown>,
  kind: EnrichmentFieldKind,
): string[] {
  const field = agent.fields.find((f) => f.kind === kind)
  if (!field) return []
  const value = data[field.key]
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
}

export const ScoredResourceSchema = ResourceSummarySchema.extend({
  /** Retrieval relevance in [0, 1]. */
  relevance: z.number().min(0).max(1),
  /** How many citations in the current answer point at this resource. */
  citedCount: z.number().int().nonnegative().default(0),
  matchedPassage: z.string().optional(),
  /** Page the matched passage sits on (PDFs), for open-at-page links. */
  matchedPage: z.number().int().positive().optional(),
  /** True when the matched passage looks like a reference list or front matter. */
  referenceChunk: z.boolean().optional(),
})

export const SearchResultsSchema = z.object({
  query: z.string(),
  resources: ScoredResourceSchema.array(),
  relatedQuestions: QuestionSchema.array(),
})

export const RetrievalModeSchema = z.enum(['hybrid', 'semantic', 'keyword'])

/** One page of the tenant's catalogue (the Library view). */
export const CatalogItemSchema = z.object({
  id: z.string().min(1),
  /** Merchandised display headline - never a raw filename when a better one exists. */
  title: z.string().min(1),
  status: z.enum(['pending', 'processed', 'error']),
  created: z.string().optional(),
  topicIds: z.string().array(),
  /** Label in the 'kind' labelset, when classified. */
  kind: z.string().optional(),
  /** ISO date the source was published, when known. */
  published: z.string().optional(),
  /** Merchandised blurb from the default enrichment, when generated. */
  summary: z.string().optional(),
  /** The raw source name (original filename/project code); muted secondary only. */
  sourceName: z.string().optional(),
  /** True when a generated enrichment drives the title/summary. */
  enriched: z.boolean().optional(),
})

export const CatalogPageSchema = z.object({
  items: CatalogItemSchema.array(),
  total: z.number().int().nonnegative(),
})

/** A taxonomy category (labelset) with its labels. */
export const LabelsetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  multiple: z.boolean(),
  labels: z.string().array(),
  /** RESOURCES (document-level) or PARAGRAPHS (passage-level). */
  kind: z.enum(['RESOURCES', 'PARAGRAPHS']).optional(),
})

/** Facet counts: labelset id -> label -> count of resources carrying it. */
export const FacetCountsSchema = z.record(z.string(), z.record(z.string(), z.number()))

/** Label co-occurrence graph (the reference portal's knowledge-graph model). */
export const GraphDataSchema = z.object({
  primary: z.string(),
  secondary: z.string(),
  nodes: z
    .object({
      id: z.string(),
      label: z.string(),
      group: z.enum(['primary', 'secondary']),
      weight: z.number().nonnegative(),
    })
    .array(),
  edges: z
    .object({ source: z.string(), target: z.string(), weight: z.number().nonnegative() })
    .array(),
})

/** Grounded, schema-enforced artifact kinds the Generate surface offers. */
export const GenerateKindSchema = z.enum([
  'comparison',
  'briefing',
  'timeline',
  'proscons',
  'faq',
  'assessment',
])

export const GenerateResultSchema = z.object({
  kind: GenerateKindSchema,
  /** Absent when the corpus lacked sufficient grounding - see insufficientGrounding. */
  object: z.unknown().optional(),
  sources: z.lazy(() => ScoredResourceSchema.array()),
  /**
   * True when retrieval found no sufficiently relevant material for this
   * topic and generation was refused rather than fabricated from
   * background knowledge - the structured-artefact equivalent of `ask`'s
   * honest refusal. `object` is absent in this case; `message` carries the
   * reader-facing explanation.
   */
  insufficientGrounding: z.boolean().optional(),
  message: z.string().optional(),
})

/** Full typed content of one resource, for the type-aware detail view. */
export const ResourceContentSchema = z.object({
  id: z.string(),
  /** Merchandised display headline - never a raw filename when a better one exists. */
  title: z.string(),
  kind: z.enum(['web', 'pdf', 'video', 'audio', 'image', 'office', 'text', 'file']),
  originUrl: z.string().optional(),
  summary: z.string().optional(),
  /**
   * The platform DA "page summary" agent's per-resource summary, read back from
   * the `da-pagesummary-f-*` field when present. A real, human summary already
   * paid for at ingest time - used as the merchandised summary source before
   * any richer enrichment is generated.
   */
  pageSummary: z.string().optional(),
  /** The raw source name (original filename/project code); muted secondary only. */
  sourceName: z.string().optional(),
  /** Merchandised key takeaways from the default enrichment, when generated. */
  keyTakeaways: z.string().array().optional(),
  /** Merchandised notable quotes from the default enrichment, when generated. */
  quotesOfInterest: z.string().array().optional(),
  /** True when a generated enrichment drives the title/summary. */
  enriched: z.boolean().optional(),
  /** Extracted text per field. */
  texts: z.object({ fieldId: z.string(), text: z.string() }).array(),
  /** Timed transcript segments when the platform extracted timings. */
  transcript: z
    .object({ text: z.string(), startSec: z.number().nonnegative().optional() })
    .array(),
  /** Streamable file fields (group/field for the proxy route). */
  files: z
    .object({ group: z.string(), fieldId: z.string(), contentType: z.string().optional() })
    .array(),
  /**
   * A browser-renderable rendition (PDF or image) of an original the browser
   * cannot display natively - an Office document - when the platform generated
   * one. Absent when there is no rendition; the viewer then shows the honest
   * thumbnail + download fallback rather than pretending.
   */
  preview: z
    .object({ fieldId: z.string(), contentType: z.string().optional() })
    .optional(),
})

/** A data-augmentation agent registered on the knowledge box. */
export const KbAgentSchema = z.object({
  id: z.string(),
  task: z.string(),
  title: z.string(),
})

/** The proposed knowledge-graph strategy, shown to the user before implementing. */
export const KgProposalSchema = z.object({
  rationale: z.string(),
  entityTypes: z.object({ label: z.string(), description: z.string() }).array(),
  resourceLabels: z.object({ label: z.string(), description: z.string() }).array(),
  chunkLabels: z.object({ label: z.string(), description: z.string() }).array(),
  /** Few-shot NER examples so the graph agent learns entity RELATIONS too. */
  examples: z
    .object({
      text: z.string(),
      entities: z.object({ name: z.string(), label: z.string() }).array(),
      relations: z
        .object({ source: z.string(), target: z.string(), label: z.string() })
        .array(),
    })
    .array()
    .default([]),
})

export const KgImplementEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), label: z.string() }),
  z.object({ type: z.literal('item'), label: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal('done'), agents: z.number().int().nonnegative() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

// ---------------------------------------------------------------------------
// Ask - the streamed, cited answer experience.
// ---------------------------------------------------------------------------

export const CitationSchema = z.object({
  /** 1-based citation number as it appears in the answer text, e.g. [1]. */
  index: z.number().int().positive(),
  resourceId: z.string().min(1),
  title: z.string().min(1),
  passage: z.string().optional(),
})

export const AskStageSchema = z.enum(['preprocessing', 'retrieval', 'generating', 'validating'])

export const AskEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'),
    stage: AskStageSchema,
    status: z.enum(['started', 'completed']),
  }),
  z.object({ type: z.literal('sources'), resources: ScoredResourceSchema.array() }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('citation'), citation: CitationSchema }),
  z.object({
    /** Platform learning id for this answer - target for feedback. */
    type: z.literal('learning'),
    id: z.string(),
  }),
  z.object({
    /** The query as the platform interpreted or rephrased it. */
    type: z.literal('interpreted'),
    query: z.string(),
  }),
  z.object({
    /** Sub-queries automatically researched alongside the main question. */
    type: z.literal('searched'),
    queries: z.string().array(),
  }),
  z.object({
    type: z.literal('quality'),
    /** REMi scores, 0 to 5. Null when a metric could not be computed. */
    answerRelevance: z.number().nullable(),
    groundedness: z.number().nullable(),
    contextRelevance: z.number().nullable(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    firstChunkSec: z.number().nonnegative().optional(),
    totalSec: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('done'),
    /** True when the corpus could not answer and guidance was shown instead. */
    refused: z.boolean().optional(),
    /**
     * The complete answer text with deterministic citation binding applied -
     * the model's own inline `[n]` markers stripped and replaced with
     * markers spliced at the platform's citation char-offsets, numbered to
     * match the `citation` events emitted just before this one. Present
     * whenever citation binding ran (a non-refused answer); the client
     * should replace its accumulated streamed text with this string so the
     * final rendered prose, the evidence table and the click-through
     * targets agree by construction.
     */
    text: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Branding = z.infer<typeof BrandingSchema>
export type Topic = z.infer<typeof TopicSchema>
export type Question = z.infer<typeof QuestionSchema>
export type EntityType = z.infer<typeof EntityTypeSchema>
export type TenantSummary = z.infer<typeof TenantSummarySchema>
export type TenantConfig = z.infer<typeof TenantConfigSchema>
export type KnowledgeBoxStatus = z.infer<typeof KnowledgeBoxStatusSchema>
export type AdminTenantOverview = z.infer<typeof AdminTenantOverviewSchema>
export type KbCounters = z.infer<typeof KbCountersSchema>
export type RecentResource = z.infer<typeof RecentResourceSchema>
export type MigrationEvent = z.infer<typeof MigrationEventSchema>
export type AnalyseEvent = z.infer<typeof AnalyseEventSchema>
export type ResourceContent = z.infer<typeof ResourceContentSchema>
export type KbAgent = z.infer<typeof KbAgentSchema>
export type KgProposal = z.infer<typeof KgProposalSchema>
export type KgImplementEvent = z.infer<typeof KgImplementEventSchema>
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>
export type CatalogItem = z.infer<typeof CatalogItemSchema>
export type CatalogPage = z.infer<typeof CatalogPageSchema>
export type Labelset = z.infer<typeof LabelsetSchema>
export type FacetCounts = z.infer<typeof FacetCountsSchema>
export type GraphData = z.infer<typeof GraphDataSchema>
export type GenerateKind = z.infer<typeof GenerateKindSchema>
export type GenerateResult = {
  kind: GenerateKind
  object?: unknown
  sources: ScoredResource[]
  insufficientGrounding?: boolean
  message?: string
}
export type ResourceType = z.infer<typeof ResourceTypeSchema>
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>
export type ScoredResource = z.infer<typeof ScoredResourceSchema>
export type SearchResults = z.infer<typeof SearchResultsSchema>
export type Citation = z.infer<typeof CitationSchema>
export type AskStage = z.infer<typeof AskStageSchema>
export type AskEvent = z.infer<typeof AskEventSchema>

// ---------------------------------------------------------------------------
// In-app user documentation (the Help section) + the documentation-isolation
// contract shared by the web front end and the retrieval provider.
// ---------------------------------------------------------------------------
export * from './docs.ts'
export * from './palettes.ts'
