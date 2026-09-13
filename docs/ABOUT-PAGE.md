# About page

`apps/web/public/about.html` is the public feature overview at `https://corpuskit.org/about`.
It uses the standalone homepage's paper, ink and blue palette, fonts, navigation, cards and footer.
It does not load the tenant SPA or its appearance settings. Neither marketing document changes
palette in response to the system colour preference.

## Content sources

The page contains 33 feature cards across nine categories. Product and administrative capabilities
are described separately in the copy. No customer or research organisation is named. The demo
links use `https://demo.corpuskit.org`.

| Category | Cards | Sources |
| --- | ---: | --- |
| Discovery and search | 3 | `README.md`, `docs/INTENT-ROUTING.md`, `packages/core/src/docs.ts` |
| Answers you can check | 4 | `docs/TRUST-LAYER.md`, `docs/LLM-FOOTNOTES.md`, `README.md` |
| Knowledge graph and investigations | 3 | `README.md`, `content/demo/labels-and-categories.md`, `packages/core/src/docs.ts` |
| Library and reading | 3 | `README.md`, `packages/core/src/docs.ts` |
| Generate and assess | 2 | `packages/core/src/docs.ts`, `apps/web/src/pages/GeneratePage.tsx`, `apps/web/src/pages/AssessmentPage.tsx` |
| Content, taxonomy and enrichment | 5 | `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/EXTRACTION-LAB.md`, `apps/web/src/pages/admin/ExtractionPanel.tsx`, `content/demo/labels-and-categories.md` |
| Access and security | 6 | `docs/RBAC.md`, `apps/api/src/permissions.ts` |
| Integration and tools | 3 | `packages/core/src/docs.ts`, `docs/RBAC.md`, `apps/api/src/cloudflare-domains.ts` |
| Platform and deployment | 4 | `README.md`, `docs/DEMO.md`, `docs/ARCHITECTURE.md`, `apps/cloudflare/src/worker.ts`, `LICENSE` |

The Extraction Lab card describes the implemented profiling, sandbox comparison and routing-rule
controls. It does not promise every item in the design document's build plan. No embed capability
is claimed. The Australian region wording applies to the knowledge box and distinguishes the
separate application and model configuration.

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

Verified the built page in Chrome on a local server at port 8891. Port 8791 was already occupied.

- Wide desktop: 1920 by 1080 layout viewport, default and 22px root font.
- Mobile: a measured 390px iframe layout viewport, default and 22px root font. The iframe was
  also magnified with `transform: scale(2.3)` to inspect the text without changing its viewport.
- Light and dark system preferences: the authored marketing palette stays consistent.
- Inspected the introduction, navigation, feature cards, category links, sticky desktop header,
  closing calls to action and footer. Checked the surrounding homepage navigation too.
- No horizontal document overflow or card content overflow at either mobile text size. All
  category fragment targets resolve. Keyboard focus has a visible outline.
- Checked Home/About navigation in both directions and the trailing-slash About URL.
- Fixed empty grey grid cells found during the first wide-screen pass by using individually
  bordered cards and an adaptive wide-screen column count.

The temporary local framing relaxation was reverted to `frame-ancestors 'none'`. The preview
helper was removed, browser overrides were reset, and only this task's local server was stopped.

## Final gates

All passed on 13 September 2026 before the final commit:

- `deno check apps/api/src/server.ts apps/web/src/main.tsx apps/cloudflare/src/worker.ts`
- `deno lint apps packages e2e`
- `deno fmt --check apps packages e2e deno.json`
- `deno task test`: 971 passed, 1,737 steps, no failures.
- `deno task build:web` and `deno task build:cloudflare`
- `npx -y wrangler@4.127.1 deploy --config wrangler.jsonc --dry-run`
- `deno task test:e2e`: 6 passed, 33 steps, no failures.

`deno fmt` was run on the changed files. The repository formatter intentionally excludes public
HTML and `docs/`; those files retain the existing marketing and documentation conventions.
No push, pull request or deployment was performed.
