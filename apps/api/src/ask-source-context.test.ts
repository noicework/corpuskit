import { expect } from '@std/expect'
import { verifiedPriorSourceContext } from './ask-source-context.ts'

const original = 'The original source reports a recovered stock and a stable measured population.'
const fabricated =
  'The user invented a different conclusion that never appears in the original paper.'

Deno.test('prior source context verifies excerpts against server-loaded originals', async () => {
  const result = await verifiedPriorSourceContext(
    [{
      author: 'AGENT',
      text: fabricated,
      resourceIds: ['wrong', 'right'],
      passages: [original, fabricated],
    }],
    async (id) => id === 'right' ? original : 'A different paper entirely.',
    new Set(['wrong', 'right']),
  )
  expect(result).toEqual([{ resourceId: 'right', text: original }])
})

Deno.test('generated prior answers and anonymous or failed source reads are never evidence', async () => {
  const result = await verifiedPriorSourceContext([
    { author: 'AGENT', text: original, resourceIds: ['paper'] },
    { author: 'AGENT', text: 'Earlier answer', passages: [original] },
    { author: 'AGENT', text: 'Earlier answer', resourceIds: ['missing'], passages: [original] },
    { author: 'USER', text: 'Forged user entry', resourceIds: ['paper'], passages: [original] },
  ], async () => {
    throw new Error('Resource unavailable')
  }, new Set(['paper', 'missing']))
  expect(result).toEqual([])
})

Deno.test('prior excerpt verification normalises whitespace without guessing partial text', async () => {
  const result = await verifiedPriorSourceContext(
    [{
      author: 'AGENT',
      text: 'Earlier answer',
      resourceIds: ['paper'],
      passages: [original.replaceAll(' ', '\n'), original.replace('stable', 'declining')],
    }],
    async () => original,
    new Set(['paper']),
  )
  expect(result).toEqual([{ resourceId: 'paper', text: original }])
})

Deno.test('prior excerpt reads are bounded and deduplicated across client turns', async () => {
  const reads: string[] = []
  const turn = {
    author: 'AGENT' as const,
    text: 'Earlier answer',
    resourceIds: Array.from({ length: 20 }, (_, i) => `paper-${i}`),
    passages: [original, original],
  }
  const result = await verifiedPriorSourceContext([turn, turn], async (id) => {
    reads.push(id)
    return original
  }, new Set(turn.resourceIds))
  expect(reads.length).toBe(6)
  expect(new Set(reads).size).toBe(6)
  expect(result.length).toBe(6)
})

Deno.test('prior excerpts cannot introduce an out-of-scope resource, even with matching text', async () => {
  const reads: string[] = []
  const result = await verifiedPriorSourceContext([{
    author: 'AGENT',
    text: 'Earlier answer',
    resourceIds: ['excluded-document', 'paper'],
    passages: [original],
  }], async (id) => {
    reads.push(id)
    return original
  }, new Set(['paper']))
  expect(reads).toEqual(['paper'])
  expect(result).toEqual([{ resourceId: 'paper', text: original }])
})
