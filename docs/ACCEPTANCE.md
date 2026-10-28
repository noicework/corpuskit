# Acceptance test evidence

This is a coverage map for AT1 to AT19, checked against the `test/acceptance-suite` working tree
based on `70b07be` on 28 October 2026. A passing local double proves the application contract it
exercises. It does not prove a deployed portal, a retrieval service's indexing, model quality,
availability or production performance. No live retrieval, hosting or email service is used.

"In progress" below identifies a branch visible in local Git refs, with work outside this tree.
Its tests are not counted as passing here. Other assigned lanes are recorded without claiming
their branches or implementation were verified. The orchestrator should refresh this map after
merging those lanes.

| Test | Acceptance requirement | Evidence in this tree, or missing automation |
| --- | --- | --- |
| AT1 | One composed cross-portal answer, citing portal and document, with no portal chosen. | **Not yet automated.** A single composed answer with portal-qualified citations and default portal discovery needs an acceptance journey. In progress on visible branches `feat/agent-ask` and `feat/estate-mcp`. Existing per-portal answer tests do not prove this. |
| AT2 | Answer cites a hosted store and a federated endpoint with the same experience. | **Not yet automated.** Needs a local federated endpoint fixture together with a hosted collection, and assertions on both citations in one answer. In progress on visible branch `feat/estate-mcp`. |
| AT3 | A source goes offline, an answer is still served and a notice names the source. | **Not yet automated.** Needs partial-failure federation coverage, including the unavailable source's name and the remaining answer. In progress on visible branch `feat/estate-mcp`. |
| AT4 | An admin adds, updates and retires a document and triggers re-indexing without operator help. | [e2e/acceptance.test.ts](../e2e/acceptance.test.ts): **`AT4: portal admin adds, updates and re-indexes, then retires a document through Manage`**; **`AT4: viewer cannot manage, add, update, re-index or retire documents`**. The browser uses the real admin routes, verifies changed reader-visible content, a replacement indexing request, deletion, audit records and a refusal before provider dispatch. [apps/api/src/acceptance-content.test.ts](../apps/api/src/acceptance-content.test.ts): **`AT4: durable admin content lifecycle is portal-scoped, audited and denied to viewers`** and **`AT4: local admin content lifecycle is portal-scoped, audited and denied to viewers`** repeat the route contract with both storage adapters. The matching **`AT4: durable failed replacement and read-only lifecycle leave the original document intact`** and **`AT4: local failed replacement and read-only lifecycle leave the original document intact`** cover failure, lifecycle gating and draft preservation. See the update limits below. |
| AT5 | Scheduled refresh picks up a changed page and reports a broken link. | **Not yet automated.** Current `apps/api/src/sources.test.ts`, `syncSource > never re-ingests a page it has already taken from the source`, explicitly proves skipping known URLs, not detecting changes. Needs changed-page refresh and broken-link reporting through the scheduler. Assigned to the link-health lane; its branch is not visible in this snapshot. |
| AT6 | Each portal's evaluation set runs and separately reports retrieval, citation and quality results. | **Not yet automated.** Existing persona grading unit tests do not prove stored per-portal evaluation sets or an isolated runner. Assigned to the eval-runner lane; its branch is not visible in this snapshot. |
| AT7 | A chosen answer's record of stores and passages is available, with export on request. | **Not yet automated.** Current citation and answer-export tests do not prove a retained answer-specific evidence record naming every store and passage. Assigned to the evidence-record lane; its branch is not visible in this snapshot. |
| AT8 | An external agent with an issued key gets a cited result, and a revoked key is refused. | **Not yet automated in full.** Partial coverage: `apps/api/src/mcp.test.ts`, **`a portal-admin key uses data-plane tools but never key or portal management`**, and **`MCP rechecks key expiry, revocation and creator authority on every request without session augmentation`**, exercise issued keys and refusal. They do not assert a cited answer and revocation together as an external agent journey. In progress on visible branches `feat/agent-ask` and `feat/estate-mcp`. |
| AT9 | A non-participating collection leaves the federated view and the change is recorded. | **Not yet automated.** Needs an audited participation change followed by an answer proving exclusion. In progress on visible branch `feat/estate-mcp`. |
| AT10 | Planted documents in one portal never appear in another portal's views. | [e2e/acceptance.test.ts](../e2e/acceptance.test.ts): **`AT10: planted portal markers stay out of the other portal catalogue, search, topics and document views`**. Two DoubleProvider collections have different markers; both directions are checked, own markers must be present, and foreign document ids return 404. The search query echo is excluded from the content assertion. This proves route-to-portal scoping with a local double, not the retrieval service's live box isolation or federated participation rules. No eval-runner branch was visible when this coverage was added. |
| AT11 | Monthly per-portal report of queries, cost, topics, unanswered questions and evidence coverage. | **Not yet automated.** Current insights summaries are not proof of all monthly report fields or per-portal accounting. In progress on visible branch `feat/usage-export`. |
| AT12 | Export drill yields one portal's resources, metadata, configuration and evaluation sets. | **Not yet automated.** Existing configuration and answer exports do not constitute a complete portal export drill. Assigned to the portal-export lane; its branch is not visible in this snapshot. |
| AT13 | Independent WCAG 2.2 AA audit of the public interface, followed by fixes. | **Not yet automated.** An independent audit and its remediation evidence are required. Browser layout, keyboard and token tests, including **`AT4: update form reflows with tenant tokens, large text, keyboard focus and announced errors`** in `e2e/acceptance.test.ts`, are regression checks and do not replace that audit. |
| AT14 | Search and answer times measured on the public route, with percentiles. | **Not yet automated.** Needs repeated public-route measurements and a report with percentiles, sample counts, workload and environment. Local test durations and timeout assertions are not performance evidence. |
| AT15 | An unanswerable question returns insufficient evidence with nearest sources and no generated answer. | [e2e/acceptance.test.ts](../e2e/acceptance.test.ts): **`AT15: insufficient evidence returns nearest sources and a refusal without generating an answer`**. The real Ask SSE route returns `done.refused: true`, says "no answer has been generated", lists the nearest semantic sources as unused, emits no citations and never calls `provider.ask`. The delta text equals the final refusal. The existing main grounding gate is reused; no model is invoked. |
| AT16 | One portal's generation model changes, other portals remain unchanged and nothing is re-indexed. | [apps/api/src/acceptance-model.test.ts](../apps/api/src/acceptance-model.test.ts): **`AT16: durable portal model change is isolated, persists and requests no re-indexing`** and **`AT16: local portal model change is isolated, persists and requests no re-indexing`**. The real binding route changes portal A, reloads persisted bindings, and verifies the model applied by `KbClient` to each portal's next ask using a local transport. Portal B's entire binding and both collections remain unchanged. The route's only outbound operation is a stubbed counters read; no ingestion, processing or document writes occur. This is the existing operator-managed inference policy, not a new model selector in Manage. |
| AT17 | A PDF opens at its cited page. | **Not yet automated in full.** Inline citation tests establish links to resources, not the PDF viewer opening at a specified page. In progress on visible branch `feat/citation-page`. |
| AT18 | Possible duplicates are listed for human review without an automatic choice. | **Not yet automated.** Needs candidate listing, review controls and an assertion that no document is selected or removed automatically. Assigned to the duplicate-review lane; its branch is not visible in this snapshot. |
| AT19 | A report shows content overlap and similarity between collections. | **Not yet automated.** Needs a report over controlled overlapping and disjoint collections, with known expected comparisons. Assigned to the duplicate-review lane; its branch is not visible in this snapshot. |

