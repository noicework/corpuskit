# Developing on Progress Agentic RAG (ARAG / Nuclia) - hard-won reference

This is the distilled, battle-tested knowledge for building against Progress Agentic RAG
(the Nuclia-based platform). It exists so this session does NOT rediscover the platform's
sharp edges the hard way. Read it before writing any retrieval/provisioning code. Source:
the ARAG GTM factory's own field builds (Aug 2026).

## Mental model
ARAG = a managed RAG platform. Per **Knowledge Box (KB)** you: ingest content -> enrich it
with **Data-Augmentation (DA) agents** (labeler, graph, synthetic-questions, ask/summarize) ->
retrieve with grounded, **cited** answers (`/ask`) -> score answer quality with **REMi** ->
optionally expose tools to an agent over **MCP**. Extraction, labels, a knowledge graph, and
search configurations are all configurable objects ON the KB, viewable in the admin console.

## Credentials (get this right first - most 403s are a wrong-token problem)
- **Account:** all resources live under one account. Account id `86d1adc8-64ef-499b-86d6-72e9fd684ab0`
  (the shared development account). Never provision under any other account.
- **NUA key** = account-level ops only (create/list KBs). Put it in `.env` as `ARAG_NUA_KEY`
  (never commit; copy it from the team's shared `.env`). It **403s on KB-scoped writes** - do NOT
  use it to write resources/tasks/configs on a KB.
- **KB service-account token** (SOWNER) = KB-scoped reads AND writes (ingest, tasks, `/ask`, REMi).
  Header: `X-NUCLIA-SERVICEACCOUNT: Bearer <token>`. Mint one per KB after creating it.
- Verify a NUA key is scoped to the right account with `GET /api/v1/account/{ACCOUNT_ID}/kbs`
  (200 + KB list = good; 403 = wrong account). Note `GET /api/v1/user` does NOT work for NUA keys
  (always 403 "not valid in the global API") - a 403 there proves nothing.
- Hosts: retrieval/`/ask` use the **rag-host** (`{region}.rag.progress.cloud`); DA tasks use the
  **dp-host** (same, with `.rag.` swapped for `.dp.`). Only AU zone (`aws-ap-southeast-2-1`) is
  provisionable with the current key.

## Working call shapes (these are the ones that actually work)
- **Ingest a file:** single-call `POST /kb/{id}/upload`, then PATCH metadata onto the created
  resource. The two-step create-resource + PUT-file pattern **500s on PDFs** on this deployment.
- **A resource's title is NOT searchable body text.** Any name that must ground an answer
  (a person, a vehicle, a product) has to be written into the text field body too.
- **Grounded answer:** `POST {rag-host}/api/v1/kb/{id}/ask` -> grounded, cited answer.
- **Structured JSON answer (query-time):** `POST .../ask` with `answer_json_schema`
  (OpenAI-function style: `name` + `parameters` as JSON Schema) -> schema-conformant `answer_json`
  grounded in real content. **HARD CONSTRAINT: never send `citations:true` AND `answer_json_schema`
  in the same `/ask` call - it crashes the backend (500/503).** For provenance in schema mode read
  `retrieval_results.resources` (populated even with `citations:false`) or fire a second
  citations-only `/ask`.
- **REMi (answer-quality score):** `POST {kb}/predict/remi` with the **KB service-account token**
  (NOT the NUA key). Score against the **FULL retrieved context** (all paragraphs `/ask` grounded
  on), not just the citation excerpts - thin context makes groundedness swing wildly (0/5 then 5/5
  on the same good answer). Full context -> stable 5/5.
- **DA tasks:** `POST {dp-host}/api/v1/kb/{id}/task/start`, body `{name, parameters, apply, enabled}`.
  `name` is the type enum: `labeler | llm-graph | synthetic-questions | ask | ...`. **Always pin
  `parameters.llm.model`** to the KB's own model - unpinned tasks return 200 then fail silently
  during execution. **DA output is stored under `da-<destination>-f-<fieldId>`**, not the plain
  destination key - read the resource's real field list before reading it back. **Only ONE
  `labeler`-type task can run at a time** (concurrent starts 422 and can leave a stale zombie
  config; `DELETE /kb/{id}/task/{id}` clears it) - run labelers sequentially with polling.
- **Extract strategies:** register the strategy, then apply it by uploading with an
  `X-Extract-Strategy` header (e.g. table-aware for schedules, visual/OCR for scanned docs).
- **Search configurations:** `GET/POST /kb/{id}/search_configurations` - named configs with a
  baked-in `filter_expression`; wire each surface to its config rather than filtering ad hoc.
- **Reading extracted text:** needs `show=extracted&extracted=text` TOGETHER (`show=values` alone
  returns only the file pointer). The extracted text **flattens markdown line breaks into
  whitespace runs** - normalize before rendering or raw `##`/`|` leaks on screen and position-based
  citation highlighting breaks.

- **Multi-doc summaries:** `POST /kb/{id}/summarize` `{resources: [uids] (REQUIRED), summary_kind:
  'simple'|'extended', user_prompt?}` - verified 2xx; response has a combined `summary` plus
  per-resource summaries. Missing uids are silently ignored.
- **Reranker:** both `/find` and `/ask` accept a top-level `reranker` field -
  `'predict'` (cross-encoder rerank pass) or `'noop'` (raw BM25/vector/hybrid
  scores) - verified live by sending an invalid value: the 422 names the
  exact enum (`str-enum[RerankerName]`, `"Input should be 'predict' or
  'noop'"`). **The platform's default when the field is omitted is already
  `'predict'`** - confirmed by comparing `score_type` on retrieved paragraphs
  (`RERANKER` by default and with `reranker:'predict'` explicit; `BM25` /
  `VECTOR` / `BOTH` only with `reranker:'noop'`). A named `search_configuration`
  does not override an explicit request-level `reranker` (unlike `features` -
  see below) and its own `config` object also accepts a `reranker` key.
  Pinning it explicitly (in the request body and the stored config) is
  therefore defensive, not a new capability - it stops a future platform
  default change from silently un-reranking these paths. An object form
  (`{name:'predict', ...}`, discriminator field `name`) is also accepted but
  extra keys inside it (`top_k`, etc.) are silently ignored by validation, so
  don't rely on them without separately confirming they do something - the
  plain string form is the only fully-verified shape.
- **Prequeries (deep research):** `rag_strategies: [{name:'prequeries', queries:[{request:
  {query, features:['keyword','semantic']}, weight: 1}], ...}]` - max 10 queries, each `request`
  is a full FindRequest. `full_resource` and `page_image`/`tables` (under `rag_images_strategies`)
  are the other verified strategy names.
- **Rephrase:** `POST /kb/{id}/predict/rephrase` `{question, user_id}` works with the SA token BUT
  **appends a single status digit** (`0`/`1`) to the rephrased text - strip a trailing `[01]`.
- **Answer feedback:** `POST /kb/{id}/feedback` `{ident, good, task:'CHAT', feedback?}` where
  `ident` is the `Nuclia-Learning-Id` **response header** of the original `/ask` - capture it at
  stream time or it is gone.
- **Hidden resources:** `PATCH /resource/{id}` `{hidden:true}` 422s until the KB-level feature is
  on, and there is NO regional endpoint to enable it. The account-scoped Zone API
  `PATCH /account/{acct}/kb/{kbid}` `{hidden_resources_enabled:true}` (NUA key) accepts it even
  though the field is undocumented on that endpoint - verified live. `/catalog` returns hidden
  resources unless you pass `hidden=false`; `/find`/`/ask` exclude them by default.
- **Memory DA task:** `POST {dp}/task/start` `{name:'memory', parameters:{name, on:1, operations:
  [{memory:{ident, prompt?, rules?}}], llm:{model}}, apply, enabled}` - verified 200.
- **Activity endpoints (`/kb/{id}/activity/*`) are 403 to SA tokens** (dashboard-user auth only).
  Ask analytics must be logged app-side at the proxy - which sees every ask anyway.

## Known platform bugs - DO NOT burn cycles rediscovering these
- **DA-Generator JSON output (`json:true` / `kv_schema_id`) is BROKEN** - 422s even on Progress's
  own example, even schema-free. It is the ingest-time DA task path only. Workarounds: a plain-text
  `ask` DA task that emits JSON-as-text parsed server-side, OR the query-time `/ask`
  `answer_json_schema` path (which WORKS - see above). Disclose the gap; never fake it.
- **RAO Retrieval-Agent live sessions (`/session/ephemeral`) are BROKEN** - fail with
  `"unhandled errors in a TaskGroup"` even with zero tools. So "an ARAG agent orchestrating tool
  calls over MCP" is not live today. If you need that pattern, app-orchestrate the same genuine
  calls and disclose it, OR wait for the upstream fix.
- **`/ask` honours `filter_expression` weakly vs `/find`** - filtered-out resources can still
  ground an answer. Cross-check every citation server-side against the filter and withhold any
  answer grounded only in excluded content.
- **`filter_expression` is keyed differently per endpoint** - `{resource: ...}` on `/catalog` but
  `{field: ...}` on `/find` and `/ask`, same concept.
- **The legacy `filters` array silently returns ZERO for label paths** - use `filter_expression`.
- **Pagination has THREE different shapes** - `/resources` keys on `pagination.last`; `/catalog`
  on `fulltext.next_page`; there's no shared `pagination` object. A wrong key silently truncates to
  the first 50. Never assume.
- **Native faceted aggregation costs 40s+ per call** - unusable interactively; paginate-and-count.
- **DA-generated fields can come back as citation hits** on later retrieval (e.g. a stored JSON
  blob showing up as a "source"). Exclude any `da-`/`/t/da-` field id from citations.
- **Task status reporting is unreliable** - a registered task can sit in `configs` and never show
  in `/tasks` `done` even when its output is verifiably on every resource. Verify by fetching the
  resource's fields, not just the status flag.

## Clean architecture for THIS portal (so ARAG is swappable)
- Put retrieval behind a **`RetrievalProvider` interface** on the server (methods like
  `ask()`, `search()`, `graph()`, `provisionTenant()`). ARAG is one implementation; a stub/mock is
  another for local dev without the platform. No ARAG/Nuclia types leak into the UI or components.
- **Server-side only.** The KB service-account token NEVER reaches the browser - every ARAG call is
  proxied through the server. No key in client code, ever.
- **Provisioning engine (this portal's differentiator):** "point at a blank KB + a domain brief ->
  configure everything" maps directly onto the calls above: create KB (NUA key) -> mint SA token ->
  ingest the starter corpus (`/upload`) -> register DA tasks (labeler for the domain taxonomy,
  llm-graph for the entity/relation types, synthetic-questions for suggested questions, ask for
  summaries) -> register extract strategies + search configs -> done. Build it as an idempotent,
  resumable pipeline (tasks are async; poll to completion; labelers strictly sequential).

## When you hit something not covered here
The team's internal ARAG factory project has deeper skills (`arag-kb`,
`rao-workflow`, `arag-demo-app`) and a live memory of every gotcha. Ask the team to relay a
specific question to the factory session rather than probing the live platform blindly - the factory has
almost certainly already paid for that lesson.

- **`search_configuration` overrides the request's `features`** - passing a
  named config plus `features: ['keyword']` still runs the config's own
  features, making mode switches silently inert. Only attach the config for
  the default mode; drop it when the caller chooses a specific mode.
- **`/find` paragraph scores mix scales** - semantic ~0-1, BM25 unbounded
  (5-30 typical). Calibrate (logistic squash for >1) instead of normalising
  to the top hit, or every top result reads "100%".
- **Graph queries: filter to agent-extracted relations with
  `{prop:'generated', by:'data-augmentation'}`** (combinable via `{and:[...]}`
  with a path/node query). Without it, once real PDFs land the built-in NER
  pipeline floods `/graph` with PERSON/DATE/LOC paths and the curated llm-graph
  relations fall outside `top_k`.
