# Agent ask

Agent ask streams an answer one step at a time, from one of two writers:

- **agent**: a retrieval agent plans, searches each of its sources, reasons aloud, then writes a
  cited answer. A real session runs for one to two minutes.
- **orchestrated**: when the portal has no agent, the portal searches each collection itself,
  composes one answer from the passages they returned, and checks every citation against its
  passage before the reader sees it.

Both produce the same events, and `agent-start.mode` says which wrote the answer, so a view can
say "composed by CorpusKit across 3 collections" and never present the portal's own composition
as an agent's. The stream is built to be watched: steps open and close, each source's passages
arrive as they are found, and the answer streams in at the end.

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

## External agents over MCP

An external agent can consume the same portal capability at `POST /api/t/:slug/mcp`, using
`ask_federated` for an attributed answer or `search_federated` for attributed passages it can
use in its own answer. Both require agent ask to be enabled and the caller's `portal.ask`
permission. They include the host's configured peers and report sources that failed. See
[the MCP tool contract and limits](RBAC.md#federated-portal-mcp-tools).

An administrator can create and revoke keys in Manage > Access > Keys. Selecting extra portals
creates an estate key for `/api/estate/mcp`; the portal endpoint continues to serve its own
collection and peers. The estate endpoint serves the selected hosted portals.

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
   passages, numbered in the portals' order, citing them as `[n]`.
4. Step `verify` runs the Ask answer's deterministic binding over it: each sentence keeps only
   the markers whose passage carries its words, figures and names, a sentence stating a figure
   no passage supports is removed, and the markers are renumbered by first appearance. The step's
   `reason` says what was removed. An answer left with no supported citation is declined.
5. The answer streams a paragraph at a time, then its citations, then `done`.

What the federated ask does today, for comparison: each portal's answer streams on its own, a
portal that throws gets its own `error` event while the others carry on, and the stream ends with
`estate-done`. A portal that hangs has no time limit: the stream waits on it until the reader
gives up, and `estate-done` never arrives.

## Events

| Event | Fields | When |
| --- | --- | --- |
| `agent-start` | `mode, sources: [{id, label, portal?, kind?, transport?}]` | First, at once: who answers (`agent` or `orchestrated`) and the sources it can search (may be empty) |
| `agent-step` | `id, module, title, status, elapsedMs?, reason?` | A step opening (`started`) or closing (`completed` or `failed`, with `elapsedMs`) |
| `agent-sources` | `stepId, source, question?, chunks: [{id, title, text, url?, resourceId?}]` | What one source returned for a step |
| `sources-failed` | `sources: [{id, label, portal?, kind?, transport?, reason: timeout \| unauthorised \| error}]` | Composing only: the sources that could not be searched, once, before the answer |
| `reasoning` | `text, last` | The agent thinking aloud; `last` closes a run of reasoning |
| `delta` | `text` | The next piece of the answer |
| `citation` | `marker, sourceId, chunkId, title, url?` | What `[marker]` in the answer cites |
| `done` | `elapsedMs` | The answer is complete |
| `error` | `code, message, retryable` | The stream ended without an answer |

Guarantees a view can rely on:

- `agent-start` comes first and arrives before anything is searched, so there is always
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
