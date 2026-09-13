# Public documentation pages

`deno task build:docs` renders the shared `DOC_PAGES` content, grouped by
`docPagesByCategory()`, into `apps/web/dist/docs/index.html` and one HTML file
per page. It runs inside `deno task build:web` before the build stamp. The
current collection is 17 guides plus the overview, or 18 HTML pages. Generated
output is not tracked.

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
