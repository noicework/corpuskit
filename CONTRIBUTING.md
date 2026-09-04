# Contributing

Thanks for your interest in CorpusKit. This document covers how to get set up, the gate your change
needs to pass, and the conventions the codebase follows.

## Getting set up

See `README.md` for prerequisites (Deno 2.x, the esbuild and tailwindcss standalone binaries, and a
Progress Agentic RAG account) and setup steps. There is no mock mode - you will need a real ARAG
account to run the app end-to-end, though you can read and typecheck the code without one.

## No npm

This project deliberately has no `package.json` and does not use the npm registry. Server code
resolves via Deno's native module system (JSR + `https://esm.sh/...` URLs in `deno.json`'s import
map); the front end resolves the same `esm.sh` URLs at runtime via an import map in
`apps/web/index.html`; the web bundle is built with the esbuild and tailwindcss **standalone
binaries**, not `npm`/`npx`. If your change needs a new dependency, add it as a JSR package or an
`esm.sh` URL in `deno.json` (and the import map in `index.html` if it is front-end code) - do not
introduce a `package.json`, `node_modules`, or an npm-based build step.

## The gate

Before opening a PR, run:

```sh
deno task check
```

This runs, in order: `deno check` (typecheck) on the server, provisioning script and web entry
point; `deno lint`; `deno fmt --check`; and the full test suite (`deno task test`). This is exactly
what CI runs on every push and PR - if it does not pass locally, it will not pass in CI.

Formatting and lint rules live in `deno.json` (`fmt` and `lint` keys). Run `deno fmt` to
auto-format, and `deno lint` to see lint issues directly.

## Conventions

- **Typed, tested, small increments.** Prefer several small, reviewable changes over one large one.
  New behaviour should come with tests; `apps/api/src/*.test.ts` and
  `packages/retrieval/src/env.test.ts` are the existing pattern (Deno's built-in test runner with
  `@std/testing/bdd` and `@std/expect`).
- **Australian English, no em dashes.** All user-facing copy (UI text, error messages, docs) uses
  Australian English spelling and a spaced hyphen ( - ) instead of an em dash. This applies to
  product copy; ordinary prose in comments and commit messages does not need to follow the spelling
  rule strictly, but avoid em dashes everywhere in this repo.
- **Real states, not placeholders.** Every view should have a real empty state, loading state and
  error state - no bare blank divs or lorem ipsum. See `apps/web/src/components/ui.tsx` for the
  shared `EmptyState`, `ErrorCard` and `Skeleton` components.
- **Retrieval stays behind the interface.** All AI/retrieval calls go through `packages/retrieval`'s
  `RetrievalProvider` interface (`packages/retrieval/src/provider.ts`). Do not call the Progress
  Agentic RAG API, or any other LLM/vector store, directly from `apps/web` or from route handlers in
  `apps/api`.
- **Test doubles live only in test files.** No stub or mock provider ships in product code - see
  `docs/VISION.md`'s "nothing faked, ever" decision.

## Branch and PR flow

- Open PRs against **`main`** (the active development branch; there is no separate `develop`
  development flow at present).
- A push to `main` triggers `.github/workflows/deploy.yml`, which gates the change
  (`deno task check` plus `deno task build:web`) and then, if it passes, deploys straight to the
  reference Fly deployment. This means:
  - **A PR from a fork is gated (the same CI job runs against it) but is never auto-deployed** -
    only a push to `main` itself triggers the deploy job.
  - Once a PR is merged into `main`, the resulting push does deploy automatically. Keep that in mind
    when merging - there is no separate staging step.
- Keep PRs focused and pass the gate before requesting review.
