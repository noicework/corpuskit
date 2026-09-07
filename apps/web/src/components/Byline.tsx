/**
 * "Karoly PJ, Freestone DR, Eden D et al. · Frontiers in Neurology · 2021"
 * - the line a clinician or researcher triages by. Built only from stored
 * bibliographic metadata; a resource without one shows nothing here.
 */
export function bylineFor(
  resource: { authors?: string[]; journal?: string; year?: string; published?: string },
): string[] | null {
  const parts: string[] = []
  const authors = resource.authors ?? []
  if (authors.length > 0) {
    const shown = authors.slice(0, 3).join(', ')
    parts.push(authors.length > 3 ? `${shown} et al.` : shown)
  }
  if (resource.journal) parts.push(resource.journal)
  const year = resource.year || (resource.published ? resource.published.slice(0, 4) : '')
  if (year) parts.push(year)
  return parts.length > 0 ? parts : null
}

export function Byline(
  { parts, doi, className = '' }: { parts: string[]; doi?: string; className?: string },
) {
  return (
    <p
      className={`mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-ink-3 ${className}`}
    >
      {parts.map((part, i) => (
        <span key={i} className='min-w-0'>
          {i > 0 ? <span aria-hidden='true' className='mr-1.5'>·</span> : null}
          <span className={i === 0 ? 'text-ink-2' : ''}>{part}</span>
        </span>
      ))}
      {doi
        ? (
          <a
            href={`https://doi.org/${doi}`}
            target='_blank'
            rel='noopener noreferrer'
            className='rp-focus -my-1 min-w-0 truncate rounded-[var(--rp-radius-btn)] py-1 underline decoration-dotted underline-offset-2'
            style={{ color: 'var(--rp-accent-fg)' }}
            onClick={(event) => event.stopPropagation()}
          >
            doi:{doi}
          </a>
        )
        : null}
    </p>
  )
}
