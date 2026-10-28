import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { EmbeddingSettingsSchema, type TenantConfig } from '@research-portal/core'
import { adminRequest } from '../../api/client.ts'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { usePortalLocale } from '../../lib/portal-locale.tsx'

export function EmbeddingPanel({ config }: { config: TenantConfig }) {
  const { ui, error: localError } = usePortalLocale()
  const access = useAccess()
  const context = access.controller.context
  const { runExplicit } = usePermissionAdminAccess('behaviour.write', {
    kind: 'portal',
    slug: config.slug,
  })
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(config.embedding?.enabled ?? false)
  const [origins, setOrigins] = useState(config.embedding?.allowedOrigins.join('\n') ?? '')
  const [view, setView] = useState<'own' | 'federated'>(config.embedding?.defaultView ?? 'own')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSaved(false)
    const checked = EmbeddingSettingsSchema.safeParse({
      enabled,
      allowedOrigins: origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      defaultView: view,
    })
    if (!checked.success) {
      setError(ui('Enter up to 20 HTTPS origins, one per line, without paths or wildcards.'))
      return
    }
    setBusy(true)
    try {
      const result = await runExplicit(ui('Save embedding settings'), async (authority) => {
        const response = await adminRequest<{ ok: boolean }>(
          `/api/admin/tenants/${encodeURIComponent(config.slug)}`,
          authority,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ embedding: checked.data }),
          },
        )
        access.controller.assertCurrent(context)
        if (response.ok !== true) throw new AdminAccessError()
        return true
      })
      access.controller.assertCurrent(context)
      if (result === undefined) return
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', config.slug] })
      setSaved(true)
    } catch (cause) {
      if (context === access.controller.context) {
        setError(localError(cause, 'Could not save embedding settings.'))
      }
    } finally {
      if (context === access.controller.context) setBusy(false)
    }
  }
  const snippet = `<script src="${location.origin}/t/${
    encodeURIComponent(config.slug)
  }/embed.js" data-mode="inline" data-view="${view}" data-height="640" defer></script>`
  return (
    <section className='rp-card min-w-0 p-5 lg:p-6' data-embedding-settings>
      <SectionHeader
        className='rp-admin-section-head'
        title={ui('Embed the research assistant')}
        description={ui(
          'Put this portal on your own website. Only the origins listed here may frame it.',
        )}
      />
      <form onSubmit={save} className='mt-5 space-y-4'>
        <label className='flex min-h-[2.75rem] cursor-pointer items-center gap-3'>
          <input
            type='checkbox'
            role='switch'
            className='rp-focus h-6 w-6 accent-[var(--rp-accent-line)]'
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {ui('Enable embedding')}
        </label>
        <div>
          <label htmlFor='embedding-origins' className='mb-2 block font-semibold'>
            {ui('Allowed embedding origins')}
          </label>
          <textarea
            id='embedding-origins'
            className='rp-input min-h-[7rem] w-full'
            value={origins}
            onChange={(event) => setOrigins(event.target.value)}
            aria-describedby='embedding-origins-help'
          />
          <p id='embedding-origins-help' className='mt-2 text-sm text-ink-2'>
            {ui('Enter up to 20 HTTPS origins, one per line, without paths or wildcards.')}
          </p>
        </div>
        <div>
          <label htmlFor='embedding-view' className='mb-2 block font-semibold'>
            {ui('Default view')}
          </label>
          <select
            id='embedding-view'
            className='rp-input max-w-full'
            value={view}
            onChange={(event) => setView(event.target.value as 'own' | 'federated')}
          >
            <option value='own'>{ui('Own collection only')}</option>
            <option value='federated'>{ui('Own and partner collections')}</option>
          </select>
          <p className='mt-2 text-sm text-ink-2'>
            {ui('Partner search also requires agent ask to be enabled for this portal.')}
          </p>
        </div>
        <p className='text-sm text-ink-2'>
          {ui(
            'Private portals still require sign-in. Visitors can open the full portal in a new tab.',
          )}
        </p>
        <Button type='submit' disabled={busy}>{ui('Save embedding settings')}</Button>
        {error && <p role='alert' className='text-sm text-[var(--rp-bad-ink)]'>{error}</p>}
        <p role='status' className='text-sm text-ink-2'>
          {busy ? ui('Saving...') : saved ? ui('Embedding settings saved.') : ''}
        </p>
      </form>
      <label htmlFor='embedding-snippet' className='mt-6 mb-2 block font-semibold'>
        {ui('Embed snippet')}
      </label>
      <textarea
        id='embedding-snippet'
        className='rp-input min-h-[7rem] w-full font-mono text-sm'
        readOnly
        value={snippet}
        aria-describedby='embedding-snippet-help'
      />
      <p id='embedding-snippet-help' className='mt-2 text-sm text-ink-2'>
        {ui(
          'Use mode inline for a frame, or button for a dialog. View own hides partner search; federated offers it when available.',
        )}
      </p>
    </section>
  )
}
