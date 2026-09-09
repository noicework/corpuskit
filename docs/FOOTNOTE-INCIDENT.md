# LLM footnote release incident, 9 September 2026

## Confirmed

- Failed release: `67e674e6296399ddc29850e858ba86ff898d717c`, deployment run
  https://github.com/noicework/corpuskit/actions/runs/34291897385.
- Build, unit tests, health, auth and domain checks passed. The live OPAX
  in-corpus answer failed in both the deployment smoke and a subsequent manual
  smoke.
- Cloudflare historical logs for 8 September 23:45–23:55 UTC contain the exact
  error `The response citation links could not be verified`. The old code uses
  this same message for every `FootnoteError`, so the logs cannot identify which
  validation branch failed.
- Previous release `994f1b5f151cbd7232541ebf340f1a7dac960249` was restored to
  main and demo sites through a rerun of its original deployment workflow. Its
  live smoke passed all three checks, including the same OPAX question.
- Rollback PR https://github.com/noicework/corpuskit/pull/33 was independently
  reviewed and merged as `f291df01e632d6ca3586c5877c79f6a4073e12e1`, preventing
  later main deployments from reintroducing the failed code.

## Integration gaps, not yet the proven trigger

- Anonymous `extra_context` may be cited as `USER_CONTEXT_n`; the new binder
  rejects those IDs. The initial OPAX smoke ordinarily sends no such context,
  although retries can.
- Generated fields are still eligible for answer grounding but are rejected by
  the binder. Filtering citations after generation is not sufficient to exclude
  generated evidence.
- Generic metadata IDs and special graph contexts are not supported by the
  binder.
- Existing saved configurations contain `citations: true`. Request/config
  precedence needs a live test; KSP's working integration indicates the request
  should take precedence.
- Synthetic provider fixtures covered ordinary PDF locators but did not exercise
  these integration cases with real ARAG responses.

## Prepared, not released

The separate `codex/footnote-validation-fix` worktree contains a four-file
diagnostic patch: fixed reason codes, safe structured logging, and regression
tests. It changes neither public copy nor validation policy. `deno task check`:
519 tests, 1,456 steps passed. It is not a functional fix and must not be
promoted as one.

This diagnostic branch's CI job queries only historical logs. It never deploys
and prints only fixed classifications, not raw events, source text or
credentials. Do not merge the temporary diagnostic workflow into main.

## Required next step

Obtain secure access to the OPAX knowledge-box endpoint and service-account
token, or an approved existing local binding. Do not extract or publish
production Worker secrets. Capture/replay the failing upstream NDJSON with the
reason-code patch locally, then fix the confirmed cause and the affected
grounding paths. Preserve fail-closed provenance checks; do not hide errors with
a silent switch to standard citations.

Before promotion, test real corpus answers, refusal, scoped document answers,
Help isolation, follow-ups/reformatting, mixed generated/original fields,
prequeries and deep expansion. Any original-source configuration changes must
converge existing stored configurations and be verified there, not merely alter
provisioning defaults. Ship via PR, green CI, independent orchestration and the
deployment workflow. Use explicit branch push refspecs: this checkout's global
`push.default=upstream` previously pushed a branch tracking main to main.
