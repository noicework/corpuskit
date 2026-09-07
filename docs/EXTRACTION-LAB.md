# Extraction Lab - custom extraction methods, chosen by evidence

> Status 2026-09-03: built as Manage > Extraction (linked from Tools). The sandbox box
> `research-portal-<slug>-lab` is bound through `ARAG_KB_<SLUG>_LAB`; `table-aware` (`ai_tables`)
> and `visual-transcribe` (`vllm_config`) are registered on it and read back with the shapes in
> section 3.1. The profiler runs poppler on the host (the server needs
> `--allow-run=pdfinfo,pdftotext,pdffonts`, now in the `dev` task). Verified live on the
> PMC8960314 data sheet: class `image-only`; default and table-aware 1,130 characters, judge 2/5;
> visual 3,107 characters with 47 table rows, judge 3/5, recommended. Not yet built: the corpus
> buckets and streamed re-ingest, and the loader honouring the rules (a method must first be
> registered on the production box; the lab registers on the sandbox only).

> Update 2026-09-04 (roadmap R26, persona finding P4-10): the compare recommendation is now a
> function of the profile class first - a `tables` document recommends the table-aware method,
> an `image-only`, `garbled-text` or `long-scan` document the visual method - and the judge
> only overrides that on a clear loss (its score at least 2 points below the best other method;
> `JUDGE_OVERRIDE_MARGIN` in `apps/api/src/extraction.ts`). The `done` event carries a one-line
> `reason`. `yieldVsDefault` is filled on every method's event once Default has landed, and the
> before/after ask runs as a sandbox ask (`AskOptions.sandbox`): no stored search configuration
> (the lab box has none - naming `portal-ask` there 400s "Search configuration not found"), a
> zero retrieval score floor, and full-document grounding on the uploaded copy.

> Design and solution architecture for the second horizontal demo, written 2026-09-03 on a
> downstream fork; ported upstream on 7 September 2026. A sibling to `docs/INTENT-ROUTING.md`:
> that demo shows what a knowledge box does with a question; this one shows what a knowledge box
> can ever know, which is decided before the first question is asked, at extraction time.

## 1. The horizontal use case

**The extraction layer decides what your RAG can ever know.** Retrieval, reranking, agents and
citations all operate on the text the platform extracted at ingest. A table that came out as a
run of numbers with no columns, a scanned page that came out as forty characters of noise, a
figure whose caption was dropped: none of that can be retrieved, cited or reasoned over, and
nothing downstream will tell you. The answer simply comes back thinner, or wrong, with the same
confident tone.

That is the silent failure mode of a single default extraction, and every vertical has it:

| Vertical | Document class that breaks default extraction | What is lost |
|---|---|---|
| Regulatory and legal | Scanned filings, faxed correspondence, contracts with tabular schedules | The schedule of fees, the dates, the signatures, the whole page |
| Engineering and field service | Drawings, parts schedules, maintenance tables, photographed reports | Part numbers and tolerances in tables, callouts on drawings |
| Financial services | Policy wordings with benefit tables, statements, invoices | Every number that matters, mis-ordered or merged |
| Clinical research (the fixture tenant, live) | Trial results tables, dose schedules, supplementary data sheets, figure panels | Effect sizes, doses and confidence intervals that live only in tables |

On this platform a **custom extraction method** is a named **extract strategy** registered on the
knowledge box and applied per upload with the `X-Extract-Strategy` header. Verified live on
2026-09-03 (see section 3.1): a strategy carries a `vllm_config` (a vision language model with
transcription rules), an `ai_tables` option, an optional `split` strategy and a parallelism cap.
The default extraction is the platform's text layer. The horizontal pattern is not "OCR everything"
(a scanned-document corpus bake-off showed vision extraction is throughput bound and would take weeks on a corpus):
it is **profile every document, route each class to the cheapest method that recovers it, and
prove the choice with evidence before committing a corpus to it.**

| Document profile (from the profiler) | Default | Table-aware | Visual / OCR |
|---|---|---|---|
| Born-digital, prose, few tables | yes, free | no | no |
| Born-digital, dense tables (trial results, schedules, statements) | text only, columns lost | **yes** | no |
| Embedded text present but garbled (bad historical OCR) | keeps the garbage | no | **yes** |
| Image-only pages (scans, photographed forms, data sheets exported as images) | 40 chars per page | no | **yes** |
| Very long scanned documents (over about 60 pages) | thin | no | yes, chunked or capped |

The same routing table works for a fisheries archive, a legal practice or an insurer. Only the
profiles' thresholds and the worked examples change.

