<h1 align="center">CorpusKit</h1>

<p align="center"><strong>An open source research portal.</strong></p>

<p align="center">
Point it at an empty Progress Agentic RAG knowledge box.<br>
It reads your corpus, designs the taxonomy and the knowledge graph around it,<br>
writes the questions worth asking, and opens as a branded portal.
</p>

<p align="center">
<a href="https://corpuskit.org">Website</a> ·
<a href="https://corpuskit.org/docs">Documentation</a> ·
<a href="#showcase">Showcase</a> ·
<a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
<img alt="Licence: Apache 2.0" src="https://img.shields.io/badge/licence-Apache%202.0-blue.svg">
<img alt="Deno 2" src="https://img.shields.io/badge/Deno-2.x-black.svg">
</p>

---

## The problem this solves

The research is all there. Nobody can ask it a question.

Decades of final reports, reviews and briefings, sitting across drives, archives and a website
search box that matches on filenames. The work is findable only by the people who already know it
exists, and they are the ones retiring.

CorpusKit is a thin application layer you point at an empty knowledge box. It provisions and
configures a complete, branded research portal on top of that box - corpus, knowledge graph,
labels, agents and suggested questions - then gives an organisation's researchers a fast, cited
way to explore and question their entire research estate.

## What you get

| | |
|---|---|
| **Explore** | The front door. One ask box, questions generated from your own corpus, and topic rows built from the taxonomy the portal designed. |
| **Search** | Hybrid, semantic or keyword, with faceted filters, matched passages and a cited answer alongside the ranked results. |
| **Ask** | A conversation over the whole corpus. Streamed, numbered citations, per-source confidence, and an evidence table that persists. |
| **Library** | Every resource with a real title, a summary and key takeaways. Open one and ask questions of that document alone. |
| **Knowledge graph** | Entities and the relations between them, extracted from the corpus and explorable. A fisheries portal and a grains portal look different. |
| **Investigations** | A named research question that accumulates evidence over weeks, with provenance on every piece of it. |
| **Tools** | A dedicated home for focused research tools as they become available. |
| **Manage** | Corpus health, enrichments, taxonomy, graph strategy and the knowledge box binding, all in the app. |

## An answer you can check

A research organisation cannot act on an answer it cannot trace. Every answer is built to be
audited, and the confidence in it is stated rather than implied.

- **Grounded in the corpus.** Retrieval runs over your documents with a reranking pass,
  neighbouring-paragraph and full-resource strategies, and the knowledge graph in the loop.
- **Cited, and the citation opens.** Numbered citations map to a source list, and every one
  resolves to the real document at the passage it came from.
- **Scored, per source and per answer.** The platform's own evaluation model scores the answer, and
  each source carries a confidence the reader can see.
- **Honest when it is thin.** A weak answer is labelled as one, in plain language, rather than
  presented with the same confidence as a strong one.

## Showcase

Two portals, one codebase. Each is a fictional organisation provisioned from the small synthetic
seed corpus in `content/seed`, so the whole product can be seen working before you point it at
your own knowledge box.

- **Southern Waters Research Institute** (`marine`) - a fisheries and aquaculture research portal.
- **Dryland Cropping Research Alliance** (`grains`) - a grains research portal.

## Prerequisites

- **Deno 2.x** (developed against 2.9.5).
- **esbuild** and **tailwindcss**, as standalone binaries on your `PATH` (not via npm - see below).
  Versions are pinned in `Dockerfile` and `.github/workflows/deploy.yml`; keep your local binaries
  in step with those pins (esbuild 0.28.2, Tailwind CSS 4.3.3 at time of writing).
- **A Progress Agentic RAG account** (zone, account id, NUA key). There is no mock mode - this is a
  deliberate product decision ("nothing faked, ever"): the portal always talks to live knowledge
  boxes, never a stub. You cannot run this end-to-end without one.

### Why no npm tooling

This project deliberately does not use npm-based tooling: there is no `package.json`, no
`node_modules` directory, and no `npm install` step (`deno.json` sets `nodeModulesDir: "none"`).
Dependencies are resolved by Deno itself:

