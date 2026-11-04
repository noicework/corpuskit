# Security policy

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches or version
tags. The contribution and deployment workflow is described in `CONTRIBUTING.md` and
`.github/workflows/deploy.yml`.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Email: **security@noice.net.au**

Alternatively, use this repository's private vulnerability reporting (Security -> Report a
vulnerability).

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept if you have one.
- Any affected version/commit.

We will acknowledge reports as soon as practicable and aim to keep you updated as we investigate and
fix.

Application code, authentication, authorisation, tenant isolation, credential handling, audit,
exports and restore are in scope. Relevant implementation lives in `apps/`, `packages/`, `content/`
and deployment configuration (`Dockerfile`, `wrangler.jsonc`, `.github/workflows/`). Report
vulnerabilities in upstream platforms or third-party services to their providers. Do not conduct
denial-of-service testing against a deployed instance you do not own.

## Security model

### Tenancy and roles

Portals are logical tenant boundaries within a deployment. Permissions are checked against the
portal identified by the route, and portal-owned objects are resolved within that scope. A portal
role grants no access to another portal. The access modes are `public` (anonymous viewer access),
`authenticated` (viewer access for signed-in users of the configured identity tenant) and
`restricted` (assigned access). Inaccessible portals expose only the safe metadata needed for
sign-in and access-denied views. See `docs/RBAC.md`, `apps/api/src/permissions.ts` and
`apps/api/src/authorisation.ts`.

Portal roles are cumulative: `viewer`, `analyst`, `curator`, `portal-admin`. They add reading and
answers, research and exports, content management, then portal administration respectively. Platform
roles are `platform-admin` and `owner`; both imply portal-admin access across all portals. Owner
adds portal deletion and platform membership/settings permissions. Route and MCP permissions are
declared centrally and evaluated by the shared authorisation core. See `docs/RBAC.md`,
`packages/core/src/rbac.ts` and `apps/api/src/permissions.ts`.

### Identity, sessions and keys

Sign-in uses the configured identity provider through OpenID Connect or the optional external-login
bridge. Sessions are encrypted and authenticated with AES-GCM using `SESSION_SECRET`, last at most
eight hours, and use `Secure`, `HttpOnly`, `SameSite=Lax` cookies. Alias-host sessions are bound to
the issuing host. The managed ingress strips caller-supplied identity headers and forwards a signed
principal bound to the deployment audience, identity tenant and request time. See
`apps/cloudflare/src/auth.ts`, `apps/api/src/external-login.ts`, `apps/cloudflare/src/worker.ts` and
`apps/api/src/principal.ts`.

Scoped `ck_` keys are shown once, with only their SHA-256 hashes retained. Each key is bound to a
portal and role, optionally expires, and can be revoked. Its effective role is capped by its
creator's current authority. Keys cannot use `/api/admin/*` or management permissions. Explicit
estate coverage can extend a key to selected portals at the estate MCP endpoint only. Legacy
`ck_mcp_` keys remain fixed viewer credentials. See `docs/RBAC.md`, `apps/api/src/scoped-keys.ts`
and `apps/api/src/authorisation.ts`.

Hosting automation has a separate operator credential, restricted to explicitly declared operator
routes with platform-admin authority. It does not acquire owner authority or inherit browser session
roles. See `docs/HOSTING.md`, `apps/api/src/operator.ts` and `apps/api/src/permissions.ts`.

The passcode is an emergency break-glass path, disabled by default. It requires both
`ADMIN_PASSCODE` and exactly `ADMIN_BREAK_GLASS=true`, presented through `x-admin-passcode` for each
request. It grants owner authority for that request without creating a session. Uses, failures and
lockouts are audited; five failures in ten minutes lock the address bucket for ten minutes. These
attempts and locks are database-backed. See `apps/api/src/break-glass.ts` and `docs/RBAC.md`.

### Sealed bindings

