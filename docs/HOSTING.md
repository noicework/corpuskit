# Hosting CorpusKit

CorpusKit can be run as a hosted service, with one deployment serving portals for several
organisations. This document describes the optional hosting hooks that let whoever runs such a
deployment automate it. Each hook is configured per deployment through its own secrets and
runtime variables, keeps portal data in the deployment's own storage and uses the existing portal
access controls. A deployment that uses none of them behaves exactly as a single-organisation
install.

| Hook | Section |
|---|---|
| Stored knowledge box tokens sealed with a deployment key | [Knowledge box credential encryption](#knowledge-box-credential-encryption) |
| A separate credential for hosting automation | [Operator credential](#operator-credential) |
| Per-portal status, limits and usage | [Portal lifecycle, limits and usage](#portal-lifecycle-limits-and-usage) |
| Sign-in through a trusted outside identity issuer | [External sign-in handoff](#external-sign-in-handoff) |
| The hostname portals and sessions live under | [Configurable platform domain](#configurable-platform-domain) |
| Serving a portal on hostnames outside the platform domain | [Portal host aliases](#portal-host-aliases) |

## Knowledge box credential encryption

Set `BINDING_KEY` to the standard base64 encoding of 32 cryptographically random bytes. The
Cloudflare adapter requires it to connect or replace a knowledge box. The local JSON adapter
also supports it; without it, local startup warns that stored tokens remain plaintext and new
bindings are stored as plaintext.

Each persisted binding token uses AES-256-GCM, a fresh random 96-bit IV, a 128-bit authentication
tag and additional authenticated data `corpuskit-binding-v1:<portal slug>`. Its stored form is
`enc:v1:<base64url iv>:<base64url ciphertext>`, with the authentication tag included in the
ciphertext. Moving a sealed token to another portal, altering it, or supplying the wrong key
fails closed. API responses, audit details, logs and errors never include the token or the key.

On startup with a key, sealed tokens are opened before requests are served. New and replaced
tokens are sealed before they are committed. Tokens already stored as plaintext stay plaintext,
and readable, until the deployment sets `BINDING_KEY_MIGRATE` to `true`; each start with that
setting then seals the remaining plaintext tokens. Sealing waits until every stored token opens
with the configured key, so a well-formed but wrong key never re-seals plaintext under itself.
Migration accepts mixed plaintext and sealed records and is idempotent across restarts; if its
write fails, the records stay readable as before and sealing is retried at the next start.
Environment-provided bindings stay in the runtime secret store.

Without a key on Cloudflare, existing plaintext bindings remain readable and can still be
disconnected. New or replacement bindings return HTTP 503 with `{ "error": "binding_key_missing" }`
before contacting the knowledge box.

### Turning on encryption for existing bindings

Code from before sealing reads a stored token verbatim, so it sends a sealed token to the
knowledge box as if it were the credential, and every portal connected through the admin app
stops working. The release pipeline rolls a release that fails verification back to the version
it replaced, and the first request a new version serves, its health probe, is what starts the
Durable Object. Sealing stored tokens during that window would break every admin-connected portal
on the rolled-back version, while its own checks still pass. So existing tokens are sealed only as
a separate step, after a release that understands sealed tokens has been verified:

1. Release this version, or a later one, and let the pipeline finish verifying it. If
   `BINDING_KEY` is already set, stored plaintext is left untouched; avoid connecting or replacing
   a knowledge box until verification finishes, because a token written then is sealed.
2. If `BINDING_KEY` is not set yet, set it now. New and replaced tokens are sealed from then on.
3. Read `bindingEncryption.plaintext` in the admin overview: it counts stored tokens not yet
   sealed.
4. Set `BINDING_KEY_MIGRATE` to `true`. On Cloudflare, run
   `npx wrangler secret put BINDING_KEY_MIGRATE --name <worker>` and enter `true`; the secret
   upload task never sends it. The new version seals the remaining tokens when it starts.
5. Check that `plaintext` and `unavailable` are both `0`.

A secret change publishes a new version, so from then on the version a failed release rolls back to
already understands sealed tokens. The same order applies to every Worker that stores bindings,
including a demo Worker.

### Unavailable bindings

A stored binding that cannot be opened is withheld; the rest of the deployment keeps working.
This covers a sealed token whose key was removed or changed, altered ciphertext, a token moved from
another portal and a record without a usable shape. A withheld binding:

- reports `"status": "unavailable"` from `GET /api/t/<slug>/knowledge-box` and in the admin
  overview;
- answers requests that need it with HTTP 503 `{ "error": "binding_unavailable" }`;
- never falls back to an environment binding, to its stored text or to another portal's binding;
- can be replaced with `POST /api/admin/t/<slug>/knowledge-box` when the deployment can seal new
  bindings, or removed with `DELETE /api/admin/t/<slug>/knowledge-box`.

If the stored binding set itself is unreadable, every portal reports `unavailable` and answers
`binding_storage_invalid`, and bindings cannot be written or removed until the storage is
repaired, because a write would discard the records that could not be read.

A malformed `BINDING_KEY` (any value other than base64 of 32 bytes) is a deployment fault rather
than a data fault. The Worker answers every `/api/*` and `/auth/me` request, `/api/health`
included, with HTTP 503 `{ "error": "binding_key_invalid" }` until it is corrected. Pages and
static assets are unaffected, and stored bindings are left untouched, so correcting the value
restores them.

### Readiness signals

`GET /api/health` is unauthenticated, so it carries one coarse `bindingsReady` flag. It is always
present on Cloudflare and appears elsewhere only when false. It is false when new bindings cannot
be stored or any stored binding is withheld.

Each row of the authorised `GET /api/admin/overview` includes
`bindingEncryption: { configured, required, writable, error?, unavailable, plaintext }`. `error`
names a deployment-wide cause: `binding_key_missing`, `binding_key_invalid` or
`binding_storage_invalid`. `unavailable` counts withheld bindings, and `plaintext` counts stored
bindings whose token is not sealed. A missing Cloudflare key with nothing stored reports
`{ "configured": false, "required": true, "writable": false, "error": "binding_key_missing", "unavailable": 0, "plaintext": 0 }`.
The overview remains an array for existing clients. A deployment with a key and stored plaintext
also logs one start-up warning with the count, never a portal or a token, until it opts in to
sealing.

### Recovering from a changed or lost key

1. Watch `bindingsReady`, then read `bindingEncryption` and each row's `knowledgeBox.status` in
   the admin overview to find the cause and the affected portals.
2. If the previous key still exists, restore it as `BINDING_KEY`. Withheld bindings open again
   unchanged at the next start.
3. If it is lost, keep or set a new key, then reconnect each `unavailable` portal with a fresh
   service account key, or disconnect it. With `BINDING_KEY_MIGRATE` set, sealing of any
   remaining plaintext resumes at the next start once nothing is withheld.

Keep the key available with your protected backups. This release does not provide automatic key
rotation or re-encryption under a replacement key. Once any token is sealed, a code rollback must
understand the sealed format; do not roll back to a version that treats sealed tokens as
plaintext.

## Operator credential

Set `OPERATOR_API_KEY` to the unpadded base64url encoding of at least 32 cryptographically random
bytes. For example, generate a value locally with
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`, then place it in the deployment's secret
store. Never commit the generated value or include it in logs. `OPERATOR_ID` is an optional
non-secret actor identifier, defaulting to `operator`. It must start with an ASCII letter or
digit, contain only letters, digits, `_`, `.`, `:`, `@`, `/` or `-`, and be at most 151 characters.
It must not contain `://`.
An absent, empty or invalid key, or an invalid identifier, disables the credential. When
`OPERATOR_API_KEY` is present but unusable, or `OPERATOR_ID` is invalid, the Durable Object and
the local server log one startup warning naming the setting (never its value), so a
misconfiguration can be told apart from a caller presenting the wrong key.

Send the credential as `Authorization: Operator <key>`. `Bearer` is reserved for portal data
keys and does not accept an operator key. A wrong, missing or malformed operator credential
returns `401 invalid_operator`; it never falls back to a browser session or break-glass passcode.
Combining the operator scheme with `x-admin-passcode` is refused. Existing browser cookies grant
no additional authority to an operator request.

The Worker and the local server decide the operator credential before platform redirects,
sign-in routes, sessions or static assets. An operator request never reads a session cookie,
whether Entra or [external](#external-sign-in-handoff), and the cookie is removed before the
request is forwarded. A signed-in session, Entra or external, never becomes operator authority,
whatever roles are assigned to it. Sign-in routes, including `/auth/external`, refuse an
authenticated operator with `403 operator_not_allowed`.

The Worker compares the key in constant time, removes it before forwarding, and signs an
`operator` principal with the existing `SESSION_SECRET`-derived principal key. The Durable Object
verifies the signature, deployment audience, configured operator identity and freshness before
using it. The raw operator key never reaches the Durable Object. The local Deno server supports
the same `OPERATOR_API_KEY` and `OPERATOR_ID` environment variables and signs and verifies the
same envelope in process. Operator requests do not create sessions or activate pending member
assignments.

The Worker requires `SESSION_SECRET` with at least 32 bytes and a configured `WORKER_NAME` for
principal signing, even when Entra sign-in is disabled. Local development uses an ephemeral
principal-signing secret when `SESSION_SECRET` is absent. The production local server requires
an explicit secret of at least 32 bytes.

An operator has `platform-admin` authority, never `owner`, and can use only HTTP routes under
`/api/admin/` with `operator: true` in `apps/api/src/permissions.ts`. An authenticated operator on
any other route receives `403 operator_not_allowed`, including portal data routes, authentication
routes, portal deletion, platform membership administration and platform settings. The route
declaration tests validate this explicit opt-in flag.

The current allowlist is:

| Purpose | Method and route |
|---|---|
| Create a portal | `POST /api/admin/tenants` |
| Update portal appearance, search prompt and regional discovery band | `PATCH /api/admin/tenants/:slug` |
| Connect or disconnect a knowledge box | `POST`, `DELETE /api/admin/t/:slug/knowledge-box` |
| Change portal access mode | `PATCH /api/admin/t/:slug/access` |
| List and create portal members | `GET`, `POST /api/admin/t/:slug/members` |
| Remove a portal member | `DELETE /api/admin/t/:slug/members/:id` |
| Read or replace a portal's lifecycle | `GET`, `PUT /api/admin/t/:slug/lifecycle` |
| Read portal usage | `GET /api/admin/t/:slug/usage` |
| Read corpus counters | `GET /api/admin/t/:slug/counters` |
| List, register or remove portal host aliases | `GET /api/admin/t/:slug/aliases`, `PUT`, `DELETE /api/admin/t/:slug/aliases/:hostname` |
| Upload branding | `POST /api/admin/t/:slug/branding/:kind` |
| Migrate content between portals | `POST /api/admin/migrate` |

Create an email assignment with a body such as
`{"subjectKind":"pending-email","subjectId":"reader@example.org","role":"viewer"}`.
The list response returns the assignment identifier used for deletion. Member role changes and
group mappings are separate routes and are not enabled for this credential.

Member assignments created for people who sign in through
[external sign-in](#external-sign-in-handoff) must send `"source":"external"`, for example
`{"subjectKind":"pending-email","subjectId":"reader@example.org","source":"external","role":"viewer"}`.
Operator-created assignments default to `entra` when `source` is omitted, as they do for every
other caller. An external identity can never claim an Entra assignment, so the person would never
gain access through it, and a deployment without Entra refuses such an assignment with
`400 {"error":"invalid_input"}`.

Portal updates accept the appearance fields (`name`, `organisation`, `tagline`, `colours`,
`typography`, `shape`, `textScale`, `density`, `paletteId`) and the behaviour fields
`searchPlaceholder` and `regionalDiscovery`. The regional discovery band on Explore is off unless
a portal opts in: send `{"regionalDiscovery": true}` to show it and `{"regionalDiscovery": false}`
to hide it again. A palette made for one organisation (`listed: false` in
`packages/core/src/palettes.ts`) is refused with `400 {"error":"palette_not_available"}` unless
the portal already uses it.

Knowledge-box connection accepts
`{"endpoint":"https://<region>.rag.progress.cloud/api/v1/kb/<box-id>","token":"<token>"}`
and validates the binding with the provider before saving it. The existing `url` field remains
available; supply exactly one of `endpoint` or `url`.

Portal creation can attach the automatically derived hostname when the domain provisioner is
configured, and portal deletion, which requires `owner` and is therefore refused for operators,
detaches it. Hostnames outside the platform domain are routed by the hosting operator and
registered with the [portal host alias](#portal-host-aliases) routes.

Operator calls are refused on a portal's alias host with `403 operator_not_allowed`, whatever the
route. Use the platform hostname, the Worker's own `workers.dev` hostname or a service binding.

`POST /api/admin/migrate` is declared with `portal.create` (platform-admin) rather than the
owner-only `platform.settings.write`, for every caller, so that the operator can use it. The
route only composes authority a platform-admin already holds: it separately checks
`content.write` on both the source and destination portals, which a platform-admin has on every
portal, and it changes no platform settings. The administration screen still offers the
migration panel to owners only.

The [portal lifecycle and usage routes](#portal-lifecycle-limits-and-usage) are on the list, so
hosting automation can pause, restore and limit a portal and read its usage. The operator holds
platform-admin authority, so a suspended portal does not pause it out. Any other hosting route
must opt in explicitly with `operator: true`; adding a route does not make it
operator-accessible automatically.

Every operator call is audited, including allowed reads and denied attempts. Verified calls use
actor kind `operator` and actor id `operator:<OPERATOR_ID>`, so the default is
`operator:operator`. Credential verification failures use an anonymous actor because their
identity is unproven. Keys are excluded from audit detail, errors and logs. Audit write failure
fails the request rather than permitting an unaudited operation.

Invalid operator credentials, including an operator key sent as `Bearer`, are limited to 60 per
client address per minute. Further invalid attempts from that address within the window receive
`429 rate_limited` with a `Retry-After` header and are not audited individually, so a looping
caller cannot grow the audit log without bound. Verified operator requests are never counted.

Rotate the credential by replacing `OPERATOR_API_KEY` in the runtime secret store and updating
the caller to use the new value. Only one key is accepted; the previous key stops working as
soon as the replacement takes effect. Restart the local server after changing its environment.
Keep `OPERATOR_ID` stable when rotating a key to retain the same audit actor, or change it to
identify a different operator. Remove `OPERATOR_API_KEY` to disable this authentication scheme.

## Portal lifecycle, limits and usage

Each portal has a hosting lifecycle: a status, optional limits, and usage counters. A platform
administrator or owner manages them through three routes, and so can the
[operator credential](#operator-credential). Portal roles cannot see or change them.

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
target; a change made with the operator credential names the actor `operator:<OPERATOR_ID>`. The record holds the new status, each limit that is set, and the note. The note is at
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

Platform administrators and owners are not paused out, and neither is the operator
credential. They can still use and change a suspended portal: they can inspect it, fix its
binding, and restore it.

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
  `usage_unavailable`. If the portal's stored binding is withheld (see
  [Unavailable bindings](#unavailable-bindings)) it answers 503 `binding_unavailable`; the
  lifecycle routes keep working.
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
until it is enabled again. The hosting lifecycle is a separate, platform-level control that
portal roles cannot change. It shows visitors a paused screen rather than hiding the portal.
The two are independent:

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
working. Connecting a different knowledge box or disconnecting one resets the capacity ledger
wherever the binding is written. Replacing or removing a withheld binding always resets it,
because the withheld record cannot show which box the ledger described.

No secret or variable is needed.

### Deleting a portal

`DELETE /api/admin/tenants/<slug>` (owner only) removes the portal, retires its slug and removes
its [host aliases](#portal-host-aliases) in one write, then removes its knowledge box binding and
lifecycle records. Only the portal's own hostname is detached from the Worker; alias hostnames are
left to the hosting operator that routed them. After that it revokes every
member row and group mapping scoped to the portal, each recorded as an `assignment.delete` audit
event, and every data key issued for it. The portal's other records (sources, enrichments, insights,
suggestions, knowledge graph proposals, research sessions, investigations, watches and branding)
stay stored under the retired slug, where no portal route can reach them. Its audit events stay
in the platform audit log.

A new portal never takes a retired slug: `POST /api/admin/tenants` moves on to the next free
slug for the same name (`acme`, then `acme-2`). It also passes over a slug that still has member
rows, group mappings or data keys on record, which covers portals deleted before slugs were
retired. So a new portal, whoever creates it, never inherits access or data from a removed one.

The one exception is a demo Worker (`ENVIRONMENT=demo`), which seeds its own `demo` and `acmd`
portals whenever they have no portal record. Deleting either one there is undone on the next
start: the portal comes back under the same slug with its seeded configuration, and the slug
stays retired, so `POST /api/admin/tenants` still passes over it. The seed first clears every
record the removed portal left stored under the slug (sources, enrichments and cached questions,
insights, suggestions, knowledge graph proposals, research sessions, investigations, watches,
branding and routing decisions), so the seeded portal starts empty. Its members, group mappings
and data keys were already revoked when it was deleted; the revoked key records and its audit
events stay on record. No other Worker seeds portals.

### In the web app

- Signed-in users of a read-only portal see a banner saying so under the navigation.
- A suspended portal shows a paused screen in its own branding, including its uploaded logo,
  to signed-in and anonymous visitors alike. The paused screen shows no sign-in buttons,
  Microsoft or [external](#external-sign-in-handoff). Platform administrators, who are not
  paused out, see the portal with a banner saying it is paused.
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

## External sign-in handoff

A deployment can accept a short-lived, signed identity assertion from a trusted external issuer,
alongside Microsoft Entra sign-in or instead of it. The issuer authenticates the person and sends
their browser to `GET /auth/external?assertion=<compact JWS>&returnTo=<path>`.

Configure the same values in the Worker environment or the local server's `.env`:

| Variable | Meaning |
|---|---|
| `EXTERNAL_LOGIN_ISSUER` | Exact issuer identifier, for example `https://identity.example`. |
| `EXTERNAL_LOGIN_JWK` | JSON Ed25519 public JWK, shaped as `{"kty":"OKP","crv":"Ed25519","x":"<public key>"}`. Never supply the private key. |
| `EXTERNAL_LOGIN_NAME` | Optional sign-in button label. Defaults to `Continue with your organisation account`. |
| `EXTERNAL_LOGIN_START_URL` | HTTPS URL on the issuer that starts sign-in; HTTP is accepted only for localhost development. Optional for the handoff itself, but the portal shows an external sign-in button only when it is set, so an external-only deployment needs it. |
| `WORKER_NAME` | Deployment-specific assertion audience and principal-envelope audience. Local development defaults to `corpuskit`. |
| `SESSION_SECRET` | Random secret of at least 32 bytes, used to seal the normal session cookie and sign the internal principal envelope. |

The Worker and a production local server require `SESSION_SECRET`. For local development only,
an omitted secret uses a randomly generated process key, so sessions end on restart. Replay
identifiers still persist independently in SQLite; restarting does not make an assertion reusable.
The local server serves only `/auth/external` and `/auth/logout` from the `/auth/*` boundary and
reads only external session cookies; its Entra behaviour is unchanged.

External sign-in is off unless both issuer and public JWK are set. Invalid configuration fails
closed. Entra credentials are not required for an external-only deployment. When Entra is also
configured, the portal sign-in gate keeps its Entra button and adds the external button when the
external start URL is configured. Without a start URL, `/auth/external` still accepts valid
handoffs, but people have no button to begin sign-in from the portal.

The external button links to the start URL with one added query parameter, `returnTo`, holding the
portal path the person started from, such as `/t/marine`. Only the path is sent, never the query
string, and any `returnTo` already on the configured URL is replaced. The issuer controls the
subsequent handoff to CorpusKit. To return the person to where they started, it passes that value
back unchanged as the handoff's `returnTo`, which the portal validates again on arrival.

The issuer signs a compact JWS with Ed25519. Its protected header must have `alg: "EdDSA"` and
`typ: "JWT"`. CorpusKit verifies the signature with WebCrypto and validates these claims:

| Claim | Requirement |
|---|---|
| `iss` | Exactly `EXTERNAL_LOGIN_ISSUER`. |
| `aud` | Exactly this deployment's `WORKER_NAME`. |
| `sub` | Stable issuer user id, 1 to 128 characters, with no control characters. |
| `email` | A valid email address, normalised to lower case in the session. |
| `email_verified` | Boolean `true`. |
| `name` | Optional display name. |
| `iat`, `exp` | Numeric dates in seconds. Lifetime is at most 120 seconds; the current time must be within `[iat - 30 seconds, exp]`. |
| `jti` | Unique identifier of at least 16 characters. Accepted once only and retained until expiry has passed. |

Successful verification creates an encrypted session with `provenance: "external"` that expires
eight hours after creation. The identity has `tid: "external"`, `oid: "ext:<sub>"`, the verified
email and optional name. Assertion roles and groups never grant authority. A `303` response
redirects to `returnTo`, which must begin with a single `/` and stay on the same origin. Absolute
URLs, protocol-relative URLs, backslashes, control characters, `.` and `..` path segments
(including percent-encoded forms), other encoded redirect bypasses and characters outside visible
ASCII (percent-encode them) fall back to `/`. An unusable `returnTo` never fails the sign-in; it
only changes the destination.

Assertion replay is checked in the existing SQLite-backed Durable Object, so a token cannot be
reused in another Worker isolate. The local server uses the RBAC SQLite database for the same
single-use check, including across local server restarts. The signed principal envelope accepts
`tid: "external"` only while the feature is configured. Verification failures return only
`401 {"error":"external_login_invalid"}`; the audit log records a safe reason code without the
assertion, signing key or email address, as the `auth.external.denied` action with an
`externalReason` field. As for every audited denial, if that record cannot be written the request
fails with `500 {"error":"audit_write_failed"}`, and no session is issued either way.

These records are capped per client address, as
[invalid operator credentials](#operator-credential) are: each address writes at most one
`auth.external.denied` record a minute. Further failures from that address within the minute
receive the same `401` but are only counted, and the next record written, from any address,
carries that number in a `count` field: the failures refused without a record of their own since
the previous record. A looping caller therefore cannot grow the audit log without bound, while the
log still shows how many attempts failed. The client address is `CF-Connecting-IP` on Cloudflare
and the TCP peer on the local server. It only keys the limit and is never written to the log.
Successful sign-ins are never limited. The limit lives in the Durable Object's or the local server
process's memory, so a restart starts it afresh.

`GET /auth/me` exposes the sign-in origin as `sessionProvenance` and `user.provenance`, preserving
the existing `provenance` array that describes role grants. It also reports `entraEnabled`,
`externalLoginEnabled` (issuer and key are both set) and
`externalLogin: { "name": "...", "startUrl": "..." }` when the external button is configured,
or `externalLogin: null` otherwise. Existing Entra sign-in and its session flow remain unchanged.

### Issuer responsibilities

The handoff is not bound to the browser that began sign-in: CorpusKit issues no state or nonce for
the assertion to echo. An assertion is therefore accepted from any browser that presents it, and
it replaces any session that browser already holds, Entra or external. Someone with an ordinary
account at the issuer could obtain a fresh assertion for themselves and send another person's
browser to `/auth/external` with it. That person would then work as the sender's identity, and
research trails, saved sessions or uploads they create would belong to the sender, who could read
them later. The short lifetime and single-use `jti` do not prevent this, because a new assertion
can be requested on demand. The audience is the Worker's `WORKER_NAME`, so an assertion is valid
for every portal served by that Worker.

An issuer that CorpusKit trusts must therefore:

- mint an assertion only as the final step of the person's own interactive sign-in, never through
  an API that returns assertions to a caller;
- deliver it at once by top-level navigation of that same browser to `/auth/external`, for
  example with a `303` redirect, never as a link that can be copied, shared or embedded;
- send the person only to the portal host they started from.

A later version may bind the handoff to a portal-issued state value, or refuse to replace a live
session that belongs to a different person. Until then these obligations are the protection
against sign-in forgery. People can confirm who they are signed in as in the portal's profile
dialog.

### Logging

Treat the assertion query parameter as a credential. The deployment configurations disable
[Worker invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs),
which otherwise record request URLs, while keeping application logs enabled. Configure any reverse
proxy, request tracing, access logging or telemetry export to omit the handoff query string as
well. The handler sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on both success
and failure.

### Access and assignments

External users receive roles only through local assignments. The `authenticated` access mode
admits signed-in users of the configured Entra tenant only, so on an `authenticated` or
`restricted` portal an external identity sees only what is assigned to it; a `public` portal
remains readable by everyone. In the portal Members screen or
the platform People screen, choose the external identity source when adding a person; the choice
and each row's source appear once external sign-in is configured or an external row exists. The existing
assignment APIs accept `source: "entra" | "external"` and return it with each assignment. For
example, `POST /api/admin/t/:slug/members` accepts:

```json
{
  "subjectKind": "pending-email",
  "subjectId": "reader@example.org",
  "source": "external",
  "role": "viewer"
}
```

Only a verified identity from the same source can claim a pending email assignment, after which
it is rewritten to that person's object id. A preferred username never claims an external
assignment; only the verified email does. Existing rows and requests that omit `source` use
`entra`; an external sign-in can never claim an Entra assignment. Group mappings remain Entra-only.
An external object-id assignment uses the `ext:<sub>` identifier and `source: "external"`. An
Entra object-id or group assignment whose identifier starts with `ext:` is refused, and role
resolution only matches an assignment against an identity from its own source.

A deployment without `ENTRA_TENANT_ID` has no Entra identity that could ever claim or match an
Entra assignment, so the assignment APIs refuse `source: "entra"` there with
`400 {"error":"invalid_input"}`. Requests that omit `source` default to `entra` and are refused in
the same way, so automation must send `source: "external"`. Group mappings cannot be created in
that deployment. When Entra sign-in is not configured, the Members and People forms start from the
external identity source.

### First owner without Entra

`ENTRA_ADMIN_EMAILS` creates the first owners only when Entra is configured. An external-only
deployment creates its first owner with one [break-glass](RBAC.md#break-glass) request. Set
`ADMIN_PASSCODE`, and in production also `ADMIN_BREAK_GLASS=true`, then send:

```http
POST /api/admin/people
x-admin-passcode: <ADMIN_PASSCODE>
content-type: application/json

{
  "subjectKind": "pending-email",
  "subjectId": "owner@example.org",
  "source": "external",
  "role": "owner"
}
```

The assignment activates when that person completes an external sign-in with the same verified
email. After that, the owner manages access from the People screen. In production, remove
`ADMIN_BREAK_GLASS` again unless you want to keep the emergency path available.

### Rollback

The assignment migration runs atomically and preserves existing rows as `entra`. Older binaries
do not understand the `source` boundary and could apply external assignments to an Entra identity.
Prefer a forward fix for this change. Do not roll back to code that ignores `source` while external
assignment rows remain, even if external sign-in has been disabled. A code rollback does not undo
the SQLite migration or remove those rows.

## Configurable platform domain

Set the runtime `PLATFORM_DOMAIN` variable to the deployment's platform hostname, such as
`research.example`. It defaults to `corpuskit.org`. Use a DNS hostname without a scheme, path or
port. Explicitly malformed values return HTTP 503 `platform_domain_invalid` at the Worker
boundary.

Automatic portal hostnames use `<slug>.<PLATFORM_DOMAIN>`. The platform redirect, platform links
in the SPA and shared session-cookie scope derive from the same value. The server injects the
domain into each HTML response at runtime, before the SPA loads, so a single web bundle can serve
different deployments without a rebuild. The same value fills the canonical and share-card URLs of
the app shell, homepage, About page and documentation. Custom hostnames outside the platform
domain retain host-only cookies; lookalike suffixes are never included in the platform cookie
scope. The SPA only links across origins to hostnames within the platform domain, except on a
[portal's alias host](#portal-host-aliases), where links to other portals go to their canonical
hostnames.

Every host under the platform domain shares that one session cookie, and each of them answers
the API routes of every portal. A file that a portal administrator or a knowledge box supplied
must therefore never run as a page there. Branding uploads accept PNG, JPEG and WebP images and
WOFF2, WOFF, TTF and OTF fonts; SVG is refused with HTTP 415 `unsupported_type`, because an SVG
can carry script. Branding assets, including any SVG stored before this rule, are served with
`Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'` and
`Content-Disposition: attachment`. Resource thumbnails carry the same policy. Knowledge box files
carry it too, except PDFs, which need the browser's own viewer. Of the sandboxed files, raster
images, audio and video show in place and everything else downloads. A knowledge box file shows
in place only when its upstream `Content-Type` names exactly one media type, and it is then served
as exactly that type, without parameters (`application/pdf`, not `application/pdf; x=1`). A value
holding a comma, or one that is not a media type, is sandboxed and downloads, because a browser
splits the header on commas and could render a later type, such as `text/html`, in place.

The two seeded showcase portals, and one showcase portal created before hostnames were stored,
receive their `corpuskit.org` hostnames when read on the `corpuskit.org` platform domain only.
On any other platform domain they have no hostname until one is attached, and every new portal,
whatever its slug, gets its hostname through hostname automation.

Configure Worker routes, the domain automation token's zone permissions and the identity
provider's redirect URI for your chosen domain. Changing this variable does not create DNS
routes or rewrite explicitly assigned portal hostnames. Existing sessions on the previous
domain do not transfer to a different domain.

The platform domain may be a Cloudflare zone apex or a subdomain of one. Hostname automation
attaches each new hostname to the Worker script named by `WORKER_NAME` (default `corpuskit`) and
lets Cloudflare place it in the account zone that contains it, then rejects a result for any
other hostname, Worker or zone. Its token needs DNS Edit for that zone and Workers Scripts Edit
for the account. `WORKER_NAME` is also the signing audience, so it must equal the Worker script
name. Before changing it on a deployment that already attached hostnames, list the account's
Worker custom domains: a portal whose hostname is attached to the previous script cannot be
removed (`domain_removal_failed`) until that hostname is detached or moved.

## Portal host aliases

A hosting operator can serve a portal on hostnames outside the platform domain, such as
`research.example.org`. The portal never creates DNS records, certificates or routes for these
hostnames. The operator first routes a hostname to this Worker, by whatever means it likes, and
then registers it here as one of the portal's aliases. Removing an alias here does not remove the
operator's routing either.

### Routes

| Method and route | Body | Answer |
|---|---|---|
| `GET /api/admin/t/:slug/aliases` | None | `{ "aliases": [{ "hostname", "primary", "createdAt" }], "hostname" }` |
| `PUT /api/admin/t/:slug/aliases/:hostname` | Empty, or `{ "primary": true \| false }` | 200 `{ "ok": true, "aliases": [...], "hostname" }` |
| `DELETE /api/admin/t/:slug/aliases/:hostname` | None | 200 `{ "ok": true, "aliases": [...], "hostname" }` |

The top-level `hostname` is the portal's canonical hostname after the call, or `null` when it has
none. `aliases` lists the portal's aliases, oldest first; `createdAt` is an ISO timestamp.

`PUT` is idempotent: registering an alias the portal already has keeps its creation time, and
changes `primary` only when the body gives it. `DELETE` is idempotent too: removing a hostname the
portal does not have, including another portal's alias, is still 200 and changes nothing.

All three routes are hosting control at platform scope, like the
[lifecycle routes](#portal-lifecycle-limits-and-usage). They need `portal.create` at platform
scope (a platform administrator or owner) and accept the [operator credential](#operator-credential).
Portal roles can neither read nor change aliases: a portal administrator who could register one
could claim a hostname the deployment already answers on and take it over for their own portal.
The routes are refused to `ck_` keys, answered `private, no-store`, and stay available while a
portal is suspended, read-only or disabled.

| Refusal | Status | Body |
|---|---|---|
| The hostname cannot be an alias (see below) | 400 | `{ "error": "invalid_hostname" }` |
| The `PUT` body is not empty, `{}` or `{ "primary": <boolean> }` | 400 | `{ "error": "invalid_request" }` |
| No such portal | 404 | `{ "error": "unknown_tenant" }` |
| The hostname is another portal's alias, or another portal's own hostname | 409 | `{ "error": "hostname_taken" }` |
| The portal already has `MAX_PORTAL_ALIASES` aliases | 409 | `{ "error": "alias_limit" }` |

`MAX_PORTAL_ALIASES` is a runtime variable: a whole number from 0 to 100, 5 when unset or invalid.
Updating an alias the portal already has is never refused by the limit. The check that a hostname
is free and the write that registers it happen in one synchronous store call inside the Durable
Object's SQLite transaction, so two concurrent registrations of one hostname, or of a portal's
last free alias, admit exactly one.

### Valid hostnames

The hostname in the path is trimmed, lower-cased and loses one trailing dot. It must then be a DNS
name of at least two labels and at most 253 characters, each label made of letters, digits and
inner hyphens, at most 63 characters long. These are refused with `invalid_hostname`:

- IP literals in any spelling, and any name whose last label is numeric;
- ports, paths, credentials, wildcards and any character outside the label alphabet;
- punycode (`xn--`) and every other label with hyphens in its third and fourth places, and
  unicode names, which are refused rather than converted;
- the platform domain and every name under it, which the platform routes itself;
- `workers.dev` names, which the operator keeps for reaching the Worker directly.

### Canonical hostname

With `"primary": true` the alias becomes the portal's canonical hostname: `hostname` in the portal
configuration (`GET /api/t/:slug/config`) and the portal list (`GET /api/tenants`), used for
canonical and share URLs and for links. Only one alias is primary at a time, so promoting one
clears the others. Deleting the primary alias, or `PUT` with `"primary": false` on it, reverts the
canonical hostname to the portal's own hostname, the automatic `<slug>.<PLATFORM_DOMAIN>` when it
has one; otherwise the portal has none. The automatic platform hostname keeps serving the portal
either way.

### Serving on an alias host

A request whose `Host` is a registered alias reaches that portal only:

- `GET /` answers 308 with `Location: /t/<slug>` and the original query string, as a platform
  subdomain's root does.
- The portal's pages (`/t/<slug>/...`), its API (`/api/t/<slug>/...`) and its portal-scoped
  administration (`/api/admin/t/<slug>/...`) work as on the platform hosts, and so do
  `/api/health`, static assets and the SPA shell.
- `GET /api/tenants` lists that portal alone. `GET /auth/me?portal=` answers for that portal alone.
- Every other portal's pages answer a plain-text 404, and its API
  `404 { "error": "not_found" }`, before any credential is read.
- Platform-scope API routes answer `404 { "error": "not_found" }` too, whoever calls them:
  `/api/admin/tenants`, `/api/admin/overview`, people, groups and platform audit, content
  migration, cross-portal asks, and the portal's own lifecycle, usage and alias routes.
- Platform pages (`/admin`, `/about`, `/docs`, `/home`) answer a plain-text 404.
- The operator credential is refused with `403 operator_not_allowed` and audited, whatever the
  route; a wrong key is refused with `401 invalid_operator` as anywhere else.
- The [lifecycle](#portal-lifecycle-limits-and-usage) applies unchanged: a suspended portal shows
  its paused screen and a read-only one refuses writes.

The SPA calls the API with relative URLs, so it works unchanged on an alias host. The server fills
a `corpuskit-host-portal` shell setting with the portal's slug on its alias hosts and leaves it
empty on every other host. On an alias host the SPA keeps links to its own portal on that host,
and sends links to any other portal to that portal's canonical hostname, or to the platform domain
when it has none. The portal switcher lists only the alias host's portal, because the portal list
does. Platform administration links, which only platform administrators see, lead to the platform
pages, which are not served on an alias host.

### Sign-in on an alias host

`/auth/external`, `/auth/me` and `/auth/logout` behave as on a platform host, with a session
cookie that is always host-only on an alias host: it is never shared with the platform domain or
another alias. [External sign-in](#external-sign-in-handoff) returns to a same-origin path only,
so `returnTo` cannot send a person to another host. Entra sign-in is offered on an alias host only
when `ENTRA_REDIRECT_URI` is on that host; otherwise the host reports `entraEnabled: false`,
refuses `/auth/login` with `503 microsoft_sign_in_not_configured`, and reads no Entra session
cookie. A hosting operator that uses external sign-in should send each person back to the host
they started from, as [its responsibilities](#issuer-responsibilities) already require.

### Lookup, caching and consistency

The Durable Object holds the alias records and is authoritative. The Worker looks up every host
that could be an alias, that is every valid hostname outside the platform domain and
`workers.dev`, and caches each answer, positive or negative, in the isolate for
`ALIAS_CACHE_SECONDS`. That runtime variable is a whole number of
seconds from 0 to 300, 30 when unset or invalid; 0 turns the cache off. Platform hosts, IP
addresses and `workers.dev` hosts are never looked up. If a lookup fails, the Worker treats the
host as unregistered for that request and does not cache the failure.

The Durable Object checks every API request against its own record of the host as well, and
applies the Worker's cached answer only to narrow a request further. So a stale edge answer can
send a visitor to the wrong portal's home page for up to `ALIAS_CACHE_SECONDS`, but never serves
another portal's data, and an operator credential is refused as soon as the alias exists. The
local server reads the registry on every request and caches nothing.

**Operator rule:** after deleting an alias, wait longer than `ALIAS_CACHE_SECONDS` before
registering the same hostname on a different portal. Within that window the hostname can still
redirect to the previous portal and serve neither portal's data.

### Lifecycle, audit and storage

Deleting a portal deletes its aliases in the same write, and a deleted portal's hostnames stop
resolving at once. Portal deletion detaches only the portal's own hostname from the Worker.

Every `PUT` and `DELETE` is audited at platform scope with the portal as the target, as
`portal.alias.set` or `portal.alias.remove`. The record names the actor (`operator:<OPERATOR_ID>`
for the operator credential), `aliasHostname`, and `aliasPrimary`: the primary flag the alias has
after a `PUT`, or had before a `DELETE`. A successful change is recorded in the same transaction as
the change itself. A refused `PUT` is recorded with outcome `failure`.

On Cloudflare the aliases are stored in the Durable Object's `tenants` state row, as an `aliases`
list that appears once a portal has an alias. The local server stores the same list in its
portal registry file (`TENANTS_PATH`). A malformed list fails closed, like the rest of the
registry. Code from before this feature ignores the list: a rollback serves alias hosts as
unregistered hosts, uses each portal's own hostname as its canonical hostname, and drops the list
at its next registry write, so register the aliases again after rolling forward.

### Example: Cloudflare for SaaS

One way to route customer hostnames to this Worker, in the Cloudflare zone that holds the
platform domain:

1. Enable Cloudflare for SaaS on the zone and create its fallback origin, for example a proxied
   originless record `fallback.<platform domain> AAAA 100::`. Publish a CNAME target for
   customers, such as `customers.<platform domain>`, that points at the fallback origin.
2. For each customer hostname, add a custom hostname such as `research.example.org` and let
   Cloudflare validate it and issue its certificate. The customer creates
   `research.example.org CNAME customers.<platform domain>` in their own DNS.
3. Add a Worker route with the exact pattern `research.example.org/*` for the Worker named by
   `WORKER_NAME`. An exact route per hostname keeps every other hostname in the zone away from
   the Worker.
4. Register the alias on the platform hostname with the operator credential:

   ```http
   PUT /api/admin/t/<slug>/aliases/research.example.org
   Authorization: Operator <key>
   content-type: application/json

   {"primary": true}
   ```

To retire a hostname, delete the alias first, then remove the route and the custom hostname, and
wait longer than `ALIAS_CACHE_SECONDS` before registering it for another portal.
