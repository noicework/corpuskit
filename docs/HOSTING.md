# Hosting CorpusKit

CorpusKit provides optional hosting capabilities for deployments that serve one or more
organisations. Each capability is explicitly configured, uses the existing portal access controls
and keeps tenant data within the deployment's own storage. The default deployment continues to
work without these optional settings.

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
