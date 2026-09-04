import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const [graphPage, entityPage] = await Promise.all(
  ['GraphPage.tsx', 'EntityPage.tsx'].map((page) =>
    Deno.readTextFile(new URL(page, import.meta.url))
  ),
)

const mentionedInPages = [graphPage, entityPage]
const a4Frame =
  "className='relative aspect-[210/297] w-[4.5rem] shrink-0 self-start overflow-hidden border border-line'"

describe('Mentioned in resource thumbnails', () => {
  it('uses the reserved A4 document frame on both surfaces', () => {
    for (const page of mentionedInPages) {
      expect(page).toContain(a4Frame)
      expect(page).toContain("imgClassName='object-top'")
      expect(page).toContain("aria-hidden='true'")
    }
  })

  it('keeps the entity thumbnail visible at phone widths', () => {
    expect(entityPage).not.toContain("className='hidden h-16 w-24")
  })

  it('keeps the narrow graph card text flexible and keyboard focus visible', () => {
    expect(graphPage).toContain("className='rp-focus flex gap-2.5")
    expect(graphPage).toContain("<div className='min-w-0 flex-1'>")
  })
})
