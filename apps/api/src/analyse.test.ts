/**
 * Corpus analysis never replaces a label set this portal did not create:
 * writing `topic` or `kind` replaces the whole set on the platform, so a
 * curated set on a connected box would be lost to one click. A re-run on a
 * box whose sets came from this portal's own analysis keeps working.
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { AnalyseEvent, Labelset, TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { analyseTenant, foreignLabelsets, labelsetExistsMessage } from './analyse.ts'
import type { TenantPatch, TenantStoreApi } from './tenants.ts'

const RESOURCES = [
  { id: 'r1', title: 'Abalone stock assessment', summary: 'Dive surveys of blacklip abalone.' },
  { id: 'r2', title: 'Reef habitat mapping', summary: 'Seafloor habitat in the southern zone.' },
]

const DESIGN = {
  topics: [
    { id: 'stock-assessment', label: 'Stock assessment', description: 'Stock status work.' },
    { id: 'habitat', label: 'Habitat', description: 'Habitat and environment.' },
  ],
  kinds: [
    { id: 'report', label: 'Report', description: 'A technical report.' },
    { id: 'review', label: 'Review', description: 'A literature review.' },
  ],
  assignments: [
    { number: 1, topicId: 'stock-assessment', kindId: 'report' },
    { number: 2, topicId: 'habitat', kindId: 'review' },
  ],
  suggestedQuestions: ['How are abalone stocks assessed?'],
  searchPlaceholder: 'Search abalone, habitat, surveys…',
}

function portal(topics: string[] = []): TenantConfig {
  return {
    slug: 'southern-waters',
    searchPlaceholder: 'Search',
    topics: topics.map((id) => ({ id, label: id })),
  } as unknown as TenantConfig
}

function labelset(id: string, labels: string[]): Labelset {
  return { id, title: id, multiple: false, labels }
}

/** A knowledge box and tenant store that remember what analysis did to them, in order. */
function box(opts: { labelsets?: Labelset[]; readFails?: boolean; writeFails?: string[] } = {}) {
  const sets = new Map((opts.labelsets ?? []).map((ls) => [ls.id, ls]))
  const calls: string[] = []
  const patches: TenantPatch[] = []
  const management = {
    listResources: () => Promise.resolve(RESOURCES),
    labelsets: () => {
      calls.push('labelsets')
      return opts.readFails
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve([...sets.values()])
    },
    askStructured: () => {
      calls.push('askStructured')
      return Promise.resolve({ object: structuredClone(DESIGN) })
    },
    createLabelset: (_config: TenantConfig, input: { id: string; labels: { title: string }[] }) => {
      calls.push(`createLabelset:${input.id}`)
      if (opts.writeFails?.includes(input.id)) return Promise.reject(new Error('write failed'))
      sets.set(input.id, labelset(input.id, input.labels.map((l) => l.title)))
      return Promise.resolve()
    },
    patchResourceClassifications: (_config: TenantConfig, id: string) => {
      calls.push(`label:${id}`)
      return Promise.resolve()
    },
  } as unknown as AragProvider
  const tenants = {
    patch: (_slug: string, patch: TenantPatch) => {
      calls.push(`patch:${Object.keys(patch).sort().join(',')}`)
      patches.push(patch)
    },
  } as unknown as TenantStoreApi
  return { management, tenants, sets, calls, patches }
}

async function run(b: ReturnType<typeof box>, config: TenantConfig) {
  const events: AnalyseEvent[] = []
  for await (const event of analyseTenant(b.management, b.tenants, config, () => {})) {
    events.push(event)
  }
  return events
}

/** No paid design call and no write of any kind happened. */
function expectNothingWritten(b: ReturnType<typeof box>) {
  expect(b.calls.filter((c) => c !== 'labelsets')).toEqual([])
  expect(b.patches).toEqual([])
}

