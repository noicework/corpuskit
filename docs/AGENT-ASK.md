# Agent ask

Agent ask streams an answer one step at a time, from one of two writers:

- **agent**: a retrieval agent plans, searches each of its sources, reasons aloud, then writes a
  cited answer. A real session runs for one to two minutes.
- **orchestrated**: when the portal has no agent, the portal searches each collection itself,
  streams one answer from the passages they returned, and checks every citation against its
  passage before finalising the text.

Both produce the same events, and `agent-start.mode` says which wrote the answer, so a view can
say "composed by CorpusKit across 3 collections" and never present the portal's own composition
as an agent's. The stream is built to be watched: steps open and close, each source's passages
arrive as they are found, and generation deltas arrive while the host writes its answer.

It is a separate contract from Ask (`AskEventSchema`): nothing that reads the portal's own Ask
stream changes.

- Events: `AgentAskEventSchema` in `packages/core/src/agent-ask.ts`
- Normaliser (ARAG `AragAnswer` NDJSON to events): `packages/retrieval/src/providers/arag/agent-stream.ts`
- Composer (the orchestrated mode): `apps/api/src/agent-compose.ts`
- Routes: `POST /api/t/:slug/ask-agent` and `POST /api/ask-agent` in `apps/api/src/app.ts`
- Client: `streamAgentAsk()` and `streamAgentAskAcross()` in `apps/web/src/api/client.ts`
- Fixtures: `packages/retrieval/src/providers/arag/fixtures/agent-*.ndjson`

## Switching it on

Opt-in per portal with the `agentAsk` tenant setting (default off):

```
PATCH /api/admin/tenants/:slug   {"agentAsk": true}
```

While it is off, or when the retrieval provider can neither run an agent nor compose, the routes
answer `404 {"error":"not_found"}`. `AragProvider` has no agent yet (`AragProvider.agentAsk` is
a TODO that reports `not_configured`), so today every opted-in portal composes.

## Federation peers

A portal's composed answers can also search **federation peers**: partners' Progress Agentic RAG
knowledge boxes, reached with the partner's read-only service-account key. Peers are what lets a
single portal host, which serves only its own routes, compose one answer across its own
collection and its partners'. The host's model writes the answer, once.

| Kind | How it is searched | Shown as |
| --- | --- | --- |
| `arag-kb` | The box's retrieval, `POST https://<zone>.dp.progress.cloud/api/v1/kb/<kbId>/find`. Retrieval only, never a generative call | `kind: "peer"`, `transport: "kb"` |
| `arag-mcp` | The box's MCP server, `https://<zone>.dp.progress.cloud/api/v1/kb/<kbId>/mcp` over Streamable HTTP: `initialize`, `notifications/initialized`, then `tools/call search_documents {query}`. JSON or SSE answers, the session id echoed | `kind: "peer"`, `transport: "mcp"` |

