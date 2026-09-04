import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { resourceThumbLabel } from './ResourceThumb.tsx'

describe('ResourceThumb', () => {
  it('labels platform content kinds without exposing raw identifiers', () => {
    expect(resourceThumbLabel('pdf')).toBe('PDF')
    expect(resourceThumbLabel('video')).toBe('Video')
    expect(resourceThumbLabel('audio')).toBe('Audio')
    expect(resourceThumbLabel('office')).toBe('Document')
    expect(resourceThumbLabel('something-new')).toBe('Resource')
  })

  it('keeps the loading treatment tenant-driven and motion-safe', async () => {
    const styles = await Deno.readTextFile(new URL('../styles.css', import.meta.url))

    expect(styles).toContain('background: var(--rp-surface-2);')
    expect(styles).toContain('border-radius: var(--rp-radius-chip);')
    expect(styles).toContain(`
  .rp-thumb-placeholder-loading::after {
    animation: none;
    background-image: none;
  }`)
    expect(styles).toContain(`
  .rp-thumb-image {
    transition: none;
  }`)
  })
})
