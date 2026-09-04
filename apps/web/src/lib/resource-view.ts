import type { ResourceContent, ScoredResource } from '@research-portal/core'

/**
 * Pure logic for the resource detail ("watch/read this document") view: which
 * viewer to show for a resource's content kind, how to build and clean the
 * semantic "related resources" rail, and how to parse an authored document
 * body into renderable blocks. Kept UI-free so it can be unit-tested directly.
 */

/** The primary-viewer variant for a resource's content. */
export type ViewerVariant =
  | 'pdf'
  | 'video'
  | 'audio'
  | 'image'
  | 'office'
  | 'web'
  | 'document'

/**
 * Which primary viewer renders a resource. `text`/`file` (and anything
 * unrecognised) read as the structured `document` reader; `web` keeps its own
 * page-summary-plus-body treatment; the rest map one-to-one.
 */
export function selectViewerVariant(kind: ResourceContent['kind']): ViewerVariant {
  switch (kind) {
    case 'pdf':
      return 'pdf'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'image':
      return 'image'
    case 'office':
      return 'office'
    case 'web':
      return 'web'
    default:
      return 'document'
  }
}

/**
 * The semantic query for the "related resources" rail: this document's title
 * and summary joined into one natural-language query, whitespace-collapsed and
 * length-capped. Richer than the title alone, so the rail recommends on what
 * the document is actually about.
 */
export function buildRelatedQuery(title: string, summary?: string): string {
  const t = (title ?? '').trim()
  const s = (summary ?? '').trim()
  const combined = s && s.toLowerCase() !== t.toLowerCase() ? `${t}. ${s}` : t
  return combined.replace(/\s+/g, ' ').trim().slice(0, 400)
}

/**
 * A system/housekeeping artefact that must never appear as a recommendation -
 * a dotfile (`.uploaded.log`) or a log/temp/backup file. Mirrors the
 * provider's `looksLikeSystemFileTitle`; kept here too as client-side defence
 * so junk can never reach the rail even if a raw result slips through.
 */
export function looksLikeSystemResource(title: string): boolean {
  const t = (title ?? '').trim()
  if (t.length === 0) return true
  if (t.startsWith('.')) return true
  return /\.(log|tmp|temp|bak|swp|ds_store)$/i.test(t)
}

/**
 * Turns raw semantic search hits into a clean recommendations rail: the
 * current resource is excluded, system/junk files are dropped, duplicates are
 * removed, and the list is capped. Preserves the incoming relevance order.
 */
