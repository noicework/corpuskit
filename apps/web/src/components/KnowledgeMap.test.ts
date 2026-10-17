import { expect } from '@std/expect'
import { computeFit, mapCaptionLayout, placeTerritoryCaptions } from './KnowledgeMap.tsx'

const style = {
  slot: 0,
  colour: 'var(--rp-cat-1)',
  ink: 'var(--rp-cat-1-ink)',
  hollow: false,
  count: 4,
}

Deno.test('2D territory captions clear adjacent captions and the marks beneath them', () => {
  const marks = [
    { id: 'a', x: 110, y: 95, r: 18 },
    { id: 'b', x: 180, y: 80, r: 15 },
    { id: 'c', x: 245, y: 140, r: 24 },
  ]
  const captions = placeTerritoryCaptions([
    { group: 'a', text: 'International connections · 4', x: 120, y: 140, r: 42, style },
    { group: 'b', text: 'Research organisations · 4', x: 190, y: 140, r: 42, style },
    { group: 'c', text: 'Regions and communities · 4', x: 245, y: 170, r: 40, style },
  ], marks)

  expect(captions).toHaveLength(3)
  for (const caption of captions) {
    for (const other of captions) {
      if (other === caption) continue
      expect(
        caption.x1 < other.x2 && caption.x2 > other.x1 &&
          caption.y1 < other.y2 && caption.y2 > other.y1,
      ).toBe(false)
    }
    for (const mark of marks) {
      const x = Math.max(caption.x1, Math.min(mark.x, caption.x2))
      const y = Math.max(caption.y1, Math.min(mark.y, caption.y2))
      expect(Math.hypot(mark.x - x, mark.y - y)).toBeGreaterThanOrEqual(mark.r + 4)
    }
  }
})

Deno.test('2D overview fits the caption and mark bounds into the visible phone area', () => {
  const nodes = [
    { id: 'a', label: 'First', group: 'one', weight: 1, x: -360, y: -200 },
    { id: 'b', label: 'Second', group: 'two', weight: 1, x: 560, y: 620 },
  ]
  const captions = [{
    id: 'long',
    text: 'A long category caption',
    x: -340,
    y: -235,
    x1: -480,
    x2: -200,
    y1: -250,
    y2: -230,
  }]
  const insets = { left: 12, right: 48, top: 36, bottom: 54 }
  const fit = computeFit(nodes, 390, 410, insets, captions, () => 26)
  expect(fit).not.toBeNull()
  if (!fit) return
  const minX = fit.x - 480 * fit.k
  const maxX = fit.x + 586 * fit.k
  const minY = fit.y - 250 * fit.k
  const maxY = fit.y + 646 * fit.k
  expect(minX).toBeGreaterThan(insets.left)
  expect(maxX).toBeLessThan(390 - insets.right)
  expect(minY).toBeGreaterThan(insets.top)
  expect(maxY).toBeLessThan(410 - insets.bottom)
  expect(minY - insets.top).toBeLessThan((410 - insets.top - insets.bottom) * 0.15)
  expect(410 - insets.bottom - maxY).toBeLessThan((410 - insets.top - insets.bottom) * 0.15)
})

Deno.test('2D node captions share the territory collision budget in simulation coordinates', () => {
  const nodes = [
    { id: 'a', label: 'A wide research label', group: 'one', weight: 1, x: 20, y: 40 },
    { id: 'b', label: 'Another wide research label', group: 'one', weight: 1, x: 70, y: 40 },
    { id: 'c', label: 'A nearby organisation', group: 'two', weight: 1, x: 190, y: 45 },
    { id: 'd', label: 'A nearby region', group: 'two', weight: 1, x: 240, y: 50 },
  ]
  const result = mapCaptionLayout(
    nodes,
    new Map([['one', style], ['two', style]]),
    () => 16,
    'grouped',
    (group) => group,
    8,
    new Set(['b']),
  )
  expect(result.labels.has('b')).toBe(true)
  for (const caption of result.captions) {
    for (const other of result.captions) {
      if (other === caption) continue
      expect(
        caption.x1 < other.x2 && caption.x2 > other.x1 &&
          caption.y1 < other.y2 && caption.y2 > other.y1,
      ).toBe(false)
    }
    for (const node of nodes) {
      const x = Math.max(caption.x1, Math.min(node.x, caption.x2))
      const y = Math.max(caption.y1, Math.min(node.y, caption.y2))
      expect(Math.hypot(node.x - x, node.y - y)).toBeGreaterThanOrEqual(20)
    }
  }
})
