# Role-based access control

CorpusKit portals can hold research that is not public. This document describes how access is
decided, where identity comes from, how keys and the audit log work, and what changes for an
existing deployment. It covers the authorisation core, principals and assignments, and
enforcement. The administration screens (Access panel, People page, audit viewer) and the
migration runbook are documented when they land.

## Roles

Two scopes, six roles. Roles are cumulative within a scope.

| Scope | Roles, lowest to highest | What each adds |
|---|---|---|
| Portal | `viewer` | browse, search, cited answers |
| | `analyst` | generate briefings and assessments, investigations, exports, watches |
| | `curator` | content, taxonomy, enrichments, knowledge-graph strategy |
| | `portal-admin` | behaviour, appearance, knowledge-box bindings, domains, keys, members, portal audit |
| Platform | `platform-admin` | portal-admin on every portal, create portals, platform audit |
| | `owner` | everything, including deleting portals and managing platform members and settings |

A portal role grants nothing on any other portal. A platform role implies `portal-admin` on
every portal, present and future.

## Permissions

Twenty-two permissions form the catalogue. Every route and every MCP tool declares exactly one
of them, and `authorize(principal, permission, scope)` in `packages/core/src/rbac.ts` is the only
place a decision is made. The full grant table is the `portalMinimumRoles` and
`platformMinimumRoles` maps in that file; the tests in `rbac.test.ts` enumerate every cell.

| Permission | Minimum role |
|---|---|
| `portal.read`, `portal.ask` | viewer |
| `portal.generate`, `portal.investigate`, `portal.export`, `portal.watch` | analyst |
| `content.write`, `taxonomy.write`, `enrichments.write`, `graph.write` | curator |
| `behaviour.write`, `appearance.write`, `bindings.write`, `domains.write`, `keys.manage`, `members.manage`, `audit.read` and `audit.export` at portal scope | portal-admin |
| `portal.create`, `audit.read` and `audit.export` at platform scope | platform-admin |
| `portal.delete`, `platform.members.manage`, `platform.settings.write` | owner |

Portal permissions evaluated against the platform scope are denied, and platform permissions
evaluated against a portal are denied. Malformed input of any kind is denied.

Content migration (`POST /api/admin/migrate`) is declared with `portal.create`, so any
platform-admin can run it; earlier releases required `owner` (`platform.settings.write`). It still
requires `content.write` on both the source and destination portals and changes no platform
settings. The administration screen continues to show the migration panel to owners only.

Deleting a document (`DELETE /api/admin/t/:slug/resources/:id`) is declared with `content.write`,
like the purge of failed crawls and reingest, which already remove resources. It is audited as
`resource.delete`. The MCP server offers no delete tool, and keys are refused on
`/api/admin/*`, so only a signed-in manager deletes. See `HOSTING.md`, "Deleting a document".

The monthly usage report (`GET /api/admin/t/:slug/insights/usage`) is declared with
`audit.export`, not with `content.write` like Insights: it is an accountability record of the
portal's use, exported like the audit log, so curators read Insights but only portal
administrators export the report. See `USAGE-REPORTS.md`.

## Portal access modes

Each portal has an access mode. Existing portals are `public`.

| Mode | Anonymous visitor | Signed-in user of the configured Entra tenant | Other signed-in user |
|---|---|---|---|
| `public` | viewer | viewer, or higher if assigned | viewer |
| `authenticated` | safe metadata only | viewer, or higher if assigned | safe metadata only |
| `restricted` | safe metadata only | only what is assigned | safe metadata only |

Safe metadata is what the sign-in and access-denied views need to draw themselves: the slug,
product name, organisation, logo, colours, palette and the access mode. Counters, facets,
catalogue, suggestions, search, documents, thumbnails and branding bytes are withheld. Fetching
the safe metadata is a normal response, not a denial.

Only `PATCH /api/admin/t/:slug/access` changes the mode. It needs `behaviour.write`, is audited,
and takes effect on the next request; identity-dependent responses are served `private,
no-store` so a cached copy cannot outlive a change of mode.

## Portal list

