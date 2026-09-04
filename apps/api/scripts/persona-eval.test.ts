import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  conceptCoverage,
  grade,
  type GradeInput,
  type PersonaQuestion,
  type QuestionRun,
  QUESTIONS,
  summarise,
} from './persona-eval.ts'

/** A clean, well-cited answer - the baseline every test varies one thing from. */
function goodAnswer(overrides: Partial<GradeInput> = {}): GradeInput {
  return {
    refused: false,
    text: 'Catch curve analysis is recommended for data-limited fisheries [1][2].',
    sourcesCount: 8,
    distinctCitations: 3,
    citationMarkers: 2,
    citationUnresolved: 0,
    ...overrides,
  }
}

function question(overrides: Partial<PersonaQuestion> = {}): PersonaQuestion {
  return {
    id: 'T-01',
    persona: 'F1',
    klass: 'lookup',
    query: 'test question',
    probes: 'test',
    expect: { behaviour: 'answer', citationsRequired: true },
    ...overrides,
  }
}

describe('conceptCoverage', () => {
  it('counts a group as hit when any one of its surface forms appears', () => {
    const text = 'The study used microsatellite markers.'
    expect(conceptCoverage(text, [['allozyme', 'microsatellite', 'mtdna']])).toBe(1)
  })

  it('is case insensitive in both directions', () => {
    expect(conceptCoverage('WHITE SPOT was detected', [['White Spot']])).toBe(1)
  })

  it('requires every group to be hit, not just one', () => {
    const text = 'Abalone were surveyed by divers.'
    expect(conceptCoverage(text, [['abalone'], ['catch curve', 'mortality']])).toBe(1)
  })

  it('returns zero when nothing matches', () => {
    expect(conceptCoverage('unrelated prose', [['abalone'], ['prawn']])).toBe(0)
  })
})

