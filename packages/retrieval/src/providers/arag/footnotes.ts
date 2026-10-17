// Progress's beta wire format uses [1] (also accept Markdown [^1]), followed
// by [1]: block-AA definitions and a separate footnote_to_context event.
// Keep answer offsets in UTF-16, just like the existing browser renderer.
import type { Citation } from '@research-portal/core'
import type { GeneratedCitations } from './citations.ts'

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
  | 'out_of_scope'
  | 'stream_rewrite'
  | 'unexpected_standard_citations'

export class FootnoteError extends Error {
  constructor(readonly reason: FootnoteFailureReason) {
    super('The response citation links could not be verified. Please try again.')
  }
}

/**
 * Preserve CorpusKit's resource-level numbering contract while taking anchor
 * positions from the model's verified block references, not offset attribution.
 * Validate every referenced block before emitting any citation. A marker that cannot be tied to
 * a verified document passage is dropped (counted in `unresolved`), never guessed. A reference to
 * a resource outside the ask's scope still fails the whole answer: the generator read material
 * the portal must not show. Under `strictScope` an unverifiable reference fails it too.
 *
 * A reference to a data-augmentation field (`<rid>/t/da-...`, a generated
 * summary rather than the document) is the one exception to failing closed:
 * it binds to its resource at resource level, sharing that resource's number,
 * or is dropped, marker and all, when the resource is not citable here. The
 * citation never carries the generated text, and the sentence audit checks
 * the claim against the document's own text.
 */
export function bindFootnotes(
  parsed: ReturnType<FootnoteStream['finish']>,
  citable: (resourceId: string) => boolean,
  resolveTitle: (resourceId: string) => string,
  extraContextSources: ReadonlyMap<string, string> = new Map(),
  /**
   * A pinned or documentation-scoped ask: an unverifiable reference fails the answer, because
   * nothing then proves the prose stayed inside the pin.
   */
  strictScope = false,
): {
  text: string
  citations: Citation[]
  generated: GeneratedCitations
  /** Markers that could not be tied to a verifiable document passage, dropped from the text. */
  unresolved: number
} {
  const citations: Citation[] = []
  const byResource = new Map<string, number>()
  const inserts = new Map<number, Set<number>>()
  const generated: GeneratedCitations = { remapped: 0, dropped: 0 }
  let unresolved = parsed.unresolved
  for (const anchor of parsed.anchors) {
    const suppliedResource = extraContextSources.get(anchor.id)
    const match = /^([^/]+)\/(t|f|l|c)\/([^/]+)(?:\/(?:[^/]+\/)?\d+-\d+)?$/.exec(anchor.id)
    if (!match && !suppliedResource) {
      // Anonymous context, resource metadata or an unknown shape is not a document passage:
      // its marker goes, and the rest of the answer keeps its verified citations.
      if (strictScope) {
        throw new FootnoteError(
          /^USER_CONTEXT_/.test(anchor.id)
            ? 'anonymous_context'
            : /^[^/]+\/a\//.test(anchor.id)
            ? 'metadata_context'
            : 'unsupported_context',
        )
      }
      unresolved += 1
      continue
    }
    // Supplied context has a verified resource identity, not a fabricated
    // native paragraph ID. Both paths retain the same scope validation.
    const resourceId = suppliedResource ?? match![1]!
    if (match?.[3]?.startsWith('da-')) {
      if (!citable(resourceId)) {
        generated.dropped += 1
        continue
      }
      generated.remapped += 1
    } else if (!citable(resourceId)) throw new FootnoteError('out_of_scope')
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
  return { text, citations, generated, unresolved }
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
    if (group.end > group.start && next && !/[\r\n.!?。！？,;:…\])”’"'」』）】》〉〕]/.test(next)) {
      out += ' '
    }
    cursor = group.end
  }
  out += text.slice(cursor)
  for (const ref of shifted) {
    const punctuation = /^[.!?。！？,;:…\])”’"'」』）】》〉〕]+/.exec(out.slice(ref.pos))
    if (punctuation) ref.pos += punctuation[0].length
  }
  return { text: out, references: shifted }
}