The portal list (`GET /api/tenants`), which the switcher beside a portal's logo shows, holds the
portals a caller is entitled to, not every portal they could read. A portal is listed when the
caller can read it and one of these holds:

- the caller has platform authority (an owner or platform administrator, or break-glass access),
  which lists every portal;
- the caller holds a role on the portal, assigned to them directly or through a group mapping;
- the portal's canonical hostname is the request's host, compared without regard to case or port.

So a public portal is not listed to an anonymous visitor on the platform domain or on another
portal's host, and on its own hostname it lists itself. A signed-in user of the configured tenant
who holds no role on an `authenticated` portal can still open it, but it is listed to them only on
its own hostname. A list with nothing in it is `200 []`, not a refusal, and is not audited. On a
portal's alias host the list holds that portal alone, as it always has.

A cross-portal ask (`POST /api/ask-estate`) that names no portals reaches the portals in the same
list, and is refused when the list is empty. One that names portals reaches every named portal the
caller may read.

The switcher beside the logo draws nothing, neither its button nor its menu, unless the list holds
a portal other than the current one or the caller can create portals.

## Where identity comes from

1. **Sign-in.** The Worker and single-process Deno server share OpenID Connect against Microsoft
   Entra and seal the verified claims into an encrypted cookie scoped to the platform domain.
   Sessions last up to eight hours. If a token carries so many group ids that the cookie would
   exceed the browser limit, the groups are dropped and the session records `groupStatus: overage`,
   which disables group mappings for that session rather than truncating the list.
2. **Principal envelope.** For every request the Worker forwards to the Durable Object it strips
   any identity headers the caller supplied and, when there is a session, adds one signed header,
   `x-corpuskit-principal`: `{ v, aud, tid, oid, email, name, roles, groups, iat }` plus an
   HMAC-SHA256 tag. The key is derived from `SESSION_SECRET` with HKDF and the info string
   `corpuskit-principal-v1`, so it is never the cookie key. `aud` is the Worker name
   (`WORKER_NAME`), so a signature from one deployment is worthless on another. The Durable Object
   rejects an envelope that is unsigned, over 8 KiB, for another audience or tenant, more than
   sixty seconds old, or more than thirty seconds in the future. No header means anonymous; a
   bad header is rejected, never downgraded.
3. **Effective roles.** Three sources, highest role wins per scope:
   - Entra app roles: `CorpusKit.Owner`, `CorpusKit.PlatformAdmin`, and the earlier
     `CorpusKit.Admin`, which maps to `platform-admin`.
   - Entra group mappings per scope, only when the deployment has verified that group claims are
     emitted; otherwise mappings are disabled and reported as such.
   - Local assignments in the portal's own database, by user object id, or by email. An email
     assignment stays pending until that person signs in from the configured tenant, then it is
     rewritten to their object id. Local assignments are read on every request; Entra claims are
     as fresh as the session, and `/auth/me` reports their age.
   The store refuses to remove or downgrade the last owner.
4. **Keys** (below) are the only other way to hold a role.

`GET /auth/me` returns the session plus `effectiveRoles` (platform role and per-portal roles),
`provenance`, `claimAgeSeconds`, `groupStatus`, `groupMappings`, `coarseAdminEligible` and
`breakGlassEnabled`.

## Enforcement

`apps/api/src/permissions.ts` is the single declaration table: every HTTP route and every MCP
tool maps to a permission and a scope (`portal`, `platform` or `public`). Registration consumes
the table, one guard authorises every `/api` request from the route Hono actually matched before
any handler, provider call or store access runs, and a test compares the table against Hono's
route list and the MCP `tools/list` in both directions. A route that is not declared fails the
test rather than defaulting to allow. The only public entries are `/api/health`, the `/auth/*`
boundary, static assets and the SPA shell, each with a written reason.

Portal scope always comes from the route, never from a body or query field. Objects such as
resources, investigations, sessions, watches, keys, bindings and enrichments are resolved inside
the route's portal before anything is read or changed; a mismatch is an audited 404.

Research artefacts (trails, investigations, watches) belong to the signed-in user by object id
when there is a session, and otherwise to the browser client id on public portals only. The two
namespaces are separate: signing in does not adopt anonymous artefacts, and a key never owns any.

