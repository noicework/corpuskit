import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  DOC_CATEGORIES,
  DOC_ORIGIN_PREFIX,
  DOC_PAGES,
  docPageById,
  docPagesByCategory,
  docPageToMarkdown,
  docPageToPlainText,
  docResourceOrigin,
  docResourceSlug,
  DOCUMENTATION_LABEL,
  DOCUMENTATION_LABELSET,
  isDocOrigin,
} from './docs.ts'

describe('documentation content integrity', () => {
  it('has at least the core set of pages, each fully populated', () => {
    expect(DOC_PAGES.length).toBeGreaterThanOrEqual(12)
    for (const page of DOC_PAGES) {
      expect(page.id).toMatch(/^[a-z0-9-]+$/)
      expect(page.title.trim().length).toBeGreaterThan(0)
      expect(page.summary.trim().length).toBeGreaterThan(0)
      expect(page.sections.length).toBeGreaterThan(0)
      for (const section of page.sections) {
        expect(section.heading.trim().length).toBeGreaterThan(0)
        expect(section.body.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('gives every page a unique, stable id', () => {
    const ids = DOC_PAGES.map((page) => page.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('files every page under a known category', () => {
    for (const page of DOC_PAGES) {
      expect(DOC_CATEGORIES).toContain(page.category)
    }
  })

  it('covers the features named in the owner brief', () => {
    for (const id of ['getting-started', 'search', 'assistant', 'trust-and-citations', 'library']) {
      expect(docPageById(id)).toBeDefined()
    }
  })

  it('uses Australian English and no em dashes in user-facing copy', () => {
    // US spellings chosen so they are not substrings of their Australian forms
    // (e.g. "colour" does not contain "color", "artefact" does not contain "artifact").
    const usSpellings = ['organization', 'organize', 'color', 'behavior', 'analyze', 'artifact']
    for (const page of DOC_PAGES) {
      const text = docPageToPlainText(page)
      expect(text).not.toContain('—') // em dash
      const lower = text.toLowerCase()
      for (const us of usSpellings) {
        expect(lower).not.toContain(us)
      }
    }
  })

  it('uses the current Ask and Tools surface names', () => {
    const gettingStarted = docPageToPlainText(docPageById('getting-started')!)
    const ask = docPageById('assistant')

    expect(gettingStarted).toContain('Ask - a full, grounded conversation')
    expect(gettingStarted).toContain('Tools - connect MCP clients')
    expect(gettingStarted).not.toContain('Assistant -')
    expect(ask?.title).toBe('Ask')
    expect(docPageToPlainText(ask!)).not.toContain('Assistant')
    expect(docPageById('generate')?.title).toBe('Tools')
    // The Tools page itself is pared to the create-key journey; the detail
    // the page used to carry has to live here instead.
    const tools = docPageToPlainText(docPageById('generate')!)
    expect(tools).toContain('MCP connector')
    expect(tools).toContain('read-only')
    expect(tools).toContain('Authorization: Bearer')
  })
})

describe('docPagesByCategory()', () => {
  it('groups every page exactly once, in category order', () => {
    const groups = docPagesByCategory()
    const flattened = groups.flatMap((group) => group.pages)
    expect(flattened.length).toBe(DOC_PAGES.length)
    expect(new Set(flattened.map((p) => p.id)).size).toBe(DOC_PAGES.length)
    // Categories appear in the declared order.
    const seen = groups.map((g) => g.category)
    expect(seen).toEqual(DOC_CATEGORIES.filter((c) => seen.includes(c)))
  })
})

describe('docPageToMarkdown()', () => {
  it('leads with the title as H1 and each section as H2', () => {
    const page = DOC_PAGES[0]!
    const md = docPageToMarkdown(page)
    expect(md.startsWith(`# ${page.title}`)).toBe(true)
    for (const section of page.sections) {
      expect(md).toContain(`## ${section.heading}`)
    }
  })
})

describe('docPageToPlainText()', () => {
  it('strips markdown markers', () => {
    const text = docPageToPlainText(DOC_PAGES[0]!)
    expect(text).not.toMatch(/^#/m)
    expect(text).not.toContain('**')
  })
})

describe('documentation isolation identifiers', () => {
  it('exposes the reserved labelset and label', () => {
    expect(DOCUMENTATION_LABELSET).toBe('content-type')
    expect(DOCUMENTATION_LABEL).toBe('documentation')
  })

  it('derives a stable slug and origin per page id', () => {
    expect(docResourceSlug('search')).toBe('doc-search')
    expect(docResourceOrigin('search')).toBe(`${DOC_ORIGIN_PREFIX}search`)
  })

  it('recognises a documentation origin url', () => {
    expect(isDocOrigin(docResourceOrigin('assistant'))).toBe(true)
    expect(isDocOrigin('https://example.org/report.pdf')).toBe(false)
    expect(isDocOrigin(undefined)).toBe(false)
  })
})
