import type { Locale } from './portal-locale.tsx'

/** Translate only the extraction service's finite application templates, preserving method names. */
export function extractionReason(reason: string, ui: Locale['ui']): string {
  const kind = '(prose|table-dense|image-only|garbled-text|long-scan)'
  const score = '(unscored|[0-9.]+ / 5)'
  const value = (text: string) => text === 'unscored' ? ui('unscored') : text
  let match = new RegExp(
    `^${kind} document, but no (default|tables|visual) method ran - (.+) scored best \\(${score}\\)\\.$`,
  ).exec(reason)
  if (match) {
    return ui('{class} document, but no {kind} method ran - {method} scored best ({score}).', {
      class: ui(match[1]!),
      kind: ui(match[2]!),
      method: match[3]!,
      score: value(match[4]!),
    })
  }
  match = new RegExp(
    `^${kind} document: (.+) is the method that class calls for and the judge agreed \\(${score}(?:, (\\d+) table rows recovered)?\\)\\.$`,
  ).exec(reason)
  if (match) {
    return ui(
      match[4] === undefined
        ? '{class} document: {method} is the method that class calls for and the judge agreed ({score}).'
        : '{class} document: {method} is the method that class calls for and the judge agreed ({score}, {rows} table rows recovered).',
      {
        class: ui(match[1]!),
        method: match[2]!,
        score: value(match[3]!),
        ...(match[4] === undefined ? {} : { rows: match[4] }),
      },
    )
  }
  match = new RegExp(
    `^${kind} document: (.+) is the method that class calls for(?: \\((\\d+) table rows recovered\\))?, and the judge's ${score} is within ([0-9.]+) points of (.+)'s ${score}\\.$`,
  ).exec(reason)
  if (match) {
    return ui(
      match[3] === undefined
        ? "{class} document: {method} is the method that class calls for, and the judge's {score} is within {margin} points of {best}'s {bestScore}."
        : "{class} document: {method} is the method that class calls for ({rows} table rows recovered), and the judge's {score} is within {margin} points of {best}'s {bestScore}.",
      {
        class: ui(match[1]!),
        method: match[2]!,
        ...(match[3] === undefined ? {} : { rows: match[3] }),
        score: value(match[4]!),
        margin: match[5]!,
        best: match[6]!,
        bestScore: value(match[7]!),
      },
    )
  }
  match = new RegExp(
    `^${kind} document would normally take (.+), but the judge scored it ${score} against (.+)'s ${score} - a clear loss, so (.+) is recommended\\.$`,
  ).exec(reason)
  if (match) {
    return ui(
      "{class} document would normally take {method}, but the judge scored it {score} against {best}'s {bestScore} - a clear loss, so {recommended} is recommended.",
      {
        class: ui(match[1]!),
        method: match[2]!,
        score: value(match[3]!),
        best: match[4]!,
        bestScore: value(match[5]!),
        recommended: match[6]!,
      },
    )
  }
  return reason === 'No method finished, so there is nothing to recommend.' ? ui(reason) : reason
}
