import process from 'node:process'
import { type TenantConfig, TenantConfigSchema, type TenantSummary } from '@research-portal/core'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

// ---------------------------------------------------------------------------
// Seed tenant configs - the single source of truth for tenant-driven theming
// and copy, validated at module load so a bad seed fails fast on boot.
// Persistence is deliberately plain JSON files on the volume (project rule:
// no SQLite or embedded databases unless absolutely unavoidable).
// ---------------------------------------------------------------------------

const PLATFORM_HOSTNAMES: Readonly<Record<string, string>> = {
  marine: 'marine.corpuskit.org',
  grains: 'grains.corpuskit.org',
  opax: 'opax.corpuskit.org',
}

/**
 * Compatibility for portals whose custom domains pre-date persisted hostname
 * metadata. OPAX was created at runtime, so its stored config needs the same
 * read-time upgrade as the two seeded portals.
 */
export function withPlatformHostname(config: TenantConfig): TenantConfig {
  const hostname = config.hostname ?? PLATFORM_HOSTNAMES[config.slug]
  return hostname ? { ...config, hostname } : config
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
  hostname: PLATFORM_HOSTNAMES.grains,
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
  hostname: PLATFORM_HOSTNAMES.marine,
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

export function tenantConfig(slug: string): TenantConfig | undefined {
  const config = tenantsBySlug[slug]
  return config ? withPlatformHostname(config) : undefined
}

export function tenantSummaries(): TenantSummary[] {
  return Object.values(tenantsBySlug).map((tenant) => tenantSummary(withPlatformHostname(tenant)))
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
  hostname?: TenantConfig['hostname']
  topics?: TenantConfig['topics']
  suggestedQuestions?: TenantConfig['suggestedQuestions']
  searchPlaceholder?: string
  branding?: TenantConfig['branding']
  /** Portal-managed behaviour settings (system prompt, image grounding). */
  prompts?: { ask?: string; images?: boolean }
}

export class TenantStore {
  private custom: Record<string, TenantConfig> = {}
  /** Analysis-derived overrides, applicable to seeded portals too. */
  private overrides: Record<string, TenantPatch> = {}
  private disabled = new Set<string>()
  private readonly path: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.path = env.TENANTS_PATH ?? './data/tenants.json'
    const raw = readJsonSafe<Record<string, unknown>>(this.path, {})
    // v2 format: { custom, overrides, disabled }. v1 was a bare custom map.
    const customSource = (raw.custom ?? raw) as Record<string, unknown>
    for (const [slug, value] of Object.entries(customSource)) {
      const parsed = TenantConfigSchema.safeParse(value)
      if (parsed.success) this.custom[slug] = parsed.data
    }
    if (raw.overrides && typeof raw.overrides === 'object') {
      this.overrides = raw.overrides as Record<string, TenantPatch>
    }
    if (Array.isArray(raw.disabled)) {
      this.disabled = new Set(raw.disabled.filter((s): s is string => typeof s === 'string'))
    }
  }

  get(slug: string): TenantConfig | undefined {
    const base = tenantsBySlug[slug] ?? this.custom[slug]
    if (!base) return undefined
    const override = this.overrides[slug]
    if (!override) return withPlatformHostname(base)
    const { prompts: _prompts, ...configPatch } = override
    return withPlatformHostname({ ...base, ...configPatch })
  }

  /** App-side settings that never reach the public config payload. */
  promptsFor(slug: string): { ask?: string; images?: boolean } {
    return this.overrides[slug]?.prompts ?? {}
  }

  isCustom(slug: string): boolean {
    return slug in this.custom && !(slug in tenantsBySlug)
  }

  isDisabled(slug: string): boolean {
    return this.disabled.has(slug)
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
      this.custom[slug] = { ...this.custom[slug], branding: merged }
    } else {
      this.overrides[slug] = { ...this.overrides[slug], branding: merged }
    }
    this.persist()
  }

  /** Apply analysis-derived config (topics, questions, placeholder). */
  patch(slug: string, patch: TenantPatch): void {
    this.overrides[slug] = { ...this.overrides[slug], ...patch }
    this.persist()
  }

  list(includeDisabled = false): TenantSummary[] {
    const all = [
      ...tenantSummaries(),
      ...Object.values(this.custom).map((tenant) =>
        tenantSummary(this.get(tenant.slug) ?? withPlatformHostname(tenant))
      ),
    ]
    return includeDisabled ? all : all.filter((t) => !this.disabled.has(t.slug))
  }

  add(input: NewTenantInput): TenantConfig {
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!base) throw new Error('The portal name must contain letters or numbers')
    let slug = base
    for (let i = 2; this.get(slug); i++) slug = `${base}-${i}`
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
    const configured = withPlatformHostname(config)
    this.custom[slug] = configured
    this.persist()
    return configured
  }

  remove(slug: string): boolean {
    if (!this.isCustom(slug)) return false
    delete this.custom[slug]
    delete this.overrides[slug]
    this.disabled.delete(slug)
    this.persist()
    return true
  }

  private persist(): void {
    writeJsonAtomic(this.path, {
      custom: this.custom,
      overrides: this.overrides,
      disabled: [...this.disabled],
    })
  }
}

/** Public tenant-store contract for runtimes without a local filesystem. */
export type TenantStoreApi = Pick<TenantStore, keyof TenantStore>
