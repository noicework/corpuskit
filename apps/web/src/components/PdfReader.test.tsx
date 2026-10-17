import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { pdfMenuFocusIndex, PdfReader } from './PdfReader.tsx'

Deno.test('PDF controls keep page navigation before zoom and place file actions in a closed menu', () => {
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
  expect(html).toMatch(/role="menu"[^>]+hidden=""/)
  expect(html.match(/role="menuitem"/g)?.length).toBe(5)
  for (
    const label of ['Fit to width', 'Full screen', 'Print', 'Download PDF', 'Open PDF in a new tab']
  ) {
    expect(html.slice(html.indexOf('role="menu"'))).toContain(label)
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
  expect(pdfMenuFocusIndex(-1, 5, 'ArrowDown')).toBe(0)
  expect(pdfMenuFocusIndex(-1, 5, 'ArrowUp')).toBe(4)
  expect(pdfMenuFocusIndex(4, 5, 'ArrowDown')).toBe(0)
  expect(pdfMenuFocusIndex(0, 5, 'ArrowUp')).toBe(4)
  expect(pdfMenuFocusIndex(1, 5, 'ArrowDown')).toBe(2)
  expect(pdfMenuFocusIndex(3, 5, 'Home')).toBe(0)
  expect(pdfMenuFocusIndex(1, 5, 'End')).toBe(4)
  expect(pdfMenuFocusIndex(0, 0, 'ArrowDown')).toBe(null)
  expect(pdfMenuFocusIndex(0, 5, 'Escape')).toBe(null)
})
