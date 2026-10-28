import { expect } from '@std/expect'
import {
  assign,
  MAX_RETRIED_FILES,
  measure,
  outcome,
  parseReport,
  retryFiles,
  retrySummary,
  testFiles,
} from './shard.ts'

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

Deno.test('test files are found by the names deno test runs, under every root', () => {
  const root = Deno.makeTempDirSync({ prefix: 'e2e-shard-' })
  try {
    Deno.mkdirSync(`${root}/nested/__tests__`, { recursive: true })
    Deno.mkdirSync(`${root}/other`)
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
        'other/e.test.ts',
      ]
    ) Deno.writeTextFileSync(`${root}/${name}`, '')
    const found = (roots: string[]) => testFiles(roots).map((path) => path.slice(root.length + 1))
    expect(found([`${root}/`])).toEqual([
      'a.test.ts',
      'b_test.tsx',
      'nested/__tests__/d.ts',
      'nested/c.test.js',
      'other/e.test.ts',
      'test.mjs',
    ])
    expect(found([`${root}/other`, `${root}/nested`])).toEqual([
      'nested/__tests__/d.ts',
      'nested/c.test.js',
      'other/e.test.ts',
    ])
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
  const suite = testFiles(['e2e'])
  expect(suite).toContain('e2e/support/shard.test.ts')
  expect(suite).not.toContain('e2e/design-shots.ts')
  expect(testFiles(['packages', 'apps'])).toContain('apps/api/src/app.test.ts')
})

Deno.test('weights are measured per file, to a tenth of a second, from a CI log', () => {
  const at = (time: string) => `2026-10-28T03:${time}0000Z`
  const log = [
    `unit 1\tUnit tests\t${at('08:39.000')} running 3 tests from ./apps/api/src/app.test.ts`,
    `unit 1\tUnit tests\t${at('08:50.240')} running 1 test from ./apps/api/src/quick.test.ts`,
    `unit 1\tUnit tests\t${at('08:50.270')} ok | 4 passed | 0 failed (11s)`,
    `e2e 1\tE2E\t${at('12:58.000')} ^[[0m^[[38;5;245mrunning 1 test from ./e2e/a.test.ts^[[0m`,
    `e2e 2\tE2E\t${at('13:00.000')} running 2 tests from ./e2e/c.test.ts`,
    `e2e 1\tE2E\t${at('13:04.000')} running 4 tests from ./e2e/b.test.ts`,
    `e2e 1\tE2E\t${at('15:22.000')} ^[[0m^[[32mok^[[0m | 5 passed | 0 failed (2m30s)`,
    `e2e 2\tE2E\t${at('13:09.000')} ok | 2 passed | 0 failed (9s)`,
  ].join('\n')
  expect(measure(log)).toEqual({
    'apps/api/src/app.test.ts': 11.2,
    'apps/api/src/quick.test.ts': 0,
    'e2e/a.test.ts': 6,
    'e2e/b.test.ts': 138,
    'e2e/c.test.ts': 9,
  })
})

// Trimmed from a real `deno test --junit-path` report: a failing test, a failing step and its
// parent, an ignored test, and a passing file.
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="deno test" tests="6" failures="3" errors="0" time="0.091">
    <testsuite name="./e2e/a.test.ts" tests="4" disabled="0" errors="0" failures="3">
        <testcase name="passes" classname="./e2e/a.test.ts" time="0.000" line="1" col="6">
        </testcase>
        <testcase name="fails &amp; says so" classname="./e2e/a.test.ts" time="0.000" line="2" col="6">
            <failure message="Uncaught Error: boom">Error: boom</failure>
        </testcase>
        <testcase name="steps" classname="./e2e/a.test.ts" time="0.000" line="3" col="6">
            <failure message="1 test step failed">1 test step failed.</failure>
        </testcase>
        <testcase name="steps &gt; inner" classname="./e2e/a.test.ts" time="0.000" line="3" col="43">
            <failure message="Uncaught Error: x">Error: x</failure>
        </testcase>
    </testsuite>
    <testsuite name="./e2e/b.test.ts" tests="1" disabled="1" errors="0" failures="0">
        <testcase name="skipped" classname="./e2e/b.test.ts" time="0.000" line="1" col="6">
            <skipped/>
        </testcase>
    </testsuite>
    <testsuite name="./e2e/c.test.ts" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="ok" classname="./e2e/c.test.ts" time="0.000" line="1" col="6">
        </testcase>
    </testsuite>
</testsuites>`

Deno.test("a JUnit report gives every file it covers and each file's failing tests", () => {
  const report = parseReport(REPORT)
  expect([...report.files]).toEqual(['e2e/a.test.ts', 'e2e/b.test.ts', 'e2e/c.test.ts'])
  expect([...report.failures]).toEqual([
    ['e2e/a.test.ts', ['fails & says so', 'steps', 'steps > inner']],
  ])
})

Deno.test('a retry covers failing files and owned files the report never mentions', () => {
  const report = parseReport(REPORT)
  // d failed to load, so the report has no entry for it; c passed; e belongs to another shard.
  expect(retryFiles(['e2e/c.test.ts', 'e2e/d.test.ts'], report)).toEqual([
    'e2e/a.test.ts',
    'e2e/d.test.ts',
  ])
  // No report at all (the run stopped early) means every owned file runs again.
  expect(retryFiles(['e2e/c.test.ts', 'e2e/d.test.ts'], null)).toEqual([
    'e2e/c.test.ts',
    'e2e/d.test.ts',
  ])
})

Deno.test('the job summary lists each retried file, its failing tests and how it did again', () => {
  const first = parseReport(REPORT)
  const again = parseReport(
    REPORT.replace('<failure message="Uncaught Error: x">Error: x</failure>', '')
      .replaceAll('./e2e/a.test.ts', './e2e/z.test.ts'),
  )
  const files = ['e2e/a.test.ts', 'e2e/c.test.ts', 'e2e/d.test.ts']
  const summary = retrySummary('test:e2e, shard 2/7', first, files, again)
  expect(summary).toContain('### test:e2e, shard 2/7: 3 test files failed')
  expect(summary).toContain(
    '- `e2e/a.test.ts`: fails & says so; steps; steps > inner. Did not report again',
  )
  expect(summary).toContain(
    '- `e2e/c.test.ts`: did not report (failed to load, or the run stopped). Passed when run again',
  )
  expect(summary).toContain(
    '- `e2e/d.test.ts`: did not report (failed to load, or the run stopped). Did not report again',
  )
  expect(outcome('e2e/z.test.ts', again)).toBe('Failed again')
  expect(outcome('e2e/c.test.ts', null)).toBe('Did not report again')
  expect(retrySummary('test, shard 1/3', first, files)).toContain(
    `More than ${MAX_RETRIED_FILES} files failed, so none were run again.`,
  )
})
