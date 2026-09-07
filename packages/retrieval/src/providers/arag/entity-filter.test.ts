import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  dedupeNames,
  isGeneSymbolEntity,
  isNoiseEntity,
  keepEntity,
  preferredSpelling,
} from './entity-filter.ts'

describe('isNoiseEntity', () => {
  it('drops numbers, single letters, people, journals, vignettes and addresses', () => {
    for (
      const noise of [
        '100',
        '191',
        '60156',
        '0.5%',
        'U',
        'b',
        'Sowcik M',
        'Cho H',
        'Vajda F',
        "Terence J. O'Brien",
        'Igarashi et al.',
        'Faden et al., 1989',
        'Mehndiratta 2002',
        'Frontiers in Neurology',
        'Frontiers in Genetics',
        'Journal of Neuroscience',
        '26-year-old woman',
        '3 month old boy',
        'vajda@netspace.net.au',
        'Table 18',
        'Pathway 7',
        'Glut!D patients',
        'Dravet Syndrome \n UK',
        '10 Hz',
        '100 children',
        '13 probands',
        '155 AHC patients',
        '0.2 mg/kg/d',
        '16% PFA stock',
        '1X TBS',
        '7T',
        '3/Male/18c',
        '0 and 1',
        '3q21.3',
        '10.1038/nature12439',
        '16 Shafi MM',
        '6 NATURE COMMUNICATIONS',
        'A193V',
        'Arg55',
        '[25]',
        'A0122026',
        'Afrikanova, T.',
      ]
    ) {
      expect(isNoiseEntity(noise)).toBe(true)
    }
  })
  it('keeps real entities, including genes, drugs, models and syndromes', () => {
    for (
      const ok of [
        'SCN1A',
        'Dravet syndrome',
        'fenfluramine',
        'kainic acid',
        'Wistar',
        'status epilepticus',
        'Antisense oligonucleotides',
        'FHM3',
        'Kryptofix 222',
        'GABAA receptor',
        '24 hour ambulatory EEG',
        '5-HT2A receptor',
        '[18F]flumazenil',
        '2-AG',
        '2023 Genetic Generalized Epilepsy (GGE) PRS model',
      ]
    ) {
      expect(isNoiseEntity(ok)).toBe(false)
    }
  })
})

describe('isGeneSymbolEntity', () => {
  it('accepts HGNC-shaped symbols, with a variant or gene tail, and rodent symbols', () => {
    for (
      const ok of [
        'SCN1A',
        'KCNT1 mutation',
        'SLC12A5 gene',
        'IQSEC2',
        'TUBA1A',
        'GABBR2',
        'WDR45',
        'PTEN',
        'Scn1a',
        'TBC1D24',
      ]
    ) {
      expect(isGeneSymbolEntity(ok)).toBe(true)
    }
  })
  it('rejects phrases, numbers, authors and variant descriptions that are not a symbol', () => {
    for (
      const no of [
        '14',
        'Tononi G',
        'SETBP1 missense variants',
        'potassium channel gene cluster',
        'DNA binding-independent functions',
        'short insertions/deletions',
        'homozygous variant',
        'top SNP',
        'rtTA',
        'chr9:g.(140382705_141044489)x1',
        'amyloid-b',
        'genetic findings',
        'p.Lys114 deletion',
      ]
    ) {
      expect(isGeneSymbolEntity(no)).toBe(false)
    }
  })
})

describe('keepEntity', () => {
  it('applies the gene check only to the Gene group', () => {
    expect(keepEntity('genetic findings', 'Gene')).toBe(false)
    expect(keepEntity('genetic findings', 'Research Study')).toBe(true)
    expect(keepEntity('100', 'Medical Condition')).toBe(false)
  })
})

describe('dedupeNames and preferredSpelling', () => {
  it('case-folds, collapses whitespace and keeps the first spelling', () => {
    expect(dedupeNames(['Dravet', 'dravet', 'DRAVET', 'Dravet  syndrome', 'dravet syndrome']))
      .toEqual(['Dravet', 'Dravet syndrome'])
  })
  it('prefers a mixed-case spelling and then the shorter one', () => {
    expect(preferredSpelling(['DRAVET SYNDROME', 'dravet syndrome', 'Dravet syndrome'])).toBe(
      'Dravet syndrome',
    )
    expect(preferredSpelling(['scn1a', 'SCN1A'])).toBe('SCN1A')
    expect(preferredSpelling(['kainic Acid', 'kainic acid'])).toBe('kainic acid')
    expect(preferredSpelling(['KAINIC ACID', 'kainic acid', 'Kainic acid'])).toBe('Kainic acid')
  })
})
