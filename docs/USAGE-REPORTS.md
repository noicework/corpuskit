# Usage reports

A portal administrator can export one portal's usage for a calendar month: how many questions
people asked each day, how many the collection answered, the knowledge gaps, how well the answers
were grounded, the answers readers marked unhelpful, the documents added and how quickly the
portal answered. It also reports citation topics, document evidence coverage, reader opens, search latency and provider-reported answer tokens. The report comes as a CSV for spreadsheets and as a printable page, from the same
numbers.

In the portal, open **Manage > Insights** and find **Monthly usage report** below the Insights
panel. Choose a month, then **Download CSV**, or **View report** and **Print report**. The month
list offers the current month and the 23 before it, and starts on the month just ended. The panel
appears only to people who can export it.

## The route

```
GET /api/admin/t/:slug/insights/usage?month=YYYY-MM
GET /api/admin/t/:slug/insights/usage?month=YYYY-MM&format=csv
```

- **Permission:** `audit.export` at portal scope, so portal administrators, platform
  administrators and owners. Curators, analysts, viewers, data keys and anonymous visitors are
  refused before anything is read. The report is an accountability record of the portal's use and
  is exported like the audit log (see [RBAC](RBAC.md)). Each read is audited as
  `request.privileged`, and emergency access works as it does for the other administration routes.
- **Parameters:** `month` is required, as `YYYY-MM`, and may not be later than the current month
  in the portal's timezone. `format` is `json` (the default) or `csv`. A missing or malformed
  month, a later month, another format, a repeated parameter or any other parameter answers
  `400 {"error": "invalid_request"}`.
- **JSON** is the report the printable page renders: `slug`, `month`, `timezone`, `generatedAt`,
  `through` (the last day included), `inProgress`, `days` (one entry per day), `totals` and
  `coverage` (below). The shape is `UsageReportSchema` in `packages/core/src/usage-report.ts`.
- **CSV** is `text/csv; charset=utf-8`, saved as `usage-<slug>-<month>.csv`.
- Both are sent with `Cache-Control: private, no-store`.

## Days and the timezone

Days are calendar days in the portal's `timezone` (an IANA name such as `Australia/Melbourne`,
set in the portal configuration). A portal that states none, or one the runtime does not
recognise, is counted in UTC, as its other dates are. A question asked at 01:00 on 1 October in
Melbourne counts on 1 October, although it was still 30 September in UTC. While a month is in
progress the report runs to today.

## Columns

| Column | What it counts |
|---|---|
| `date` | The calendar day in the portal's timezone as YYYY-MM-DD; the row named total covers the whole month |
| `questions` | Research questions asked in the portal's assistant that day; a question asked across several portals counts in each portal it searched; help questions are not counted |
| `answered` | Questions answered with at least one cited source |
| `unanswered` | Questions the collection could not answer: declined or failed answers and answers without a cited source |
| `weakly_grounded` | Answered questions with a groundedness score of 2 or less out of 5 |
| `knowledge_gaps` | Unanswered plus weakly grounded questions; the questions Insights lists as knowledge gaps |
| `scored_answers` | Answered questions that received a groundedness score |
| `average_groundedness` | The mean groundedness score of scored answers from 0 to 5 to one decimal place; it measures how well the cited passages support each answer; blank when no answer was scored |
| `ratings` | Readers' helpful and unhelpful ratings received that day for answers this portal gave |
| `unhelpful_ratings` | Ratings received that day that marked an answer unhelpful |
| `documents_added` | Library documents added that day that the knowledge box still holds; drafts and help pages and failed imports are not counted |
| `timed_answers` | Answered questions whose response times the portal server measured; it has measured them since the release that added these columns |
| `first_token_p50` | Median seconds from the portal server receiving a question to sending the first words of its answer; over timed answers |
| `first_token_p90` | The 90th percentile of the time to first token in seconds |
| `first_token_p95` | The 95th percentile of the time to first token in seconds |
| `answer_time_p50` | Median seconds from the portal server receiving a question to finishing its answer; over timed answers |
| `answer_time_p90` | The 90th percentile of the answer time in seconds |
| `answer_time_p95` | The 95th percentile of the answer time in seconds |
| `generation_timed` | Answered questions with a generation time reported by the knowledge box |
| `generation_time_p50` | Median seconds the knowledge box reports spending to generate an answer; it leaves out the portal's own routing and checks and the network to the reader |
| `generation_time_p90` | The 90th percentile of the generation time in seconds |
| `generation_time_p95` | The 95th percentile of the generation time in seconds |
| `notes` | Why cells in the row are blank: the records for that day are past their retention period or could not be read |

