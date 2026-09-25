import process from 'node:process'
import { readFileSync } from 'node:fs'
import {
  type AccessMode,
  AccessModeSchema,
  type TenantConfig,
  TenantConfigSchema,
  type TenantSummary,
} from '@research-portal/core'
import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'
import { type OwnedMutationBoundary, ownedWrite } from './stores.ts'

// ---------------------------------------------------------------------------
// Seed tenant configs - the single source of truth for tenant-driven theming
// and copy, validated at module load so a bad seed fails fast on boot.
// Persistence is deliberately plain JSON files on the volume (project rule:
// no SQLite or embedded databases unless absolutely unavoidable).
// ---------------------------------------------------------------------------

/** The public showcase domain, where these portal hostnames were attached by hand. */
const LEGACY_PLATFORM_DOMAIN = 'corpuskit.org'
const LEGACY_PLATFORM_SLUGS: ReadonlySet<string> = new Set(['marine', 'grains', 'opax'])

/**
 * Compatibility for showcase portals whose hostnames pre-date persisted hostname
 * metadata. OPAX was created at runtime, so its stored config needs the same
 * read-time upgrade as the two seeded portals. The upgrade applies only on the
 * showcase domain: another deployment never links to showcase hostnames, and a
 * portal it creates always gets a hostname through domain attachment instead.
 * Stores apply this when reading and never persist its result.
 */
export function withPlatformHostname(config: TenantConfig, platformDomain: string): TenantConfig {
  if (config.hostname || platformDomain !== LEGACY_PLATFORM_DOMAIN) return config
  if (!LEGACY_PLATFORM_SLUGS.has(config.slug)) return config
  return { ...config, hostname: `${config.slug}.${LEGACY_PLATFORM_DOMAIN}` }
}

export function tenantSummary(config: TenantConfig): TenantSummary {
  return {
    slug: config.slug,
    organisation: config.branding.organisation,
    productName: config.branding.productName,
    tagline: config.branding.tagline,
    ...(config.hostname ? { hostname: config.hostname } : {}),
  }
}

// The two showcase portals are fictional organisations over the synthetic seed
// corpus in content/seed. Their topic ids are the `topic` labels
// `deno task provision` pushes to the knowledge box and files each seed
// document under (content/seed/manifest.json) - Explore intersects them with
// the box's facet counts, so an id that is not a real label silently yields an
// empty portal. Both identities use a stock library palette; nothing here is
// sampled from a real organisation's brand.

const grains: TenantConfig = TenantConfigSchema.parse({
  slug: 'grains',
  branding: {
    productName: 'Dryland Cropping Research Portal',
    organisation: 'Dryland Cropping Research Alliance',
    tagline: 'Research for Australian dryland grain growers',
    colours: {
      primary: '#58281a',
      accent: '#e0863c',
      heroFrom: '#571f19',
      heroTo: '#6e3414',
    },
    paletteId: 'kiln',
  },
  searchPlaceholder: 'Search agronomy, crop protection, soils, farm business…',
  assessmentHeading: 'Industry Knowledge Areas',
  // These ids must match the `topic` labelset on the bound knowledge box -
  // Explore intersects them with the box's facet counts, so an id that is not a
  // real label silently yields an empty portal. Read from the box on
  // 2026-08-31; the comments are its resource counts.
  topics: [
    { id: 'crop-protection', label: 'Crop protection' },
    { id: 'soils-nutrition', label: 'Soils and nutrition' },
    { id: 'farm-business', label: 'Farm business' },
    { id: 'climate-environment', label: 'Climate and environment' },
    { id: 'harvest-storage', label: 'Harvest and storage' },
  ],
  suggestedQuestions: [
    {
      id: 'grains-q1',
      text: 'What rotation strategies help manage herbicide-resistant ryegrass?',
    },
    { id: 'grains-q2', text: 'How does nitrogen timing affect grain protein in dryland wheat?' },
    { id: 'grains-q3', text: 'How is stripe rust surveillance organised across growing regions?' },
    { id: 'grains-q4', text: 'How is frost risk managed across the southern cropping region?' },
    { id: 'grains-q5', text: 'What storage conditions reduce grain quality loss after harvest?' },
    { id: 'grains-q6', text: 'When does strategic liming pay off on acidic subsoils?' },
  ],
  entityTypes: [
    { id: 'crop', label: 'Crop', colour: '#7cb342' },
    { id: 'pest', label: 'Pest or disease', colour: '#e53935' },
    { id: 'researcher', label: 'Researcher', colour: '#5e97f6' },
    { id: 'project', label: 'Project', colour: '#e0863c' },
    { id: 'region', label: 'Growing region', colour: '#26a69a' },
  ],
  relationTypes: ['studies', 'affects', 'conducted-in', 'funded-by', 'collaborates-with'],
})

