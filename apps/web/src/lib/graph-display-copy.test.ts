import { expect } from '@std/expect'
import { createPortalLocale } from './portal-locale.tsx'
import { graphGroupLabel, graphRelationLabel } from './graph-display-copy.ts'
import { missingPortalMessages } from './locale-messages.ts'
import { mapPopupCopy } from '../components/map3d-engine.ts'

Deno.test('graph display aliases translate only exact finite category and predicate keys', () => {
  const ja = createPortalLocale('ja').ui
  const groups = {
    Entity: 'エンティティ',
    Topic: 'テーマ',
    Kind: '種類',
    Experiment: '実験',
    Material: '材料',
    'Research topic': '研究テーマ',
  }
  const relations = {
    studies: ['studies', '研究する'],
    affects: ['affects', '影響を与える'],
    'conducted-in': ['conducted in', '実施場所'],
    'funded-by': ['funded by', '資金提供元'],
    'collaborates-with': ['collaborates with', '共同研究先'],
    infects: ['infects', '感染する'],
    'located-in': ['located in', '所在する'],
    assesses: ['assesses', '評価する'],
    examines: ['examines', '検討する'],
    'uses material': ['uses material', '材料として使用する'],
  } as const
  expect(missingPortalMessages([
    ...Object.keys(groups),
    ...Object.values(relations).map(([english]) => english),
    'Show all {count} entities',
    'Show all {count} categories',
  ])).toEqual([])
  for (const [original, translated] of Object.entries(groups)) {
    expect(graphGroupLabel(original, ja)).toBe(translated)
    expect(graphGroupLabel(original)).toBe(original)
  }
  for (const [original, [english, translated]] of Object.entries(relations)) {
    expect(graphRelationLabel(original, ja)).toBe(translated)
    expect(graphRelationLabel(original)).toBe(english)
  }
  expect(graphGroupLabel('', ja)).toBe(ja('Entity'))
  expect(graphRelationLabel('', ja)).toBe(ja('related to'))
  expect(graphGroupLabel('')).toBe('Entity')
  expect(graphRelationLabel('')).toBe('related to')
})

Deno.test('unknown graph copy keeps catalog-key authored values, case, whitespace and braces intact', () => {
  const ja = createPortalLocale('ja').ui
  for (
    const value of [
      'Library',
      'Summary',
      'Material {count}',
      'Research topic {name}',
      'material',
      ' Material',
      'Material ',
      '__proto__',
      'constructor',
      'toString',
    ]
  ) expect(graphGroupLabel(value, ja)).toBe(value)
  for (
    const value of [
      'Library',
      'Summary',
      'related to',
      'examines {name}',
      'Examines',
      'examines ',
      ' uses material',
      'uses material {count}',
      'Located-in',
      ' located-in',
      'located-in ',
      'located-in {name}',
      'custom-authored-relation',
      '__proto__',
      'constructor',
      'toString',
    ]
  ) expect(graphRelationLabel(value, ja)).toBe(value)
})

Deno.test('graph popup aliases categories while preserving authored entity names and source values', () => {
  const subject = {
    kind: 'entity' as const,
    label: 'Material {name}',
    group: 'Material',
    relations: 2,
    mentions: 3,
  }
  const original = structuredClone(subject)
  expect(mapPopupCopy(subject, createPortalLocale('ja').ui)).toEqual({
    name: 'Material {name}',
    category: '材料',
    counts: '関連2件 · 言及3件',
    hint: 'クリックして詳しく見る',
  })
  expect(mapPopupCopy(subject).category).toBe('Material')
  expect(subject).toEqual(original)
})
