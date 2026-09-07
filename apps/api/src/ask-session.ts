/**
 * What a follow-up turn carries forward from the session (D4-06, D4-07,
 * D3-06). The earlier turns' cited papers are pinned into the follow-up's
 * retrieval, their cited passages ride beside retrieval as context, and a
 * turn that only asks for the earlier answers in another shape ("put the
 * three drugs in a table", "summarise the above") is answered from those
 * papers and passages alone, with no new topic searched. Deterministic; no
 * model in the loop.
 */

export interface ContextTurn {
  author: 'USER' | 'AGENT'
  text: string
  /** The resources the answer cited (AGENT turns). */
  resourceIds?: string[]
  /** The passages those citations quoted, in citation order (AGENT turns). */
  passages?: string[]
}

/** How many prior papers a follow-up pins and re-reads. */
export const MAX_PRIOR_IDS = 6
/** How many prior passages ride beside retrieval, and how long each may be. */
export const MAX_PRIOR_PASSAGES = 8
const MAX_PASSAGE_CHARS = 700
/** How much of each earlier answer a reformatting turn is given. */
const MAX_ANSWER_CHARS = 2000

/** The resources the session's earlier answers cited, most recent first, deduplicated. */
export function priorResourceIds(context: readonly ContextTurn[]): string[] {
  const out: string[] = []
  for (const turn of [...context].reverse()) {
    for (const id of turn.resourceIds ?? []) if (!out.includes(id)) out.push(id)
  }
  return out.slice(0, MAX_PRIOR_IDS)
}

/** The questions the session asked before this one, most recent first. */
export function priorQuestions(context: readonly ContextTurn[], limit = 3): string[] {
  return context
    .filter((t) => t.author === 'USER' && t.text.trim().length > 0)
    .map((t) => t.text.trim())
    .reverse()
    .slice(0, limit)
}

/**
 * The earlier answers' cited passages as context blocks for the platform:
 * what the follow-up may quote without retrieval finding it again. Each is
 * labelled as an earlier turn's passage so the generator does not read it
 * as this question's retrieval.
 */
export function priorPassageContext(context: readonly ContextTurn[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const turn of [...context].reverse()) {
    for (const passage of turn.passages ?? []) {
      const text = passage.replace(/\s+/g, ' ').trim().slice(0, MAX_PASSAGE_CHARS)
      if (text.length < 40 || seen.has(text)) continue
      seen.add(text)
      out.push(`Passage cited by an earlier answer in this conversation: ${text}`)
      if (out.length >= MAX_PRIOR_PASSAGES) return out
    }
  }
  return out
}

/**
 * The earlier answers themselves, as the material a reformatting turn
 * reshapes: markers and audit notes stripped, each capped.
 */
export function priorAnswerContext(context: readonly ContextTurn[]): string[] {
  const out: string[] = []
  const turns = context.filter((t) => t.author === 'AGENT' && t.text.trim().length > 0)
  for (const turn of turns.slice(-3)) {
    const question = context[context.indexOf(turn) - 1]
    const text = turn.text
      .split('\n')
      .filter((line) => !/^\s*\*[^*]+\*\s*$/.test(line))
      .join('\n')
      .replace(/\s*\[\d{1,3}\]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_ANSWER_CHARS)
    if (!text) continue
    const lead = question?.author === 'USER' ? `Earlier question: ${question.text.trim()}\n` : ''
    out.push(`${lead}Earlier answer in this conversation: ${text}`)
  }
  return out
}

/**
 * A follow-up that asks for the earlier answers in another shape and
 * nothing new: a table, bullets, a summary of the above. Short, names a
 * shape or a summary, and refers back ("the three drugs", "the above",
 * "these", "so far") rather than introducing a question of its own.
 */
export function isReformatFollowUp(query: string): boolean {
  const q = query.trim()
  if (q.split(/\s+/).length > 24) return false
  const shape =
    /\b(?:table|tabulate|tabular|bullet|bullets|bullet points|dot points|list|summari[sz]e|summary|recap|one[- ]liner|shorter|condense|reformat|as prose|in prose)\b/i
      .test(q)
  if (!shape) return false
  const refersBack =
    /\b(?:the above|above|the previous|previous|earlier|prior|so far|these|those|that|the three|the two|the four|both|all (?:three|of them|of the)|the (?:three|two|four) (?:drugs|studies|papers|trials|cohorts|figures|answers)|what you (?:said|found|gave)|your (?:answers?|findings)|the (?:answers?|findings|results) (?:above|so far))\b/i
      .test(q)
  const opensWithVerb =
    /^(?:put|present|show|give|make|turn|convert|lay|format|reformat|summari[sz]e|tabulate|list|condense|recap)\b/i
      .test(q)
  const newQuestion = /\b(?:what|which|how|why|when|where|who|does|did|is|was|were|are)\b/i.test(q)
  return (refersBack || opensWithVerb) && (!newQuestion || refersBack)
}

