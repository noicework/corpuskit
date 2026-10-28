/**
 * Splits a test suite across CI runners so its files run at the same time instead of one after
 * another: the browser E2E suite (`e2e`) and the unit tests (`packages apps`).
 *
 *   deno run --allow-read=e2e e2e/support/shard.ts ignore <shard> <shards> e2e
 *   deno run --allow-read=packages,apps e2e/support/shard.ts ignore <shard> <shards> packages apps
 *
 * prints the files under those directories that the OTHER shards own, comma separated, for
 * `deno task test:e2e --ignore=...` or `deno task test --ignore=...`. Every shard still runs the
 * whole task, so Deno itself finds the test files: a file this script does not know about is
 * ignored by no shard and runs on every shard, never on none. Files are balanced by the seconds
 * each took in CI (`shard-weights.json`), heaviest first; a file with no weight yet counts as the
 * median of its suite.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-run=deno e2e/support/shard.ts \
 *     run <task> <shard> <shards> <directory>...
 *
 * is what CI runs: `deno task <task>` with that ignore list. If it fails, the files that failed run
 * once more in the same job, and the job passes only if that second run passes. A file that
 * passes the second time is listed as flaky in the job summary. More than three failing files
 * is a breakage, not a flake, and fails at once.
 *
 *   gh run view <run id> --log | deno run e2e/support/shard.ts weights > e2e/support/shard-weights.json
 *
 * remeasures the weights from a green CI run when the shards drift out of balance.
 */
export interface Shard {
  files: string[]
  seconds: number
}

/** Deno's default test module names: `test.ts`, `*_test.ts` and `*.test.ts`, any script extension. */
const TEST_FILE = /(^|[._])test\.(ts|tsx|mts|js|mjs|jsx)$/
const SCRIPT_FILE = /\.(ts|tsx|mts|js|mjs|jsx)$/

/** The test files `deno test <roots>` runs, sorted: test names, and any script under `__tests__`. */
export function testFiles(roots: string[]): string[] {
  const found: string[] = []
  const visit = (directory: string, underTests: boolean) => {
    for (const entry of Deno.readDirSync(directory)) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory) visit(path, underTests || entry.name === '__tests__')
      else if (TEST_FILE.test(entry.name) || (underTests && SCRIPT_FILE.test(entry.name))) {
        found.push(path)
      }
    }
  }
  for (const root of roots) visit(root.replace(/\/+$/, ''), false)
  return found.sort()
}

/**
 * Deals `files` into `count` shards, heaviest first, each to the lightest shard so far. The same
 * files and weights always give the same shards, so every runner computes the same split.
 */
export function assign(files: string[], weights: Record<string, number>, count: number): Shard[] {
  if (!Number.isInteger(count) || count < 2) throw new Error(`Expected 2 or more shards: ${count}`)
  const known = files.filter((file) => file in weights).map((file) => weights[file]!)
  known.sort((a, b) => a - b)
  const median = known[Math.floor(known.length / 2)] ?? 1
  const shards: Shard[] = Array.from({ length: count }, () => ({ files: [], seconds: 0 }))
  const heaviestFirst = files
    .map((file) => ({ file, seconds: weights[file] ?? median }))
    .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1))
  for (const { file, seconds } of heaviestFirst) {
    const lightest = shards.reduce((min, shard) => shard.seconds < min.seconds ? shard : min)
    lightest.files.push(file)
    lightest.seconds += seconds
  }
  const owners = new Map<string, number>()
  for (const shard of shards) {
    if (shard.files.length === 0) throw new Error(`More shards (${count}) than test files`)
    for (const file of shard.files) owners.set(file, (owners.get(file) ?? 0) + 1)
  }
  const unowned = files.filter((file) => owners.get(file) !== 1)
  if (unowned.length > 0) throw new Error(`Not in exactly one shard: ${unowned.join(', ')}`)
  for (const shard of shards) {
    shard.files.sort()
    shard.seconds = Math.round(shard.seconds)
  }
  return shards
}

