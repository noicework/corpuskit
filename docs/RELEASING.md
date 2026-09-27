# Releasing CorpusKit

Every push to `main` passes the gate and then deploys, so production is normally the tip of `main`
once that deploy succeeds; a failed or running deploy leaves it on an earlier commit, so check the
deploy. A release names one of those deployed commits: a `vYYYY.M.D` tag on it, a dated section in
[`CHANGELOG.md`](../CHANGELOG.md), and a GitHub release carrying that section. Operators upgrade
from release to release and read the notes in between.

## Versions

Releases use calendar versions: `YYYY.M.D` for the day the release is cut, in Australian Eastern
time, without zero padding, tagged with a leading `v`. The release cut on 27 September 2026 is `2026.9.27`, tagged
`v2026.9.27`. A second release on the same day adds `.1`, then `.2`: `v2026.9.27.1`.

Releases are cut from `main` only. The version says when, not how much changed: read the Upgrade
notes to judge an upgrade.

## Keeping the changelog

Every pull request that changes what a reader, a curator or an operator sees adds its lines under
`## [Unreleased]` in `CHANGELOG.md`, in the same pull request. Nothing waits for release day.

- File each line under Added, Changed, Fixed or Security, and add Upgrade notes when an operator
  must act or decide (see below). Leave out a heading with nothing under it.
- Lead with the effect a person notices, then the detail: "Readers can no longer see hidden
  drafts", not "Filter catalogue rows on `hidden`". Write for both audiences at once: people
  using a portal and people running one.
- End each line with its pull request as an inline link, such as
  `([#69](https://github.com/noicework/corpuskit/pull/69))`. The notes are published on their own
  as a GitHub release, so reference-style links do not work there.
- List a change only once it merges: the changelog on `main` describes `main`. Unmerged work stays
  out, above all a security fix, whose lines would describe the weakness before the fix ships. Its
  pull request adds them.
- Plain, factual and positive, in Australian English, with no em dashes. Describe a portal made
  for a particular organisation generically, and keep commercial matters out: this is a public
  repository.

