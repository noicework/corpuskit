// Progress's beta wire format uses [1] (also accept Markdown [^1]), followed
// by [1]: block-AA definitions and a separate footnote_to_context event.
// Keep answer offsets in UTF-16, just like the existing browser renderer.
import type { Citation } from '@research-portal/core'

/** Fixed, non-content diagnostics. Never attach source IDs, text or wire payloads. */
export type FootnoteFailureReason =
  | 'missing_definition'
  | 'missing_mapping'
  | 'invalid_mapping'
  | 'conflicting_mapping'
  | 'invalid_definition'
  | 'conflicting_definition'
  | 'unsupported_context'
  | 'anonymous_context'
  | 'metadata_context'
  | 'generated_context'
  | 'out_of_scope'
  | 'stream_rewrite'
  | 'unexpected_standard_citations'

/**
 * A citation the binder could not honour, and why.
 *
 * Binding runs AFTER the whole answer has streamed to the reader. Throwing
 * there destroyed a complete, correct answer over one unusable anchor: loop 9
 * measured a ~50% failure rate on grains portals whose knowledge box cites its
 * own data-augmentation fields (`generated_context`), and the reader saw the
 * finished prose followed by "The answer was cut short". A single bad anchor is
 * now dropped and counted instead, so the answer stands on the citations that
 * did verify. Every drop is reported to the caller for logging, so a corpus
 * that needs its generation configuration fixed stays visible.
 *
 * Scope is the one thing degradation never relaxes: `out_of_scope` still
 * removes the citation rather than showing it.
 */
export interface FootnoteDrop {
  reason: FootnoteFailureReason
  count: number
}

/** Collects drop reasons without carrying any content. */
export class DropLog {
  private readonly counts = new Map<FootnoteFailureReason, number>()
  add(reason: FootnoteFailureReason) {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1)
  }
  merge(drops: readonly FootnoteDrop[]) {
    for (const drop of drops) {
      this.counts.set(drop.reason, (this.counts.get(drop.reason) ?? 0) + drop.count)
    }
  }
  get list(): FootnoteDrop[] {
    return [...this.counts].map(([reason, count]) => ({ reason, count }))
  }
}

/**
 * Preserve CorpusKit's resource-level numbering contract while taking anchor
 * positions from the model's verified block references, not offset attribution.
 *
 * Every anchor is still validated. What changed is the consequence of failing:
 * the anchor is dropped and counted rather than thrown, because by this point
 * the answer has already reached the reader in full.
 *
 * A data-augmentation anchor (`da-...`) is the one case that resolves rather
 * than drops. The generated field belongs to a real resource - the id in front
 * of it - and a CorpusKit citation is resource-level by contract
 * (`{ index, resourceId, title }`), never block-level, so the reader is sent to
 * the actual document. The sentence-level grounding audit still checks that
 * claim against the document's own text and annotates it when it is not
 * carried, which is the safeguard that does the work here.
 */
