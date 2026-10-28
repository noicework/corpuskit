import { usePortalLocale } from '../lib/portal-locale.tsx'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { layoutHrefTarget } from '@research-portal/core'
import type { ResolvedScene } from '../lib/demo-tour.ts'
import { SceneIllustration, SceneList } from './DemoTourScenes.tsx'
import { ExternalMark } from './LayoutLink.tsx'
import { Button, IconButton } from './ui.tsx'
import { ArrowLeft, ArrowRight, X } from './icons.tsx'

/**
 * The guided tour: one dialog, a scene per step and a finish. Each scene puts its
 * words and its one button beside an illustration drawn with the portal's own components, so
 * the reader sees the feature before they are sent to it. Every control in the dialog is the
 * same size: one button family, one footer rhythm.
 *
 * Accessibility: a native modal dialog, so the page behind is inert and Escape closes it
 * through `onCancel`; Tab stays inside; the step heading takes focus on every step so a
 * screen reader hears where it is; a live region repeats the step count; focus goes back to
 * the control that opened it when it closes; the illustration pane is hidden and inert, since
 * the words beside it carry the meaning; motion stops under reduced motion.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

type Step = { kind: 'scene'; scene: ResolvedScene; index: number } | { kind: 'finish' }

export function DemoTourDialog({
  onClose,
  slug,
  productName,
  scenes,
  graphKinds,
}: {
  onClose: () => void
  slug: string
  productName: string
  scenes: ResolvedScene[]
  /** The Graph's kinds of thing, for its illustration's labels. */
  graphKinds: string[]
}) {
  const { ui } = usePortalLocale()
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [at, setAt] = useState(0)
  // The band on the home page has already said what this is, so the tour opens on its first
  // step rather than on a welcome that says it again.
  const steps: Step[] = [
    ...scenes.map((scene, index): Step => ({ kind: 'scene', scene, index })),
    { kind: 'finish' },
  ]
  const step = steps[Math.min(at, steps.length - 1)]!
  const last = steps.length - 1

  // The dialog is mounted only while it is open: open the native dialog on mount, hold the
  // page's scroll, and on unmount close it and give focus back to the control that opened it.
  useEffect(() => {
    const dialog = dialogRef.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!dialog.open) dialog.showModal()
    dialog.scrollTop = 0
    return () => {
      if (dialog.open) dialog.close()
      document.body.style.overflow = overflow
      if (previous?.isConnected && previous.getClientRects().length > 0) previous.focus()
    }
  }, [])

  // Every step starts at its heading, so what changed is the first thing heard.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
    dialogRef.current?.scrollTo({ top: 0 })
  }, [at])

  const next = () => (at >= last ? close.current() : setAt(at + 1))
  const back = () => setAt(Math.max(0, at - 1))

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      next()
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      back()
      return
    }
    if (event.key !== 'Tab') return
    // The illustration's own links and buttons are inert, so they are not stops: letting Tab
    // run on to them would carry focus out of the dialog into the browser's chrome.
    const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
    const first = stops[0], end = stops.at(-1)
    if (!first || !end) return
    const active = document.activeElement as HTMLElement | null
    if (!active || !stops.includes(active)) {
      event.preventDefault()
      ;(event.shiftKey ? end : first).focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      end.focus()
    } else if (!event.shiftKey && active === end) {
      event.preventDefault()
      first.focus()
    }
  }

  const title = step.kind === 'finish'
    ? ui('Get started with {portal}', { portal: productName })
    : step.scene.title
  // Only the scenes are counted and dotted; the finish is the way out, not a step.
  const position = step.kind === 'scene'
    ? ui('Step {n} of {total}', { n: step.index + 1, total: scenes.length })
    : null

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={step.kind === 'scene' ? `${id}-body` : undefined}
      data-demo-tour
      className='rp-dialog rp-tour-dialog rp-anim-fade overscroll-contain text-ink'
      onCancel={(event) => {
        event.preventDefault()
        close.current()
      }}
      onClose={(event) => {
        // A browser may close the dialog itself (a second Escape); follow it.
        if (!event.currentTarget.open) close.current()
      }}
      onKeyDown={onKeyDown}
    >
      <p role='status' className='sr-only'>{position ? `${position}: ${title}` : title}</p>
      <div className='rp-tour-body'>
        <div className='flex min-w-0 flex-col'>
          <div className='flex items-start justify-between gap-3'>
            <p className='rp-eyebrow min-h-[1em] text-[var(--rp-brand-fg)]' aria-hidden='true'>
              {position}
            </p>
            <IconButton icon={X} label={ui('Close')} onClick={() => close.current()} />
          </div>
          <h2
            id={`${id}-title`}
            ref={headingRef}
            tabIndex={-1}
            className='rp-display mt-2 break-words text-2xl text-ink outline-none'
          >
            {title}
          </h2>
          {step.kind === 'scene'
            ? (
              <p id={`${id}-body`} className='mt-3 text-base leading-relaxed text-ink-2'>
                {step.scene.body}
              </p>
            )
            : null}
          {step.kind === 'scene'
            ? <TryIt scene={step.scene} slug={slug} onGo={() => close.current()} />
            : null}
          {step.kind === 'finish'
            ? (
              <div className='mt-5 flex flex-wrap gap-2'>
                {[
                  { href: '/ask', label: ui('Ask a question') },
                  { href: '/library', label: ui('Browse the Library') },
                  { href: '/graph', label: ui('Explore the Graph') },
                ].map((link) => (
                  <Link
                    key={link.href}
                    to={`/t/${encodeURIComponent(slug)}${link.href}`}
                    className='rp-btn rp-btn-outline'
                    onClick={() => close.current()}
                  >
                    {link.label}
                    <ArrowRight />
                  </Link>
                ))}
              </div>
            )
            : null}
          <div className='mt-auto flex flex-wrap items-center gap-x-3 gap-y-3 pt-6'>
            <div className='flex items-center gap-1.5' aria-hidden='true'>
              {step.kind === 'scene'
                ? scenes.map((scene, index) => (
                  <span
                    key={scene.id}
                    className={`rp-tour-dot${index === at ? ' rp-tour-dot-active' : ''}`}
                  />
                ))
                : null}
            </div>
            <div className='ml-auto flex shrink-0 items-center gap-2'>
              {at > 0
                ? (
                  <Button variant='ghost' leadingIcon={ArrowLeft} onClick={back}>
                    {ui('Back')}
                  </Button>
                )
                : null}
              {step.kind === 'finish'
                ? <Button onClick={() => close.current()}>{ui('Done')}</Button>
                : (
                  <Button trailingIcon={ArrowRight} onClick={next}>
                    {ui('Next')}
                  </Button>
                )}
            </div>
          </div>
        </div>
        <div
          className='rp-tour-stage'
          aria-hidden='true'
          ref={(element) => element?.setAttribute('inert', '')}
        >
          {step.kind === 'scene'
            ? (
              <div className='mb-3 flex justify-end'>
                <span className='rp-badge rp-badge-quiet'>{ui('Example')}</span>
              </div>
            )
            : null}
          <div key={`${at}-${step.kind}`} className='rp-tour-reveal'>
            {step.kind === 'scene'
              ? <SceneIllustration id={step.scene.id} slug={slug} kinds={graphKinds} />
              : <SceneList scenes={scenes} done />}
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  )
}

/**
 * The scene's one click into the real feature: a question sent, or a page opened. A question
 * is shown beside its button, so the reader knows what they are about to ask.
 */
function TryIt({ scene, slug, onGo }: { scene: ResolvedScene; slug: string; onGo: () => void }) {
  const target = layoutHrefTarget(scene.href, slug)
  if (!target) return null
  return (
    <div className='mt-5 space-y-4'>
      {scene.question
        ? (
          <blockquote className='rp-tour-question text-base leading-relaxed text-ink'>
            {scene.question}
          </blockquote>
        )
        : null}
      {target.external
        ? (
          <a
            href={target.url}
            rel='noopener'
            className='rp-btn rp-btn-outline'
            data-tour-action
            onClick={onGo}
          >
            {scene.action}
            <ArrowRight />
            <ExternalMark />
          </a>
        )
        : (
          <Link to={target.to} className='rp-btn rp-btn-outline' data-tour-action onClick={onGo}>
            {scene.action}
            <ArrowRight />
          </Link>
        )}
    </div>
  )
}
