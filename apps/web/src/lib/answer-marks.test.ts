import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  auditBadge,
  figureLabel,
  isUnsupportedFigure,
  unsupportedFigurePattern,
} from './answer-marks.ts'

const clean = {
  figuresChecked: 4,
  figuresUnsupported: [],
  yearsUnsupported: [],
  contraindicationsUnsupported: [],
}

describe('auditBadge', () => {
  it('says every figure was checked when all were found', () => {
    expect(auditBadge(clean)).toEqual({
      label: '4 figures checked',
      tone: 'ok',
      title: 'Every figure in this answer was found beside its claim in a cited passage.',
    })
  })

  it('counts the unverified figures and years, and removed contraindications', () => {
    const badge = auditBadge({
      figuresChecked: 3,
      figuresUnsupported: ['45%'],
      yearsUnsupported: ['2025'],
      contraindicationsUnsupported: ['vigabatrin'],
    })
    expect(badge?.tone).toBe('warn')
    expect(badge?.label).toBe('2 of 4 unverified · 1 unsupported contraindication removed')
    expect(badge?.title).toContain('45%')
    expect(badge?.title).toContain('2025')
    expect(badge?.title).toContain('vigabatrin')
  })

  it('says what the gate removed, and that what remains passed', () => {
    const badge = auditBadge({
      ...clean,
      figuresChecked: 10,
      sentencesRemoved: 2,
      figuresRemoved: ['80%', '82.7%'],
      sentencesChecked: 5,
      sentencesCited: 3,
    })
    expect(badge?.tone).toBe('warn')
    expect(badge?.label).toBe('10 figures checked · 2 sentences removed')
    expect(badge?.title).toContain('2 sentences were removed')
    expect(badge?.title).toContain('(80%, 82.7%)')
    expect(badge?.title).toContain('Every figure still in the answer was found beside its claim.')
  })

  it('is silent when there was nothing to check', () => {
    expect(auditBadge({ ...clean, figuresChecked: 0 })).toBeNull()
    expect(auditBadge(undefined)).toBeNull()
  })
})

describe('unsupportedFigurePattern', () => {
  it('matches the figures as written in the answer, with separators and units', () => {
    const pattern = unsupportedFigurePattern({
      ...clean,
      figuresUnsupported: ['1400mg', '45%', '6.42%'],
      yearsUnsupported: ['2025'],
    })
    const text = 'Below 1,400 mg the rate was 6.42%; 21% to 45 % in 2025, not 20250 or 4.5%.'
    const marked = text.split(new RegExp(`(${pattern!.source})`, 'g')).filter((s) =>
      isUnsupportedFigure(s, pattern)
    )
    expect(marked).toEqual(['1,400 mg', '6.42%', '45 %', '2025'])
  })

  it('is null with nothing to mark', () => {
    expect(unsupportedFigurePattern(clean)).toBeNull()
    expect(isUnsupportedFigure('45%', null)).toBe(false)
  })
})

describe('audit badge - denominators, sentences and durations', () => {
  it('names the sentence coverage and bare proportions in the tooltip', () => {
    const badge = auditBadge({
      figuresChecked: 2,
      figuresUnsupported: [],
      yearsUnsupported: [],
      contraindicationsUnsupported: [],
      sentencesChecked: 3,
      sentencesCited: 2,
      denominatorsMissing: ['71.1%'],
    })
    expect(badge?.label).toBe('2 figures checked')
    expect(badge?.title).toContain('2 of 3 sentences carry a citation')
    expect(badge?.title).toContain('Stated without a denominator: 71.1%')
  })

  it('marks a duration as written, "12 months" or "12-month"', () => {
    const pattern = unsupportedFigurePattern({
      figuresChecked: 1,
      figuresUnsupported: ['12months'],
      yearsUnsupported: [],
      contraindicationsUnsupported: [],
    })
    expect(pattern).not.toBeNull()
    expect('at 12 months'.split(new RegExp(`(${pattern!.source})`, 'g'))).toContain('12 months')
    expect('the 12-month rate'.split(new RegExp(`(${pattern!.source})`, 'g'))).toContain('12-month')
    expect(figureLabel('12months')).toBe('12 months')
  })
})
