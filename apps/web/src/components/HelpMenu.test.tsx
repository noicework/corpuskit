import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { HelpMenu } from './HelpMenu.tsx'

Deno.test('help trigger names no menu while the menu is not mounted', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/t/example']}>
      <HelpMenu slug='example' />
    </MemoryRouter>,
  )
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('aria-expanded="false"')
  // The menu renders only while open, so a closed trigger pointing at it would be broken.
  expect(html).not.toContain('role="menu"')
  expect(html).not.toContain('aria-controls')
})
