import type { ResourceContent, TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'

/**
 * Openers worth asking about ONE particular document, written from the
 * document itself rather than from a generic list.
 *
 * The generic three ("Summarise the key findings", "What are the main
 * recommendations?", "What methods were used?") are the same on every page, so
 * they teach the reader nothing about what THIS document holds - and on a
 * document that has no recommendations, the middle one is a trap that makes the
 * assistant answer "not enough data" to a question the portal itself offered.
 *
 * Cached under its own schema id in the EnrichmentStore, so a document's
 * openers are generated once and then served from the volume.
 */
export const SUGGESTED_QUESTIONS_SCHEMA_ID = 'suggested-questions'

/**
 * Openers are a cheap, high-volume job - one per document viewed - and they are
 * writing from text handed straight to them rather than reasoning over a corpus.
 * The fast tier does that well at a fraction of the latency and cost of the
 * box's default model.
 */
const FAST_MODEL = 'aws-claude-4-5-haiku'

/** Questions to show; we ask for twice this, because some fail the grounding test below. */
const WANT = 3

/**
 * A view of the document that isn't just its opening pages.
 *
 * Feeding a model the first N characters of a report feeds it the cover, the
 * acknowledgements and the contents page - so the questions come back about the
 * introduction, because that is all it was shown. Sampling the beginning, the
 * middle and the end for the same token spend reaches the findings and the
 * recommendations, which is what a reader actually wants to ask about. Cuts land
 * on whitespace so a window never opens mid-word.
 */
export function sampleDocument(raw: string, budget = 6000): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length <= budget) return text

  const cut = (from: number, len: number) => {
    const start = from === 0 ? 0 : Math.max(0, text.indexOf(' ', from) + 1 || from)
    const end = Math.min(text.length, start + len)
    const stop = end >= text.length ? end : text.lastIndexOf(' ', end)
    return text.slice(start, stop > start ? stop : end).trim()
  }
  const head = Math.round(budget * 0.4)
  const rest = Math.round(budget * 0.3)
  return [
    cut(0, head),
    cut(Math.round(text.length / 2) - Math.round(rest / 2), rest),
    cut(text.length - rest, rest),
  ].filter(Boolean).join('\n\n[...]\n\n')
}

/** Straight quotes, single spaces, lower case - so a curly apostrophe or a line
 *  break the PDF extractor left behind cannot defeat the grounding check. */
