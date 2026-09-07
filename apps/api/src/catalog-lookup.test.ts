import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ResourceSummary } from '@research-portal/core'
import {
  authorLine,
  isCatalogueAuthor,
  parsePersonQuery,
  researcherLabel,
  resolveAuthor,
  resolveIdentifier,
  resolvePersonName,
  retypeResearchers,
} from './catalog-lookup.ts'

const base = { summary: 'x', type: 'pdf' as const, topicIds: [], keyFacts: [] }
const resources: ResourceSummary[] = [
  {
    ...base,
    id: 'a',
    title: 'ENVISION natural history',
    doi: '10.1111/epi.70015',
    pmid: '39876543',
    originUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8517288/',
    authors: ['Vajda FJE', 'O’Brien TJ', 'Lander CM'],
    journal: 'Epilepsia',
    year: '2025',
  },
  {
    ...base,
    id: 'b',
    title: 'Another paper',
    doi: '10.1016/j.ebiom.2021.103619',
    pmcid: 'pmc8371239',
    authors: ['Seery N', 'Butzkueven H'],
  },
]

describe('resolveIdentifier', () => {
  it('matches a DOI regardless of prefix, case or trailing punctuation', () => {
    expect(resolveIdentifier(resources, { kind: 'doi', value: '10.1111/EPI.70015' })[0]?.id).toBe(
      'a',
    )
    expect(
      resolveIdentifier(resources, {
        kind: 'doi',
        value: 'https://doi.org/10.1016/j.ebiom.2021.103619.',
      })[0]
        ?.id,
    ).toBe('b')
    expect(resolveIdentifier(resources, { kind: 'doi', value: '10.1111/epi.17708' })).toEqual([])
  })
  it('matches a PMC id from the pmcid field or the origin URL, and a PMID', () => {
    expect(resolveIdentifier(resources, { kind: 'pmcid', value: 'PMC8371239' })[0]?.id).toBe('b')
    expect(resolveIdentifier(resources, { kind: 'pmcid', value: 'PMC8517288' })[0]?.id).toBe('a')
    expect(resolveIdentifier(resources, { kind: 'pmid', value: '39876543' })[0]?.id).toBe('a')
    expect(resolveIdentifier(resources, { kind: 'pmcid', value: 'PMC1' })).toEqual([])
  })
  it('puts the article before the supplements that share its PMC id', () => {
    const withSupplement = [
      { ...resources[1]!, id: 'supp', title: 'Supplementary material 1: extra tables' },
      resources[1]!,
    ]
    expect(
      resolveIdentifier(withSupplement, { kind: 'pmcid', value: 'PMC8371239' }).map((r) => r.id),
    )
      .toEqual(['b', 'supp'])
  })
})

describe('resolveAuthor', () => {
  it('finds resources by surname from "Surname INITIALS" author strings', () => {
    expect(resolveAuthor(resources, 'Vajda')?.matches.map((r) => r.id)).toEqual(['a'])
    expect(resolveAuthor(resources, 'seery')?.matches.map((r) => r.id)).toEqual(['b'])
    expect(resolveAuthor(resources, "O'Brien")?.matches.map((r) => r.id)).toEqual(['a'])
  })
  it('accepts a citation-shaped "Surname YYYY topic" and narrows by year', () => {
    expect(resolveAuthor(resources, 'Vajda 2025 valproate')?.matches.map((r) => r.id)).toEqual([
      'a',
    ])
    expect(resolveAuthor(resources, 'Vajda 2004 valproate')).toBeNull()
  })
  it('is null for questions, short tokens and unknown names', () => {
    expect(resolveAuthor(resources, 'Vajda valproate')).toBeNull()
    expect(resolveAuthor(resources, 'Cho')).toBeNull()
    expect(resolveAuthor(resources, 'Okafor')).toBeNull()
  })
  it('writes an author line with the journal and year', () => {
    expect(authorLine(resources[0]!)).toBe('Vajda FJE, O’Brien TJ, Lander CM - Epilepsia, 2025')
  })
  it('matches a surname typed without its apostrophe (D3-04)', () => {
    expect(resolveAuthor(resources, 'OBrien')?.matches.map((r) => r.id)).toEqual(['a'])
    expect(resolveAuthor(resources, 'O’Brien')?.matches.map((r) => r.id)).toEqual(['a'])
  })
})