## Keys

Keys let MCP clients and scripts act on one portal.

- Format `ck_` followed by 43 URL-safe characters. Shown once at creation; only a SHA-256 hash is
  stored, with the portal, role, creator, creation time, optional expiry and revocation time.
- Managed at `GET`, `POST` and `DELETE /api/t/:slug/mcp/keys` with `keys.manage` and a signed-in
  session. A key cannot be created above the creator's own role on that portal.
- At every use the effective role is `min(key role, creator's current role on that portal)`. A
  creator who lost access makes the key inert without deleting it. A creator whose authority
  comes only from Entra claims must sign in again once those claims age past the session bound.
- Accepted as `Authorization: Bearer ck_...` on `/api/t/:slug/*` and the MCP endpoint of the
  bound portal, and on the estate MCP endpoint below. Refused on `/api/admin/*`, on other
  portals' routes, after expiry or revocation, and for every management permission: a key is a
  data-plane credential whatever role it carries.
- A key may name an `estate`: up to 19 other portals it also reaches at the estate MCP endpoint,
  and only there. Its creator must administer each of them when it is minted, and on
  each the effective role is again `min(key role, creator's current role on that portal)`, so a
  portal drops out of the key's reach as soon as the creator loses access to it. The key is listed,
  revoked and expires on the portal it was minted on, and revoking it there ends it everywhere.
  A revoked key keeps no estate.
- Keys minted before this release (`ck_mcp_` prefix) keep working as fixed `viewer` keys on their
  portal. They cannot be raised, and the key list marks them as legacy.

## Federated portal MCP tools

`POST /api/t/:slug/mcp` also offers `ask_federated` and `search_federated` when the
portal has `agentAsk: true`, its retrieval provider supports agent ask or composition, and
the caller has `portal.ask`. The tools are absent from `tools/list` otherwise, and direct
calls cannot bypass that check. Existing portal and legacy viewer keys may use them because
viewer includes `portal.ask`; a key still reaches only its bound portal at this endpoint.

- `ask_federated`: `question` (1 to 2000 characters). Runs the same agent answer path as
  `POST /api/t/:slug/ask-agent`: the configured agent, or one answer composed from the host's
  passages and its federation peers. Returns `answer`, `mode`, `sources`, `citations` with
  their `source` attribution, and `failed_sources` with each unavailable source and reason.
  The returned text uses the completed stream's citation-checked final answer.
  An interrupted or failed answer releases no partial answer text.
- `search_federated`: `query` (1 to 2000 characters) and optional `limit` (passages per source,
  default 4, maximum 20). Returns `results` containing passage text and its `source`, plus
  `sources` and `failed_sources`. It makes no generation call and consumes no daily ask.
  A call in which every source fails is an MCP tool error, with those sources still listed.

