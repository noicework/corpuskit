import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { docPageById } from '@research-portal/core'
import { FLOW_STEPS, FlowDiagram, HOW_IT_WORKS_SECTIONS } from './HowItWorksPage.tsx'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { helpMenuItems } from '../components/help-menu-items.ts'

const pageSource = await Deno.readTextFile(new URL('./HowItWorksPage.tsx', import.meta.url))
const routerSource = await Deno.readTextFile(new URL('../main.tsx', import.meta.url))
const layoutSource = await Deno.readTextFile(new URL('./TenantLayout.tsx', import.meta.url))
const docsPageSource = await Deno.readTextFile(new URL('./DocsPage.tsx', import.meta.url))

describe('How this works page', () => {
  it('is routed at /t/:slug/how-it-works', () => {
    expect(routerSource).toContain("<Route path='how-it-works' element={<HowItWorksPage />} />")
  })

  it('keeps the same sections, in the same order, as the documentation page', () => {
    const doc = docPageById('how-this-works')
    expect(doc).toBeDefined()
    expect(HOW_IT_WORKS_SECTIONS.map((section) => section.heading)).toEqual(
      doc!.sections.map((section) => section.heading),
    )
  })

  it('draws the flow from the appearance tokens only', () => {
    // No literal colour anywhere on the page: fills, strokes and faces are tokens.
    expect(pageSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(pageSource).not.toMatch(/\b(?:rgb|hsl)a?\(/)
    expect(pageSource).not.toMatch(/\b(?:white|black)\b/)
    for (
      const token of ['--rp-surface-2', '--rp-line', '--rp-accent', '--rp-on-accent', '--rp-ink']
    ) {
      expect(pageSource).toContain(`var(${token})`)
    }
    const html = renderToStaticMarkup(createElement(FlowDiagram))
    // Normal document text grows with the reader's settings instead of clipping in SVG boxes.
    expect(html).not.toContain('<text')
    expect(html).not.toContain('<rect')
    expect(html).not.toMatch(/font-size:[^;]*px|height="\d+(?:\.\d+)?(?:px)?"/)
    expect(html).toContain('var(--rp-radius)')
    // Two orientations: a row from lg up and a stacked column below it.
    expect(html).toContain('data-orientation="row"')
    expect(html).toContain('data-orientation="column"')
    expect(html).toContain('lg:hidden')
  })

  it('takes every figure from the live counters endpoint', () => {
    expect(pageSource).toContain('getCounters(slug)')
    // No resource count typed into the copy.
    expect(pageSource).not.toMatch(/\b\d{3,} (?:resources|papers|paragraphs|sentences)\b/)
  })

  it('names the platform exactly once, in the technical note', () => {
    expect(pageSource.match(/Progress Agentic RAG/g)?.length).toBe(1)
    expect(pageSource).toContain('(retrieval-augmented generation)')
  })

  it('keeps all six step titles and details readable and includes an accessible description', () => {
    const html = renderToStaticMarkup(createElement(FlowDiagram))
    expect(FLOW_STEPS.length).toBe(6)
    for (const step of FLOW_STEPS) {
      expect(html).toContain(step.title)
      expect(html).toContain(step.detail)
    }
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="The flow of one question through the portal.')
  })

  it('is linked from the header help menu, the phone menu and the Help landing page', () => {
    expect(helpMenuItems('marine')).toEqual([
      { key: 'help', href: '/t/marine/help', label: 'Help and documentation' },
      { key: 'how', href: '/t/marine/how-it-works', label: 'How this works' },
    ])
    expect(layoutSource).toContain('<HelpMenu slug={config.slug} />')
    expect(layoutSource).toContain('helpMenuItems(config.slug).map(')
    expect(docsPageSource).toContain('/how-it-works`')
  })
})
