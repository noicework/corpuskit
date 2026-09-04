# Architecture - CorpusKit

Status: **current, updated 2026-09-01 for Cloudflare production.** Companion to `VISION.md` (the
product decisions and standing principles).

## Shape of the system

```
research-portal/                      Deno workspace (no package manager, no node_modules)
  apps/
    web/                              React + TS SPA, built with esbuild + Tailwind standalone
    api/                              Deno + Hono + Zod (thin typed API server)
    cloudflare/                       Worker, Entra auth and Durable Object storage adapters
  packages/
    core/                             shared types & Zod schemas (Tenant, Answer,
                                      Citation, Entity, Relation, Assessment, ...)
    retrieval/                        RetrievalProvider interface + providers
      src/provider.ts                 the interface (server-side only)
      src/providers/arag/             Progress Agentic RAG implementation (the only one)
  content/seed/                       authored seed corpora, uploaded INTO the knowledge boxes
  docs/
```

One run target: `deno task dev` against live knowledge boxes (`ARAG_*` env in the repo-root
`.env`, gitignored). **There is no mock mode** - a standing product directive: nothing faked,
ever. Sample content exists only as real documents uploaded into real knowledge boxes by
`deno task provision`. Test doubles are permitted strictly inside test files.

## The three load-bearing ideas

### 1. Tenants are data, not code
A **tenant** is one organisation's portal: the marine and grains showcase tenants are rows, not
branches. The client is served a single `TenantConfig` (branding, terminology, topic taxonomy,
entity/relation types, suggested questions, feature flags) from `GET /api/t/:slug/config`, and the
entire UI - theme tokens, nav labels, hero copy, graph legend, topic rows - renders from it.
Nothing tenant-specific ever appears in a component.

Server-side, a tenant record also holds the knowledge-box binding: zone, KB id, service-account
token (minted at provision time, never sent to the client). The Deno development server uses the
file stores in `apps/api`; Cloudflare production injects equivalent synchronous adapters over a
SQLite-backed Durable Object. Credentials never reach the browser.
Routing: path-based (`/t/marine/...`, `/t/grains/...`), with a tenant picker at `/`. Subdomains can
come later at the reverse proxy without code changes.

### 2. Retrieval behind one interface
`packages/retrieval` defines the only doorway to AI and retrieval:

```ts
interface RetrievalProvider {
  ask(q, opts): AsyncIterable<AskEvent>        // streamed answer, citations, quality signals
  search(q, filters): Promise<SearchResults>   // resources + matched passages + scores
  suggest(context): Promise<Question[]>        // suggested / follow-on questions
  resource(id): Promise<Resource>              // metadata + file/preview URLs
  askResource(id, q, opts): AsyncIterable<AskEvent>   // per-document chat
  graph(filters): Promise<{entities, relations}>       // knowledge graph slices
  // management (admin/provisioning only):
  createKb, configureLabels, configureGraph, configureAgents, upsertResource, status
}
```

Everything is expressed in **portal domain types** (Answer, Citation, SourcePassage, Entity,
TrustSignal) - never vendor response shapes. `AragProvider` maps Nuclia's REST API (ask with
`citations:true`, `/resources`, labelsets, entity groups, task/agent config) into those types.
Adding a provider is a config change, exactly as CLAUDE.md requires - but there is exactly one
in the product, and it is live. `AskEvent` is a small
discriminated union (`delta`, `citation`, `sources`, `quality`, `stage`, `done`) - rich enough
to drive both the answer panel and the agentic "stages/live feed" view from one stream.

### 3. Provisioning is a product feature, not a script
The **provisioning engine** (in `apps/api`) turns a blank knowledge box + a *domain brief* into
a configured tenant, and it is demo-able in its own right (SSE progress the admin UI renders as
a live checklist):

1. **Create/bind KB** - create via account NUA key (`POST /account/{acct}/kbs`, AU zone
   `aws-ap-southeast-2-1`) or bind an existing blank KB; create a service account and mint the
   KB token (the recipe already proven in the GTM factory).
