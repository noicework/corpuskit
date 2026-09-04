/**
 * A resource that can participate in browse-result family de-duplication.
 * `priority` is optional: browse lists omit it and prefer the canonical file,
 * while search supplies relevance so a query for Part B can still surface
 * Part B instead of always redirecting discovery to the main report.
 */
export interface ResourceFamilyCandidate {
  id: string
  title?: string
  priority?: number
}

type FamilyKind = 'primary' | 'part' | 'appendix' | 'supplementary' | 'product' | 'numeric'

interface FamilyDescriptor {
  key: string
  kind: FamilyKind
  order: number
}

const FILE_EXTENSION = /\.(?:pdf|docx?|pptx?|xlsx?|odt|ods|odp|rtf|txt|html?)$/i
const PROJECT_CODE = /^((?:19|20)\d{2})[-/](\d{2,3})(.*)$/i

function ordinal(value: string | undefined): number {
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value)
  return value.toUpperCase().charCodeAt(0) - 64
}

/**
 * Identify only strong project-code filename families (the YYYY-NNN naming
 * research funders use for final reports). A title must begin with a
 * year/project code and then either be the primary report or carry one of
 * the variant markers observed on a real archive. Ordinary prose containing "part",
 * "supplementary" or "product" is deliberately ineligible.
 */
function describeFamily(title: string | undefined): FamilyDescriptor | undefined {
  const withoutExtension = (title ?? '').trim().replace(FILE_EXTENSION, '')
  const match = PROJECT_CODE.exec(withoutExtension)
  if (!match) return undefined

  const key = `${match[1]}-${match[2]}`.toLowerCase()
  const suffix = match[3] ?? ''
  const primary = suffix.replace(/^[-_\s]+|[-_\s]+$/g, '')
  if (
    primary === '' || /^dld$/i.test(primary) || /^(?:dld[-_\s]+)?final[-_\s]+report$/i.test(primary)
  ) {
    return { key, kind: 'primary', order: 0 }
  }

  const part = /(?:^|[^a-z0-9])part[-_\s]*([a-z]|\d+)(?:[-_\s]*of[-_\s]*\d+)?(?=$|[^a-z0-9])/i
    .exec(suffix)
  if (part) return { key, kind: 'part', order: ordinal(part[1]) }

  const appendix =
    /(?:^|[^a-z0-9])(?:app|appendix|attachment|att)[-_\s]*(\d+|[a-z])(?=$|[^a-z0-9])/i
      .exec(suffix)
  if (appendix) return { key, kind: 'appendix', order: ordinal(appendix[1]) }

  if (/(?:^|[^a-z0-9])supplement(?:ary)?(?=$|[^a-z0-9])/i.test(suffix)) {
    return { key, kind: 'supplementary', order: 0 }
  }

  const product = /(?:^|[^a-z0-9])product(?:[-_\s]*(\d+))?(?=$|[^a-z0-9])/i.exec(suffix)
  if (product) return { key, kind: 'product', order: ordinal(product[1]) }

  const numeric = /^\.(\d{2})(?=$|[^0-9])/.exec(suffix)
  if (numeric) return { key, kind: 'numeric', order: ordinal(numeric[1]) }

  return undefined
}

const KIND_RANK: Record<FamilyKind, number> = {
  primary: 0,
  part: 1,
  appendix: 2,
  supplementary: 3,
  product: 4,
  numeric: 5,
}

/**
 * Keep one card for a confidently detected document family.
 *
 * A lone marked resource is retained: without a sibling there is no duplicate
 * to remove and it may be the corpus's only copy. Families are collapsed only
 * when at least two eligible resources share the exact project code and one is
 * an explicit variant. Browse lists prefer the primary, then Part A/Part 1;
 * search lists prefer the highest-scoring member so every part remains
 * discoverable through a sufficiently specific query. Direct resource lookup
 * is never affected.
 */
export function dedupeResourceFamilies<T extends ResourceFamilyCandidate>(resources: T[]): T[] {
  const described = resources.map((resource, index) => ({
    resource,
    index,
    family: describeFamily(resource.title),
  }))
  const families = new Map<string, typeof described>()
  for (const entry of described) {
    if (!entry.family) continue
    const family = families.get(entry.family.key) ?? []
    family.push(entry)
    families.set(entry.family.key, family)
  }

  const hidden = new Set<number>()
  for (const family of families.values()) {
    if (family.length < 2 || family.every((entry) => entry.family?.kind === 'primary')) continue
    const winner = family.reduce((best, candidate) => {
      const priority = candidate.resource.priority ?? 0
      const bestPriority = best.resource.priority ?? 0
      if (priority !== bestPriority) return priority > bestPriority ? candidate : best
      const rank = KIND_RANK[candidate.family!.kind]
      const bestRank = KIND_RANK[best.family!.kind]
      if (rank !== bestRank) return rank < bestRank ? candidate : best
      if (candidate.family!.order !== best.family!.order) {
        return candidate.family!.order < best.family!.order ? candidate : best
      }
      return candidate.index < best.index ? candidate : best
    })
    for (const entry of family) {
      if (entry.index !== winner.index) hidden.add(entry.index)
    }
  }

  return resources.filter((_, index) => !hidden.has(index))
}
