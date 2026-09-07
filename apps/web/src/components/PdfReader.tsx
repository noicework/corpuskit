import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { ErrorCard, LiveStatus, Skeleton } from './ui.tsx'
import { findPassageRange, passageNeedles } from '../lib/pdf-highlight.ts'

/**
 * Wiring note (see CLAUDE.md's "keep the
 * AI/retrieval layer behind an interface" spirit - this is the same idea
 * applied to a vendor dependency): pdfjs-dist is loaded exactly like the
 * project's other vendor deps - added to the browser import map in
 * apps/web/index.html and marked `--external` in the esbuild `build:js`
 * task, so esbuild leaves `import('pdfjs-dist')` untouched and the browser
 * resolves it from esm.sh at runtime. `deno check` gets types for free too:
 * esm.sh returns an `X-TypeScript-Types` header on the module response,
 * which Deno follows automatically for any HTTP(S) import.
 *
 * The one thing that does NOT work unmodified is the worker. pdfjs-dist v4
 * only ships a module worker (`new Worker(src, { type: 'module' })`
 * internally) - there is no classic-script fallback to point
 * GlobalWorkerOptions.workerSrc at. A cross-origin *classic* worker script
 * would be blocked by the same-origin policy, but a cross-origin *module*
 * worker is fetched in CORS mode, and esm.sh serves
 * `Access-Control-Allow-Origin: *` - so pointing workerSrc straight at the
 * esm.sh-hosted worker file works with no proxy/blob-URL trick. Verified
 * directly: `curl -sI https://esm.sh/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs`
 * returns 200 with `access-control-allow-origin: *`, and the built
 * apps/web/dist/app.js contains an untouched `import("pdfjs-dist")` (esbuild
 * left it external), confirmed by grepping the built bundle.
 *
 * pdfjs-dist is imported dynamically (not statically at module scope) so its
 * ~600KB module is only fetched when a reader actually mounts a PDF, not on
 * every resource page. If the import or worker registration throws at
 * runtime (CDN hiccup, a browser that blocks cross-origin module workers),
 * `PdfReader` falls back to the plain `<iframe>` this component replaced -
 * the fallback the task calls out explicitly.
 *
 * Trade-off carried forward rather than solved: pdfjs's CMap and standard
 * font data files (needed for some non-Latin scripts and PDFs that don't
 * embed their fonts) are not code, so esm.sh doesn't serve them from this
 * package (verified: both return 404). They're left unset here, which means
 * those specific PDFs may render with substituted fonts or missing glyphs.
 * Every PDF in both tenant corpora is Latin-script with embedded fonts, so
 * this doesn't show up in practice today; it would need its own CDN path
 * (e.g. jsDelivr's raw npm mirror) if a CJK/non-embedded-font corpus shows up.
 */
const PDFJS_VERSION = '4.9.155'
const WORKER_SRC = `https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`

type PdfjsModule = typeof import('pdfjs-dist')

let pdfjsModulePromise: Promise<PdfjsModule> | null = null

/** Lazily imports pdfjs-dist once per page load and points it at its worker. */
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModulePromise ??= import('pdfjs-dist').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = WORKER_SRC
    return mod
  })
  return pdfjsModulePromise
}

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const ZOOM_STEP = 1.2

type ZoomMode = 'fit-width' | { scale: number }

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Renders a hidden iframe pointed at the PDF and prints it via the browser's
 * native PDF plugin, so the print output is the real vector document (every
 * page, selectable text) rather than a raster of whichever page is on
 * screen. `window.print()` on this page would only capture the current DOM,
 * and a `<canvas>` region print loses vector quality and can only print one
 * page at a time - neither is a real substitute for printing the source
 * file, so this is the approach that actually works. */
function printFile(fileUrl: string) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.src = fileUrl
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } catch {
      globalThis.open(fileUrl, '_blank', 'noopener,noreferrer')
    }
    globalThis.setTimeout(() => iframe.remove(), 2000)
  }
  document.body.appendChild(iframe)
}