export function selectRecommendations(
  results: ScoredResource[],
  currentId: string,
  limit = 6,
): ScoredResource[] {
  const seen = new Set<string>([currentId])
  const out: ScoredResource[] = []
  for (const r of results) {
    if (seen.has(r.id)) continue
    if (looksLikeSystemResource(r.title)) continue
    seen.add(r.id)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

/** One list entry: its text plus any indented sub-bullets nested under it. */
export interface DocListItem {
  text: string
  children: string[]
}

/** A parsed, renderable block of an authored document body. */
export type DocBlock =
  | { kind: 'heading'; level: number; text: string; index: number }
  | { kind: 'paragraph'; text: string; index: number }
  | { kind: 'quote'; text: string; index: number }
  | { kind: 'list'; ordered: boolean; items: DocListItem[]; index: number }
  | { kind: 'code'; text: string; index: number }
  | { kind: 'table'; headers: string[]; rows: string[][]; index: number }

/** A DocBlock before its sequential `index` is assigned (distributes over the union). */
type DocBlockInput = DocBlock extends infer T ? (T extends DocBlock ? Omit<T, 'index'> : never)
  : never

/** Strip a markdown table-row into trimmed cells. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** Whether a line is a markdown table separator row (e.g. `|---|:--:|`). */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')
}

/** Collapse the soft line wraps inside a single paragraph into spaces. */
function unwrap(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/** Width of a line's leading whitespace, counting a tab as two spaces. */
function indentWidth(line: string): number {
  const leading = /^[ \t]*/.exec(line)?.[0] ?? ''
  return leading.replace(/\t/g, '  ').length
}

/**
 * Parse an authored document body (markdown, or the platform's flattened
 * extracted text) into a flat list of renderable blocks, each stamped with a
 * sequential `index` so the "matches in this document" rail and passage
 * highlighting can anchor to `doc-block-{index}`. Handles headings, block
 * quotes, fenced code, ordered/unordered lists and pipe tables; everything
 * else is a paragraph. Blank-line separation is used when present (authored
 * markdown); otherwise each source line becomes its own block (flattened
 * extracted text), so both shapes stay readable.
 */
export function parseDocBlocks(body: string): DocBlock[] {
  const source = (body ?? '').replace(/\r\n?/g, '\n')
  if (source.trim().length === 0) return []
  const hasBlankLines = /\n[ \t]*\n/.test(source)
  const lines = source.split('\n')
  const blocks: DocBlock[] = []
  let index = 0
  const push = (block: DocBlockInput) => {
    blocks.push({ ...block, index } as DocBlock)
    index += 1
  }

  let i = 0
  let paragraph: string[] = []
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    push({ kind: 'paragraph', text: unwrap(paragraph.join('\n')) })
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      flushParagraph()
      i += 1
      continue
    }

    // Fenced code block.
    if (/^```/.test(trimmed)) {
      flushParagraph()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
        buf.push(lines[i] ?? '')
        i += 1
      }
      i += 1 // closing fence
      push({ kind: 'code', text: buf.join('\n') })
      continue
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      i += 1
      continue
    }

    // Table: a pipe row followed by a separator row.
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
      flushParagraph()
      const headers = tableCells(trimmed)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(tableCells(lines[i] ?? ''))
        i += 1
      }
      push({ kind: 'table', headers, rows })
      continue
    }

    // Block quote (one or more consecutive `>` lines).
    if (/^>\s?/.test(trimmed)) {
      flushParagraph()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test((lines[i] ?? '').trim())) {
        buf.push((lines[i] ?? '').trim().replace(/^>\s?/, ''))
        i += 1
      }
      push({ kind: 'quote', text: unwrap(buf.join('\n')) })
      continue
    }

    // List: one or more bullet/number lines, each of which may soft-wrap onto
    // indented continuation lines, and may be separated by a blank line (a
    // "loose" list). Continuation lines are folded into their item so a
    // wrapped item stays one entry rather than fragmenting into stray blocks.
    // A bullet line indented at least two spaces past the first item nests as
    // a sub-bullet of the item above it (one level - deeper indents flatten).
    const bullet = /^([-*+]|\d+[.)])\s+/.exec(trimmed)
    if (bullet) {
      flushParagraph()
      const ordered = /^\d/.test(bullet[1]!)
      const baseIndent = indentWidth(line)
      const items: DocListItem[] = []
      let lastWasChild = false
      while (i < lines.length) {
        const raw = lines[i] ?? ''
        const t = raw.trim()
        const m = /^([-*+]|\d+[.)])\s+(.*)$/.exec(t)
        if (m) {
          const parent = items[items.length - 1]
          if (parent && indentWidth(raw) >= baseIndent + 2) {
            parent.children.push(m[2]!.trim())
            lastWasChild = true
          } else {
            items.push({ text: m[2]!.trim(), children: [] })
            lastWasChild = false
          }
          i += 1
          continue
        }
        if (t.length === 0) {
          // Continue across a blank line only when the list resumes after it.
          let j = i + 1
          while (j < lines.length && (lines[j] ?? '').trim().length === 0) j += 1
          if (j < lines.length && /^([-*+]|\d+[.)])\s+/.test((lines[j] ?? '').trim())) {
            i = j
            continue
          }
          break
        }
        // An indented, non-bullet line continues the most recent entry's text.
        const target = items[items.length - 1]
        if (/^\s/.test(raw) && target) {
          if (lastWasChild && target.children.length > 0) {
            target.children[target.children.length - 1] = `${
              target.children[target.children.length - 1]
            } ${t}`
          } else {
            target.text = `${target.text} ${t}`
          }
          i += 1
          continue
        }
        break
      }
      push({ kind: 'list', ordered, items })
      continue
    }

    // Plain text. With blank-line separation we accumulate wrapped lines into a
    // paragraph; without it (flattened extracted text) each line stands alone.
    if (hasBlankLines) {
      paragraph.push(line)
      i += 1
    } else {
      push({ kind: 'paragraph', text: trimmed })
      i += 1
    }
  }
  flushParagraph()
  return blocks
}

/**
 * How many leading blocks fit within a character budget. Long documents can
 * carry hundreds of thousands of characters of extracted text, and rendering
 * every block through the inline renderer in one go locks the main thread -
 * so the reader renders the blocks that fit this budget and grows it on
 * request. Always admits at least one block, so a single huge block still
 * renders rather than showing an empty reader.
 */
export function blocksWithinBudget(lengths: number[], budget: number): number {
  let used = 0
  for (let i = 0; i < lengths.length; i++) {
    used += lengths[i] ?? 0
    if (used > budget && i > 0) return i
  }
  return lengths.length
}

/** Plain searchable text for a block - what passage/`?q=` matching runs over. */
export function blockPlainText(block: DocBlock): string {
  switch (block.kind) {
    case 'list':
      return block.items.map((item) => [item.text, ...item.children].join(' ')).join(' ')
    case 'table':
      return [block.headers.join(' '), ...block.rows.map((r) => r.join(' '))].join(' ')
    default:
      return block.text
  }
}
