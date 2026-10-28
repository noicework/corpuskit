import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { participatesInFederation } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import { Button, SectionHeader, Skeleton } from '../../components/ui.tsx'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import {
  acceptedPeerKinds,
  isPeerKind,
  PEER_KINDS,
  type PeerDraft,
  type PeerKind,
  validatePeer,
} from '../../lib/federation-peers.ts'
import {
  getFederation,
  getFederationDocuments,
  setFederationExclusion,
  setPeerKey,
  updateFederation,
} from '../../api/federation.ts'
import { listAudit } from '../../api/audit.ts'
import { ApiError } from '../../api/client.ts'

export function FederationPanel({ config }: { config: TenantConfig }) {
  const { ui, date } = usePortalLocale()
  const authority = useAccess()
  const scope = { kind: 'portal' as const, slug: config.slug }
  const can = (
    permission:
      | 'bindings.write'
      | 'behaviour.write'
      | 'appearance.write'
      | 'content.write'
      | 'audit.read',
  ) => authority.can(permission, scope)
  const context = { authority: authority.controller, context: authority.controller.context }
  const client = useQueryClient()
  const slug = config.slug
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [editor, setEditor] = useState<PeerDraft | null>(null)
  const [editing, setEditing] = useState<string | undefined>()
  const addButton = useRef<HTMLButtonElement>(null)
  const documentPicker = useRef<HTMLSelectElement>(null)
  const [focusTarget, setFocusTarget] = useState<'partner' | 'document' | HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (busy || !focusTarget) return
    let target: HTMLElement | null = focusTarget === 'partner'
      ? addButton.current
      : focusTarget === 'document'
      ? documentPicker.current
      : focusTarget
    if (focusTarget === 'partner' && target?.matches(':disabled')) {
      target = target.closest('section')?.querySelector<HTMLElement>(
        '[data-federation-peer]:last-child button',
      ) ?? null
    }
    if (target?.isConnected && !target.matches(':disabled')) {
      if (document.activeElement === document.body || document.activeElement === target) {
        target.focus()
      }
      setFocusTarget(null)
    } else if (typeof focusTarget !== 'string') setFocusTarget(null)
  }, [busy, editor, focusTarget])
  const settings = useQuery({
    queryKey: ['federation', slug],
    queryFn: ({ signal }) => getFederation(slug, { ...context, signal }),
    enabled: can('bindings.write'),
    retry: false,
  })
  const documents = useQuery({
    queryKey: ['federation-documents', slug],
    queryFn: ({ signal }) => getFederationDocuments(slug, { ...context, signal }),
    enabled: can('content.write'),
    retry: false,
  })
  const [cursor, setCursor] = useState<string | undefined>()
  const audit = useQuery({
    queryKey: ['federation-audit', slug, cursor],
    queryFn: ({ signal }) =>
      listAudit(
        scope,
        { action: 'tenant.behaviour.update', outcome: 'success', limit: 25, cursor },
        { ...context, signal },
      ),
    enabled: can('audit.read'),
    retry: false,
  })
  const snapshot = settings.data
  const participates = snapshot?.participates ?? participatesInFederation(config)
  const agentAsk = snapshot?.agentAsk ?? config.agentAsk === true
  const peers = snapshot?.peers ?? config.federation?.peers ?? []
  const kinds = acceptedPeerKinds().filter((kind) => snapshot?.supportedKinds.includes(kind))
  const [documentId, setDocumentId] = useState('')
  const excluded = documents.data?.items.filter((item) => item.excluded) ?? []
  const included = documents.data?.items.filter((item) => !item.excluded) ?? []

  async function run(work: () => Promise<void>, success: string): Promise<boolean> {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(true)
    setNotice(null)
    try {
      await work()
      authority.controller.assertCurrent(context.context)
      setCursor(undefined)
      await Promise.all([
        client.invalidateQueries({ queryKey: ['federation', slug] }),
        client.invalidateQueries({ queryKey: ['federation-documents', slug] }),
        client.invalidateQueries({ queryKey: ['federation-audit', slug] }),
        client.invalidateQueries({ queryKey: ['tenant-config', slug] }),
      ])
      authority.controller.assertCurrent(context.context)
      setNotice({ error: false, text: success })
      return true
    } catch (error) {
      if (context.context === authority.controller.context) {
        setNotice({
          error: true,
          text: error instanceof ApiError && error.code === 'computed_exclusion'
            ? 'This document is excluded by a labelling rule. Change that rule before removing the exclusion.'
            : 'Could not save federation settings. Refresh and try again.',
        })
      }
      return false
    } finally {
      if (context.context === authority.controller.context) {
        setBusy(false)
        setFocusTarget(focused)
      }
    }
  }
  function closeEditor() {
    setEditor(null)
    setEditing(undefined)
    setFocusTarget('partner')
  }
  const writablePeers = can('behaviour.write') && can('appearance.write') && !!snapshot
  return (
    <div className='rp-federation-panel min-w-0 space-y-6' data-federation-panel aria-busy={busy}>
      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className='rp-card p-4 text-sm'>
          {ui(notice.text)}
        </p>
      )}
      <section className='rp-card min-w-0 p-5 lg:p-6'>
        <SectionHeader
          className='rp-manage-section-head'
          title={ui('Federation')}
          description={ui('Choose how this portal shares research with partner collections.')}
        />
        <h3 className='mt-5 font-semibold'>{ui('Participation')}</h3>
        <p className='mt-2 max-w-prose text-sm text-ink-2'>
          {ui(
            "Taking part lets other portals include this collection in federated answers and search. Turning it off also stops this portal searching partner collections for composed answers and shared search. Agent ask stays available for this portal's own collection.",
          )}
        </p>
        {can('behaviour.write')
          ? (
            <label className='rp-check mt-3 min-h-11 text-sm'>
              <input
                className='sr-only'
                data-federation-participates
                type='checkbox'
                role='switch'
                checked={participates}
                disabled={busy || !snapshot}
                onChange={(event) =>
                  void run(
                    () =>
                      updateFederation(
                        slug,
                        { federation: { participates: event.target.checked } },
                        context,
                      ),
                    'Participation updated.',
                  )}
              />
              <span
                className='rp-switch'
                data-on={participates ? 'true' : 'false'}
                aria-hidden='true'
              >
                <span className='rp-switch-knob' />
              </span>
              {ui("Take part in other portals' federated answers and search")}
            </label>
          )
          : (
            <p className='mt-3 text-sm'>
              {ui(
                participates
                  ? 'This portal takes part in federation.'
                  : 'This portal does not take part in federation.',
              )}
            </p>
          )}
        <h3 className='mt-5 font-semibold'>{ui('Agent ask')}</h3>
        <p className='mt-2 text-sm text-ink-2'>
          {ui(
            'Agent ask composes a cited answer from available collections. This setting does not change participation.',
          )}
        </p>
        {can('behaviour.write')
          ? (
            <label className='rp-check mt-3 min-h-11 text-sm'>
              <input
                className='sr-only'
                data-federation-agent-ask
                type='checkbox'
                role='switch'
                checked={agentAsk}
                disabled={busy || !snapshot}
                onChange={(event) =>
                  void run(
                    () => updateFederation(slug, { agentAsk: event.target.checked }, context),
                    'Agent ask updated.',
                  )}
              />
              <span className='rp-switch' data-on={agentAsk ? 'true' : 'false'} aria-hidden='true'>
                <span className='rp-switch-knob' />
              </span>
              {ui('Offer agent ask on this portal')}
            </label>
          )
          : (
            <p className='mt-3 text-sm'>
              {ui(agentAsk ? 'Agent ask is on.' : 'Agent ask is off.')}
            </p>
          )}
        {settings.isLoading && can('bindings.write') && <Skeleton className='mt-4 h-6 w-full' />}
        {settings.isError && (
          <p role='alert' className='mt-3 text-sm'>
            {ui('Could not load federation settings.')}{' '}
            <Button
              variant='ghost'
              onClick={() => void settings.refetch()}
            >
              {ui('Try again')}
            </Button>
          </p>
        )}
      </section>
      <section className='rp-card min-w-0 p-5 lg:p-6'>
        <SectionHeader
          className='rp-manage-section-head'
          title={ui('Partner collections')}
          description={ui(
            'Partners are searched when this portal takes part in federation. Origin links are shared only when you allow them.',
          )}
          actions={writablePeers && !editor && (
            <button
              ref={addButton}
              type='button'
              className='rp-btn rp-btn-outline'
              disabled={busy || peers.length >= 6 || !kinds.length}
              onClick={() => {
                setEditing(undefined)
                setEditor({ id: '', label: '', kind: kinds[0]! })
              }}
            >
              {ui('Add partner')}
            </button>
          )}
        />
        {!peers.length && (
          <p className='mt-4 text-sm text-ink-2'>{ui('No partner collections configured.')}</p>
        )}
        <ul className='mt-4 space-y-4'>
          {peers.map((peer) => (
            <li
              key={peer.id}
              className='min-w-0 border-t border-line pt-4'
              data-federation-peer={peer.id}
            >
              <div className='flex min-w-0 flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <div className='flex min-w-0 flex-wrap items-center gap-2'>
                    <h3 className='break-words font-semibold'>{peer.label}</h3>
                    {snapshot && isPeerKind(peer.kind) && PEER_KINDS[peer.kind].key && (
                      <span className='rp-badge text-xs' data-peer-key-status>
                        {ui(
                          snapshot.peers.find((item) =>
                              item.id === peer.id
                            )!.keySet
                            ? 'Key saved'
                            : 'No key',
                        )}
                      </span>
                    )}
                  </div>
                  <p className='mt-1 break-words text-sm text-ink-2'>
                    {ui(isPeerKind(peer.kind) ? PEER_KINDS[peer.kind].label : 'Partner collection')}
                    {' '}
                    · {peer.id}
                  </p>
                </div>
                {writablePeers && (
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      variant='outline'
                      aria-label={ui('Edit {partner}', { partner: peer.label })}
                      disabled={busy}
                      onClick={() => {
                        const { keySet: _keySet, ...draft } = peer as typeof peer & {
                          keySet?: boolean
                        }
                        setEditing(peer.id)
                        setEditor(draft as PeerDraft)
                      }}
                    >
                      {ui('Edit')}
                    </Button>
                    <Button
                      variant='ghost'
                      aria-label={ui('Remove {partner}', { partner: peer.label })}
                      disabled={busy}
                      onClick={() => {
                        setEditor(null)
                        void run(() =>
                          updateFederation(slug, {
                            federation: {
                              peers: snapshot!.peers.filter((item) => item.id !== peer.id).map((
                                { keySet: _keySet, ...item },
                              ) =>
                                item as PeerDraft
                              ),
                            },
                          }, context), 'Partner removed.').then((saved) => {
                            if (saved) {
                              setFocusTarget('partner')
                            }
                          })
                      }}
                    >
                      {ui('Remove')}
                    </Button>
                  </div>
                )}
              </div>
              {snapshot && isPeerKind(peer.kind) && (
                <dl className='mt-3 grid min-w-0 gap-2 text-sm sm:grid-cols-2'>
                  {Object.entries(PEER_KINDS[peer.kind].fields).map(([field, label]) => (
                    <div key={field} className='min-w-0'>
                      <dt className='text-ink-2'>{ui(label)}</dt>
                      <dd className='break-all'>
                        {String((peer as unknown as Record<string, unknown>)[field] ?? '')}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {can('bindings.write') && snapshot && isPeerKind(peer.kind) &&
                PEER_KINDS[peer.kind].key && (
                <PeerKeyForm
                  keySet={snapshot.peers.find((item) => item.id === peer.id)!.keySet}
                  busy={busy}
                  save={(token) =>
                    run(() =>
                      setPeerKey(slug, peer.id, token, context), 'Partner key saved.')}
                />
              )}
            </li>
          ))}
        </ul>
        {editor && writablePeers && (
          <PeerEditor
            key={`${editing ?? 'new'}-${editor.kind}`}
            initial={editor}
            editing={editing}
            kinds={kinds}
            peers={peers}
            busy={busy}
            onCancel={closeEditor}
            onSave={async (draft) => {
              const saved = await run(() =>
                updateFederation(slug, {
                  federation: {
                    peers: [
                      ...snapshot!.peers.filter((peer) => peer.id !== editing).map((
                        { keySet: _keySet, ...peer },
                      ) =>
                        peer as PeerDraft
                      ),
                      draft,
                    ],
                  },
                }, context), 'Partner saved.')
              if (saved) closeEditor()
            }}
          />
        )}
      </section>
      {can('content.write') && (
        <section className='rp-card min-w-0 p-5 lg:p-6' data-federation-exclusions>
          <SectionHeader
            className='rp-manage-section-head'
            title={ui('Excluded documents')}
            description={ui(
              'Excluded documents still answer and appear in searches here. Other portals leave them out when searching partner collections or composing answers. Separate answers from each portal are unaffected.',
            )}
          />
          {documents.isLoading && (
            <p role='status' className='mt-3 text-sm'>{ui('Loading documents...')}</p>
          )}
          {documents.isError && (
            <p role='alert' className='mt-3 text-sm'>
              {ui('Could not load federation documents.')}{' '}
              <Button
                variant='ghost'
                onClick={() => void documents.refetch()}
              >
                {ui('Try again')}
              </Button>
            </p>
          )}
          {documents.data && (
            <>
              {!excluded.length && (
                <p className='mt-4 text-sm text-ink-2'>{ui('No documents are excluded.')}</p>
              )}
              <ul className='mt-4 space-y-3'>
                {excluded.map((item) => (
                  <li
                    key={item.id}
                    className='flex min-w-0 flex-wrap items-center justify-between gap-3'
                    data-federation-excluded={item.id}
                  >
                    <Link
                      className='rp-link-standalone min-w-0 break-words'
                      to={`/t/${slug}/library/${encodeURIComponent(item.id)}`}
                    >
                      {item.title}
                    </Link>
                    {documents.data.writable && (
                      <Button
                        variant='outline'
                        disabled={busy}
                        aria-label={ui('Allow federation for {document}', { document: item.title })}
                        onClick={() =>
                          void run(
                            () => setFederationExclusion(slug, item.id, false, context),
                            'Document exclusion removed.',
                          ).then((saved) => {
                            if (saved) {
                              setFocusTarget('document')
                            }
                          })}
                      >
                        {ui('Remove exclusion')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {documents.data.writable
                ? (
                  <form
                    className='mt-5 space-y-3'
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (documentId) {
                        void run(
                          () => setFederationExclusion(slug, documentId, true, context),
                          'Document excluded.',
                        ).then((saved) => {
                          if (saved) {
                            setDocumentId('')
                            setFocusTarget('document')
                          }
                        })
                      }
                    }}
                  >
                    <label className='block text-sm font-medium'>
                      {ui('Document to exclude')}
                      <select
                        ref={documentPicker}
                        className='rp-input mt-2 w-full'
                        aria-label={ui('Document to exclude')}
                        value={documentId}
                        disabled={busy}
                        required
                        onChange={(event) =>
                          setDocumentId(event.target.value)}
                      >
                        <option value=''>{ui('Choose a document')}</option>
                        {included.map((item) => (
                          <option key={item.id} value={item.id}>{item.title}</option>
                        ))}
                      </select>
                    </label>
                    <Button type='submit' disabled={busy || !documentId}>
                      {ui('Exclude document')}
                    </Button>
                  </form>
                )
                : (
                  <p className='mt-3 text-sm text-ink-2'>
                    {ui('Document label changes are unavailable on this server.')}
                  </p>
                )}
            </>
          )}
        </section>
      )}
      {can('audit.read') && (
        <section className='rp-card min-w-0 p-5 lg:p-6'>
          <SectionHeader
            className='rp-manage-section-head'
            title={ui('Participation history')}
            description={ui(
              'Successful changes from the portal audit log, including who changed participation and its previous and new values.',
            )}
          />
          {audit.isLoading && (
            <p role='status' className='mt-3 text-sm'>{ui('Loading participation history...')}</p>
          )}
          {audit.isError && (
            <p role='alert' className='mt-3 text-sm'>
              {ui('Could not load participation history.')}{' '}
              <Button variant='ghost' onClick={() => void audit.refetch()}>
                {ui('Try again')}
              </Button>
            </p>
          )}
          {audit.data && (
            <div data-federation-history>
              <ul className='mt-4 space-y-3'>
                {audit.data.items.filter((row) =>
                  typeof JSON.parse(row.detail_json).participates === 'boolean'
                ).map((row) => {
                  const detail = JSON.parse(row.detail_json)
                  return (
                    <li key={row.id} className='break-words border-t border-line pt-3 text-sm'>
                      <p>
                        <time dateTime={row.at}>
                          {date(row.at, { dateStyle: 'medium', timeStyle: 'short' })}
                        </time>{' '}
                        · {row.actor_label ?? row.actor_id ?? row.actor_kind}
                      </p>
                      <p className='mt-1'>
                        {ui('Participation: {before} to {after}', {
                          before: ui(detail.previousParticipates ? 'On' : 'Off'),
                          after: ui(detail.participates ? 'On' : 'Off'),
                        })}
                      </p>
                    </li>
                  )
                })}
              </ul>
              {!audit.data.items.some((row) =>
                typeof JSON.parse(row.detail_json).participates === 'boolean'
              ) && (
                <p className='mt-3 text-sm text-ink-2'>
                  {ui('No participation changes on this page.')}
                </p>
              )}
              {audit.data.nextCursor && (
                <Button
                  className='mt-4'
                  variant='outline'
                  onClick={() => setCursor(audit.data.nextCursor!)}
                >
                  {ui('Older changes')}
                </Button>
              )}
              {cursor && (
                <Button
                  className='mt-4'
                  variant='ghost'
                  onClick={() => setCursor(undefined)}
                >
                  {ui('Latest changes')}
                </Button>
              )}
              <Link
                className='rp-link-standalone mt-4 block text-sm'
                to={`/t/${slug}/manage?tab=audit`}
              >
                {ui('Open full audit log')}
              </Link>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function PeerKeyForm(
  { keySet, busy, save }: {
    keySet: boolean
    busy: boolean
    save(token: string): Promise<boolean>
  },
) {
  const { ui } = usePortalLocale()
  const id = useId()
  return (
    <form
      className='mt-4 space-y-3'
      onSubmit={(event) => {
        event.preventDefault()
        const input = event.currentTarget.elements.namedItem('token') as HTMLInputElement
        const token = input.value
        input.value = ''
        void save(token)
      }}
    >
      <p id={`${id}-help`} className='max-w-prose text-sm text-ink-2'>
        {ui(
          'Keys are write-only. Enter a read-only partner key to set or replace it; saved keys are never displayed.',
        )}
      </p>
      <label className='block text-sm font-medium' htmlFor={id}>
        {ui('Replace key')}
      </label>
      <input
        id={id}
        className='rp-input w-full'
        name='token'
        type='password'
        autoComplete='new-password'
        spellCheck={false}
        required
        maxLength={4096}
        disabled={busy}
        aria-describedby={`${id}-help`}
      />
      <Button type='submit' variant='outline' disabled={busy}>
        {ui(keySet ? 'Replace key' : 'Set key')}
      </Button>
    </form>
  )
}

function PeerEditor(
  { initial, editing, kinds, peers, busy, onCancel, onSave }: {
    initial: PeerDraft
    editing?: string
    kinds: PeerKind[]
    peers: readonly { id: string }[]
    busy: boolean
    onCancel(): void
    onSave(draft: PeerDraft): Promise<void>
  },
) {
  const { ui } = usePortalLocale()
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const update = (field: string, value: string | boolean) =>
    setDraft((before) => ({ ...before, [field]: value }))
  return (
    <form
      className='mt-5 space-y-4 border-t border-line pt-5'
      data-peer-editor
      onSubmit={(event) => {
        event.preventDefault()
        const error = validatePeer(draft, peers, editing)
        setError(error)
        if (!error) void onSave(draft)
      }}
    >
      <h3 className='font-semibold'>{ui(editing ? 'Edit partner' : 'Add partner')}</h3>
      {error && <p role='alert' className='text-sm'>{ui(error)}</p>}
      <label className='block text-sm font-medium' htmlFor={`${id}-id`}>{ui('Partner ID')}</label>
      <input
        id={`${id}-id`}
        autoFocus={!editing}
        className='rp-input w-full'
        aria-label={ui('Partner ID')}
        required
        maxLength={40}
        pattern='[a-z0-9][a-z0-9-]{0,39}'
        value={draft.id}
        disabled={busy || !!editing}
        onChange={(event) => update('id', event.target.value)}
      />
      <label className='block text-sm font-medium' htmlFor={`${id}-label`}>
        {ui('Collection name')}
      </label>
      <input
        id={`${id}-label`}
        autoFocus={!!editing}
        className='rp-input w-full'
        aria-label={ui('Collection name')}
        required
        maxLength={80}
        value={draft.label}
        disabled={busy}
        onChange={(event) => update('label', event.target.value)}
      />
      <label className='block text-sm font-medium' htmlFor={`${id}-kind`}>
        {ui('Connection kind')}
      </label>
      <select
        id={`${id}-kind`}
        className='rp-input w-full'
        aria-label={ui('Connection kind')}
        value={draft.kind}
        disabled={busy || !!editing}
        onChange={(event) => {
          const kind = event.target.value as PeerKind
          setDraft({ id: draft.id, label: draft.label, kind })
        }}
      >
        {kinds.map((kind) => <option key={kind} value={kind}>{ui(PEER_KINDS[kind].label)}</option>)}
      </select>
      {Object.entries(PEER_KINDS[draft.kind].fields).map(([field, label]) => (
        <div key={field}>
          <label className='block text-sm font-medium' htmlFor={`${id}-${field}`}>
            {ui(label)}
          </label>
          <input
            id={`${id}-${field}`}
            className='rp-input mt-2 w-full'
            aria-label={ui(label)}
            value={String(draft[field] ?? '')}
            required
            maxLength={field === 'url' ? 2048 : 200}
            type={field === 'url' ? 'url' : 'text'}
            disabled={busy}
            onChange={(event) => update(field, event.target.value)}
          />
        </div>
      ))}
      <label className='rp-check min-h-11 text-sm'>
        <input
          type='checkbox'
          checked={draft.linkOrigins === true}
          disabled={busy}
          onChange={(event) => update('linkOrigins', event.target.checked)}
        />
        {ui('Allow citations to link to original documents')}
      </label>
      <div className='flex flex-wrap gap-2'>
        <Button type='submit' disabled={busy}>{ui('Save partner')}</Button>
        <Button variant='ghost' disabled={busy} onClick={onCancel}>{ui('Cancel')}</Button>
      </div>
    </form>
  )
}
