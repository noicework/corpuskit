import { expect } from '@std/expect'
import { FederationPeerSchema } from '@research-portal/core'
import {
  acceptedPeerKinds,
  isPeerKind,
  PEER_KINDS,
  type PeerDraft,
  validatePeer,
} from './federation-peers.ts'
import { missingPortalMessages } from './locale-messages.ts'

const draft: PeerDraft = {
  id: 'soil-research',
  label: 'Soil Research Hub',
  kind: 'arag-kb',
  zone: 'test-zone',
  kbId: 'fixture-box',
}
Deno.test('peer descriptors are complete, translated and gated by the deployed schema', () => {
  expect(Object.keys(PEER_KINDS)).toEqual(['arag-kb', 'arag-mcp', 'mcp', 'hosted'])
  for (const [kind, descriptor] of Object.entries(PEER_KINDS)) {
    expect(isPeerKind(kind)).toBe(true)
    expect(missingPortalMessages([descriptor.label, ...Object.values(descriptor.fields)])).toEqual(
      [],
    )
    const sample = { id: 'partner', label: 'Partner', kind, ...descriptor.sample }
    expect(acceptedPeerKinds().includes(kind as keyof typeof PEER_KINDS)).toBe(
      FederationPeerSchema.safeParse(sample).success,
    )
  }
  expect(isPeerKind('__proto__')).toBe(false)
  expect(isPeerKind('unknown')).toBe(false)
})
Deno.test('peer form validates required fields, strict shapes, unique IDs and the peer limit', () => {
  expect(validatePeer(draft, [])).toBeNull()
  expect(validatePeer({ ...draft, kind: 'arag-mcp' }, [])).toBeNull()
  for (
    const changed of [{ id: 'Invalid ID' }, { label: ' ' }, { zone: '' }, { kbId: '' }, {
      token: 'must-never-be-saved-in-config',
    }, { zone: 'https://example.test' }]
  ) {
    expect(validatePeer({ ...draft, ...changed }, [])).not.toBeNull()
  }
  expect(validatePeer(draft, [{ id: draft.id }])).toBe('Use a unique partner ID.')
  expect(validatePeer(draft, [{ id: draft.id }], draft.id)).toBeNull()
  expect(validatePeer(draft, Array.from({ length: 6 }, (_, index) => ({ id: `p-${index}` })))).toBe(
    'A portal can have up to six partner collections.',
  )
})