describe('grade - forbidden phrases', () => {
  it('fails outright whatever the expected behaviour, because the phrase proves the failure', () => {
    const q = question({ expect: { behaviour: 'answer', absent: ['metformin'] } })
    const g = grade(q, goodAnswer({ text: 'First-line treatment is metformin [1].' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('forbidden phrase')
  })

  it('matches a forbidden phrase case-insensitively', () => {
    const q = question({ expect: { behaviour: 'refuse', absent: ['Ulaanbaatar'] } })
    const g = grade(q, goodAnswer({ text: 'The capital is ULAANBAATAR.' }))
    expect(g.verdict).toBe('fail')
  })
})

describe('grade - refuse', () => {
  const q = question({ klass: 'out-of-corpus', expect: { behaviour: 'refuse' } })

  it('passes when the portal set the refused flag', () => {
    expect(grade(q, goodAnswer({ refused: true, text: '' })).verdict).toBe('pass')
  })

  it("passes on the portal's own guardrail refusal copy even without the flag", () => {
    const text = "This portal's content does not hold enough relevant material to answer this."
    expect(grade(q, goodAnswer({ text })).verdict).toBe('pass')
  })

  it('fails when it answered a question it should have refused', () => {
    const g = grade(q, goodAnswer({ text: 'The answer is definitely 42 [1].' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('should have refused')
  })

  it('passes an assistant-voice decline, which leaves the refused flag false', () => {
    // A prompt injection is declined by the model in its own words rather than
    // by the platform guardrail, so wording is the only signal there is.
    expect(grade(q, goodAnswer({ text: "I'm sorry, I can't do that." })).verdict).toBe('pass')
  })
})

describe('grade - challenge (false premise)', () => {
  const q = question({ klass: 'false-premise', expect: { behaviour: 'challenge' } })

  it('fails when it plays along with the premise', () => {
    const g = grade(q, goodAnswer({ text: 'The release failed because of poor uptake [1].' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('false premise')
  })

  it('routes a pushback to review rather than claiming a pass keyword matching cannot justify', () => {
    const g = grade(q, goodAnswer({ text: 'There is no evidence such a release took place.' }))
    expect(g.verdict).toBe('review')
    expect(g.needsReview).toBe(true)
  })
})

describe('grade - caveat', () => {
  const q = question({
    klass: 'temporal',
    expect: { behaviour: 'caveat', citationsRequired: true },
  })

  it('fails an answer that states no limit on its own authority', () => {
    const g = grade(q, goodAnswer({ text: 'Eastern gemfish is currently overfished [1].' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('no visible limit')
  })

  it('passes an answer that bounds itself', () => {
    const text = 'Assessments up to 1998 found gemfish overfished [1]; this may not reflect ' +
      'current status and should be verified against recent assessments.'
    expect(grade(q, goodAnswer({ text })).verdict).toBe('pass')
  })

  it('fails a refusal, because the question was answerable with a caveat', () => {
    const g = grade(q, goodAnswer({ refused: true, text: '' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('should have been answered')
  })
})

describe('grade - answer', () => {
  it('fails a refusal on a question the corpus covers', () => {
    const g = grade(question(), goodAnswer({ refused: true, text: '' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('demonstrably covers')
  })

  it('fails an answer with no citation markers when citations are required', () => {
    const g = grade(question(), goodAnswer({ citationMarkers: 0, text: 'Some prose.' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('no inline citation markers')
  })

  it('fails an answer whose citation marker resolves to nothing', () => {
    const g = grade(question(), goodAnswer({ citationUnresolved: 1 }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons.some((r) => r.includes('resolve to nothing'))).toBe(true)
  })

  it('downgrades a thin retrieval to review rather than failing it', () => {
    const q = question({ expect: { behaviour: 'answer', minSources: 5, citationsRequired: true } })
    const g = grade(q, goodAnswer({ sourcesCount: 2 }))
    expect(g.verdict).toBe('review')
    expect(g.reasons.some((r) => r.includes('retrieved 2 sources'))).toBe(true)
  })

  it('downgrades a single-source answer when synthesis was expected', () => {
    const q = question({
      expect: { behaviour: 'answer', minDistinctCitations: 3, citationsRequired: true },
    })
    const g = grade(q, goodAnswer({ distinctCitations: 1 }))
    expect(g.verdict).toBe('review')
    expect(g.reasons.some((r) => r.includes('cited 1 distinct'))).toBe(true)
  })

  it('downgrades a partial concept hit to review', () => {
    const q = question({
      expect: {
        behaviour: 'answer',
        concepts: [['catch curve'], ['abalone']],
        citationsRequired: true,
      },
    })
    const g = grade(q, goodAnswer())
    expect(g.verdict).toBe('review')
    expect(g.conceptsHit).toBe(1)
    expect(g.conceptsTotal).toBe(2)
  })

  it('passes a clean answer that meets every expectation', () => {
    const q = question({
      expect: {
        behaviour: 'answer',
        concepts: [['catch curve'], ['data-limited']],
        minSources: 3,
        minDistinctCitations: 2,
        citationsRequired: true,
      },
    })
    const g = grade(q, goodAnswer())
    expect(g.verdict).toBe('pass')
    expect(g.needsReview).toBe(false)
  })

  it('fails a no-evidence response to an in-corpus question', () => {
    const g = grade(question(), goodAnswer({ text: 'There is no evidence in these reports.' }))
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('no-evidence response')
  })
})

describe('summarise', () => {
  function run(overrides: Partial<QuestionRun> = {}): QuestionRun {
    return {
      id: 'T-01',
      persona: 'F1',
      klass: 'lookup',
      query: 'q',
      probes: 'p',
      expected: 'answer',
      ok: true,
      verdict: 'pass',
      reasons: [],
      conceptsHit: 1,
      conceptsTotal: 1,
      refused: false,
      sourcesCount: 5,
      distinctCitations: 2,
      citationMarkers: 2,
      citationUnresolved: 0,
      answerRelevance: 4,
      groundedness: 5,
      contextRelevance: 3,
      firstTokenMs: 2000,
      totalMs: 8000,
      citedTitles: [],
      topSources: [],
      answer: 'text',
      ...overrides,
    }
  }

  it('separates the strict pass rate from the pass-or-review rate', () => {
    const s = summarise([
      run({ verdict: 'pass' }),
      run({ verdict: 'review' }),
      run({ verdict: 'fail' }),
      run({ verdict: 'pass' }),
    ])
    expect(s.total).toBe(4)
    expect(s.pass).toBe(2)
    expect(s.review).toBe(1)
    expect(s.fail).toBe(1)
    expect(s.strictPassRate).toBe(50)
    expect(s.passRate).toBe(75)
  })

  it('tallies by persona and by question class independently', () => {
    const s = summarise([
      run({ persona: 'F1', klass: 'lookup', verdict: 'pass' }),
      run({ persona: 'F8', klass: 'false-premise', verdict: 'fail' }),
      run({ persona: 'F8', klass: 'out-of-corpus', verdict: 'pass' }),
    ])
    expect(s.byPersona.F8?.total).toBe(2)
    expect(s.byPersona.F8?.fail).toBe(1)
    expect(s.byClass['false-premise']?.fail).toBe(1)
    expect(s.byClass.lookup?.pass).toBe(1)
  })

  it('counts a harness error separately from a portal verdict', () => {
    const s = summarise([run({ ok: false, verdict: 'fail' })])
    expect(s.harnessErrors).toBe(1)
    expect(s.fail).toBe(1)
  })

  it('excludes refusals from the quality means, which are only defined for answers', () => {
    const s = summarise([
      run({ groundedness: 4 }),
      run({ refused: true, groundedness: null, answerRelevance: null, contextRelevance: null }),
    ])
    expect(s.meanGroundedness).toBe(4)
  })

  it('reports zero citation integrity failures on a clean set', () => {
    expect(summarise([run(), run()]).citationIntegrityFailures).toBe(0)
  })

  it('counts every run with an unresolved marker', () => {
    expect(summarise([run({ citationUnresolved: 2 }), run()]).citationIntegrityFailures).toBe(1)
  })
})

describe('the question bank itself', () => {
  it('gives every question a unique id', () => {
    const ids = QUESTIONS.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers all eight fisheries personas', () => {
    expect(new Set(QUESTIONS.map((q) => q.persona)).size).toBe(8)
  })

  it('requires citations wherever it expects a substantive answer', () => {
    const substantive = QUESTIONS.filter((q) =>
      q.expect.behaviour === 'answer' || q.expect.behaviour === 'caveat'
    )
    for (const q of substantive) {
      expect(q.expect.citationsRequired, `${q.id} must require citations`).toBe(true)
    }
  })

  it('never asks for concept coverage on a question it expects to be refused', () => {
    for (const q of QUESTIONS.filter((q) => q.expect.behaviour === 'refuse')) {
      expect(q.expect.concepts, `${q.id} should not assert concepts in a refusal`).toBeUndefined()
    }
  })

  it('explains why every question is in the set', () => {
    for (const q of QUESTIONS) {
      expect(q.probes.length, `${q.id} needs a probes rationale`).toBeGreaterThan(20)
    }
  })
})
