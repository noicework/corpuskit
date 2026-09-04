/**
 * Currency / staleness guard for grounded AI answers.
 *
 * THE PROBLEM this solves: the research corpora are largely historical (an
 * archive can reach back to the 1970s). An answer can confidently state a fact that
 * WAS true when its sources were written but is no longer current - and to a
 * research scientist one confidently-stale answer is disqualifying. So every
 * grounded answer carries an honest, calibrated recency signal derived purely
 * from the years of the sources it actually rests on:
 *
 *  1. a quiet, always-shown recency line (the date span of the cited sources); and
 *  2. a single honest caveat, shown ONLY when the newest cited source is older
 *     than `CURRENCY_CAVEAT_MAX_AGE_YEARS`.
 *
 * This is deliberately a pure function over the sources the retrieval provider
 * already returns - no new coupling to any LLM or vector store. The caller
 * decides which sources count (the ones actually cited / grounded on) and passes
 * them in.
 *
 * YEAR SOURCE: a source's real publication metadata (`published`) is preferred,
 * but on real archives that field is usually empty - the year instead
 * lives in the project code (`sourceName`, e.g. "1975-022-DLD.pdf") and the
 * merchandised `title` ("Project 1975-022"). So the guard falls back
 * published -> project code -> title, and reads whichever first yields a
 * plausible year. Without this fallback the recency signal never fires on the
 * real corpus (verified on a live production corpus).
 */

/**
 * How old (in years) the newest cited source may be before the answer carries a
 * currency caveat. Named so it can be tuned in one place. Eight years is the
 * starting point: long enough not to nag on merely-recent research, short enough
 * to flag an answer whose freshest source predates a scientist's "current" view
 * of a fast-moving field.
 */
export const CURRENCY_CAVEAT_MAX_AGE_YEARS = 8

/**
 * The fields this guard reads to date a source, in order of preference:
 * `published` (real metadata), else the project code in `sourceName`, else the
 * merchandised `title`. All optional - a source that yields none is simply
 * excluded from the span.
 */
export interface CurrencySource {
  /** ISO date the source was published (e.g. "1998" or "1998-06-01"), when known. */
  published?: string
  /**
   * The raw source name / project code (e.g. "1975-022-DLD.pdf"), whose leading
   * digits encode the year on real archives. Fallback when `published`
   * is absent.
   */
  sourceName?: string
  /** The merchandised title (e.g. "Project 1975-022"); last-resort year source. */
  title?: string
}

export interface CurrencySpan {
  /** Oldest cited-source year. */
  earliest: number
  /** Newest cited-source year. */
  latest: number
}

export interface CurrencySignal {
  /**
   * The year span of the cited sources that carry a year. Absent when NOT ONE
   * cited source has a usable year - in which case the guard shows nothing
   * rather than guessing.
   */
  span?: CurrencySpan
  /** The newest cited-source year, or undefined when none carry a year. */
  mostRecentYear?: number
  /** How many cited sources contributed a usable year. */
  datedCount: number
  /**
   * The quiet, always-shown recency line, e.g. "Cited sources: 1971-1998" or,
   * when a single year is present, "Most recent cited source: 1998". Says
   * "cited" because the evidence disclosure above it reports a year span over
   * every RETRIEVED source - two unlabelled ranges that disagree read as a
   * contradiction. Absent when no cited
   * source carries a year.
   */
  recencyLabel?: string
  /** True only when the newest cited source is older than the caveat threshold. */
  showCaveat: boolean
  /**
   * The one honest caveat line, present only when `showCaveat` is true. Calibrated
   * and specific to this answer's newest source - not boilerplate.
   */
  caveatText?: string
}

/**
 * Extracts a four-digit publication year (1800-2099) from an ISO-ish date string.
 * Handles a bare year ("1998"), a full ISO date ("1998-06-01") and a year sitting
 * inside other text. Returns undefined when no plausible year is present, so a
 * source with no or unparseable date is simply excluded from the span.
 */
export function yearOf(published: string | undefined): number | undefined {
  if (!published) return undefined
  const match = /(?:^|\D)(1[89]\d{2}|20\d{2})(?:\D|$)/.exec(published)
  return match ? Number(match[1]) : undefined
}

/**
 * The best available year for a source: its `published` date, else the year in
 * its project code (`sourceName`), else the year in its `title`. Returns
 * undefined when none yields a plausible year.
 */
export function sourceYear(source: CurrencySource): number | undefined {
  return yearOf(source.published) ?? yearOf(source.sourceName) ?? yearOf(source.title)
}

/** The recency line copy for a computed span (single year vs a range). */
function recencyLabelFor(span: CurrencySpan): string {
  return span.earliest === span.latest
    ? `Most recent cited source: ${span.latest}`
    : `Cited sources: ${span.earliest}-${span.latest}`
}

/**
 * Assesses the currency of an answer from the sources it is grounded on.
 *
 * Reads only each source's published year. Sources with no usable year are
 * excluded from the span (they cannot make the answer look fresher OR staler).
 * When NO source carries a year, the result is silent (`recencyLabel`, `span`
 * and `mostRecentYear` all absent, `showCaveat` false) so nothing is shown.
 *
 * The caveat fires when the newest dated source is STRICTLY older than
 * `CURRENCY_CAVEAT_MAX_AGE_YEARS` - so an eight-year-old source (at the default
 * threshold) does not trip it, a nine-year-old one does.
 *
 * `now` (the current year) is a parameter so the boundary is deterministically
 * testable; it defaults to the real current year.
 */
export function assessCurrency(
  sources: readonly CurrencySource[],
  now: number = new Date().getFullYear(),
): CurrencySignal {
  const years: number[] = []
  for (const source of sources) {
    const year = sourceYear(source)
    // Ignore a "year" in the future - it is a spurious number (e.g. a target
    // year in a title), not a publication date, and would falsely freshen the span.
    if (year !== undefined && year <= now) years.push(year)
  }

  if (years.length === 0) {
    return { datedCount: 0, showCaveat: false }
  }

  const span: CurrencySpan = { earliest: Math.min(...years), latest: Math.max(...years) }
  const mostRecentYear = span.latest
  const showCaveat = now - mostRecentYear > CURRENCY_CAVEAT_MAX_AGE_YEARS

  return {
    span,
    mostRecentYear,
    datedCount: years.length,
    recencyLabel: recencyLabelFor(span),
    showCaveat,
    ...(showCaveat
      ? {
        caveatText:
          `This answer draws on sources up to ${mostRecentYear} and may not reflect developments since.`,
      }
      : {}),
  }
}
