/**
 * Exact catalogue lookups: identifiers and author names.
 *
 * Resolves a DOI, PMCID, PMID or author surname against catalogue metadata
 * before any retrieval runs, so an identifier or author question gets the
 * one matching resource (or an honest no-match) instead of retrieval's best
 * guess. Used by `/search` and `/route` in `app.ts`.
 * Serves: R7 (P2-11, P4-07, P9-09, P6-16, P6-17, P7-12, P8-13, P8-19,
 * P10-14, P10-23, P9-10, P3-18, P1-12), D3-04, D4-16; PR #3, #7, #16.
 */
import type { ResourceSummary, ScoredResource, SearchLookup } from '@research-portal/core'
import type { IdentifierKind } from './intent-router.ts'

// ---------------------------------------------------------------------------
// Exact lookups against catalogue metadata, run BEFORE any retrieval. A DOI,
// PMCID or PMID names one document: the answer is that resource or an honest
// "no resource carries this identifier", never five unrelated papers whose
// reference lists share a DOI prefix. An author surname is the same shape of
// question - the catalogue's `authors` field is the index the platform does
// not have.
// ---------------------------------------------------------------------------

function normaliseDoi(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(
    /^doi:\s*/,
    '',
  ).replace(/[.,;)]+$/, '')
}