The groundedness score is the knowledge box's own answer-quality measure, recorded with each
answer. The definitions live in `USAGE_COLUMNS` (`packages/core/src/usage-report.ts`), which the
CSV and the printable report share. The additional metrics are described below. Questions put to the portal by AI assistants over
MCP are not in the ask log, so they are not counted.

## Response times

The response time columns are percentiles: each day's row gives that day's, and the `total` row
gives the month's, over every timed answer in it (not an average of the days). They are
nearest-rank percentiles, the smallest time at or above the given share of answers, to a tenth of a
second. Only answered questions are timed, since a declined question returns quickly and says
nothing about answering. The printable report shows the month's figures in a table of their own.

| Measure | Measured by | Since |
|---|---|---|
| Time to first token (`first_token_*`) | The portal server, from receiving the question on `POST /api/t/:slug/ask` to sending the first words of the answer to the reader's stream | The release that added these columns. Earlier answers have none, and `timed_answers` says how many each day has. |
| Answer time (`answer_time_*`) | The portal server, from receiving the question to finishing the answer | The same release |
| Search time (`search_*`) | The portal server, from receiving a successful `GET /api/t/:slug/search` request to preparing its response, including routing and retrieval. Excludes the browser network and the subsequent usage-record write. | This release onwards; errors and non-search routes are excluded. |
| Generation time (`generation_time_*`) | The knowledge box, which reports how long it spent generating each answer. It leaves out the portal's own routing, retrieval retries and answer checks, and the network to the reader. | Every answer the ask log holds |

Not measured:

- **Questions asked across several portals and MCP answers.** Estate asks carry no timings, and MCP
  answers are not in the ask log.
- **The reader's network.** The server's times end when the server sends; the time the words take
  to reach the reader's screen is not seen.

## Retention: blank is not zero

Each source keeps its records for a limited time, and a report never fills a day it no longer
holds with zeros. Such a cell is blank in the CSV (with the reason in `notes`), null in the JSON,
and marked "Not held" in the printable report. The `coverage` object gives, for each source, the
first day it holds in full (`from`), or null when it holds the whole month.

| Source | Columns | What it keeps |
|---|---|---|
| Ask log | `questions` to `average_groundedness` | Asks, search measurements and opens share the insights log. The local server keeps every record. The Durable Object keeps the newest 50,000 records per portal; once it is full, days up to and including the day of its oldest kept ask are blank. |
| Answer ratings | `ratings`, `unhelpful_ratings` | Ratings are kept for 90 days, at most 500 per portal (see [Hosting](HOSTING.md)). A day the window has passed is blank, and once a portal holds 500, so is every day up to its oldest kept rating. A rating counts only while the ask log still holds the answer it rates, as in Insights. |
| Knowledge box | `documents_added` | Read live, newest first: up to 50 pages of 200 documents added since the month began, for at most 20 seconds. A read that stops short leaves the days before it reached blank, and a box that cannot be read leaves the whole column blank. Documents deleted since are not counted. |

The day a source's record begins is counted as not held, since part of it may be missing. Totals
add up the days a source holds; the `total` row's note says when that is only part of the month.

## Knowledge gaps in Insights

