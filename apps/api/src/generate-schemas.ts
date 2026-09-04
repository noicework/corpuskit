import type { GenerateKind } from '@research-portal/core'

/**
 * OpenAI-function-style schemas for query-time structured generation
 * (`answer_json_schema` on /ask). Strict form throughout: every object node
 * sets additionalProperties:false and lists every property in required -
 * some KB generative models enforce this, and the strict form works on all.
 */

const strict = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})

const str = { type: 'string' }
const strArray = { type: 'array', items: str }

export const GENERATE_SCHEMAS: Record<
  GenerateKind,
  { name: string; description: string; parameters: unknown; label: string }
> = {
  comparison: {
    name: 'comparison_matrix',
    description: 'Structured comparison of items across assessment dimensions',
    label: 'comparison',
    parameters: strict(
      {
        dimensions: strArray,
        items: {
          type: 'array',
          items: strict(
            {
              name: str,
              ratings: {
                type: 'array',
                items: strict({
                  dimension: str,
                  assessment: str,
                  source: {
                    type: 'string',
                    description:
                      'Title of the context source this assessment is drawn from; empty string when none applies',
                  },
                }, [
                  'dimension',
                  'assessment',
                  'source',
                ]),
              },
            },
            ['name', 'ratings'],
          ),
        },
      },
      ['dimensions', 'items'],
    ),
  },
  briefing: {
    name: 'research_briefing',
    description: 'A structured research briefing document',
    label: 'briefing',
    parameters: strict(
      {
        title: str,
        executive_summary: str,
        sections: {
          type: 'array',
          items: strict({ heading: str, content: str }, ['heading', 'content']),
        },
        key_takeaways: strArray,
      },
      ['title', 'executive_summary', 'sections', 'key_takeaways'],
    ),
  },
  timeline: {
    name: 'timeline',
    description: 'A chronological timeline of events',
    label: 'timeline',
    parameters: strict(
      {
        title: str,
        events: {
          type: 'array',
          items: strict({ date: str, title: str, description: str }, [
            'date',
            'title',
            'description',
          ]),
        },
      },
      ['title', 'events'],
    ),
  },
  proscons: {
    name: 'pros_cons',
    description: 'A balanced pros and cons analysis of a subject',
    label: 'pros and cons analysis',
    parameters: strict(
      {
        subject: str,
        pros: {
          type: 'array',
          items: strict({ point: str, rationale: str }, ['point', 'rationale']),
        },
        cons: {
          type: 'array',
          items: strict({ point: str, rationale: str }, ['point', 'rationale']),
        },
      },
      ['subject', 'pros', 'cons'],
    ),
  },
  faq: {
    name: 'faq',
    description: 'Frequently asked questions with grounded answers',
    label: 'FAQ',
    parameters: strict(
      {
        title: str,
        entries: {
          type: 'array',
          items: strict({ question: str, answer: str }, ['question', 'answer']),
        },
      },
      ['title', 'entries'],
    ),
  },
  assessment: {
    name: 'assessment_quiz',
    description: 'A knowledge-check quiz grounded in the corpus',
    label: 'assessment quiz',
    parameters: strict(
      {
        questions: {
          type: 'array',
          items: strict(
            {
              question: str,
              options: { type: 'array', items: str, minItems: 4, maxItems: 4 },
              correct_index: { type: 'integer' },
              explanation: str,
              topic: str,
            },
            ['question', 'options', 'correct_index', 'explanation', 'topic'],
          ),
        },
      },
      ['questions'],
    ),
  },
}
