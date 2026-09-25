# Hosting CorpusKit for several organisations

CorpusKit can be run as a hosted service, with one deployment serving portals for several
organisations. This document describes the hooks that let the operator of such a deployment
automate it: controlling each portal's lifecycle and limits, reading its usage, and the other
hosting capabilities described in the sections below. Each hook is optional, and a deployment
that uses none of them behaves exactly as a single-organisation install.

## Portal lifecycle, limits and usage

Each portal has a hosting lifecycle: a status, optional limits, and usage counters. A platform
administrator or owner manages them through three routes. Portal roles cannot see or change
them.

| Route | Purpose |
|---|---|
| `GET /api/admin/t/:slug/lifecycle` | The portal's status, limits and `updatedAt` |
| `PUT /api/admin/t/:slug/lifecycle` | Replace the status and limits |
| `GET /api/admin/t/:slug/usage` | Status, limits and current usage |

All three need `portal.create` at platform scope, are refused to `ck_` keys, and are served
`private, no-store`. They stay available while a portal is suspended, read-only or disabled, so
a portal can always be inspected and restored.

### Setting the lifecycle

```json
PUT /api/admin/t/:slug/lifecycle
{
  "status": "active" | "read_only" | "suspended",
  "limits": {
    "maxResources": 200,
    "maxBytes": 524288000,
    "asksPerDay": 100,
    "agentsEnabled": false
  } | null,
  "note": "optional free text for the audit log"
}
```

The response is `{ "ok": true, "lifecycle": { "status", "limits", "updatedAt" } }`. The body
replaces the whole lifecycle. A portal with no lifecycle record is `active` with no limits.
Every limit field is optional and an absent field means unlimited, so `limits: null` and
`limits: {}` both mean unlimited. Limits are whole numbers from zero upwards. A zero limit is
allowed: `asksPerDay: 0` refuses every ask. Invalid input, including unknown fields, is
refused with 400 `invalid_request`.

Each change is audited at platform scope as `portal.lifecycle.update`, with the portal as the
target. The record holds the new status, each limit that is set, and the note. The note is at
most 1000 characters. A note that contains control characters, bidirectional overrides or text
shaped like a credential (a bearer or operator token, a key, a JWT, a sealed binding, or
`token=`, `password:` and similar) is refused, so it cannot carry a secret into the audit log.

### Statuses

**`active`**: the portal works normally, within its limits.

