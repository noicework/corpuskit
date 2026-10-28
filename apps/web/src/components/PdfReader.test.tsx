import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { pdfMenuFocusIndex, PdfReader } from './PdfReader.tsx'

Deno.test('PDF controls prioritise page navigation and provide zoom actions in the closed menu', () => {
  const html = renderToStaticMarkup(
    <PdfReader fileUrl='/report.pdf' title='Reef survey' initialPage={2} />,
  )
  const controls = html.slice(0, html.indexOf('role="menu"'))
  expect(controls.match(/<button /g)?.length).toBe(5)
  const order = [
    'aria-label="Previous page"',
    'inputMode="numeric"',
    'aria-label="Next page"',
    'aria-label="Zoom out"',
    'aria-label="Zoom in"',
    'aria-label="More PDF actions"',
  ].map((name) => controls.indexOf(name))
  expect(order.every((position) => position >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(controls).toContain('aria-expanded="false"')
  expect(controls).toContain('aria-haspopup="menu"')
  expect(controls).toContain('rp-library-pdf-inline-zoom')
  expect(html).toMatch(/role="menu"[^>]+hidden=""/)
  expect(html.match(/role="menuitem"/g)?.length).toBe(7)
  const menu = html.slice(html.indexOf('role="menu"'))
  expect(menu).toContain('rp-library-pdf-menu-zoom')
  for (
    const label of [
      'Zoom out',
      'Zoom in',
      'Fit to width',
      'Full screen',
      'Print',
      'Download PDF',
      'Open PDF in a new tab',
    ]
  ) {
    expect(menu).toContain(label)
  }
})

Deno.test('PDF file actions preserve the source URL, page deep link and download behaviour', () => {
  const html = renderToStaticMarkup(
    <PdfReader fileUrl='/report.pdf' title='Reef survey' initialPage={2} />,
  )
  expect(html).toMatch(/<a[^>]+href="\/report.pdf"[^>]+download=""/)
  expect(html).toMatch(/<a[^>]+href="\/report.pdf#page=2"[^>]+target="_blank"/)
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).toContain('value="2"')
})

Deno.test('PDF page fields have unique associated labels when more than one reader is mounted', () => {
  const html = renderToStaticMarkup(
    <>
      <PdfReader fileUrl='/first.pdf' title='First survey' initialPage={null} />
      <PdfReader fileUrl='/second.pdf' title='Second survey' initialPage={null} />
    </>,
  )
  const fieldIds = [...html.matchAll(/<input id="([^"]+)"/g)].map((match) => match[1])
  expect(fieldIds.length).toBe(2)
  expect(new Set(fieldIds).size).toBe(2)
  for (const id of fieldIds) expect(html).toContain(`<label for="${id}"`)
})

Deno.test('PDF menu keyboard focus wraps available actions and supports the ends of the menu', () => {
  for (const count of [5, 7]) {
    expect(pdfMenuFocusIndex(-1, count, 'ArrowDown')).toBe(0)
    expect(pdfMenuFocusIndex(-1, count, 'ArrowUp')).toBe(count - 1)
    expect(pdfMenuFocusIndex(count - 1, count, 'ArrowDown')).toBe(0)
    expect(pdfMenuFocusIndex(0, count, 'ArrowUp')).toBe(count - 1)
    expect(pdfMenuFocusIndex(1, count, 'ArrowDown')).toBe(2)
    expect(pdfMenuFocusIndex(3, count, 'Home')).toBe(0)
    expect(pdfMenuFocusIndex(1, count, 'End')).toBe(count - 1)
  }
  expect(pdfMenuFocusIndex(0, 0, 'ArrowDown')).toBe(null)
  expect(pdfMenuFocusIndex(0, 5, 'Escape')).toBe(null)
})

Deno.test('the closed actions menu names no element it does not show, and the page shows its focus', () => {
  const html = renderToStaticMarkup(
    <PdfReader fileUrl='/report.pdf' title='Reef survey' initialPage={2} />,
  )
  const trigger = /<button[^>]*aria-haspopup="menu"[^>]*>/.exec(html)?.[0] ?? ''
  expect(trigger).toContain('aria-expanded="false"')
  expect(trigger).not.toContain('aria-controls')
  // The focusable page carries the inward ring its scroll pane cannot clip (library.css).
  expect(html).toMatch(/role="group"[^>]*tabindex="0"[^>]*class="[^"]*rp-library-pdf-stage/i)
})