## 2. The Extraction Lab (the demo)

A Tools-page tool and a Manage panel that make the extraction decision visible and cheap to get
right. Everything runs in a **sandbox knowledge box**, never the production box.

### Panel 1 - Profile

Pick a resource from the library or upload a PDF. The lab profiles it server-side and shows a
compact card: pages, characters per page (embedded text layer), fonts embedded, image-only pages,
table density (rows detected per page), file size, and a profile class: `prose`, `tables`,
`garbled-text`, `image-only`, `long-scan`. The class is the routing key.

### Panel 2 - Compare methods

Run the document through two or three methods at once: **Default**, **Table-aware** (`ai_tables`
on), and **Visual** (a `vllm_config` strategy). Each column shows, as the sandbox processes it:

- extracted text, page by page, with the page render alongside for eyeballing;
- tables recovered (count, and the first table rendered as a real table);
- characters per page yield, and yield relative to Default;
- structure fidelity: headings, paragraphs and captions preserved;
- a quality score from a model-as-judge that compares the extraction with the page render (the
  judge is asked for a 0 to 5 score with a one-line reason, using the platform's structured
  `/ask` path with `answer_json_schema`, citations off);
- wall-clock latency and an estimated cost (vision pages times a per-page rate from the model).

### Panel 3 - Route and re-ingest

