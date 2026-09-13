import { expect } from '@std/expect'
import { AuthorityController } from '../api/access-lifecycle.ts'
import { sessionFixture } from '../api/auth.test.ts'
import {
  createResearchStorageContext,
  readCurrentInvestigation,
  readResearchDraft,
  writeCurrentInvestigation,
  writeResearchDraft,
} from './research-storage.ts'

Deno.test('anonymous legacy research is readable, new writes are namespaced and signed identities never adopt it', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([
    ['rp-client-id', 'browser-one'],
    ['rp-chat-marine', '["legacy answer"]'],
    ['rp-current-investigation-marine', '{"id":"legacy","name":"Private legacy name"}'],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  try {
    const controller = new AuthorityController(() => 'browser-one')
    controller.setSession(sessionFixture('marine', null), 'marine')
    const anonymous = createResearchStorageContext(controller, 'marine')
    expect(readResearchDraft(anonymous)).toEqual(['legacy answer'])
    expect(readCurrentInvestigation(anonymous)?.name).toBe('Private legacy name')
    writeResearchDraft(anonymous, ['new answer'])
    expect(values.get('rp-chat-marine')).toBe('["legacy answer"]')
    expect(readResearchDraft(anonymous)).toEqual(['new answer'])
    controller.setSession(sessionFixture('marine', 'one'), 'marine')
    const signed = createResearchStorageContext(controller, 'marine')
    expect(readResearchDraft(signed)).toEqual([])
    expect(readCurrentInvestigation(signed)).toBeNull()
    const before = [...values]
    writeResearchDraft(signed, ['signed secret'])
    writeCurrentInvestigation(signed, { id: 'signed', name: 'Signed secret' })
    expect([...values]).toEqual(before)
    controller.setSession(sessionFixture('marine', 'two'), 'marine')
    expect(readCurrentInvestigation(createResearchStorageContext(controller, 'marine'))).toBeNull()
    controller.setSession(sessionFixture('marine', null), 'marine')
    const returned = createResearchStorageContext(controller, 'marine')
    writeResearchDraft(anonymous, ['late save'])
    expect(readResearchDraft(returned)).toEqual(['new answer'])
    controller.setSession(sessionFixture('other', null), 'other')
    expect(readResearchDraft(createResearchStorageContext(controller, 'other'))).toEqual([])
    expect(readResearchDraft(returned)).toEqual([])
    expect(values.get('rp-client-id')).toBe('browser-one')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
