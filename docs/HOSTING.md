# Hosting CorpusKit

CorpusKit supports deployments serving several organisations from one Worker. The capabilities
below configure deployment-wide credential storage and routing while keeping portal data and
access policies scoped to each portal. Set secrets through your deployment's secret manager and
ordinary variables through its runtime configuration.

## Knowledge box credential encryption

Set `BINDING_KEY` to the standard base64 encoding of 32 cryptographically random bytes. The
Cloudflare adapter requires it to connect or replace a knowledge box. The local JSON adapter
also supports it; without it, local startup warns that stored tokens remain plaintext.

Each persisted binding token uses AES-256-GCM, a fresh random 96-bit IV, a 128-bit authentication
tag and additional authenticated data `corpuskit-binding-v1:<portal slug>`. Its stored form is
`enc:v1:<base64url iv>:<base64url ciphertext>`, with the authentication tag included in the
ciphertext. Moving a sealed token to another portal, altering it, or supplying the wrong key
fails closed. API responses, audit details and errors never include the token or encryption key.

On startup with a key, existing plaintext tokens are sealed before requests are served. Migration
accepts mixed plaintext and sealed records, writes only after all records validate, and is
idempotent across restarts. Subsequent writes seal tokens before committing them. Reads use the
decrypted server-side binding; environment-provided bindings stay in the runtime secret store.

Without a key on Cloudflare, existing plaintext bindings remain readable and can still be
disconnected. New or replacement bindings return HTTP 503 with `{ "error": "binding_key_missing" }`
before contacting the knowledge box. Sealed bindings require their original key and never fall
back to plaintext or another binding if verification fails. Invalid key configuration also fails
closed: if the key is malformed, or any stored token cannot be opened because the key is missing
or different, the portal API does not serve requests until the original key is restored.

`GET /api/health` includes `bindingEncryption: { configured, required, writable }` on Cloudflare.
Liveness remains available when a key is missing because existing plaintext bindings can still
serve reads. Each row of the authorised `GET /api/admin/overview` includes the same status; a
missing Cloudflare key reports `{ "configured": false, "required": true, "writable": false }`.
The overview remains an array for existing clients.

Keep the key available with your protected backups. Changing or losing it prevents existing
sealed tokens from being decrypted. This release does not provide automatic key rotation or
re-encryption under a replacement key. A code rollback must understand the sealed format; do not
roll back to a version that treats sealed tokens as plaintext.

## Configurable platform domain

Set the runtime `PLATFORM_DOMAIN` variable to the deployment's platform hostname, such as
`research.example`. It defaults to `corpuskit.org`. Use a DNS hostname without a scheme, path or
port. Invalid values are rejected. This value is independent of the Worker name.

Automatic portal hostnames use `<slug>.<PLATFORM_DOMAIN>`. The platform redirect, platform links
in the SPA and shared session-cookie scope derive from the same value. The server injects the
domain into the HTML shell at runtime before the SPA loads, so a single web bundle can serve
different deployments without a rebuild. Custom hostnames outside the platform domain retain
host-only cookies; lookalike suffixes are never included in the platform cookie scope.

Configure Worker routes, the domain automation token's zone permissions and the identity
provider's redirect URI for your chosen domain. Changing this variable does not create DNS
routes or rewrite explicitly assigned portal hostnames. Existing sessions on the previous
domain do not transfer to a different domain.

The platform domain may be a Cloudflare zone apex or a subdomain of one. Hostname automation
attaches each new hostname to `WORKER_NAME` (default `corpuskit`) and lets Cloudflare place it in
the account zone that contains it, then rejects a result for any other hostname, Worker or zone.
Its token needs DNS Edit for that zone and Workers Scripts Edit for the account. Explicitly
malformed `PLATFORM_DOMAIN` configuration returns HTTP 503 `platform_domain_invalid` at the Worker
boundary.