Insights lists the month's top knowledge gaps for the people who curate the portal: the ten
questions asked most this month (in the portal's timezone) that the collection could not answer, or
answered with a groundedness score of 2 or less, with how often each was asked, how many of those
went unanswered or were weakly grounded, and when it was last asked. Questions that differ only in
case, spacing or closing punctuation count as one, shown in their latest phrasing.

Question text can hold personal data, so this list is shortened to 160 characters a question,
returned only by `GET /api/admin/t/:slug/insights` (`content.write`: curators and portal
administrators), and never included in the usage report or any export.

The current month's **Top topics**, **Evidence coverage by topic**, **Reader opens** and
**Answer consumption and search latency** cards use the same aggregations as the monthly report.
Curators can read these cards with `content.write`; exporting still needs `audit.export`.
`knowledgeGaps.topics` stays null because an unanswered question has no citation topic. The new
topic counts describe cited answers, not the subject matter of unanswered questions.

## What the report leaves out

The report holds counts only. Question text and readers' comments can hold personal data, so they
are never exported. The topics of unanswered questions are not inferred from their text. Only the topics of documents actually cited in final answers are counted. Curators can read the unanswered questions themselves
under **Knowledge gaps** in Insights.

## The CSV file

The file opens with comment lines that begin with `#`: the portal, month, timezone and time the
report was generated, which days each source holds, and each column's definition. They contain no
commas or double quotes, so a spreadsheet shows each one in a single cell, and CSV readers can skip
them (`pandas.read_csv(path, comment='#')`, or `read.csv(path, comment.char = '#')` in R). Then
come the heading row, a row per day and a `total` row. Every cell is quoted, and a value that a
spreadsheet would read as a formula is prefixed with `'`, as in the audit export.

This abbreviated example omits the additional topic, open, search and token columns described below.

```
# CorpusKit usage report
# Portal: marine
# Month: 2026-07
# Timezone: Australia/Melbourne
# Generated: 2026-10-28T03:00:00.000Z
# Questions and answers: held for every day
# Ratings: kept for 90 days and at most 500 per portal; held from 2026-07-31; earlier days are blank
# Documents added: read for every day
# Response times: time to first token and answer time are measured by the portal server for each answered question and recorded from this release on; generation time is the knowledge box's own report; search times are measured from request receipt to response preparation on the server; percentiles are nearest-rank
# Topics of unanswered questions are not recorded; question text is left out because it can hold personal data
#
# Columns
# date: The calendar day in the portal's timezone as YYYY-MM-DD; the row named total covers the whole month
...
"date","questions","answered","unanswered","weakly_grounded","knowledge_gaps","scored_answers","average_groundedness","ratings","unhelpful_ratings","documents_added","timed_answers","first_token_p50","first_token_p90","first_token_p95","answer_time_p50","answer_time_p90","answer_time_p95","generation_timed","generation_time_p50","generation_time_p90","generation_time_p95","notes"
"2026-07-30","12","10","2","1","3","9","4.1","","","1","10","1.8","3.2","3.9","7.4","12.6","14.0","10","5.9","10.8","12.1","ratings past retention"
"2026-07-31","8","8","0","0","0","8","4.4","3","1","0","8","1.6","2.7","2.7","6.9","11.2","11.2","8","5.5","9.4","9.4",""
"total","312","281","31","17","48","270","4.2","3","1","24","281","1.7","3.1","3.8","7.1","12.2","13.9","281","5.8","10.5","11.9","rating totals from 2026-07-31"
```


## Citation topics and evidence coverage

Each final research answer keeps the resource id, citation rank and topic ids of the documents it
cited, taken from provider source metadata. The `topics` column is a quoted JSON array per day and
for the month, with `id`, `label`, `questions`, `citedDocuments` and `totalDocuments` for each topic.
A question citing two topics counts once in each. Repeated citations in the same topic do not add
another question. Unanswered questions have no citation topic.

Evidence coverage is the number of **distinct currently held documents cited at least once in the
period**, against **all documents the topic currently holds**. The denominator is a current
catalogue snapshot, not the historical size at month end. Documents removed since the answer do
not inflate the numerator; multiple questions citing the same document still count one document.
This measures use of the collection, not answer quality, completeness of the research or coverage
of unanswered questions. A catalogue that cannot be read in full gives null document counts, including one that reaches the provider’s 8,000-document reader cap without proving the inventory ended. A capped listing is never treated as the whole topic.

Earlier asks have no citation metadata. Topic, coverage, click-through and search measurements
start with this release and are not backfilled. A historical zero for these measures means no
recorded activity, not proof that no reader used that topic. The log's retained days and partial
month notes apply to these figures too.

## Anonymous reader opens

`POST /api/t/:slug/events/open` needs `portal.read` on that portal and accepts JSON with exactly
one of `answerId` or `searchId`, plus `resourceId` and a one-based integer `rank` (1 to 1000).
The opaque source id comes from the server's answer `done` event or search JSON response.
The source and resource/rank pair must have been returned by this portal in the last 24 hours.
The body is limited to 1 KiB, and extra fields, arbitrary text and cross-site browser requests
are refused. There is no user id, browser id, question text or IP in the stored event.

The endpoint admits 60 requests per address per portal per minute and 600 per portal per minute,
using runtime-trusted addresses only in short-lived in-memory limiter buckets. A 429 carries
`Retry-After`. The web app sends best-effort keepalive beacons when a reader opens a search result
or citation, including keyboard activation and middle-clicks. Blocked or failed beacons can
undercount use. These are interaction counts, never unique reader counts.

`opens` counts accepted opens in the period. `open_rate` is a fraction from 0 to 1: the share of
answers with citations and searches with results **created in that period** that also received
at least one open **in that period**. Several opens of the same answer/search count once in the
rate. An open of an older source contributes to `opens`, but not to the rate's numerator.
`mean_open_rank` is the mean one-based citation or search result rank across accepted opens;
there is no mean when nothing was opened.

Set `analyticsEnabled: false` with `PATCH /api/admin/tenants/:slug` to disable new research usage
recording and ignore beacons (204). This is a behaviour change requiring `behaviour.write` as well
as the route's `appearance.write`, and is audited through the existing configuration boundary.
Absent or true enables recording. Disabling recording does not erase already retained records.

Search/open rows live beside asks under `insights:<slug>` on the Durable Object and in
`DATA_DIR/insights/<slug>.jsonl` locally. The existing `insights` erasure kind removes all three
record types together; no new erased record kind is introduced. Usage mutations are audited with an anonymous actor on
both runtimes, including when a signed-in reader opens a source. Privileged operations and access
denials retain their normal audit policy. The existing answer-evidence boundary persists the
completed answer before releasing its terminal event, so beacon validation can use the kept log
as soon as the reader receives that event.

## Consumption and cost attribution

The additional scalar CSV columns are `searches`, `search_p50`, `search_p90`, `search_p95`,
`opens`, `open_rate`, `mean_open_rank`, `consumption_answers`, `input_tokens` and `output_tokens`.
They appear in daily and monthly totals. Monthly percentiles are calculated over the original
search timings, never averaged from daily percentiles. Units are seconds and percentile rules
match the answer timing columns.

`consumption_answers` counts questions for which the provider reported token consumption.
Input and output tokens are summed separately per portal, including consumption reported for
failed answers and retries. A genuine reported zero remains zero; absent consumption stays
blank/null, including when a provider reports timings alone. The ARAG adapter already requests
`x-show-consumption: true`; this report preserves the consumption it returns. It does not
estimate tokens when the provider supplies none.

This is **portal research-answer consumption**, including estate source answers. It excludes
shared platform hosting and core operations, routing/classification, enrichment, documentation
questions, agent composition and MCP activity. There are no prices or currency calculations in
the open source application. A hosting operator can price these portal token totals separately
from shared core platform costs and other portal-specific services using its own metering and
commercial terms. This report is not a complete hosting invoice or a measurement of those
excluded operations.


## Upgrade and rollback

No dependency or lockfile change is needed. Analytics are enabled by default; set
`analyticsEnabled: false` to stop new usage recording. Existing ask records remain readable and
are never backfilled with inferred topics or estimated tokens. The answer evidence and routing
records retain their separate purposes and retention settings.

The insights log now contains tagged search/open rows alongside asks. A rollback to a build
without this mixed-record reader requires restoring the pre-upgrade insights log, or removing
only the tagged search/open rows in a backed-up copy before restoring that older build. Older
builds cannot safely interpret those rows as asks. Portal erasure removes every record type in
the insights log through the existing inventory.
