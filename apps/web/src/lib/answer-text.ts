/**
 * Normalisation for streamed answer text before markdown parsing.
 *
 * The model is asked for markdown but sometimes runs a whole bulleted
 * section onto one line - `**5. Tier Systems** * The SESSF uses ... * Tier 3
 * and 4 use ...` - which a line-based parser can only read as a paragraph
 * with literal asterisks. A lone ` * ` surrounded by spaces is never
 * legitimate prose in this corpus, so when one follows a sentence-ish
 * boundary (closing punctuation, a citation marker's `]`, or a closing
 * `**`), it is moved onto its own line and parses as the bullet it was
 * meant to be. Emphasis (`*word*`, no surrounding spaces) and arithmetic
 * (`0.2 * 3`, preceded by a digit) never match.
 */
/**
 * The platform's default guardrail sentence, "Not enough data to answer
 * this.", occasionally leaks into an otherwise real answer as a quoted
 * aside ('Therefore, "Not enough data to answer this."'). The refusal
 * behaviour is right; the template string is not something a reader should
 * see. Drop the sentence that carries it and leave the rest untouched.
 */
export function stripRefusalTemplate(text: string): string {
  const template = /not enough data to answer this\.?/i
  if (!template.test(text)) return text
  return text
    .split('\n')
    .map((line) => {
      if (!template.test(line)) return line
      const cleaned = line
        // A sentence may close with a quote or bracket after its full stop.
        .split(/(?<=[.!?]["'\u201d\u2019)]?)\s+/)
        .filter((sentence) => !template.test(sentence))
        .join(' ')
        .trim()
      return cleaned
    })
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim()
}

export function normaliseAnswerBullets(text: string): string {
  return text.replace(/([.:;!?\]"”)*]) \* (?=\S)/g, '$1\n* ')
}
