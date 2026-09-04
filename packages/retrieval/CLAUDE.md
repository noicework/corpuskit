# Retrieval rules (packages/retrieval)

The ARAG/Progress Agentic RAG integration lives here, behind the `RetrievalProvider` interface. See
root `CLAUDE.md` and `docs/ARAG-DEV.md` (the hard-won platform reference - read it before changing
any call shape; it lists the KNOWN PLATFORM BUGS, e.g. the json-output DA generator 422s, and the
citations+answer_json_schema crash).

## Search-config isolation is CENTRAL, not per-request

Isolation and retrieval policy belong in the named, stored search configurations on the box
(`ensureSearchConfigs`), not in per-request filter parameters passed at runtime. This is a standing
product directive: "use search configurations all the time and don't pass search-config parameters
at runtime that could be centrally managed."

- `portal-search` / `portal-ask` are the research configs and must EXCLUDE the `documentation` label
  (user documentation is not part of research search/answers).
- A `portal-doc-search` / `portal-doc-ask` config includes ONLY the `documentation` label - the
  documentation section's AI search/answer uses these.
- Add label filters to the stored configs, and select the config by context, rather than sending
  ad-hoc label filters on each request.

## Exploit the platform

Use ARAG features (reranker, rag_strategies, graph, REMi, DA agents, classifiers, summaries) rather
than rebuilding them app-side. The reranker is pinned `predict` on search/ask and the stored
configs.

## Displayable resources / merchandising

`isDisplayableResource` hides failed/junk ingests (error status, raw-hash titles, bot-challenge
titles, system files like `.uploaded.log`) from user-facing lists but NOT from admin/curation views.
Resources should present via DA-generated merchandising fields (title, summary, key takeaways,
etc.), never raw filenames.

## Testing

Provider logic is unit-tested with fetch doubles in test files (doubles only inside tests - the
product never ships a mock provider). But provider changes that affect what users SEE must still be
visually verified in the browser once deployed (see apps/web/CLAUDE.md).
