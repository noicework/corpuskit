# Answer records

Every completed portal Ask answer (including search summaries and per-document chat) saves a
server-created evidence record before its final SSE `done` event. Early corpus refusals also
have records. Estate ask saves a separate source answer record in each participating portal.
A failed save publishes an error instead of successful completion. Existing saved answers are
not backfilled. The Help assistant and other structured generation surfaces are not automatically
instrumented; their routes can use the server-only recorder below.

Agent ask (`POST /api/t/:slug/ask-agent` and `POST /api/ask-agent`) also records every run,
using `recordAgentAnswer` in `apps/api/src/agent-answer-record-stream.ts`. One record belongs
to the host portal, including when other hosted portals or federation peers supply passages.
An `answer-record` event with the saved id precedes the terminal `done` or `error` event.
The agent ask page can consume this event to link to the curator record; its UI is separate.

The optional `agent` field distinguishes `agent` and `orchestrated` modes and retains the
sources announced by `agent-start`, their kind and transport, hosted portal or peer id,
non-secret store identifiers and configured peer endpoints. It includes every step's final
status, duration and reported reason, the question put to each source, failures with their
reason, and citation decisions before and after composition's citation check. Passages and
citations carry source and chunk ids, a resource id when supplied, titles, excerpts and URLs
when supplied. Every URL has credentials, query strings and fragments removed.

The composer reports kept and dropped original citation markers per sentence, including their
source and chunk when known, the zero-based `sentenceIndex`, and the final marker after
renumbering. A marker kept on one sentence and dropped on another retains both decisions.
The curator view shows these
decisions and a Source/Kind/Transport table. CSV adds `mode`, `sources`, `steps`,
`sourceQuestions`, `citationDecisions`, `failedSources` and `truncatedFields` columns, with
structured values encoded as JSON cells. JSON preserves the complete record structure.
An agent provider that emits only final citations cannot report its rejected candidates:
its citation check remains `not_reported`. Missing source topology and model identifiers
are explicitly unknown, rather than inferred. Configuration identifiers name the local
agent/composition and citation-binding paths; `portal-search` identifies composed retrieval.
The model is the answer model reported by the provider, not an inferred vendor default.
Reasoning text and previous conversation turns are not retained.

A record includes its random answer id, UTC creation time, portal, question, retrieval queries,
retrieved passages, final cited passages, verification outcomes, reported quality/token/timing
metrics, model/configuration identifiers and source calls with status and duration. Resource
scores are explicitly labelled as resource scores, rather than claimed to be paragraph scores.
Unknown pages, models, quality and token counts are null. Verification that the provider did not
report is labelled `not_reported`. Prompt text is represented by SHA-256 hashes. The deployment
build id is included when the runtime supplies one.

The question and retrieval text are personal data. Records hold no actor, session id, client IP,
headers, cookies, learning ids or request context. Schema projection removes unknown fields;
credential patterns, labelled session ids, IP literals and URL credentials/query strings are
redacted from every stored string. This does not anonymise personal information in a research
question. Never pass a request body, headers or identity to the recorder. The operational audit
log records the mutation, scope, opaque target and outcome, without evidence text or questions.

## Access and review

The `Answer record` link appears beside completed answers only when `content.write` is allowed
on that portal: curator, portal administrator, platform administrator or owner. The record page
is `/t/:slug/answer-records/:id`. Records are scoped to their portal at every lookup. Keys are
refused on these administration routes. Reads and exports are privileged and audited; they are
available in read-only mode and subject to suspension in the usual way. Changing retention needs
`behaviour.write` and is blocked in read-only mode.

| Method | Path under `/api/admin/t/:slug/answer-records` | Permission |
| --- | --- | --- |
| GET | `/records/:id` | `content.write` |
| GET | `/records/:id/export?format=json` or `csv` | `content.write` |
| GET | `/export?from=<UTC ISO time>&to=<UTC ISO time>&format=json` or `csv` | `content.write` |
| GET | `/retention` | `content.write` |
| PUT | `/retention`, JSON `{ "days": 90 }` | `behaviour.write` |

Export range endpoints include both timestamps and reject invalid/duplicate query parameters.
JSON returns `{ records, nextCursor }`. CSV includes JSON cells for structured fields and prevents
spreadsheet formula execution. Export pages are bounded below the privileged response audit cap.
Records are fetched individually in answer-id order, so paging does not load the full history
into Worker memory. Continue with `cursor=<nextCursor>` using the same range and format. CSV exposes the cursor in
`X-Answer-Records-Next`; retain only the first page's header. The page downloads all pages for the
selection and publishes a file only after every page succeeds. This is an immutable-record
traversal, not a historical database snapshot; a concurrent retention or erasure can invalidate a
cursor and fail the export. Date controls in the page select whole UTC days.

