import { parseDocBlocks } from '../src/lib/resource-view.ts'

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
        // A plain comparison/navigation separator is not an HTML tag.
        if (!/^>\s/.test(text)) throw new Error(`Unrecognised inline syntax: ${text}`)
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

/** Reject constructs the shared permissive parser would otherwise flatten or lose. */
function validateSource(source: string): void {
  let fenced = false
  let listKind: string | undefined
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^```[\w-]*$/.test(line)) {
      fenced = !fenced
      listKind = undefined
      continue
    }
    if (fenced) continue
    if (/^\s*(?:```|~~~|>|\||#{7}|[-*_](?:\s*[-*_]){2,}\s*$)|^ {4}\S|\t| {2}$/.test(line)) {
      throw new Error(`Unrecognised block syntax: ${line}`)
    }
    const bullet = /^( *)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      const indent = bullet[1]!.length
      const kind = /^\d/.test(bullet[2]!) ? 'ordered' : 'unordered'
      if (indent > 2 || (indent > 0 && (kind === 'ordered' || !listKind))) {
        throw new Error(`Unsupported nested list: ${line}`)
      }
      if (indent === 0) {
        if (listKind && listKind !== kind) throw new Error(`Mixed list kinds: ${line}`)
        if (!listKind && kind === 'ordered' && !/^1[.)]$/.test(bullet[2]!)) {
          throw new Error(`Ordered lists must start at 1: ${line}`)
        }
        listKind = kind
      }
      if (/^\[[ xX]\]/.test(bullet[3]!)) throw new Error(`Unsupported task list: ${line}`)
      renderInline(bullet[3]!)
    } else if (line.trim()) {
      listKind = undefined
      if (/^\s*#/.test(line) && !/^#{1,6}\s+\S/.test(line)) {
        throw new Error(`Unrecognised heading: ${line}`)
      }
      renderInline(line.replace(/^#{1,6}\s+/, ''))
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
        return `<${tag}>${
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
      case 'quote':
      case 'table':
        throw new Error(`Unsupported documentation block: ${block.kind}`)
      default: {
        const exhaustive: never = block
        throw new Error(`Unrecognised documentation block: ${exhaustive}`)
      }
    }
  }).join('\n')
}
