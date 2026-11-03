# Vendored esm.sh builds

`cookie@1.1.1/cookie.mjs` is esm.sh's `https://esm.sh/cookie@1.1.1/denonext/cookie.mjs`,
copied on 3 Nov 2026 (sha256 `fd8c42c831272a2886b6eafccb78032f5930f22c9ad2867342af4f4e918cd5b1`)
with the package's MIT licence beside it. `deno.json` maps that URL here.

esm.sh rebuilt the module at the same URL in early November 2026, and its edges served the old
and new builds side by side for a while, so no one lock hash could pass every CI job. Serving
the copy from the repository keeps the bytes fixed. To drop it, remove the `deno.json` mapping
and this directory, and let `deno.lock` record the URL again.