## AT4 update and indexing limits

Manage > Content > Recent additions now offers **Update and re-index**. It posts replacement text
to the existing `POST /api/admin/t/:slug/reingest` route. The route creates a new text resource,
which requests provider processing and indexing, then deletes the original. Its existing
80-word extraction minimum applies. It keeps the title, source URL and draft status, and carries
the first topic and kind classification. It is not an in-place PDF or metadata editor. Saved
citations retain the old resource id. A short replacement is refused without a write, and a
failed create leaves the original intact. The route's existing multi-step upstream operation is
not transactional: a later failure can leave a replacement alongside the original. Normal portal
capacity limits still apply while the replacement is created.

This change adds a UI entry to an existing route. It adds no API route, permission, persistent
store or deployment setting. `content.write`, its route inventory entry, mandatory privileged
request audit, lifecycle guard and the existing erasure inventory continue to apply. Re-indexing
here means a verified request for processing via `createText`; completion by a live retrieval
service remains a deployment acceptance check. The double reports processing as completed
deterministically and cannot prove the service's indexing latency.

## Local reproduction

Run from the repository root. A built web bundle is required for the browser tests.

```sh
deno task check
deno task build:web
DS_PORT_BASE=9371 deno test --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys e2e/acceptance.test.ts
```

The two `apps/api/src/acceptance-*.test.ts` files run as part of `deno task check`. The e2e harness
serves the real Hono application and built Manage UI with isolated temporary storage. Only the
retrieval and management boundaries are test doubles. Model-policy tests intercept all outbound
traffic with local functions. UI regression coverage checks keyboard activation, labelled input,
announced errors and completion, focus movement, tenant input-radius tokens and 44px controls.
It measures actual layout widths of 1440px, 390px and 320px with a 22px root font, under both the
light house palette and dark Observatory palette. Local screenshots are written to
`.planning/logs/acceptance-suite/`; they are review artefacts, not independent audit evidence.
