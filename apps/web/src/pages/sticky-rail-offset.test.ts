import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const pageSources = await Promise.all(
  ['LibraryPage.tsx', 'SearchPage.tsx', 'DocsPage.tsx', 'ResourceDetailPage.tsx'].map(
    (page) => Deno.readTextFile(new URL(page, import.meta.url)),
  ),
)

const measuredHeaderOffset = 'lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)]'
const measuredViewportHeight =
  'lg:max-h-[calc(100dvh_-_var(--rp-header-h,_4rem)_-_var(--spacing)_*_8)]'

describe('desktop sticky rail offsets', () => {
  it('keeps every rail below the measured header with a first-paint fallback', () => {
    for (const source of pageSources) {
      expect(source).toContain('lg:sticky')
      expect(source).toContain(measuredHeaderOffset)
      expect(source).not.toContain('top-20')
    }
  })

  it('keeps scrolling rails within the viewport using the same header measurement', () => {
    for (const source of pageSources.slice(2)) {
      expect(source).toContain(measuredViewportHeight)
      expect(source).not.toMatch(/max-h-\[calc\(100(?:d)?vh-6rem\)\]/)
    }
  })
})
