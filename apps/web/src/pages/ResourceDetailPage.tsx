import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import type {
  Citation,
  ResourceContent,
  ResourceSummary,
  ScoredResource,
} from '@research-portal/core'
import {
  ApiError,
  getResource,
  getResourceContent,
  getResourceQuestions,
  resourceFileUrl,
  searchTenantFull,
} from '../api/client.ts'
import { AnswerStream } from '../components/AnswerStream.tsx'
import { PdfReader } from '../components/PdfReader.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { SaveEvidenceButton } from '../components/SaveEvidence.tsx'
import {
  EmptyState,
  ErrorCard,
  prettyLabel,
  sameLabel,
  Skeleton,
  TypeBadge,
  typeLabel,
} from '../components/ui.tsx'
import {
  blockPlainText,
  blocksWithinBudget,
  buildRelatedQuery,
  type DocBlock,
  parseDocBlocks,
  selectRecommendations,
  selectViewerVariant,
} from '../lib/resource-view.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'
import { useResizableRail } from '../components/useResizableRail.ts'

/** Publish year from an ISO date, or null when the date is missing/unparseable. */
function formatYear(iso: string): string | null {
  const match = /^(\d{4})/.exec(iso)
  return match ? match[1] ?? null : null
}

/**
 * The funder's project number embedded in a title, e.g. "...ABC 2018-190..." ->
 * "2018-190". Funding bodies code their projects `YYYY-NNN` behind their own
 * acronym, so the acronym is what tells a project number apart from a date
 * range or a page span: a bare "2018-190" is not enough to claim one, and this
 * returns null for it.
 */
export function projectNumber(title: string): string | null {
  const match = /\b[A-Z]{2,6}\s*((?:19|20)\d{2}-\d{3})\b/.exec(title)
  return match ? match[1] ?? null : null
}

/** Lowercase + collapse whitespace, so passage matching survives punctuation/whitespace drift. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The matchable fragment of a `?passage=` value: normalised, first 40 characters. */
function passageNeedle(passage: string | null): string | null {
  if (!passage) return null
  const normalised = normalise(passage)
  return normalised.length > 0 ? normalised.slice(0, 40) : null
}

