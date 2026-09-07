import type { Citation, ScoredResource } from '@research-portal/core'
import { normaliseAnswerBullets, stripRefusalTemplate } from './answer-text.ts'
import { parseDocBlocks } from './resource-view.ts'

/**
 * Word-export serialisation for an Ask answer (persona finding P9-12).
 *
 * The page renders answers through `AnswerMarkdown`, which parses the text
 * with `parseDocBlocks`. This module runs the SAME parser over the same
 * normalised text and writes each block as HTML, so headings, lists and
 * tables reach the exported document as headings, lists and tables rather
 * than as literal `###`, `**` and `- ` characters. The `[n]` markers become
 * superscripts, and the reference list below them is numbered in marker
 * order from the citation metadata the corpus carries - authors, journal,
 * year, DOI and a link back to the resource - so a marker can be resolved
 * offline.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * One plain-text run to HTML: `**bold**` and `[n]` markers (kept only when a
 * citation with that index exists; stray `[16,17]` copied from a paper's own
 * numbering is dropped, as on the page).
 */
export function inlineHtml(text: string, citations: Citation[]): string {
  const known = new Set(citations.map((c) => c.index))
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`
      }
      return part
        .split(/(\[\d+(?:\s*,\s*\d+)*\]|\[inference\])/gi)
        .map((segment) => {
          if (/^\[inference\]$/i.test(segment)) return '<em>(inference)</em>'
          const single = /^\[(\d+)\]$/.exec(segment)
          if (single) {
            const index = Number(single[1])
            return known.has(index) ? `<sup>[${index}]</sup>` : ''
          }
          if (/^\[[\d,\s]+\]$/.test(segment) && citations.length > 0) return ''
          return escapeHtml(segment)
        })
        .join('')
    })
    .join('')
}

/** The answer body as HTML blocks - the export twin of `AnswerMarkdown`. */
export function answerHtml(text: string, citations: Citation[]): string {
  const blocks = parseDocBlocks(normaliseAnswerBullets(stripRefusalTemplate(text)))
  const inline = (run: string) => inlineHtml(run, citations)
  return blocks.map((block) => {
    switch (block.kind) {
      case 'heading': {
        const tag = block.level <= 3 ? 'h3' : 'h4'
        return `<${tag}>${inline(block.text)}</${tag}>`
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul'
        const items = block.items.map((item) => {
          const children = item.children.length > 0
            ? `<ul>${item.children.map((child) => `<li>${inline(child)}</li>`).join('')}</ul>`
            : ''
          return `<li>${inline(item.text)}${children}</li>`
        }).join('')
        return `<${tag}>${items}</${tag}>`
      }
      case 'quote':
        return `<blockquote>${inline(block.text)}</blockquote>`
      case 'code':
        return `<pre>${escapeHtml(block.text)}</pre>`
      case 'table': {
        const head = block.headers.map((h) => `<th>${inline(h)}</th>`).join('')
        const rows = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
          .join('')
        return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
      }
      default:
        return `<p>${inline(block.text)}</p>`
    }
  }).join('')
}

export interface ReferenceEntry {
  index: number
  resourceId: string
  title: string
  authors?: string[]
  journal?: string
  year?: string
  doi?: string
}

/** Authors as "A, B and C" for up to three, else "A, B, C et al." */
export function formatAuthors(authors: string[] | undefined): string {
  const list = (authors ?? []).map((a) => a.trim()).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length <= 3) {
    return list.length === 1
      ? list[0]!
      : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  }
  return `${list.slice(0, 3).join(', ')} et al.`
}

/**
 * The numbered reference list, in marker order, one entry per citation
 * index. Bibliographic fields come from the cited resource when the corpus
 * holds them; a resource without them still gets its title and link.
 */
export function referenceEntries(
  citations: Citation[],
  sources: Pick<ScoredResource, 'id' | 'title' | 'authors' | 'journal' | 'year' | 'doi'>[],
): ReferenceEntry[] {
  const seen = new Set<number>()
  return [...citations]
    .sort((a, b) => a.index - b.index)
    .filter((c) => (seen.has(c.index) ? false : (seen.add(c.index), true)))
    .map((citation) => {
      const source = sources.find((s) => s.id === citation.resourceId)
      return {
        index: citation.index,
        resourceId: citation.resourceId,
        title: source?.title ?? citation.title,
        ...(source?.authors && source.authors.length > 0 ? { authors: source.authors } : {}),
        ...(source?.journal ? { journal: source.journal } : {}),
        ...(source?.year ? { year: source.year } : {}),
        ...(source?.doi ? { doi: source.doi } : {}),
      }
    })
}

const doiUrl = (doi: string): string =>
  /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi.replace(/^doi:\s*/i, '')}`

/** One reference as HTML: authors. Title. Journal, year. DOI. Portal link. */
export function referenceHtml(entry: ReferenceEntry, resourceUrl: (id: string) => string): string {
  const parts: string[] = []
  const authors = formatAuthors(entry.authors)
  if (authors) parts.push(escapeHtml(authors.endsWith('.') ? authors : `${authors}.`))
  parts.push(`<em>${escapeHtml(entry.title)}</em>.`)
  const venue = [entry.journal, entry.year].filter(Boolean).map((v) => escapeHtml(v!)).join(', ')
  if (venue) parts.push(`${venue}.`)
  if (entry.doi) {
    const url = doiUrl(entry.doi)
    parts.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>.`)
  }
  const link = resourceUrl(entry.resourceId)
  parts.push(`<a href="${escapeHtml(link)}">Open in the portal</a>.`)
  return `<li>${parts.join(' ')}</li>`
}

/** The whole numbered list, or an empty string when the answer cited nothing. */
export function referenceListHtml(
  citations: Citation[],
  sources: Pick<ScoredResource, 'id' | 'title' | 'authors' | 'journal' | 'year' | 'doi'>[],
  resourceUrl: (id: string) => string,
): string {
  const entries = referenceEntries(citations, sources)
  if (entries.length === 0) return ''
  return `<h3>References</h3><ol>${
    entries.map((entry) => referenceHtml(entry, resourceUrl)).join('')
  }</ol>`
}
