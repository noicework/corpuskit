import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPortalLocale, PortalLocaleContext } from '../lib/portal-locale.tsx'
import { ResourceProvenanceLabel } from './ResourceProvenanceLabel.tsx'

Deno.test('resource provenance is explicit, scoped and escaped without rewriting source text', () => {
  expect(renderToStaticMarkup(<ResourceProvenanceLabel resourceId='example' />)).toBe('')
  const locale = createPortalLocale('en', undefined, {
    resourceLabels: { example: 'Fictional <record>' },
    defaultResourceLabel: 'Published paper',
  })
  const html = renderToStaticMarkup(
    <PortalLocaleContext.Provider value={locale}>
      <ResourceProvenanceLabel resourceId='example' />
      <ResourceProvenanceLabel resourceId='other' />
    </PortalLocaleContext.Provider>,
  )
  expect(html).toContain('Fictional &lt;record&gt;')
  expect(html).toContain('Published paper')
  expect(createPortalLocale('en').resourceLabel?.('example')).toBeUndefined()
})
