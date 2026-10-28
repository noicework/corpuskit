# Portal evaluations and isolation evidence

Manage > Evaluations lets a portal administrator save a question bank and run it through that
portal's existing HTTP search and ask handlers. The provider, intent routing, trust layer, daily
ask cap and request auditing are the same ones used by readers. It works with the local server
and the managed runtime. Tests use the DoubleProvider only; no deployment was contacted to
implement or verify this capability.

## Defining and running a set

Each set has a name, retrieval top k (1 to 50), and up to 20 questions. Each question declares
expected resource IDs, optional expected fact phrases, and whether the portal should decline it.
Answerable questions need at least one expected source. Use IDs from this portal's document
responses. A deleted or unavailable expected document remains a useful retrieval regression.

Save edits, choose **Run saved set**, and confirm its maximum ask count. Each question calls
search and ask once; the ask path counts towards the portal's daily cap. The confirmation includes
the saved revision, so an intervening edit requires fresh consent. A run is refused before it
starts when the remaining daily cap cannot cover all questions. Concurrent reader asks can still
spend that allowance: every question rechecks the actual quota, and any refused calls appear as
errors, with no fabricated scores. A portal allows one active evaluation run at a time.

Runs have a 100-second overall budget and a 60-second question budget, within the existing
120-second privileged request audit boundary. Questions that fail or exceed the budget remain
visible as errors. A process restart can leave a run marked running; after ten minutes a new run
marks it failed and proceeds. No background continuation or automatic retry spends extra asks.

The history lists each run separately and shows its predecessor for comparison. Each run keeps
a snapshot of its definition, so changes to the question bank or top k can be distinguished from
changes in the portal's answers. CSV downloads contain a row per question and the run ID, time,
expected, retrieved and cited source IDs, scores and errors. Spreadsheet formula cells are escaped.
The application does not store the generated answer prose in evaluation records.

Scores are independent, with no combined pass mark:

- **Retrieval hit rate:** the proportion of measured questions with at least one expected source
  in the search path's first k returned resources. The stored IDs show the actual retrieval depth.
- **Citation precision:** the proportion of distinct resource IDs cited by markers in the final answer that are expected sources
  or have an explicit `verified` signal from the ask path. A retrieved source alone is not verified.
  Run history averages these per-question proportions. CSV also records unresolved citation markers.
- **REMi:** answer relevance, groundedness and context relevance exactly as returned by ask, on the
  existing 0 to 5 scale. Missing metrics remain unmeasured, including when a refusal returns none.
- **Decline correctness:** whether a completed response's refused flag agrees with the question's
  expected behaviour, for both answerable and unanswerable questions.
- **Expected fact coverage:** case-insensitive literal phrase coverage after collapsing whitespace.
  This is a review aid, not semantic truth grading. A correct paraphrase may score poorly.

Null means unmeasured, not zero or perfect. Errors are counted separately. A successful retrieval is still measured if ask fails, and
answer quality is still measured if search fails. Unmeasured components are excluded from their
means; review both component statuses and the error count alongside every comparison.

## Optional schedules

A saved set can repeat daily or weekly. Confirming the schedule explicitly authorises up to the
shown number of asks on each occurrence. The managed daily cron and the local daily maintenance
timer dispatch due sets through the same run endpoint. There is no additional cron or environment
variable. The local `LOCAL_SCHEDULER_ENABLED=false` switch also stops evaluations.

Schedules store the creator's directory tenant and object ID, never cookies, tokens, email,
directory roles or groups. They require a **current local administrator assignment** on that
portal, or a current local platform assignment. A role supplied only by directory claims cannot
create a schedule. Current local assignments are resolved again at execution and at each inner
request. Revocation, a disabled or paused portal, or an edited definition stops scheduled work.
After editing, confirm the schedule again. Due checks claim each occurrence synchronously, so
overlapping maintenance calls do not duplicate a run. An exhausted cap records a failed occurrence
and waits until the next period; it does not retry later that day. Schedules run on the first daily
maintenance pass after their due time, not at a promised wall-clock minute. Each pass takes at
most three occurrences, oldest due first, to bound work on the managed runtime; a backlog may
delay later occurrences.

