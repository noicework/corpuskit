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
| Deleting finished portals and erasing what they stored | [Deleting and erasing portals](#deleting-and-erasing-portals) |

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
| Delete a portal suspended for `OPERATOR_DELETE_AFTER_DAYS` | `POST /api/admin/tenants/:slug/delete-suspended` |
| Erase a deleted portal's records | `POST /api/admin/tenants/:slug/erase` |

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
configured, and portal deletion detaches it. Ordinary deletion requires `owner` and is refused for
operators; the operator can delete only a portal that has stayed suspended for
`OPERATOR_DELETE_AFTER_DAYS` (see [Deleting and erasing portals](#deleting-and-erasing-portals)). Hostnames outside the platform domain are routed by the hosting operator and
registered with the [portal host alias](#portal-host-aliases) routes.

Operator calls are refused on a portal's alias host with `403 operator_not_allowed`, whatever the
route. Use the platform hostname, the Worker's own `workers.dev` hostname or a service binding.
With `UNKNOWN_HOSTS=deny`, list the `workers.dev` hostname in `RESERVED_HOSTNAMES` to keep using
it.

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

The response is
`{ "ok": true, "lifecycle": { "status", "limits", "updatedAt", "suspendedSince" } }`, and
`GET /api/admin/t/:slug/lifecycle` answers the same `lifecycle` object. `suspendedSince` is the
ISO time the portal's current, unbroken suspension began, or `null` when it is not suspended.
Replacing the lifecycle of a suspended portal with another suspended one, to change its limits for
example, keeps that time; any other status ends the suspension, and the next one starts afresh.
It is what the [operator delete](#operator-delete-of-a-suspended-portal) counts from. The body
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
cannot size. Adding a link whose page the portal can fetch and read itself is measured as text,
so it is admitted like any other text.

A link handed to the platform crawler cannot be sized when it is added: the portal has not seen
the content the platform will store. It is admitted holding **provisional bytes**,
`LINK_PROVISIONAL_BYTES` (a whole number of bytes, at least 1; 10485760, 10 MB, when unset or
invalid), so a portal refuses a link it does not have that much room for. A link is measured by
its extracted text, which is far smaller than the files an upload may bring, so the default
bounds all but exceptional documents; a hosting operator can raise or lower it. Once the
platform has settled the resource (`PROCESSED`, `ERROR`, `BLOCKED` or `EXPIRED`), the ledger
measures its extracted text, UTF-8 bytes as for pasted text, and that replaces the provisional
bytes. A status CorpusKit does not know, and a read that fails, leave the provisional bytes in
place. So does a 404 at first, since a knowledge box that has not caught up with a write can
answer one for a moment. A link whose reads have answered nothing but 404 for an hour is gone:
it is settled at 0 bytes. Any other reading starts that hour again, and a link already measured
keeps its measured size whatever its reads answer later.

An add that would fit but for the provisional bytes of links still waiting to be measured is
refused with 503 `{ "error": "links_pending" }`, not with `limit_exceeded`: the portal is not
full, and the add can be tried again once the links are processed. So is a further link while
`maxBytes` is set and 20 crawled links are already waiting. Only an add with no room even
without those links is refused as a limit.

Waiting links are read when they matter: when an add would be refused for `maxBytes` or for
waiting links, the portal reads up to ten of them, those never tried first and then the least
recently tried, and judges the add once more. A usage report reads up to 50, and the link
route's precheck reads them when it would otherwise refuse. The reads run outside the step that
admits adds, so other adds are not held up, and a caller waits at most eight seconds for them.
A read still unanswered after 30 seconds is given up and counts as a failed read. The resource
count an admission waits for is given up after 15 seconds, and the add is then refused with
503 `usage_unavailable`.
Reads never write: every admission on the portal, whether or not it reads anything, records
what earlier reads found. A read the link route's precheck made is not repeated by the add that
follows. Links hold provisional bytes on every portal, limited or not, so links added before a
byte limit is set are judged at their provisional bytes until they are measured.

A link still unprocessed, or unreadable, an hour after it was added is stuck: it stops counting
towards the 20, but it keeps its provisional bytes until it is measured, which happens as soon
as the platform settles it. An add that would fit but for stuck links is refused with 413
`{ "error": "links_stuck" }`: waiting will not make room, and the app asks the curator to have
the hosting operator check the link or raise the storage limit. CorpusKit has no route to
remove a resource. To release a stuck link, the hosting operator deletes its resource on the
platform: an hour of 404s later it holds nothing (see above). Otherwise its bytes can only be
worked around: by raising `maxBytes`, by clearing it (without `maxBytes` provisional bytes are
held against nothing), or by connecting a different knowledge box, which starts a fresh ledger. A
ledger written by an earlier build in a form this build does not recognise is read, never
refused: a link recorded in an unknown form is taken as not yet measured and holds the
deployment's `LINK_PROVISIONAL_BYTES` until it is.

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
  adds or deletes. `bytes` reports stored content only: a link handed to the platform crawler
  (including links a content copy brings over) counts once it is measured (see `maxBytes`
  above), and its provisional bytes, a reservation against the limit, are never reported. A
  report reads links that are due, so repeated reports settle on the measured figure without an
  add. `bytes` is `null` whenever the box holds a resource the ledger cannot size: content that
  was there before the ledger started, content added to the box outside CorpusKit, or a write
  whose outcome could not be sized. Deleting such a resource through the portal brings the
  count back. Content removed outside CorpusKit is not noticed, so `bytes` can over-count until
  that resource's entry is cleared. Replacing a built-in help page keeps its recorded size. Connecting a different knowledge box starts a fresh ledger. A
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
four keys per portal: `portal-lifecycle:<slug>` (status, limits, last activity),
`portal-asks:<slug>` (ask counts in quarter-hour buckets, kept for 32 days),
`portal-capacity:<slug>` (reservations and the byte ledger) and `portal-suspension:<slug>` (when
the current suspension began). The suspension start is kept beside the lifecycle record rather
than in it, so a release from before it was tracked still reads the lifecycle. Such a release
ignores the suspension record and does not update it, so once the lifecycle has been replaced
without it the record no longer applies. A suspended portal with no applicable record, including
one suspended before this was tracked, counts its suspension from the lifecycle's last change,
which is never earlier than the suspension really began. The local Deno server keeps the
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
stay stored under the retired slug, where no portal route can reach them, until they are
[erased](#erasing-a-deleted-portal). Its audit events stay in the platform audit log until then
too.

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
| `EXTERNAL_LOGIN_REQUIRE_HOST` | Optional. `true` refuses every assertion without a `host` claim, on platform hosts too (see [Host-bound assertions](#host-bound-assertions)). Only an absent, empty or `false` value leaves it off, so a mistyped value fails closed. Off by default, for issuers that do not send the claim yet; alias and other candidate hosts require the claim either way. |
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
| `host` | Optional, required when `EXTERNAL_LOGIN_REQUIRE_HOST` is on. The hostname the issuer hands the person to. It must equal the hostname `/auth/external` is requested on; case and one trailing dot are ignored. A value that is not a hostname is refused. |

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

### Host-bound assertions

The audience, `WORKER_NAME`, is shared by every host the deployment answers on. Without a `host`
claim, an assertion minted for one host is accepted on any other: an assertion meant for a
[portal's alias host](#portal-host-aliases) could be replayed on a platform host, where the
session it creates shares the platform domain's cookie scope. Whoever controls an alias
hostname's DNS can point it at their own server and collect the assertions sent there, so this is
not only a theoretical risk.

The `host` claim closes it. With `host`, `/auth/external` accepts the assertion only on that
hostname, and anywhere else refuses it with the usual `401 {"error":"external_login_invalid"}`;
the audit record names the reason `host`. A refused assertion is not consumed. An issuer that
knows the claim should always send it, set to the hostname of the handoff URL it redirects to.

On a portal's alias host and on any other candidate host (a hostname outside the platform domain
that is not reserved or a `workers.dev` host, and so may be controlled by a third party), an
assertion without `host` is always refused, so sign-in there needs an issuer that sends it. On
platform hosts, reserved hosts, `workers.dev` hosts and local hosts the claim is optional unless
`EXTERNAL_LOGIN_REQUIRE_HOST` is on.

**Set `EXTERNAL_LOGIN_REQUIRE_HOST=true` on every deployment that registers portal host
aliases,** once its issuer sends `host`. It then refuses every assertion without the claim on
platform hosts too, with the reason `host`, so an assertion collected on an alias host can never
be replayed on the platform. The Durable Object and the local server log a start-up warning while
aliases are enabled and it is off.

### Issuer responsibilities

The handoff is not bound to the browser that began sign-in: CorpusKit issues no state or nonce for
the assertion to echo. An assertion is therefore accepted from any browser that presents it, and
it replaces any session that browser already holds, Entra or external. Someone with an ordinary
account at the issuer could obtain a fresh assertion for themselves and send another person's
browser to `/auth/external` with it. That person would then work as the sender's identity, and
research trails, saved sessions or uploads they create would belong to the sender, who could read
them later. The short lifetime and single-use `jti` do not prevent this, because a new assertion
can be requested on demand. The audience is the Worker's `WORKER_NAME`, so an assertion is valid
for every portal served by that Worker, on every host, unless it is
[bound to a host](#host-bound-assertions).

An issuer that CorpusKit trusts must therefore:

- mint an assertion only as the final step of the person's own interactive sign-in, never through
  an API that returns assertions to a caller;
- deliver it at once by top-level navigation of that same browser to `/auth/external`, for
  example with a `303` redirect, never as a link that can be copied, shared or embedded;
- send the person only to the portal host they started from;
- name that host in the assertion's `host` claim.

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
domain retain host-only cookies, and on alias and other candidate hosts the sessions in them are
sealed to their host (see [Alias and candidate hosts](#alias-and-candidate-hosts)); lookalike
suffixes are never included in the platform cookie scope. The SPA only links across origins to
hostnames within the platform domain, except on a
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
hostnames. The operator routes a hostname to this Worker by whatever means it likes, and registers
it here as one of the portal's aliases. Removing an alias here does not remove the operator's
routing either.

**A deployment that routes hostnames it does not control to this Worker must run with:**

| Setting | Why |
|---|---|
| `UNKNOWN_HOSTS=deny` | A routed hostname that is not registered, or no longer is, answers 404 for everything instead of serving the whole deployment. |
| `EXTERNAL_LOGIN_REQUIRE_HOST=true` | An assertion sent to one host cannot be replayed on another (see [Host-bound assertions](#host-bound-assertions)). |
| `RESERVED_HOSTNAMES` | Lists the deployment's own hosts outside the platform domain, such as other custom domains and the `workers.dev` host, so they are served in `deny` mode and can never be registered as a portal's alias. |

The Durable Object and the local server log a start-up warning in each of these cases:

- aliases are enabled (`MAX_PORTAL_ALIASES` above 0) and external sign-in is configured without
  `EXTERNAL_LOGIN_REQUIRE_HOST`;
- `UNKNOWN_HOSTS` is `serve` while aliases are enabled or any alias is registered (set
  `MAX_PORTAL_ALIASES=0` on a deployment that uses no aliases);
- a reserved hostname still carries an alias record (see [Reserved hostnames](#reserved-hostnames)).

### Settings

| Variable | Meaning |
|---|---|
| `MAX_PORTAL_ALIASES` | Aliases each portal may have: a whole number from 0 to 100, 5 when unset or invalid. 0 disables new aliases. |
| `ALIAS_CACHE_SECONDS` | How long the Worker remembers a host lookup in each isolate: a whole number of seconds from 0 to 300, 30 when unset or invalid. 0 turns the cache off. |
| `UNKNOWN_HOSTS` | `serve` (the default) or `deny`. With `deny`, a request on any host that is not the platform domain, a platform subdomain, a registered alias or a reserved hostname answers `404 {"error":"not_found"}` with `Cache-Control: no-store`, for pages, API, sign-in and assets alike, before any credential is read. Only an absent, empty or `serve` value (any case) serves unknown hosts, so a mistyped value fails closed. |
| `RESERVED_HOSTNAMES` | Optional, comma-separated hostnames the deployment keeps for itself. Case and one trailing dot are ignored; entries that are not hostnames are ignored. |

### Reserved hostnames

The hosts of `ENTRA_REDIRECT_URI` and `EXTERNAL_LOGIN_START_URL` are reserved too. A reserved
hostname is the deployment's own: it is never registered as an alias (`400 hostname_reserved`),
never looked up by the Worker, and always served, in `deny` mode too. Like a platform host, it
follows `EXTERNAL_LOGIN_REQUIRE_HOST` for the `host` claim and its sessions are not sealed to it.

A hostname can be reserved after it was registered as an alias, for example when it is added to
`RESERVED_HOSTNAMES` or becomes the Entra redirect host. Its DNS may then still be the customer's.
This is a misconfiguration: **remove the alias with `DELETE` first.** Until then:

- The start-up warning names the hostname.
- The API narrows the host to that portal, as on any alias host: other portals, platform routes,
  platform authority and operator calls are refused there.
- Sign-in there is refused. Every route that issues a session (`/auth/external`,
  `/auth/callback` and `/auth/login`) answers `409 {"error":"host_conflict"}` with
  `Cache-Control: no-store` and no cookie, audited as `request.denied` with
  `code: "host_conflict"`, and an assertion sent there is not consumed. The Worker learns of the
  record by looking the hostname up on those routes only; a failed lookup there answers
  `503 host_lookup_failed`. Pages and every other request on a reserved host never wait on a
  lookup.
- The hostname is never the portal's canonical hostname.

A reserved host never reads a session sealed to a host, its own name included. Once the alias is
removed, sign-in there follows the deployment's rules for a reserved host.

### Upgrading

Before upgrading a deployment that answers on hostnames outside its platform domain:

- **List every custom domain outside the platform domain in `RESERVED_HOSTNAMES`.** An unlisted
  one becomes a candidate host: the Worker looks it up (answering 503 when the lookup fails),
  seals its sessions to it (so people sign in once more), requires a `host` claim for external
  sign-in there, and drops `includeSubDomains` from its HSTS. The Worker logs once per isolate
  when a hostname that is neither registered nor reserved reaches the deployment.
- **Self-hosting on a hostname outside `PLATFORM_DOMAIN`** (which defaults to `corpuskit.org`):
  set `PLATFORM_DOMAIN` to your own domain, or list your hostname in `RESERVED_HOSTNAMES`.
  Otherwise it is a candidate host, with the effects above.
- Reserved hosts, `workers.dev` hosts and local hosts keep their sessions and follow
  `EXTERNAL_LOGIN_REQUIRE_HOST`, as platform hosts do.

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
| The hostname is reserved (`PUT` only) | 400 | `{ "error": "hostname_reserved" }` |
| The `PUT` body is not empty, `{}` or `{ "primary": <boolean> }` | 400 | `{ "error": "invalid_request" }` |
| No such portal | 404 | `{ "error": "unknown_tenant" }` |
| The hostname is another portal's alias, or another portal's own hostname | 409 | `{ "error": "hostname_taken" }` |
| The portal already has `MAX_PORTAL_ALIASES` aliases | 409 | `{ "error": "alias_limit" }` |

Updating an alias the portal already has is never refused by the limit. The check that a hostname
is free and the write that registers it happen in one synchronous store call inside the Durable
Object's SQLite transaction, so two concurrent registrations of one hostname, or of a portal's
last free alias, admit exactly one.

**Verify that the customer controls a hostname before the `PUT`,** for example with the hosting
provider's hostname validation. The portal cannot tell who owns a name, and registering one
hands its traffic to the portal.

### Valid hostnames

The hostname in the path is trimmed, lower-cased and loses one trailing dot. It must then be a DNS
name of at least two labels and at most 253 characters, each label made of letters, digits and
inner hyphens, at most 63 characters long. These are refused with `invalid_hostname`:

- IP literals in any spelling, and any name whose last label is numeric or hexadecimal
  (`0x...`), which browsers read as an IPv4 address;
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
  administration (`/api/admin/t/<slug>/...` and `PATCH /api/admin/tenants/<slug>`) work as on
  the platform hosts, and so do `/api/health`, static assets and the SPA shell.
- `GET /api/tenants` lists that portal alone. `GET /auth/me` answers for that portal alone: a
  `?portal=` selection of another portal is ignored.
- **No platform authority.** A third party may control the host's DNS and so hold a session
  harvested there, and nothing legitimate needs platform authority on it. For authorisation and
  in `/auth/me`, a caller's platform role, their platform-scope grants and the portal-admin role a
  platform role implies on every portal are all dropped; only their own grants in this portal
  count, and `effectiveRoles` and `provenance` describe only those. A platform administrator is
  paused out of a suspended portal there like anyone else, and the break-glass passcode
  (`x-admin-passcode`) is ignored.
- Every other portal's pages answer a plain-text 404, and its API
  `404 { "error": "not_found" }`, before any credential is read.
- Platform-scope API routes answer `404 { "error": "not_found" }` too, whoever calls them:
  `/api/admin/tenants`, `/api/admin/overview`, people, groups and platform audit, content
  migration, cross-portal asks, portal deletion, and the portal's own lifecycle, usage and alias
  routes.
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

### Alias and candidate hosts

A candidate host is a hostname outside the platform domain that is not reserved and not a
`workers.dev` host: a portal's alias, or a hostname that routes here without being registered.
A third party may control its DNS. These rules hold on every candidate host, whether or not the
Worker recognises it as an alias, so a slow lookup or a stale cache cannot weaken them:

- **Sessions are sealed to the host.** A session issued there is read on that host and nowhere
  else, and a session issued on any other host, platform hosts included, is not read there. The
  cookie is host-only. Whoever controls the hostname's DNS could collect the cookies browsers send
  to it, but those cookies are worthless on every other host. A session refused because it was
  sealed to another host (or to none, where one is required) is audited as `request.denied` with
  `code: "session_host_mismatch"` under the session's own identity, at most 10 records per client
  address a minute; the request carries on unauthenticated.
- **External sign-in assertions must name the host.** `/auth/external` refuses an assertion
  without a `host` claim there, whatever `EXTERNAL_LOGIN_REQUIRE_HOST` says (reason `host`).
- [External sign-in](#external-sign-in-handoff) returns to a same-origin path only, so `returnTo`
  cannot send a person to another host.

On every host outside the platform domain, candidate, reserved or other, **HSTS never includes
subdomains**: answers send `Strict-Transport-Security: max-age=63072000`, because the host may be
a customer's apex domain whose other hosts are not this deployment's to secure. Only platform
hosts send `includeSubDomains`.

Entra sign-in is never offered on an alias host (the redirect URI's host is reserved, so it can
never be one): the host reports `entraEnabled: false`, refuses `/auth/login` with
`503 microsoft_sign_in_not_configured`, and reads no Entra session cookie. A hosting operator
that uses external sign-in should send each person back to the host they started from, naming it
in `host`, as [its responsibilities](#issuer-responsibilities) already require.

### Lookup, caching and consistency

The Durable Object holds the alias records and is authoritative. The Worker looks up every host
that could be an alias, that is every valid hostname outside the platform domain that is not
reserved or a `workers.dev` host, and caches each answer, positive or negative, in the isolate
for `ALIAS_CACHE_SECONDS`. Platform hosts, reserved hosts, IP addresses and `workers.dev` hosts
are never looked up.

A lookup that fails or takes longer than one second is never treated as an unregistered host: the
request is answered `503 {"error":"host_lookup_failed"}` with `Cache-Control: no-store` and
`Retry-After: 5`, and nothing is remembered, so the next request asks again. An assertion sent in
that moment is not consumed and still works on retry.

The Durable Object checks every request against its own record of the host as well, a reserved
host's included: in `deny` mode it refuses an unknown host itself, and it applies the Worker's
cached answer only to narrow a request further. So a stale edge answer can send a visitor to the wrong portal's home page, or
keep a newly registered host shut, for up to `ALIAS_CACHE_SECONDS`, but it never serves another
portal's data, and an operator credential is refused as soon as the alias exists. The local
server reads the registry on every request and caches nothing.

### Onboarding and retiring a hostname

In `serve` mode, a hostname that routes here but is not registered is an unknown host: it serves
the whole deployment, every portal's pages and API, under the rules above. So order the steps to
keep that window closed:

1. **To add a hostname,** verify the customer controls it, register the alias (harmless while no
   traffic arrives), and only then route the hostname to the Worker.
2. **To retire a hostname,** remove the route and the hosting provider's custom hostname first,
   and only then `DELETE` the alias.
3. Wait longer than `ALIAS_CACHE_SECONDS` before registering the same hostname for another
   portal. Within that window the hostname can still redirect to the previous portal and serve
   neither portal's data.

With `UNKNOWN_HOSTS=deny` a routed but unregistered hostname answers 404, so either order is
safe; the order above still avoids visitors meeting a 404.

### Lifecycle, audit and storage

Deleting a portal deletes its aliases in the same write, and a deleted portal's hostnames stop
resolving at once. Portal deletion detaches only the portal's own hostname from the Worker.

Every `PUT` and `DELETE` is audited at platform scope with the portal as the target, as
`portal.alias.set` or `portal.alias.remove`, naming the actor (`operator:<OPERATOR_ID>` for the
operator credential):

- A successful change is recorded with `aliasHostname` and `aliasPrimary` (the primary flag the
  alias has after a `PUT`, or had before a `DELETE`), in the same transaction as the change.
- Every refusal is recorded with outcome `denied` and its `code` (`invalid_hostname`,
  `invalid_request`, `unknown_tenant`, `hostname_reserved`, `hostname_taken` or `alias_limit`),
  plus `aliasHostname` when the hostname was valid. A registration refused inside the store,
  because another request took the name or the last free alias first, is also recorded as a
  `failure` of the attempted change.

On Cloudflare the aliases are stored in the Durable Object's `tenants` state row, as an `aliases`
list that appears once a portal has an alias. The local server stores the same list in its
portal registry file (`TENANTS_PATH`). A malformed list fails closed, like the rest of the
registry. Code from before this feature ignores the list: a rollback serves alias hosts as
unregistered hosts, uses each portal's own hostname as its canonical hostname, and drops the list
at its next registry write, so register the aliases again after rolling forward.

### Example: Cloudflare for SaaS

One way to route customer hostnames to this Worker, in the Cloudflare zone that holds the
platform domain, with `UNKNOWN_HOSTS=deny`, `EXTERNAL_LOGIN_REQUIRE_HOST=true` and the Worker's
other hosts in `RESERVED_HOSTNAMES`:

1. Enable Cloudflare for SaaS on the zone and create its fallback origin, for example a proxied
   originless record `fallback.<platform domain> AAAA 100::`. Publish a CNAME target for
   customers, such as `customers.<platform domain>`, that points at the fallback origin.
2. For each customer hostname, add a custom hostname such as `research.example.org`. The
   customer creates `research.example.org CNAME customers.<platform domain>` in their own DNS, and
   Cloudflare validates it and issues its certificate. Validation is the proof of control the
   `PUT` relies on.
3. Register the alias on the platform hostname with the operator credential:

   ```http
   PUT /api/admin/t/<slug>/aliases/research.example.org
   Authorization: Operator <key>
   content-type: application/json

   {"primary": true}
   ```

4. Add a Worker route with the exact pattern `research.example.org/*` for the Worker named by
   `WORKER_NAME`. An exact route per hostname keeps every other hostname in the zone away from
   the Worker.

To retire a hostname, remove the route and the custom hostname, then `DELETE` the alias, and wait
longer than `ALIAS_CACHE_SECONDS` before registering it for another portal.

## Deleting and erasing portals

A hosting operator that promises its customers their data is deleted within a set period after
their portal ends needs two things the owner's delete does not give it: a way to delete a finished
portal without the owner, and a way to remove everything a deleted portal left stored. Three routes
cover the whole path.

| Method and route | Who may call it | What it does |
|---|---|---|
| `DELETE /api/admin/tenants/:slug` | Owner | Deletes a portal ([owner delete](#owner-delete)) |
| `POST /api/admin/tenants/:slug/delete-suspended` | Platform administrator, operator credential | Deletes a portal that has stayed suspended for `OPERATOR_DELETE_AFTER_DAYS` |
| `POST /api/admin/tenants/:slug/erase` | Platform administrator, operator credential | Erases every record a deleted portal left |

The two retention routes need `portal.create` at platform scope and are declared with
`operator: true`, so hosting automation can call them with the
[operator credential](#operator-credential). Neither can reach a live portal that is not
suspended: one deletes only a portal that has been suspended for as long as the deployment
allows, and the other touches only what an already deleted portal left. Portal roles and `ck_`
keys are refused, answers are `private, no-store`, and like every platform route they are not
served on a portal's alias host. Both take an empty body or `{}`.

### Owner delete

`DELETE /api/admin/tenants/<slug>` is unchanged and stays owner-only (see
[Deleting a portal](#deleting-a-portal)). It detaches the portal's own hostname, retires the slug,
removes the portal's host aliases, knowledge box binding and lifecycle records, and revokes its
members, group mappings and data keys. Everything else the portal stored stays under the retired
slug, out of reach of every route, until it is erased.

### Operator delete of a suspended portal

| Variable | Meaning |
|---|---|
| `OPERATOR_DELETE_AFTER_DAYS` | Whole days a portal must stay suspended, without a break, before a platform administrator or the operator credential may delete it: 1 to 36500. Unset or empty turns the route off. Any other value also turns it off, and the Durable Object and the local server log one start-up warning naming the setting, never its value. |

Set it as a Worker variable, or in the local server's environment and restart it.

`POST /api/admin/tenants/<slug>/delete-suspended` deletes the portal exactly as the owner delete
does, when the portal's [lifecycle](#portal-lifecycle-limits-and-usage) status is `suspended` and
its `suspendedSince` is at least `OPERATOR_DELETE_AFTER_DAYS` × 24 hours ago. Exactly that long is
enough. A change to any other status ends the suspension, and the count starts again at the next
one; replacing the limits of a suspended portal does not. The route checks the gate again once the
portal's hostname has been detached, because detaching waits on the hosting provider.

Add `?erase=true` to [erase](#erasing-a-deleted-portal) the portal's records in the same call.
`erase` accepts only `true` or `false`.

```json
200 { "ok": true,
      "domain": { "status": "removed", "hostname": "acme.research.example" }
              | { "status": "not_configured" },
      "erasure": { "slug": "acme", "erased": { ... }, "total": 57 } }
```

`erasure` is present only with `?erase=true`, and has the shape of the erase response below.

| Refusal | Status | Body |
|---|---|---|
| A body that is not empty or `{}`, or `erase` other than `true` or `false` | 400 | `{ "error": "invalid_request" }` |
| `OPERATOR_DELETE_AFTER_DAYS` is unset or unusable | 409 | `{ "error": "operator_delete_disabled" }` |
| No portal serves the slug, including one already deleted | 404 | `{ "error": "unknown_tenant" }` |
| A portal that ships with the deployment rather than one created in it | 400 | `{ "error": "not_removable" }` |
| Not suspended, or not for long enough | 409 | `{ "error": "not_suspended_long_enough", "status", "suspendedSince", "eligibleAt" }` |
| Domain removal is not configured | 503 | `{ "error": "domain_removal_unavailable" }`, as for the owner delete |
| The hosting provider refused to detach the hostname | 502 | `{ "error": "domain_removal_failed" }`, as for the owner delete |

`suspendedSince` and `eligibleAt` are ISO times, or `null` when the portal is not suspended. A
`not_suspended_long_enough` refusal that came after the hostname was detached, because the
lifecycle changed while it was being detached, also carries
`"domain": { "status": "removed", "hostname" }`.

Each call is audited at platform scope as `portal.delete.suspended`, with the portal as the
target: a success with `lifecycleStatus`, `suspendedDays`, `operatorDeleteAfterDays` and
`eraseRequested`, and each refusal as `denied` with its `code` and whichever of those were known.
The deletion itself writes the same records as the owner delete, such as one `assignment.delete`
for each member revoked.

### Erasing a deleted portal

`POST /api/admin/tenants/<slug>/erase` permanently deletes every record stored under the slug of
a portal that has already been deleted, by the owner or by the operator route.

| Kind | What | Durable Object | Local server |
|---|---|---|---|
| `configuration` | An override or disabled flag left in the portal registry | `tenants` row | `TENANTS_PATH` |
| `aliases` | Host alias records | `tenants` row | `TENANTS_PATH` |
| `bindings` | The knowledge box endpoint and sealed service account token | `bindings` row | `BINDINGS_PATH` |
| `lifecycle` | Status, limits, ask counts, capacity ledger and suspension start | `portal-*:<slug>` rows | `DATA_DIR/lifecycle/` |
| `sessions` | Every member's and visitor's saved research sessions, including pre-owner-scope records | `research-v2:…:sessions:` and `session:<slug>:` rows | `DATA_DIR/research-v2/`, `DATA_DIR/sessions/<slug>/` |
| `investigations` | Investigations with their evidence, notes and artefacts | `research-v2:…:investigations:` and `investigation:<slug>:` rows | `DATA_DIR/research-v2/`, `DATA_DIR/investigations/<slug>/` |
| `watches` | Saved searches | `research-v2:…:watches` and `watches:<slug>` rows | `DATA_DIR/research-v2/`, `DATA_DIR/watches/<slug>.json` |
| `sources` | The source registry | `sources:<slug>` row | `DATA_DIR/sources/<slug>.json` |
| `insights` | The ask log, which holds the questions asked | `insights:<slug>` row | `DATA_DIR/insights/<slug>.jsonl` |
| `suggestions` | Setup suggestions | `suggestions:<slug>` row | `DATA_DIR/suggestions/<slug>.json` |
| `enrichments` | Generated enrichments and cached suggested questions | `enrichment_records` rows, `enrichments:<slug>` row | `DATA_DIR/enrichments/<slug>.json` |
| `kgProposals` | The last knowledge graph proposal | Entry in the `kg-proposals` row | Entry in `KG_PROPOSALS_PATH` |
| `branding` | Uploaded logo, hero image and fonts | `branding_assets` rows | `BRANDING_PATH/<slug>-<kind>.<ext>` |
| `routing` | Question routing decisions | `routing_records` rows | `DATA_DIR/routing/<slug>.jsonl` |
| `mcpKeys` | Data key records, revoked ones included | `mcp-keys:<slug>` row | `DATA_DIR/mcp-keys/<slug>.json` |
| `assignments` | Member rows, pending email invitations and group mappings, under any directory tenant | `role_assignments` rows | `rbac.sqlite` |
| `auditEvents` | Every audit event in the portal's scope, and every platform event whose target is the portal, with the member identities and email addresses they carry; open paged audit queries of the portal | `audit_events` rows and their ordering rows | `rbac.sqlite` |

Branding is the only binary data CorpusKit keeps for a portal: on Cloudflare it is stored in the
Durable Object's SQLite database, not in R2 or another blob store, and locally it is files under
`BRANDING_PATH`. Stores that cache records in memory (bindings, enrichments, knowledge graph
proposals and the local portal registry) drop them too.

```json
200 { "ok": true, "slug": "acme",
      "erased": { "configuration": 0, "aliases": 0, "bindings": 0, "lifecycle": 0,
                  "sessions": 12, "investigations": 3, "watches": 1, "sources": 1,
                  "insights": 1, "suggestions": 1, "enrichments": 214, "kgProposals": 1,
                  "branding": 2, "routing": 1, "mcpKeys": 1, "assignments": 0,
                  "auditEvents": 318 },
      "total": 557 }
```

`erased` always lists the kinds above, in that order. Each count is the number of stored records
(rows, files or keys) removed. A store that keeps a collection in one record counts one, so the
same portal can count differently on the Durable Object and on the local server. After an owner or
operator delete, `configuration`, `aliases`, `bindings`, `lifecycle` and the current directory
tenant's `assignments` are usually already zero, because deletion removed them.

| Refusal | Status | Body |
|---|---|---|
| A body that is not empty or `{}` | 400 | `{ "error": "invalid_request" }` |
| The slug is not a retired portal's, including one that never held a portal | 404 | `{ "error": "unknown_tenant" }` |
| A portal serves the slug: a live, seeded or unreadable portal | 409 | `{ "error": "portal_active" }` |
| The stored binding set cannot be read (see [Unavailable bindings](#unavailable-bindings)) | 503 | `{ "error": "binding_storage_invalid" }` |

Each refusal of the first three kinds is audited as `portal.erase` with outcome `denied` and its
`code`. With unreadable binding storage nothing is erased, because a binding for the portal might
remain; repair the storage and call it again.

Erasure is idempotent. Calling it again erases nothing more and answers 200 with every count 0.
On Cloudflare the whole erasure, including its audit line, is one SQLite transaction, so it
happens completely or not at all. The local server removes the files first and then commits the
database part with the audit line, so a failure part-way leaves some files removed and no audit
line; call it again to finish.

### What is kept

- **The retired slug**, in the portal registry's `retired` list, so the slug is never given to
  another portal. The one exception is a demo Worker's own seeded portals (see
  [Deleting a portal](#deleting-a-portal)), which are live again after a restart and so cannot be
  erased.
- **The erasure's own audit records.** Each erase call records one `portal.erase` line at
  platform scope with the portal as the target: the actor, the time and a count for each kind
  (`erasedSessions`, `erasedAuditEvents` and so on, and `count` for the total), never what was
  erased. The request that erased it keeps its other records too: its `request.privileged`
  records, and the `local.mutation` records of the stores it changed (on Cloudflare, one
  `erasure.erase` record for the whole transaction). With `?erase=true` so do the deletion's
  records made in the same request. These name the actor, the slug and opaque record ids, never a
  member or any content. A later erase of the same slug keeps the earlier erasures' records.

Nothing else about the portal is kept. Audit events of other portals, and platform events that do
not target this one, are untouched. All audit records, erasure lines included, still age out under
`AUDIT_RETENTION_DAYS` (see [RBAC](RBAC.md)).

### What erasure cannot reach

- **The knowledge box.** It lives with the retrieval provider. Deletion and erasure remove the
  portal's binding to it, not the box and the documents in it; delete the box with the provider
  as part of the same retention job.
- **Point-in-time recovery on Cloudflare.** A SQLite-backed Durable Object can be restored to any
  point in the previous 30 days, so erased rows stay recoverable from that history for up to 30
  days after the erasure. Count that window in the period you promise.
- **Storage below the application on the local server.** SQLite can keep freed pages in the
  database file until they are reused, and filesystem snapshots and backups keep what they
  captured.
- **Everything outside the deployment**: your backups and exports, your logs and the hosting
  control plane's own records. Invocation logs are off in the deployment configurations, so
  request URLs are not logged, but check what your log and telemetry exports retain.

### A retention policy

For a promise such as "a portal's data is deleted within 60 days after the portal ends", with a
28-day grace period in which the customer can still come back:

1. When a portal ends, suspend it:
   `PUT /api/admin/t/<slug>/lifecycle` with `{"status": "suspended", "limits": null, "note": "Portal ended"}`.
   Visitors see the paused screen, nothing is lost, and one call restores it.
2. Set `OPERATOR_DELETE_AFTER_DAYS=28`.
3. Run a daily job over the portals your control plane has marked as ended. For each, call
   `POST /api/admin/tenants/<slug>/delete-suspended?erase=true`:
   - 200: the portal is deleted and erased; keep the counts with your records.
   - 409 `not_suspended_long_enough`: not yet; `eligibleAt` says when. A `status` other than
     `suspended` means someone restored the portal, so take it off the list.
   - 404 `unknown_tenant`: it was already deleted, for example by its owner, or an earlier call's
     answer was lost. Call `POST /api/admin/tenants/<slug>/erase` to be sure; it is idempotent.
4. Delete the portal's knowledge box with the retrieval provider.

The data is then gone from the application within 29 days of the portal ending (28 days of
suspension, plus up to a day until the job runs), and out of Cloudflare's point-in-time recovery 30
days after that: 59 days at most. In general, the period you can promise is at least
`OPERATOR_DELETE_AFTER_DAYS`, plus the job's interval, plus 30 days of point-in-time recovery,
plus whatever your own backups keep.

When an owner deletes a portal themselves, erase it straight away, or on the same schedule. The
deployment does not list retired slugs, so keep your own record of the portals you delete.
