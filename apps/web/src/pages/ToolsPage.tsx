import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useAccess } from '../components/AccessProvider.tsx'
import { ArrowRight, Copy } from '../components/icons.tsx'
import { Button } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

export function mcpConfigSnippet(endpoint: string, slug: string, key?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [`${slug}-knowledge`]: {
          type: 'streamable-http',
          url: endpoint,
          ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
        },
      },
    },
    null,
    2,
  )
}

export function ToolsPage() {
  const { ui } = usePortalLocale()
  const { config } = useOutletContext<TenantOutletContext>()
  const access = useAccess()
  const slug = config.slug
  const scope = { kind: 'portal' as const, slug }
  const canExtract = access.can('content.write', scope)
  const endpoint = `${globalThis.location?.origin ?? ''}/api/t/${encodeURIComponent(slug)}/mcp`
  const isPublic = config.accessMode === 'public'
  const snippet = mcpConfigSnippet(endpoint, slug, isPublic ? undefined : 'YOUR_KEY')
  const [status, setStatus] = useState<'copied' | 'failed' | null>(null)
  const lifetime = useRef<object | null>(null)
  useEffect(() => {
    const token = {}
    lifetime.current = token
    return () => {
      if (lifetime.current === token) lifetime.current = null
    }
  }, [])
  async function copy() {
    const token = lifetime.current, context = access.controller.context
    try {
      await navigator.clipboard.writeText(snippet)
      if (token && token === lifetime.current && access.controller.context === context) {
        setStatus('copied')
      }
    } catch {
      if (token && token === lifetime.current && access.controller.context === context) {
        setStatus('failed')
      }
    }
  }
  return (
    <main className='rp-shell py-8 lg:py-10' data-tools-page>
      <header className='rp-measure'>
        <h1 className='rp-display text-2xl text-ink sm:text-3xl'>{ui('Tools')}</h1>
        <p className='mt-3 text-base leading-relaxed text-ink-2'>
          {ui("Connect research tools to this portal's knowledge.")}
        </p>
      </header>
      <div className={`mt-6 grid min-w-0 gap-6 ${canExtract ? 'xl:grid-cols-2' : 'grid-cols-1'}`}>
        <section className='rp-card min-w-0 p-5 lg:p-6' aria-labelledby='connector-heading'>
          <h2 id='connector-heading' className='rp-display text-xl'>
            {ui('Knowledge box MCP connector')}
          </h2>
          <p className='rp-measure mt-3 text-base leading-relaxed text-ink-2'>
            {ui(
              'Search, browse documents and ask questions with cited answers from an MCP client. The connector is read-only and stays within this portal.',
            )}
          </p>
          <p className='rp-measure mt-4 text-base leading-relaxed' data-mcp-guidance>
            {isPublic
              ? ui(
                'This public portal supports anonymous MCP access without a key. Paste these connection details into a client that supports Streamable HTTP.',
              )
              : ui(
                'This portal requires authorised access. Use a portal-scoped key, or an authorised session if your client supports it. Your browser sign-in is not automatically shared with an external client.',
              )}
          </p>
          {!isPublic && (
            <p className='mt-3 text-sm text-ink-2'>
              {ui(
                "Replace YOUR_KEY with a key supplied by someone who manages this portal's keys.",
              )}
            </p>
          )}
          <pre
            className='mt-5 max-w-full whitespace-pre-wrap break-words rounded-[var(--rp-radius-input)] border border-line bg-[var(--rp-surface-2)] p-4 text-sm leading-relaxed [overflow-wrap:anywhere]'
            data-mcp-configuration
          ><code>{snippet}</code></pre>
          <Button
            type='button'
            leadingIcon={Copy}
            className='mt-4'
            onClick={() => void copy()}
          >
            {ui('Copy connection details')}
          </Button>
          <p role='status' className='mt-3 text-sm'>
            {status === 'copied'
              ? ui('Connection details copied.')
              : status === 'failed'
              ? ui('Could not copy. Select the connection details and copy them manually.')
              : null}
          </p>
          <Link
            to={`/t/${encodeURIComponent(slug)}/help/generate`}
            className='rp-link-standalone rp-focus mt-3 text-sm text-[var(--rp-accent-fg)] underline'
          >
            {ui('How to connect an MCP client')}
            <ArrowRight size='sm' />
          </Link>
          {access.can('keys.manage', scope) && (
            <div className='mt-6 border-t border-line pt-5'>
              <p className='text-sm text-ink-2'>
                {ui(
                  'Create, inspect and revoke portal keys in Access. Keys cannot manage portal access or settings.',
                )}
              </p>
              <Link
                to={`/t/${encodeURIComponent(slug)}/manage?tab=access#access-keys`}
                className='rp-btn rp-btn-outline mt-3'
                data-manage-keys-link
              >
                {ui('Manage portal keys')}
                <ArrowRight size='sm' />
              </Link>
            </div>
          )}
        </section>
        {canExtract && (
          <section
            className='rp-card min-w-0 self-start p-5 lg:p-6'
            aria-labelledby='extraction-lab-heading'
          >
            <h2 id='extraction-lab-heading' className='rp-display text-xl'>
              {ui('Extraction Lab')}
            </h2>
            <p className='rp-measure mt-3 text-base leading-relaxed text-ink-2'>
              {ui(
                'Profile a document and compare extraction methods, text and tables before adding it to the portal.',
              )}
            </p>
            <Link
              to={`/t/${encodeURIComponent(slug)}/manage?tab=extraction`}
              className='rp-btn rp-btn-outline mt-4'
            >
              {ui('Open the Extraction Lab')}
              <ArrowRight size='sm' />
            </Link>
          </section>
        )}
      </div>
    </main>
  )
}
