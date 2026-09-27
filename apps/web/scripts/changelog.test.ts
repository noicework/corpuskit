import { expect } from '@std/expect'
import {
  compareVersions,
  latestRelease,
  normaliseVersion,
  parseChangelog,
  releaseNotes,
  UNRELEASED,
} from './changelog.ts'
import { run } from './release-notes.ts'

const changelog = await Deno.readTextFile(new URL('../../../CHANGELOG.md', import.meta.url))

const sample = `# Changelog

Intro with [a link](https://example.org).

## [Unreleased]

- Pending work.

## [2026.9.27.1] - 2026-09-27

### Fixed

- A same-day fix.

## [2026.9.27] - 2026-09-27

### Added

- A feature. ([#69](https://github.com/noicework/corpuskit/pull/69))
  - A detail.

## [2026.9.5] - 2026-09-05

[Unreleased]: https://github.com/noicework/corpuskit/compare/v2026.9.27.1...HEAD
[2026.9.27]: https://github.com/noicework/corpuskit/compare/v2026.9.5...v2026.9.27
`

function io(source: string) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    readChangelog: () => Promise.resolve(source),
    write: (text: string) => out.push(text),
    error: (text: string) => err.push(text),
  }
}

Deno.test('parses the intro, releases in order and bodies without link definitions', () => {
  const parsed = parseChangelog(sample)
  expect(parsed.intro).toBe('Intro with [a link](https://example.org).')
  expect(parsed.releases.map((r) => [r.version, r.date])).toEqual([
    [UNRELEASED, undefined],
    ['2026.9.27.1', '2026-09-27'],
    ['2026.9.27', '2026-09-27'],
    ['2026.9.5', '2026-09-05'],
  ])
  expect(parsed.releases[2]!.body).toBe(
    '### Added\n\n- A feature. ([#69](https://github.com/noicework/corpuskit/pull/69))\n  - A detail.',
  )
  expect(parsed.releases[3]!.body).toBe('')
  expect(latestRelease(parsed)?.version).toBe('2026.9.27.1')
})

Deno.test('prints one release section for the tag, bare and Unreleased forms', () => {
  expect(releaseNotes(sample, 'v2026.9.27.1')).toBe('### Fixed\n\n- A same-day fix.')
  expect(releaseNotes(sample, '2026.9.27')).toContain('- A feature.')
  expect(releaseNotes(sample, '2026.9.27')).not.toContain('same-day')
  expect(releaseNotes(sample, 'unreleased')).toBe('- Pending work.')
})

Deno.test('refuses a missing or empty version', () => {
  expect(() => releaseNotes(sample, '2026.9.28')).toThrow('no section for 2026.9.28')
  expect(() => releaseNotes(sample, '2026.9.5')).toThrow('section 2026.9.5 is empty')
})

Deno.test('rejects a changelog a release could not rely on', () => {
  const release = (heading: string) => `# Changelog\n\n${heading}\n\n- Change.\n`
  const cases: [string, string][] = [
    [release('## 2026.9.27'), 'Unrecognised release heading'],
    [release('## [2026.09.27] - 2026-09-27'), 'not a CalVer version'],
    [release('## [2026.9.27]'), 'has no date'],
    [release('## [2026.9.27] - 2026-09-26'), 'expected 2026-09-27'],
    [release('## [Unreleased] - 2026-09-27'), 'Unreleased takes no date'],
    [
      `${release('## [2026.9.5] - 2026-09-05')}\n## [Unreleased]\n`,
      'Unreleased must be the first section',
    ],
    [
      `${release('## [2026.9.5] - 2026-09-05')}\n## [2026.9.27] - 2026-09-27\n`,
      'newest first',
    ],
    [
      `${release('## [2026.9.5] - 2026-09-05')}\n## [2026.9.5] - 2026-09-05\n`,
      'Duplicate release',
    ],
  ]
  for (const [source, message] of cases) expect(() => parseChangelog(source)).toThrow(message)
})

Deno.test('orders and normalises calendar versions', () => {
  expect(compareVersions('2026.9.27', '2026.10.1')).toBeLessThan(0)
  expect(compareVersions('2026.9.27.1', '2026.9.27')).toBeGreaterThan(0)
  expect(compareVersions('2026.9.27', '2026.9.27')).toBe(0)
  expect(normaliseVersion(' v2026.9.27 ')).toBe('2026.9.27')
  expect(normaliseVersion('UNRELEASED')).toBe(UNRELEASED)
})

Deno.test('the release notes task prints the section and exits 0', async () => {
  const streams = io(sample)
  expect(await run(['v2026.9.27.1'], streams)).toBe(0)
  expect(streams.out).toEqual(['### Fixed\n\n- A same-day fix.'])
  expect(streams.err).toEqual([])
})

Deno.test('the release notes task exits non-zero without a usable section', async () => {
  for (
    const [args, code] of [[[], 2], [['2026.9.27', 'extra'], 2], [['2026.9.28'], 1], [
      ['2026.9.5'],
      1,
    ]]
  ) {
    const streams = io(sample)
    expect(await run(args as string[], streams)).toBe(code)
    expect(streams.out).toEqual([])
    expect(streams.err).toHaveLength(1)
  }
  const unreadable = { ...io(sample), readChangelog: () => Promise.reject(new Error('gone')) }
  expect(await run(['2026.9.27'], unreadable)).toBe(1)
})

Deno.test('CHANGELOG.md parses and every dated release has notes', () => {
  const parsed = parseChangelog(changelog)
  expect(parsed.releases[0]?.version).toBe(UNRELEASED)
  const dated = parsed.releases.filter((release) => release.version !== UNRELEASED)
  expect(dated.length).toBeGreaterThan(0)
  for (const release of dated) {
    const notes = releaseNotes(changelog, release.version)
    // Notes go into a GitHub release on their own, so links must be inline, not reference style.
    expect(notes).not.toMatch(/\]\[|^\[[^\]]+\]:/m)
    expect(notes).toMatch(/^### (Added|Changed|Fixed|Security|Upgrade notes)$/m)
  }
  expect(changelog).not.toContain('—')
  // Every release a heading names has a compare or tag link at the foot.
  for (const release of parsed.releases) {
    expect(changelog).toContain(`\n[${release.version}]: https://github.com/noicework/corpuskit/`)
  }
})
