/**
 * Reads CHANGELOG.md, which follows Keep a Changelog: an intro, then one `## [version]` section
 * per release, newest first, with `## [Unreleased]` on top. Versions are CalVer (`2026.9.27`,
 * or `2026.9.27.1` for a second release that day). The release notes task, the build stamp and the
 * public Release notes page all read it through this module, so a malformed changelog fails the
 * test suite rather than a release.
 */

export const UNRELEASED = 'Unreleased'

/** `YYYY.M.D` without zero padding, with an optional `.N` for a later release the same day. */
export const CALVER = /^(\d{4})\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])(?:\.([1-9]\d*))?$/

export interface ChangelogRelease {
  /** `Unreleased`, or a CalVer version such as `2026.9.27`. */
  version: string
  /** The release date as `YYYY-MM-DD`; absent for Unreleased. */
  date?: string
  /** The section's Markdown under its heading, trimmed, with link definitions removed. */
  body: string
}

export interface Changelog {
  /** The Markdown above the first release heading, without the `# ` title line. */
  intro: string
  releases: ChangelogRelease[]
}

const RELEASE_HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/
const LINK_DEFINITION = /^\[[^\]\n]+\]:\s+\S+$/

/** Parses and validates the changelog; throws on anything a release could not rely on. */
export function parseChangelog(source: string): Changelog {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const intro: string[] = []
  const releases: { version: string; date?: string; lines: string[] }[] = []
  for (const line of lines) {
    if (LINK_DEFINITION.test(line)) continue
    if (line.startsWith('## ')) {
      const heading = RELEASE_HEADING.exec(line.trimEnd())
      if (!heading) throw new Error(`Unrecognised release heading: ${line}`)
      const [, version, date] = heading as unknown as [string, string, string | undefined]
      releases.push({ version, date, lines: [] })
    } else if (releases.length) {
      releases[releases.length - 1]!.lines.push(line)
    } else if (!/^# /.test(line)) {
      intro.push(line)
    }
  }

  const seen = new Set<string>()
  let previous: string | undefined
  releases.forEach((release, index) => {
    if (seen.has(release.version)) throw new Error(`Duplicate release: ${release.version}`)
    seen.add(release.version)
    if (release.version === UNRELEASED) {
      if (index !== 0) throw new Error('Unreleased must be the first section')
      if (release.date) throw new Error('Unreleased takes no date')
      return
    }
    const calver = CALVER.exec(release.version)
    if (!calver) throw new Error(`Release ${release.version} is not a CalVer version`)
    if (!release.date) throw new Error(`Release ${release.version} has no date`)
    const [, year, month, day] = calver
    const expected = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`
    if (release.date !== expected) {
      throw new Error(`Release ${release.version} is dated ${release.date}, expected ${expected}`)
    }
    if (previous && compareVersions(release.version, previous) >= 0) {
      throw new Error(`Release ${release.version} must come after ${previous}, newest first`)
    }
    previous = release.version
  })

  return {
    intro: intro.join('\n').trim(),
    releases: releases.map(({ version, date, lines }) => ({
      version,
      ...(date ? { date } : {}),
      body: lines.join('\n').trim(),
    })),
  }
}

/** Orders two CalVer versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => {
    const match = CALVER.exec(version)
    if (!match) throw new Error(`Not a CalVer version: ${version}`)
    return [match[1], match[2], match[3], match[4] ?? '0'].map(Number)
  }
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < left.length; i++) {
    const difference = left[i]! - right[i]!
    if (difference) return difference
  }
  return 0
}

/** Accepts `2026.9.27`, the tag form `v2026.9.27`, or `unreleased` in any case. */
export function normaliseVersion(input: string): string {
  const value = input.trim()
  if (value.toLowerCase() === 'unreleased') return UNRELEASED
  return value.replace(/^v(?=\d)/, '')
}

/** The newest dated release, which is what a build from this tree contains at least. */
export function latestRelease(changelog: Changelog): ChangelogRelease | undefined {
  return changelog.releases.find((release) => release.version !== UNRELEASED)
}

/** One release's notes, ready for `gh release create --notes-file -`. Throws if absent or empty. */
export function releaseNotes(source: string, version: string): string {
  const wanted = normaliseVersion(version)
  const release = parseChangelog(source).releases.find((r) => r.version === wanted)
  if (!release) throw new Error(`CHANGELOG.md has no section for ${wanted}`)
  if (!/[^\s]/.test(release.body)) throw new Error(`CHANGELOG.md section ${wanted} is empty`)
  return release.body
}
