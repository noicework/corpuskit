/** A marker run closes the text since the preceding run, or the start of its sentence. */
export interface MarkedClause {
  text: string
  markers: number[]
  /** An inline comma/semicolon stays beside the preceding marker when rendered. */
  joinBefore?: string
}

export function markedClauses(sentence: string): MarkedClause[] {
  const runs = [...sentence.matchAll(/(?:\s*\[\d{1,3}\])+/g)]
  // Table rows are audited by cell under their headings; a closing pipe is not another claim.
  if (/^\s*\|/.test(sentence)) {
    return [{
      text: sentence.replace(/\s*\[\d{1,3}\]/g, '').trim(),
      markers: runs.flatMap((run) => [...run[0].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))),
    }]
  }
  const clauses: MarkedClause[] = []
  let start = 0
  const append = (text: string, markers: number[]) => {
    const plain = text.trim()
    clauses.push({
      text: plain,
      markers,
      ...(clauses.length > 0 ? { joinBefore: /^[,;:)]/.test(plain) ? '' : ' ' } : {}),
    })
  }
  for (const run of runs) {
    append(
      sentence.slice(start, run.index),
      [...run[0].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    )
    start = run.index + run[0].length
  }
  const tail = sentence.slice(start).trim()
  if (clauses.length > 0 && /^[.!?"'”’)]+$/.test(tail)) clauses.at(-1)!.text += tail
  else if (tail || clauses.length === 0) append(tail, [])
  return clauses
}
