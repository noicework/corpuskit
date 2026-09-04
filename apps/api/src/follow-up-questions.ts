import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { evidenceIsGrounded, isAboutTheObject } from './suggested-questions.ts'

/**
 * The questions worth asking NEXT, written from the answer the reader has just
 * been given rather than from a fixed list.
 *
 * The portal already has a tenant-level list of openers, and it is the right
 * thing on an empty assistant page. Re-showing it under an answer is not: the
 * same six generic questions appear whatever was just asked, so they read as
 * decoration rather than as a way on. A follow-up earns its place only when it
 * continues THIS conversation.
 *
 * The grounding problem is the interesting one. A follow-up is by definition
 * not answered by the answer above it, so the answer cannot be the evidence.
 * What can be is the retrieval that produced the answer: the passages the
 * platform pulled back are real corpus text, they are already topically close
 * to the question, and most answers use only a fraction of what they retrieved.
 * So a follow-up is accepted only when the model can copy out the sentence
 * FROM THOSE PASSAGES that answers it. That makes the question demonstrably
 * answerable from the corpus, and phrased around specifics the passage
 * actually contains, so the next retrieval finds that passage again.
 *
 * The alternative (generate freely from the answer, ship whatever comes back)
 * produces questions the assistant then has to refuse, which is worse than
 * offering nothing at all - the same reasoning that governs the per-document
 * openers in ./suggested-questions.ts, whose grounding test this reuses.
 */

/**
 * Follow-ups are a cheap, high-volume job written from text handed straight to
 * the model, exactly like the per-document openers, and they run AFTER an
 * answer the reader is already reading. The fast tier does that well at a
 * fraction of the latency of the box's default model, which matters here: a
 * follow-up that lands a minute late has missed its moment.
 */
const FAST_MODEL = 'aws-claude-4-5-haiku'

/** Follow-ups to show. We ask for twice this, because some fail the tests below. */
const WANT = 3

/** Total passage text handed to the model, across all passages. */
const PASSAGE_BUDGET = 6000

/** How much of the answer the model is shown, so it can avoid re-asking it. */
const ANSWER_BUDGET = 2500

/** Below this there is not enough real corpus text to prove a follow-up against. */
const MIN_CONTEXT = 200

export interface FollowUpPassage {
  title: string
  text: string
}

export interface FollowUpInput {
  /** The question the reader just asked. */
  question: string
  /** The answer they were given. */
  answer: string
  /** The passages retrieved for that answer - the only source a follow-up may draw on. */
  passages: FollowUpPassage[]
}

/** Collapse whitespace and cut on a word boundary, so a window never opens mid-word. */
function clip(raw: string, limit: number): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  const stop = text.lastIndexOf(' ', limit)
  return text.slice(0, stop > limit / 2 ? stop : limit).trim()
}

/**
 * The retrieved passages as one block of corpus text.
 *
 * Every passage gets an equal share of the budget rather than the first one
 * taking it all: the top hit is usually what the answer already used, so the
 * unspent material - which is where a good follow-up comes from - sits further
 * down the list.
 */
export function passageContext(passages: FollowUpPassage[], budget = PASSAGE_BUDGET): string {
  const usable = passages.filter((passage) => passage.text.trim().length > 0)
  if (usable.length === 0) return ''
  const share = Math.max(300, Math.floor(budget / usable.length))
  const parts: string[] = []
  let spent = 0
  for (const passage of usable) {
    if (spent >= budget) break
    const text = clip(passage.text, Math.min(share, budget - spent))
    if (!text) continue
    spent += text.length
    parts.push(`${clip(passage.title, 160)}: ${text}`)
  }
  return parts.join('\n\n')
}

/**
 * Words that carry the topic. Short words and question scaffolding are dropped
 * so "What did the trial find?" and "Which trial found what?" compare on
 * "trial" and "find", not on their grammar.
 */
const SCAFFOLDING = new Set(
  ('what which when where whose whom does done this that these those they them their there here ' +
    'been being have from with about into than then were was are the and for any how why who ' +
    'much many more most said says tell show give given make made take taken')
    .split(' '),
)

/**
 * Crude stemming, enough that "findings" and "find" or "trials" and "trial"
 * count as the same word. Without it a model can dodge the echo test by
 * changing a verb to a noun, which is the first thing it reaches for.
 */
function stem(word: string): string {
  let out = word
  if (out.endsWith('ies') && out.length > 4) out = `${out.slice(0, -3)}y`
  else if (out.endsWith('s') && !out.endsWith('ss') && out.length > 3) out = out.slice(0, -1)
  if (out.endsWith('ing') && out.length > 5) out = out.slice(0, -3)
  else if (out.endsWith('ed') && out.length > 4) out = out.slice(0, -2)
  return out
}

function topicWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !SCAFFOLDING.has(word))
      .map(stem),
  )
}

/** Share of a candidate's own topic words that the asked question already had. */
const ECHO_THRESHOLD = 0.7

/**
 * True when a candidate is the question that was just asked, wearing different
 * grammar. Offering the reader their own question back is the single most
 * obvious way this feature can look stupid, and models reach for it constantly
 * because a reworded question is trivially "answerable from the passages".
 *
 * Measured against the CANDIDATE's own topic words, not the union: a follow-up
 * that adds a new subject keeps a low score even when it repeats the original
 * subject, which is exactly the shape of a good follow-up ("...and how did that
 * affect spawning?"). A candidate that adds nothing scores 1.
 */