A routing-rule table, one row per profile class, pre-filled with the platform's recommendation
and editable: `image-only -> visual`, `tables -> table-aware`, `prose -> default`, `long-scan ->
default (capped)`. Beneath it, the corpus is bucketed by class with counts ("212 resources have
dense tables; 9 are image-only"), and a **Re-ingest N resources with this method** action that
re-uploads those files through the loader path with the chosen strategy, streamed, resumable,
with a cost cap the operator confirms.

### The before/after ask

The panel that makes the value undeniable: the same question asked twice, grounded on the default
and on the custom extraction of the same document, side by side with citations. For a trial paper:
"What was the hazard ratio and its confidence interval for a second seizure?" With the default
extraction the answer hedges or quotes prose; with table-aware extraction it cites the results
table. Numbers, not adjectives.

### Demo documents (all in a local corpus directory)

| Role | Resource | Why |
|---|---|---|
| Table-heavy article | PMC9716332, 2022, "Individualised prediction of drug resistance and seizure recurrence", 13 pages, about 5,000 chars per page | Results and model tables; the before/after ask targets its hazard ratios |
| Supplementary data sheet | PMC12891084 supplementary data sheet, 7 pages, about 1,570 chars per page | Tabular supplement to the anti-seizure medication timing paper |
| Figure-heavy paper | PMC13273915, 2026, "Acute and longitudinal MRI abnormalities in autoimmune encephalitis", 13 pages, 2.8 MB | Imaging panels and captions; shows what visual extraction adds and what it costs |
| Near image-only page | PMC8960314 supplementary data sheet, 1 page, 199 chars per page, one embedded JPEG | The corpus's own "image-only" class, without leaving the domain |
| True scan (optional) | A true 1-bit scan, if one is available | The hardest class; only if the platform's visual strategy is registered on the sandbox |

## 3. Solution architecture

### 3.1 What the live platform exposes (verified 2026-09-03)

- `GET /kb/{id}/extract_strategies` returns a map of strategy id to strategy. The fixture
  tenant's box has none (`{}`). Another knowledge box has one registered strategy, which gives
  the real shape:

  ```json
  {
    "3125bd6a-...": {
      "name": "visual-ocr-scanned",
      "vllm_config": {
        "rules": ["Transcribe every element on the page faithfully ... Do not summarise."],
        "llm": { "generative_model": "chatgpt-azure-4o", "user_keys": null,
                 "generative_provider": "", "generative_prompt_id": "", "reasoning_config": null }
      },
      "ai_tables": null,
      "split": null,
      "max_parallel_llm_calls": 0
    }
  }
  ```

  `GET /kb/{id}/extract_strategies/{id}` 404s for an unknown id; strategies are created with
  `POST /kb/{id}/extract_strategies` (body: the object above without the id) and applied per
  upload with `X-Extract-Strategy: <id>`. `ai_tables` is the table-aware switch; `split` names a
  split strategy (`GET /kb/{id}/split_strategies` is `{}` on both boxes).
- `GET /kb/{id}/schema` lists the model catalogue. `generative_model` and `summary_model` options
  include `claude-4-5-haiku`, `claude-4-5-sonnet`, `claude-4-6-sonnet`, `claude-4-6-opus`,
  `claude-4-7-opus`, `claude-4-8-opus`, `claude-5-sonnet`, `claude-5-fable` and their `gcp-` and
  `aws-` variants; `visual_labeling` is `disabled | enabled`. The box's configuration reports
  `generative_model: chatgpt-azure-4o`, semantic model `multilingual-2024-05-06`.
- The Pagehound strategy id from a previous loader run (`06275b19-...`) is not on either box
  today; the other knowledge box's registered strategy is the `visual-ocr-scanned` vLLM one above.

### 3.2 Layers and contracts

**RetrievalProvider (packages/retrieval)** gains an extraction facet, in the portal's vocabulary:

```ts
interface ExtractionMethod { id: string; name: string; kind: 'default' | 'tables' | 'visual'
  model?: string; rules?: string[] }
listExtractionMethods(tenant): Promise<ExtractionMethod[]>
registerExtractionMethod(tenant, spec: Omit<ExtractionMethod, 'id'>): Promise<ExtractionMethod>
uploadFile(tenant, { filename, contentType, bytes, method?: string })   // sets X-Extract-Strategy
resourceExtraction(tenant, id): Promise<{ pages: { number, text }[]; tables: Table[]; chars }>
```

The ARAG implementation maps `kind: 'tables'` to `{ ai_tables: {...} }` and `kind: 'visual'` to
a `vllm_config` with the transcription rules and a pinned model. No vendor shape reaches the UI.

**Sandbox box.** `provisionLab(tenant)` creates `research-portal-<slug>-lab` under the account
with the NUA key, mints a service-account token, stores the binding as `ARAG_KB_<SLUG>_LAB` in
`.env` (or the bindings store), and registers the three methods on it. It carries a cost cap
(max vision pages per day, default 60) and an auto-purge: every lab resource is tagged
`lab:<jobId>` and deleted when the comparison closes or after 24 hours.

**Profiler (apps/api/src/extraction/profile.ts).** Server-side, pure where possible. Uses
`pdfinfo`, `pdftotext` and `pdfimages -list` when present on the host (they are, via Homebrew;
the Dockerfile adds poppler), else falls back to the platform's extracted text and page count.
Emits the profile card and the class. Thresholds are constants with tests: under 100 chars per
page is `image-only`; over 100 with a dictionary-hit rate under 0.6 on words of four or more
letters is `garbled-text`; over 8 table rows per page is `tables`; over 60 pages and image-only is
`long-scan`.

**Comparison job (apps/api/src/extraction/compare.ts).** An SSE-streamed admin action,
`POST /api/admin/t/:slug/extraction/compare` with `{ resourceId | upload, methods[] }`. For each
method: upload to the sandbox with the header, poll to PROCESSED, read the extraction, compute
metrics, run the judge, emit `{ type: 'method', method, metrics, pages }` as each lands, then
`{ type: 'ask', method, answer, citations }` for the before/after question, then `done`. Timeouts
mirror the loader's batch ceiling.

**Routing rules on TenantConfig (packages/core).**

```ts
extraction?: {
  default: string                       // method id
  rules: { when: 'image-only' | 'garbled-text' | 'tables' | 'long-scan' | 'prose'; method: string }[]
  visualPageCap?: number                // route above this to default (the 125-page lesson)
}
```

Consumed by the corpus upload route (`/resources/upload` profiles the file and picks the method)
and by the corpus loader script, which reads the rules from `GET /api/t/:slug/config` and sets the
header per file.

**UI.** `apps/web/src/pages/tools/ExtractionLab.tsx` (three panels above, tokens only, both
themes, 390 px) linked from the Tools page; `apps/web/src/pages/admin/ExtractionPanel.tsx` under
Manage with the methods on the box, the routing rules editor, the corpus buckets and the
re-ingest action. Streams via the existing SSE client helpers.

### 3.3 Tests and rules

- Provider: strategy shape mapping (`kind` to platform body), header on upload, extraction
  read-back parsing; the existing `uploadFile` tests keep passing with `method` absent.
- Profiler: class thresholds on fixtures (a prose page, a table page, a garbled page, an image
  page), pure functions, no binaries in tests.
- Compare job: event order with a stubbed provider; cost cap refusal; purge on close.
- No npm: poppler is a host binary, invoked with `Deno.Command`; the PDF page render for the judge
  uses `pdftoppm` server-side, never a browser library.

## 4. Demo script (3 minutes, CIO or technical buyer)

1. **Open the Extraction Lab, pick PMC9716332.** Profile card: 13 pages, 5,000 chars per page,
   class `tables`. "Born-digital and healthy, by every cheap measure. Watch what the default
   still misses."
2. **Compare Default and Table-aware.** Text columns fill in. Default: the results table is a
   single paragraph of numbers. Table-aware: two tables recovered, rendered with headers. Yield
   similar, structure fidelity 2 versus 5, judge 3 versus 5, latency 40 s versus 2 min, cost
   shown. "Same file, same box. The only thing that changed is the extraction method."
3. **Before/after ask.** "What was the hazard ratio for seizure recurrence and its confidence
   interval?" Default answer paraphrases prose. Table-aware answer cites the table row with the
   numbers. "This is the difference between an answer a clinician can act on and one they cannot."
4. **Pick the PMC8960314 data sheet.** Class `image-only`, 199 chars per page, one embedded
   image. Compare Default and Visual: 199 chars against a full transcription; judge 1 versus 5.
   "This is the class that silently disappears from a corpus."
5. **Route and re-ingest.** The rule table proposes `tables -> table-aware`, `image-only ->
   visual`, `prose -> default`. Corpus buckets: how many resources sit in each. "212 resources
   get the table method, 9 get vision, the other 700 stay free. That is the whole point: not OCR
   everything, route by evidence." Click re-ingest on the 9, watch the stream.
6. **The reveal.** Manage > Extraction shows the three strategies registered on the sandbox box,
   read live from the platform, and the routing rules as stored tenant configuration. "This is
   configuration on the platform, not code in the app. Any vertical, same three panels."

## 5. Build plan

Each step is a `deno task check`-sized change on the PR branch.

1. `packages/core/src/index.ts`: `ExtractionMethodSchema`, `ExtractionProfileSchema`,
   `ExtractionRulesSchema` and `extraction?` on `TenantConfigSchema`, with tests.
2. `packages/retrieval/src/provider.ts` and `providers/arag/index.ts`: `listExtractionMethods`,
   `registerExtractionMethod`, `method` on `uploadFile` (header), `resourceExtraction` read-back
   (`show=extracted&extracted=text` plus tables). Tests beside the existing upload tests.
3. `apps/api/src/extraction/profile.ts` (+ test): the profiler, pure classification over a
   profile object; a thin `Deno.Command` shell for poppler with a fallback.
4. `apps/api/src/lab.ts` (+ test): sandbox provisioning and binding (`research-portal-<slug>-lab`),
   cost cap, purge; reuse `provision.ts` helpers.
5. `apps/api/src/extraction/compare.ts` (+ test): the streamed comparison job, the judge call via
   `askStructured` (never `citations: true` with `answer_json_schema`), the before/after ask.
6. `apps/api/src/app.ts`: `GET /api/admin/t/:slug/extraction/methods`,
   `POST .../extraction/methods` (register), `POST .../extraction/profile`,
   `POST .../extraction/compare` (SSE), `PUT .../extraction/rules`,
   `POST .../extraction/reingest` (SSE); `/resources/upload` applies the rules.
7. `apps/web/src/api/client.ts`: typed calls and SSE helpers for the above.
8. `apps/web/src/pages/tools/ExtractionLab.tsx` + Tools page card: Profile, Compare, Route
   panels; page render beside text; tables rendered as tables; a cost line before any vision run.
9. `apps/web/src/pages/admin/ExtractionPanel.tsx` + Manage tab: methods on the box (live),
   rules editor, corpus buckets, re-ingest with confirmation.
10. The corpus loader script: read rules from the portal config and set
    `X-Extract-Strategy` per file; `profile` and `reingest --class image-only` commands.
11. `docs/EXTRACTION-LAB.md` build notes, help page entry.

**Verify:** gate green after each step; on the sandbox box only, register the three methods and
read them back (`GET /extract_strategies` must show the `vllm_config` and `ai_tables` shapes as
sent); upload PMC8960314's data sheet with each header and confirm three distinct extractions;
run the judge once and read the score; headless screenshots of the three panels and the Manage
panel in light and dark at desktop and 390 px; the before/after ask on PMC9716332.

**Risks:** the `ai_tables` body shape is unverified (register one and read it back before building
the UI on it); vision cost and time (cap pages, show the estimate before running, never batch a
whole corpus from the lab); judge reliability (show the page render beside the score so a human
can disagree); sandbox isolation (a lab upload must never touch the production box, enforced by
the binding, not by convention); the 125-page vision failure (`visualPageCap`, default 60, routes
long scans to default); poppler absent on some hosts (fallback to platform text with a notice).
