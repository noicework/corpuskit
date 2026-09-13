import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useAccess } from '../components/AccessProvider.tsx'
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
  const { config } = useOutletContext<TenantOutletContext>()
  const access = useAccess()
  const slug = config.slug
  const scope = { kind: 'portal' as const, slug }
  const canExtract = access.can('content.write', scope)
  const actionStyle = {
    height: 'auto',
    minHeight: 'max(44px, calc(2.25rem * var(--rp-density-ctl, 1)))',
    paddingBlock: '0.5rem',
  }
  const endpoint = `${globalThis.location?.origin ?? ''}/api/t/${encodeURIComponent(slug)}/mcp`
  const isPublic = config.accessMode === 'public'
  const snippet = mcpConfigSnippet(endpoint, slug, isPublic ? undefined : 'YOUR_KEY')
  const [status, setStatus] = useState('')
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
        setStatus('Connection details copied.')
      }
    } catch {
      if (token && token === lifetime.current && access.controller.context === context) {
        setStatus('Could not copy. Select the connection details and copy them manually.')
      }
    }
  }
  return (
    <main className='rp-shell py-10 sm:py-14' data-tools-page>
      <header className='max-w-3xl'>
        <h1 className='rp-display text-3xl text-ink sm:text-4xl'>Tools</h1>
        <p className='mt-3 text-base leading-relaxed text-ink-2'>
          Connect research tools to this portal's knowledge.
        </p>
      </header>
      <div className={`mt-8 grid min-w-0 gap-6 ${canExtract ? 'xl:grid-cols-2' : 'grid-cols-1'}`}>
        <section className='rp-card min-w-0 p-6 sm:p-8' aria-labelledby='connector-heading'>
          <h2 id='connector-heading' className='rp-display text-2xl'>
            Knowledge box MCP connector
          </h2>
          <p className='mt-3 max-w-prose text-base leading-relaxed text-ink-2'>
            Search, browse documents and ask questions with cited answers from an MCP client. The
            connector is read-only and stays within this portal.
          </p>
          <p className='mt-4 max-w-prose text-base' data-mcp-guidance>
            {isPublic
              ? 'This public portal supports anonymous MCP access without a key. Paste these connection details into a client that supports Streamable HTTP.'
              : 'This portal requires authorised access. Use a portal-scoped key, or an authorised session if your client supports it. Your browser sign-in is not automatically shared with an external client.'}
          </p>
          {!isPublic && (
            <p className='mt-3 text-sm text-ink-2'>
              Replace YOUR_KEY with a key supplied by someone who manages this portal's keys.
            </p>
          )}
          <pre
            className='mt-5 max-w-full whitespace-pre-wrap break-words rounded-[var(--rp-radius-input)] border border-line bg-[var(--rp-surface-2)] p-4 text-sm leading-relaxed [overflow-wrap:anywhere]'
            data-mcp-configuration
          ><code>{snippet}</code></pre>
          <button
            type='button'
            className='rp-btn rp-btn-primary mt-4 min-h-[44px]'
            style={actionStyle}
            onClick={() => void copy()}
          >
            Copy connection details
          </button>
          <p role='status' className='mt-3 text-sm'>{status}</p>
          <Link
            to={`/t/${encodeURIComponent(slug)}/help/generate`}
            className='mt-3 inline-block text-sm text-[var(--rp-accent-fg)] underline'
          >
            How to connect an MCP client
          </Link>
          {access.can('keys.manage', scope) && (
            <div className='mt-6 border-t border-line pt-5'>
              <p className='text-sm text-ink-2'>
                Create, inspect and revoke portal keys in Access. Keys cannot manage portal access
                or settings.
              </p>
              <Link
                to={`/t/${encodeURIComponent(slug)}/manage?tab=access#access-keys`}
                className='rp-btn rp-btn-outline mt-3 min-h-[44px]'
                data-manage-keys-link
                style={actionStyle}
              >
                Manage portal keys
              </Link>
            </div>
          )}
        </section>
        {canExtract && (
          <section
            className='rp-card min-w-0 self-start p-6 sm:p-8'
            aria-labelledby='extraction-lab-heading'
          >
            <h2 id='extraction-lab-heading' className='rp-display text-2xl'>Extraction Lab</h2>
            <p className='mt-3 text-base leading-relaxed text-ink-2'>
              Profile a document and compare extraction methods, text and tables before adding it to
              the portal.
            </p>
            <Link
              to={`/t/${encodeURIComponent(slug)}/manage?tab=extraction`}
              className='rp-btn rp-btn-outline mt-4 min-h-[44px]'
              style={actionStyle}
            >
              Open the Extraction Lab
            </Link>
          </section>
        )}
      </div>
    </main>
  )
}
