# ACMD demonstration portal

`https://acmd.corpuskit.org` is tenant `acmd` on the isolated `corpuskit-demo`
Worker. `wrangler.demo.jsonc` owns both demo custom domains; keep both entries
when deploying. This portal does not add a tenant to the production Worker.

The idempotent initializer in `apps/cloudflare/src/acmd-demo.ts` seeds the
appearance and copies the existing `demo` knowledge-box binding server-side.
It does not create or modify an ARAG knowledge box. It preserves an existing
ACMD binding and appearance, including a dedicated knowledge box connected
later through Manage. No credentials are stored in the source tree.

The initial collection is the CorpusKit documentation collection (32 resources
when checked on 21 September 2026). The UI labels the demo and names this
temporary source on every portal page. Suggestions and topic IDs match that
collection; they do not imply that ACMD research has been ingested.

## Brand source

Matched against the live https://acmd.org.au/ site on 21 September 2026:

- Montserrat variable font, normal Latin subset, weights 100–900.
- Navy `#212d57`, pale blue `#83d0f5`, white, and light grey `#f5f5f5`.
- The original logo and laboratory photograph, served locally to keep the demo
  independent of third-party asset availability.
- Rounded blue actions and a split photographic hero, with the site's
  “Engineering the future of healthcare” tagline.

Original assets (under `apps/web/public/brands/acmd`):

- Logo: https://acmd.org.au/images/logo-v2-tm.png
- Font: https://acmd.org.au/_next/static/media/904be59b21bd51cb-s.p.woff2
- Photograph: https://svhaacmdwe-882de482ba6ce492f8f2-endpoint.azureedge.net/blobsvhaacmdweb801fc7d1c/wp-content/uploads/2023/10/8b92723efda47aecc99e1e833b7565e1-1600x2399.jpeg

These assets retain their original ownership and are included for the requested
ACMD demonstration. Delivery follows the existing pull-request gate and GitHub
Actions deployment, including the real CorpusKit demo functional check.

## Source-matched chrome and refinement

The ACMD palette is marked `listed: false` in `packages/core/src/palettes.ts`:
it was made for this one portal, so no other portal's Appearance picker offers
it and `PATCH /api/admin/tenants/:slug` refuses to assign it to a portal that
is not already using it (`400 palette_not_available`). The ACMD portal still
sees and keeps it. The seed writes the portal directly, so it is unaffected.

The ACMD palette selects `AcmdChrome.tsx` for the real website navigation and
footer destinations. The portal navigation remains a separate compact strip,
and the source notice is included in measured header height so Ask and Graph
still fit the viewport. Other tenant headers and footers keep their existing UI.

The hero and section headings use the site's `#283583 → #188ecb → #212d57`
text gradient. The footer uses `#83d0f5 → #188ecb → #ffffff`; the image caption
uses its navy-to-blue panel treatment. Dark mode uses a legible pale variant.

Additional original assets:

- Footer logo: https://acmd.org.au/images/logo-v2.png
- Tile artwork: https://acmd.org.au/images/tiles-colour-combined.svg
- White tile artwork: https://acmd.org.au/images/tiles-white.svg

Newsletter signup links to the existing public `#signupForm` on ACMD's website;
the demo does not collect subscription data. The existing footer links, contact
button, LinkedIn destination and acknowledgement are retained. The footer is
shown on scrolling pages; Ask and Graph retain their full-height workspace.