Both use the host's configured peers and sealed peer keys. Participation, peer document
exclusion and origin-link settings follow [agent ask](AGENT-ASK.md#federation-peers): an
opted-out host searches only its own collection, and excluded peer passages are withheld.
The host may still use its own excluded documents, as its own HTTP agent ask does.
Peer lookups have the same source timeout as HTTP agent ask. A peer's failure does not discard
other sources' results. These tools do not enumerate other hosted portals from an estate key;
use the estate endpoint below to query the key's other hosted portals.

Every call takes the same per-caller and per-address rate budget as HTTP agent ask, including
one additional search for each configured peer. Anonymous calls also take the host's anonymous
portal and address budgets. `ask_federated` counts once toward the host's daily ask limit;
`search_federated` does not. Suspension and read-only rules are checked for each tool call.
Each completed call writes `estate.query` on the host with the actor, tool and source count;
peer lookups also write `federation.peer.call`. Required audit failure withholds the result.
No new retained record kind or secret is introduced.

## Estate MCP endpoint

`/api/estate/mcp` is a Streamable HTTP MCP endpoint over many portals at once, for an agent that
works across a research estate rather than inside one portal. It is stateless, takes `POST`
only, and offers two read-only tools:

- `search_estate` (`portal.read`): `query`, optional `mode`, `limit` per portal (default 5, at
  most 20) and `portals`. Returns one list ranked by relevance, each result tagged with its
  `portal` slug and `portalTitle`.
- `answer_estate` (`portal.ask`): `question` and optional `portals`. Every portal answers from its
  own corpus; each answer carries its `portal`, `portalTitle` and its own verified citations, and
  each citation names its portal too. An answer that is neither refused nor cited is not returned.

Who reaches what is the cross-portal ask's rule (see Portal list): a key reaches the portal it was
minted on and its estate; a signed-in user reaches the portals in their directory. `portals`
narrows a call; a portal outside the caller's reach is left out and never queried, and a call
left with no portal is refused. A caller with no portal at all is refused at the transport, 401
without credentials and 403 with them. Each tool call is authorised again on its own permission.

Each portal is queried at once with its own time limit, `ESTATE_SOURCE_TIMEOUT_MS` (default
25000). A portal that fails, times out, answers without a verified citation, or is unavailable
(suspended, or its asks for the day are spent) is listed in `failed_sources` with its `portal`,
`portalTitle` and a `reason` (`upstream`, `timeout`, `unverified` or `unavailable`), and the rest
still return. When every portal fails the call is a tool error that still names each one.

Every call writes one `estate.query` audit row for each portal it queried, in that portal's own
log, so each portal's administrators see who reached it: the actor (for a key, its id), the tool,
the number of portals in the call, the key's role there and the outcome, with the failure code
for a portal that did not return. A failed audit write fails the request with 500 and nothing is
released. An answer is one ask on every portal it reaches: it counts toward each portal's daily
ask limit, and against the caller's per-minute ask limits once per portal, all admitted or none,
as a cross-portal ask does (see [hosting](HOSTING.md)). Failed bearers count against the same
per-address MCP authentication limit as a portal's own endpoint, before any key is looked up.

In Manage > Access > Keys, a signed-in administrator can select additional **Portals covered**
when creating a key. Only portals they can administer are offered; the current portal is always
included. The key list shows the stored coverage. Revoke the key on its issuing portal to end
access everywhere. As with single-portal keys, its secret is shown once, at creation.

`GET /api/t/:slug/mcp/portals` (`keys.manage`) supplies those choices, including on a portal's
alias hostname. It returns only `{slug, title}` for enabled portals the caller can administer;
it does not broaden the normal portal picker. Issuing an estate key checks `keys.manage` on
every selected portal, in addition to the key's role ceiling.

A key with an estate can also be minted with the portal's key route, by a signed-in administrator:

```http
POST /api/t/<portal>/mcp/keys
content-type: application/json

{"label": "Estate agent", "role": "viewer", "estate": ["<portal-b>", "<portal-c>"]}
```

An MCP client then needs only the endpoint and the key. For example, in a client that reads an
`mcpServers` file:

```json
{
  "mcpServers": {
    "corpuskit-estate": {
      "type": "http",
      "url": "https://<deployment>/api/estate/mcp",
      "headers": { "Authorization": "Bearer ck_..." }
    }
  }
}
```

or with Claude Code:
`claude mcp add --transport http corpuskit-estate https://<deployment>/api/estate/mcp --header "Authorization: Bearer ck_..."`.

The endpoint answers on the platform domain only; on a portal's alias host it is not found.

## Audit log

`audit_events` is append-only: no route updates or deletes it. Each row records the actor, the
action, the scope, the target, the outcome, a request id for correlation and a redacted detail
object that never carries secrets, passcodes, key material, document text or request bodies.

Recorded events include every privileged action (`request.privileged` and the specific
`tenant.*`, `assignment.*`, `audit.*`, `migration.*` and `maintenance.*` actions), every denial
(`request.denied`), and every break-glass use, failure and lockout. Writing the audit record is
part of the request: if the write fails the request fails with 500. For a privileged operation
whose response is built in memory, the completion record is written before the response is
released; streaming responses are buffered up to a fixed cap for the same reason.

Every declared local store mutation on either runtime also records `local.mutation`, including
sources, generated enrichments, suggestions, answer feedback, reader feedback, insights, routing,
knowledge graph proposals and branding. On Deno, the synchronous file write and its required audit completion
form one rollback boundary. See [single-process hosting](HOSTING.md#single-process-mutation-audit).

Read at `GET /api/admin/t/:slug/audit` (portal `audit.read`) or `GET /api/admin/audit` (platform
`audit.read`), export as CSV or JSON from the `/export` siblings (`audit.export`). Retention is
`AUDIT_RETENTION_DAYS` (default 400), applied by the maintenance cron, and the purge is itself
recorded.

The administrative portal bundle at `GET /api/admin/t/:slug/export` also requires portal
`audit.export`. Its `portal.export.bundle` events record the explicit feedback selection.
See [the versioned bundle format](PORTAL-EXPORT.md) for included data and bounds.

## Break-glass

`ADMIN_PASSCODE` no longer opens the whole administration surface. It grants `owner` for a single
request only when the deployment also sets `ADMIN_BREAK_GLASS=true` (exactly that value), and only
when presented in the `x-admin-passcode` header of that request. `ENVIRONMENT` plays no part: a
passcode without the flag does nothing in any environment, and the server logs a start-up warning
saying so, without the value. The browser never stores the passcode and never retries with it.
Every use is audited with the session identity beside it when there is one. Five failures from one
address in ten minutes lock the path for ten minutes.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `SESSION_SECRET` | Worker secret | Cookie sealing and, via HKDF, principal signing. At least 32 bytes. |
| `WORKER_NAME` | `wrangler.jsonc` var | Signing audience: `corpuskit`, `corpuskit-demo`, or the name of another deployment. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Worker | Sign-in. Without them sign-in is unconfigured and every visitor is anonymous. |
| `ENTRA_REDIRECT_URI` | Worker or Deno environment | Public callback URL; required on Deno whenever `ENTRA_TENANT_ID` is set. |
| `ENTRA_ADMIN_EMAILS` | Worker secret | Migrated once, on first boot, into owner assignments. |
| `ADMIN_PASSCODE`, `ADMIN_BREAK_GLASS` | Worker | Break-glass, above. |
| `AUDIT_RETENTION_DAYS` | Worker var | Default 400. |

The Entra app registration needs the `CorpusKit.Owner` and `CorpusKit.PlatformAdmin` app roles
for platform roles to come from Entra; `infra/entra-app-roles.json` is the manifest. Group
mappings need `groupMembershipClaims` set on the registration.

## What changes for an existing deployment

- Nothing for visitors: existing portals are `public`, and browse, search and cited answers work
  as before for anonymous visitors and keyless MCP clients.
- Administrators: anyone in `ENTRA_ADMIN_EMAILS` or holding `CorpusKit.Admin` keeps full access,
  now as an owner or platform-admin assignment. The passcode stops being an everyday credential;
  set `ADMIN_BREAK_GLASS=true` beside it only while you need it as an emergency path.
- Research trails, investigations and watches saved before this release stay readable by the same
  browser.
- Existing MCP keys keep working as viewer keys; mint new keys for anything above viewer.
- Migrations are additive and idempotent: restarting the Durable Object does not recreate a
  removed owner or duplicate an assignment.

## Threat notes

- Header forgery: caller-supplied identity headers are stripped at ingress; only the signed
  envelope is trusted, and it is bound to audience, tenant and time.
- Stale authority: local assignments are authoritative per request; Entra claims age out with the
  session; keys are capped by their creator's current role.
- Cross-portal access: scope comes from the route, and every object lookup is portal-checked.
- Escalation through keys: keys never satisfy management permissions and never own artefacts.
  An estate reaches other portals only at the estate endpoint, only while the key's creator holds
  a role on each, and each of those portals' audit logs records every call that reached it.
- Audit tampering: no update or delete route; retention purges are recorded; details are
  whitelisted per action.
- Denial of service through audit growth: safe-metadata fetches and ordinary reads are not
  audited; MCP credential failures are rate limited before they are verified.

## Answer evidence records

Answer record reads and JSON/CSV exports use `content.write` (curator and above), scoped to the
portal in the route. These are privileged reads and refuse keys. Retention settings use
`behaviour.write` (portal administrator and above). See [Answer records](ANSWER-RECORDS.md) for the
route inventory, personal-data handling and per-portal retention.