// A definition line, leniently: an optional list bullet or number, optional bold around the
// marker, then the blocks it names. `[1]: block-AA`, `- [1]: block-AA.`, `**[1]:** block-AA,
// block-AB` all define [1]. A line whose value names no block defines nothing usable.
const DEFINITION =
  /^ {0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+)?(?:\*\*|__)?\[\^?(\d+)\](?:\*\*|__)?:(?:\*\*|__)?\s*(.*?)\s*$/
// While a line is still arriving, anything that could become a definition is held back.
const PARTIAL_DEFINITION =
  /^\s*(?:[-*+]\s*|\d{1,3}[.)]?\s*)?(?:\*{1,2}|_{1,2})?\[?\^?\d*\]?(?:\*{1,2}|_{1,2})?(?::.*)?$/
const BLOCK = /\bblock-[A-Za-z0-9_-]+/g

export function parseFootnoteAnswer(raw: string, final = true) {
  /** Marker number -> the blocks it names. An empty list is a definition that resolves nothing. */
  const definitions = new Map<string, string[]>()
  const references: FootnoteReference[] = []
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
    if (!complete && (/^\s*$/.test(line) || PARTIAL_DEFINITION.test(line))) continue
    const definition = complete ? DEFINITION.exec(line.replace(/\r?\n$/, '')) : null
    if (definition) {
      // Only exact block identifiers count; anything else on the line (a URL, a title) is
      // ignored, and a value naming no block leaves its marker unresolved.
      const blocks = [...new Set(definition[2]!.match(BLOCK) ?? [])]
      const previous = definitions.get(definition[1]!)
      // Two definitions of one marker that disagree resolve nothing rather than either one.
      definitions.set(
        definition[1]!,
        previous && previous.join() !== blocks.join() ? [] : blocks,
      )
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
  return { ...tidy, text: final ? tidy.text : tidy.text.replace(/[ \t]+$/, ''), definitions }
}

export class FootnoteStream {
  private raw = ''
  private emitted = ''
  private contexts = new Map<string, string>()
  /** Blocks the platform mapped inconsistently: they bind nothing. */
  private conflicted = new Set<string>()
  consume(item: { type?: string; text?: unknown; footnote_to_context?: unknown }): string {
    if (item.type === 'footnote_citations') {
      // A malformed mapping maps nothing; an inconsistent block maps nothing. The markers that
      // relied on them are dropped at finish, never bound to a guess.
      const mapping = item.footnote_to_context
      if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
        for (const [block, id] of Object.entries(mapping)) {
          if (typeof id !== 'string') continue
          if (this.contexts.has(block) && this.contexts.get(block) !== id) {
            this.conflicted.add(block)
          }
          this.contexts.set(block, id)
        }
      }
    }
    if (item.type !== 'answer' || typeof item.text !== 'string') return ''
    this.raw += item.text
    return this.delta(parseFootnoteAnswer(this.raw, false).text)
  }
  private delta(text: string) {
    if (!text.startsWith(this.emitted)) throw new FootnoteError('stream_rewrite')
    const delta = text.slice(this.emitted.length)
    this.emitted = text
    return delta
  }
  /**
   * The final text with every marker removed, and an anchor for each marker that resolves through
   * its definition and the platform's mapping. A marker with no definition, an unusable definition
   * or an unmapped block is counted in `unresolved` and simply not re-inserted.
   */
  finish() {
    const { text, references, definitions } = parseFootnoteAnswer(this.raw)
    const anchors: { id: string; pos: number }[] = []
    let unresolved = 0
    for (const ref of references) {
      const ids = (definitions.get(ref.number) ?? [])
        .filter((block) => !this.conflicted.has(block))
        .map((block) => this.contexts.get(block))
        .filter((id): id is string => !!id)
      if (!ids.length) unresolved += 1
      for (const id of ids) anchors.push({ id, pos: ref.pos })
    }
    return { text, tail: this.delta(text), anchors, unresolved, references: references.length }
  }
}
