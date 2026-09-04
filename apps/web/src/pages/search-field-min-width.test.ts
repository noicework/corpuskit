import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const searchFieldSources = await Promise.all(
  [
    new URL('LibraryPage.tsx', import.meta.url),
    new URL('SearchPage.tsx', import.meta.url),
    new URL('admin/SourcesPanel.tsx', import.meta.url),
  ].map((page) => Deno.readTextFile(page)),
)

describe('search field minimum widths', () => {
  it('caps every comfortable 16rem floor at the available row width', () => {
    for (const source of searchFieldSources) {
      expect(source).toContain("className='min-w-[min(16rem,100%)] flex-1'")
    }
  })

  it('does not leave an absolute 16rem floor in any listing or source field', () => {
    for (const source of searchFieldSources) {
      expect(source).not.toContain("className='min-w-[16rem] flex-1'")
    }
  })
})
