import { isTableSeparator, parseDocBlocks } from '../src/lib/resource-view.ts'

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
}

/** Deliberately strict: new Markdown syntax must be supported before it can ship. */
export function renderInline(text: string): string {
  let html = ''
  while (text) {
    const code = /^`([^`\n]+)`/.exec(text)
    const link = /^\[([^\]\n]+)\]\(([^\s()]+)\)/.exec(text)
    const emphasis = /^(\*\*|__|\*|_)(\S[\s\S]*?)\1(?!\1)/.exec(text)
    if (code) {
      html += `<code>${escapeHtml(code[1]!)}</code>`
      text = text.slice(code[0].length)
    } else if (link) {
      const href = link[2]!
      if (!/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href) || /[<>"\\]/.test(href)) {
        throw new Error(`Unsupported documentation link: ${href}`)
      }
      html += `<a href="${escapeHtml(href)}">${renderInline(link[1]!)}</a>`
      text = text.slice(link[0].length)
    } else if (emphasis) {
      const tag = emphasis[1]!.length === 2 ? 'strong' : 'em'
      html += `<${tag}>${renderInline(emphasis[2]!)}</${tag}>`
      text = text.slice(emphasis[0].length)
    } else {
      // Numeric citation examples such as [1] are literal documentation text.
      if (/^[*_`~\\<>|]|^!\[|^\[(?!\d+\])/.test(text)) {
        // A plain comparison/navigation separator (or an arrow ending a line) is not an HTML tag.
        if (!/^>(?:\s|$)/.test(text)) throw new Error(`Unrecognised inline syntax: ${text}`)
      }
      html += escapeHtml(text[0]!)
      text = text.slice(1)
    }
  }
  return html
}

/** Stable, unique anchors across section headings and Markdown subheadings. */
export function headingIds(): (heading: string) => string {
  const used = new Set<string>()
  return (heading) => {
    const base = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
      'section'
    let id = base
    let suffix = 2
    while (used.has(id)) id = `${base}-${suffix++}`
    used.add(id)
    return id
  }
}

/**
 * Reject block constructs the shared permissive parser would otherwise flatten or lose. Inline
 * syntax is checked as each block renders, on the block's joined text, so a code span or bold run
 * may wrap across lines as Markdown allows.
 */
function validateSource(source: string): void {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let fenced = false
  let listKind: string | undefined
  let inTable = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    // A fence may be indented, as under a list item; the parser reads it trimmed.
    if (/^\s*```[\w-]*\s*$/.test(line)) {
      fenced = !fenced
      listKind = undefined
      continue
    }
    if (fenced) continue
    // A table: a pipe row followed by a separator row, then pipe rows up to a blank line.
    if (inTable && line.trim() && line.includes('|')) continue
    inTable = false
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      inTable = true
      listKind = undefined
      index += 1
      continue
    }
    const bullet = /^( *)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    // An indented line inside a list continues the item above it.
    if (!bullet && listKind && /^\s+\S/.test(line) && !/\t| {2}$/.test(line)) continue
    if (/^\s*(?:```|~~~|>|\||#{7}|=+\s*$|[-*_](?:\s*[-*_]){2,}\s*$)|^ {4}\S|\t| {2}$/.test(line)) {
      throw new Error(`Unrecognised block syntax: ${line}`)
    }
    if (bullet) {
      const indent = bullet[1]!.length
      const kind = /^\d/.test(bullet[2]!) ? 'ordered' : 'unordered'
      // One level of nesting: two spaces under a bullet, or three under `1. `.
      if (indent > 3 || (indent > 0 && (kind === 'ordered' || !listKind))) {
        throw new Error(`Unsupported nested list: ${line}`)
      }
      if (indent === 0) {
        if (listKind && listKind !== kind) throw new Error(`Mixed list kinds: ${line}`)
        listKind = kind
      }
      if (/^\[[ xX]\]/.test(bullet[3]!)) throw new Error(`Unsupported task list: ${line}`)
    } else if (line.trim()) {
      listKind = undefined
      if (/^\s*#/.test(line) && !/^#{1,6}\s+\S/.test(line)) {
        throw new Error(`Unrecognised heading: ${line}`)
      }
    }
  }
  if (fenced) throw new Error('Unclosed documentation code fence')
}

export function renderMarkdown(source: string, id = headingIds()): string {
  validateSource(source)
  return parseDocBlocks(source).map((block): string => {
    switch (block.kind) {
      case 'paragraph':
        return `<p>${renderInline(block.text)}</p>`
      case 'heading': {
        // A page title is h1 and its authored sections are h2.
        const level = Math.max(3, block.level)
        return `<h${level} id="${id(block.text)}">${renderInline(block.text)}</h${level}>`
      }
      case 'code':
        return `<pre><code>${escapeHtml(block.text)}</code></pre>`
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul'
        const start = block.ordered && block.start !== undefined ? ` start="${block.start}"` : ''
        return `<${tag}${start}>${
          block.items.map((item) =>
            `<li>${renderInline(item.text)}${
              item.children.length
                ? `<ul>${
                  item.children.map((child) => `<li>${renderInline(child)}</li>`).join('')
                }</ul>`
                : ''
            }</li>`
          ).join('')
        }</${tag}>`
      }
      case 'table': {
        // A wide table scrolls inside its own region, which the keyboard can reach.
        const label = escapeHtml(`Table: ${block.headers.join(', ')}`)
        return `<div class="docs-table" role="region" aria-label="${label}" tabindex="0"><table><thead><tr>${
          block.headers.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join('')
        }</tr></thead><tbody>${
          block.rows.map((row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`
          ).join('')
        }</tbody></table></div>`
      }
      case 'quote':
        throw new Error(`Unsupported documentation block: ${block.kind}`)
      default: {
        const exhaustive: never = block
        throw new Error(`Unrecognised documentation block: ${exhaustive}`)
      }
    }
  }).join('\n')
}