const marine: TenantConfig = TenantConfigSchema.parse({
  slug: 'marine',
  branding: {
    productName: 'Southern Waters Research Portal',
    organisation: 'Southern Waters Research Institute',
    tagline: 'Fisheries and aquaculture research for southern Australian waters',
    colours: {
      primary: '#0a3a57',
      accent: '#38a8e0',
      heroFrom: '#123a63',
      heroTo: '#0b4d66',
    },
    paletteId: 'fathom',
  },
  searchPlaceholder: 'Search fisheries, aquaculture, stock assessment, marine ecology…',
  assessmentHeading: 'Industry Knowledge Areas',
  // These ids must match the `topic` labelset actually on the bound knowledge
  // box - Explore intersects them with the box's classification facet counts,
  // so an id that is not a real label silently yields an empty portal.
  topics: [
    { id: 'stock-assessment', label: 'Stock assessment' },
    { id: 'aquaculture-biosecurity', label: 'Aquaculture biosecurity' },
    { id: 'post-harvest', label: 'Post-harvest and supply chain' },
    { id: 'marine-sustainability', label: 'Marine sustainability' },
    { id: 'fisheries-policy', label: 'Fisheries policy and management' },
  ],
  suggestedQuestions: [
    {
      id: 'marine-q1',
      text: 'What stock assessment methods are recommended for data-limited fisheries?',
    },
    { id: 'marine-q2', text: 'How is white spot disease being managed in prawn aquaculture?' },
    {
      id: 'marine-q3',
      text: 'What post-harvest handling practices best preserve rock lobster quality?',
    },
    {
      id: 'marine-q4',
      text: 'How are marine heatwaves affecting abalone populations along the southern coast?',
    },
    {
      id: 'marine-q5',
      text: 'What biosecurity controls reduce pathogen spread between aquaculture leases?',
    },
    {
      id: 'marine-q6',
      text: 'What does the latest research say about bycatch reduction in longline fisheries?',
    },
  ],
  entityTypes: [
    { id: 'species', label: 'Species', colour: '#7cb342' },
    { id: 'researcher', label: 'Researcher', colour: '#5e97f6' },
    { id: 'project', label: 'Project', colour: '#38a8e0' },
    { id: 'pathogen', label: 'Pathogen', colour: '#e53935' },
    { id: 'location', label: 'Location', colour: '#f6bf26' },
  ],
  relationTypes: ['studies', 'infects', 'located-in', 'funded-by', 'assesses'],
})

const tenantsBySlug: Record<string, TenantConfig> = {
  marine,
  grains,
}

/** A seeded portal's configuration; stores add the deployment's hostname when they read it. */
export function tenantConfig(slug: string): TenantConfig | undefined {
  return Object.hasOwn(tenantsBySlug, slug) ? tenantsBySlug[slug] : undefined
}

export function tenantSummaries(): TenantSummary[] {
  return Object.values(tenantsBySlug).map(tenantSummary)
}

/** Registry identifiers without projecting portal metadata. */
export function tenantSlugs(): string[] {
  return Object.keys(tenantsBySlug)
}

// ---------------------------------------------------------------------------
// Dynamic tenant store: the seed above plus knowledge box portals added in the
// app, persisted as JSON (TENANTS_PATH, default ./data/tenants.json).
// ---------------------------------------------------------------------------

/** Neutral dark palette for portals added in-app (until a theming pass). */
const DEFAULT_COLOURS = {
  primary: '#27364b',
  accent: '#5a8bd6',
  heroFrom: '#141d2b',
  heroTo: '#27364b',
}

export interface NewTenantInput {
  name: string
  organisation?: string
  tagline?: string
}

/** Config fields corpus analysis is allowed to rewrite. */
export interface TenantPatch {
  accessMode?: AccessMode
  hostname?: TenantConfig['hostname']
  topics?: TenantConfig['topics']
  suggestedQuestions?: TenantConfig['suggestedQuestions']
  searchPlaceholder?: string
  assessmentHeading?: string
  branding?: TenantConfig['branding']
  /** Portal-managed behaviour settings (system prompt, image grounding). */
  prompts?: { ask?: string; images?: boolean }
  /** Extraction routing rules (docs/EXTRACTION-LAB.md). */
  extraction?: TenantConfig['extraction']
  /** Intent-routed configurations (docs/INTENT-ROUTING.md), when a portal tunes its own. */
  intents?: TenantConfig['intents']
}