function flatten(value: string): string {
  return value
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Grounded, not word-perfect.
 *
 * The test exists to catch a question the document cannot answer. Demanding the
 * model reproduce a sentence character for character tests something else - how
 * good a copyist it is - and it fails on an expanded abbreviation or a hyphen
 * the extractor left mid-sentence, silently discarding true questions.
 *
 * So: evidence is grounded if any run of six consecutive words from it appears
 * in the document. Six words in a row is not something a model invents about a
 * document it is looking at, and it survives the model tidying up the rest.
 */
export function evidenceIsGrounded(evidence: string, excerpt: string): boolean {
  const haystack = flatten(excerpt)
  const needle = flatten(evidence)
  if (!haystack) return true // nothing to check against: trust the summary
  if (haystack.includes(needle)) return true
  const words = needle.split(' ').filter(Boolean)
  if (words.length < 6) return false
  for (let i = 0; i + 6 <= words.length; i++) {
    if (haystack.includes(words.slice(i, i + 6).join(' '))) return true
  }
  return false
}

/**
 * The model is told not to ask these, and mostly obeys; this is the backstop for
 * when it doesn't. A reader looking at the page can already see who wrote the
 * thing and when - an opener that tells them nothing new wastes one of three slots.
 */
const ABOUT_THE_OBJECT =
  /^(who (wrote|authored|published|funded|commissioned|produced|prepared)|when (was|is) (it|this)|what (year|type|kind) of|who (is|was) (it|this) (for|written for)|what is this (document|report|resource))/i

export function isAboutTheObject(question: string): boolean {
  return ABOUT_THE_OBJECT.test(question.trim())
}

/** Keep the questions that prove they are answerable from this document. */
export function selectQuestions(
  rows: unknown,
  excerpt: string,
  count = WANT,
): string[] {
  if (!Array.isArray(rows)) return []
  const out: string[] = []
  for (const row of rows) {
    const record = row as { question?: unknown; evidence?: unknown }
    const question = String(record?.question ?? '').trim()
    const evidence = String(record?.evidence ?? '').trim()
    // A suggested question the document cannot answer is worse than no
    // suggestion at all: the reader clicks it, and the assistant has to reply
    // "not enough data" to a question the app itself put in front of them.
    if (!question || flatten(evidence).length < 25) continue
    if (isAboutTheObject(question)) continue
    if (!evidenceIsGrounded(evidence, excerpt)) continue
    if (out.some((q) => q.toLowerCase() === question.toLowerCase())) continue
    out.push(question)
  }
  return out.slice(0, count)
}

function questionsSchema(asked: number) {
  return {
    name: 'suggested_questions',
    description: 'Questions this specific document actually answers.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          // No minItems/maxItems: the API rejects array bounds above 1
          // ("minItems values other than 0 or 1 are not supported"), so the
          // count is asked for in the description and enforced on the way out.
          description: `Exactly ${asked} questions, each with the sentence from the ` +
            'document that answers it. Vary them: what it found, what it recommends, what it ' +
            'means in practice, what a specific term or figure in it means. Australian English.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: {
                type: 'string',
                description:
                  'A question this document ANSWERS. Under 12 words, phrased the way a person ' +
                  'would type it, no numbering, no trailing context. Be specific to the ' +
                  "document's actual content - name the programs, species, fisheries, figures " +
                  'or frameworks it discusses - so it could not be asked of any other document. ' +
                  'Ask about the substance: what it found, what it recommends, what a term ' +
                  'means, what it asks people to do. NEVER ask about the document as an object ' +
                  'rather than about its content - not who wrote, authored, published, funded ' +
                  'or commissioned it, not when it was published, not what kind of document it ' +
                  'is, not who it is for, and nothing from acknowledgements, the foreword or ' +
                  'the copyright page. A reader can see all of that on the page already; they ' +
                  'came here to ask what it SAYS.',
              },
              evidence: {
                type: 'string',
                description:
                  'The sentence from the text above that ANSWERS the question, copied EXACTLY, ' +
                  'character for character. This is the test the question has to pass: if the ' +
                  'text mentions that something exists but never states it, the question cannot ' +
                  'be asked, because the document does not answer it. If you cannot copy out a ' +
                  'sentence that answers the question, return an empty string and the question ' +
                  'will be discarded.',
              },
            },
            required: ['question', 'evidence'],
          },
        },
      },
      required: ['questions'],
    },
  }
}

/** The document as context for pure generation: its full extracted text, sampled. */
export function questionContextFor(content: ResourceContent | null): string {
  if (!content) return ''
  // Deliberately NOT documentTextFor(): that prefers the page summary, and
  // questions written from a summary are questions about the summary. The whole
  // text, sampled across its length, is what makes an opener specific.
  const joined = content.texts.map((t) => t.text).join('\n\n').trim()
  if (joined.length >= 400) return sampleDocument(joined)
  return content.pageSummary?.trim() ?? joined
}

/**
 * Generate openers for one resource. Returns [] rather than throwing: openers
 * are a nicety, and the caller falls back to its generic three.
 */
export async function generateSuggestedQuestions(
  management: AragProvider,
  config: TenantConfig,
  resourceId: string,
  title: string,
  summary?: string,
): Promise<string[]> {
  const content = await management.resourceContent(config, resourceId).catch(() => null)
  const excerpt = questionContextFor(content)
  if (!excerpt) return []

  // Ask for more than the page can show. Every question has to prove it is
  // grounded, and some will fail; asking for exactly three means two failures
  // drop the page back to its generic openers.
  const asked = WANT * 2
  const prompt = [
    `Write ${asked} questions that this ONE research document answers.`,
    'Use only the document text below; do not draw on outside knowledge.',
    '',
    `TITLE: ${title}`,
    summary ? `SUMMARY: ${summary}` : '',
    '',
    '--- DOCUMENT TEXT (use only this) ---',
    excerpt,
    '--- END DOCUMENT TEXT ---',
  ].filter(Boolean).join('\n')

  try {
    const result = await management.askStructured(config, questionsSchema(asked), prompt, {
      resourceId,
      model: FAST_MODEL,
    })
    const object = result.object as { questions?: unknown } | null
    return selectQuestions(object?.questions, excerpt)
  } catch {
    return []
  }
}