## API, permissions and storage

All paths below start with `/api/admin/t/:slug/evaluations` and require portal
`behaviour.write` (portal-admin or above). Portal keys cannot use administration routes.

| Method | Suffix | Behaviour |
|---|---|---|
| GET | none | Sets, schedules without creator identities, daily ask usage and cap |
| PUT | `/:id` | Create or replace a validated definition |
| DELETE | `/:id` | Delete the definition, its schedule and all its runs |
| GET | `/:id/runs` | Latest 100 runs, newest first |
| POST | `/:id/runs` | Run with `{ "confirmedAsks": N, "updatedAt": "saved revision" }` |
| GET | `/:id/runs/:runId/csv` | Download that run's question results |
| PUT | `/:id/schedule` | `{ "everyDays": 1, "confirmedAsks": N, "updatedAt": "saved revision" }`; use 7 for weekly or null to stop |

Definitions, results and scheduling delegations live in `evaluation_sets`, `evaluation_runs`
and `evaluation_schedules`: in `DATA_DIR/rbac.sqlite` locally and in the managed Durable Object's
SQLite database. There are at most 50 sets per portal and 100 retained runs per set. Older runs
are removed when a run starts; definitions and schedules persist until explicitly removed. These
records contain user-authored questions and expected facts, so include them in the portal's data
handling policy. Erasing a deleted portal removes all three tables' records for its slug. The
`evaluations` erased-record kind and `erasedEvaluations` audit count are additions to the hosting
contract and must be recognised by any control plane that validates that inventory.

Writes pass the declared local-mutation audit boundary on both adapters. Evaluation content is
excluded from audit details. Scheduled runs additionally record `maintenance.evaluation.run` with
a system actor and the set ID. The existing audit retention policy applies to these audit records.

## Isolation proof and later deployment check

`e2e/portal-isolation.test.ts` plants different unpredictable marker documents in two portals of
one DoubleProvider, then checks each portal's search, ask, catalogue, document detail, MCP search,
MCP ask, MCP catalogue, MCP document and explicitly scoped estate ask. Positive controls require
its own marker on every surface; negative assertions reject every other portal's marker. Foreign
document IDs are also attempted directly and through MCP. The question never contains a marker,
so reflected question text cannot create a false leak.

The agent ask route is being built independently and is absent from this base branch. The test
activates its separate agent case when a declared POST `/agent…/ask` route is present. Until then
that case is explicitly ignored. Integration must run it against the agreed agent route and input
contract before claiming agent isolation. Estate asks naming multiple authorised portals are
intentionally allowed to include those portals; the isolation test selects only the viewing portal.

`apps/api/scripts/isolation-check.ts` is a deliberately non-executed deployment script. It has
not been run. Later, an authorised operator can use dedicated test portals and short-lived,
authorised test sessions with content management rights. It creates marker documents, waits for
indexing, checks the same positive and negative surfaces, and deletes its documents in `finally`.
It makes real ask calls, which consume the configured daily caps. Do not use production research
portals for this check without an agreed test window. Keep its configuration file outside this
public repository, with owner-only file permissions:

```json
{
  "baseUrl": "https://portal.example.test",
  "portals": [
    { "slug": "fisheries-research", "cookie": "short-lived test session cookie" },
    { "slug": "soil-research-hub", "cookie": "short-lived test session cookie" }
  ],
  "agentAskPath": "/api/t/:slug/agent/ask"
}
```

After confirming the deployed agent route and its request shape:

```sh
deno run --allow-net --allow-read apps/api/scripts/isolation-check.ts \
  --execute --config=/private/path/isolation.json
```

The explicit `--execute` flag is mandatory. Never paste sessions into a shell command, log or
issue. Review any reported cleanup failure before removing the private configuration file.