/** Significant words from a `?q=` search query - short/noise tokens are dropped. */
function queryTerms(query: string | null): string[] {
  if (!query) return []
  const words = normalise(query).split(/\s+/).filter((w) => w.length >= 3)
  return Array.from(new Set(words))
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

/** Small eyebrow section label used on every panel in this view. */
function PanelHeading({ children }: { children: ReactNode }) {
  return <h2 className='rp-eyebrow text-ink-3'>{children}</h2>
}

/**
 * Inline markdown (bold, italic, inline code, links) rendered as React nodes -
 * never as raw HTML, so authored emphasis reads correctly without an injection
 * surface. Anything it does not recognise is passed straight through as text.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const k = `${keyPrefix}-${key++}`
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={k}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={k}
          className='rounded-[var(--rp-radius-chip)] bg-surface-2 px-1 py-0.5 text-[0.85em]'
        >
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link) {
        nodes.push(
          <a
            key={k}
            href={link[2]}
            target='_blank'
            rel='noopener noreferrer'
            className='rp-focus rounded-[var(--rp-radius)] underline decoration-dotted underline-offset-2'
            style={{ color: 'var(--rp-accent-fg)' }}
          >
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(<em key={k}>{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'rp-display text-xl text-ink mt-6 first:mt-0',
  2: 'rp-display text-lg text-ink mt-6 first:mt-0',
  3: 'font-semibold text-base text-ink mt-5',
  4: 'font-semibold text-sm text-ink mt-4',
  5: 'font-semibold text-sm text-ink mt-4',
  6: 'font-semibold text-sm text-ink-2 mt-4',
}

/**
 * Renders one parsed document block, anchored `doc-block-{index}` so the
 * "Matches" rail and passage highlighting can scroll to it, with a transient
 * flash and a persistent passage highlight when this block is the target.
 */
function DocBlockView(
  { block, emphasised, setRef }: {
    block: DocBlock
    emphasised: boolean
    setRef: ((el: HTMLElement | null) => void) | undefined
  },
) {
  const emphasisClass = emphasised
    ? 'rounded-[var(--rp-radius)] border-l-2 py-1.5 pl-3 pr-2 text-ink'
    : ''
  const emphasisStyle = emphasised
    ? {
      borderColor: 'var(--rp-accent)',
      backgroundColor: 'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))',
    }
    : undefined
  const base = `doc-block scroll-mt-24 transition-colors duration-700 ${emphasisClass}`
  const id = `doc-block-${block.index}`

  switch (block.kind) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level))
      const Tag = `h${level}` as 'h2'
      return (
        <Tag
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`${HEADING_CLASSES[level]} ${base}`}
        >
          {renderInline(block.text, `h-${block.index}`)}
        </Tag>
      )
    }
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul'
      const markerClass = block.ordered ? 'list-decimal' : 'list-disc'
      return (
        <ListTag
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`${base} ${markerClass} space-y-1.5 pl-6`}
        >
          {block.items.map((item, i) => (
            <li key={i} className='pl-1'>
              {renderInline(item.text, `li-${block.index}-${i}`)}
              {item.children.length > 0
                ? (
                  <ul className='mt-1.5 list-[circle] space-y-1.5 pl-5'>
                    {item.children.map((child, c) => (
                      <li key={c} className='pl-1'>
                        {renderInline(child, `li-${block.index}-${i}-${c}`)}
                      </li>
                    ))}
                  </ul>
                )
                : null}
            </li>
          ))}
        </ListTag>
      )
    }
    case 'table':
      return (
        <div id={id} ref={setRef} style={emphasisStyle} className={`${base} overflow-x-auto`}>
          <table className='w-full border-collapse text-sm'>
            <thead>
              <tr>
                {block.headers.map((h, i) => (
                  <th
                    key={i}
                    className='border-b border-line px-3 py-2 text-left font-semibold text-ink'
                  >
                    {renderInline(h, `th-${block.index}-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className='border-b border-line px-3 py-2 align-top text-ink-2'>
                      {renderInline(cell, `td-${block.index}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'code':
      return (
        <pre
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`${base} overflow-x-auto rounded-[var(--rp-radius)] bg-surface-2 p-3 text-xs leading-relaxed text-ink-2`}
        >
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`break-words ${base} border-l-2 border-line pl-3 italic text-ink-2`}
        >
          {renderInline(block.text, `q-${block.index}`)}
        </blockquote>
      )
    default:
      return (
        <p id={id} ref={setRef} style={emphasisStyle} className={`${base} leading-relaxed`}>
          {renderInline(block.text, `p-${block.index}`)}
        </p>
      )
  }
}

// How much extracted text the reader renders at a time. Long documents carry
// hundreds of thousands of characters; parsing all of it through the inline
// renderer in one go locks the main thread for seconds, so the reader shows
// the blocks that fit this budget and grows it on request. (Pattern ported
// from the vccmhw-ksp reader.)
const READER_CHUNK_CHARS = 40_000
const READER_STEP_CHARS = 120_000

/**
 * The structured reading pane for an authored/extracted document body. Renders
 * parsed markdown blocks (headings, lists, tables, quotes) rather than a
 * flattened text dump, while keeping the passage/`?q=` highlight and the
 * jump-to-block behaviour. A leading level-1 heading equal to the resource
 * title is dropped, since the page shows the title in its own header.
 *
 * Only the leading slice of a long document renders at first, with a
 * "Show more" control beneath it; a passage highlight or a jump from the
 * Matches rail that lands beyond the slice extends it automatically so deep
 * links always resolve.
 */
function DocumentReader(
  { blocks, title, passage, flashIndex }: {
    blocks: DocBlock[]
    title: string
    passage: string | null
    flashIndex: number | null
  },
) {
  const highlightRef = useRef<HTMLElement | null>(null)
  const needle = passageNeedle(passage)
  const highlightIndex = needle
    ? blocks.findIndex((block) => normalise(blockPlainText(block)).includes(needle))
    : -1

  const [budget, setBudget] = useState(READER_CHUNK_CHARS)
  const blockLengths = useMemo(() => blocks.map((block) => blockPlainText(block).length), [blocks])
  const totalChars = useMemo(
    () => blockLengths.reduce((sum, length) => sum + length, 0),
    [blockLengths],
  )
  // The rendered slice always reaches the highlight/jump target, so a deep
  // link into the back of a long document never lands on an unrendered block.
  const visibleCount = Math.max(
    blocksWithinBudget(blockLengths, budget),
    highlightIndex + 1,
    (flashIndex ?? -1) + 1,
  )
  const shownChars = useMemo(
    () => blockLengths.slice(0, visibleCount).reduce((sum, length) => sum + length, 0),
    [blockLengths, visibleCount],
  )

  useEffect(() => {
    if (highlightIndex < 0) return
    highlightRef.current?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex])

  // A jump can extend the slice in the same render, so the target block may
  // not exist when the page's own scroll call fires - scroll again once it
  // has mounted.
  useEffect(() => {
    if (flashIndex === null || flashIndex < 0) return
    const frame = requestAnimationFrame(() => {
      document.getElementById(`doc-block-${flashIndex}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [flashIndex])

  if (blocks.length === 0) {
    return <p className='text-sm text-ink-3'>No readable text is available for this document.</p>
  }

  const titleNorm = normalise(title)
  return (
    <div>
      <div className='rp-prose rp-measure text-sm text-ink-2'>
        {blocks.slice(0, visibleCount).map((block, i) => {
          if (
            i === 0 && block.kind === 'heading' && block.level === 1 &&
            normalise(block.text) === titleNorm
          ) {
            return null
          }
          const emphasised = block.index === highlightIndex || block.index === flashIndex
          return (
            <DocBlockView
              key={block.index}
              block={block}
              emphasised={emphasised}
              setRef={block.index === highlightIndex
                ? (el) => (highlightRef.current = el)
                : undefined}
            />
          )
        })}
      </div>
      {visibleCount < blocks.length
        ? (
          <div className='mt-4 flex flex-wrap items-center gap-3'>
            <button
              type='button'
              onClick={() => setBudget((current) => current + READER_STEP_CHARS)}
              className='rp-btn rp-btn-outline'
            >
              Show more
            </button>
            <span className='text-xs tabular-nums text-ink-3'>
              Showing {shownChars.toLocaleString()} of {totalChars.toLocaleString()} characters
            </span>
          </div>
        )
        : null}
    </div>
  )
}

/**
 * Timed transcript for video/audio resources: a search filter, a scrollable
 * segment list, and click-to-seek on the shared media ref. A matching
 * `?passage=` auto-highlights and seeks (without playing) on load.
 */
function TranscriptPanel(
  { transcript, mediaRef, passage }: {
    transcript: { text: string; startSec?: number }[]
    mediaRef: RefObject<HTMLMediaElement | null>
    passage: string | null
  },
) {
  const [search, setSearch] = useState('')
  const rowRefs = useRef(new Map<number, HTMLButtonElement>())

  const needle = passageNeedle(passage)
  const highlightIndex = needle
    ? transcript.findIndex((segment) => {
      const segmentNorm = normalise(segment.text)
      return segmentNorm.includes(needle) ||
        (segmentNorm.length > 0 && needle.includes(segmentNorm))
    })
    : -1

  useEffect(() => {
    if (highlightIndex < 0) return
    rowRefs.current.get(highlightIndex)?.scrollIntoView({ block: 'center' })
    const startSec = transcript[highlightIndex]?.startSec
    if (mediaRef.current && startSec !== undefined) {
      mediaRef.current.currentTime = startSec
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex])

  function seekTo(startSec: number | undefined) {
    const media = mediaRef.current
    if (!media || startSec === undefined) return
    media.currentTime = startSec
    void media.play()
  }

  const trimmedSearch = search.trim().toLowerCase()
  const rows = transcript
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) =>
      trimmedSearch.length === 0 || segment.text.toLowerCase().includes(trimmedSearch)
    )

  return (
    <div className='rp-card mt-5 p-5'>
      <PanelHeading>Transcript</PanelHeading>

      <label htmlFor='transcript-search' className='sr-only'>
        Search the transcript
      </label>
      <input
        id='transcript-search'
        type='text'
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder='Search the transcript'
        className='rp-input mt-3'
      />

      <div className='mt-3 max-h-96 overflow-y-auto rounded-[var(--rp-radius)] border border-line'>
        {rows.length === 0
          ? <p className='p-4 text-sm text-ink-3'>No matching transcript segments.</p>
          : (
            <ul className='divide-y divide-[var(--rp-line)]'>
              {rows.map(({ segment, index }) => {
                const isHighlighted = index === highlightIndex
                return (
                  <li key={index}>
                    <button
                      type='button'
                      ref={(el) => {
                        if (el) rowRefs.current.set(index, el)
                        else rowRefs.current.delete(index)
                      }}
                      onClick={() => seekTo(segment.startSec)}
                      className='flex w-full items-start gap-3 px-3.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
                      style={isHighlighted
                        ? {
                          backgroundColor:
                            'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))',
                        }
                        : undefined}
                    >
                      <span className='shrink-0 rounded-[var(--rp-radius-chip)] bg-surface-2 px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink-3'>
                        {segment.startSec !== undefined
                          ? formatTimestamp(segment.startSec)
                          : '--:--'}
                      </span>
                      <span className='text-ink-2'>{segment.text}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    </div>
  )
}

/**
 * The matched passage quoted above the PDF viewer - PDFs bury the same
 * highlight far below a tall canvas, so the reader would otherwise never see
 * it without scrolling past the embed first.
 */
function MatchedPassageCard({ passage, page }: { passage: string; page: number | null }) {
  return (
    <div className='rp-card p-4'>
      <p className='rp-eyebrow text-ink-3'>Matched passage</p>
      <blockquote
        className='break-words mt-2 text-sm leading-relaxed text-ink-2'
        style={{ borderColor: 'var(--rp-accent)' }}
      >
        &ldquo;{passage}&rdquo;
      </blockquote>
      {page
        ? <p className='mt-2 text-xs font-medium tabular-nums text-ink-3'>From page {page}</p>
        : null}
    </div>
  )
}

/** A prominent link to download or open the original stored file. */
function OriginalFileActions(
  { fileUrl, label }: { fileUrl: string; label: string },
) {
  return (
    <div className='flex flex-wrap gap-2'>
      <a href={fileUrl} download className='rp-btn rp-btn-primary font-semibold'>
        {label}
      </a>
      <a
        href={fileUrl}
        target='_blank'
        rel='noopener noreferrer'
        className='rp-btn rp-btn-outline'
      >
        Open in a new tab
      </a>
    </div>
  )
}

/**
 * Honest viewer for an Office document (Word/PowerPoint/Excel), which browsers
 * cannot render natively. When the platform generated a browser-renderable
 * rendition (a PDF/image preview) it is shown inline; otherwise the original
 * is offered for download alongside its thumbnail, and the extracted text is
 * shown clearly labelled as a text extraction - never passed off as the
 * document itself.
 */
function OfficeBody(
  { slug, content, fileUrl }: {
    slug: string
    content: ResourceContent
    fileUrl: string | undefined
  },
) {
  const preview = content.preview
  const previewUrl = preview ? resourceFileUrl(slug, content.id, preview.fieldId) : undefined

  if (previewUrl && preview?.contentType === 'application/pdf') {
    return (
      <div className='space-y-4'>
        <p className='text-xs text-ink-3'>
          Showing a PDF rendition of the original document.
        </p>
        <PdfReader fileUrl={previewUrl} title={content.title} initialPage={null} />
        {fileUrl ? <OriginalFileActions fileUrl={fileUrl} label='Download original' /> : null}
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-col gap-4 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-5 sm:flex-row sm:items-center'>
        <div className='h-28 w-40 shrink-0 overflow-hidden rounded-[var(--rp-radius)] border border-line'>
          {previewUrl
            ? (
              <img
                src={previewUrl}
                alt={`Preview of ${content.title}`}
                className='h-full w-full object-cover'
              />
            )
            : <ResourceThumb slug={slug} id={content.id} type='document' />}
        </div>
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-semibold text-ink'>Original document</p>
          <p className='mt-1 text-sm leading-relaxed text-ink-2'>
            This is an Office document. Browsers cannot display it in place, so download the
            original to read it exactly as authored.
          </p>
          {fileUrl
            ? (
              <div className='mt-3'>
                <OriginalFileActions fileUrl={fileUrl} label='Download original' />
              </div>
            )
            : <p className='mt-3 text-sm text-ink-3'>The original file is not available.</p>}
        </div>
      </div>
    </div>
  )
}

/** Dispatches to the type-aware primary viewer for the resource's content. */
function ResourceViewer(
  { slug, content, blocks, passage, page, flashIndex, hasTextMatches }: {
    slug: string
    content: ResourceContent
    blocks: DocBlock[]
    passage: string | null
    page: number | null
    flashIndex: number | null
    hasTextMatches: boolean
  },
) {
  const primaryFile = content.files[0]
  const fileUrl = primaryFile ? resourceFileUrl(slug, content.id, primaryFile.fieldId) : undefined
  const variant = selectViewerVariant(content.kind)
  const mediaRef = useRef<HTMLMediaElement | null>(null)

  switch (variant) {
    case 'pdf':
      return (
        <div className='space-y-4'>
          {passage ? <MatchedPassageCard passage={passage} page={page} /> : null}
          {fileUrl
            ? <PdfReader fileUrl={fileUrl} title={content.title} initialPage={page} />
            : (
              <EmptyState
                title='This PDF is not available'
                description='The original file could not be loaded. The extracted text below is a machine reading of the document.'
              />
            )}
          {blocks.length > 0
            ? (
              <details className='rp-card p-5' open={passage != null || hasTextMatches}>
                <summary className='rp-eyebrow cursor-pointer text-ink-3'>
                  Extracted text
                </summary>
                <div className='mt-3'>
                  <DocumentReader
                    key={content.id}
                    blocks={blocks}
                    title={content.title}
                    passage={passage}
                    flashIndex={flashIndex}
                  />
                </div>
              </details>
            )
            : null}
        </div>
      )
    case 'video':
      return (
        <div className='space-y-5'>
          {fileUrl
            ? (
              <video
                ref={(el) => (mediaRef.current = el)}
                controls
                preload='metadata'
                className='w-full rounded-[var(--rp-radius)] border border-line bg-black'
                src={fileUrl}
              />
            )
            : <EmptyState title='This video is not available' />}
          {content.transcript.length > 0
            ? (
              <TranscriptPanel
                transcript={content.transcript}
                mediaRef={mediaRef}
                passage={passage}
              />
            )
            : null}
        </div>
      )
    case 'audio':
      return (
        <div className='space-y-5'>
          {fileUrl
            ? (
              <audio
                ref={(el) => (mediaRef.current = el)}
                controls
                className='w-full'
                src={fileUrl}
              />
            )
            : <EmptyState title='This audio is not available' />}
          {content.transcript.length > 0
            ? (
              <TranscriptPanel
                transcript={content.transcript}
                mediaRef={mediaRef}
                passage={passage}
              />
            )
            : null}
        </div>
      )
    case 'image':
      return fileUrl
        ? (
          <img
            src={fileUrl}
            className='max-h-[75vh] w-full rounded-[var(--rp-radius)] border border-line object-contain'
            alt={content.title}
          />
        )
        : <EmptyState title='This image is not available' />
    case 'office':
      return <OfficeBody slug={slug} content={content} fileUrl={fileUrl} />
    default:
      // web / text / file - the structured reading pane. A downloadable file
      // (a non-office attachment) gets a download action above the reader.
      return (
        <div className='space-y-4'>
          {content.kind === 'file' && fileUrl
            ? <OriginalFileActions fileUrl={fileUrl} label='Download file' />
            : null}
          <DocumentReader
            key={content.id}
            blocks={blocks}
            title={content.title}
            passage={passage}
            flashIndex={flashIndex}
          />
        </div>
      )
  }
}

/**
 * The way back out of a document. Rendered in every state of this page - the
 * skeleton and the error cards included - so a reader is never stranded on a
 * document that failed to load. Sized as a control rather than a bare line of
 * text so it is a comfortable thumb target, and pulled left by its own padding
 * so its label still aligns optically with the title beneath it.
 *
 * The label shortens to "Library" on a phone, where this link shares its row
 * with the Save action and that action grows once a current investigation is
 * pinned to it. The arrow carries the "back" sense either way, and the
 * accessible name stays "Back to library" at every width.
 */
function BackToLibrary({ slug }: { slug: string }) {
  return (
    <Link
      to={`/t/${slug}/library`}
      aria-label='Back to library'
      className='rp-focus -ml-2 inline-flex h-9 min-w-9 items-center gap-1.5 rounded-[var(--rp-radius-btn)] px-2 text-sm font-medium text-ink-3 transition-colors duration-150 hover:text-ink'
    >
      {
        /* The arrow never shrinks, so on a very narrow phone - where the Save
        * control beside it is at its widest - the label gives up its width
        * first and the affordance survives as the arrow alone. */
      }
      <span aria-hidden='true' className='shrink-0'>&larr;</span>
      <span className='truncate sm:hidden'>Library</span>
      <span className='hidden truncate sm:inline'>Back to library</span>
    </Link>
  )
}

/**
 * Top-of-page identity, in three bands: a utility row that pairs the way out
 * with the primary Save action, the title, and one wrapping meta line carrying
 * everything that qualifies the title - type, kind, topics, publication facts
 * and provenance.
 *
 * The shape is driven by the phone. Navigation and an action are page chrome,
 * so they share a single short row rather than each claiming a full-width band;
 * the title then lands second, high on the screen, and reads as the anchor it
 * is. Everything descriptive collapses underneath it into one flow that wraps
 * only when it must, instead of a stack of one-item rows. The same structure
 * suits a wide screen: the title gets the entire content width rather than
 * being squeezed beside a column of actions.
 */
function ResourceHeader(
  { slug, resource, originUrl, topicLabel, organisation }: {
    slug: string
    resource: ResourceSummary
    originUrl: string | undefined
    topicLabel: (id: string) => string | undefined
    organisation: string
  },
) {
  const kind = resource.kind ? prettyLabel(resource.kind, organisation) : null
  // The kind chip is dropped when it only restates the type badge - a
  // `document` (labelled "Report") filed under kind "report" printed the word
  // twice, on all but a handful of the corpus. Compared after prettyLabel and
  // case-insensitively, because the two values arrive from different fields in
  // different casings; a kind that genuinely adds something ("Submission",
  // "Plan", "Framework") still shows.
  const kindBadge = kind && !sameLabel(kind, typeLabel(resource.type)) ? kind : null

  const topics = resource.topicIds
    .map((id) => ({ id, label: topicLabel(id) }))
    .filter((topic): topic is { id: string; label: string } => Boolean(topic.label))

  const year = resource.published ? formatYear(resource.published) : null
  const project = projectNumber(resource.sourceName ?? resource.title)
  const facts: Array<{ label: string; value: string }> = []
  if (year) facts.push({ label: 'Published', value: year })
  if (project) facts.push({ label: 'Project', value: project })
  if (resource.sourceName) facts.push({ label: 'Source file', value: resource.sourceName })

  return (
    <header>
      <div className='flex items-center justify-between gap-3'>
        <BackToLibrary slug={slug} />
        <div className='shrink-0'>
          {
            /* Just "Save" with a bookmark glyph. The picker it opens is
            * titled "Save to investigation", so the destination is stated the
            * moment it matters, and the button gives its width back to the
            * title row on a phone. The accessible name keeps the long form. */
          }
          <SaveEvidenceButton
            slug={slug}
            evidence={{
              passage: resource.summary,
              resourceId: resource.id,
              resourceTitle: resource.title,
            }}
          />
        </div>
      </div>

      {/* `break-words`: a title that is one long unspaced token still wraps. */}
      <h1 className='rp-display mt-2 break-words text-2xl leading-tight text-ink sm:text-[1.75rem]'>
        {resource.title}
      </h1>

      <div className='mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5'>
        <TypeBadge type={resource.type} />
        {kindBadge ? <span className='rp-badge rp-badge-quiet'>{kindBadge}</span> : null}
        {topics.map((topic) => (
          <Link
            key={topic.id}
            to={`/t/${slug}/library?topics=${encodeURIComponent(topic.id)}`}
            className='rp-focus rp-badge rp-badge-quiet transition-colors duration-150 hover:text-ink'
          >
            {topic.label}
          </Link>
        ))}
        {facts.length > 0
          ? (
            <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3'>
              {facts.map((fact) => (
                <span key={fact.label} className='min-w-0'>
                  {fact.label}{' '}
                  <span className='break-words font-medium tabular-nums text-ink-2'>
                    {fact.value}
                  </span>
                </span>
              ))}
            </div>
          )
          : null}
        {originUrl
          ? (
            <a
              href={originUrl}
              target='_blank'
              rel='noopener noreferrer'
              className='rp-focus rounded-[var(--rp-radius-btn)] text-xs font-medium underline decoration-dotted underline-offset-2'
              style={{ color: 'var(--rp-accent-fg)' }}
            >
              View original source <span aria-hidden='true'>&rarr;</span>
            </a>
          )
          : null}
      </div>
    </header>
  )
}

/**
 * The "what is this" reading context shown directly under the viewer,
 * YouTube-style beneath the video: the document summary and its key facts.
 * The extracted/authored body lives inside the viewer itself (collapsible for
 * PDFs, the reading pane for documents), so this panel stays a tight overview.
 */
function ResourceContext({ resource }: { resource: ResourceSummary }) {
  return (
    <article className='rp-card p-5 sm:p-6' aria-labelledby='summary-heading'>
      <h2 id='summary-heading' className='rp-eyebrow text-ink-3'>Summary</h2>
      <p className='rp-measure mt-2 text-sm leading-relaxed text-ink-2'>{resource.summary}</p>

      {resource.keyTakeaways && resource.keyTakeaways.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <PanelHeading>Key takeaways</PanelHeading>
            <ul className='rp-measure mt-2 space-y-1.5'>
              {resource.keyTakeaways.map((point, index) => (
                <li key={index} className='flex gap-2 text-sm text-ink-2'>
                  <span
                    aria-hidden='true'
                    className='mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--rp-accent)]'
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>
        )
        : null}

      {resource.quotesOfInterest && resource.quotesOfInterest.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <PanelHeading>Quotes of interest</PanelHeading>
            <div className='rp-measure mt-2 space-y-2.5'>
              {resource.quotesOfInterest.map((quote, index) => (
                <blockquote
                  key={index}
                  className='break-words text-sm leading-relaxed text-ink-2'
                  style={{ borderColor: 'var(--rp-accent)' }}
                >
                  {quote}
                </blockquote>
              ))}
            </div>
          </div>
        )
        : null}

      {resource.keyFacts.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <PanelHeading>Key facts</PanelHeading>
            <ol className='rp-measure mt-2 space-y-1.5'>
              {resource.keyFacts.map((fact, index) => (
                <li key={index} className='flex gap-2 text-sm text-ink-2'>
                  <span className='font-medium tabular-nums text-ink-3'>{index + 1}.</span>
                  <span>{fact}</span>
                </li>
              ))}
            </ol>
          </div>
        )
        : null}
    </article>
  )
}

/**
 * The per-resource chat, scoped to this one document (its `resourceId` is
 * passed to `/ask`, which filters retrieval to this resource server-side).
 * Surfaced prominently, always available, with starter prompts as an empty
 * state rather than a blank box.
 */
function DocumentChat(
  { slug, resource, onFocus, onCitationJump }: {
    slug: string
    resource: ResourceSummary
    /** Lets the page widen the rail when the reader starts asking. */
    onFocus?: () => void
    /**
     * Sends a citation click into the reader beside this panel. Returns
     * whether the passage was found and scrolled to; false lets the marker
     * fall through to its ordinary deep link.
     */
    onCitationJump?: (citation: Citation, passage: string | undefined) => boolean
  },
) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    setQuery(trimmed)
    // The question moves into the answer above; leaving it in the field reads
    // as if it had not been sent.
    setDraft('')
  }

  function askStarter(text: string) {
    setDraft(text)
    setQuery(text)
  }

  // Openers written from this document. Generation takes a few seconds the first
  // time a document is opened (cached thereafter), so the generic three show
  // until they land rather than leaving the reader looking at an empty row.
  const { data: generated } = useQuery({
    queryKey: ['resource-questions', slug, resource.id],
    queryFn: () => getResourceQuestions(slug, resource.id),
    staleTime: Infinity,
    retry: false,
  })

  const GENERIC_STARTERS = [
    'Summarise the key findings',
    'What are the main recommendations?',
    'What methods were used?',
  ]
  const starters = generated && generated.length > 0 ? generated : GENERIC_STARTERS

  return (
    <section className='rp-card p-5 sm:p-6' aria-labelledby='chat-heading'>
      <div className='flex items-center gap-2'>
        <svg
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth={1.8}
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
          className='h-[1.125rem] w-[1.125rem] shrink-0 text-ink-3'
        >
          <path d='M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z' />
        </svg>
        <h2 id='chat-heading' className='text-base font-semibold leading-6 text-ink'>
          Chat with this document
        </h2>
      </div>

      {
        /* No placeholder: the heading above already says what the field is for,
        * and the starter questions below show the shape of a good one. The
        * screen-reader label carries the accessible name instead. */
      }
      <form onSubmit={submit} className='mt-4'>
        <label htmlFor='ask-document' className='sr-only'>
          Ask a question about {resource.title}
        </label>
        <div className='flex items-center gap-2 rounded-[var(--rp-radius)] border border-line bg-surface p-1.5 pl-3'>
          <input
            id='ask-document'
            onFocus={onFocus}
            type='text'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className='min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-ink focus:outline-none'
          />
          <button type='submit' className='rp-btn rp-btn-primary shrink-0 font-semibold'>
            Ask
          </button>
        </div>
      </form>

      {query.trim().length > 0
        ? (
          <div className='mt-4'>
            <AnswerStream
              slug={slug}
              request={{ query, resourceId: resource.id }}
              onRetry={() => setQuery(query)}
              scopedToResource
              onCitationJump={onCitationJump}
            />
          </div>
        )
        : (
          <div className='mt-3 flex flex-wrap gap-2'>
            {starters.map((text) => (
              <button
                key={text}
                type='button'
                onClick={() => askStarter(text)}
                className='rp-focus rounded-[var(--rp-radius-chip)] border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors duration-150 hover:text-ink'
              >
                {text}
              </button>
            ))}
          </div>
        )}
    </section>
  )
}

/** One recommendation card: thumbnail + title + type, linking onward. */
function RecommendationCard(
  { slug, resource, topicLabel }: {
    slug: string
    resource: ScoredResource
    topicLabel: (id: string) => string | undefined
  },
) {
  // The second line used to be `resource.type`, which reads "document" on
  // every row of this corpus and is in any case already said by the thumbnail,
  // whose fallback is a per-type glyph. The topic is the one classification
  // that is both near-universally present (measured: 135 of 136 real rail
  // rows) and actually different between rows (47% of rows carry a topic other
  // than the one being read), so it is what a reader can choose on. Absent, the
  // line is simply not rendered - no empty chip, no reserved gap.
  const topic = resource.topicIds.map(topicLabel).find(Boolean)

  return (
    <li>
      <Link
        to={`/t/${slug}/library/${resource.id}`}
        className='rp-focus group flex gap-3 rounded-[var(--rp-radius-btn)] p-1.5 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
      >
        <div className='h-16 w-24 shrink-0 overflow-hidden rounded-[var(--rp-radius)] border border-line'>
          <ResourceThumb slug={slug} id={resource.id} type={resource.type} />
        </div>
        <div className='min-w-0 flex-1'>
          <p className='rp-clamp-2 text-sm font-medium leading-snug text-ink-2 transition-colors duration-150 group-hover:text-ink'>
            {resource.title}
          </p>
          {topic
            ? (
              <span className='rp-badge rp-badge-quiet mt-1.5 max-w-full'>
                <span className='truncate'>{topic}</span>
              </span>
            )
            : null}
        </div>
      </Link>
    </li>
  )
}

/**
 * The right-hand "you might also want" rail: a semantic find on this
 * document's title + summary, cleaned of the current resource and any
 * system/junk files, presented as onward links for continuous
 * resource-to-resource browsing.
 */
function RecommendationsRail(
  { slug, resource, topicLabel }: {
    slug: string
    resource: ResourceSummary
    topicLabel: (id: string) => string | undefined
  },
) {
  const relatedQuery = buildRelatedQuery(resource.title, resource.summary)
  const query = useQuery({
    queryKey: ['related-search', slug, resource.id, relatedQuery],
    queryFn: () => searchTenantFull(slug, relatedQuery, { mode: 'semantic' }),
    enabled: relatedQuery.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  const recommendations = useMemo(
    () => query.data ? selectRecommendations(query.data.resources, resource.id) : [],
    [query.data, resource.id],
  )

  return (
    <div className='rp-card p-4'>
      <PanelHeading>You might also want</PanelHeading>
      {query.isLoading
        ? (
          <div className='mt-3 space-y-3' aria-hidden='true'>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className='flex gap-3'>
                <Skeleton className='h-16 w-24 shrink-0 rounded-[var(--rp-radius)]' />
                <div className='flex-1 space-y-1.5 py-1'>
                  <Skeleton className='h-3.5 w-full' />
                  <Skeleton className='h-3.5 w-2/3' />
                </div>
              </div>
            ))}
          </div>
        )
        : query.isError
        ? (
          <p className='mt-3 text-sm text-ink-3'>
            Related resources could not be loaded right now.
          </p>
        )
        : recommendations.length === 0
        ? <p className='mt-3 text-sm text-ink-3'>No related resources found yet.</p>
        : (
          <ul className='mt-2 space-y-1'>
            {recommendations.map((r) => (
              <RecommendationCard
                key={r.id}
                slug={slug}
                resource={r}
                topicLabel={topicLabel}
              />
            ))}
          </ul>
        )}
    </div>
  )
}

/** The "Matches in this document" jump list, driven by a `?q=` search query. */
function MatchesPanel(
  { indices, blockTexts, onJump }: {
    indices: number[]
    blockTexts: string[]
    onJump: (index: number) => void
  },
) {
  if (indices.length === 0) return null

  return (
    <div className='rp-card p-4'>
      <PanelHeading>Matches in this document ({indices.length})</PanelHeading>
      <ul className='mt-3 space-y-1'>
        {indices.map((index) => (
          <li key={index}>
            <button
              type='button'
              onClick={() => onJump(index)}
              className='rp-focus block w-full rounded-[var(--rp-radius-btn)] px-2 py-1.5 text-left text-xs leading-relaxed text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
            >
              <span className='rp-clamp-2'>{blockTexts[index]}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Floating "Save selection" action that appears near a text selection made
 * inside the reading pane, so a passage can be promoted to Evidence without
 * leaving the reader. Dismissed on scroll, Escape, or a click outside.
 */
function SelectionSaveBar(
  { slug, resourceId, resourceTitle, selection, onDismiss }: {
    slug: string
    resourceId: string
    resourceTitle: string
    selection: { text: string; top: number; left: number }
    onDismiss: () => void
  },
) {
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onScroll = () => onDismiss()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) onDismiss()
    }
    globalThis.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      globalThis.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [onDismiss])

  const top = Math.max(8, selection.top - 46)
  const left = Math.min(Math.max(8, selection.left), globalThis.innerWidth - 180)

  return createPortal(
    <div
      ref={popoverRef}
      className='rp-shadow-lg fixed z-[80] rounded-[var(--rp-radius)] border border-line bg-surface p-1'
      style={{ top, left }}
    >
      <SaveEvidenceButton
        slug={slug}
        label='Save selection'
        evidence={{
          passage: selection.text.slice(0, 2000),
          resourceId,
          resourceTitle,
        }}
      />
    </div>,
    document.body,
  )
}

function ViewerSkeleton() {
  return (
    <div className='rp-card p-5'>
      <Skeleton className='h-[55vh] w-full' />
    </div>
  )
}

export function ResourceDetailPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const splitRef = useRef<HTMLDivElement | null>(null)
  const rail = useResizableRail(splitRef)
  const revealRail = rail.reveal
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const passage = searchParams.get('passage')
  const qParam = searchParams.get('q')
  const pageParam = Number(searchParams.get('page'))
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : null

  const contentRef = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(
    null,
  )

  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (flashTimeout.current) globalThis.clearTimeout(flashTimeout.current)
    }
  }, [])

  const {
    data: resource,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['resource', config.slug, id],
    queryFn: () => getResource(config.slug, id ?? ''),
    enabled: Boolean(id),
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 1,
  })

  const { data: content, isLoading: contentLoading } = useQuery({
    queryKey: ['resource-content', config.slug, id],
    queryFn: () => getResourceContent(config.slug, id ?? ''),
    enabled: Boolean(id),
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 1,
  })

  const notFound = error instanceof ApiError && error.status === 404

  const blocks = useMemo(() => {
    const joined = (content?.texts ?? []).map((t) => t.text).join('\n\n')
    return parseDocBlocks(joined)
  }, [content])
  const blockTexts = useMemo(() => blocks.map(blockPlainText), [blocks])

  const matchTerms = useMemo(() => queryTerms(qParam), [qParam])
  const matchIndices = useMemo(() => {
    if (matchTerms.length === 0) return []
    return blockTexts
      .map((text, index) => ({ normalised: normalise(text), index }))
      .filter(({ normalised }) => matchTerms.some((term) => normalised.includes(term)))
      .map(({ index }) => index)
  }, [blockTexts, matchTerms])

  /**
   * Scrolls the reader to one parsed block and flashes it. Returns false when
   * the block is not on the page at all - the reader may be a transcript, an
   * image, or a PDF with no extracted text - so a caller can fall back rather
   * than believing a jump happened.
   *
   * For a PDF the reader lives inside a collapsed `Extracted text` disclosure,
   * and scrolling into a closed `<details>` does nothing, so the ancestor is
   * opened first. Focus moves to the block as well: without it a keyboard or
   * screen-reader user is left on the control they activated with no signal
   * that anything moved.
   */
  function jumpToBlock(index: number): boolean {
    const el = document.getElementById(`doc-block-${index}`)
    if (!el) return false

    const disclosure = el.closest('details')
    if (disclosure && !disclosure.open) disclosure.open = true

    el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })

    if (flashTimeout.current) globalThis.clearTimeout(flashTimeout.current)
    setFlashIndex(index)
    flashTimeout.current = globalThis.setTimeout(() => setFlashIndex(null), 1500)
    return true
  }

  /**
   * Locates a cited passage in the parsed blocks and jumps to it. Uses the
   * same 40-character normalised needle as the `?passage=` highlight, so a
   * citation click and a passage deep link agree on the target by
   * construction. A passage the extraction does not contain - the retrieved
   * text and the extracted text are two different readings of the file, and
   * they do drift - finds nothing and returns false, which sends the reader
   * down the ordinary deep link instead of to a confidently wrong block.
   */
  function jumpToPassage(passage: string | undefined): boolean {
    const needle = passageNeedle(passage ?? null)
    if (!needle) return false
    const index = blockTexts.findIndex((text) => normalise(text).includes(needle))
    return index >= 0 && jumpToBlock(index)
  }

  function handleContentMouseUp() {
    const sel = globalThis.getSelection()
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      setSelection(null)
      return
    }
    const anchor = sel.anchorNode
    if (!anchor || !contentRef.current?.contains(anchor)) {
      setSelection(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setSelection({ text: sel.toString(), top: rect.top, left: rect.left })
  }

  const topicLabel = (topicId: string) => config.topics.find((topic) => topic.id === topicId)?.label

  return (
    <main className='rp-shell py-8'>
      {
        /* Loaded, the way back rides in the header's utility row alongside the
        * Save action, so it costs no row of its own. While the document is
        * still loading, or has failed to load, there is no header to carry it
        * and it stands on its own above the state. */
      }
      {isLoading || isError ? <BackToLibrary slug={config.slug} /> : null}

      <div className={isLoading || isError ? 'mt-3' : ''}>
        {isLoading ? <ViewerSkeleton /> : null}

        {isError && notFound
          ? (
            <EmptyState
              title='This document does not exist'
              description='It may have been removed, or the link is out of date.'
            >
              <Link to={`/t/${config.slug}/library`} className='rp-btn rp-btn-primary'>
                Back to library
              </Link>
            </EmptyState>
          )
          : null}

        {isError && !notFound
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load this document.'}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {!isLoading && !isError && resource
          ? (
            <>
              <ResourceHeader
                slug={config.slug}
                resource={resource}
                originUrl={content?.originUrl}
                topicLabel={topicLabel}
                organisation={config.branding.organisation}
              />

              <div
                ref={splitRef}
                className={`mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_auto_var(--rp-rail)] ${
                  rail.dragging ? '' : 'rp-rail-eased'
                }`}
                style={{ '--rp-rail': `${rail.width}px` } as CSSProperties}
              >
                <div className='min-w-0 space-y-6'>
                  <div className='relative' ref={contentRef} onMouseUp={handleContentMouseUp}>
                    {contentLoading ? <ViewerSkeleton /> : content
                      ? (
                        <div className='rp-card p-4 sm:p-5'>
                          <ResourceViewer
                            slug={config.slug}
                            content={content}
                            blocks={blocks}
                            passage={passage}
                            page={page}
                            flashIndex={flashIndex}
                            hasTextMatches={matchIndices.length > 0}
                          />
                        </div>
                      )
                      : (
                        <EmptyState
                          title='This document cannot be displayed'
                          description='The full content is unavailable for this resource right now.'
                        />
                      )}
                  </div>
                </div>

                {
                  /* Splitter. Pointer-draggable, and arrow-key adjustable so it
                  * is not a pointer-only control. */
                }
                <div
                  role='separator'
                  aria-orientation='vertical'
                  aria-label='Resize the document rail'
                  aria-valuenow={rail.width}
                  aria-valuemin={rail.min}
                  aria-valuemax={rail.max}
                  tabIndex={0}
                  onPointerDown={rail.onPointerDown}
                  onKeyDown={rail.onKeyDown}
                  onDoubleClick={() =>
                    rail.onKeyDown(
                      { key: 'Home', preventDefault: () => {} } as never,
                    )}
                  className='rp-rail-handle hidden lg:block'
                />

                <aside className='rp-scroll space-y-5 lg:sticky lg:top-[calc(var(--rp-header-h,_4rem)_+_var(--spacing)_*_4)] lg:max-h-[calc(100dvh_-_var(--rp-header-h,_4rem)_-_var(--spacing)_*_8)] lg:self-start lg:overflow-y-auto lg:pr-1'>
                  <MatchesPanel
                    indices={matchIndices}
                    blockTexts={blockTexts}
                    onJump={jumpToBlock}
                  />
                  <DocumentChat
                    slug={config.slug}
                    resource={resource}
                    onFocus={revealRail}
                    onCitationJump={(_citation, passage) => jumpToPassage(passage)}
                  />
                  <ResourceContext resource={resource} />
                  <RecommendationsRail
                    slug={config.slug}
                    resource={resource}
                    topicLabel={topicLabel}
                  />
                </aside>
              </div>
            </>
          )
          : null}
      </div>

      {selection && resource
        ? (
          <SelectionSaveBar
            slug={config.slug}
            resourceId={resource.id}
            resourceTitle={resource.title}
            selection={selection}
            onDismiss={() => setSelection(null)}
          />
        )
        : null}
    </main>
  )
}