## Recorder API for agent and composed routes

`apps/api/src/answer-recorder.ts` exports `AnswerRecorder`. Its dependency is
`AnswerRecordStoreApi`, exposed as `BuildAppOptions.answerRecords` and injected by both runtime
adapters. A route module should receive the already-created `answerRecords` store from `buildApp`,
so it shares the runtime's audited adapter. Do not create a second file store inside a Worker.
The agent ask branch can accept that store as a route service without changing the recorder.

```ts
const recorder = new AnswerRecorder({
  store: answerRecords,
  portal: config.slug, // resolved and authorised by the route
  question,
  surface: 'agent', // or 'composed'
  modelId, // null/undefined if the actual configured identifier is unknown
  buildId,
})
const retrieval = recorder.provider(provider) // same RetrievalProvider; adds no retrieval calls
for await (const event of retrieval.ask(config, question, options)) {
  recorder.observe(event) // call AFTER any route verification/rebinding, for final events only
  // Send interim events, but hold the final done event until finish succeeds.
}
const answerId = recorder.finish() // required persistence; throws on failure
// Emit { type: 'answer-record', answerId }, then the held done event.
```

The wrapper captures each `search` query/results and each `ask` query, options and raw events,
including attempts later rejected by verification. Verified `sourceContext` supplied for generation
is also retained, with unknown pages and scores represented explicitly. `observe` takes the final `AskEvent` stream
and retains citations whose markers survive the final text, plus audit removal counts and
unsupported figures. Pass final quality/usage as provider events when a composed route computes
those metrics itself. `finish('error')` or `finish('cancelled')` can record an unfinished run while
its request mutation scope is still open; cancellation after scope closure cannot write data.
`finish` is idempotent for the same recorder; stored answer ids cannot be overwritten.

For external peers, explicitly call these methods with server-verified, portal-scoped data:

```ts
recorder.query(retrievalQuery)
recorder.retrieved(resources) // domain ScoredResource values
recorder.providerEvent(providerEvent) // raw citations/quality/usage before verification
recorder.observe(finalEvent) // final citations/audit/done after verification
recorder.call({
  source: 'soil-peer', storeId: 'soil-store', operation: 'mcp.ask',
  status: 'ok', // or 'error' / 'cancelled'; never put a remote error message here
  durationMs,
})
```

Use a `try/finally` around each peer call so failures and cancellations are recorded as well as
success. The agent/composition module owns authorisation and lifecycle checks for every peer;
the recorder grants no access and makes no remote calls of its own. Portal Ask uses the
`recordSSE` adapter in `answer-record-stream.ts`; estate fan-out uses `recordComposedSource`.
These adapters report the configured model/store identifiers through the optional provider
methods, without exposing binding credentials.

## Bounds, retention and erasure

Records are bounded to 384 KiB, 160 retrieved/cited passages, 2,000 characters per passage,
100 retrieval queries, 200 source calls and 8,000 question characters. The recorder marks
`truncated: true` when a bound shortens or omits evidence. A large generic record passed directly
to the store is rejected. Retained excerpts are evidence of the retrieval used, not a complete
copy of the source documents. Verification includes removal counts and figures reported by the
trust layer; it does not reconstruct the text of sentences the trust layer did not emit.

Agent evidence additionally bounds sources, steps, source questions, source failures and citation
decisions to 200 items each, with the same text bounds. `truncatedFields` names the shortened or
omitted fields (`text` denotes shortened field values). To meet the total byte limit, the
existing order removes retrieved passages, cited passages, retrieval queries and calls first;
then agent citation decisions, source questions, steps, failures and sources. The view and
both export formats disclose truncation. The same `answerRecords` retention, audited storage
adapters and erasure inventory apply without another erased record kind or setting.

Retention is per portal: **90 days by default**, configurable from **1 to 365 whole days**.
Expired records disappear from reads and exports at the cutoff. Reducing retention immediately
removes older records. Daily maintenance physically purges expired records, including those of
inactive/retired portals; one failure does not stop the other maintenance jobs. Local files use
`DATA_DIR/answer-records/<slug>/<answer-id>.json` and `retention.json`. The managed runtime uses
individual `state` rows named `answer-records:<slug>:record:<answer-id>` and
`answer-records:<slug>:retention`. Normal record and retention mutations share the required
local mutation audit/rollback boundary on both runtimes.

**Hosting contract change:** portal erasure adds the `answerRecords` erased record kind and
`erasedAnswerRecords` audit count. The hosting control plane's strict erased-kind contract must
add `answerRecords` in the same release. Erasure removes every record and its retention setting,
including corrupt stored records. Each file/row counts once. The usual backup/recovery limitations
in [HOSTING.md](HOSTING.md#what-erasure-cannot-reach) still apply.
