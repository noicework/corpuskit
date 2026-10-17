import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RouteDecision } from '../api/client.ts'
import { createPortalLocale, PortalLocaleContext } from '../lib/portal-locale.tsx'
import { RouteChip } from './RouteChip.tsx'

const decision: RouteDecision = {
  intent: 'research',
  confidence: 0.92,
  stage: 'classifier',
  rationale: 'The question asks for research evidence.',
  configuration: 'portal-ask',
  entities: [],
}

Deno.test('a routing decision without an override is readable without an inert control', () => {
  const html = renderToStaticMarkup(<RouteChip decision={decision} intents={[]} />)
  expect(html).toContain('research')
  expect(html).toContain('classified · 92%')
  expect(html).toContain(decision.rationale)
  expect(html).not.toContain('<button')
  expect(html).not.toContain('aria-haspopup')
})

Deno.test('an overridable routing decision exposes a collapsed, named menu trigger', () => {
  const html = renderToStaticMarkup(
    <RouteChip decision={decision} intents={[]} onOverride={() => {}} />,
  )
  expect(html).toContain('<button')
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('research')
  expect(html).not.toContain('role="menu"')
})

Deno.test('routing status localises interface copy and keeps the authored intent exact', () => {
  const html = renderToStaticMarkup(
    <PortalLocaleContext.Provider value={createPortalLocale('ja')}>
      <RouteChip decision={{ ...decision, stage: 'override' }} intents={[]} />
    </PortalLocaleContext.Provider>,
  )
  expect(html).toContain('research')
  expect(html).not.toContain('chosen by you')
  expect(renderToStaticMarkup(<RouteChip decision={undefined} intents={[]} />)).toBe('')
  const pending = renderToStaticMarkup(<RouteChip decision={undefined} intents={[]} pending />)
  expect(pending).toContain('role="status"')
  expect(pending).not.toContain('<button')
})
