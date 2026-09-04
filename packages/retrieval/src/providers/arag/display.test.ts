import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { Question } from '@research-portal/core'
import {
  deriveRelatedQuestions,
  displayTitle,
  isDisplayableResource,
  looksLikeBotChallengeTitle,
  looksLikeRawHashTitle,
} from './index.ts'

/**
 * Punch-list defect #2 (junk ingestions leaking into user-facing lists),
 * #5 (raw-hash/project-code citation titles) and #6 (query-blind related
 * questions) - the pure predicates and helpers behind those fixes, tested
 * directly against representative platform payload shapes.
 */

describe('looksLikeRawHashTitle', () => {
  it('flags a bare 32-char hex resource id with no spaces', () => {
    expect(looksLikeRawHashTitle('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true)
  })

  it('flags a dashed uuid-shaped id', () => {
    expect(looksLikeRawHashTitle('a1b2c3d4-e5f6-4a1b-8c3d-4e5f6a1b2c3d')).toBe(true)
  })

  it('does not flag a real title, even a long one', () => {
    expect(looksLikeRawHashTitle('Abalone stock assessment for the southern zone 2024')).toBe(
      false,
    )
  })

  it('does not flag a bare funder-style project code - that is an acceptable title', () => {
    expect(looksLikeRawHashTitle('2005-024-DLD')).toBe(false)
  })

  it('does not flag a short numeric-only string', () => {
    expect(looksLikeRawHashTitle('12345')).toBe(false)
  })
})

describe('looksLikeBotChallengeTitle', () => {
  for (
    const title of [
      'Just a moment...',
      'Attention Required',
      'Please verify you are human',
      'Enable JavaScript and cookies to continue',
    ]
  ) {
    it(`flags "${title}"`, () => {
      expect(looksLikeBotChallengeTitle(title)).toBe(true)
    })
  }

  it('does not flag an ordinary research title', () => {
    expect(looksLikeBotChallengeTitle('White spot disease in farmed prawns')).toBe(false)
  })
})

describe('displayTitle', () => {
  it('prefers a real title over the id', () => {
    expect(displayTitle('Abalone stock management', 'res-1')).toBe('Abalone stock management')
  })

  it('keeps a bare project code - acceptable, just not a hash', () => {
    expect(displayTitle('2005-024-DLD', 'res-1')).toBe('2005-024-DLD')
  })

  it('never renders a raw hash id as the title', () => {
    const hash = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4'
    expect(displayTitle(hash, hash)).not.toBe(hash)
    expect(displayTitle(hash, hash)).toBe('Untitled resource')
  })

  it('falls back cleanly when the title is missing entirely', () => {
    expect(displayTitle(undefined, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe('Untitled resource')
  })

  it('falls back cleanly on a bot-challenge title', () => {
    expect(displayTitle('Just a moment...', 'res-1')).toBe('Untitled resource')
  })
})

describe('isDisplayableResource', () => {
  it('hides a resource with status ERROR', () => {
    expect(isDisplayableResource({ title: 'A fine title', metadata: { status: 'ERROR' } }))
      .toBe(false)
  })

  it('hides a resource whose title is a raw hash', () => {
    expect(isDisplayableResource({ title: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' })).toBe(false)
  })

  for (
    const title of [
      'Just a moment...',
      'Attention Required',
      'Please verify you are human',
      'Enable JavaScript and cookies to continue',
    ]
  ) {
    it(`hides a known bot-challenge title ("${title}")`, () => {
      expect(isDisplayableResource({ title })).toBe(false)
    })
  }

  it('shows a normally-processed resource with a real title', () => {
    expect(
      isDisplayableResource({
        title: 'Abalone stock assessment 2024',
        metadata: { status: 'PROCESSED' },
      }),
    ).toBe(true)
  })

  it('shows a resource with an acceptable bare project-code title', () => {
    expect(isDisplayableResource({ title: '2005-024-DLD', metadata: { status: 'PROCESSED' } }))
      .toBe(true)
  })
})

describe('deriveRelatedQuestions (query-aware "people also ask")', () => {
  const suggested: Question[] = [
    { id: 'q1', text: 'What does the research say about abalone stock management?' },
    { id: 'q2', text: 'How is white spot disease managed in farmed prawns?' },
    { id: 'q3', text: 'What biosecurity measures apply to orange roughy fisheries?' },
    { id: 'q4', text: 'What does the research say about abalone stock management?' },
  ]

  it('returns questions that share real subject words with the query', () => {
    const result = deriveRelatedQuestions('abalone stock management in Tasmania', suggested)
    expect(result.map((q) => q.id)).toContain('q1')
  })

  it('excludes the exact same question the user just asked', () => {
    const result = deriveRelatedQuestions(
      'What does the research say about abalone stock management?',
      suggested,
    )
    expect(result.map((q) => q.id)).not.toContain('q1')
  })

  it('does not surface unrelated questions for a different topic', () => {
    const result = deriveRelatedQuestions('abalone stock management in Tasmania', suggested)
    expect(result.map((q) => q.id)).not.toContain('q3')
  })

  it('returns an empty list (widget hides) when nothing genuinely overlaps', () => {
    const result = deriveRelatedQuestions('kelp forest restoration in Victoria', suggested)
    expect(result).toEqual([])
  })
})