A `corpuskit-mcp` kind (another CorpusKit portal's MCP `search_corpus`) is not built yet.

Set the peers on the host (behaviour settings, merged over what is there):

```
PATCH /api/admin/tenants/:slug
{"federation": {"peers": [
  {"id": "partner-a", "label": "Partner A research", "kind": "arag-kb",  "zone": "<zone>", "kbId": "<box id>"},
  {"id": "partner-b", "label": "Partner B research", "kind": "arag-mcp", "zone": "<zone>", "kbId": "<box id>", "linkOrigins": false}
]}}
```

Then store each peer's key (operator or `bindings.write`; the peer must already be configured):

```
PUT /api/admin/t/:slug/federation/peers/:peerId/key
{"token": "<the box's read-only service-account key>"}
-> {"ok": true}
```

- The key is sealed with `BINDING_KEY` in the binding store, beside the portal's own binding, and
  is never returned: not by this route, not in the portal's configuration, not to the browser.
  Readers' configuration shows each peer's `id`, `label` and `kind` only. Storing a key calls
  nothing. Putting a key again replaces it; erasing the portal removes its peers' keys.
- **Allowlist.** A peer key may only call `/find` (`arag-kb`) and `/mcp` (`arag-mcp`). The MCP
  session may only use `initialize`, `notifications/initialized` and `tools/call` for
  `search_documents`, `get_document` and `batch_get_documents`. Anything else is refused before it
  is sent. Never a configuration or settings route, never a write.
- **Address guard.** The address is built from `zone` (one DNS label) and `kbId` alone, as
  `https://<zone>.dp.progress.cloud/...`, so no setting can point a call at another host, a
  private address or plain http. Redirects are refused, not followed.
- Each peer gets the same 20 s limit as any source, and counts as one more ask against the host's
  rate limits. A peer that fails, times out or refuses its key (`reason: "unauthorised"`, also
  when no key is stored) is named in `sources-failed`; the answer comes from the rest.
- Every peer call is audited on the host as `federation.peer.call`, with the peer's id, kind,
  duration and, when it failed, why. Never the key.
- **Citations.** `linkOrigins` (default false): off, a partner citation shows its title, label and
  passage with no link, so a public portal does not name the partner's site. On, it links the
  passage's origin URL when the box has one (`arag-kb` only; the MCP results carry none).

## Participation

Every portal takes part in federated answers unless it opts out:

```
PATCH /api/admin/tenants/:slug   {"federation": {"participates": false}}
```

A portal that does not take part is left out of other portals' composed answers
(`POST /api/ask-agent`), of federated asks (`POST /api/ask-estate`) and of the estate MCP
endpoint's tools (`/api/estate/mcp`) before anything is asked
or counted, is checked again as each answer is assembled (a portal that leaves mid-answer
contributes nothing), and does not federate to its own peers. Its own one-portal agent ask is
unaffected. The change is audited as `tenant.behaviour.update` with `participates` and
`previousParticipates`; the event records who and when.

**One policy rule.** A resource labelled `federation/exclude` (labelset `federation`, label
`exclude`) never leaves its portal in a federated answer: it is dropped from another portal's
composed answer and from any peer's results. It still answers in its own portal. The rule
applies to composed answers; the federated ask's per-portal answers honour portal participation
only.

## The requests

One portal:

```
POST /api/t/:slug/ask-agent
{"query": "How is a warmer climate changing pest pressure?", "context": [{"author": "USER", "text": "..."}]}
```

Several portals, authorised and admitted exactly as the federated ask (`/api/ask-estate`) is:

```
POST /api/ask-agent
{"query": "...", "slugs": ["host-portal", "second-portal", "third-portal"], "context": [...]}
```

- `query` is 1 to 2000 characters; `context` (optional, up to 24 prior turns) is
  `{author: "USER" | "AGENT", text}`; `slugs` (optional, 1 to 12) names the portals.
- Without `slugs`, the cross-portal route asks every portal in the caller's directory, as the
  federated ask does; an anonymous caller has none and is refused. Selected portals that do not
  offer agent ask are left out; if none is left, the answer is 404.
- The first portal is the host: its agent answers if it has one, and otherwise its generation
  path composes the answer from every selected portal's passages and its own federation peers'.
  The one-portal route composes over the portal and its peers.
- Like the federated ask, the cross-portal route is not served on a portal's own hostname, which
  only reaches that portal's routes. On a portal host, use the one-portal route.
- The answer is a server-sent event stream, one JSON event per `data:` frame. The one-portal
  route counts as one ask, like `/ask`; the cross-portal one counts once per portal reached, like
  the federated ask. Closing the connection ends the upstream work at once.

## Which writer answers

The host's agent answers when it starts. If it throws before its first event (no agent
configured, or the session refused), the portal composes instead. Once an agent has started, its
own errors end the stream as they are; the portal does not compose after a half-told answer.

Composing (`mode: "orchestrated"`):

1. Every selected portal is searched at once, each with a time limit (20 s by default,
   `agentSourceTimeoutMs`). Each is a step, `source/<slug>`. Up to four passages a portal, its
   strongest matches, become its `agent-sources`.
