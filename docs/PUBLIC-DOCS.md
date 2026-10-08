# Public documentation pages

`deno task build:docs` renders the shared `DOC_PAGES` content, grouped by
`docPagesByCategory()`, into `apps/web/dist/docs/index.html` and one HTML file
per page. It runs inside `deno task build:web` before the build stamp. The
current collection is 17 guides, 3 developer guides, the Release notes page and
the overview, or 22 HTML pages. Generated output is not tracked.

## Developer guides

`DEVELOPER_DOCS` in `packages/core/src/docs.ts` names the repository's own
Markdown files under `docs/` that the public documentation publishes: Hosting
(`HOSTING.md`), Architecture (`ARCHITECTURE.md`) and Developing on Progress
Agentic RAG (`ARAG-DEV.md`), under a Developers group between the Help
categories and Project. They are public only, not in-app Help. The build drops
the file's H1 for the page's own title, turns the text before the first `## `
heading into an Overview section, and starts a section at each `## ` heading.
A section listed in `unpublished` stays in the repository only; a test fails
if that heading disappears from the file. A link to another repository file
points at its published page when it has one, and at the file on GitHub
otherwise.

The renderer supports what these files use: pipe tables (a scrolling region on
narrow screens; `\|` keeps a pipe inside a cell), numbered lists that resume
after a code block (`<ol start>`), item text and code spans that wrap onto
indented lines, a code fence indented under a list item, and one level of
nesting three spaces under a numbered item. Inline syntax is checked on each
block's joined text as it renders. Anything else still fails the build.

## Release notes

`/docs/release-notes` renders the dated releases in `CHANGELOG.md`, newest
first, under a Project group at the end of the navigation. It is built for the
public docs only and is not in-app Help content, so it has its own id,
`RELEASE_NOTES_PAGE_ID`, which the Worker's docs routing accepts beside the Help
pages. Unreleased work stays in the repository. Because the page goes through
the same strict renderer, `CHANGELOG.md` must stay within its Markdown subset:
one line per bullet, nested bullets two spaces in, identifiers, paths and
anything with `_`, `*`, `<`, `>` or `|` in backticks, and absolute link URLs. A
test renders the whole changelog, so anything else fails the gate.

Checked on 27 September 2026 in headless Chromium at 1920px and a true 390px
viewport, 16px and 22px root fonts, light and dark preferences: no horizontal
overflow on any combination, the Project group on the overview, and the
current-page link in the navigation.

The build reuses the About document's marketing shell: metadata pattern, fonts,
palette, header, footer and base styles. Only the main content, page metadata
and current navigation item are replaced. Documentation-specific layout lives in
`apps/web/public/docs.css`. The pure `parseDocBlocks` parser used by in-app Help
also parses these pages. A strict validation layer rejects unsupported syntax,
while the HTML renderer escapes content and permits only safe link destinations.
Tests walk every authored section.

## Routing

On the platform apex, GET and HEAD requests for `/docs` and `/docs/` select the
overview. `/docs/<page-id>`, `/docs/<page-id>/`, `/docs/<page-id>.html` and
`/docs/<page-id>.html/` select the matching guide. Unknown paths under `/docs/`
return the **overview with HTTP 200**. This includes nested unknown paths. The
canonical metadata on the overview points to `/docs`.

The Worker requests `/docs/` or the extensionless guide path from Assets so its
HTML canonicalisation does not send a pretty-URL redirect to the visitor.
Responses pass through the homepage's existing cache and security header
handling. Public docs asset aliases are unavailable on tenant and non-apex
hosts. The existing www-to-apex redirect remains intact. In-app tenant routes
and mutation requests are not rewritten by the marketing selector.

## Container contract

About and documentation match every homepage `--page` value:

- Default: `min(92vw, 1480px)`.
- Up to 980px: `min(90vw, 820px)`.
- Up to 680px: `calc(100vw - 48px)`, giving 24px side gutters.

Measured in Chromium: 1480px wide at a 1920px viewport (220px side gutters),
820px at 950px (65px gutters), and 342px at 390px (24px gutters). The old About
override that expanded to 2200px above 1900px was removed, and its tablet rule
now includes the 820px cap.

## Local visual verification, 13 September 2026

Built with `deno task build:web` and served `apps/web/dist` on port 8795. Port
8794 was already occupied and its process was left alone. No production
deployment was performed.

Chromium screenshots and DOM measurements covered the overview, Getting started
and Tools (`/docs/generate`) in all 24 combinations of 1920px and 390px layout
viewports, 16px and 22px root fonts, and light and dark system colour
preferences. The 390px checks used a same-origin iframe, magnified with
`transform: scale(2.3)`; measurements came from its `contentDocument` and
`defaultView`, not the outer window. The marketing palette is fixed, so both
system preferences intentionally retain the same paper-and-blue appearance.

Inspected heading blocks, current navigation, category cards, section lists,
inline code, connector code examples, sticky desktop header/sidebar, expanded
mobile navigation, previous/next links and the footer. Mobile navigation also
opened using the keyboard, and an in-page link scrolled to its heading. Every
docs page was additionally measured at 390px with a 22px root font. About was
inspected at desktop and mobile sizes and measured against the homepage at
desktop, tablet and mobile widths. No horizontal document overflow remained. The
visual pass found and fixed an awkward final-letter wrap in the mobile
Documentation heading at the larger root font.

Local screenshots and measurements are in `/tmp/corpuskit-docs-visual/`. These
are review evidence, not build inputs. No CSP changes were needed for the static
server.

## Validation

The release gate includes the requested API/web/Worker/build-script type check,
lint, format check, complete unit/integration suite, Cloudflare build, Wrangler
4.127.1 deploy dry run and browser E2E suite. Do not rebuild while E2E is
running: its fresh-asset checks assert that the build stamp remains unchanged
throughout the run.

Wrangler's normal dry run reports the directory count rather than individual
filenames. Repeating the same dry run with `WRANGLER_LOG=debug` lists all 18
`/docs/*.html` files and `/docs.css` in its asset scan, with no ignored docs
entries. It exits without uploading.

All requested gates passed before the final commit. The unit/integration suite
passed 981 tests and 1802 steps; the browser E2E suite passed 6 tests and 33
steps. The initial E2E attempt detected a concurrent rebuild changing its build
stamp; the complete rerun passed with the build output held unchanged.