/**
 * Seconds per test file, to a tenth, from `gh run view --log` of a CI run: from each file's
 * "running N tests from" line to the next one, or to the summary line, within the same job step.
 */
export function measure(log: string): Record<string, number> {
  const seconds: Record<string, number> = {}
  const open = new Map<string, { file: string; at: number }>()
  for (const raw of log.split('\n')) {
    // Colour codes, raw or as the caret notation (`^[[0m`) gh prints them in.
    // deno-lint-ignore no-control-regex
    const [job, step, rest] = raw.replace(/(\x1b|\^\[)\[[0-9;]*m/g, '').split('\t')
    const line = rest?.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/)
    if (!line) continue
    const running = line[2]!.match(/^running \d+ tests? from \.\/(\S+)$/)
    if (!running && !/^(ok|FAILED) \| \d+ passed/.test(line[2]!)) continue
    const at = Date.parse(line[1]!)
    const key = `${job}\t${step}`
    const previous = open.get(key)
    if (previous) seconds[previous.file] = Math.round((at - previous.at) / 100) / 10
    open.delete(key)
    if (running) open.set(key, { file: running[1]!, at })
  }
  return Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => a < b ? -1 : 1))
}

/** A first run that fails in more files than this is a breakage, not a flake: no retry. */
export const MAX_RETRIED_FILES = 3

/** What a `deno test --junit-path` report says: each file it covers, and its failing tests. */
export interface Report {
  files: Set<string>
  failures: Map<string, string[]>
}

