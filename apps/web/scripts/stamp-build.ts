/**
 * Stamps the web build: writes `apps/web/dist/build.json` with the commit the
 * bundle was built from and the time it was built, so /api/health and the
 * Help page can say which bundle is being served. Run by `deno task
 * build:web`; a stale bundle is then visible instead of silently masking a
 * change that never reached the browser (D1-21).
 */
import process from 'node:process'

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

const sha = process.env.BUILD_SHA?.trim() || await gitSha() || 'dev'
const stamp = { sha, builtAt: new Date().toISOString() }
await Deno.writeTextFile('./apps/web/dist/build.json', JSON.stringify(stamp, null, 2) + '\n')
console.log(`web build stamped: ${stamp.sha} at ${stamp.builtAt}`)
