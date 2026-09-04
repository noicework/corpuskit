# CorpusKit - working notes for agents and contributors

## What this is
CorpusKit is a **research portal**: a web application where someone explores a body of research
and gets fast, credible, beautifully designed answers and discovery. It is built as a reference
application - the standard other teams point to, not a prototype.

Point it at an empty Progress Agentic RAG knowledge box and it provisions and configures
everything for the domain you describe, then opens as a branded, cited, explorable portal over
your corpus.

## The bar
- **Design & UX**: considered typography, spacing, motion, and real empty/loading/error states;
  responsive to mobile (test at 390px) and up to large displays; accessible (WCAG AA).
- **Performance**: fast first paint, streamed answers, no jank; works on a throttled connection.
- **Content credibility**: real, cited sources; never a bare unattributed answer.
- **Code quality**: typed, tested, readable; no dead scaffolding; production-grade.
- **Discovery, not just search**: browse, filter, related work, a knowledge graph you explore.

Keep the retrieval/answer/AI layer behind the `RetrievalProvider` interface. Do NOT hardcode a
specific LLM or vector store into the UI or the components. See `docs/VISION.md` for the
standing principles and `docs/ARCHITECTURE.md` for the layering.

## Conventions
- Small, typed, tested increments; a render/lint/test loop before calling anything done.
- Real content over placeholders; real empty/error/loading states, not blank divs.
- **All frontend work plugs into the tenant appearance system** (colour roles, grey suites,
  typography, text scale, shape and density dials) - the token contract and the rules live in
  `apps/web/CLAUDE.md` under "The appearance system"; hardcoded colours/radii/heights that the
  tokens cover are bugs even when they look right on the default portal.
- Australian English, no em dashes (spaced hyphen) in any user-facing copy - this becomes a
  Progress asset.
- Secrets live in `.env` only (gitignored).
- **Branching and delivery - this is the process, not a suggestion.**
  - `main` is production. A push to `main` deploys the `corpuskit` Cloudflare Worker. Nothing else
    deploys.
  - **Never commit or push directly to `main`.** Never run a production deploy from a developer
    machine.
  - Work on a short-lived branch off `main`, one branch per piece of work, then
    **open a pull request**. CI (typecheck, lint, format, tests, web build) runs
    on every PR; a red PR is not merge-ready.
  - An **orchestration agent drains merge-ready PRs into `main`**. It is the only
    thing that merges. Its job is to check CI is green, resolve conflicts against
    current `main`, merge in a sensible order when PRs touch the same files, and
    stop and escalate rather than force anything through.
  - So the order is: **branch -> PR -> CI green -> orchestrator merges to main ->
    main deploys to Cloudflare.** A change that fails the gate never reaches
    production, and no single agent both writes and ships its own work.
  - **Every agent works in its own git worktree**, never in the shared checkout.
    One worktree, one branch, one PR. Branch from `noicework/main` explicitly
    (`git fetch noicework main && git checkout -B <branch> noicework/main`) - the
    shared checkout's HEAD is routinely a stale branch, and inheriting it
    silently bases the work on the wrong commit.
  - Parallel agents must take disjoint file sets and their own branches. Two
    agents editing the same file in one working tree is how you lose work.
  - Never `git add` a whole directory. The shared checkout usually carries other
    people's in-progress edits, and `git add apps/web/src` has already swept a
    second agent's half-finished file into an unrelated commit. Stage named
    files, and when one file holds both your change and someone else's, stage
    only your own hunks.
  - **Each agent gets its own dev-server port** (8791, 8792, ... one per agent).
    Kill only your own: `lsof -ti tcp:<port> | xargs kill`. A broad
    `pkill -f "apps/api/src/server.ts"` matches every worktree's server and has
    taken down five agents at once. A dead server renders blank or half-loaded
    pages that look exactly like layout defects, so anything measured around an
    unexplained restart has to be measured again.
  - Write scratch files and logs to a path unique to your agent. Agents have
    overwritten each other's shared log paths and lost their own output.

## Operating rules - these are HARD rules
See `docs/VISION.md` for the standing principles behind these. The essentials:

- **Testing bar - do NOT call UI work "done" or "tested" on gates alone.** `deno task check` +
  `build:web` are necessary, not sufficient. Every UI change must be VISUALLY verified in a real
  browser on the live/deployed page: light mode AND dark mode, wide desktop AND ~390px mobile,
  the change plus the surrounding chrome (header, rails, scroll). Only then is it "done", and say
  what was visually verified - never claim "tested" for gates-only. Confirm it is actually served
  (version/cache check) before saying it is live.
- **Mobile must be measured at a real 390px layout viewport, and resizing the window is NOT
  one.** In this environment Chrome's layout viewport does not follow a window resize
  (`innerWidth` stays ~1974 while `outerWidth` changes), so resize-based mobile checks pass
  while the phone is still broken. Load the page in a 390px-wide iframe instead - an iframe
  gets a true layout viewport - and measure through `iframe.contentDocument`. The app sends
  `frame-ancestors 'none'`, so framing it locally needs that header temporarily relaxed to
  `'self'` in `apps/api/src/app.ts`; that is a LOCAL probe and must be reverted before
  committing (a test asserts `'none'`, and shipping `'self'` is a security regression).
  Add `transform: scale(2.3)` to the iframe to read screenshots - it magnifies without
  changing the layout viewport, so trust measured rects over apparent size.
- **Check a scaled-up system font.** Several real defects here only appeared at a ~22px root
  font: fixed-height boxes whose text spilled their own border, and flex rows with no
  `min-w-0` that pushed the document wider than the viewport. Phones with large-text
  accessibility settings hit these; a default-font check does not.
- **Nothing but the best.** No "vibe coded" look, no visual/theme bugs shipped. Translucent
  surfaces must not let content bleed through (header, tiles); check both themes.
- **Use the full screen on large displays.** Responsive scales UP (27-inch, maximised) not only
  down to mobile - wider containers, more columns, content that breathes on 2xl+, prose kept at a
  readable measure. Fixed centred `max-w-6xl` that strands half a monitor is the anti-pattern.
- **Exploit Progress Agentic RAG maximally.** Use platform features rather than rebuilding them.
- **SQLite (`node:sqlite`) for admin state** that cannot/should not live in the knowledge box.
  This supersedes the earlier no-SQLite rule (JSON stores remain only until the migration).
- **Search-config isolation is central, not per-request.** Encode label filters in the named
  stored search configurations (portal-search/portal-ask exclude `documentation`; a docs config
  includes only `documentation`), not in runtime filter params - so isolation is centrally managed.
- **Merchandising:** resources display via DA-generated fields (title, hook, summary, key
  takeaways, stat, year/authors, tags), never raw filenames like `1981-071-DLD.pdf`.
- **Acceptance:** a release needs a full functional acceptance sweep - every feature exercised
  against a real knowledge box, all green. See `docs/TEST-FRAMEWORK.md`.

## Model & orchestration
Default is **`fable`** (set in `.claude/settings.json`). Fable acts as **product owner and
orchestrator**: it owns product decisions, contracts (schemas, interfaces, API shape) and review,
and delegates well-specified implementation to subagents with the model matched to the job -
Sonnet for spec-driven implementation, Opus/Fable for judgment-heavy passes (architecture, the
design system, the world-class polish), Haiku only for trivial mechanical sweeps.

## Developing on Progress Agentic RAG - READ FIRST
This portal provisions and configures ARAG knowledge boxes, so you are developing on Progress
Agentic RAG from day one, not "later". **`docs/ARAG-DEV.md` is the hard-won reference** - the
working call shapes, the credential model (which token for which call - most 403s are a
wrong-token bug), the provisioning recipe, and every KNOWN PLATFORM BUG (the `json:true` DA
generator and the RAO `/session/ephemeral` agent-session are both broken - don't burn cycles
rediscovering them). Read it before writing any retrieval or provisioning code, and put ARAG
behind the `RetrievalProvider` interface so a stub covers local dev. When you hit something it
doesn't cover, ask rather than probing the live platform blindly.