export function bindFootnotes(
  parsed: ReturnType<FootnoteStream['finish']>,
  citable: (resourceId: string) => boolean,
  resolveTitle: (resourceId: string) => string,
  extraContextSources: ReadonlyMap<string, string> = new Map(),
): { text: string; citations: Citation[]; drops: FootnoteDrop[] } {
  const citations: Citation[] = []
  const byResource = new Map<string, number>()
  const inserts = new Map<number, Set<number>>()
  const dropped = new DropLog()
  dropped.merge(parsed.drops)
  for (const anchor of parsed.anchors) {
    const suppliedResource = extraContextSources.get(anchor.id)
    const match = /^([^/]+)\/(t|f|l|c)\/([^/]+)(?:\/(?:[^/]+\/)?\d+-\d+)?$/.exec(anchor.id)
    if (!match && !suppliedResource) {
      dropped.add(
        /^USER_CONTEXT_/.test(anchor.id)
          ? 'anonymous_context'
          : /^[^/]+\/a\//.test(anchor.id)
          ? 'metadata_context'
          : 'unsupported_context',
      )
      continue
    }
    // A generated field still names its own resource: cite the document, and
    // count the drop so the corpus configuration stays visible.
    if (match?.[3]?.startsWith('da-')) dropped.add('generated_context')
    const resourceId = suppliedResource ?? match![1]!
    // Scope is never relaxed. An out-of-scope resource loses its citation.
    if (!citable(resourceId)) {
      dropped.add('out_of_scope')
      continue
    }
    let index = byResource.get(resourceId)
    if (index === undefined) {
      index = citations.length + 1
      byResource.set(resourceId, index)
      citations.push({ index, resourceId, title: resolveTitle(resourceId) })
    }
    const indices = inserts.get(anchor.pos) ?? new Set<number>()
    indices.add(index)
    inserts.set(anchor.pos, indices)
  }
  let text = parsed.text
  for (const [pos, indices] of [...inserts].sort((a, b) => b[0] - a[0])) {
    const markers = [...indices].sort((a, b) => a - b).map((n) => `[${n}]`).join('')
    text = text.slice(0, pos) + markers + text.slice(pos)
  }
  return { text, citations, drops: dropped.list }
}
export interface FootnoteReference {
  number: string
  pos: number
}

// Only edit whitespace immediately surrounding authored citation anchors.
// Shift every anchor with those edits, then place it after adjacent punctuation.
// Never change source offsets, paragraph breaks or the words of the answer.
function tidyFootnotes(text: string, references: FootnoteReference[]) {
  const groups: { start: number; end: number; refs: FootnoteReference[] }[] = []
  for (const ref of references) {
    let start = ref.pos, end = ref.pos
    while (start > 0 && /[ \t]/.test(text[start - 1]!)) start--
    while (end < text.length && /[ \t]/.test(text[end]!)) end++
    const previous = groups[groups.length - 1]
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end)
      previous.refs.push(ref)
    } else groups.push({ start, end, refs: [ref] })
  }
  let out = '', cursor = 0
  const shifted: FootnoteReference[] = []
  for (const group of groups) {
    out += text.slice(cursor, group.start)
    for (const ref of group.refs) shifted.push({ ...ref, pos: out.length })
    const next = text[group.end]
    // Retain a word separator for mid-sentence citations, but not a floating
    // space before punctuation or at the end of a paragraph.
    if (group.end > group.start && next && !/[\r\n.!?,;:…\])”’"']/.test(next)) out += ' '
    cursor = group.end
  }
  out += text.slice(cursor)
  for (const ref of shifted) {
    const punctuation = /^[.!?,;:…\])”’"']+/.exec(out.slice(ref.pos))
    if (punctuation) ref.pos += punctuation[0].length
  }
  return { text: out, references: shifted }
}