describe('analysis refuses to replace a label set this portal did not create', () => {
  it("refuses a box's own curated 'topic' set before the design is paid for", async () => {
    const b = box({ labelsets: [labelset('topic', ['Marine ecology', 'Fisheries policy'])] })
    const events = await run(b, portal())
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'labelset_exists',
      message: "This knowledge box already has a 'topic' label set that this portal did not " +
        'create. Running analysis would replace it. Rename or remove it in the knowledge box ' +
        'first.',
    })
    expect(events.some((e) => e.type === 'done')).toBe(false)
    expectNothingWritten(b)
  })

  it("refuses a 'topic' set holding any label the portal did not write", async () => {
    // The portal's earlier analysis wrote two labels; someone added a third.
    const b = box({
      labelsets: [labelset('topic', ['stock-assessment', 'habitat', 'Curated extra'])],
    })
    const events = await run(b, portal(['stock-assessment', 'habitat']))
    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'labelset_exists' })
    expectNothingWritten(b)
  })

  it("refuses a curated 'kind' set when the portal has no taxonomy of its own on the box", async () => {
    for (
      const sets of [
        [labelset('kind', ['Report', 'Brief'])],
        [labelset('topic', []), labelset('kind', ['Report', 'Brief'])],
      ]
    ) {
      const b = box({ labelsets: sets })
      const events = await run(b, portal(['stock-assessment']))
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: 'labelset_exists',
        message: expect.stringContaining("a 'kind' label set that this portal did not create"),
      })
      expectNothingWritten(b)
    }
  })

  it('names both sets when both are curated', async () => {
    const b = box({
      labelsets: [labelset('topic', ['Marine ecology']), labelset('kind', ['Report'])],
    })
    const events = await run(b, portal())
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'labelset_exists',
      message: "This knowledge box already has 'topic' and 'kind' label sets that this portal " +
        'did not create. Running analysis would replace them. Rename or remove them in the ' +
        'knowledge box first.',
    })
    expectNothingWritten(b)
  })

  it('makes no changes when the existing label sets cannot be read', async () => {
    const b = box({ readFails: true })
    const events = await run(b, portal())
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(events.at(-1)).not.toHaveProperty('error')
    expectNothingWritten(b)
  })

  it('leaves other label sets alone and is not blocked by them', async () => {
    const b = box({ labelsets: [labelset('content-type', ['documentation'])] })
    const events = await run(b, portal())
    expect(events.at(-1)?.type).toBe('done')
    expect(b.sets.get('content-type')?.labels).toEqual(['documentation'])
  })
})

describe('analysis re-runs on its own label sets', () => {
  it('runs on a fresh box, then runs again over the sets it wrote', async () => {
    const b = box()
    const first = await run(b, portal())
    expect(first.at(-1)).toEqual({ type: 'done', topics: 2, kinds: 2, labelled: 2, questions: 1 })
    expect(b.sets.get('topic')?.labels).toEqual(['stock-assessment', 'habitat'])
    expect(b.sets.get('kind')?.labels).toEqual(['report', 'review'])

    // The configuration the first run recorded is what the second run reads.
    const recorded = b.patches.find((p) => p.topics)?.topics?.map((t) => t.id) ?? []
    expect(recorded).toEqual(['stock-assessment', 'habitat'])
    b.calls.length = 0
    const second = await run(b, portal(recorded))
    expect(second.at(-1)?.type).toBe('done')
    expect(b.calls).toContain('askStructured')
    expect(b.calls).toContain('createLabelset:topic')
    expect(b.calls).toContain('createLabelset:kind')
  })

  it('runs over sets provisioned or written by an earlier design with fewer labels', async () => {
    for (
      const sets of [
        // Provisioning wrote the topic ids; a seeding script wrote the kinds.
        [labelset('topic', ['stock-assessment', 'habitat']), labelset('kind', ['Report'])],
        // A run cut short after writing its sets: every label is still the portal's.
        [labelset('topic', ['habitat'])],
        // Empty sets have nothing to lose.
        [labelset('topic', []), labelset('kind', [])],
      ]
    ) {
      const b = box({ labelsets: sets })
      const events = await run(b, portal(['stock-assessment', 'habitat']))
      expect(events.at(-1)?.type).toBe('done')
    }
  })

  it('records its topic ids before labelling, so a run cut short still owns its set', async () => {
    const b = box()
    await run(b, portal())
    const recorded = b.calls.indexOf('patch:topics')
    expect(recorded).toBeGreaterThan(b.calls.indexOf('createLabelset:kind'))
    expect(recorded).toBeLessThan(b.calls.indexOf('label:r1'))
    expect(b.calls.at(-1)).toBe('patch:searchPlaceholder,suggestedQuestions')
  })

  it('stops before labelling when the topic set cannot be written', async () => {
    const b = box({ writeFails: ['topic'] })
    const events = await run(b, portal())
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(b.calls.some((c) => c.startsWith('label:') || c.startsWith('patch:'))).toBe(false)
    expect(b.calls).not.toContain('createLabelset:kind')
  })

  it('labels by topic only when the kind set cannot be written', async () => {
    const b = box({ writeFails: ['kind'] })
    const events = await run(b, portal())
    expect(events.at(-1)).toEqual({ type: 'done', topics: 2, kinds: 0, labelled: 2, questions: 1 })
  })
})

describe('foreignLabelsets', () => {
  it('reads ownership from the portal topic ids alone', () => {
    const config = portal(['a', 'b'])
    expect(foreignLabelsets(config, [])).toEqual([])
    expect(foreignLabelsets(config, [labelset('topic', ['a']), labelset('kind', ['x'])]))
      .toEqual([])
    expect(foreignLabelsets(config, [labelset('topic', ['a', 'c']), labelset('kind', ['x'])]))
      .toEqual(['topic', 'kind'])
    expect(foreignLabelsets(portal(), [labelset('topic', ['a'])])).toEqual(['topic'])
  })

  it('words the refusal for one set or two', () => {
    expect(labelsetExistsMessage(['kind'])).toContain("a 'kind' label set")
    expect(labelsetExistsMessage(['topic', 'kind'])).toContain("'topic' and 'kind' label sets")
  })
})
