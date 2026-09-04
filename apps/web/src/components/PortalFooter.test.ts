import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const source = await Deno.readTextFile(new URL('PortalFooter.tsx', import.meta.url))
/** The markup only, so the doc comment explaining a rule cannot satisfy it. */
const markup = source.slice(source.indexOf('export function PortalFooter'))
const tenantLayoutSource = await Deno.readTextFile(
  new URL('../pages/TenantLayout.tsx', import.meta.url),
)

describe('PortalFooter', () => {
  it('renders from the tenant branding rather than a per-slug content table', () => {
    expect(source).toContain('branding: Branding')
    expect(source).not.toMatch(/Record<string,\s*FooterContent>/)
    expect(tenantLayoutSource).toContain('<PortalFooter branding={config.branding} />')
  })

  it('invents nothing about the organisation it belongs to', () => {
    // Link columns, legal pages, social accounts and an Acknowledgement of
    // Country belong to a real organisation. A footer that generates them is
    // asserting something the portal does not know.
    expect(markup).not.toContain('href')
    expect(markup).not.toContain('<svg')
    expect(markup).not.toMatch(/acknowledge/i)
    expect(markup).not.toMatch(/subscribe/i)
  })

  it('paints on the brand surface through the appearance tokens', () => {
    expect(markup).toContain('bg-[var(--rp-primary)]')
    expect(markup).toContain('text-[var(--rp-on-primary)]')
    // A palette need not pair white with its brand colour.
    expect(markup).not.toContain('text-white')
  })

  it('stacks on narrow viewports and guards its flex items against overflow', () => {
    expect(markup).toContain('flex-col')
    expect(markup).toContain('sm:flex-row')
    expect(markup.match(/min-w-0/g)?.length).toBe(2)
  })
})
