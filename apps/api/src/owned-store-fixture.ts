import { expect } from '@std/expect'
import type { InvestigationStoreApi, SessionsStoreApi, WatchStoreApi } from './stores.ts'
import type { ResearchOwner } from './research-owner.ts'

export function ownedMutationCases(
  stores: {
    sessions: SessionsStoreApi
    watches: WatchStoreApi
    investigations: InvestigationStoreApi
  },
  watchId: string,
  investigationId: string,
  evidenceId: string,
): (() => unknown)[] {
  const owner = { kind: 'user' as const, tenantId: 'one', oid: 'same' }
  return [
    () =>
      stores.sessions.put('marine', owner, {
        id: 's',
        title: 'changed',
        updatedAt: 'now',
        messages: [],
      }),
    () =>
      stores.sessions.put('marine', owner, {
        id: 'new',
        title: 'new',
        updatedAt: 'now',
        messages: [],
      }),
    () => stores.sessions.remove('marine', owner, 's'),
    () => stores.watches.add('marine', owner, 'new'),
    () => stores.watches.update('marine', watchId, { changed: true }, owner),
    () => stores.watches.remove('marine', owner, watchId),
    () => stores.investigations.create('marine', owner, { name: 'new' }),
    () => stores.investigations.update('marine', owner, investigationId, { notes: 'changed' }),
    () => stores.investigations.remove('marine', owner, investigationId),
    () =>
      stores.investigations.updateEvidence('marine', owner, investigationId, evidenceId, {
        note: 'changed',
      }),
    () => stores.investigations.removeEvidence('marine', owner, investigationId, evidenceId),
    () =>
      stores.investigations.addEvidence('marine', owner, investigationId, {
        passage: 'different passage',
        resourceId: 'other',
        resourceTitle: 'Other',
        score: null,
        question: 'Q',
        verdict: null,
        aiRelevance: null,
        note: '',
        tags: [],
      }),
    () =>
      stores.investigations.addArtefact('marine', owner, investigationId, {
        kind: 'brief',
        title: 'new',
        data: {},
      }),
  ]
}

export function seedOwned(
  stores: {
    sessions: SessionsStoreApi
    watches: WatchStoreApi
    investigations: InvestigationStoreApi
  },
) {
  const owner = { kind: 'user' as const, tenantId: 'one', oid: 'same' }
  stores.sessions.put('marine', owner, {
    id: 's',
    title: 'original',
    updatedAt: 'then',
    messages: [],
  })
  const watch = stores.watches.add('marine', owner, 'original')
  const investigation = stores.investigations.create('marine', owner, { name: 'original' })
  const evidence = stores.investigations.addEvidence('marine', owner, investigation.id, {
    passage: 'private passage',
    resourceId: 'r',
    resourceTitle: 'Resource',
    score: null,
    question: 'Q',
    verdict: null,
    aiRelevance: null,
    note: '',
    tags: [],
  })!
  return { watch, investigation, evidence }
}

export function checkOwnedStores(stores: {
  sessions: SessionsStoreApi
  watches: WatchStoreApi
  investigations: InvestigationStoreApi
}): void {
  const { sessions, watches, investigations } = stores
  const owners: (ResearchOwner | string)[] = [
    'same',
    { kind: 'user', tenantId: 'one', oid: 'same' },
    { kind: 'user', tenantId: 'two', oid: 'same' },
    'a/b',
    'ab',
    'x'.repeat(100) + 'a',
    'x'.repeat(100) + 'b',
  ]
  for (const [index, owner] of owners.entries()) {
    sessions.put('owned/a', owner, {
      id: 's/a',
      title: String(index),
      updatedAt: '2026-09-12',
      messages: [{ text: 'private' }],
    })
    sessions.put('owned/a', owner, { id: 'sa', title: 'other', updatedAt: '2026', messages: [] })
    expect(sessions.get('owned/a', owner, 's/a')?.title).toBe(String(index))
    expect(sessions.list('owneda', owner)).toEqual([])
    const watch = watches.add('owned/a', owner, 'query')
    expect(watches.add('owned/a', owner, 'query').id).toBe(watch.id)
    const investigation = investigations.create('owned/a', owner, { name: String(index) })
    const evidence = investigations.addEvidence('owned/a', owner, investigation.id, {
      passage: 'Evidence',
      resourceId: 'r',
      resourceTitle: 'Resource',
      score: 1,
      question: 'Q',
      verdict: null,
      aiRelevance: null,
      note: '',
      tags: [],
    })!
    expect(evidence).not.toBeNull()
    const other = owners[(index + 1) % owners.length]!
    expect(investigations.get('owned/a', other, investigation.id)).toBeNull()
    expect(
      investigations.updateEvidence('owned/a', other, investigation.id, evidence.id, {
        note: 'attack',
      }),
    ).toBe(false)
    investigations.remove('owned/a', other, investigation.id)
    expect(investigations.update('owned/a', owner, investigation.id, { notes: 'mine' })?.notes)
      .toBe('mine')
    expect(
      investigations.updateEvidence('owned/a', owner, investigation.id, evidence.id, {
        note: 'mine',
      }),
    ).toBe(true)
    expect(
      investigations.addArtefact('owned/a', owner, investigation.id, {
        kind: 'brief',
        title: 'Brief',
        data: { private: true },
      }),
    ).not.toBeNull()
    investigations.removeEvidence('owned/a', other, investigation.id, evidence.id)
    expect(investigations.get('owned/a', owner, investigation.id)?.evidence[0]?.note).toBe('mine')
    investigations.removeEvidence('owned/a', owner, investigation.id, evidence.id)
    expect(investigations.list('owned/a', owner)[0]?.evidenceCount).toBe(0)
    investigations.remove('owned/a', owner, investigation.id)
    expect(investigations.get('owned/a', owner, investigation.id)).toBeNull()
    watches.update('owned/a', watch.id, { changed: true }, other)
    expect(watches.list('owned/a', owner)[0]?.changed).toBe(false)
    watches.update('owned/a', watch.id, {
      changed: true,
      clientId: 'attacker',
      owner: { kind: 'anonymous', clientId: 'attacker' },
    }, owner)
    expect(watches.list('owned/a', owner)[0]?.changed).toBe(true)
    expect(watches.list('owned/a', 'attacker')).toEqual([])
    watches.remove('owned/a', other, watch.id)
    expect(watches.list('owned/a', owner)).toHaveLength(1)
    watches.remove('owned/a', owner, watch.id)
    expect(watches.list('owned/a', owner)).toEqual([])
  }
  for (const [index, owner] of owners.entries()) {
    expect(sessions.get('owned/a', owner, 's/a')?.title).toBe(String(index))
    sessions.remove('owned/a', owner, 's/a')
    expect(sessions.list('owned/a', owner).map((s) => s.id)).toEqual(['sa'])
  }
  const simultaneous = owners.map((owner) => watches.add('watch-collisions', owner, 'same query'))
  expect(new Set(simultaneous.map((w) => w.id)).size).toBe(owners.length)
  for (const [index, owner] of owners.entries()) {
    expect(watches.list('watch-collisions', owner).map((w) => w.id)).toEqual([
      simultaneous[index]!.id,
    ])
  }
  for (let index = 0; index < 55; index++) {
    watches.add('watch-collisions', owners[0]!, 'query ' + index)
  }
  expect(watches.list('watch-collisions', owners[0]!)).toHaveLength(50)
  expect(watches.list('watch-collisions', owners[1]!)).toHaveLength(1)
  expect(watches.list('watch-collisions', owners[2]!)).toHaveLength(1)
}