/** Never interpret malformed persisted policy as a missing legacy field. */
export function tenantRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted portal configuration')
  }
  return value as Record<string, unknown>
}

export function validateTenantPatch(value: unknown): TenantPatch {
  const patch = tenantRecord(value)
  if (patch.accessMode !== undefined) AccessModeSchema.parse(patch.accessMode)
  return patch as TenantPatch
}

/** Slugs recorded as retired, from a persisted `retired` list. Anything else reads as none. */
export function retiredSlugs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((slug): slug is string => typeof slug === 'string')
    : []
}

export class TenantStore {
  private custom: Record<string, unknown> = {}
  /** Analysis-derived overrides, applicable to seeded portals too. */
  private overrides: Record<string, unknown> = {}
  private disabled = new Set<string>()
  /**
   * Slugs of removed portals. Grants, keys and research records are keyed by slug, so a new
   * portal never takes one of these and cannot inherit what the removed portal left behind.
   */
  private retired = new Set<string>()
  private readonly path: string
  private readonly platformDomain: string

  private committed!: {
    custom: Record<string, unknown>
    overrides: Record<string, unknown>
    disabled: string[]
    retired: string[]
  }

  constructor(
    env: Record<string, string | undefined> = process.env,
    private readonly boundary?: OwnedMutationBoundary,
  ) {
    this.path = env.TENANTS_PATH ?? './data/tenants.json'
    this.platformDomain = getPlatformDomain(env.PLATFORM_DOMAIN)
    let raw: Record<string, unknown>
    try {
      raw = tenantRecord(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      raw = {}
    }
    // v2 format: { custom, overrides, disabled }. v1 was a bare custom map.
    this.custom = tenantRecord(Object.hasOwn(raw, 'custom') ? raw.custom : raw)
    if (Object.hasOwn(raw, 'overrides')) this.overrides = tenantRecord(raw.overrides)
    if (Array.isArray(raw.disabled)) {
      this.disabled = new Set(raw.disabled.filter((s): s is string => typeof s === 'string'))
    }
    this.retired = new Set(retiredSlugs(raw.retired))
    this.committed = structuredClone(this.snapshot())
  }

  get(slug: string): TenantConfig | undefined {
    // Validate even a shadowed custom record: corruption cannot reveal a seed.
    const custom = Object.hasOwn(this.custom, slug)
      ? TenantConfigSchema.parse(this.custom[slug])
      : undefined
    if (custom && custom.slug !== slug) throw new Error('Invalid persisted portal slug')
    const base = tenantsBySlug[slug] ?? custom
    if (!base) return undefined
    if (!Object.hasOwn(this.overrides, slug)) return withPlatformHostname(base, this.platformDomain)
    const override = validateTenantPatch(this.overrides[slug])
    const { prompts: _prompts, ...configPatch } = override
    return withPlatformHostname(
      TenantConfigSchema.parse({ ...base, ...configPatch }),
      this.platformDomain,
    )
  }

  /** App-side settings that never reach the public config payload. */
  promptsFor(slug: string): { ask?: string; images?: boolean } {
    this.get(slug)
    return Object.hasOwn(this.overrides, slug)
      ? validateTenantPatch(this.overrides[slug]).prompts ?? {}
      : {}
  }

  isCustom(slug: string): boolean {
    return slug in this.custom && !(slug in tenantsBySlug)
  }

  isDisabled(slug: string): boolean {
    return this.disabled.has(slug)
  }

  /** A removed portal's slug, which no new portal may take. */
  isRetired(slug: string): boolean {
    return this.retired.has(slug)
  }

  setDisabled(slug: string, disabled: boolean): void {
    if (disabled) this.disabled.add(slug)
    else this.disabled.delete(slug)
    this.persist()
  }

  /** Rename or re-theme a portal (product name, organisation, tagline, palette, type, shape). */
  patchBranding(
    slug: string,
    branding: {
      productName?: string
      organisation?: string
      tagline?: string
      colours?: TenantConfig['branding']['colours']
      typography?: TenantConfig['branding']['typography']
      shape?: TenantConfig['branding']['shape']
      textScale?: TenantConfig['branding']['textScale']
      density?: TenantConfig['branding']['density']
      paletteId?: TenantConfig['branding']['paletteId']
    },
  ): void {
    const base = this.get(slug)
    if (!base) return
    const merged = {
      ...base.branding,
      ...(branding.productName ? { productName: branding.productName } : {}),
      ...(branding.organisation ? { organisation: branding.organisation } : {}),
      ...(branding.tagline ? { tagline: branding.tagline } : {}),
      ...(branding.colours ? { colours: branding.colours } : {}),
      ...(branding.typography ? { typography: branding.typography } : {}),
      ...(branding.shape ? { shape: branding.shape } : {}),
      ...(branding.textScale ? { textScale: branding.textScale } : {}),
      ...(branding.density ? { density: branding.density } : {}),
      ...(branding.paletteId ? { paletteId: branding.paletteId } : {}),
    }
    if (this.custom[slug]) {
      this.custom[slug] = { ...TenantConfigSchema.parse(this.custom[slug]), branding: merged }
    } else {
      this.overrides[slug] = { ...this.existingPatch(slug), branding: merged }
    }
    this.persist()
  }

  /** Apply analysis-derived config (topics, questions, placeholder). */
  patch(slug: string, patch: TenantPatch): void {
    validateTenantPatch(patch)
    const base = this.get(slug)
    if (!base) throw new Error('Unknown portal')
    TenantConfigSchema.parse({ ...base, ...patch })
    this.overrides[slug] = { ...this.existingPatch(slug), ...patch }
    this.persist()
  }

  private existingPatch(slug: string): TenantPatch {
    return Object.hasOwn(this.overrides, slug) ? validateTenantPatch(this.overrides[slug]) : {}
  }

  list(includeDisabled = false, visible?: (config: TenantConfig) => boolean): TenantSummary[] {
    const all: TenantSummary[] = []
    for (const slug of new Set([...Object.keys(tenantsBySlug), ...Object.keys(this.custom)])) {
      if (!includeDisabled && this.disabled.has(slug)) continue
      let config: TenantConfig | undefined
      try {
        config = this.get(slug)
      } catch {
        // A corrupt portal is unavailable, including in aggregate listings.
        continue
      }
      if (config && (!visible || visible(config))) all.push(tenantSummary(config))
    }
    return all
  }

  /**
   * Create a portal under the first free slug made from its name. A slug is taken while a portal
   * holds it, once it has been retired, or when `unavailable` says so.
   */
  add(input: NewTenantInput, unavailable?: (slug: string) => boolean): TenantConfig {
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!base) throw new Error('The portal name must contain letters or numbers')
    let slug = base
    for (let i = 2; this.get(slug) || this.retired.has(slug) || unavailable?.(slug); i++) {
      slug = `${base}-${i}`
    }
    const config = TenantConfigSchema.parse({
      slug,
      branding: {
        productName: input.name,
        organisation: input.organisation?.trim() || input.name,
        tagline: input.tagline?.trim() || 'Research, discovery and development',
        colours: DEFAULT_COLOURS,
      },
      searchPlaceholder: 'Search this portal…',
      topics: [],
      suggestedQuestions: [],
      entityTypes: [],
      relationTypes: [],
    })
    // Persist and return exactly what was created: a hostname comes only from domain attachment.
    this.custom[slug] = config
    this.persist()
    return config
  }

  /** Remove a portal created in the app and retire its slug in the same write. */
  remove(slug: string): boolean {
    if (!this.isCustom(slug)) return false
    delete this.custom[slug]
    delete this.overrides[slug]
    this.disabled.delete(slug)
    this.retired.add(slug)
    this.persist()
    return true
  }

  private persist(): void {
    try {
      ownedWrite(this.path, this.snapshot(), this.boundary)
      this.committed = structuredClone(this.snapshot())
    } catch (error) {
      const before = structuredClone(this.committed)
      this.custom = before.custom
      this.overrides = before.overrides
      this.disabled = new Set(before.disabled)
      this.retired = new Set(before.retired)
      throw error
    }
  }

  private snapshot() {
    return {
      custom: this.custom,
      overrides: this.overrides,
      disabled: [...this.disabled],
      retired: [...this.retired],
    }
  }
}

/** Public tenant-store contract for runtimes without a local filesystem. */
export type TenantStoreApi = Pick<TenantStore, keyof TenantStore>