function ToolbarButton(
  { label, onClick, disabled, children }: {
    label: string
    onClick: () => void
    disabled?: boolean
    children: ReactNode
  },
) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className='rp-focus rp-btn rp-btn-ghost h-8 w-8 shrink-0 !px-0'
    >
      {children}
    </button>
  )
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className: 'h-4 w-4',
}

/** Inline PDF viewer built on pdfjs-dist, canvas-rendering one page at a
 * time. Falls back to the plain iframe embed (`fallback`) whenever pdfjs
 * cannot be loaded or fails to open the document. */
/** A highlight box over the rendered page, in CSS pixels of the canvas. */
interface HighlightRect {
  left: number
  top: number
  width: number
  height: number
}

/** The shape of a pdfjs text-content item that carries text and a position. */
interface PositionedRun {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

/** How many pages to search for a passage when the citation carries no page number. */
const PASSAGE_SCAN_LIMIT = 80

export function PdfReader(
  { fileUrl, title, initialPage, highlight = null, onLoadError }: {
    fileUrl: string
    title: string
    initialPage: number | null
    /**
     * The cited passage. When set, the viewer locates it in the page's text
     * layer and paints a highlight over it - and, if no page was given, scans
     * the document for the page that carries it.
     */
    highlight?: string | null
    /**
     * The document could not be opened or rendered, so this viewer is showing
     * an error rather than the file. The page above uses it to fall back to
     * the extracted text, which is then the only reading available.
     */
    onLoadError?: () => void
  },
) {
  const [libFailed, setLibFailed] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const [numPages, setNumPages] = useState(0)
  const [pageNumber, setPageNumber] = useState(initialPage && initialPage > 0 ? initialPage : 1)
  const [pageInput, setPageInput] = useState(String(pageNumber))
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width')
  const [announcement, setAnnouncement] = useState('')

  const docRef = useRef<PDFDocumentProxy | null>(null)
  const pageCacheRef = useRef(new Map<number, Promise<PDFPageProxy>>())
  const renderTaskRef = useRef<RenderTask | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  /** The scale the current page was last rendered at - the source of truth
   * for "current zoom" when the user zooms in/out from fit-width, since
   * fit-width itself has no single fixed scale. */
  const effectiveScaleRef = useRef(1)
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([])
  const [highlightPage, setHighlightPage] = useState<number | null>(null)
  /**
   * A deep link named a page but the passage is not on it (the citation's
   * page index was off, or the text layer differs). Said out loud, with a
   * way to search the document, rather than landing there in silence.
   */
  const [highlightMissing, setHighlightMissing] = useState(false)
  const [scanRequested, setScanRequested] = useState(false)
  const [scanOutcome, setScanOutcome] = useState<'idle' | 'searching' | 'not-found'>('idle')
  /** Guards the one-off passage scan so paging never re-triggers it. */
  const scannedForRef = useRef<string | null>(null)
  /**
   * The page+passage the viewer has already scrolled to. A cited passage
   * halfway down an A4 page sits below the fold of this pane, so landing on
   * the right page is not enough - the highlight itself has to be brought
   * into view, once, without fighting the reader's own scrolling afterwards
   * (a zoom or a resize re-renders the same page and must not yank it back).
   */
  const scrolledToHighlightRef = useRef<string | null>(null)
  /**
   * The file+passage the page itself has already been scrolled to. The viewer
   * pane sits below the title and the quoted passage, so a cited passage can
   * be perfectly placed inside the pane and still be off the bottom of the
   * window - the page has to come to the reader once, on arrival. Paging back
   * to the cited page later must not yank the window again.
   */
  const scrolledPageToReaderRef = useRef<string | null>(null)

  // Load the document whenever the file or retry token changes.
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setLibFailed(false)
    docRef.current = null
    pageCacheRef.current = new Map()

    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url: fileUrl }).promise)
      .then((doc) => {
        if (cancelled) return
        docRef.current = doc
        setNumPages(doc.numPages)
        const start = initialPage && initialPage > 0 && initialPage <= doc.numPages
          ? initialPage
          : 1
        setPageNumber(start)
        setPageInput(String(start))
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        // A failure to even import the module or start the worker means the
        // canvas renderer cannot work at all here - fall back to the iframe
        // rather than showing an error for something the browser itself can
        // usually still display natively.
        if (!pdfjsModulePromise) {
          setLibFailed(true)
          return
        }
        setErrorMessage(err instanceof Error ? err.message : 'This PDF could not be opened.')
        setStatus('error')
        onLoadError?.()
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl, retryToken])

  // Jump to a new deep-linked page (e.g. a different matched-passage click)
  // once the document is already open.
  useEffect(() => {
    if (status !== 'ready' || !initialPage || initialPage < 1) return
    const doc = docRef.current
    const target = doc ? Math.min(initialPage, doc.numPages) : initialPage
    setPageNumber(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage])

  useEffect(() => {
    setPageInput(String(pageNumber))
    if (numPages > 0) setAnnouncement(`Page ${pageNumber} of ${numPages}`)
  }, [pageNumber, numPages])

  // Track the reader's width for fit-width zoom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setContainerWidth(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const getPage = useCallback((n: number): Promise<PDFPageProxy> | null => {
    const doc = docRef.current
    if (!doc) return null
    let cached = pageCacheRef.current.get(n)
    if (!cached) {
      cached = doc.getPage(n)
      pageCacheRef.current.set(n, cached)
    }
    return cached
  }, [])

  // Render the current page whenever it, the zoom, or the container width
  // changes. Only the current page is ever drawn to canvas; neighbouring
  // pages are merely pre-fetched (their PDFPageProxy warmed, not rendered)
  // so paging forward/back feels instant without keeping a 200-page report's
  // worth of canvases in memory.
  useEffect(() => {
    if (status !== 'ready' || containerWidth === 0) return
    const pagePromise = getPage(pageNumber)
    if (!pagePromise) return
    let cancelled = false

    pagePromise.then(async (page) => {
      if (cancelled) return
      const canvas = canvasRef.current
      if (!canvas) return

      const baseViewport = page.getViewport({ scale: 1 })
      const scale = clampScale(
        zoomMode === 'fit-width' ? containerWidth / baseViewport.width : zoomMode.scale,
      )
      const viewport = page.getViewport({ scale })
      effectiveScaleRef.current = scale

      const outputScale = globalThis.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      renderTaskRef.current?.cancel()
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      })
      renderTaskRef.current = task
      try {
        await task.promise
        if (cancelled) return
        if (highlight && passageNeedles(highlight).length > 0) {
          const content = await page.getTextContent()
          if (cancelled) return
          const runs = content.items as PositionedRun[]
          const range = findPassageRange(runs.map((r) => ({ str: r.str ?? '' })), highlight)
          if (range) {
            const rects: HighlightRect[] = []
            for (let i = range.start; i <= range.end; i++) {
              const run = runs[i]
              const t = run?.transform
              if (!run || !t || !run.str?.trim()) continue
              const x = t[4] ?? 0
              const y = t[5] ?? 0
              const h = run.height || Math.hypot(t[1] ?? 0, t[3] ?? 0) || 10
              const w = run.width || 0
              const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([x, y, x + w, y + h])
              rects.push({
                left: Math.min(x1, x2),
                top: Math.min(y1, y2),
                width: Math.abs(x2 - x1),
                height: Math.abs(y2 - y1),
              })
            }
            setHighlightRects(rects)
            setHighlightPage(pageNumber)
            setHighlightMissing(false)
            const firstRect = rects[0]
            if (firstRect) {
              setAnnouncement(`Cited passage highlighted on page ${pageNumber}`)
              scrollHighlightIntoView(canvas, firstRect, `${fileUrl}::${pageNumber}::${highlight}`)
            }
          } else {
            setHighlightRects([])
            setHighlightPage(null)
            // The deep-linked page (clamped: a citation can name a page the
            // file does not have) is on screen and the passage is not on it.
            if (initialPage && pageNumber === Math.min(initialPage, numPages || initialPage)) {
              setHighlightMissing(true)
              setAnnouncement(`Highlight not found on page ${pageNumber}`)
            }
          }
        }
      } catch (err) {
        // A cancelled render (superseded by a newer page/zoom) is expected
        // and not an error.
        const isCancellation = err instanceof Error && err.name === 'RenderingCancelledException'
        if (!cancelled && !isCancellation) {
          setErrorMessage(err instanceof Error ? err.message : 'This page could not be rendered.')
          setStatus('error')
          onLoadError?.()
        }
      }
    })

    // Warm the neighbours so Next/Previous doesn't wait on a fresh fetch.
    getPage(pageNumber + 1)
    if (pageNumber > 1) getPage(pageNumber - 1)

    return () => {
      cancelled = true
    }
  }, [status, pageNumber, zoomMode, containerWidth, getPage, highlight, initialPage, numPages])

  // A citation with a passage but no page - or one whose page did not carry
  // the passage and the reader asked for a search: find the page that
  // carries it, once per document, scanning from the front within a sane
  // limit.
  useEffect(() => {
    if (status !== 'ready' || (initialPage && !scanRequested) || !highlight) return
    const key = `${fileUrl}::${highlight}::${scanRequested}`
    if (scannedForRef.current === key) return
    scannedForRef.current = key
    if (passageNeedles(highlight).length === 0) return
    let cancelled = false
    if (scanRequested) setScanOutcome('searching')
    ;(async () => {
      const limit = Math.min(numPages, PASSAGE_SCAN_LIMIT)
      for (let n = 1; n <= limit && !cancelled; n++) {
        const pagePromise = getPage(n)
        if (!pagePromise) return
        const content = await (await pagePromise).getTextContent()
        const runs = content.items as PositionedRun[]
        if (findPassageRange(runs.map((r) => ({ str: r.str ?? '' })), highlight)) {
          if (!cancelled) {
            setPageNumber(n)
            setHighlightMissing(false)
            setScanOutcome('idle')
          }
          return
        }
      }
      if (!cancelled && scanRequested) {
        setScanOutcome('not-found')
        setAnnouncement(`The passage was not found in the first ${limit} pages`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status, initialPage, scanRequested, highlight, numPages, getPage, fileUrl])

  /**
   * Brings the first highlighted run into view inside the viewer's own scroll
   * pane. Scrolls the pane, never the page: the reader arrived here to see the
   * document, so the document is what moves. Runs once per page+passage.
   */
  function scrollHighlightIntoView(canvas: HTMLCanvasElement, rect: HighlightRect, key: string) {
    const scroller = containerRef.current
    if (!scroller || scrolledToHighlightRef.current === key) return
    scrolledToHighlightRef.current = key
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ===
      true

    const canvasBox = canvas.getBoundingClientRect()
    const scrollBox = scroller.getBoundingClientRect()
    const top = scroller.scrollTop + (canvasBox.top - scrollBox.top) + rect.top
    const left = scroller.scrollLeft + (canvasBox.left - scrollBox.left) + rect.left
    const overflowsHorizontally = scroller.scrollWidth - scroller.clientWidth > 1
    scroller.scrollTo({
      // A quarter of the pane above the passage, so it reads in context rather
      // than pinned to the very top edge.
      top: Math.max(0, top - scroller.clientHeight * 0.25),
      left: overflowsHorizontally ? Math.max(0, left - scroller.clientWidth * 0.25) : 0,
      behavior: reducedMotion ? 'auto' : 'smooth',
    })

    // Then bring the viewer itself under the sticky header, once per arrival:
    // the pane can be scrolled perfectly and still sit below the fold, since
    // it opens under the title and the quoted passage. A frame later, and via
    // scrollTo rather than scrollIntoView, because Chrome cancels a smooth
    // scrollIntoView on the document when a nested box starts its own smooth
    // scroll in the same task (measured, not assumed). The offset is the
    // root's own scroll-margin, so the header height stays a token.
    const arrivalKey = `${fileUrl}::${highlight}`
    if (scrolledPageToReaderRef.current !== arrivalKey) {
      scrolledPageToReaderRef.current = arrivalKey
      requestAnimationFrame(() => {
        const root = rootRef.current
        if (!root) return
        const margin = Number.parseFloat(getComputedStyle(root).scrollMarginTop) || 0
        globalThis.scrollTo({
          top: Math.max(0, globalThis.scrollY + root.getBoundingClientRect().top - margin),
          behavior: reducedMotion ? 'auto' : 'smooth',
        })
      })
    }
  }

  function goToPage(n: number) {
    setPageNumber(Math.min(Math.max(1, n), Math.max(1, numPages)))
  }

  function commitPageInput() {
    const parsed = Number.parseInt(pageInput, 10)
    if (Number.isFinite(parsed)) goToPage(parsed)
    else setPageInput(String(pageNumber))
  }

  function zoomIn() {
    setZoomMode({ scale: clampScale(effectiveScaleRef.current * ZOOM_STEP) })
  }

  function zoomOut() {
    setZoomMode({ scale: clampScale(effectiveScaleRef.current / ZOOM_STEP) })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goToPage(pageNumber - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goToPage(pageNumber + 1)
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomIn()
    } else if (event.key === '-') {
      event.preventDefault()
      zoomOut()
    }
  }

  if (libFailed) {
    return (
      <iframe
        src={initialPage ? `${fileUrl}#page=${initialPage}` : fileUrl}
        className='h-[60vh] w-full rounded-[var(--rp-radius)] border border-line bg-surface sm:h-[75vh]'
        title={title}
      />
    )
  }

  const zoomPercent = zoomMode === 'fit-width' ? null : Math.round(zoomMode.scale * 100)

  return (
    <div
      ref={rootRef}
      className='scroll-mt-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_2)] overflow-hidden rounded-[var(--rp-radius)] border border-line bg-surface'
    >
      <div className='flex flex-wrap items-center gap-1 border-b border-line bg-surface-2 px-2 py-1.5'>
        <ToolbarButton
          label='Previous page'
          onClick={() => goToPage(pageNumber - 1)}
          disabled={status !== 'ready' || pageNumber <= 1}
        >
          <svg {...ICON_PROPS}>
            <path d='M15 18l-6-6 6-6' />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          label='Next page'
          onClick={() => goToPage(pageNumber + 1)}
          disabled={status !== 'ready' || pageNumber >= numPages}
        >
          <svg {...ICON_PROPS}>
            <path d='M9 6l6 6-6 6' />
          </svg>
        </ToolbarButton>

        <div className='mx-1 flex items-center gap-1.5 text-xs text-ink-2'>
          <label htmlFor='pdf-page-input' className='sr-only'>Page number</label>
          <input
            id='pdf-page-input'
            type='text'
            inputMode='numeric'
            value={pageInput}
            disabled={status !== 'ready'}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitPageInput()
              }
            }}
            className='rp-focus h-7 w-10 rounded-[var(--rp-radius)] border border-line bg-surface text-center text-xs tabular-nums text-ink'
          />
          <span className='tabular-nums'>of {numPages || '–'}</span>
        </div>

        <div className='mx-1 h-4 w-px bg-line' aria-hidden='true' />

        <ToolbarButton label='Zoom out' onClick={zoomOut} disabled={status !== 'ready'}>
          <svg {...ICON_PROPS}>
            <circle cx='11' cy='11' r='7' />
            <path d='M21 21l-4.3-4.3M8 11h6' />
          </svg>
        </ToolbarButton>
        <span className='w-11 shrink-0 text-center text-xs tabular-nums text-ink-2'>
          {zoomPercent ? `${zoomPercent}%` : 'Fit'}
        </span>
        <ToolbarButton label='Zoom in' onClick={zoomIn} disabled={status !== 'ready'}>
          <svg {...ICON_PROPS}>
            <circle cx='11' cy='11' r='7' />
            <path d='M21 21l-4.3-4.3M11 8v6M8 11h6' />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          label='Fit to width'
          onClick={() => setZoomMode('fit-width')}
          disabled={status !== 'ready'}
        >
          <svg {...ICON_PROPS}>
            <path d='M4 8V5a1 1 0 011-1h3M20 8V5a1 1 0 00-1-1h-3M4 16v3a1 1 0 001 1h3m12-4v3a1 1 0 01-1 1h-3' />
          </svg>
        </ToolbarButton>

        <div className='mx-1 h-4 w-px bg-line' aria-hidden='true' />

        <ToolbarButton label='Print' onClick={() => printFile(fileUrl)}>
          <svg {...ICON_PROPS}>
            <path d='M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-5a1 1 0 011-1h16a1 1 0 011 1v5a1 1 0 01-1 1h-2M6 14h12v7H6z' />
          </svg>
        </ToolbarButton>
        <a
          href={fileUrl}
          download
          aria-label='Download PDF'
          title='Download PDF'
          className='rp-focus rp-btn rp-btn-ghost h-8 w-8 shrink-0 !px-0'
        >
          <svg {...ICON_PROPS}>
            <path d='M12 3v12m0 0l-4-4m4 4l4-4M5 21h14' />
          </svg>
        </a>
        <a
          href={initialPage ? `${fileUrl}#page=${initialPage}` : fileUrl}
          target='_blank'
          rel='noopener noreferrer'
          aria-label='Open PDF in a new tab'
          title='Open in a new tab'
          className='rp-focus rp-btn rp-btn-ghost h-8 w-8 shrink-0 !px-0'
        >
          <svg {...ICON_PROPS}>
            <path d='M14 4h6v6M10 14L20 4M19 13v6a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1h6' />
          </svg>
        </a>
      </div>

      <LiveStatus message={announcement} />

      {highlightMissing && highlight
        ? (
          <div
            role='status'
            className='flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs'
            style={{
              borderColor: 'var(--rp-warn-line)',
              background: 'var(--rp-warn-bg)',
              color: 'var(--rp-warn-ink)',
            }}
          >
            <span className='font-medium'>Highlight not found on this page.</span>
            {scanOutcome === 'searching'
              ? <span>Searching the document for the passage…</span>
              : scanOutcome === 'not-found'
              ? (
                <span>
                  It was not found in the first {Math.min(numPages, PASSAGE_SCAN_LIMIT)}{' '}
                  pages either - the cited text may differ from this file's text layer.
                </span>
              )
              : (
                <button
                  type='button'
                  onClick={() => setScanRequested(true)}
                  className='rp-focus inline-flex min-h-6 items-center rounded-[var(--rp-radius-btn)] font-medium underline decoration-dotted underline-offset-2'
                >
                  Find it in the document
                </button>
              )}
          </div>
        )
        : null}

      <div
        ref={containerRef}
        className='rp-scroll max-h-[75vh] overflow-auto bg-surface-2 sm:max-h-[80vh]'
      >
        {status === 'loading'
          ? (
            <div className='space-y-3 p-6'>
              <Skeleton className='mx-auto h-[50vh] w-full max-w-2xl sm:h-[65vh]' />
            </div>
          )
          : null}

        {status === 'error'
          ? (
            <div className='space-y-3 p-5'>
              <ErrorCard
                message={errorMessage}
                onRetry={() => setRetryToken((t) => t + 1)}
              />
              <a
                href={fileUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='rp-focus inline-block text-sm font-medium text-[var(--rp-ink-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--rp-ink)]'
              >
                Open PDF in a new tab instead
              </a>
            </div>
          )
          : null}

        <div
          role='group'
          aria-label={`${title} - PDF page ${pageNumber} of ${numPages || 1}`}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className={`rp-focus flex justify-center p-4 ${status === 'ready' ? '' : 'hidden'}`}
        >
          <div className='relative'>
            <canvas ref={canvasRef} className='rp-shadow-sm bg-white' />
            {highlightPage === pageNumber
              ? highlightRects.map((rect, i) => (
                <div
                  key={i}
                  aria-hidden='true'
                  data-pdf-highlight=''
                  className='pointer-events-none absolute rounded-[2px]'
                  style={{
                    left: rect.left - 1,
                    top: rect.top - 1,
                    width: rect.width + 2,
                    height: rect.height + 2,
                    backgroundColor: 'var(--rp-accent)',
                    opacity: 0.3,
                    mixBlendMode: 'multiply',
                  }}
                />
              ))
              : null}
          </div>
        </div>
      </div>
    </div>
  )
}