const unescape = (text: string) =>
  text.replace(
    /&(lt|gt|quot|apos|amp);/g,
    (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!,
  )

export function parseReport(xml: string): Report {
  const report: Report = { files: new Set(), failures: new Map() }
  for (const suite of xml.split('<testsuite ').slice(1)) {
    const file = suite.match(/^name="\.\/([^"]*)"/)?.[1]
    if (!file) continue
    report.files.add(unescape(file))
    const failing = suite.split('<testcase ').slice(1)
      .filter((testcase) => testcase.split('</testcase>')[0]!.includes('<failure'))
      .map((testcase) => unescape(testcase.match(/^name="([^"]*)"/)?.[1] ?? ''))
    if (failing.length > 0) report.failures.set(unescape(file), failing)
  }
  return report
}

/**
 * The files to run again after a failed first run: every file with a failing test, and every
 * file the shard owns that the report never mentions, because it failed to load or the run
 * stopped before it.
 */
export function retryFiles(owned: string[], report: Report | null): string[] {
  const files = new Set(report?.failures.keys() ?? [])
  for (const file of owned) if (!report?.files.has(file)) files.add(file)
  return [...files].sort()
}

/**
 * The job summary section for a retry, so the flaky files are kept on record. `again` is the
 * second run's report, or undefined when the files were not run again.
 */
export function retrySummary(
  label: string,
  first: Report | null,
  files: string[],
  again?: Report | null,
): string {
  const lines = [
    `### ${label}: ${files.length} test file${files.length === 1 ? '' : 's'} failed`,
    '',
    again === undefined
      ? `More than ${MAX_RETRIED_FILES} files failed, so none were run again.`
      : 'Each was run once more. A file that passed the second time is flaky.',
    '',
  ]
  for (const file of files) {
    const tests = first?.failures.get(file)?.join('; ') ??
      'did not report (failed to load, or the run stopped)'
    lines.push(`- \`${file}\`: ${tests}${again === undefined ? '' : `. ${outcome(file, again)}`}`)
  }
  return lines.join('\n') + '\n'
}

/** How a retried file did the second time. */
export function outcome(file: string, again: Report | null): string {
  if (!again?.files.has(file)) return 'Did not report again'
  return again.failures.has(file) ? 'Failed again' : 'Passed when run again'
}

interface Plan {
  files: string[]
  owned: string[]
  ignore: string[]
}

async function plan(shard: number, count: number, roots: string[]): Promise<Plan> {
  if (!Number.isInteger(shard) || shard < 1 || shard > count || roots.length === 0) {
    throw new Error('Expected <shard> <shards> <directory>..., shard from 1 to shards')
  }
  // Imported here, not at the top, so `weights > shard-weights.json` can rewrite the file.
  const recorded: Record<string, number> =
    (await import('./shard-weights.json', { with: { type: 'json' } })).default
  const files = testFiles(roots)
  const comma = files.find((file) => file.includes(','))
  if (comma) throw new Error(`The comma in ${comma} would split the --ignore list`)
  const shards = assign(files, recorded, count)
  shards.forEach(({ files, seconds }, index) => {
    const mark = index + 1 === shard ? ', this runner:' : ''
    console.error(`shard ${index + 1}/${count}: ${files.length} files, ~${seconds} s${mark}`)
  })
  const owned = shards[shard - 1]!.files
  for (const file of owned) {
    console.error(`  ${file}${file in recorded ? '' : ' (no weight yet, counted as the median)'}`)
  }
  return { files, owned, ignore: files.filter((file) => !owned.includes(file)) }
}

/** Runs `deno task <task>`, ignoring `ignore`, and returns whether it passed and its report. */
async function runTask(task: string, ignore: string[]): Promise<[boolean, Report | null]> {
  // An empty --ignore= makes Deno ignore everything.
  if (ignore.length === 0) throw new Error('Nothing to ignore: run the task directly')
  const path = `${Deno.makeTempDirSync({ prefix: 'shard-' })}/report.xml`
  const { success } = await new Deno.Command('deno', {
    args: ['task', task, `--ignore=${ignore.join(',')}`, `--junit-path=${path}`],
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn().status
  let report: Report | null = null
  try {
    report = parseReport(Deno.readTextFileSync(path))
  } catch { /* the run stopped before writing a report */ }
  return [success, report]
}

if (import.meta.main) {
  const [operation, ...args] = Deno.args
  if (operation === 'ignore') {
    const [shard, count, ...roots] = args
    console.log((await plan(Number(shard), Number(count), roots)).ignore.join(','))
  } else if (operation === 'run') {
    const [task, shard, count, ...roots] = args
    if (!task) throw new Error('Expected run <task> <shard> <shards> <directory>...')
    const { files, owned, ignore } = await plan(Number(shard), Number(count), roots)
    const [passed, first] = await runTask(task, ignore)
    if (!passed) {
      const label = `${task}, shard ${shard}/${count}`
      const retry = retryFiles(owned, first)
      const write = (text: string) => {
        console.log(text)
        const path = Deno.env.get('GITHUB_STEP_SUMMARY')
        if (path) Deno.writeTextFileSync(path, text, { append: true })
      }
      if (retry.length === 0 || retry.length > MAX_RETRIED_FILES) {
        // No report at all is a type error or a crash: nothing to list.
        if (first && retry.length > 0) write(retrySummary(label, first, retry))
        Deno.exit(1)
      }
      console.log(`\nRunning ${retry.length} failed file(s) again: ${retry.join(', ')}\n`)
      const [passedAgain, again] = await runTask(
        task,
        files.filter((file) => !retry.includes(file)),
      )
      write(retrySummary(label, first, retry, again))
      for (const file of retry) {
        const result = outcome(file, again)
        console.log(
          result === 'Passed when run again'
            ? `::warning title=Flaky test::${file} failed, then passed when run again`
            : `::error title=Failed twice::${file} failed. ${result}`,
        )
      }
      // The second run's own result decides, so a failure no file owns still fails the job.
      if (!passedAgain) Deno.exit(1)
    }
  } else if (operation === 'weights') {
    console.log(JSON.stringify(measure(await new Response(Deno.stdin.readable).text()), null, 2))
  } else {
    throw new Error('Expected ignore or run <shard> <shards> <directory>..., or weights')
  }
}
