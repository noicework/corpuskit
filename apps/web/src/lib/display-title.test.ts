import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { plainDashes, presentTitle } from './display-title.ts'

describe('presentTitle', () => {
  it('re-cases a shouted title, keeping small words and initialisms in their place', () => {
    expect(presentTitle('A WORLDWIDE ENIGMA STUDY ON EPILEPSY AND THE BRAIN')).toBe(
      'A Worldwide ENIGMA Study on Epilepsy and the Brain',
    )
    expect(presentTitle('SCN1A VARIANTS IN DRUG-RESISTANT EPILEPSY: AN EEG STUDY')).toBe(
      'SCN1A Variants in Drug-Resistant Epilepsy: An EEG Study',
    )
  })

  it('re-cases a leading section label in front of a normal title', () => {
    expect(presentTitle('GENETICS. The Human Variome Project')).toBe(
      'Genetics. The Human Variome Project',
    )
  })

  it('leaves mixed-case titles alone, initialisms included', () => {
    const title = 'Augmented currents of an HCN2 variant in patients with febrile seizures'
    expect(presentTitle(title)).toBe(title)
    expect(presentTitle('SUDEP risk and the ILAE classification')).toBe(
      'SUDEP risk and the ILAE classification',
    )
  })

  it('does not treat a short initialism title as shouting', () => {
    expect(presentTitle('EEG')).toBe('EEG')
    expect(presentTitle('MRI in SUDEP')).toBe('MRI in SUDEP')
  })
})

describe('plainDashes', () => {
  it('replaces em dashes with a spaced hyphen', () => {
    expect(plainDashes('brain metabolites—glutamate, glutathione, and GABA—using 7-Tesla')).toBe(
      'brain metabolites - glutamate, glutathione, and GABA - using 7-Tesla',
    )
  })

  it('replaces an en dash used as punctuation but keeps numeric ranges', () => {
    expect(plainDashes('seizures – a review')).toBe('seizures - a review')
    expect(plainDashes('2018;59:186–94')).toBe('2018;59:186–94')
  })
})