2. A portal that errors or runs out of time ends its step `failed`, with a `reason`, and is named
   in one `sources-failed` event, sent after every lookup has settled and before the answer.
   The answer comes from the rest. If every portal fails, the stream ends with an `error`.
3. The host composes one answer (step `compose`, 90 s limit, `agentComposeTimeoutMs`) from the
   passages, numbered in the portals' order, citing them as `[n]`. One plain streaming `/ask`
   emits its `answer` items directly as provisional `delta` events, without a schema attempt,
   JSON-text retry or catalogue walk. Hosted lookups request passages without fetching display summaries.
4. Step `verify` runs the Ask answer's deterministic binding over it: each sentence keeps only
   the markers whose passage carries its words, figures and names, a sentence stating a figure
   no passage supports is removed, and the markers are renumbered by first appearance. The step's
   `reason` says what was removed. An answer left with no supported citation is declined.
5. Verified citations follow the provisional deltas, then `done.text` supplies the complete, checked
   answer. Consumers MUST replace the accumulated text with `done.text` when it is present. This
   removes unsupported markers and figures, applies the final numbering, or replaces the draft
   with the refusal when no supported citation survives. `applyAgentEvent` does this for display
   records and evidence exports. Providers with only the older `compose` method still work, with
   buffered paragraph deltas.

### Budgets, deadlines and timing

- Hosted and peer lookups start together, with each source's deadline installed before work
  begins. Each source gets one 20-second budget across connection, MCP handshake, retries and
  response-body reads. The same abort signal reaches hosted `/find` and peer calls. Cancellation
  ends outstanding source and generation work; streaming generation has one absolute 90-second
  deadline, which is not reset on each delta. These are failure limits, not latency targets.
- Every source contributes at most **4 passages**, each **1,200 characters**. Composition admits
  at most **16 passages** overall, round-robin by source before numbering in source order, so a
  large first source cannot crowd out the others. Collection labels are capped at 120 characters,
  titles at 160, the question at 2,000 and history at the last four turns of 600 characters each.
  The question/passage prompt plus system instructions must fit **32,000 characters**. The host's
  own retrieval remains `top_k: 1`; generation remains `max_tokens: 4096`.
- An MCP peer's matching JSON-RPC result is consumed as soon as its SSE frame arrives. The
  response body is then cancelled, rather than waiting for a long-lived connection to close.
  Handshake ordering and the endpoint/tool allowlists still apply.
- `askStructured` remembers a recognised model-refusal 412 for **five minutes**, per portal and
  effective model, and skips the refused schema attempt on subsequent calls. Other errors do not
  populate the hint. Rebinding/invalidation clears it. At most 256 hints live in each provider
  instance; they retain no query, answer, error text or key and add no persistent record kind.
- Source and composition completion events carry their own `elapsedMs`. Composition completion
  also carries `firstTokenMs`, measured from composition start to the first upstream text delta.
  The source clock is sampled when the lookup settles, independent of stream backpressure.
- Both agent ask routes record one existing ask-insight row on the **host portal**. Its
  `firstTokenSec` and `answerSec` use the server clock from entering the answer stream through
  first text and completion, including search and verification. These feed the existing usage
  report's nearest-rank percentiles without new columns. Failures and uncited refusals are
  recorded as unanswered and excluded from answered-question percentiles. `durationSec` stays
  null because this path does not report the knowledge box's generation duration. These rows
  use the existing local and Durable Object insights adapters, retention and erasure.

The performance targets are interactive search below **2 seconds p95** and completed grounded
answers below **10 seconds p95** for typical queries. First-token time is a separate measure of
responsiveness, not proof of answer completion. The usage report measures server-side answered
question times; standalone search latency needs a separate representative load test. No target is
claimed from a synthetic fixture or from a failure timeout. With concurrent sources, expected
first-text time is the slowest admitted lookup plus the model's first delta; completion adds the
rest of one generation and the deterministic citation check. Model speed and peer latency still
need measurement in the intended managed deployment.