- Server and shared code: Deno's native module resolution, via `deno.json` import maps - JSR
  packages (e.g. `hono`) and `https://esm.sh/...` URLs.
- Front end (React, TanStack Query, React Router, Zod, d3-force): also `esm.sh` URLs, wired into the
  browser via an `<script type="importmap">` in `apps/web/index.html`, loaded at runtime with no
  bundler-side dependency resolution.
- A small number of **`npm:` specifiers** in `deno.json`, where a package has no JSR or esm.sh
  equivalent worth using - currently the Model Context Protocol server SDK behind the Tools page
  connector, and its schema/validation dependencies. Deno resolves these natively into its own
  cache; they do not reintroduce `node_modules`, a lockfile-plus-install step, or npm as a build
  tool. Prefer JSR or `esm.sh` first, and reach for `npm:` only when neither carries the package.
- The web bundle itself is built with the **esbuild** and **tailwindcss** standalone binaries
  (fetched directly as platform binaries in `Dockerfile` and CI). Cloudflare deployment is the
  one tooling exception: CI invokes a pinned Wrangler release through `npx`, without adding npm
  packages to the application.

If a command in an old doc, issue or PR mentions `npm install` or `npm run <script>`, it is stale -
the equivalent is `deno task <name>` (see the table below).

## Setup

```sh
cp .env.example .env
# fill in ARAG_ZONE, ARAG_ACCOUNT, ARAG_NUA_KEY (and set ADMIN_PASSCODE if you want the
# admin surface enabled locally)

deno task provision   # create + seed the showcase knowledge boxes (idempotent);
                      # writes ARAG_KB_* bindings back into .env

deno task dev         # builds the web bundle, then serves the API + SPA on :8787
```

Without `ADMIN_PASSCODE` set, the server still runs, but every `/api/admin/*` route returns
`503 { error: "admin_disabled" }` - there is no default passcode and no way to reach the admin
surface (provisioning, corpus upload, labels, graph config, agents, branding) until you set one.

Open `http://localhost:8787`.

## Deno tasks

All commands are `deno task <name>`, defined in `deno.json`.

