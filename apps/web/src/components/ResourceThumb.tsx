import { useEffect, useRef, useState } from 'react'
import type { ResourceType } from '@research-portal/core'
import { thumbnailUrl } from '../api/client.ts'

const TYPE_GLYPHS: Record<string, string> = {
  document: 'M7 3h7l5 5v13H7zM14 3v5h5',
  pdf: 'M7 3h7l5 5v13H7zM14 3v5h5M9.5 13h5M9.5 16h5',
  web:
    'M12 3a9 9 0 100 18 9 9 0 000-18zM3.6 9h16.8M3.6 15h16.8M12 3c-2.5 2.4-3.8 5.4-3.8 9s1.3 6.6 3.8 9c2.5-2.4 3.8-5.4 3.8-9s-1.3-6.6-3.8-9z',
  video: 'M4 5h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2zM18 10l4-2.5v9L18 14',
  audio:
    'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  image:
    'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5-9 9',
}

const THUMB_LABELS: Record<string, string> = {
  document: 'Report',
  pdf: 'PDF',
  web: 'Web',
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  office: 'Document',
  text: 'Text',
  file: 'File',
}

/** Compact label shown immediately, before a platform thumbnail is available. */
export function resourceThumbLabel(type: ResourceType | string): string {
  return THUMB_LABELS[type] ?? 'Resource'
}

/**
 * Resource artwork used everywhere resources appear: the platform thumbnail
 * when one exists, otherwise a token-driven folio with its content type.
 */
export function ResourceThumb({
  slug,
  id,
  type,
  className = '',
  imgClassName = '',
}: {
  slug: string
  id: string
  type: ResourceType | string
  className?: string
  /** Extra classes for the image itself, e.g. `object-top` to anchor the crop. */
  imgClassName?: string
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const src = thumbnailUrl(slug, id)
  const [requestedSrc, setRequestedSrc] = useState<string | null>(null)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const requested = requestedSrc === src
  const loaded = loadedSrc === src
  const failed = failedSrc === src
  const glyph = TYPE_GLYPHS[type] ?? TYPE_GLYPHS.document
  const label = resourceThumbLabel(type)

  // Native lazy loading looks several viewports ahead. In a long card list that
  // made every large thumbnail compete at once, so the visible row was last to
  // look ready. Request only the near-viewport set, then make those eager.
  useEffect(() => {
    const node = frameRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setRequestedSrc(src)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setRequestedSrc(src)
        observer.disconnect()
      },
      { rootMargin: '160px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [src])

  return (
    <div
      ref={frameRef}
      aria-hidden='true'
      className={`rp-resource-thumb relative h-full w-full ${className}`}
    >
      <div
        className={`rp-thumb-placeholder ${
          failed ? 'rp-thumb-placeholder-static' : 'rp-thumb-placeholder-loading'
        }`}
      >
        <div className='rp-thumb-placeholder-mark'>
          <svg
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.5'
            strokeLinecap='round'
            strokeLinejoin='round'
            className='rp-thumb-placeholder-icon'
          >
            <path d={glyph} />
          </svg>
          <span className='rp-thumb-placeholder-label'>{label}</span>
        </div>
      </div>
      {requested && !failed && (
        <img
          key={src}
          src={src}
          alt=''
          loading='eager'
          fetchPriority='high'
          decoding='async'
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
          // Invisible until it genuinely loads - never a broken-image glyph.
          className={`rp-thumb-image absolute inset-0 h-full w-full object-cover ${imgClassName} ${
            loaded ? 'rp-thumb-image-loaded' : ''
          }`}
        />
      )}
    </div>
  )
}
