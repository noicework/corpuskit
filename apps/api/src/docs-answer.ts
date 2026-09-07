/**
 * The Help assistant's voice.
 *
 * The documentation-scoped ask runs on the same platform prompt machinery as
 * the research ask, so the same two sentinels leak into its answers: the
 * platform's guardrail sentence ("Not enough data to answer this.") written
 * ahead of a real answer, and the prompt's own noun for its grounding ("the
 * provided context"). A reader of the Help section never sees a context;
 * they see the documentation. `rewriteDocsSentinels` drops the template
 * sentences and names the material as the documentation, on the finished
 * text; `DocsSentinelStream` does the same on the streamed deltas, holding
 * text back to a sentence boundary so a phrase split across two chunks is
 * still seen whole. Deterministic; no model in the loop.
 */

import { TEMPLATE_SENTENCE } from './answer-shape.ts'

/** The decline the Help surface shows when nothing in the documentation answers. */
export const DOCS_DECLINE =
  'The help documentation does not cover this yet. Try rephrasing your question, or ' +
  'browse the Help sections for the feature you are after.'

/** "the provided context", "the context", "the documentation provided" and kin. */
const CONTEXT_NOUN =
  /\b(the|this|that|in the|from the|within the|per the|by the|of the)\s+(?:provided\s+|given\s+|available\s+|supplied\s+|retrieved\s+)?(?:context|(?:help )?documentation provided)\b/gi

/** Sentence-level scrub of the sentinels; a text that was nothing but them comes back empty. */
export function rewriteDocsSentinels(text: string): string {
  let out = text.replace(TEMPLATE_SENTENCE, '')
  out = out.replace(CONTEXT_NOUN, (_m, lead: string) => `${lead} documentation`)
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/**
 * Streaming form of `rewriteDocsSentinels`: text is released only up to the
 * last sentence or line boundary that leaves something pending, so the tail
 * of a growing template sentence is never shown. `flush` releases the
 * remainder at the end of the stream.
 */
export class DocsSentinelStream {
  private pending = ''

  push(chunk: string): string {
    this.pending += chunk
    let cut = -1
    const re = /[.!?:](?=["'”)]?\s)|\n/g
    let m: RegExpExecArray | null
    while ((m = re.exec(this.pending)) !== null) {
      // A sentence boundary releases its trailing space too; a newline
      // releases nothing past itself, or the next line's first letter
      // would slip out before that line is seen whole.
      const end = m.index + m[0].length + (m[0] === '\n' ? 0 : 1)
      if (end < this.pending.length) cut = end
    }
    if (cut <= 0) return ''
    const out = this.pending.slice(0, cut)
    this.pending = this.pending.slice(cut)
    return rewriteChunk(out)
  }

  flush(): string {
    const out = rewriteChunk(this.pending)
    this.pending = ''
    return out
  }
}

/** `rewriteDocsSentinels` without the trim, so streamed chunks keep their joins. */
function rewriteChunk(chunk: string): string {
  if (!chunk) return ''
  const leading = /^\s*/.exec(chunk)?.[0] ?? ''
  const trailing = /\s*$/.exec(chunk)?.[0] ?? ''
  const core = rewriteDocsSentinels(chunk)
  if (!core) return trailing.includes('\n') ? trailing : ''
  return leading + core + trailing
}

// ---------------------------------------------------------------------------
// Two-part questions (D4-17)
// ---------------------------------------------------------------------------

/**
 * The parts of a two-part Help question ("Does the portal look anything up
 * on the internet, and which AI model writes the answers?"): split at a
 * conjunction that opens a new question, at a semicolon, or at a question
 * mark. Each part is searched for on its own, so the documentation page
 * that answers one part is retrieved even when the other part's words
 * dominate the question. One part comes back as no split.
 */
export function helpQuestionParts(query: string): string[] {
  const parts = query
    .split(
      /\s*(?:[;?]|,?\s+(?:and|or|plus|also)\s+(?=(?:what|how|which|whether|when|where|why|did|does|do|is|was|were|are|can|could|should|who|will)\b))\s*/i,
    )
    .map((p) => p.trim().replace(/[?.]+$/, '').trim())
    .filter((p) => p.split(/\s+/).length >= 3)
  return parts.length >= 2 ? parts.slice(0, 3) : []
}

/** The instruction for a two-part question: answer what the documentation holds, bound the rest. */
export function helpPartsAddendum(parts: readonly string[]): string {
  return `The question has ${parts.length} parts: ${
    parts.map((p, i) => `(${i + 1}) ${p}`).join('; ')
  }. Answer each part the documentation covers, citing it. For a part the documentation ` +
    'does not describe, say so in one plain sentence and move on; never decline the whole ' +
    'question because one part is not covered.'
}

/** The boundary sentence for a part the documentation does not cover. */
export function helpBoundary(part: string): string {
  const plain = part.trim().replace(/[?.]+$/, '')
  return `The Help pages do not cover this part of the question: "${plain}".`
}

/**
 * The composed answer when the parts were asked separately: each answered
 * part's text in order, a boundary sentence for each part that was
 * declined. Empty when nothing was answered.
 */
export function composeHelpParts(
  answered: readonly { part: string; text: string | null }[],
): string {
  if (!answered.some((a) => a.text && a.text.trim())) return ''
  return answered
    .map((a) => (a.text && a.text.trim() ? a.text.trim() : helpBoundary(a.part)))
    .join('\n\n')
}
