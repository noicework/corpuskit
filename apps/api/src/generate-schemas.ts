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
          items: strict({
            heading: str,
            content: {
              type: 'string',
              description:
                'Two to six sentences that state the concrete figures the sources report ' +
                '(effect sizes, AUCs, hazard ratios, cohort sizes, dataset names, doses) with ' +
                'the study or first author named beside each figure; never a generality',
            },
            sources: {
              type: 'array',
              items: str,
              description:
                'Exact titles of the context sources this section draws on; at least one. ' +
                'A section with no source is discarded',
            },
            statements: {
              type: 'array',
              description:
                'One entry per figure the content states: the figure exactly as written ' +
                '(for example "36.9%" or "n = 822"), the outcome it measures in the source\'s ' +
                'own words (for example "50% responder rate at 12 months" or "discontinuation ' +
                'for any reason"), the population or analysis set it applies to (for example ' +
                '"all patients, full analysis set" or "patients with psychiatric comorbidity"), ' +
                'and the exact title of the source document it comes from',
              items: strict({
                figure: str,
                outcome: str,
                population: str,
                study: str,
              }, ['figure', 'outcome', 'population', 'study']),
            },
          }, ['heading', 'content', 'sources', 'statements']),
        },
        key_takeaways: {
          type: 'array',
          items: str,
          description: 'Each takeaway carries a figure or a named study from the sources',
        },
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
              question: {
                type: 'string',
                description: 'A stem answerable from one retrieved passage - about a figure, a ' +
                  'proportion, an effect size or a comparison the source reports',
              },
              options: {
                type: 'array',
                items: str,
                minItems: 4,
                maxItems: 4,
                description:
                  'Four options; every distractor a plausible value or claim a specialist ' +
                  'could mistake for the answer',
              },
              correct_index: { type: 'integer' },
              explanation: str,
              topic: str,
              source: {
                type: 'string',
                description: 'Exact title of the context source this question is written from',
              },
              source_quote: {
                type: 'string',
                description:
                  'A verbatim quote of eight to twenty words, copied exactly from the context ' +
                  'passage the question is written from',
              },
            },
            [
              'question',
              'options',
              'correct_index',
              'explanation',
              'topic',
              'source',
              'source_quote',
            ],
          ),
        },
      },
      ['questions'],
    ),
  },
}
