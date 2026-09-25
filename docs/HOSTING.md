# Hosting CorpusKit

CorpusKit provides optional hosting capabilities for operators running portals for multiple
organisations. These capabilities use the existing permission declarations, trusted identity
boundary and audit log. They are disabled unless their deployment configuration is present.

## Operator credential

Set `OPERATOR_API_KEY` to the unpadded base64url encoding of at least 32 cryptographically random
bytes. For example, generate a value locally with
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`, then place it in the deployment's secret
store. Never commit the generated value or include it in logs. `OPERATOR_ID` is an optional
non-secret actor identifier, defaulting to `operator`. It must start with an ASCII letter or
digit, contain only letters, digits, `_`, `.`, `:`, `@`, `/` or `-`, and be at most 151 characters.
It must not contain `://`.
An absent, empty or invalid key, or an invalid identifier, disables the credential.

Send the credential as `Authorization: Operator <key>`. `Bearer` is reserved for portal data
keys and does not accept an operator key. A wrong, missing or malformed operator credential
returns `401 invalid_operator`; it never falls back to a browser session or break-glass passcode.
Combining the operator scheme with `x-admin-passcode` is refused. Existing browser cookies grant
no additional authority to an operator request.

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
group mappings are separate routes and are not enabled for this credential.

Knowledge-box connection accepts `{"endpoint":"https://example.invalid/api/v1/kb/example","token":"<token>"}`
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

Rotate the credential by replacing `OPERATOR_API_KEY` in the runtime secret store and updating
the caller to use the new value. Only one key is accepted; the previous key stops working as
soon as the replacement takes effect. Restart the local server after changing its environment.
Keep `OPERATOR_ID` stable when rotating a key to retain the same audit actor, or change it to
identify a different operator. Remove `OPERATOR_API_KEY` to disable this authentication scheme.
