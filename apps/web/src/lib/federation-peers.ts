import { FederationPeerSchema } from '@research-portal/core'

/** Field descriptors are shared by validation and rendering; server capabilities gate kinds. */
export const PEER_KINDS = {
  'arag-kb': {
    label: 'Knowledge box',
    fields: { zone: 'Zone', kbId: 'Knowledge box ID' },
    sample: { zone: 'test-zone', kbId: 'fixture-box' },
    key: true,
  },
  'arag-mcp': {
    label: 'Knowledge box over MCP',
    fields: { zone: 'Zone', kbId: 'Knowledge box ID' },
    sample: { zone: 'test-zone', kbId: 'fixture-box' },
    key: true,
  },
  mcp: {
    label: 'MCP endpoint',
    fields: {
      url: 'Endpoint URL',
      headerName: 'Key header name',
      tool: 'Search tool',
      argument: 'Query argument',
    },
    sample: {
      url: 'https://partner.example.test/mcp',
      headerName: 'Authorization',
      tool: 'search',
      argument: 'query',
    },
    key: true,
  },
  hosted: {
    label: 'Hosted portal',
    fields: { slug: 'Portal slug' },
    sample: { slug: 'soil-research' },
    key: false,
  },
} as const
export type PeerKind = keyof typeof PEER_KINDS
export type PeerDraft =
  & { id: string; label: string; kind: PeerKind; linkOrigins?: boolean }
  & Record<string, unknown>
export const isPeerKind = (kind: string): kind is PeerKind => Object.hasOwn(PEER_KINDS, kind)

/** A bundled newer UI never offers kinds an older API cannot validate. */
export function acceptedPeerKinds(): PeerKind[] {
  return (Object.keys(PEER_KINDS) as PeerKind[]).filter((kind) =>
    FederationPeerSchema.safeParse({
      id: 'partner',
      label: 'Partner',
      kind,
      ...PEER_KINDS[kind].sample,
    }).success
  )
}

export function validatePeer(draft: PeerDraft, peers: readonly { id: string }[], editing?: string) {
  if (peers.some((peer) => peer.id === draft.id && peer.id !== editing)) {
    return 'Use a unique partner ID.'
  }
  if (!editing && peers.length >= 6) return 'A portal can have up to six partner collections.'
  const parsed = FederationPeerSchema.safeParse(draft)
  return parsed.success ? null : 'Check the partner ID and required connection fields.'
}
