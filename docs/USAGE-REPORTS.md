# Usage reports

A portal administrator can export one portal's usage for a calendar month: how many questions
people asked each day, how many the collection answered, the knowledge gaps, how well the answers
were grounded, the answers readers marked unhelpful and the documents added. The report comes as a
CSV for spreadsheets and as a printable page, from the same numbers.

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
| `notes` | Why cells in the row are blank: the records for that day are past their retention period or could not be read |

The groundedness score is the knowledge box's own answer-quality measure, recorded with each
answer. The definitions live in `USAGE_COLUMNS` (`packages/core/src/usage-report.ts`), which the
CSV, the printable report and this table share. Questions put to the portal by AI assistants over
MCP are not in the ask log, so they are not counted.

## Retention: blank is not zero

Each source keeps its records for a limited time, and a report never fills a day it no longer
holds with zeros. Such a cell is blank in the CSV (with the reason in `notes`), null in the JSON,
and marked "Not held" in the printable report. The `coverage` object gives, for each source, the
first day it holds in full (`from`), or null when it holds the whole month.

| Source | Columns | What it keeps |
|---|---|---|
| Ask log | `questions` to `average_groundedness` | The local server keeps every ask. The Durable Object keeps the newest 50,000 asks per portal; once it is full, days up to and including the day of its oldest kept ask are blank. |
| Answer ratings | `ratings`, `unhelpful_ratings` | Ratings are kept for 90 days, at most 500 per portal (see [Hosting](HOSTING.md)). A day the window has passed is blank, and once a portal holds 500, so is every day up to its oldest kept rating. A rating counts only while the ask log still holds the answer it rates, as in Insights. |
| Knowledge box | `documents_added` | Read live, newest first: up to 50 pages of 200 documents added since the month began, for at most 20 seconds. A read that stops short leaves the days before it reached blank, and a box that cannot be read leaves the whole column blank. Documents deleted since are not counted. |

The day a source's record begins is counted as not held, since part of it may be missing. Totals
add up the days a source holds; the `total` row's note says when that is only part of the month.

## What the report leaves out

The report holds counts only. Question text and readers' comments can hold personal data, so they
are never exported. The topics of unanswered questions are not recorded anywhere: the ask log
keeps each question's text, not a topic. Curators can read the unanswered questions themselves
under **Knowledge gaps** in Insights.

## The CSV file

The file opens with comment lines that begin with `#`: the portal, month, timezone and time the
report was generated, which days each source holds, and each column's definition. They contain no
commas or double quotes, so a spreadsheet shows each one in a single cell, and CSV readers can skip
them (`pandas.read_csv(path, comment='#')`, or `read.csv(path, comment.char = '#')` in R). Then
come the heading row, a row per day and a `total` row. Every cell is quoted, and a value that a
spreadsheet would read as a formula is prefixed with `'`, as in the audit export.

```
# CorpusKit usage report
# Portal: marine
# Month: 2026-07
# Timezone: Australia/Melbourne
# Generated: 2026-10-28T03:00:00.000Z
# Questions and answers: held for every day
# Ratings: kept for 90 days and at most 500 per portal; held from 2026-07-31; earlier days are blank
# Documents added: read for every day
# Topics of unanswered questions are not recorded; question text is left out because it can hold personal data
#
# Columns
# date: The calendar day in the portal's timezone as YYYY-MM-DD; the row named total covers the whole month
...
"date","questions","answered","unanswered","weakly_grounded","knowledge_gaps","scored_answers","average_groundedness","ratings","unhelpful_ratings","documents_added","notes"
"2026-07-30","12","10","2","1","3","9","4.1","","","1","ratings past retention"
"2026-07-31","8","8","0","0","0","8","4.4","3","1","0",""
"total","312","281","31","17","48","270","4.2","3","1","24","rating totals from 2026-07-31"
```