export function isEchoOfQuestion(candidate: string, asked: string): boolean {
  const mine = topicWords(candidate)
  if (mine.size === 0) return true
  const theirs = topicWords(asked)
  let shared = 0
  for (const word of mine) if (theirs.has(word)) shared++
  return shared / mine.size >= ECHO_THRESHOLD
}

/**
 * Keep the follow-ups that prove they belong: answerable from the retrieved
 * corpus text, not a rewording of the question just answered, not about the
 * documents as objects, and phrased like something a person would type.
 *
 * Returns [] when there is no corpus text to test against. `evidenceIsGrounded`
 * deliberately trusts the model when it has nothing to check (the per-document
 * openers need that, because a scanned page yields no text), but here an
 * untested follow-up is the exact failure this whole module exists to avoid.
 */
export function selectFollowUps(
  rows: unknown,
  context: string,
  asked: string,
  count = WANT,
): string[] {
  if (!Array.isArray(rows)) return []
  if (context.trim().length === 0) return []
  const out: string[] = []
  for (const row of rows) {
    const record = row as { question?: unknown; evidence?: unknown }
    const question = String(record?.question ?? '').trim()
    const evidence = String(record?.evidence ?? '').trim()
    if (!question.endsWith('?')) continue
    const words = question.split(/\s+/).filter(Boolean)
    if (words.length < 4 || words.length > 16) continue
    if (evidence.replace(/\s+/g, ' ').trim().length < 25) continue
    if (isAboutTheObject(question)) continue
    if (isEchoOfQuestion(question, asked)) continue
    if (!evidenceIsGrounded(evidence, context)) continue
    if (out.some((kept) => kept.toLowerCase() === question.toLowerCase())) continue
    // Three follow-ups that are each other's rewording waste all three slots.
    if (out.some((kept) => isEchoOfQuestion(question, kept))) continue
    out.push(question)
  }
  return out.slice(0, count)
}

function followUpSchema(asked: number) {
  return {
    name: 'follow_up_questions',
    description: 'Questions the retrieved passages answer that the answer given did not cover.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          // No minItems/maxItems: the API rejects array bounds above 1
          // ("minItems values other than 0 or 1 are not supported"), so the
          // count is asked for in the description and enforced on the way out.
          description: `Exactly ${asked} follow-up questions, each with the sentence from the ` +
            'retrieved passages that answers it. Vary them: a detail the answer skated over, a ' +
            'figure or term it used without explaining, a related finding in the passages it ' +
            'never reached. Australian English.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: {
                type: 'string',
                description:
                  'A question the reader would naturally ask NEXT, and that the passages above ' +
                  'ANSWER. Under 12 words, phrased the way a person would type it, no numbering. ' +
                  'It must NOT be the question already asked or a rewording of it, and must not ' +
                  'ask for something the answer above already states in full - go to what the ' +
                  'answer left open. Name the specific programs, species, fisheries, figures or ' +
                  'frameworks the passages discuss, so it could not be asked of any other ' +
                  'corpus. NEVER ask about the documents as objects rather than their content - ' +
                  'not who wrote, funded or published them, not when, not what kind of document ' +
                  'they are.',
              },
              evidence: {
                type: 'string',
                description:
                  'The sentence from the RETRIEVED PASSAGES above that ANSWERS the question, ' +
                  'copied EXACTLY, character for character. This is the test the question has ' +
                  'to pass: if the passages mention a topic but never state the answer, the ' +
                  'question cannot be asked, because the corpus would refuse it. If you cannot ' +
                  'copy out a sentence that answers the question, return an empty string and ' +
                  'the question will be discarded.',
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

/**
 * Generate follow-ups for one answered question. Returns [] rather than
 * throwing: follow-ups are a nicety that arrives after the answer, and the page
 * renders nothing at all when there are none.
 */
export async function generateFollowUpQuestions(
  management: AragProvider,
  config: TenantConfig,
  input: FollowUpInput,
): Promise<string[]> {
  const context = passageContext(input.passages)
  if (context.length < MIN_CONTEXT) return []

  // Ask for more than the page will show. Every follow-up has to prove it is
  // grounded and not an echo, and some will fail; asking for exactly three
  // means two failures leave the reader with a single lonely chip.
  const asked = WANT * 2
  const prompt = [
    `Write ${asked} follow-up questions for a reader who has just been given the answer below.`,
    'Use only the retrieved passages; do not draw on outside knowledge.',
    '',
    `QUESTION ALREADY ASKED: ${clip(input.question, 500)}`,
    '',
    'ANSWER ALREADY GIVEN (do not ask for anything it already states):',
    clip(input.answer, ANSWER_BUDGET),
    '',
    '--- RETRIEVED PASSAGES (the only source a follow-up may draw on) ---',
    context,
    '--- END RETRIEVED PASSAGES ---',
  ].join('\n')

  try {
    const result = await management.askStructured(config, followUpSchema(asked), prompt, {
      model: FAST_MODEL,
    })
    const object = result.object as { questions?: unknown } | null
    return selectFollowUps(object?.questions, context, input.question)
  } catch {
    return []
  }
}
