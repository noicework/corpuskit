import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  closesSentence,
  StreamVerifier,
  verifyFirstSentence,
  type WarmText,
} from './ask-stream-verify.ts'

const experience: WarmText = {
  resourceId: 'exp',
  title: 'Effectiveness and Tolerability of 12-Month Brivaracetam in the Real World: EXPERIENCE',
  text:
    'Results. In the full analysis set (n = 1644), retention on brivaracetam at 12 months was 71.1%. ' +
    'Seizure freedom at 12 months was 14.9% (n = 1111).',
}
const permit: WarmText = {
  resourceId: 'per',
  title: 'PERMIT pooled analysis of perampanel',
  text: 'Retention on perampanel at 12 months was 64.2% (2698/4201) in the retention population.',
}

describe('verifyFirstSentence', () => {
  it('finds the sentence whose every figure sits beside its claim in one warm text', () => {
    const found = verifyFirstSentence(
      'In the EXPERIENCE study, the 12-month retention rate for brivaracetam was 71.1% (n = 1644, full analysis set).',
      {
        texts: () => [permit, experience],
        lexicon: ['brivaracetam', 'perampanel'],
        questionEntities: ['brivaracetam'],
      },
    )
    expect(found?.resourceId).toBe('exp')
    expect(found?.title).toContain('EXPERIENCE')
  })
  it('never vouches for a figure the warm texts do not carry, or a sentence with no figure', () => {
    expect(
      verifyFirstSentence('Retention on brivaracetam at 12 months was 80.1% (n = 1644).', {
        texts: () => [experience],
        lexicon: ['brivaracetam'],
        questionEntities: ['brivaracetam'],
      }),
    ).toBeNull()
    expect(
      verifyFirstSentence('Brivaracetam was well tolerated in the real world.', {
        texts: () => [experience],
        lexicon: ['brivaracetam'],
        questionEntities: [],
      }),
    ).toBeNull()
  })
  it('requires the text to carry the cohort the question names', () => {
    const opts = {
      texts: () => [experience, permit],
      lexicon: ['brivaracetam', 'perampanel'],
      questionEntities: ['perampanel'],
      requiredNames: ['permit'],
    }
    expect(
      verifyFirstSentence('Retention at 12 months was 64.2% (2698/4201).', opts)?.resourceId,
    ).toBe('per')
    expect(
      verifyFirstSentence('Retention at 12 months was 71.1% (n = 1644).', opts),
    ).toBeNull()
  })
})

describe('StreamVerifier', () => {
  const opts = {
    texts: () => [experience],
    lexicon: ['brivaracetam'],
    questionEntities: ['brivaracetam'],
  }
  it('judges the first sentence once it closes or the second has begun, and only once', () => {
    const v = new StreamVerifier(opts)
    expect(v.push('In the EXPERIENCE study, the 12-month retention rate for')).toBeNull()
    expect(v.push(' brivaracetam was 71.1% (n = 1644')).toBeNull()
    const found = v.push('). Seizure freedom was 14.9% (n = 1111).')
    expect(found?.resourceId).toBe('exp')
    expect(v.push(' More text.')).toBeNull()
    expect(v.flush()).toBeNull()
  })
  it('judges a single-sentence answer the moment its chunk closes the sentence', () => {
    const v = new StreamVerifier(opts)
    expect(
      v.push(
        'The 12-month retention rate for brivaracetam was 71.1% (n = 1644, full analysis set).',
      )
        ?.resourceId,
    ).toBe('exp')
    expect(v.flush()).toBeNull()
  })
  it('judges an unclosed single sentence at the end of the stream', () => {
    const v = new StreamVerifier(opts)
    expect(v.push('Retention at 12 months was 71.1% (n = 1644) in the full analysis set'))
      .toBeNull()
    expect(v.flush()?.resourceId).toBe('exp')
  })
  it('knows a sentence end from an abbreviation', () => {
    expect(closesSentence('Retention was 71.1% (n = 1644).')).toBe(true)
    expect(closesSentence('Retention was 71.1% (n = 1644).[1]')).toBe(true)
    expect(closesSentence('as reported by Villanueva et al.')).toBe(false)
    expect(closesSentence('Retention was 71.1% at 3, 6 and')).toBe(false)
  })
  it('skips a leading heading', () => {
    const v = new StreamVerifier(opts)
    expect(v.push('### Retention\nRetention at 12 months was 71.1% (n = 1644).')?.resourceId).toBe(
      'exp',
    )
  })
})
