# Hosting CorpusKit

CorpusKit provides optional hosting capabilities for deployments that serve one or more
organisations. Each capability is explicitly configured per deployment through its secrets and
runtime variables, keeps portal data in the deployment's own storage and uses the existing portal
access controls. The default deployment continues to work without these optional settings. Each
section below describes one capability.

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

On startup with a key, sealed tokens are opened before requests are served, then remaining
plaintext tokens are sealed. Sealing waits until every stored token opens with the configured
key, so a well-formed but wrong key never re-seals plaintext under itself. Migration accepts mixed
plaintext and sealed records and is idempotent across restarts; if its write fails, the records
stay readable as before and sealing is retried at the next start. Later writes seal tokens
before committing them. Environment-provided bindings stay in the runtime secret store.

Without a key on Cloudflare, existing plaintext bindings remain readable and can still be
disconnected. New or replacement bindings return HTTP 503 with `{ "error": "binding_key_missing" }`
before contacting the knowledge box.

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
`bindingEncryption: { configured, required, writable, error?, unavailable }`. `error` names a
deployment-wide cause: `binding_key_missing`, `binding_key_invalid` or `binding_storage_invalid`.
`unavailable` counts withheld bindings. A missing Cloudflare key reports
`{ "configured": false, "required": true, "writable": false, "error": "binding_key_missing", "unavailable": 0 }`.
The overview remains an array for existing clients.

### Recovering from a changed or lost key

1. Watch `bindingsReady`, then read `bindingEncryption` and each row's `knowledgeBox.status` in
   the admin overview to find the cause and the affected portals.
2. If the previous key still exists, restore it as `BINDING_KEY`. Withheld bindings open again
   unchanged at the next start.
3. If it is lost, keep or set a new key, then reconnect each `unavailable` portal with a fresh
   service account key, or disconnect it. Sealing of any remaining plaintext resumes at the next
   start once nothing is withheld.

Keep the key available with your protected backups. This release does not provide automatic key
rotation or re-encryption under a replacement key. A code rollback must understand the sealed
format; do not roll back to a version that treats sealed tokens as plaintext.

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
scope, and the SPA only links across origins to hostnames within the platform domain.

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
| Update portal appearance and search prompt | `PATCH /api/admin/tenants/:slug` |
| Connect or disconnect a knowledge box | `POST`, `DELETE /api/admin/t/:slug/knowledge-box` |
| Change portal access mode | `PATCH /api/admin/t/:slug/access` |
| List and create portal members | `GET`, `POST /api/admin/t/:slug/members` |
| Remove a portal member | `DELETE /api/admin/t/:slug/members/:id` |
| Read corpus counters | `GET /api/admin/t/:slug/counters` |
| Upload branding | `POST /api/admin/t/:slug/branding/:kind` |
| Migrate content between portals | `POST /api/admin/migrate` |

Create an email assignment with a body such as
`{"subjectKind":"pending-email","subjectId":"reader@example.org","role":"viewer"}`.
The list response returns the assignment identifier used for deletion. Member role changes and
group mappings are separate routes and are not enabled for this credential. For people who sign
in through [external sign-in](#external-sign-in-handoff), add `"source":"external"`: an assignment
that omits it is an Entra assignment, which an external identity can never claim and which a
deployment without Entra refuses.

Knowledge-box connection accepts
`{"endpoint":"https://<region>.rag.progress.cloud/api/v1/kb/<box-id>","token":"<token>"}`
and validates the binding with the provider before saving it. The existing `url` field remains
available; supply exactly one of `endpoint` or `url`.

This version has no standalone dedicated-hostname assignment or removal routes. Portal creation
can attach the automatically derived hostname when the domain provisioner is configured. The
existing hostname removal operation is part of portal deletion, which requires `owner` and is
therefore refused for operators. A future dedicated-hostname route must opt in explicitly and
retain the `domains.write` permission.

`POST /api/admin/migrate` is declared with `portal.create` (platform-admin) rather than the
owner-only `platform.settings.write`, for every caller, so that the operator can use it. The
route only composes authority a platform-admin already holds: it separately checks
`content.write` on both the source and destination portals, which a platform-admin has on every
portal, and it changes no platform settings. The administration screen still offers the
migration panel to owners only.

Additional hosting routes, including portal lifecycle and usage routes, must explicitly opt in
with `operator: true`; adding a route does not make it operator-accessible automatically.

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
assertion, signing key or email address, as the `auth.external.denied` action with one
`externalReason` field. As for every audited denial, if that record cannot be written the request
fails with `500 {"error":"audit_write_failed"}`, and no session is issued either way.

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