function foldApostrophes(value: string): string {
  return value.replace(/[’‘`]/g, "'")
}

/**
 * The comparison key for a name: diacritics and apostrophes removed, lower
 * case, so "O'Neill", "O’Neill" and "ONeill" are one person (D3-04).
 */
function nameKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`']/g, '')
    .toLowerCase()
}

/** One to three initials, with or without stops: "W", "WJ", "W.", "W.J.". */
function isInitials(token: string): boolean {
  return /^(?:[A-Z]\.?){1,3}$/.test(token)
}

/**
 * A query that is a person's name: "Wilma O'Neill", "W O'Neill", "W. J.
 * O'Neill", "O'Neill WJ", "Wilma J O'Neill". Two or three tokens, every
 * one a capitalised word or initials; the surname is the word beside the
 * initials, or the last word. Null for anything else - a two-word topic is
 * not a name, and a lower-case pair never reads as one.
 */
export function parsePersonQuery(
  query: string,
): { surname: string; initial?: string; display: string } | null {
  const tokens = query.trim().split(/\s+/)
  if (tokens.length < 2 || tokens.length > 3) return null
  if (!tokens.every((t) => /^[A-Z][A-Za-z'’.-]*$/.test(t))) return null
  const first = tokens[0]!
  const last = tokens[tokens.length - 1]!
  const words = tokens.filter((t) => !isInitials(t))
  const initials = tokens.filter((t) => isInitials(t))
  if (words.length === 0) return null
  let surname: string
  let initial: string | undefined
  if (isInitials(last) && !isInitials(first)) {
    // "O'Neill WJ"
    surname = words.join(' ')
    initial = last[0]!.toLowerCase()
  } else if (isInitials(first)) {
    // "W O'Neill", "W. J. O'Neill"
    surname = words[words.length - 1]!
    initial = first[0]!.toLowerCase()
  } else if (initials.length === 0) {
    // "Wilma O'Neill", "Wilma John O'Neill"
    surname = last
    initial = first[0]!.toLowerCase()
  } else {
    // "Wilma J O'Neill"
    surname = last
    initial = first[0]!.toLowerCase()
  }
  if (nameKey(surname).length < 3 || /[.]/.test(surname)) return null
  return { surname, initial, display: query.trim() }
}

function pmcidOf(resource: ResourceSummary): string | undefined {
  if (resource.pmcid) return resource.pmcid.toUpperCase()
  const fromUrl = /\/(PMC\d{4,9})\/?$/i.exec(resource.originUrl ?? '')?.[1]
  return fromUrl?.toUpperCase()
}

/** Supplements and media files share their article's identifiers; the article comes first. */
function isAttachment(resource: ResourceSummary): boolean {
  return /^(?:supplementary|supplement\b|supplemental|peer review|video|movie|media|additional file|appendix)/i
    .test(resource.title) || resource.type === 'video'
}

/** Articles before their attachments, newest first, then by title - a total order. */
export function articleFirst(resources: readonly ResourceSummary[]): ResourceSummary[] {
  return [...resources].sort((a, b) =>
    Number(isAttachment(a)) - Number(isAttachment(b)) ||
    (b.year ?? b.published ?? '').localeCompare(a.year ?? a.published ?? '') ||
    a.title.localeCompare(b.title)
  )
}

/**
 * The resources an identifier names, the article first and its supplements
 * after it (they share the article's PMC id and DOI); empty when the
 * catalogue holds nothing with it.
 */
export function resolveIdentifier(
  resources: readonly ResourceSummary[],
  identifier: { kind: IdentifierKind; value: string },
): ResourceSummary[] {
  const wanted = identifier.kind === 'doi'
    ? normaliseDoi(identifier.value)
    : identifier.value.toUpperCase()
  const matches = resources.filter((resource) => {
    const have = identifier.kind === 'doi'
      ? resource.doi ? normaliseDoi(resource.doi) : undefined
      : identifier.kind === 'pmcid'
      ? pmcidOf(resource)
      : resource.pmid?.trim()
    return have !== undefined && have === wanted
  })
  return articleFirst(matches)
}

/** Surname from an "Surname AB" / "Surname, A. B." / "A. B. Surname" author string. */
function surnameOf(author: string): string {
  const cleaned = foldApostrophes(author).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const parts = cleaned.split(' ')
  // "Vajda FJE" - the initials are the all-caps short tail.
  const first = parts[0] ?? ''
  const last = parts[parts.length - 1] ?? ''
  if (parts.length > 1 && /^[A-Z]{1,3}$/.test(last)) return parts.slice(0, -1).join(' ')
  if (parts.length > 1 && /^[A-Z]{1,3}$/.test(first)) return parts.slice(1).join(' ')
  return last
}

/**
 * Resources whose author list carries this surname, when the query is a bare
 * surname (one word, letters only, four or more characters, not a lexicon
 * term or a gene). Returns null when the query is not an author-shaped
 * lookup, an empty list when it is but nobody in the catalogue matches.
 */
export function resolveAuthor(
  resources: readonly ResourceSummary[],
  query: string,
): { surname: string; year?: string; matches: ResourceSummary[] } | null {
  const q = query.trim()
  // A bare surname, or a citation-shaped "Surname YYYY ..." (the rest of the
  // query is the topic and does not narrow the author match).
  const m = /^([A-Za-z][A-Za-z'’-]{3,})(?:\s+((?:19|20)\d\d)\b.*)?$/.exec(q)
  if (!m?.[1]) return null
  const surname = m[1]
  const year = m[2]
  const wanted = nameKey(surname)
  const matches = resources.filter((r) =>
    (r.authors ?? []).some((a) => nameKey(surnameOf(a)) === wanted) &&
    (!year || r.year === year || (r.published ?? '').startsWith(year))
  )
  if (matches.length === 0) return null
  return { surname, ...(year ? { year } : {}), matches: articleFirst(matches) }
}

/**
 * A person's name as a query ("Wilma O'Neill", "W O'Neill", "ONeill WJ"):
 * the papers of the catalogue author with that surname and a compatible
 * first initial. Null when the query is not name-shaped or nobody in the
 * catalogue has the surname; an EMPTY match list when the surname is an
 * author's but the initial is not - a person's name the collection does
 * not hold, which the surface lists honestly and never answers (D3-04).
 */
export function resolvePersonName(
  resources: readonly ResourceSummary[],
  query: string,
): { surname: string; matches: ResourceSummary[] } | null {
  const person = parsePersonQuery(query)
  if (!person) return null
  const wanted = nameKey(person.surname)
  const bySurname = resources.filter((r) =>
    (r.authors ?? []).some((a) => personKey(a)?.surname === wanted)
  )
  if (bySurname.length === 0) return null
  const matches = bySurname.filter((r) =>
    (r.authors ?? []).some((a) => {
      const have = personKey(a)
      return have?.surname === wanted &&
        (!have.initial || !person.initial || have.initial === person.initial)
    })
  )
  return { surname: person.display, matches: articleFirst(matches) }
}

/** Shape a metadata match as a search result, with the record as its passage. */
export function metadataHit(resource: ResourceSummary, passage: string): ScoredResource {
  return {
    ...resource,
    relevance: 1,
    citedCount: 0,
    matchedPassage: passage,
    matchedField: 'metadata',
  }
}

/** Author line for a resource, for the metadata passage. */
export function authorLine(resource: ResourceSummary): string {
  const authors = resource.authors ?? []
  const shown = authors.slice(0, 6).join(', ') + (authors.length > 6 ? ' et al.' : '')
  const tail = [resource.journal, resource.year].filter(Boolean).join(', ')
  return tail ? `${shown} - ${tail}` : shown
}

export function lookupOf(
  kind: SearchLookup['kind'],
  value: string,
  matched: boolean,
): SearchLookup {
  return { kind, value, matched }
}

// ---------------------------------------------------------------------------
// Researchers. The knowledge-graph agent types a person by the sentence it
// found them in ("Wilma O'Neill" came out as a Research Study), but the
// catalogue's author lists are the portal's own record of who its
// researchers are. A graph node whose name matches an author - same surname,
// compatible first initial - is retyped to the tenant's researcher entity
// type, on the map and on the entity page alike.
// ---------------------------------------------------------------------------

/** Surname plus first initial for a person's name as an entity ("Wilma J O'Neill") or an author record ("O'Neill WJ"). */
function personKey(name: string): { surname: string; initial?: string } | null {
  const cleaned = foldApostrophes(name).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = cleaned.split(' ').filter(Boolean)
  if (parts.length === 0 || parts.length > 5) return null
  const first = parts[0]!
  const last = parts[parts.length - 1]!
  // "O'Neill WJ": the all-caps tail is the initials.
  if (parts.length > 1 && /^[A-Z]{1,3}$/.test(last)) {
    return { surname: nameKey(parts.slice(0, -1).join(' ')), initial: last[0]!.toLowerCase() }
  }
  // "WJ O'Neill" / "W. O'Neill".
  if (parts.length > 1 && /^[A-Z]{1,3}$/.test(first)) {
    return { surname: nameKey(parts.slice(1).join(' ')), initial: first[0]!.toLowerCase() }
  }
  if (parts.length === 1) return { surname: nameKey(last) }
  // "Wilma O'Neill" / "Wilma John O'Neill" - every token a capitalised word.
  if (!parts.every((p) => /^[A-Z][A-Za-z'-]*$/.test(p))) return null
  return { surname: nameKey(last), initial: first[0]!.toLowerCase() }
}

/** Whether an entity name names someone on the catalogue's author lists. */
export function isCatalogueAuthor(resources: readonly ResourceSummary[], name: string): boolean {
  const wanted = personKey(name)
  if (!wanted || wanted.surname.length < 3) return false
  for (const resource of resources) {
    for (const author of resource.authors ?? []) {
      const have = personKey(author)
      if (!have || have.surname !== wanted.surname) continue
      if (!wanted.initial || !have.initial || wanted.initial === have.initial) return true
    }
  }
  return false
}

/** The tenant's researcher entity type label, or a plain "Researcher". */
export function researcherLabel(
  entityTypes: readonly { id: string; label: string }[],
): string {
  return entityTypes.find((t) => /^(researcher|person|author|people)$/i.test(t.id))?.label ??
    entityTypes.find((t) => /researcher|person|author/i.test(t.label))?.label ??
    'Researcher'
}

/** Graph nodes with every catalogue author retyped to the researcher group. */
export function retypeResearchers<T extends { id: string; group: string }>(
  nodes: readonly T[],
  resources: readonly ResourceSummary[],
  label: string,
): T[] {
  return nodes.map((node) =>
    node.group !== label && isCatalogueAuthor(resources, node.id) ? { ...node, group: label } : node
  )
}
