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
| `EXTERNAL_LOGIN_START_URL` | Optional HTTPS URL on the issuer that starts sign-in; HTTP is accepted only for localhost development. Without it, the handoff endpoint remains available but the portal shows no external sign-in button. |
| `WORKER_NAME` | Deployment-specific assertion audience and principal-envelope audience. Local development defaults to `corpuskit`. |
| `SESSION_SECRET` | Random secret of at least 32 bytes, used to seal the normal session cookie and sign the internal principal envelope. |

The Worker and a production local server require `SESSION_SECRET`. For local development only,
an omitted secret uses a randomly generated process key, so sessions end on restart. Replay
identifiers still persist independently in SQLite; restarting does not make an assertion reusable.

External sign-in is off unless both issuer and public JWK are set. Invalid configuration fails
closed. Entra credentials are not required for an external-only deployment. When Entra is also
configured, the portal sign-in gate keeps its Entra button and adds the external button when the
external start URL is configured. The external button links to that start URL; the issuer controls
the subsequent handoff to CorpusKit.

The issuer signs a compact JWS with Ed25519. Its protected header must have `alg: "EdDSA"` and
`typ: "JWT"`. CorpusKit verifies the signature with WebCrypto and validates these claims:

| Claim | Requirement |
|---|---|
| `iss` | Exactly `EXTERNAL_LOGIN_ISSUER`. |
| `aud` | Exactly this deployment's `WORKER_NAME`. |
| `sub` | Stable issuer user id, 1 to 128 characters. |
| `email` | A valid email address, normalised to lower case in the session. |
| `email_verified` | Boolean `true`. |
| `name` | Optional display name. |
| `iat`, `exp` | Numeric dates in seconds. Lifetime is at most 120 seconds; the current time must be within `[iat - 30 seconds, exp]`. |
| `jti` | Unique identifier of at least 16 characters. Accepted once only and retained until expiry has passed. |

Successful verification creates an encrypted session with `provenance: "external"` that expires
eight hours after creation. The identity has `tid: "external"`, `oid: "ext:<sub>"`, the verified
email and optional name. Assertion roles and groups never grant authority. A `303` response
redirects to `returnTo`, which must begin with a single `/` and stay on the same origin. Absolute
URLs, protocol-relative URLs, backslashes and encoded redirect bypasses fall back to `/`.

Assertion replay is checked in the existing SQLite-backed Durable Object, so a token cannot be
reused in another Worker isolate. The local server uses the RBAC SQLite database for the same
single-use check, including across local server restarts. The signed principal envelope accepts
`tid: "external"` only while the feature is configured. Verification failures return only
`401 {"error":"external_login_invalid"}`; the audit log records a safe reason code without the
assertion, signing key or email address.

Treat the assertion query parameter as a credential. The deployment configurations disable
[Worker invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs),
which otherwise record request URLs, while keeping application logs enabled. Configure any reverse
proxy, request tracing, access logging or telemetry export to omit the handoff query string as
well. The handler sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on both success
and failure.

External users receive roles only through local assignments. In the portal Members screen or
the platform People screen, choose the external identity source when adding a person. The existing
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
it is rewritten to that person's object id. Existing rows and requests that omit `source` use
`entra`; an external sign-in can never claim an Entra assignment. Group mappings remain Entra-only.
An external object-id assignment uses the `ext:<sub>` identifier and `source: "external"`.

The assignment migration runs atomically and preserves existing rows as `entra`. Older binaries
do not understand the `source` boundary and could apply external assignments to an Entra identity.
Prefer a forward fix for this change. Do not roll back to code that ignores `source` while external
assignment rows remain, even if external sign-in has been disabled. A code rollback does not undo
the SQLite migration or remove those rows.

`GET /auth/me` exposes the sign-in origin as `sessionProvenance` and `user.provenance`, preserving
the existing `provenance` array that describes role grants. It also reports `entraEnabled` and
`externalLogin: { "name": "...", "startUrl": "..." }` when the external button is configured,
or `externalLogin: null` otherwise. Existing Entra sign-in and its session flow remain unchanged.
