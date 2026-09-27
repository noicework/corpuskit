/**
 * Stamps the web build: writes `apps/web/dist/build.json` with the commit the
 * bundle was built from, the time it was built and the newest dated release in
 * CHANGELOG.md, so /api/health and the Help page can say which bundle is being
 * served. Run by `deno task build:web`; a stale bundle is then visible instead
 * of silently masking a change that never reached the browser (D1-21).
 */
import process from 'node:process'
import { latestRelease, parseChangelog } from './changelog.ts'

async function gitSha(): Promise<string | null> {
  try {
    const out = await new Deno.Command('git', {
      args: ['rev-parse', '--short=12', 'HEAD'],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    const sha = new TextDecoder().decode(out.stdout).trim()
    return out.success && sha ? sha : null
  } catch {
    return null
  }
}

/** The release a build from this tree contains at least; commits after it keep that release. */
async function release(): Promise<string | null> {
  try {
    return latestRelease(parseChangelog(await Deno.readTextFile('./CHANGELOG.md')))?.version ?? null
  } catch (error) {
    console.warn(
      `web build stamp has no release: ${error instanceof Error ? error.message : error}`,
    )
    return null
  }
}

const sha = process.env.BUILD_SHA?.trim() || await gitSha() || 'dev'
const version = await release()
const stamp = { sha, builtAt: new Date().toISOString(), ...(version ? { release: version } : {}) }
await Deno.writeTextFile('./apps/web/dist/build.json', JSON.stringify(stamp, null, 2) + '\n')
console.log(`web build stamped: ${stamp.sha}${version ? ` (${version})` : ''} at ${stamp.builtAt}`)
