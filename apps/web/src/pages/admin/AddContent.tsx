import { useAccess } from '../../components/AccessProvider.tsx'
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { addAdminLink, addAdminText, ApiError, discoverCrawl } from '../../api/client.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError, type AdminRequestAccess } from '../../api/break-glass.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'
import { UploadFiles } from './UploadFiles.tsx'

type Tab = 'upload' | 'link' | 'text' | 'crawl'

const TABS: { id: Tab; label: string }[] = [
  { id: 'upload', label: 'Upload files' },
  { id: 'link', label: 'Add link' },
  { id: 'text', label: 'Paste text' },
  { id: 'crawl', label: 'Crawl site' },
]

const CRAWL_LIMITS = [25, 50, 100] as const

/**
 * Discover links on a site and ingest a chosen subset. Two steps: discover
 * (list candidate URLs) then ingest (add each selected link sequentially,
 * reusing the same admin endpoint as the "Add link" tab).
 */
function CrawlTab({
  slug,
  onAdded,
}: {
  slug: string
  onAdded: () => Promise<unknown>
}) {
  const { runExplicit, sessionAllowed, sessionAccess } = usePermissionAdminAccess('content.write', {
    kind: 'portal',
    slug,
  })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [url, setUrl] = useState('')
  const [limit, setLimit] = useState<(typeof CRAWL_LIMITS)[number]>(50)
  const [discovering, setDiscovering] = useState(false)
  const [links, setLinks] = useState<string[] | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [ingesting, setIngesting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const selectedLinks = links?.filter((link) => checked[link]) ?? []

  const onDiscover = async (event: FormEvent) => {
    event.preventDefault()
    setDiscovering(true)
    setMessage(null)
    setLinks(null)
    setProgress(null)
    try {
      const result = await runExplicit(
        'Discover site links',
        (access) => discoverCrawl(slug, access, url, limit),
      )
      assertCurrent()
      if (result === undefined) return
      if (!Array.isArray(result.links) || !result.links.every((link) => typeof link === 'string')) {
        throw new AdminAccessError()
      }
      setLinks(result.links)
      setChecked(Object.fromEntries(result.links.map((link) => [link, true])))
      if (result.links.length === 0) {
        setMessage({ tone: 'error', text: 'No links were found at that address.' })
      }
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not crawl that site - please try again.'),
      })
    } finally {
      setDiscovering(false)
    }
  }

  const toggleAll = (value: boolean) => {
    if (!links) return
    setChecked(Object.fromEntries(links.map((link) => [link, value])))
  }

  const onIngest = async () => {
    if (!sessionAllowed || selectedLinks.length === 0) return
    setIngesting(true)
    setMessage(null)
    setProgress({ done: 0, total: selectedLinks.length })
    let added = 0
    let failures = 0
    let busy = false
    let attempted = 0
    for (const link of selectedLinks) {
      attempted += 1
      try {
        const result = await addAdminLink(slug, sessionAccess, { url: link })
        if (!result || typeof result.id !== 'string' || !result.id) throw new AdminAccessError()
        added += 1
      } catch (err) {
        if (
          err instanceof AdminAccessError || (err instanceof Error && err.name === 'AbortError')
        ) {
          setIngesting(false)
          setProgress(null)
          setMessage({
            tone: 'error',
            text: errorMessage(
              err,
              'The result could not be confirmed. Check recent additions before trying again.',
            ),
          })
          return
        }
        // The knowledge box's processing queue is full - stop the batch
        // here rather than hammering it for every remaining link. The ones
        // not yet attempted can be re-run once it has drained.
        if (err instanceof ApiError && err.status === 503) {
          busy = true
          setProgress({ done: attempted, total: selectedLinks.length })
          break
        }
        failures += 1
      }
      setProgress({ done: attempted, total: selectedLinks.length })
    }
    const deferred = selectedLinks.length - attempted
    setIngesting(false)
    setMessage(
      busy
        ? {
          tone: 'ok',
          text: `Added ${added} of ${selectedLinks.length} links - the knowledge box is busy ` +
            `processing recent changes, so the remaining ${deferred} ${
              deferred === 1 ? 'link was' : 'links were'
            } not attempted. Try again in a few minutes.`,
        }
        : failures === 0
        ? {
          tone: 'ok',
          text: `Added ${selectedLinks.length} ${
            selectedLinks.length === 1 ? 'link' : 'links'
          } - they will appear below once processed.`,
        }
        : {
          tone: 'error',
          text: `Added ${
            selectedLinks.length - failures
          } of ${selectedLinks.length} links - ${failures} failed.`,
        },
    )
    setLinks(null)
    setChecked({})
    assertCurrent()
    await onAdded()
  }

  return (
    <div className='space-y-4'>
      {!sessionAllowed && (
        <p className='text-sm text-ink-2'>
          Discovery is one request. Sign in with an administrator account to ingest selected links
          as a batch, or add each link separately.
        </p>
      )}
      <form onSubmit={onDiscover} className='space-y-3'>
        <div>
          <label
            htmlFor={`crawl-url-${slug}`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Site URL
          </label>
          <input
            id={`crawl-url-${slug}`}
            type='url'
            className='rp-input'
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://example.com'
            autoComplete='off'
            required
          />
        </div>
        <div>
          <label
            htmlFor={`crawl-limit-${slug}`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Link limit
          </label>
          <select
            id={`crawl-limit-${slug}`}
            className='rp-input'
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) as (typeof CRAWL_LIMITS)[number])}
          >
            {CRAWL_LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button type='submit' disabled={discovering} className='rp-btn rp-btn-primary'>
          {discovering ? 'Discovering…' : 'Discover'}
        </button>
      </form>

      {links && links.length > 0 && (
        <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <p className='text-sm font-medium text-ink'>
              {links.length} {links.length === 1 ? 'link' : 'links'} found
            </p>
            <div className='flex flex-wrap items-center gap-3 text-sm font-medium text-ink-2'>
              <button
                type='button'
                onClick={() => toggleAll(true)}
                className='transition-colors duration-150 hover:text-[var(--rp-ink)]'
              >
                Select all
              </button>
              <button
                type='button'
                onClick={() => toggleAll(false)}
                className='transition-colors duration-150 hover:text-[var(--rp-ink)]'
              >
                Select none
              </button>
            </div>
          </div>

          <ul className='mt-3 max-h-64 space-y-1.5 overflow-y-auto'>
            {links.map((link) => (
              <li key={link}>
                <label className='flex items-start gap-2 text-sm text-ink-2'>
                  <input
                    type='checkbox'
                    className='mt-0.5'
                    checked={checked[link] ?? false}
                    onChange={(e) => setChecked((prev) => ({ ...prev, [link]: e.target.checked }))}
                  />
                  <span className='break-all'>{link}</span>
                </label>
              </li>
            ))}
          </ul>

          <button
            type='button'
            onClick={() => void onIngest()}
            disabled={!sessionAllowed || ingesting || selectedLinks.length === 0}
            className='rp-btn rp-btn-primary mt-4'
          >
            {ingesting
              ? `Ingesting ${progress?.done ?? 0} of ${progress?.total ?? selectedLinks.length}…`
              : `Ingest ${selectedLinks.length} selected`}
          </button>
        </div>
      )}

      {message && <MessagePanel message={message} />}
    </div>
  )
}