2. **Generate the domain profile** - an LLM call (behind the provider interface) expands the
   brief ("Southern Waters Research Institute: fisheries & aquaculture R&D for southern Australian
   waters...") into topic taxonomy, labelsets, graph entity types + relation types, suggested
   questions, terminology and theme hints.
3. **Push configuration** - labelsets, entity groups, graph-extraction agents/tasks, synonyms
   applied to the KB via the management API.
4. **Seed the corpus** - upload the sample documents, poll to PROCESSED, verify with a smoke
   `ask`.
5. **Save the tenant** - config + binding written to the JSON tenant/binding stores; portal is
   live at `/t/:slug`.

Every step is idempotent and re-runnable, which also gives the factory its 30-second reset.
The same machinery backs the ongoing **admin surfaces**: corpus upload, label management, graph
config, agents, suggested questions - "expose the things people need to manage, in the app".

## API surface (Deno + Hono + Zod, all typed end-to-end)

```
GET  /api/tenants                      tenant list (picker)
GET  /api/t/:slug/config               TenantConfig (public)
POST /api/t/:slug/ask                  SSE stream of AskEvent
GET  /api/t/:slug/search               search + passages + scores
GET  /api/t/:slug/suggest              suggested questions
GET  /api/t/:slug/resources[/:id]      library + document detail
POST /api/t/:slug/resources/:id/ask    per-document chat (SSE)
GET  /api/t/:slug/graph                entities + relations
CRUD /api/t/:slug/sessions             research sessions (JSON store)
POST /api/t/:slug/assessments          generate + grade knowledge checks
POST /api/admin/tenants                provision (SSE progress)  - admin-authed
CRUD /api/admin/t/:slug/*              corpus, labels, graph, agents, questions
```

Zod schemas shared between server validation and the client. Sessions/assessments live in the
JSON stores under `apps/api/src/stores.ts` so the portal, not the browser, owns them.

## Front end

- **React 18 + TypeScript**, loaded via an `esm.sh` import map (`apps/web/index.html`), bundled
  by the esbuild standalone binary (`deno task build:js`) - no Vite, no bundler-managed
  dependency graph. React Router (routes mirror the parity sections: explore, search, research,
  library, graph, agentic, assess, admin).
- **TanStack Query** for data; native `fetch` + a streamed-response reader for SSE.
- **Design system**: our own, tenant-themed via CSS custom properties emitted from
  `TenantConfig` (colour, type scale, radius, logo). Tailwind CSS v4 (standalone CLI, `deno task
  build:css`) plus a small in-house component set (`apps/web/src/components/ui.tsx`) - no Radix
  UI, no Framer Motion; the streaming/answer choreography is done with CSS transitions. Every
  view ships real empty, loading, error and offline states; 390 px and WCAG AA are acceptance
  criteria, not afterthoughts.
- **Graph**: `d3-force` used directly (not `react-force-graph`) to drive a hand-built SVG force
  layout (`apps/web/src/pages/GraphPage.tsx`) with drag, pan and zoom, driven by the tenant's
  entity/relation types for legend and filters.
- **PDF**: no pdf.js - a PDF resource is shown in a plain `<iframe>` pointed at the file URL
  (`ResourceDetailPage.tsx`'s `PdfBody`), with an "open in a new tab" fallback. A richer in-page
  viewer (e.g. pdf.js) is a roadmap item, not yet built.

## Quality loop
- Deno's built-in test runner (`deno test`, with `@std/testing/bdd` and `@std/expect`) for
  unit/integration tests, `deno check` for typechecking, `deno lint` and `deno fmt --check` for
  lint/format - one `deno task check` gate before anything is called done (see `deno.json`'s
  `tasks` key and `CONTRIBUTING.md`).
- Tests use in-file stub doubles only; no stub ships in product code. CI needs no ARAG
  credentials for the current test suite, which runs entirely against the JSON-file stores and
  in-file doubles.
- **Not yet built**: there is no component-testing library and no browser-driven smoke suite in
  this repo today. Playwright smoke journeys per tenant (ask, cite-click-through, library, graph)
  remain a valid target and stay on the roadmap, but nothing currently exercises the app in a
  real browser as part of the gate.

## Build order (small, reviewable increments)
1. **Scaffold** - workspace, CI loop (`deno task check`), design tokens, app shells.
2. **Tenant core + live provider** - config-driven theming, tenant picker, explore page,
   the two showcase knowledge boxes provisioned with seed corpora uploaded.
3. **Ask experience** - streamed cited answer + evidence panel against the live KBs.
4. **Provisioning engine** - CLI-first, then admin UI; stand up the showcase knowledge boxes with
   sample corpora.
5. **Library + document viewer + per-doc chat.**
6. **Knowledge graph** (provisioned config -> extraction -> explorer).
7. **Research sessions, agentic view, self-assessment.**
8. **Admin surfaces, then the world-class pass** - motion, a11y/perf audit, export/share,
   trust signals, mobile.

## Persistence rule
All production app-side state (tenants, bindings, sessions, investigations, watches, sources,
insights, suggestions, enrichments and branding) lives in the `PortalDurableObject` SQLite
database. The object serialises writes and SQLite output gates make each mutation durable before
the response completes. The file-backed stores remain the local Deno adapter and rollback path;
business routes depend on store interfaces rather than either persistence mechanism.

## Deployment pipeline
`local -> pull request -> Cloudflare`, in that order, always.

- Repo: `github.com/noicework/corpuskit`, production branch `main`.
- `.github/workflows/deploy.yml` runs the full gate, builds and dry-runs the Worker package, then
  deploys that preserved package as the `corpuskit` Worker only when the gate passes.
- Cloudflare auth in CI is a scoped API token stored as `CLOUDFLARE_API_TOKEN`; ARAG and Entra
  runtime secrets remain attached to the Worker.
- Deploying from a developer machine is not permitted: it bypasses the gate and
  leaves production ahead of the repo.
