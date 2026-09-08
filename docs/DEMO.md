# CorpusKit documentation demo

`demo.corpuskit.org` runs the same tested application package in the separate
`corpuskit-demo` Worker. Its SQLite Durable Object, knowledge-box credentials and
admin passcode are independent of the production `corpuskit` Worker.

The `deploy-demo` job in `.github/workflows/deploy.yml` deploys
`wrangler.demo.jsonc` after the shared build and test gate passes. Runtime secrets
remain attached to that Worker; they are never committed or passed through CI.

Required secrets: `ADMIN_PASSCODE`, `ARAG_ZONE`, `ARAG_KB_DEMO`, and
`ARAG_KB_DEMO_TOKEN`. The portal slug is `demo`; its knowledge box is the CorpusKit
box in the Noice NFR account's Australia region.

The CorpusKit palette and Archivo / Source Sans 3 pairing reproduce the public
homepage's paper, ink, blue, heading weight and tracking through the existing
Appearance controls. They can also be selected for other portals.

The demo corpus uses public CorpusKit user guides and Progress documentation.
User-facing guides are collection content (`content-type: product-guide`), with
normal HTTPS source URLs. They are distinct from the reserved in-app Help copies
(`content-type: documentation`, `portal-doc:` origins), which remain isolated by
the stored search configurations.

OpenRouter credentials belong in ARAG's OpenAI-compatible configuration. The
`corpuskit-demo-flash` and `corpuskit-demo-pro` OpenRouter presets control model
and provider routing with fallbacks disabled. The Worker explicitly passes
`ARAG_DA_AGENT_MODEL` into its retrieval provider so demo augmentation uses the
same configured OpenAI-compatible model instead of the application's default
augmentation tier. Embeddings, reranking and extraction remain ARAG services.

The CorpusKit palette starts in light mode independently of saved or system
preferences, while retaining the viewer toggle for the current visit. The
homepage navigation links to the demo on desktop and mobile.

The decorative hero asset is `apps/web/public/images/corpuskit-knowledge-paper.webp`,
generated with the built-in image generator and encoded as WebP. Prompt: an
extremely light abstract editorial composition of text blobs, floating clusters
of tiny typographic lines and ghosted document paragraphs on warm paper #f2efe7;
pale warm grey marks, a whisper of blue-grey, most detail around the right and
bottom edges, clear space for heading and search, no readable titles or UI.