### Local streaming comparison (28 October 2026)

Five sequential HTTP requests to the agent stub's one-host, two-peer route, at replay speed 10,
used `Why warming? #compose sample N` (N from 0 to 4). The client clock started before `fetch`
and recorded the first `delta` and `done` SSE frames. The baseline was `2f857bb`; the streaming
implementation was `6b32091`. No real retrieval or generation service was called.

| Client-observed milliseconds | Before | Streaming |
|---|---:|---:|
| First delta p50 | 870 | 370 |
| First delta p95 | 904 | 528 |
| Completion p50 | 870 | 872 |
| Completion p95 | 904 | 1046 |

Percentiles here are nearest-rank over five samples, not an acceptance load test. The fixture
keeps its original six-second generation schedule (600 ms at this speed); it now emits the
first delta after one second of generation instead of waiting for all six. Its 2.5-second hosted
lookup therefore puts first text near 3.5 seconds and completion near 8.5 seconds at the original
pace, before harness overhead. The peers are in-process fixtures. Completion did not improve in
this synthetic comparison, and the small sample on a shared development machine is insufficient
to assess completion p95. The production provider's removed catalogue walk and schema/retry
calls are covered by fetch-count tests; their real-world time saving remains unmeasured. The
reported live 39 to 40 seconds was not retested because this lane uses local fixtures only.

What the federated ask does today, for comparison: each portal's answer streams on its own, a
portal that throws gets its own `error` event while the others carry on, and the stream ends with
`estate-done`. A portal that hangs has no time limit: the stream waits on it until the reader
gives up, and `estate-done` never arrives.

## Events

| Event | Fields | When |
| --- | --- | --- |
| `agent-start` | `mode, sources: [{id, label, portal?, kind?, transport?}]` | First, at once: who answers (`agent` or `orchestrated`) and the sources it can search (may be empty) |
| `agent-step` | `id, module, title, status, elapsedMs?, firstTokenMs?, reason?` | A step opening (`started`) or closing (`completed` or `failed`, with `elapsedMs`) |
| `agent-sources` | `stepId, source, question?, chunks: [{id, title, text, url?, resourceId?}]` | What one source returned for a step |
| `sources-failed` | `sources: [{id, label, portal?, kind?, transport?, reason: timeout \| unauthorised \| error}]` | Composing only: the sources that could not be searched, once, before the answer |
| `reasoning` | `text, last` | The agent thinking aloud; `last` closes a run of reasoning |
| `delta` | `text` | The next piece of the answer |
| `citation` | `marker, sourceId, chunkId, title, url?` | What `[marker]` in the answer cites |
| `done` | `elapsedMs, text?` | The answer is complete; `text`, when present, replaces provisional text with the checked answer |
| `error` | `code, message, retryable` | The stream ended without an answer |

Guarantees a view can rely on:

- `agent-start` comes first, while source lookups begin concurrently, so there is always
  something to show. When the portal composes, every source has a `kind`: `hosted` is a portal
  of this deployment (`id` and `portal` its slug, `label` its name, a chunk's `resourceId` the
  resource it comes from, `/t/<portal>/library/<resourceId>`); `peer` is a federated partner
  (`id` is `peer:<peer id>`, `transport` is `kb` or `mcp`, no `portal`, no `resourceId`, and a
  `url` only when the peer allows links). Say "federated partner" for a peer.
- Every step id is `started` once, then closed at most once. A step still open at the end is
  closed by the `done` (as `completed`) or the `error` (as `failed`). Steps can run in parallel.
- `agent-sources.stepId` names the lookup step that found the passages, already started. A step
  can have several `agent-sources` events, one per source it searched. If an agent ever sends
  passages with no step at all, `stepId` is `context/<id>` and no `agent-step` has that id.
- Citation markers appear in the `delta` text as `[marker]`: `[block-AA]` from an agent, `[1]`
  when composed. The `citation` event's `marker` is the bare `block-AA` or `1`. Citations arrive
  after the answer text, and `sourceId` and `chunkId` match an earlier `agent-sources` event, so
  each citation maps to its source.
