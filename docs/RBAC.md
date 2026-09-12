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

## Where identity comes from

1. **Sign-in.** The Worker runs OpenID Connect against Microsoft Entra and seals the verified
   claims into an encrypted cookie scoped to the platform domain. Sessions last up to eight
   hours. If a token carries so many group ids that the cookie would exceed the browser limit,
   the groups are dropped and the session records `groupStatus: overage`, which disables group
   mappings for that session rather than truncating the list.
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
  bound portal only. Refused on `/api/admin/*`, on other portals, after expiry or revocation, and
  for every management permission: a key is a data-plane credential whatever role it carries.
- Keys minted before this release (`ck_mcp_` prefix) keep working as fixed `viewer` keys on their
  portal. They cannot be raised, and the key list marks them as legacy.

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

Read at `GET /api/admin/t/:slug/audit` (portal `audit.read`) or `GET /api/admin/audit` (platform
`audit.read`), export as CSV or JSON from the `/export` siblings (`audit.export`). Retention is
`AUDIT_RETENTION_DAYS` (default 400), applied by the maintenance cron, and the purge is itself
recorded.

## Break-glass

`ADMIN_PASSCODE` no longer opens the whole administration surface. It grants `owner` for a single
request only when `ADMIN_BREAK_GLASS=true`, or outside production, and only when presented in
the `x-admin-passcode` header of that request. The browser never stores it and never retries with
it. Every use is audited with the session identity beside it when there is one. Five failures
from one address in ten minutes lock the path for ten minutes.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `SESSION_SECRET` | Worker secret | Cookie sealing and, via HKDF, principal signing. At least 32 bytes. |
| `WORKER_NAME` | `wrangler.jsonc` var | Signing audience: `corpuskit`, `corpuskit-demo`, or the name of another deployment. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Worker | Sign-in. Without them sign-in is unconfigured and every visitor is anonymous. |
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
  set `ADMIN_BREAK_GLASS=true` in production if you need it as an emergency path.
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
- Audit tampering: no update or delete route; retention purges are recorded; details are
  whitelisted per action.
- Denial of service through audit growth: safe-metadata fetches and ordinary reads are not
  audited; MCP credential failures are rate limited before they are verified.
