// ---------------------------------------------------------------------------
// Relations-graph clean-up shared by relationsGraph() in index.ts.
//
// The knowledge-graph agent extracts the same entity under several spellings -
// "Tasmanian salmonid industry", "Tasmanian Salmonid Industry", "TASMANIAN
// SALMONID INDUSTRY" - and each spelling arrives as its own node with its own
// relations, so the map (and its Most connected list) shows one real thing
// three times. Merging is a display-side judgement, so it lives here rather
// than in the extraction: variants that differ only by letter case (and
// surrounding whitespace) are one entity.
// ---------------------------------------------------------------------------

export type RelationsNode = { id: string; group: string; weight: number }
export type RelationsEdge = { source: string; target: string; label: string }

/** Letters present and every one of them upper case - the shouty spelling. */
function isShouty(id: string): boolean {
  return id !== id.toLowerCase() && id === id.toUpperCase()
}

/**
 * Merge nodes whose ids differ only by case, re-pointing edges at the
 * canonical spelling. The canonical spelling is the variant with the most
 * weight behind it; on a tie, a mixed-case spelling beats an all-caps one,
 * and the earlier variant wins from there. Weights sum, edges are re-deduped
 * after the rename, and a relation that collapses onto itself is dropped.
 */
export function dedupeEntityCase(
  nodes: RelationsNode[],
  edges: RelationsEdge[],
): { nodes: RelationsNode[]; edges: RelationsEdge[] } {
  const variants = new Map<string, RelationsNode[]>()
  for (const node of nodes) {
    const key = node.id.trim().toLowerCase()
    const list = variants.get(key)
    if (list) list.push(node)
    else variants.set(key, [node])
  }

  const canonicalId = new Map<string, string>()
  const merged: RelationsNode[] = []
  for (const list of variants.values()) {
    let winner = list[0]
    if (!winner) continue
    for (const candidate of list.slice(1)) {
      if (candidate.weight > winner.weight) winner = candidate
      else if (
        candidate.weight === winner.weight && isShouty(winner.id) && !isShouty(candidate.id)
      ) {
        winner = candidate
      }
    }
    let weight = 0
    let group = winner.group
    for (const variant of list) {
      canonicalId.set(variant.id, winner.id)
      weight += variant.weight
      if (!group) group = variant.group
    }
    merged.push({ id: winner.id, group, weight })
  }

  const outEdges: RelationsEdge[] = []
  const seen = new Set<string>()
  for (const edge of edges) {
    const source = canonicalId.get(edge.source) ?? edge.source
    const target = canonicalId.get(edge.target) ?? edge.target
    if (source === target) continue
    const key = `${source}|${edge.label}|${target}`
    if (seen.has(key)) continue
    seen.add(key)
    outEdges.push({ source, target, label: edge.label })
  }
  return { nodes: merged, edges: outEdges }
}