/** The instruction a reformatting turn adds: reshape, never add. */
export function reformatAddendum(query: string): string {
  const shape = /\btable\b|tabul/i.test(query)
    ? 'a Markdown table with a header row and one row per item, every cell filled from the earlier answers or their passages ("not reported" where a figure was not given)'
    : /\bbullet|dot points?|\blist\b/i.test(query)
    ? 'a bulleted list'
    : 'the shape asked for'
  return 'This turn asks for the earlier answers in this conversation in another shape, not for new ' +
    `research. Reproduce the figures, denominators, study names and designs exactly as the earlier answers ` +
    `and their cited passages state them, as ${shape}, and add nothing that they do not state. ` +
    'Every row or item carries a bracketed marker for its source. Write the Markdown directly, never ' +
    "inside a code fence. Where a study has no acronym, name it by the cited paper's title, never " +
    '"not named". Do not decline: the material is in the earlier answers and passages supplied.'
}

/**
 * The generation budget a reformatting turn needs: a table row or a list
 * item per earlier answer, with room for the cells (D5-05). The loop 4
 * budget of 1800 tokens was fixed whatever the session held; a five-turn
 * session's table needs more, a two-turn one less. Capped at the platform's
 * own ceiling.
 */
export function reformatBudget(context: readonly ContextTurn[]): number {
  const answers = context.filter((t) => t.author === 'AGENT' && t.text.trim().length > 0).length
  return Math.min(4096, Math.max(1800, 900 + 450 * answers))
}

/**
 * Whether a follow-up stays inside the earlier turns' papers: it refers
 * back and names no entity the session has not already discussed. "What
 * was the strongest predictor in that study" (D5-06) and "back to the JME
 * cohort: what proportion had a psychiatric comorbidity" are about the
 * papers the session cited, so retrieval is scoped to them with the
 * platform's resource filter and nothing else can crowd them out; "now add
 * lacosamide" names a new drug and is not. The lexicon terms and acronyms
 * of the follow-up are compared with those of the earlier questions and
 * answers.
 */
export function staysWithinPriorTurns(
  query: string,
  context: readonly ContextTurn[],
  lexicon: readonly string[] = [],
): boolean {
  if (context.length === 0 || isReformatFollowUp(query)) return false
  if (!refersToPriorTurns(query) && !RESUMES_PRIOR.test(query)) return false
  const earlier = context.map((t) => t.text).join('\n').toLowerCase()
  for (const term of entityTerms(query, lexicon)) {
    if (!earlier.includes(term)) return false
  }
  return true
}

/** "Back to the JME cohort", "returning to that study", "in the same paper". */
const RESUMES_PRIOR = /\b(?:back to|returning to|return to|going back to)\b/i

/** Acronyms (JME, LGI1, PERMIT) and lexicon terms a follow-up names, lower-cased. */
function entityTerms(query: string, lexicon: readonly string[]): string[] {
  const out = new Set<string>()
  const lower = query.toLowerCase()
  for (const term of lexicon) {
    const t = term.toLowerCase()
    if (
      t.length >= 4 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)
    ) {
      out.add(t)
    }
  }
  for (const m of query.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)) {
    if (!/^(?:CI|HR|OR|RR|SMR|IQR|AUC|SD)$/.test(m[0])) out.add(m[0].toLowerCase())
  }
  return [...out]
}

/**
 * Whether a follow-up leans on the earlier turns ("that cohort", "the
 * same study", "how does it compare") rather than opening a new topic. A
 * follow-up that names a new entity of its own ("now add lacosamide")
 * keeps the chat context but is not pinned to the earlier papers, whose
 * paragraphs otherwise crowd out the paper it asks about (baseline TDB).
 */
export function refersToPriorTurns(query: string): boolean {
  return /\b(?:that|those|these|this|it|its|the same|same|above|earlier|previous|prior|both|either|compare|comparison|compared|versus|vs|again|also|too|the cohort|the study|the trial|the paper|each group|in each|back to)\b/i
    .test(query)
}