describe("a person's name as a query (D3-04)", () => {
  const papers: ResourceSummary[] = [
    { ...base, id: 'sudep', title: 'Risk of SUDEP', authors: ["O'Neill WJ", 'Kwan P'] },
    { ...base, id: 'other', title: 'Another', authors: ['Smith JA', 'Kwan P'] },
  ]
  it('reads "first last", "initial last", "last initials" and apostrophe-less forms', () => {
    expect(parsePersonQuery("Wilma O'Neill")).toMatchObject({ surname: "O'Neill", initial: 'w' })
    expect(parsePersonQuery("W O'Neill")).toMatchObject({ surname: "O'Neill", initial: 'w' })
    expect(parsePersonQuery("W. J. O'Neill")).toMatchObject({ surname: "O'Neill", initial: 'w' })
    expect(parsePersonQuery("O'Neill WJ")).toMatchObject({ surname: "O'Neill", initial: 'w' })
    expect(parsePersonQuery('Wilma J ONeill')).toMatchObject({ surname: 'ONeill', initial: 'w' })
    expect(parsePersonQuery('seizure cycles')).toBeNull()
    expect(parsePersonQuery('SUDEP lamotrigine')).toBeNull()
    expect(parsePersonQuery("O'Neill")).toBeNull()
  })
  it('lists the author under every form of the name', () => {
    for (const q of ["Wilma O'Neill", "W O'Neill", 'Wilma ONeill', "O'Neill WJ", 'ONeill W']) {
      expect(resolvePersonName(papers, q)?.matches.map((r) => r.id)).toEqual(['sudep'])
    }
    expect(resolvePersonName(papers, 'Patrick Kwan')?.matches.map((r) => r.id).sort()).toEqual([
      'other',
      'sudep',
    ])
  })
  it('is an empty lookup for a known surname with the wrong initial, null for an unknown name', () => {
    expect(resolvePersonName(papers, "John O'Neill")?.matches).toEqual([])
    expect(resolvePersonName(papers, 'Sodium Selenate')).toBeNull()
    expect(resolvePersonName(papers, 'Dravet Syndrome')).toBeNull()
  })
})

describe('researchers on the graph (D1-25)', () => {
  const papers: ResourceSummary[] = [
    {
      ...base,
      id: 'sudep',
      title: 'Risk of SUDEP with lamotrigine',
      authors: ["O'Neill WJ", 'Kwan P', 'Vajda FJE'],
    },
  ]

  it('recognises an author under the spellings the graph agent produces', () => {
    expect(isCatalogueAuthor(papers, "Wilma O'Neill")).toBe(true)
    expect(isCatalogueAuthor(papers, "Wilma J O'Neill")).toBe(true)
    expect(isCatalogueAuthor(papers, "O'Neill")).toBe(true)
    expect(isCatalogueAuthor(papers, 'Patrick Kwan')).toBe(true)
    expect(isCatalogueAuthor(papers, 'Frank Vajda')).toBe(true)
  })

  it('does not retype a different person, a study or a drug', () => {
    expect(isCatalogueAuthor(papers, "Anthony O'Neill")).toBe(false)
    expect(isCatalogueAuthor(papers, 'The BREATHS trial')).toBe(false)
    expect(isCatalogueAuthor(papers, 'lamotrigine')).toBe(false)
    expect(isCatalogueAuthor(papers, 'Kwan')).toBe(true)
  })

  it("retypes only the authors, to the tenant's researcher type", () => {
    const label = researcherLabel([{ id: 'gene', label: 'Gene' }, {
      id: 'researcher',
      label: 'Researcher',
    }])
    expect(label).toBe('Researcher')
    expect(researcherLabel([])).toBe('Researcher')
    const nodes = retypeResearchers(
      [
        { id: "Wilma O'Neill", group: 'Research Study', weight: 3 },
        { id: 'lamotrigine', group: 'Medication', weight: 2 },
      ],
      papers,
      label,
    )
    expect(nodes.map((n) => n.group)).toEqual(['Researcher', 'Medication'])
  })
})