- The stream ends with exactly one `done` or `error`. `code` is `timeout`, `upstream`,
  `cancelled` or `not_configured`; `message` is the portal's own wording, never upstream detail.
- `url` is always http(s).

Example (shortened from the happy-path fixture):

```
data: {"type":"agent-start","mode":"agent","sources":[{"id":"drv-fisheries","label":"Fisheries research"},{"id":"drv-grains","label":"Grains research"}]}
data: {"type":"agent-step","id":"preprocess/rephrase","module":"rephrase","title":"Understanding the question","status":"started"}
data: {"type":"reasoning","text":"The question spans three collections. ","last":false}
data: {"type":"agent-step","id":"preprocess/rephrase","module":"rephrase","title":"Understanding the question","status":"completed","elapsedMs":3050}
data: {"type":"agent-step","id":"context/ctx-fisheries","module":"basic_ask","title":"Searching Fisheries research","status":"started"}
data: {"type":"agent-step","id":"context/ctx-fisheries","module":"basic_ask","title":"Searching Fisheries research","status":"completed","elapsedMs":18500}
data: {"type":"agent-sources","stepId":"context/ctx-fisheries","source":{"id":"drv-fisheries","label":"Fisheries research"},"question":"How are warmer waters changing disease pressure?","chunks":[{"id":"res-fish-0412/f/file/0-218","title":"Summer mortality in farmed oysters: a ten-year review","text":"Mortality events...","url":"https://example.org/fish/res-fish-0412.pdf"}]}
data: {"type":"agent-step","id":"generate/answer","module":"generation","title":"Writing the answer","status":"started"}
data: {"type":"delta","text":"In fisheries, warmer water is linked to "}
data: {"type":"delta","text":"more disease outbreaks [block-AA]."}
data: {"type":"citation","marker":"block-AA","sourceId":"drv-fisheries","chunkId":"res-fish-0412/f/file/0-218","title":"Summer mortality in farmed oysters: a ten-year review","url":"https://example.org/fish/res-fish-0412.pdf"}
data: {"type":"agent-step","id":"generate/answer","module":"generation","title":"Writing the answer","status":"completed","elapsedMs":19100}
data: {"type":"done","elapsedMs":89800}
```

Composed, with one portal timing out (shortened from the stub):

```
data: {"type":"agent-start","mode":"orchestrated","sources":[{"id":"marine","label":"Southern Waters Research Portal","portal":"marine"},{"id":"grains","label":"Dryland Cropping Research Portal","portal":"grains"}]}
data: {"type":"agent-step","id":"source/marine","module":"search","title":"Searching Southern Waters Research Portal","status":"started"}
data: {"type":"agent-step","id":"source/grains","module":"search","title":"Searching Dryland Cropping Research Portal","status":"started"}
data: {"type":"agent-step","id":"source/marine","module":"search","title":"Searching Southern Waters Research Portal","status":"completed","elapsedMs":2510}
data: {"type":"agent-sources","stepId":"source/marine","source":{"id":"marine","label":"Southern Waters Research Portal","portal":"marine"},"chunks":[{"id":"marine/res-fish-0412","title":"Summer mortality in farmed oysters: a ten-year review","text":"Mortality events...","resourceId":"res-fish-0412"}]}
data: {"type":"agent-step","id":"source/grains","module":"search","title":"Searching Dryland Cropping Research Portal","status":"failed","elapsedMs":12000,"reason":"No answer within 12 seconds."}
data: {"type":"sources-failed","sources":[{"id":"grains","label":"Dryland Cropping Research Portal","portal":"grains","reason":"timeout"}]}
data: {"type":"agent-step","id":"compose","module":"compose","title":"Composing one answer from 3 passages","status":"started"}
data: {"type":"agent-step","id":"compose","module":"compose","title":"Composing one answer from 3 passages","status":"completed","elapsedMs":6000}
data: {"type":"agent-step","id":"verify","module":"verify","title":"Checking each citation against its passage","status":"started"}
data: {"type":"agent-step","id":"verify","module":"verify","title":"Checking each citation against its passage","status":"completed","elapsedMs":4}
data: {"type":"delta","text":"Mortality events in farmed oysters clustered ... ten days.[1] ...\n\n"}
data: {"type":"citation","marker":"1","sourceId":"marine","chunkId":"marine/res-fish-0412","title":"Summer mortality in farmed oysters: a ten-year review"}
data: {"type":"done","elapsedMs":18030}
```

