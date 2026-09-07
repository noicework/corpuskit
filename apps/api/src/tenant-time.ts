/**
 * Dates a reader sees are the reader's dates.
 *
 * A synthesis produced at 09:14 on 6 September in Melbourne was titled
 * "Synthesis - 2026-09-05", because the server stamped it in UTC
 * (review loop 6 D6-13). A portal states its own
 * timezone (`timezone` on the tenant config, an IANA name), and every
 * user-facing date the API writes is formatted in it; a portal that states
 * none keeps UTC, which is what it had.
 */

/**
 * Today's date in the portal's timezone, as YYYY-MM-DD. An unknown or
 * malformed zone falls back to UTC rather than throwing - a bad
 * configuration must not take an artefact down.
 */
export function tenantToday(timezone?: string, now: Date = new Date()): string {
  if (timezone) {
    try {
      // en-CA is ISO-ordered: "2026-09-06".
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now)
    } catch {
      // An unrecognised zone: UTC, below.
    }
  }
  return now.toISOString().slice(0, 10)
}
