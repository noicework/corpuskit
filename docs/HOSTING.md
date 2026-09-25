# Hosting CorpusKit

CorpusKit provides optional hosting capabilities for deployments that serve several
organisations. Each capability is configured per deployment through its secrets and runtime
variables, keeps portal data in the deployment's own storage and uses the existing portal access
controls. Each section below describes one capability.

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
