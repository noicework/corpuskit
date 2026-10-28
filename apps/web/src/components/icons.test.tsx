import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from './icons.tsx'

const requiredNames = [
  'Search',
  'X',
  'Menu',
  'ChevronDown',
  'ChevronUp',
  'ChevronLeft',
  'ChevronRight',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowUpRight',
  'ExternalLink',
  'Plus',
  'Minus',
  'Check',
  'CheckCircle',
  'Info',
  'AlertTriangle',
  'AlertCircle',
  'HelpCircle',
  'User',
  'Users',
  'Sun',
  'Moon',
  'Trash',
  'Bookmark',
  'BookmarkFilled',
  'Pin',
  'Copy',
  'RotateCw',
  'RotateCcw',
  'ThumbsUp',
  'ThumbsDown',
  'ShieldCheck',
  'Eye',
  'EyeOff',
  'Pencil',
  'Upload',
  'Download',
  'Printer',
  'ZoomIn',
  'ZoomOut',
  'Pause',
  'Play',
  'Maximize',
  'FitWidth',
  'SlidersHorizontal',
  'LayoutGrid',
  'LayoutList',
  'FileText',
  'File',
  'Globe',
  'Image',
  'Table',
  'MessageSquare',
  'History',
  'Sparkles',
  'Share',
  'Network',
  'Grid2x2',
  'Scatter',
  'Workflow',
  'Library',
  'Compass',
  'Link',
  'Key',
  'Lock',
  'LogOut',
  'Calendar',
  'Clock',
  'Tag',
  'Database',
  'Settings',
  'Send',
  'Filter',
  'Wand',
] as const

const sizes: Record<icons.IconSize, string> = { sm: '1rem', md: '1.25rem', lg: '1.5rem' }

/** Inspect the SVG element separately from child shapes and their attributes. */
function root(markup: string): string {
  return markup.match(/^<svg\b[^>]*>/)?.[0] ?? ''
}

Deno.test('the icon module provides every specified named component and no runtime registry', () => {
  expect(Object.keys(icons).sort()).toEqual([...requiredNames].sort())
  expect(requiredNames.length).toBe(76)
})

for (const name of requiredNames) {
  const Icon = icons[name]

  Deno.test(`${name} follows the icon grid, sizing and accessible-name contract at every size`, () => {
    for (const [size, length] of Object.entries(sizes) as [icons.IconSize, string][]) {
      const decorative = renderToStaticMarkup(<Icon size={size} className='test-icon' />)
      const svg = root(decorative)
      expect(svg).toContain('viewBox="0 0 24 24"')
      expect(svg).toContain('width="' + length + '"')
      expect(svg).toContain('height="' + length + '"')
      expect(svg).toContain('fill="none"')
      expect(svg).toContain('stroke="currentColor"')
      expect(svg).toContain('stroke-width="1.75"')
      expect(svg).toContain('stroke-linecap="round"')
      expect(svg).toContain('stroke-linejoin="round"')
      expect(svg).toContain('class="test-icon"')
      expect(svg).toContain('focusable="false"')
      expect(svg).toContain('aria-hidden="true"')
      expect(svg).not.toContain('aria-label=')
      expect(svg).not.toContain('role=')
      expect(decorative).not.toContain('<title')
      expect(decorative).toMatch(/<(path|rect|circle|ellipse|line|polyline|polygon)\b/)

      const title = `${name} <saved> & available`
      const named = renderToStaticMarkup(<Icon size={size} title={title} />)
      const namedRoot = root(named)
      expect(namedRoot).toContain('role="img"')
      expect(namedRoot).toContain(`aria-label="${name} &lt;saved&gt; &amp; available"`)
      expect(namedRoot).not.toContain('aria-hidden=')
      expect(named).toContain(`<title>${name} &lt;saved&gt; &amp; available</title>`)
      expect(named.match(/<title>/g)?.length).toBe(1)
      expect(namedRoot).toContain(`width="${length}"`)
      expect(namedRoot).toContain(`height="${length}"`)

      // The selected bookmark is the only filled glyph; all others inherit the outline recipe.
      const fills = [...decorative.matchAll(/\bfill="([^"]*)"/g)].map((match) => match[1])
      expect(fills).toEqual(name === 'BookmarkFilled' ? ['none', 'currentColor'] : ['none'])
      expect(decorative.match(/\bstroke="/g)?.length).toBe(1)
      expect(decorative).not.toContain('<text')
    }
  })

  Deno.test(`${name} defaults to md and treats empty titles as decorative`, () => {
    const defaultMarkup = renderToStaticMarkup(<Icon />)
    expect(root(defaultMarkup)).toContain('width="1.25rem"')
    expect(root(defaultMarkup)).toContain('height="1.25rem"')
    expect(root(defaultMarkup)).not.toContain('class=')
    for (const title of ['', '   ']) {
      const markup = renderToStaticMarkup(<Icon title={title} />)
      expect(root(markup)).toContain('aria-hidden="true"')
      expect(root(markup)).not.toContain('aria-label=')
      expect(root(markup)).not.toContain('role=')
      expect(markup).not.toContain('<title')
    }
  })
}

Deno.test('saved and unsaved bookmarks retain the same outline geometry', () => {
  const outline = renderToStaticMarkup(<icons.Bookmark />)
  const filled = renderToStaticMarkup(<icons.BookmarkFilled />)
  expect(outline.match(/\bd="([^"]+)"/)?.[1]).toBe(filled.match(/\bd="([^"]+)"/)?.[1])
  expect(filled).toContain('fill="currentColor"')
})
