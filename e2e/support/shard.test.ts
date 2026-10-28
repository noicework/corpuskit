import { expect } from '@std/expect'
import { assign, measure, testFiles } from './shard.ts'

Deno.test('every file lands in exactly one shard, heaviest first onto the lightest', () => {
  const weights = {
    'a.test.ts': 10,
    'b.test.ts': 9,
    'c.test.ts': 8,
    'd.test.ts': 2,
    'e.test.ts': 1,
  }
  const files = Object.keys(weights).reverse()
  const shards = assign(files, weights, 2)
  expect(shards).toEqual([
    { files: ['a.test.ts', 'd.test.ts', 'e.test.ts'], seconds: 13 },
    { files: ['b.test.ts', 'c.test.ts'], seconds: 17 },
  ])
  expect(assign([...files].sort(), weights, 2)).toEqual(shards)
})

Deno.test('a file with no recorded weight counts as the median', () => {
  const weights = { 'a.test.ts': 30, 'b.test.ts': 5, 'c.test.ts': 4 }
  const shards = assign([...Object.keys(weights), 'new.test.ts'], weights, 2)
  expect(shards).toEqual([
    { files: ['a.test.ts'], seconds: 30 },
    { files: ['b.test.ts', 'c.test.ts', 'new.test.ts'], seconds: 14 },
  ])
})

Deno.test('a shard count the files cannot fill is refused', () => {
  expect(() => assign(['a.test.ts'], {}, 1)).toThrow('2 or more shards')
  expect(() => assign(['a.test.ts', 'b.test.ts'], {}, 3)).toThrow('More shards (3)')
})

Deno.test('test files are found by the names deno test runs', () => {
  const root = Deno.makeTempDirSync({ prefix: 'e2e-shard-' })
  try {
    Deno.mkdirSync(`${root}/nested/__tests__`, { recursive: true })
    for (
      const name of [
        'a.test.ts',
        'b_test.tsx',
        'test.mjs',
        'helper.ts',
        'contest.ts',
        'notes.md',
        'nested/c.test.js',
        'nested/__tests__/d.ts',
      ]
    ) Deno.writeTextFileSync(`${root}/${name}`, '')
    expect(testFiles(root).map((path) => path.slice(root.length + 1))).toEqual([
      'a.test.ts',
      'b_test.tsx',
      'nested/__tests__/d.ts',
      'nested/c.test.js',
      'test.mjs',
    ])
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
  const suite = testFiles()
  expect(suite).toContain('e2e/support/shard.test.ts')
  expect(suite).not.toContain('e2e/design-shots.ts')
})

Deno.test('weights are measured per file from a CI log', () => {
  const at = (time: string) => `2026-10-28T03:${time}.0000000Z`
  const log = [
    `gate\tGate\t${at('08:39')} running 3 tests from ./apps/api/src/app.test.ts`,
    `gate\tGate\t${at('08:50')} ok | 3 passed | 0 failed (11s)`,
    `e2e 1\tE2E\t${at('12:58')} ^[[0m^[[38;5;245mrunning 1 test from ./e2e/a.test.ts^[[0m`,
    `e2e 2\tE2E\t${at('13:00')} running 2 tests from ./e2e/c.test.ts`,
    `e2e 1\tE2E\t${at('13:04')} running 4 tests from ./e2e/b.test.ts`,
    `e2e 1\tE2E\t${at('15:22')} ^[[0m^[[32mok^[[0m | 5 passed | 0 failed (2m30s)`,
    `e2e 2\tE2E\t${at('13:09')} ok | 2 passed | 0 failed (9s)`,
  ].join('\n')
  expect(measure(log)).toEqual({ 'e2e/a.test.ts': 6, 'e2e/b.test.ts': 138, 'e2e/c.test.ts': 9 })
})