**`read_only`**: the portal can still be browsed, searched and asked. Every write that changes
the portal's content or configuration is refused with 423 `portal_read_only`: uploads, links
and text, sources and syncs, reingest, purges, label sets, the knowledge graph, agents,
enrichment and suggested-question runs, prompts, search configurations, extraction rules,
appearance, branding and the knowledge-box binding. A copy into the portal (`POST
/api/admin/migrate`) is refused too; a copy out of it is allowed. Scheduled source syncs,
enrichment runs and suggested-question runs stop, and a run already under way stops before its
next model call (see [Runs in progress](#runs-in-progress)). Cached suggested questions are
still served, and no new ones are generated.

These keep working on a read-only portal:

- asks, which still count toward `asksPerDay`
- a signed-in user's own research: saved research sessions, investigations, watches, briefings
  and the other generate routes
- revoking access: removing a member, a group mapping or an MCP key
- tightening the access mode (`PATCH /api/admin/t/:slug/access` from `public` to
  `authenticated` or `restricted`, or from `authenticated` to `restricted`)
- `disable` and `enable`, which keep their own meaning (see below)

Granting or changing access is a configuration change and is refused with 423
`portal_read_only`: adding a member or group mapping, changing a role, creating an MCP key, and
loosening the access mode.

**`suspended`**: every `/api/t/:slug/*` and `/api/admin/t/:slug/*` request from anyone who is
not a platform administrator or owner is answered with 423 `portal_suspended`. That includes
anonymous visitors, every portal role, `ck_` keys and the MCP endpoint, whatever the portal's
access mode. `GET /api/t/:slug/config` answers with the same 423, and its body also carries the
safe sign-in projection (slug, product name, organisation, logo, colours, palette, access
mode) and `"status": "suspended"`, so the web app can draw a paused screen in the portal's own
branding. The projection is built by the same helper as the sign-in screen's, so both name the
same logo. The one exception to the 423 is that logo itself, `GET /api/t/:slug/branding/logo`,
which answers exactly as it would for an active portal, so the paused screen can show it; it is
still refused to anyone who could not read it before. Nothing else is disclosed. The portal
list (`GET /api/tenants`) still shows the portal with its status, and cross-portal asks leave
it out. Scheduled syncs, watches and enrichment runs stop.

Platform administrators and owners are not paused out. They can still use and change a
suspended portal: they can inspect it, fix its binding, and restore it.

A request is judged by who made it for as long as it runs. If a portal is suspended while a
request from anyone else is still writing to it (a source sync, a documentation ingest, a
purge or a content copy, for example), the next knowledge-box write that request makes is
refused with 423 `portal_suspended`. A platform administrator's request in flight carries on.
Enrichment and suggested-question runs write to the portal's own store instead, and stop as
described in [Runs in progress](#runs-in-progress).

Where the status is visible: the full configuration (`GET /api/t/:slug/config`) and each row
of `GET /api/tenants` carry `status`. The safe sign-in projection of a portal that is not
suspended is unchanged and does not include it.

### Runs in progress

Enrichment runs (`POST /api/admin/t/:slug/enrichments/run`) and suggested-question runs
(`POST /api/admin/t/:slug/questions/run`) can each make up to 2000 paid model calls, and they
write their results to the portal's own enrichment store, not to the knowledge box. A run
checks the portal again before each resource, before each model call and before each write.
The run stops at the first check that finds any of these:

- the portal is suspended, unless a platform administrator or owner started the run
- the portal is read-only
- `agentsEnabled` is `false`

A stopped run starts no further model call and writes nothing more. A model call already under
way when the change lands finishes, but its result is not written. Results written before the
change are kept. Each write the run makes to the enrichment store is also checked at the moment
it lands, in the same way as a knowledge-box write. The stream ends with a single event that
names the refusal, in place of `done`:

```json
{
  "type": "error",
  "message": "Stopped after 4 of 8 resources. This portal is paused, so no content can be added or changed.",
  "error": "portal_suspended"
}
```

`error` is `portal_suspended`, `portal_read_only` or `agents_disabled`, the same code the
matching HTTP refusal carries. No per-resource error events are sent for the resources the run
did not reach. Enriching one resource (`POST /api/admin/t/:slug/resources/:id/enrich`) makes
the same checks, and a change during its model call answers with the refusal's status and body
instead of storing the result.

Scheduled enrichment and suggested-question runs make the same checks, with no platform
exception. A scheduled run that stops this way ends that portal's pass: its suggested-question
run is not started, and the other portals are processed as usual. The maintenance job is not
recorded as failed.

### Limits

| Limit | Refused with | Body |
|---|---|---|
| `maxResources` | 413 | `{ "error": "limit_exceeded", "limit": "maxResources", "value": n, "max": n }` |
| `maxBytes` | 413 | `{ "error": "limit_exceeded", "limit": "maxBytes", "value": n, "max": n }` |
| `asksPerDay` | 429 | `{ "error": "ask_quota_exceeded", "limit": n, "resetsAt": "ISO" }` |
| `agentsEnabled: false` | 403 | `{ "error": "agents_disabled" }` |

`value` is the total the refused add would have reached.

**`maxResources`** is checked against the knowledge box's own resource count
(`GET /counters` on the box). The box counts a new resource some time after it is written, so
the portal keeps a reservation for each add it admitted until the count includes it. A
reservation is released when the write fails, and expires after six hours if the box never
counts it. Deletions made through the portal free their slot straight away, before the box has
counted them. Concurrent adds are admitted one at a time, so two requests cannot both take the
last slot.

**`maxBytes`** is checked against the portal's own byte ledger (see `bytes` below). An add
that would take the total past the limit is refused. When the portal cannot know its bytes,
every add is refused with 503 `usage_unavailable` while `maxBytes` is set, rather than being
admitted unmeasured. To add content again, clear `maxBytes`, or remove the resources the ledger
cannot size. A link handed to the platform crawler cannot be sized (the portal never sees the
content the platform stores), so while `maxBytes` is set it is refused with 503
`usage_unavailable` too. Adding a link whose page the portal can fetch and read itself is
measured as text, so it is admitted like any other text.

Resource and byte limits apply to every add: uploads, links, pasted text, source syncs, content
copies, reingest and the built-in help pages. They are checked when the write happens,
including writes made deep inside a compound operation or a scheduled job. Adding a link
checks the limits before the page is fetched. If the knowledge box cannot be counted while a
capacity limit is set, the add is refused with 503 `usage_unavailable` and no upstream detail.

**`asksPerDay`** counts asks on the portal's calendar day in its timezone (`timezone` in the
portal configuration, UTC when unset), and resets at local midnight, including on daylight
saving changes. Every route or tool that makes a paid model call for its caller is limited:

- These count as one ask each: research asks (`POST /api/t/:slug/ask`), help-assistant asks
  (`POST /api/t/:slug/docs/ask`), cross-portal asks (`POST /api/ask-estate`), the MCP
  `answer_question` tool, briefings (`POST /api/t/:slug/generate`), multi-document summaries
  (`POST /api/t/:slug/summarize`) and investigation syntheses
  (`POST /api/t/:slug/investigations/:id/synthesise`).
- These accompany an ask that has already counted, so they do not count themselves, but they
  are refused once the day's asks are spent: question routing (`POST /api/t/:slug/route`),
  sub-questions (`POST /api/t/:slug/subqueries`), source verdicts
  (`POST /api/t/:slug/verdicts`) and follow-up suggestions (`POST /api/t/:slug/followups`).
  The last ask of the day therefore gets no verdicts or follow-up suggestions.

A cross-portal ask counts once on each portal it reaches, and is admitted on every selected
portal or on none. An ask is counted when it is admitted, before its answer streams, so a
refused ask costs nothing upstream. A request that is refused after it was counted, for
example by the per-minute rate limit or because its input is invalid, is given its ask back.
A refused MCP call returns the same body as a tool error.

**`agentsEnabled: false`** refuses the portal's agents: knowledge-box agents (graph extraction
and labellers) and the enrichment and suggested-question generators. The refused routes are
`kg/implement`, `PUT kg/strategy`, graph suggestions, `enrichments/run`, `questions/run` and
`resources/:id/enrich`. Scheduled enrichment and suggested-question runs are skipped, and no
suggested questions are generated on demand. An enrichment or suggested-question run already
under way when agents are disabled stops before its next model call (see
[Runs in progress](#runs-in-progress)). Saving a label set is refused only when saving it
would restart a labeller that carries the set. Every operation that would replace an agent is
refused before its first write, so a refusal never leaves a strategy or labeller half
replaced. Existing knowledge-box agents keep running, and one can still be deleted.

### Usage

```json
GET /api/admin/t/:slug/usage
{ "status": "...", "limits": { ... } | null, "resources": 0, "bytes": 0 | null,
  "asksToday": 0, "asks30d": 0, "members": 0, "lastActivityAt": "ISO" | null }
```

- `resources` is the knowledge box's own resource count, read when the usage is requested. A
  portal with no knowledge box reports `0`. If the box cannot be counted the route answers 503
  `usage_unavailable`.
- `bytes` is the source content the portal has written to its knowledge box: file bytes for
  uploads, and UTF-8 bytes for pasted text, fetched and cleaned pages, copied text and help
  pages. The platform does not report stored source size (its counters report index size,
  which is a different quantity), so the portal keeps this ledger itself. The ledger starts
  the first time the portal observes its knowledge box, and it tracks each resource the portal
  adds or deletes. `bytes` is `null` whenever the box holds a resource the ledger cannot size:
  content that was there before the ledger started, content added to the box outside
  CorpusKit, a link handed to the platform crawler (including links a content copy brings
  over), or a write whose outcome could not be sized. Deleting such a resource through the
  portal brings the count back. Content removed outside CorpusKit is not noticed,
  so `bytes` can over-count until that resource's entry is cleared. Replacing a built-in help
  page keeps its recorded size. Connecting a different knowledge box starts a fresh ledger. A
  portal with no knowledge box reports `0`.
- `asksToday` and `asks30d` count admitted asks on today's local date and on the thirty local
  dates ending today, in the portal's timezone.
- `members` counts the portal's role assignments, including pending email assignments. Group
  mappings are not counted.
- `lastActivityAt` is the time of the most recent successful ask or other successful write on
  the portal, such as saved research or a content change. A refused request is not activity.
  Reads are not recorded, because CorpusKit never writes state on a read, so browsing and
  searching alone do not move it. It is recorded at most once a minute.

### How enforcement works

Enforcement is central, so a new route cannot bypass it by accident:

1. The single route guard in `apps/api/src/app.ts` checks suspension once the caller's
   credentials are verified and before authorisation, so every non-platform caller gets 423.
2. After authorisation it applies read-only mode to every portal route that
   `mutatesPortal()` in `apps/api/src/permissions.ts` classifies as a write. Any portal route
   or MCP tool that is not a read is a write unless it is exempt there. The exemptions are the
   ask and research permissions, the routes that revoke access, the access-mode route (whose
   handler accepts only a tightening) and the `disable` and `enable` routes. The declaration
   test lists the exemptions independently. A caller without the permission still gets 401 or
   403, not 423.
3. Still in the guard, `askUse()` in the same file says whether the route counts toward
   `asksPerDay` or only needs asks to be left. Any non-read portal route or tool with the ask
   or generate permission counts unless it is listed otherwise, so a new paid route is limited
   by default; the declaration test lists the counted and accompanying routes independently.
   The MCP transport checks each tool call again the same way.
4. The guard records whether the caller is a platform administrator or owner for the rest of
   the request. The knowledge-box management provider is wrapped so every write rechecks the
   status at the moment it happens, and a write reaches a suspended portal only while it runs
   for such a request. The same wrapper admits resource and byte usage and refuses agent
   starts. Scheduled jobs use it without the platform exception, so no background job ever
   writes to a suspended or read-only portal.
5. The portal's own stores that long-running work writes to (sources for scheduled syncs, and
   the enrichment store for scheduled and HTTP generation runs) are wrapped by
   `guardPortalWrites()` in `apps/api/src/lifecycle-management.ts`, which checks each write
   the same way. Generation runs also call `assertAgentRunAllowed()` before each model call
   and each write, so a run stops as soon as the portal is paused, made read-only or has its
   agents disabled.

### Relationship to disable and enable

`POST /api/admin/t/:slug/disable` and `enable` keep their existing meaning. They are a
portal administrator's switch that takes a portal offline: a disabled portal is left out of
the portal list and refuses every request except `enable`, even from platform administrators,
until it is enabled again. The hosting lifecycle is a separate, platform-level control that portal roles cannot
change. It shows visitors a paused screen rather than hiding the portal. The two are
independent:

- A portal is usable only when it is enabled and not suspended.
- A portal administrator can still disable or enable a read-only portal, because the two
  routes keep their existing meaning.
- A portal administrator cannot enable a suspended portal, because the request itself is
  suspended. A platform administrator can, but the portal stays paused until its status
  changes.
- The lifecycle and usage routes keep working while a portal is disabled.

### Storage

On Cloudflare, lifecycle state lives in the `PortalDurableObject` SQLite `state` table under
three keys per portal: `portal-lifecycle:<slug>` (status, limits, last activity),
`portal-asks:<slug>` (ask counts in quarter-hour buckets, kept for 32 days) and
`portal-capacity:<slug>` (reservations and the byte ledger). The local Deno server keeps the
same records as JSON files under `DATA_DIR/lifecycle/`. An application built without a
lifecycle store (an embedded or test app) keeps this state in memory for its own lifetime and
writes nothing to disk. Records are kept for every slug the route guard can address (letters,
digits, `_` and `-`, up to 64 characters). A record that cannot be read fails closed: requests
to that portal fail rather than treating it as active or unlimited, the portal list and
cross-portal asks leave it out, and scheduled jobs skip it, while every other portal keeps
working. Deleting a portal removes its records, so a later portal with the same slug starts
fresh. Connecting a different knowledge box or disconnecting one resets the capacity ledger
wherever the binding is written.

No secret or variable is needed.

### In the web app

- Signed-in users of a read-only portal see a banner saying so under the navigation.
- A suspended portal shows a paused screen in its own branding, including its uploaded logo,
  to signed-in and anonymous visitors alike. Platform administrators, who are not paused out,
  see the portal with a banner saying it is paused.
- A portal configuration that cannot be read because of a network fault or a server error is
  retried before the app says access could not be checked; an access or hosting refusal is
  shown straight away.
- The upload, link and text forms explain a resource limit, a storage limit or unavailable
  usage in plain words, and keep what was entered. A source sync that a limit, read-only mode
  or a pause stops says so once, keeps the pages it already added, and ends as a failed sync
  rather than a complete one; a scheduled sync records the same message on the source and
  moves on to the next portal. An ask over the daily limit explains when the limit resets, and
  it does not retry automatically. A refused agent run explains that
  agents are disabled, and it does not sign the user out.
