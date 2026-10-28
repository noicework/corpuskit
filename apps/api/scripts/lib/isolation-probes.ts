/** Reused by the offline proof and the explicitly operated deployment check. */
export const ISOLATION_QUERY = 'What validation token is recorded in the boundary note?'
export interface IsolationProbe {
  name: string
  path: string
  init?: RequestInit
  document?: boolean
}
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
export function isolationProbes(
  slug: string,
  documentId: string,
  agentPath?: string,
): IsolationProbe[] {
  const root = `/api/t/${encodeURIComponent(slug)}`
  const rpc = (name: string, args: Record<string, unknown>) => ({
    ...post({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  })
  return [
    { name: 'search', path: `${root}/search?q=${encodeURIComponent(ISOLATION_QUERY)}` },
    { name: 'ask', path: `${root}/ask`, init: post({ query: ISOLATION_QUERY }) },
    { name: 'catalogue', path: `${root}/catalog` },
    {
      name: 'document',
      path: `${root}/resources/${encodeURIComponent(documentId)}`,
      document: true,
    },
    {
      name: 'MCP search',
      path: `${root}/mcp`,
      init: rpc('search_corpus', { query: ISOLATION_QUERY }),
    },
    {
      name: 'MCP ask',
      path: `${root}/mcp`,
      init: rpc('answer_question', { question: ISOLATION_QUERY }),
    },
    { name: 'MCP catalogue', path: `${root}/mcp`, init: rpc('browse_catalogue', {}) },
    { name: 'MCP document', path: `${root}/mcp`, init: rpc('get_document', { id: documentId }) },
    {
      name: 'estate ask',
      path: '/api/ask-estate',
      init: post({ query: ISOLATION_QUERY, slugs: [slug] }),
    },
    ...(agentPath
      ? [{
        name: 'agent ask',
        path: agentPath.replace(':slug', encodeURIComponent(slug)),
        init: post({ query: ISOLATION_QUERY }),
      }]
      : []),
  ]
}
