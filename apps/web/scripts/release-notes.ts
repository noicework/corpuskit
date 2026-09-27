/**
 * Prints one version's section of CHANGELOG.md, for the GitHub release body. Capture it first, so
 * a failure stops before gh runs instead of publishing an empty release:
 *
 *   notes=$(deno task release:notes 2026.9.27) &&
 *     printf '%s\n' "$notes" | gh release create v2026.9.27 --notes-file - ...
 *
 * Accepts `2026.9.27`, `v2026.9.27` or `unreleased`. Exits 1 when the version has no section or
 * the section is empty, and 2 without a version. See docs/RELEASING.md.
 */
import { releaseNotes } from './changelog.ts'

export interface ReleaseNotesIo {
  readChangelog: () => Promise<string>
  write: (text: string) => void
  error: (text: string) => void
}

export async function run(args: string[], io: ReleaseNotesIo): Promise<number> {
  const [version, ...rest] = args
  if (!version || rest.length) {
    io.error('Usage: deno task release:notes <version>, for example 2026.9.27')
    return 2
  }
  try {
    io.write(releaseNotes(await io.readChangelog(), version))
    return 0
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  Deno.exit(
    await run(Deno.args, {
      readChangelog: () => Deno.readTextFile(new URL('../../../CHANGELOG.md', import.meta.url)),
      write: (text) => console.log(text),
      error: (text) => console.error(text),
    }),
  )
}
