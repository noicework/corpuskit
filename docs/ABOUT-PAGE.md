# About page

`apps/web/public/about.html` is the public feature overview at `https://corpuskit.org/about`.
It uses the standalone homepage's paper, ink and blue palette, fonts, navigation, cards and footer.
It does not load the tenant SPA or its appearance settings. Neither marketing document changes
palette in response to the system colour preference.

## Content sources

The page opens with an **At a glance** section and then lists 33 feature cards across nine
categories. Product and administrative capabilities are described separately in the copy. No
customer or research organisation is named. The demo links use `https://demo.corpuskit.org`.

### At a glance

Seven rows of short points, each row a heading beside a list: content it takes in, how it
answers, how it checks, what comes out, how it connects, how it looks, and what it runs on. Every
point is a verifiable fact from the code or the documentation, not a roadmap item:

| Row | Sources |
| --- | --- |
| Content it takes in | `packages/retrieval/src/providers/arag/index.ts` (`detectContentKind`, `isOfficeMime`), `apps/api/src/crawl.ts`, `apps/web/src/pages/admin/AddContent.tsx` (100 MB limit), `docs/EXTRACTION-LAB.md`, `packages/core/src/docs.ts` |
| How it answers | `README.md`, `packages/core/src/docs.ts` (How this works, Ask), `packages/core/src/index.ts` (search configuration schema) |
| How it checks | `packages/core/src/docs.ts` (How the answer is checked), `docs/TRUST-LAYER.md` |
| What comes out | `packages/core/src/docs.ts` (Generate, Assessment, Watch a search), `apps/api/src/audit-routes.ts` (CSV/JSON), `apps/api/src/app.ts` (enrichments export) |
| How it connects | `apps/api/src/mcp.ts` (four tools), `docs/RBAC.md` (six roles, 22 permissions, access modes), `apps/api/src/cloudflare-domains.ts` |
| How it looks | `packages/core/src/palettes.ts` (five palettes, Observatory dark, WCAG contract test), `packages/core/src/index.ts` (six font pairings, shape, text scale, density), `apps/web/src/pages/admin/AppearancePanel.tsx` (logo and font uploads) |
| What it runs on | `README.md`, `docs/ARCHITECTURE.md`, `apps/cloudflare/src/worker.ts`, `LICENSE` |

### Feature cards

Each card carries two to four detail points under its paragraph. The points name concrete
options (search modes, generate shapes, assessment sizes, export formats, access modes, key
rules), never marketing adjectives.

| Category | Cards | Sources |
| --- | ---: | --- |
| Discovery and search | 3 | `README.md`, `docs/INTENT-ROUTING.md`, `packages/core/src/docs.ts`, `packages/core/src/index.ts` |
| Answers you can check | 4 | `docs/TRUST-LAYER.md`, `docs/LLM-FOOTNOTES.md`, `README.md`, `packages/core/src/docs.ts` |
| Knowledge graph and investigations | 3 | `README.md`, `content/demo/labels-and-categories.md`, `packages/core/src/docs.ts` |
| Library and reading | 3 | `README.md`, `packages/core/src/docs.ts` |
| Generate and assess | 2 | `packages/core/src/docs.ts`, `apps/web/src/pages/GeneratePage.tsx`, `apps/web/src/pages/AssessmentPage.tsx` |
| Content, taxonomy and enrichment | 5 | `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/EXTRACTION-LAB.md`, `apps/web/src/pages/admin/ExtractionPanel.tsx`, `apps/web/src/pages/admin/AddContent.tsx`, `apps/api/src/scheduler.ts`, `content/demo/labels-and-categories.md` |
| Access and security | 6 | `docs/RBAC.md`, `apps/api/src/permissions.ts`, `apps/api/src/audit-routes.ts` |
| Integration and tools | 3 | `packages/core/src/docs.ts`, `apps/api/src/mcp.ts`, `docs/RBAC.md`, `apps/api/src/cloudflare-domains.ts` |
| Platform and deployment | 4 | `README.md`, `docs/DEMO.md`, `docs/ARCHITECTURE.md`, `apps/cloudflare/src/worker.ts`, `LICENSE` |

The Extraction Lab card describes the implemented profiling, sandbox comparison and routing-rule
controls. It does not promise every item in the design document's build plan. No embed capability
is claimed. The Australian region wording applies to the knowledge box and distinguishes the
separate application and model configuration. Office and OpenDocument support is stated because
the resource viewer recognises those types and shows the platform's PDF or image rendition of
them; no format the code does not handle is listed.

Lists use `role="list"` because both the card and glance lists set `list-style: none`, which
makes some screen readers drop list semantics. The bullet is a small square in the brand blue,
drawn with `::before`, so it reads the same in every browser.

## Routing boundary

The Worker selects the extensionless `/about` asset for `/about` and `/about/`, preserving query
strings and GET/HEAD methods. It uses the same `secureAssetResponse` function as the homepage.
Tenant and other non-apex hosts receive 404 for the About marketing URLs, including the raw
`/about.html` alias. The existing www redirect still canonicalises the hostname.

`/about` is not an API route. The existing `static-assets` boundary declaration covers it; its
written reason now includes public marketing documents. The HTTP declaration inventory is
unchanged. Local Deno preview handlers also use the infrastructure boundary.

Worker tests beside the homepage tests cover both slash forms, the raw asset alias, GET/HEAD,
query/header preservation, caching and security header parity, tenant isolation, www
canonicalisation, SPA paths and mutation passthrough.

## Visual verification

Verified on 14 September 2026 from a local static server on port 8893 serving the page file and a
copy with a 22px root font, driven through headless Chrome with a scripted viewport, after
`document.fonts.ready`. Measurements were taken in the page's own layout viewport, not a resized
window.

- Wide desktop: 1920 by 1080 layout viewport, default and 22px root font. The glance lists run
  three columns; feature cards run four columns for four-card sections at the default font and
  two columns at 22px.
- Mobile: a measured 390 by 844 layout viewport, default and 22px root font. Glance rows and
  lists stack to one column; every card is one column.
- Light and dark system preferences: the authored marketing palette stays the same, as the page
  does not follow the system colour preference.
- Measured 225 elements per run (cards, paragraphs, card points, glance rows, glance points,
  next steps, the category nav and the header shell): no element wider than its box, none
  outside the viewport, and no card point outside its card at any size or font.
- Inspected the At a glance section, the Answers you can check, Access and security and
  Platform and deployment sections, the category nav with its new first link, the sticky
  desktop header, and the page top on mobile. All fragment targets resolve.

The probe copies lived outside the repository. No security header was changed. Only this task's
local server and headless Chrome were stopped.

## Final gates

Run on 14 September 2026 in the task's own worktree before the final commit:

- `deno task check`: typecheck, lint and format passed. The test run reported three failures in
  `enforcement.test.ts` and `local-ingress.test.ts`, all a 503 from `/api/health` because the
  fresh worktree had no built web bundle (`web: false`); after `deno task build:web`, both files
  pass (139 tests) and no other test failed (1,032 passed). CI builds before it tests, so the gate
  is green there.
- `deno task build:web`.

The repository formatter intentionally excludes public HTML and `docs/`; those files retain the
existing marketing and documentation conventions. No push, pull request or deployment was
performed by the verification steps themselves.