Knowledge-box tokens stay on the server. With `BINDING_KEY` configured, new or replaced binding
tokens are sealed at rest with AES-GCM, authenticating the portal slug so ciphertext cannot be moved
between portals. The key must encode 32 random bytes in base64. A sealed token that cannot be opened
is unavailable rather than treated as plaintext. The managed binding store requires the key for
writes. See `apps/api/src/binding-crypto.ts`, `apps/api/src/bindings.ts` and
`apps/cloudflare/src/state.ts`.

### Audit, export and restore

The audit log is append-only through the application interface, with no HTTP update/delete API.
Events record actor, action, scope, target, outcome and request id, using allowlisted, redacted
details. Privileged operations, denials and break-glass activity require audit records; a required
audit failure fails the request. Manage provides an audit viewer and bounded CSV/JSON exports,
protected by scoped `audit.read` and `audit.export` permissions. See `apps/api/src/audit.ts`,
`apps/api/src/audit-execution.ts`, `apps/api/src/audit-routes.ts`,
`apps/web/src/pages/admin/AuditPanel.tsx` and `docs/RBAC.md`.

Portal bundle exports require portal `audit.export` or the hosting operator credential. Full backups
and import are opt-in through `portalRestore`, off by default. Import requires platform
`portal.create` or the operator credential and an empty destination; it validates bundle versions,
size, inventory, hashes and record shapes before restoring portal-owned state and appending audit
history. Bindings, credentials, authentication sessions, keys and access assignments are excluded;
provider-held documents and indexes need separate recovery. See `docs/PORTAL-EXPORT.md`,
`docs/RESTORE.md`, `apps/api/src/portal-export.ts` and `apps/api/src/portal-import.ts`.

### Response headers

The API sets `Strict-Transport-Security: max-age=63072000`, adding `includeSubDomains` only within
the platform domain, plus `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin` and
`Content-Security-Policy: frame-ancestors 'none'`. Stored files retain a stricter sandbox policy;
stored PDFs permit framing by the portal itself. See `apps/api/src/app.ts` and
`apps/api/src/portal-aliases.ts`.

The managed edge also sets `X-Frame-Options: DENY` and
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` on its asset and locally
composed responses. These extra headers are defined in `apps/api/src/edge.ts`; they are not set by
the API's baseline middleware in `apps/api/src/app.ts`.

## Known limitations and operator responsibilities

- The portal's baseline CSP restricts framing only. It does not provide `default-src` or
  `script-src` restrictions against script injection. See `apps/api/src/app.ts` and
  `apps/api/src/edge.ts`.
- Request rate limits use in-memory sliding windows in the serving process or managed object.
  Counters reset on restart and are not a shared distributed limit across independent instances.
  Break-glass lockouts use the database separately. See `apps/api/src/rate-limit.ts`,
  `apps/api/src/portal-export.ts` and `apps/api/src/break-glass.ts`.
- The portal provides no MFA challenge itself. MFA and sign-in policy must be enforced by the
  configured identity provider. Identity-provider claims can remain stale for the session lifetime;
  local role assignments are resolved on each request. See `apps/cloudflare/src/auth.ts`,
  `apps/api/src/external-login.ts`, `apps/api/src/rbac-state.ts` and `docs/RBAC.md`.
- Local binding storage permits plaintext when `BINDING_KEY` is absent. Existing plaintext tokens
  are sealed at start-up only with a valid key and `BINDING_KEY_MIGRATE=true`. Merely setting a key
  does not migrate them. Protect the data directory and keep the key available for recovery. See
  `apps/api/src/bindings.ts` and `apps/api/src/binding-crypto.ts`.
- Append-only application access is not tamper-proof storage against an operator with database
  access. Audit retention defaults to 400 days; maintenance purges expired rows, and portal erasure
  removes scoped history while retaining erasure evidence. See `docs/RBAC.md` and
  `apps/api/src/rbac-state.ts`.
- Downloaded backups contain sensitive research and personal data despite credential redaction.
  Operators must schedule, protect and retain backups and separately recover provider content and
  access configuration. Bundle hashes detect corruption, not authorship, and exports are not a
  transactionally consistent snapshot across providers and stores. See `docs/RESTORE.md`,
  `docs/PORTAL-EXPORT.md` and `apps/api/src/portal-export-redaction.ts`.