| Task        | What it does                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `dev`       | Builds the web bundle, then runs the API server with `--watch` on port 8787 (serves the SPA too). |
| `build:web` | Builds the full web bundle: copies `index.html`, then runs `build:css` and `build:js`.          |
| `build:worker` | Bundles the Cloudflare Worker entry point for deployment.                                  |
| `build:cloudflare` | Builds the SPA and Worker as one production package.                                  |
| `build:css` | Compiles `apps/web/src/styles.css` with the Tailwind CLI into `apps/web/dist/styles.css`.       |
| `build:js`  | Bundles `apps/web/src/main.tsx` with esbuild into `apps/web/dist/app.js` (React and friends stay external, resolved by the browser's import map). |
| `check`     | The full gate: `deno check` on the server/scripts/web entry points, `deno lint`, `deno fmt --check`, then `test`. This is what CI runs. |
| `test`      | Runs the Deno test suite (`deno test`) across `packages/` and `apps/`.                          |
| `enrich`    | Runs `apps/api/scripts/enrich-labels.ts` - a second-dimension labelling enrichment pass, idempotent. |
| `provision` | Runs `apps/api/scripts/provision.ts` - creates/binds each tenant's knowledge box, pushes the topic labelset, uploads the seed corpus from `content/seed/`, and appends the resulting bindings to `.env`. Idempotent - safe to re-run. |

## Testing

`deno task test` runs the whole suite (Deno's built-in test runner, with `@std/testing/bdd` and
`@std/expect`). Test doubles live only inside test files - there is no mock provider or mock mode in
product code (see "nothing faked, ever" above). `deno task check` runs tests as part of the full
gate; run that before considering anything done.

## Deployment

Deployment order is **local -> pull request -> Cloudflare, always**. Nobody runs a production
deploy from a developer machine. The flow is:

1. Commit locally and push.
2. `.github/workflows/deploy.yml` runs the gate job (`deno task build:cloudflare` then `deno task check` -
   typecheck, lint, format, tests) on GitHub's runners.
3. Only if the gate passes does the deploy job publish the preserved package as the Cloudflare
   Worker named `corpuskit`.

A push that fails the gate never reaches production. Cloudflare configuration is in
`wrangler.jsonc`; the production and Entra runbook is in `docs/CLOUDFLARE.md`.

State (tenant configs, knowledge-box bindings, sessions, investigations, watches, sources,
insights, suggestions and branding assets) is held in a SQLite-backed Durable Object.

## Architecture

Where the line sits between the portal and the platform:

| CorpusKit owns | The knowledge box owns |
|---|---|
| Every screen, and the design system behind them | The corpus, its extraction and its index |
| Tenants, branding, terminology and taxonomy display | Retrieval, reranking and grounded generation |
| Investigations, evidence, sessions and saved searches | The knowledge graph and the entity extraction behind it |
| The provisioning engine and the management surfaces | Labels, classifiers and the generation agents |
| One typed interface to retrieval and generation | Answer evaluation and the confidence scores |

Ask, search, suggest, graph and the management calls sit behind one typed `RetrievalProvider`
interface, in the portal's own vocabulary rather than any vendor's response shapes. No component
knows which model answered it.

## Project layout

```
corpuskit/
  apps/
    web/                 React + TypeScript SPA (esbuild + Tailwind, esm.sh import map)
      src/
        pages/            route-level views, including admin/ (provisioning, corpus, labels, ...)
        components/        shared UI
        api/               typed client for the API server
      index.html
    api/                  Deno + Hono API server (port 8787), serves the built SPA too
      src/
        server.ts          entry point
        app.ts              route definitions
        tenants.ts, bindings.ts, stores.ts, kg.ts, persist.ts   JSON-file-backed stores
        arag-account.ts, rate-limit.ts, scheduler.ts, ...
      scripts/
        provision.ts        create/seed tenant knowledge boxes (deno task provision)
        enrich-labels.ts     labelling enrichment pass (deno task enrich)
  packages/
    core/                 shared Zod schemas and types (Tenant, Answer, Citation, Entity, ...)
    retrieval/             RetrievalProvider interface + the Progress Agentic RAG implementation
  content/
    seed/                 seed documents for the showcase tenants - see content/seed/README.md
  docs/                   VISION, ARCHITECTURE, ARAG-DEV, CLOUDFLARE, TEST-FRAMEWORK
  deno.json               import map, compiler options, fmt/lint config, tasks
  wrangler.jsonc          Cloudflare Worker, Assets, Durable Object and custom-domain config
  Dockerfile, fly.toml    legacy container deployment retained for rollback during migration
  .github/workflows/      CI gate + deploy pipeline
```

## Documentation

| Doc | What it gives you |
|---|---|
| `docs/VISION.md` | Why this exists, the product decisions, and the standing principles. |
| `docs/ARCHITECTURE.md` | The system design and the layering. |
| `docs/ARAG-DEV.md` | The platform reference. Call shapes, the credential model, known platform bugs. Read before touching retrieval or provisioning. |
| `docs/CLOUDFLARE.md` | The production and Entra runbook. |
| `docs/TEST-FRAMEWORK.md` | The testing bar and how to run each suite. |
| `docs/PERSONAS.md` | The people the portal is built for. |
| `CONTRIBUTING.md` | How to work on this. |
| `SECURITY.md` | How to report a vulnerability. |

## Contributing

Contributions are welcome. Read `CONTRIBUTING.md` first - in particular the gate (`deno task
check`), the no-npm rule, and the visual verification bar for UI changes.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

A knowledge portal is a fifteen year asset, and nobody should have to bet that on a supplier
staying interested. The provisioning engine, the retrieval layer, the design system and every
screen are yours to fork, run and change.

## Who maintains this

CorpusKit is built and maintained by [Noice](https://noice.net.au), a Melbourne digital agency and
Progress partner. We sell standing it up on your corpus, loading the awkward material - the scanned
final reports from the eighties, tables and plates and all - and tuning it until the answers can be
acted on.

CorpusKit is an independent open source project. It is not a Progress Software product.