## The reader's page

`/t/:slug/agent` (`apps/web/src/pages/AgentAskPage.tsx`) is where a reader asks and watches. It
is in the portal's navigation as "Agent ask" wherever `agentAsk` is on. `?q=<question>` prefills
the question and `&run=1` sends it at once (the demo tour links this way); `run` is consumed so a
refresh does not ask again, and `q` stays so the address names the question. The page shares the
Ask page's frame: the question becomes the heading once asked, the composer is pinned at the foot
of the scrolling column, and the steps sit in a right rail from `xl` up.

- On the platform host with a directory, the page offers the other portals to include and uses
  `POST /api/ask-agent`; with nowhere else to search (an anonymous reader, or a portal's own
  host) it asks the one-portal route, which composes over the portal and its peers.
- The steps rail shows every step as it opens, grouped by phase, with its time; a failed step
  carries its reason. Under the answer, every source from `agent-start` is a section with the
  question put to it and the passages it returned as the Ask page's source cards; a peer is
  marked "federated partner" or "partner over MCP", and its passages and citations carry no link.
- The answer card says who wrote the answer ("Answered by the portal's research agent", or
  "Composed by CorpusKit from N collections", counting the collections that returned passages),
  shows the `sources-failed` notice above the answer, numbers the markers by first appearance and
  places them after punctuation, keeps the working notes under the answer (closed by default),
  and keeps whatever arrived when the stream ends early (stopped, failed, or past the page's own
  five-minute limit).
- Assistive technology hears one polite status line: the step the portal is on (at most one
  every few seconds), the failed-source notice once, and the answer's completion; never the
  answer text as it streams. Errors are an alert in the card.
- A run outlives the page. The access layer withdraws authority on every return to the window
  and re-reads the session, which remounts the page for a moment; the run is held outside the
  page (`useAgentAsk`) and its stream is read outside the access generation (`durable` on
  `streamAgentAsk`), so the page re-attaches to it. A different signed-in identity ends the run,
  and a page nobody returns to within a few seconds stops it, keeping what arrived.

## Saving an answer as an evidence brief

The Ask page's "Export" saves a research trail as a Word document. The agent ask page does the
same through `AgentAnswerExportButton` (`apps/web/src/components/AgentAnswerExport.tsx`), which
writes an evidence brief: each turn's question, who answered it (`agent-start.mode`), what every
collection gave, the answer with its markers renumbered `[1]`, `[2]`... by first appearance
whatever the writer used, and the references grouped by collection in the order `agent-start`
announced them, followed by the collections `sources-failed` named and why.

The page keeps one `AgentAnswerRecord` per turn (`apps/web/src/lib/agent-answer-export.ts`):
`emptyAgentAnswer(question)`, then `applyAgentEvent(record, event)` for each event
`streamAgentAsk()` delivers, so the record is whatever the stream has said so far. Only a finished
turn with text exports (`hasExportableAnswer`). Mount the control with the turns and the portal:

```tsx
<AgentAnswerExportButton
  slug={config.slug}
  portalName={config.branding.productName}
  turns={turns}
  busy={isStreaming}
/>
```

It renders nothing for a reader without `portal.export`, is disabled while an answer streams, and
confirms the saved file with the same status line the Ask export uses. A reference links to the
passage's own `url` when the stream gave one, else to `/t/<portal>/library/<resourceId>` when the
collection is a portal of this deployment; a passage with neither (a federated partner's, with
origin links off) is quoted under its title instead. A peer collection is headed "federated
partner", or "partner over MCP" when its transport is `mcp`, and one that refused its key is
listed as "this partner could not be reached". Everything the
stream authored (labels, titles, answer text) is escaped; the brief's own copy goes through the
portal locale.

