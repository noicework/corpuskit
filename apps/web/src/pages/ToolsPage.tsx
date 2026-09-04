import { type FormEvent, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import { getAuthSession } from '../api/auth.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Tools - the MCP connector, pared to the one journey that matters: create a
// key, copy the configuration it arrives with, paste it into the client.
// Everything else a reader might want - what the connector can do, how to
// configure a client field by field, how the keys are secured - lives on the
// Help page this card links to, not here.
// ---------------------------------------------------------------------------

interface McpCredential {
  id: string
  label: string
  prefix: string
  createdAt: string
  revokedAt: string | null
}

interface IssuedCredential {
  key: string
  credential: McpCredential
}

async function credentialRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body &&
        typeof body.message === 'string'
      ? body.message
      : 'The MCP key request could not be completed.'
    throw new Error(message)
  }
  return body as T
}

export function mcpConfigSnippet(endpoint: string, slug: string, key = 'YOUR_KEY'): string {
  return JSON.stringify(
    {
      mcpServers: {
        [`${slug}-knowledge`]: {
          type: 'streamable-http',
          url: endpoint,
          headers: { Authorization: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  )
}

function ConnectorIcon() {
  return (
    <span
      aria-hidden='true'
      className='flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--rp-radius)] bg-[var(--rp-wash)] text-[var(--rp-brand-fg)]'
    >
      <svg
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.6'
        strokeLinecap='round'
        strokeLinejoin='round'
        className='h-6 w-6'
      >
        <rect x='4' y='4' width='6' height='6' rx='1' />
        <rect x='14' y='14' width='6' height='6' rx='1' />
        <path d='M10 7h4a3 3 0 013 3v4M7 10v4a3 3 0 003 3h4' />
      </svg>
    </span>
  )
}

function CopyButton({ value, label, primary = false }: {
  value: string
  label: string
  primary?: boolean
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      globalThis.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type='button'
      className={`rp-btn shrink-0 ${primary ? 'rp-btn-primary' : 'rp-btn-outline'}`}
      onClick={() => void copy()}
    >
      <svg
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.7'
        strokeLinecap='round'
        strokeLinejoin='round'
        className='h-4 w-4'
        aria-hidden='true'
      >
        {copied ? <path d='M5 12.5l4.5 4.5L19 7.5' /> : <path d='M9 9h10v10H9zM5 15H4V5h10v1' />}
      </svg>
      {copied ? 'Copied' : label}
    </button>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ToolsPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const endpointPath = `/api/t/${encodeURIComponent(slug)}/mcp`
  const endpoint = `${globalThis.location?.origin ?? ''}${endpointPath}`
  const [label, setLabel] = useState('')
  const [issued, setIssued] = useState<IssuedCredential | null>(null)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<
    { kind: 'error' | 'success'; text: string } | null
  >(null)

  const { data: auth, isLoading: authLoading } = useQuery({
    queryKey: ['auth-session'],
    queryFn: getAuthSession,
    staleTime: 60_000,
    retry: false,
  })
  const isAdmin = auth?.user?.isAdmin === true
  const keysPath = `/api/t/${encodeURIComponent(slug)}/mcp/keys`
  const {
    data: credentials = [],
    isLoading: keysLoading,
    isError: keysError,
    refetch: refetchCredentials,
  } = useQuery({
    queryKey: ['mcp-credentials', slug],
    queryFn: () => credentialRequest<McpCredential[]>(keysPath),
    enabled: isAdmin,
    retry: false,
  })

  async function createCredential(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setActionMessage(null)
    try {
      const result = await credentialRequest<IssuedCredential>(keysPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      // The issued panel is the feedback; a separate success line on top of
      // it would just be noise.
      setIssued(result)
      setLabel('')
      await refetchCredentials()
    } catch (error) {
      setActionMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'The MCP key could not be created.',
      })
    } finally {
      setCreating(false)
    }
  }

  async function revokeCredential(credential: McpCredential) {
    const confirmed = globalThis.confirm(
      `Revoke “${credential.label}”? MCP clients using this key will stop working immediately.`,
    )
    if (!confirmed) return
    setRevoking(credential.id)
    setActionMessage(null)
    try {
      await credentialRequest(`${keysPath}/${encodeURIComponent(credential.id)}`, {
        method: 'DELETE',
      })
      if (issued?.credential.id === credential.id) setIssued(null)
      setActionMessage({ kind: 'success', text: 'MCP key revoked.' })
      await refetchCredentials()
    } catch (error) {
      setActionMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'The MCP key could not be revoked.',
      })
    } finally {
      setRevoking(null)
    }
  }

  const issuedSnippet = issued ? mcpConfigSnippet(endpoint, slug, issued.key) : null

  return (
    <main className='rp-shell py-10 sm:py-14'>
      <header className='max-w-3xl'>
        <h1 className='rp-display text-3xl text-ink sm:text-4xl'>Tools</h1>
        <p className='mt-3 text-sm leading-relaxed text-ink-2 sm:text-base'>
          Connect trusted research tools to this portal's knowledge, with access kept inside the
          portal boundary.
        </p>
      </header>

      <section className='mt-8 max-w-3xl' aria-labelledby='connector-heading'>
        <div className='rp-card p-6 sm:p-8'>
          <div className='flex flex-col gap-5 sm:flex-row'>
            <ConnectorIcon />
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 id='connector-heading' className='rp-display text-2xl text-ink'>
                  Knowledge box MCP connector
                </h2>
                <span className='rp-chip cursor-default bg-[var(--rp-wash)] text-[var(--rp-ink)]'>
                  Read-only
                </span>
              </div>
              <p className='mt-2 text-sm leading-relaxed text-ink-2 sm:text-base'>
                Give an MCP client read-only access to this portal's research. Create a key, then
                paste the configuration it arrives with into your client.
              </p>
              <Link
                to={`/t/${slug}/help/generate`}
                className='mt-2 inline-block text-sm font-medium text-[var(--rp-accent-fg)] underline-offset-2 hover:underline'
              >
                How to connect an MCP client
              </Link>
            </div>
          </div>

          {authLoading
            ? (
              <p className='mt-6 border-t border-line pt-6 text-sm text-ink-3'>
                Checking your access…
              </p>
            )
            : !isAdmin
            ? (
              <div className='mt-6 rounded-[var(--rp-radius)] border border-line bg-[var(--rp-surface-2)] p-4'>
                <p className='text-sm font-medium text-ink'>Administrator access required</p>
                <p className='mt-1 text-sm leading-relaxed text-ink-2'>
                  The connector is available for this portal, but only a signed-in CorpusKit
                  administrator can create or revoke its keys.
                </p>
              </div>
            )
            : (
              <div className='mt-6 border-t border-line pt-6'>
                <form
                  className='flex flex-col gap-3 sm:flex-row sm:items-end'
                  onSubmit={(event) => void createCredential(event)}
                >
                  <div className='min-w-0 flex-1'>
                    <label
                      htmlFor='mcp-key-label'
                      className='mb-1.5 block text-sm font-medium text-ink'
                    >
                      Key label
                    </label>
                    <input
                      id='mcp-key-label'
                      className='rp-input w-full'
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder='For example, analyst desktop'
                      maxLength={80}
                      required
                    />
                  </div>
                  <button
                    type='submit'
                    className='rp-btn rp-btn-primary shrink-0'
                    disabled={creating}
                  >
                    {creating ? 'Creating key…' : 'Create key'}
                  </button>
                </form>
                <p className='mt-2 text-xs text-ink-3'>A new key is shown once only.</p>

                {issued && issuedSnippet
                  ? (
                    <div
                      className='mt-5 min-w-0 rounded-[var(--rp-radius)] border p-4'
                      style={{
                        borderColor: 'var(--rp-ok-line)',
                        background: 'var(--rp-ok-bg)',
                        color: 'var(--rp-ok-ink)',
                      }}
                      role='status'
                    >
                      <p className='text-sm font-semibold'>
                        Your key is ready - copy the configuration now
                      </p>
                      <p className='mt-1 text-sm leading-relaxed'>
                        It will not be shown again after you leave or refresh this page. Paste it
                        into any client that accepts JSON MCP server configuration.
                      </p>
                      <pre className='mt-3 max-w-full whitespace-pre-wrap break-words rounded-[var(--rp-radius-input)] border border-[var(--rp-ok-line)] bg-[var(--rp-surface)] p-3 text-xs leading-relaxed text-ink [overflow-wrap:anywhere]'>
                        <code>{issuedSnippet}</code>
                      </pre>
                      <div className='mt-3 flex flex-wrap gap-2'>
                        <CopyButton value={issuedSnippet} label='Copy configuration' primary />
                        <CopyButton value={issued.key} label='Copy key only' />
                      </div>
                    </div>
                  )
                  : null}

                {actionMessage
                  ? (
                    <p
                      className='mt-4 text-sm'
                      style={{
                        color: actionMessage.kind === 'error'
                          ? 'var(--rp-bad-ink)'
                          : 'var(--rp-ok-ink)',
                      }}
                      role={actionMessage.kind === 'error' ? 'alert' : 'status'}
                    >
                      {actionMessage.text}
                    </p>
                  )
                  : null}

                <div className='mt-7 border-t border-line pt-6'>
                  <h3 className='text-sm font-semibold text-ink'>Existing keys</h3>
                  {keysLoading
                    ? <p className='mt-3 text-sm text-ink-3'>Loading keys…</p>
                    : keysError
                    ? (
                      <p className='mt-3 text-sm text-[var(--rp-bad-ink)]'>
                        Keys could not be loaded.
                      </p>
                    )
                    : credentials.length === 0
                    ? (
                      <p className='mt-3 text-sm text-ink-3'>
                        No keys have been created for this portal.
                      </p>
                    )
                    : (
                      <ul className='mt-3 divide-y divide-[var(--rp-line)]'>
                        {credentials.map((credential) => (
                          <li
                            key={credential.id}
                            className='flex min-w-0 flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between'
                          >
                            <div className='min-w-0'>
                              <div className='flex flex-wrap items-center gap-2'>
                                <p className='break-words text-sm font-medium text-ink'>
                                  {credential.label}
                                </p>
                                {credential.revokedAt
                                  ? <span className='rp-chip cursor-default'>Revoked</span>
                                  : null}
                              </div>
                              <p className='mt-1 break-all font-mono text-xs text-ink-3 [overflow-wrap:anywhere]'>
                                {credential.prefix}…
                              </p>
                              <p className='mt-1 text-xs text-ink-3'>
                                Created {formatDate(credential.createdAt)}
                              </p>
                            </div>
                            {!credential.revokedAt
                              ? (
                                <button
                                  type='button'
                                  className='rp-btn rp-btn-danger self-start'
                                  disabled={revoking === credential.id}
                                  onClick={() => void revokeCredential(credential)}
                                >
                                  {revoking === credential.id ? 'Revoking…' : 'Revoke'}
                                </button>
                              )
                              : null}
                          </li>
                        ))}
                      </ul>
                    )}
                </div>
              </div>
            )}
        </div>
      </section>
    </main>
  )
}
