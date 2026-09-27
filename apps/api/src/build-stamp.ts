/**
 * The web build's stamp: the commit the bundle was built from, when it was built, and the newest
 * CHANGELOG.md release it contains. `deno task build:web` writes it to apps/web/dist/build.json
 * (apps/web/scripts/stamp-build.ts); the local server reads that file and the Worker carries it in
 * its bundle (apps/cloudflare/src/build-stamp.ts). /api/health reports it.
 */
export interface WebBuildStamp {
  sha: string
  builtAt: string
  /** Absent when the tree had no dated release in CHANGELOG.md. */
  release?: string
}

/** The stamp's scalar fields, or undefined when the value is not a stamp. */
export function webBuildStamp(raw: unknown): WebBuildStamp | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { sha, builtAt, release } = raw as Record<string, unknown>
  if (typeof sha !== 'string' || !sha || typeof builtAt !== 'string' || !builtAt) return undefined
  return { sha, builtAt, ...(typeof release === 'string' && release ? { release } : {}) }
}
