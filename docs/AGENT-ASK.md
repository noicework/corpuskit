# Agent ask

Agent ask streams a retrieval agent's answer one step at a time. The agent plans, searches each
of its sources, reasons aloud, then writes a cited answer. A real session runs for one to two
minutes, so the stream is built to be watched: steps open and close, each source's passages
arrive as they are found, and the answer streams in at the end.

It is a separate contract from Ask (`AskEventSchema`): nothing that reads the portal's own Ask
stream changes.

- Events: `AgentAskEventSchema` in `packages/core/src/agent-ask.ts`
- Normaliser (ARAG `AragAnswer` NDJSON to events): `packages/retrieval/src/providers/arag/agent-stream.ts`
- Route: `POST /api/t/:slug/ask-agent` in `apps/api/src/app.ts`
- Client: `streamAgentAsk()` in `apps/web/src/api/client.ts`
- Fixtures: `packages/retrieval/src/providers/arag/fixtures/agent-*.ndjson`

## Switching it on

Opt-in per portal with the `agentAsk` tenant setting (default off):

```
PATCH /api/admin/tenants/:slug   {"agentAsk": true}
```

While it is off, or when the retrieval provider has no agent support, the route answers
`404 {"error":"not_found"}`. With it on, `AragProvider` currently answers every question with an
`error` event coded `not_configured`: the live agent session is a TODO in `AragProvider.agentAsk`.

## The request

```
POST /api/t/:slug/ask-agent
{"query": "How is a warmer climate changing pest pressure?", "context": [{"author": "USER", "text": "..."}]}
```

`query` is 1 to 2000 characters; `context` (optional, up to 24 prior turns) is
`{author: "USER" | "AGENT", text}`. The answer is a server-sent event stream, one JSON event per
`data:` frame. It is rate limited and counted as an ask, like `/ask`. Closing the connection ends
the agent's upstream session.

## Events

| Event | Fields | When |
| --- | --- | --- |
| `agent-start` | `sources: [{id, label}]` | First, at once: the sources the agent can search (may be empty) |
| `agent-step` | `id, module, title, status, elapsedMs?, reason?` | A step opening (`started`) or closing (`completed` or `failed`, with `elapsedMs`) |
| `agent-sources` | `stepId, source: {id, label}, question?, chunks: [{id, title, text, url?}]` | What one source returned for a step |
| `reasoning` | `text, last` | The agent thinking aloud; `last` closes a run of reasoning |
| `delta` | `text` | The next piece of the answer |
| `citation` | `marker, sourceId, chunkId, title, url?` | What `[marker]` in the answer cites |
| `done` | `elapsedMs` | The answer is complete |
| `error` | `code, message, retryable` | The stream ended without an answer |

Guarantees a view can rely on:

- `agent-start` comes first and arrives before the agent sends anything, so there is always
  something to show.
- Every step id is `started` once, then closed at most once. A step still open at the end is
  closed by the `done` (as `completed`) or the `error` (as `failed`). Steps can run in parallel.
- `agent-sources.stepId` names a step already started. A step can have several `agent-sources`
  events, one per source it searched.
- Citation markers appear in the `delta` text as `[block-AA]`; the `citation` event's `marker` is
  the bare `block-AA`. Citations arrive after the answer text. `sourceId` and `chunkId` match an
  earlier `agent-sources` event.
- The stream ends with exactly one `done` or `error`. `code` is `timeout`, `upstream`,
  `cancelled` or `not_configured`; `message` is the portal's own wording, never upstream detail.
- `url` is always http(s).

Example (shortened from the happy-path fixture):

```
data: {"type":"agent-start","sources":[{"id":"drv-fisheries","label":"Fisheries research"},{"id":"drv-grains","label":"Grains research"}]}
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

## The stub server

Build and check a view against the fixtures, with no live agent:

```
deno task dev:stub                 # recorded pace, about 90 s an answer
deno task dev:stub --speed=10      # ten times faster; --speed=0 is instant
deno task dev:stub --port=8795     # first port to try (8791 by default)
```

It builds `apps/web/dist`, boots the real app with the E2E `DoubleProvider`, opts the `marine`
portal in, and prints its address. Ask with tags in the question to pick a fixture:

| Tag | Fixture | Shape |
| --- | --- | --- |
| (none) | `agent-happy.ndjson` | About 90 s: rephrase, plan, three parallel source lookups with summaries, a second lookup, ranking, a coverage check, reasoning, a streamed answer with six citations |
| `#error` | `agent-error.ndjson` | One source answers, another fails at about 25 s |
| `#slow` | `agent-slow-start.ndjson` | Nothing for 12 s, the first step at 21 s, done at about 47 s |
| `#fast` | any | Replays without waiting |

```
curl -N -X POST http://127.0.0.1:8791/api/t/marine/ask-agent \
  -H 'content-type: application/json' -d '{"query":"How is warming changing pests? #fast"}'
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