export function parseFootnoteAnswer(raw: string, final = true) {
  const definitions = new Map<string, string>()
  const references: FootnoteReference[] = []
  // A definition line the binder cannot use is skipped, never emitted as
  // prose - leaking `[1]: block-AA` into the answer would be worse than
  // losing the citation. The reference that pointed at it drops in finish().
  const dropped = new DropLog()
  let text = ''
  let fence = ''
  let inline = ''
  const lines = raw.split(/(?<=\n)/)
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]!
    const complete = final || li < lines.length - 1 || line.endsWith('\n')
    const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenced) {
      if (!fence) fence = fenced[1]!
      else if (fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length) fence = ''
      text += line
      continue
    }
    if (fence) {
      text += line
      continue
    }
    // Hold a possible definition while its line is still arriving. Never leak
    // block IDs into a draft, including when every character arrives separately.
    if (!complete && (/^\s*$/.test(line) || /^\s*\[\^?\d*\]?(?::.*)?$/.test(line))) continue
    const definition = /^ {0,3}\[\^?(\d+)\]:\s*(\S+)\s*$/.exec(line)
    if (definition) {
      if (!/^block-[A-Za-z0-9_-]+$/.test(definition[2]!)) {
        dropped.add('invalid_definition')
        continue
      }
      if (definitions.has(definition[1]!) && definitions.get(definition[1]!) !== definition[2]!) {
        dropped.add('conflicting_definition')
        continue
      }
      definitions.set(definition[1]!, definition[2]!)
      continue
    }
    if (complete && /^ {0,3}\[\^?\d+\]:/.test(line)) {
      dropped.add('invalid_definition')
      continue
    }
    if (!complete) line = line.replace(/\[\^?\d*\]?$/, '')
    for (let i = 0; i < line.length;) {
      if (line[i] === '\\' && i + 1 < line.length) {
        text += line.slice(i, i + 2)
        i += 2
        continue
      }
      if (line[i] === '`') {
        const run = /^`+/.exec(line.slice(i))![0]
        if (!inline) inline = run
        else if (inline === run) inline = ''
        text += run
        i += run.length
        continue
      }
      // Definitions have already been handled at line start. A colon here is
      // prose punctuation, not a reason to leave an inline reference unparsed.
      const ref = !inline && /^\[\^?(\d+)\](?![(]|\[[^\d^])/.exec(line.slice(i))
      if (ref) {
        references.push({ number: ref[1]!, pos: text.length })
        i += ref[0].length
      } else {
        text += line[i]
        i++
      }
    }
  }
  const tidy = tidyFootnotes(text, references)
  // Hold trailing spaces while the next token could still be a citation. This
  // keeps streaming append-only when citation whitespace is removed later.
  return {
    ...tidy,
    text: final ? tidy.text : tidy.text.replace(/[ \t]+$/, ''),
    definitions,
    drops: dropped.list,
  }
}

export class FootnoteStream {
  private raw = ''
  private emitted = ''
  private contexts = new Map<string, string>()
  private readonly dropped = new DropLog()
  consume(item: { type?: string; text?: unknown; footnote_to_context?: unknown }): string {
    if (item.type === 'footnote_citations') {
      const mapping = item.footnote_to_context
      // A malformed mapping event costs the citations it carried, not the
      // answer: the blocks it should have named simply stay unresolved.
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        this.dropped.add('invalid_mapping')
      } else {
        for (const [block, id] of Object.entries(mapping)) {
          if (typeof id !== 'string') {
            this.dropped.add('invalid_mapping')
            continue
          }
          if (this.contexts.has(block) && this.contexts.get(block) !== id) {
            this.dropped.add('conflicting_mapping')
            continue
          }
          this.contexts.set(block, id)
        }
      }
    }
    if (item.type !== 'answer' || typeof item.text !== 'string') return ''
    this.raw += item.text
    return this.delta(parseFootnoteAnswer(this.raw, false).text)
  }
  /**
   * Streaming stays append-only. A service that rewrites what the reader has
   * already seen gets no further deltas from here - the canonical `done.text`
   * from finish() is what the client renders in the end, so the divergence is
   * corrected there rather than by discarding the answer.
   */
  private delta(text: string) {
    if (!text.startsWith(this.emitted)) {
      this.dropped.add('stream_rewrite')
      return ''
    }
    const delta = text.slice(this.emitted.length)
    this.emitted = text
    return delta
  }
  finish() {
    const parsed = parseFootnoteAnswer(this.raw)
    const { text, references, definitions } = parsed
    this.dropped.merge(parsed.drops)
    const anchors: { id: string; pos: number }[] = []
    for (const ref of references) {
      // A reference whose definition or block mapping never arrived cannot be
      // pointed anywhere. Drop the marker, keep the sentence.
      const block = definitions.get(ref.number)
      if (!block) {
        this.dropped.add('missing_definition')
        continue
      }
      const id = this.contexts.get(block)
      if (!id) {
        this.dropped.add('missing_mapping')
        continue
      }
      anchors.push({ id, pos: ref.pos })
    }
    return { text, tail: this.delta(text), anchors, drops: this.dropped.list }
  }
}
