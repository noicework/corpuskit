import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { ArrowLeft, ArrowRight, ArrowUp, Maximize, Minus, Plus } from './icons.tsx'
import { IconButton } from './ui.tsx'

/** Shared pointer and keyboard alternatives to dragging either map. */
export function MapCameraControls({ zoom, fit, pan, rotate, motion, target }: {
  zoom: (factor: number) => void
  fit: () => void
  pan: (x: number, y: number) => void
  rotate?: (x: number, y: number) => void
  motion?: { playing: boolean; reduced: boolean; toggle: () => void }
  target?: HTMLElement | null
}) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [panelHeight, setPanelHeight] = useState<number>()
  const [panelLeft, setPanelLeft] = useState(0)
  useLayoutEffect(() => {
    const root = rootRef.current
    const panel = document.getElementById(panelId)
    if (!target || !open || !root || !panel) return
    const measure = () => {
      const left = root.getBoundingClientRect().left
      const width = panel.getBoundingClientRect().width
      setPanelLeft(Math.max(12 - left, Math.min(0, innerWidth - left - width - 12)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(panel)
    if (target.parentElement) observer.observe(target.parentElement)
    return () => observer.disconnect()
  }, [target, open, panelId, ui])
  useEffect(() => {
    if (target) return
    const root = rootRef.current
    const stage = root?.offsetParent
    if (!root || !stage) return
    const measure = () =>
      setPanelHeight(
        Math.max(
          44,
          stage.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom - 16,
        ),
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [target])
  const directions = [
    { label: 'left', icon: ArrowLeft, x: 1, y: 0 },
    { label: 'right', icon: ArrowRight, x: -1, y: 0 },
    { label: 'up', icon: ArrowUp, x: 0, y: -1 },
    { label: 'down', icon: ArrowUp, x: 0, y: 1 },
  ]
  const controls = (
    <div
      ref={rootRef}
      className='rp-map-camera'
      data-inline={target ? '' : undefined}
      data-graph-overlay
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div className='flex flex-wrap items-center gap-1'>
        {motion
          ? (
            <button
              type='button'
              className='rp-btn rp-btn-outline rp-btn-sm'
              onClick={motion.toggle}
              disabled={motion.reduced}
              aria-label={ui(
                motion.reduced
                  ? 'Motion off'
                  : motion.playing
                  ? 'Pause map motion'
                  : 'Play map motion',
              )}
            >
              {ui(motion.reduced ? 'Motion off' : motion.playing ? 'Pause' : 'Play')}
            </button>
          )
          : null}
        <button
          ref={toggleRef}
          type='button'
          className='rp-btn rp-btn-outline rp-btn-sm'
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {ui('Map controls')}
        </button>
      </div>
      {open
        ? (
          <div
            id={panelId}
            className='rp-map-camera-panel rp-card p-3'
            style={{
              maxHeight: target ? undefined : panelHeight,
              insetInlineStart: target ? panelLeft : undefined,
              insetInlineEnd: target ? 'auto' : undefined,
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setOpen(false)
                toggleRef.current?.focus()
              }
            }}
          >
            <p className='mb-2 text-xs text-ink-2'>
              {ui(
                rotate
                  ? 'Focus the map: arrows rotate, Shift + arrows pan, + and - zoom, Home fits. Enter selects the nearest item. Tab leaves the map.'
                  : 'Focus the map: arrows pan, + and - zoom, Home fits. Tab reaches each item and leaves the map.',
              )}
            </p>
            {rotate
              ? (
                <div role='group' aria-label={ui('Rotate map')} className='mb-2'>
                  <p className='mb-1 text-xs font-semibold text-ink'>{ui('Rotate')}</p>
                  <div className='flex flex-wrap gap-1'>
                    {directions.map(({ label, icon, x, y }) => (
                      <IconButton
                        key={label}
                        label={ui(`Rotate ${label}`)}
                        icon={icon}
                        variant='outline'
                        className={label === 'down' ? '[&_svg]:rotate-180' : ''}
                        onClick={() => rotate(x * 0.15, y * 0.15)}
                      />
                    ))}
                  </div>
                </div>
              )
              : null}
            <div role='group' aria-label={ui('Pan map')}>
              <p className='mb-1 text-xs font-semibold text-ink'>{ui('Pan')}</p>
              <div className='flex flex-wrap gap-1'>
                {directions.map(({ label, icon, x, y }) => (
                  <IconButton
                    key={label}
                    label={ui(`Pan ${label}`)}
                    icon={icon}
                    className={label === 'down' ? '[&_svg]:rotate-180' : ''}
                    variant='outline'
                    onClick={() => pan(x * 40, y * 40)}
                  />
                ))}
              </div>
            </div>
            <div className='mt-2 flex flex-wrap gap-1'>
              <IconButton
                label={ui('Zoom in')}
                icon={Plus}
                variant='outline'
                onClick={() => zoom(1.3)}
              />
              <IconButton
                label={ui('Zoom out')}
                icon={Minus}
                variant='outline'
                onClick={() => zoom(1 / 1.3)}
              />
              <IconButton
                label={ui('Fit the whole map to view')}
                icon={Maximize}
                variant='outline'
                onClick={fit}
              />
            </div>
          </div>
        )
        : null}
      <span className='sr-only' role='status'>
        {motion ? ui(motion.playing ? 'Map motion playing.' : 'Map motion paused.') : ''}
      </span>
    </div>
  )
  return target ? createPortal(controls, target) : controls
}