The public [Release notes page](https://corpuskit.org/docs/release-notes) renders the changelog
through the documentation's strict Markdown renderer, and `deno task check` renders all of it. So:

- one line per bullet, with no hard wrapping (the file is excluded from `deno fmt` for this);
- nested bullets indented two spaces, one level deep;
- identifiers, paths, settings and anything containing `_`, `*`, `<`, `>` or `|` in backticks;
- absolute link URLs;
- no tables, block quotes or images.

## Upgrade notes

An upgrade note is anything the person running a deployment must do, decide or expect when moving
to this release. It belongs in Upgrade notes when it is:

- a new setting, with its default and what the default does, or a changed default;
- a setting that must be set before the upgrade, and what fails without it;
- behaviour that changes on upgrade without anyone touching a setting: a response that becomes a
  404, a feature that becomes opt-in, people who must sign in again;
- a change to stored data: a new table, a new field in a stored record, a migration, a record
  kind that retention or erasure now covers;
- a change to the API or the health response that automation relies on;
- whether rolling back is safe.

Lead with the action, in bold when missing it breaks something: "**Set `BINDING_KEY` before
upgrading**". Give each setting its default in the same sentence.

### Rollback safety

The deploy workflow restores the exact previous Worker version when post-deploy verification
fails, and an operator can roll back by hand. Stored data is never rolled back with the code. So
the question to answer is: can the previous release run correctly on the data this release has
written? State one of these, naming the release rolled back to:

- **Safe.** Say why in a clause: "nothing stored changes, and health drops the new fields".
- **Safe, with effects.** Name what the older code ignores, drops, refuses or exposes, and what to
  do: "that release ignores aliases, and its next registry write drops them; stop routing alias
  hostnames first".
- **Not safe after a step.** Name the step and the release not to go below: "once any token is
  sealed, do not roll back to a release before 2026.9.25".

Say what no rollback restores, such as erased records, and what a rollback exposes again, such as
a leak this release fixed.

Check the claim against the previous release's code, not this release's tests. A compatibility
test pins whichever build it was written against, which may be inside the same release. For every
record this release writes, find how the previous release parses it: a strict schema refuses a
field it does not know, a lenient one ignores it, and a later write by the older code may drop it.

## Cutting a release

The steps use `2026.10.2` for the version being cut and `2026.9.27` for the previous release.

1. **Check that `main` is green and deployed.** The latest `Gate and deploy CorpusKit` run on `main`
   must have succeeded for the commit at the tip of `main`, including the documentation demo, and
   production must be serving that commit:

   ```sh
   git fetch noicework main
   git rev-parse --short=12 noicework/main
   gh run list -R noicework/corpuskit --workflow deploy.yml --branch main --limit 1 \
     --json headSha,status,conclusion
   curl -s https://corpuskit.org/api/health
   ```

   The run's `conclusion` must be `success` with `headSha` at the tip of `main`, and health's
   `buildSha` must be that commit. Do not release while a deploy is running or after one failed.

2. **Move Unreleased into a dated section**, on a branch off `noicework/main`
   (`release/v2026.10.2`):
   - Add `## [2026.10.2] - 2026-10-02` under `## [Unreleased]`, and move every entry into it.
   - Open the section with one sentence saying what the release is about.
   - Check each Upgrade note, and state rollback safety to the previous release.
   - Leave `## [Unreleased]` in place, empty.
   - At the foot, point `[Unreleased]` at `compare/v2026.10.2...HEAD` and add
     `[2026.10.2]: https://github.com/noicework/corpuskit/compare/v2026.9.27...v2026.10.2`.
   - Run `deno task release:notes 2026.10.2` and read what it prints, then `deno task check`.
   - Open a pull request titled `Release v2026.10.2`. It merges like any other and deploys, which
     also publishes the new section on the Release notes page.

3. **Tag the merge commit** once its deploy has succeeded (repeat step 1 for it). Health's
   `release` then reads `2026.10.2`.

   ```sh
   git fetch noicework main
   git tag -a v2026.10.2 <merge commit> -m "CorpusKit 2026.10.2"
   git push noicework v2026.10.2
   ```

4. **Create the GitHub release from that section.** `deno task` writes its own banner to standard
   error, so standard output carries only the notes. The task exits non-zero when the section is
   missing or empty; capture the notes first, so a failure stops before `gh` runs rather than
   publishing an empty release:

   ```sh
   notes=$(deno task release:notes 2026.10.2) &&
     printf '%s\n' "$notes" | gh release create v2026.10.2 -R noicework/corpuskit \
       --verify-tag --title "CorpusKit 2026.10.2" --notes-file -
   ```

## Pre-release checklist

- [ ] The latest deploy run on `main` succeeded, and health's `buildSha` is the tip of `main`.
- [ ] Every merged pull request since the last release has its lines under Unreleased.
- [ ] Every new or changed setting is in Upgrade notes with its default.
- [ ] Behaviour that changes on upgrade, and every stored-data change, is in Upgrade notes.
- [ ] Rollback safety to the previous release is stated.
- [ ] `HOSTING.md` and `.env.example` agree with the Upgrade notes.
- [ ] No client or prospect names, commercial matters or em dashes.
- [ ] `deno task release:notes <version>` prints the section, and `deno task check` passes.
- [ ] After merging: the deploy succeeded, health's `release` is the new version, the tag is on
      the merge commit, and the GitHub release shows the notes.

## History before this process

Releases up to 2026.9.27 were cut from the history after the fact. Their tags go on these
commits:

| Tag | Commit | Last pull request |
|---|---|---|
| `v2026.9.5` | `03cd0f5` | #17 |
| `v2026.9.11` | `817ba07` | #40 |
| `v2026.9.12` | `f82f164` | #44 |
| `v2026.9.13` | `9e63f0b` | #48 |
| `v2026.9.17` | `39cc855` | #57 |
| `v2026.9.25` | `5c9eec9` | #61 |
| `v2026.9.26` | `b4695e4` | #67 |
| `v2026.9.27` | `3365b4f` | #70 |

The changelog that describes them merged later, so these builds report no `release` in health.
Tag them and create their releases oldest first, from a checkout that has the changelog, so the
newest becomes the latest release:

```sh
while read -r tag commit; do
  git tag -a "$tag" "$commit" -m "CorpusKit ${tag#v}"
done <<'TAGS'
v2026.9.5 03cd0f5
v2026.9.11 817ba07
v2026.9.12 f82f164
v2026.9.13 9e63f0b
v2026.9.17 39cc855
v2026.9.25 5c9eec9
v2026.9.26 b4695e4
v2026.9.27 3365b4f
TAGS
git push noicework v2026.9.5 v2026.9.11 v2026.9.12 v2026.9.13 v2026.9.17 v2026.9.25 v2026.9.26 \
  v2026.9.27

for version in 2026.9.5 2026.9.11 2026.9.12 2026.9.13 2026.9.17 2026.9.25 2026.9.26 2026.9.27; do
  notes=$(deno task release:notes "$version") || break
  printf '%s\n' "$notes" | gh release create "v$version" -R noicework/corpuskit \
    --verify-tag --title "CorpusKit $version" --notes-file - || break
done
```
