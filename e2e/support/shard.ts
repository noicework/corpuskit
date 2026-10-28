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

if (import.meta.main) {
  const [operation, shardArg, countArg, ...roots] = Deno.args
  if (operation === 'ignore') {
    const shard = Number(shardArg)
    const count = Number(countArg)
    if (!Number.isInteger(shard) || shard < 1 || shard > count || roots.length === 0) {
      throw new Error('Expected ignore <shard> <shards> <directory>..., shard from 1 to shards')
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
    for (const file of shards[shard - 1]!.files) {
      console.error(`  ${file}${file in recorded ? '' : ' (no weight yet, counted as the median)'}`)
    }
    console.log(shards.flatMap((other, index) => index + 1 === shard ? [] : other.files).join(','))
  } else if (operation === 'weights') {
    console.log(JSON.stringify(measure(await new Response(Deno.stdin.readable).text()), null, 2))
  } else {
    throw new Error('Expected ignore <shard> <shards> <directory>..., or weights with a CI log')
  }
}