/** The panel's anchor: other pages link to it and it takes focus when linked to. */
export const ADD_DOCUMENTS_ANCHOR = 'add-documents'

/**
 * The "Add documents" panel: upload files, add a link, paste text, or discover and ingest a
 * site's pages. Open by default with uploads first, since adding documents is the main reason
 * to be here; a link to its anchor scrolls it into view and moves focus to it.
 */
function AddContentContent({
  slug,
  onAdded,
}: {
  slug: string
  onAdded: () => Promise<unknown>
}) {
  const { runExplicit } = usePermissionAdminAccess('content.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const location = useLocation()
  const panel = useRef<HTMLElement>(null)
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>())
  const headingId = useId()
  const idFor = (kind: 'tab' | 'panel', id: Tab) => `add-${kind}-${id}-${slug}`
  const [tab, setTab] = useState<Tab>('upload')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [url, setUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [linkDraft, setLinkDraft] = useState(false)
  const [textTitle, setTextTitle] = useState('')
  const [textBody, setTextBody] = useState('')

  useEffect(() => {
    if (location.hash !== `#${ADD_DOCUMENTS_ANCHOR}`) return
    panel.current?.scrollIntoView({ block: 'start' })
    panel.current?.focus({ preventScroll: true })
  }, [location.hash, location.key])

  const choose = (id: Tab, focus = false) => {
    setTab(id)
    setMessage(null)
    if (focus) tabRefs.current.get(id)?.focus()
  }
  // Arrow keys, Home and End move between the tabs, as a tab list does.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((item) => item.id === tab)
    const target = event.key === 'ArrowRight'
      ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft'
      ? (index - 1 + TABS.length) % TABS.length
      : event.key === 'Home'
      ? 0
      : event.key === 'End'
      ? TABS.length - 1
      : null
    if (target === null) return
    event.preventDefault()
    choose(TABS[target]!.id, true)
  }

  const run = async (
    action: (access: AdminRequestAccess) => Promise<{ id: string }>,
    successText: string,
    label: string,
  ): Promise<boolean> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(label, action)
      assertCurrent()
      if (result === undefined) return false
      if (!result || typeof result.id !== 'string' || !result.id) {
        throw new Error(
          'We could not confirm the result. Check whether the action completed before trying again.',
        )
      }
      setMessage({ tone: 'ok', text: successText })
      assertCurrent()
      await onAdded()
      return true
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not add that content - please try again.'),
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  const onSubmitLink = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await run(
      (access) =>
        addAdminLink(slug, access, {
          url,
          title: linkTitle.trim() || undefined,
          hidden: linkDraft || undefined,
        }),
      linkDraft
        ? 'Link added as a draft - publish it from Recent additions once processed.'
        : 'Link added - it will appear below once processed.',
      'Add one link',
    )
    if (ok) {
      setUrl('')
      setLinkTitle('')
      setLinkDraft(false)
    }
  }

  const onSubmitText = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await run(
      (access) => addAdminText(slug, access, { title: textTitle, body: textBody }),
      'Text added - it will appear below once processed.',
      'Add text',
    )
    if (ok) {
      setTextTitle('')
      setTextBody('')
    }
  }

  return (
    <section
      ref={panel}
      id={ADD_DOCUMENTS_ANCHOR}
      tabIndex={-1}
      aria-labelledby={headingId}
      className='scroll-mt-24 outline-none'
      data-add-documents-panel
    >
      <h2 id={headingId} className='text-base font-semibold text-ink'>Add documents</h2>
      <p className='mt-1 text-sm text-ink-2'>
        Upload files, add a web page, paste text or crawl a site. New documents become searchable
        once they are processed.
      </p>

      <div
        role='tablist'
        aria-label='Ways to add documents'
        className='mt-4 flex flex-wrap gap-1 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-1'
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(node) => {
              if (node) tabRefs.current.set(t.id, node)
              else tabRefs.current.delete(t.id)
            }}
            type='button'
            role='tab'
            id={idFor('tab', t.id)}
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? idFor('panel', t.id) : undefined}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => choose(t.id)}
            onKeyDown={onTabKey}
            className={`rp-focus shrink-0 rounded-[calc(var(--rp-radius)-2px)] px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
              tab === t.id
                ? 'bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'
                : 'text-ink-2 hover:bg-[var(--rp-surface)] hover:text-[var(--rp-ink)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        role='tabpanel'
        id={idFor('panel', tab)}
        aria-labelledby={idFor('tab', tab)}
        className='mt-4'
      >
        {tab === 'upload' && <UploadFiles slug={slug} onAdded={onAdded} />}

        {tab === 'link' && (
          <form onSubmit={onSubmitLink} className='space-y-3'>
            <div>
              <label
                htmlFor={`link-url-${slug}`}
                className='mb-1.5 block text-sm font-medium text-ink'
              >
                URL
              </label>
              <input
                id={`link-url-${slug}`}
                type='url'
                className='rp-input'
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder='https://example.com/report'
                autoComplete='off'
                required
              />
            </div>
            <div>
              <label
                htmlFor={`link-title-${slug}`}
                className='mb-1.5 block text-sm font-medium text-ink'
              >
                Title (optional)
              </label>
              <input
                id={`link-title-${slug}`}
                className='rp-input'
                value={linkTitle}
                onChange={(e) => setLinkTitle(e.target.value)}
                placeholder='Leave blank to use the page title'
                autoComplete='off'
              />
            </div>
            <label className='flex items-center gap-2 text-sm text-ink-2'>
              <input
                type='checkbox'
                checked={linkDraft}
                onChange={(e) => setLinkDraft(e.target.checked)}
              />
              Ingest as draft (hidden until published)
            </label>
            <button type='submit' disabled={busy} className='rp-btn rp-btn-primary'>
              {busy ? 'Adding…' : 'Add link'}
            </button>
          </form>
        )}

        {tab === 'text' && (
          <form onSubmit={onSubmitText} className='space-y-3'>
            <div>
              <label
                htmlFor={`text-title-${slug}`}
                className='mb-1.5 block text-sm font-medium text-ink'
              >
                Title
              </label>
              <input
                id={`text-title-${slug}`}
                className='rp-input'
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                autoComplete='off'
                required
              />
            </div>
            <div>
              <label
                htmlFor={`text-body-${slug}`}
                className='mb-1.5 block text-sm font-medium text-ink'
              >
                Text
              </label>
              <textarea
                id={`text-body-${slug}`}
                className='rp-input'
                rows={6}
                value={textBody}
                onChange={(e) => setTextBody(e.target.value)}
                required
              />
            </div>
            <button type='submit' disabled={busy} className='rp-btn rp-btn-primary'>
              {busy ? 'Adding…' : 'Add text'}
            </button>
          </form>
        )}

        {tab === 'crawl' && <CrawlTab slug={slug} onAdded={onAdded} />}
      </div>

      {(tab === 'link' || tab === 'text') && message && (
        <MessagePanel message={message} className='mt-4' />
      )}
    </section>
  )
}

/** Authority generations own form state and emergency snapshots. */
export function AddContent(props: { slug: string; onAdded: () => Promise<unknown> }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <AddContentContent key={`${props.slug}:${authority.generation}`} {...props} />
}
