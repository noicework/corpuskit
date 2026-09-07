/**
 * Loop 6 D6-09: a quiz question's Source link opens the paper that carries
 * its quote. The model writes the title from memory and the quote from the
 * passage in front of it, so where the two disagree the quote wins, and a
 * quote no retrieved paper carries is not asked at all
 * (review loop 6).
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { attributeQuiz, textCarriesQuote } from './generate-sources.ts'

const sources = [
  {
    id: '8565cc8f',
    title: 'Acute and Long-Term Immune-Treatment Strategies in Anti-LGI1 Encephalitis',
    sourceName: 'lgi1.pdf',
  },
  {
    id: '76220423',
    title: 'Rituximab use for relapse prevention in anti-NMDAR encephalitis',
    sourceName: 'nmdar.pdf',
  },
]

const passages = {
  '8565cc8f': [
    'At 12 months, the mRS had improved in 34 (71%) patients, while a favorable mRS was recorded in 38 (79%) patients of this anti-LGI1 cohort.',
  ],
  '76220423': [
    'A single course of rituximab reduces the risk of relapse of anti-NMDAR antibody-mediated encephalitis in this cohort.',
  ],
}

describe('a quiz question is bound to the paper that carries its quote (D6-09)', () => {
  it('prefers the quote over the title the model wrote', () => {
    const out = attributeQuiz(
      {
        questions: [{
          question: 'What is the effect of rituximab on relapse in anti-NMDAR encephalitis?',
          options: ['a', 'b', 'c', 'd'],
          correct_index: 0,
          // The title the model wrote is the wrong paper, and it resolves.
          source: 'Acute and Long-Term Immune-Treatment Strategies in Anti-LGI1 Encephalitis',
          source_quote:
            'A single course of rituximab reduces the risk of relapse of anti-NMDAR antibody-mediated encephalitis',
        }],
      },
      sources,
      passages,
    ) as { questions: Record<string, unknown>[] }
    expect(out.questions[0]?.source_resource_id).toBe('76220423')
    expect(out.questions[0]?.source_title).toBe(
      'Rituximab use for relapse prevention in anti-NMDAR encephalitis',
    )
    // A label naming a different paper from the one the quote resolved to is
    // dropped, not carried alongside it: two attributions for one question
    // leave the reader no way to tell which is the source (loop 7 D7-11).
    expect(out.questions[0]?.source_label).toBe(null)
  })

  it('keeps the title when the quote locates nowhere', () => {
    const out = attributeQuiz(
      {
        questions: [{
          question: 'Q',
          source: 'Acute and Long-Term Immune-Treatment Strategies in Anti-LGI1 Encephalitis',
          source_quote: 'a sentence about something else entirely, with no overlap at all',
        }],
      },
      sources,
      passages,
    ) as { questions: Record<string, unknown>[] }
    expect(out.questions[0]?.source_resource_id).toBe('8565cc8f')
  })

  it("locates a quote in a paper's own extracted text, across a paragraph break", () => {
    const text = [
      'Introduction',
      'Anti-LGI1 encephalitis is the second most common form of autoimmune encephalitis in adults, and its treatment is not settled.',
      'A single course of rituximab reduces the risk of relapse of anti-NMDAR',
      'antibody-mediated encephalitis, an effect that was sustained at 24 months in this cohort of patients.',
    ].join('\n\n')
    expect(
      textCarriesQuote(
        'A single course of rituximab reduces the risk of relapse of anti-NMDAR antibody-mediated encephalitis',
        text,
      ),
    ).toBe(true)
    expect(
      textCarriesQuote(
        'perampanel retention at 12 months was 64.2% in the retention population',
        text,
      ),
    ).toBe(false)
  })
})
