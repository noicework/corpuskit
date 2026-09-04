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
export function normaliseAnswerBullets(text: string): string {
  return text.replace(/([.:;!?\]"”)*]) \* (?=\S)/g, '$1\n* ')
}
