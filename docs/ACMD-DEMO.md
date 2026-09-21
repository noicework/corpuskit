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