## The stub server

Build and check a view against the fixtures, with no live agent:

```
deno task dev:stub                 # recorded pace, about 90 s an agent answer
deno task dev:stub --speed=10      # ten times faster; --speed=0 is instant
deno task dev:stub --port=8795     # first port to try (8791 by default)
```

It builds `apps/web/dist`, boots the real app with the E2E `DoubleProvider`, and opts three
portals in: `marine` (the host, fisheries passages), `grains` (grains passages) and
`rural-industries-research` (rural passages), each searching its own slice of the fixture
corpus. The host, `marine`, also has two synthetic federation peers, one `arag-kb` and one
`arag-mcp`, answered in process by `e2e/support/arag-peer-double.ts` (no network). It prints its
address and two ready-made requests. Ask with tags in the question:

| Tag | Effect |
| --- | --- |
| (none) | The agent answers: `agent-happy.ndjson`, about 90 s, rephrase, plan, three parallel source lookups with summaries, a second lookup, ranking, a coverage check, reasoning, a streamed answer with six citations |
| `#error` | Agent session that fails at about 25 s (`agent-error.ndjson`) |
| `#slow` | Agent session with nothing for 12 s, done at about 47 s (`agent-slow-start.ndjson`) |
| `#compose` | No agent: the portal composes across the portals (about 10 s at the recorded pace) |
| `#source-timeout` | With `#compose`: the second portal runs past its time limit (12 s at speed 1) |
| `#source-error` | With `#compose`: the second portal fails |
| `#peer-timeout` | With `#compose`: the host's search peer runs past its time limit |
| `#peer-unauthorised` | With `#compose`: the host's MCP peer refuses its key |
| `#fast` | Replays without waiting |

```
curl -N -X POST http://127.0.0.1:8791/api/t/marine/ask-agent \
  -H 'content-type: application/json' -d '{"query":"How is warming changing pests? #fast"}'
curl -N -X POST http://127.0.0.1:8791/api/ask-agent -H 'content-type: application/json' \
  -d '{"query":"How is warming changing pests? #compose #source-timeout","slugs":["marine","grains","rural-industries-research"]}'
```

## How the normaliser reads an agent session

A session (`POST https://{zone}.dp.progress.cloud/api/v1/agent/{id}/session/ephemeral`) returns
NDJSON, one `AragAnswer` per line. The normaliser maps it as follows, and skips anything else:
lines that are not JSON objects, unknown operations and unknown fields.

- `operation` 6 (`streaming_response_chunk.text`) is a `delta`; 7 (`reasoning`) is `reasoning`;
  0 with `answer` is sent whole only when no chunk streamed; 3 (done) and 1 (quit) end with
  `done`; 4 (error) ends with `error` coded `upstream`; 2 (start) and 5 (agent request) add
  nothing.
- `step` opens a step keyed by `agent_path` (else `module`); the next line with the same key
  closes it, `failed` when it carries `error`. A first line already finished (`timeit` above
  zero, or `error`) opens and closes at once. `elapsedMs` is `timeit` in milliseconds.
- `context` becomes `agent-sources`, grouped by driver (`chunk.origin_agent`, else
  `context.agent_id`, `source`, `agent`), on the step whose `agent_path` is `context/<id>`.
  A configured source's label wins over the stream's.
- `answer_citations.metadata` entries become `citation` events through `context_id` and
  `chunk_index`; one whose context or chunk never arrived is dropped.

These rules come from the documented `AragAnswer` shape, not a recorded session. Check them
against a real recording when one exists: save it as a fixture (add `_t`, the arrival time in
milliseconds, to each line if it should replay at its real pace) and run the normaliser tests.
For the fallback to work, the real `AragProvider.agentAsk` should make the session request before
it yields anything, so that a refused session throws and the portal composes instead.
