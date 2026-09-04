# Cloudflare production

CorpusKit runs as one Cloudflare Worker named `corpuskit`. Static SPA assets are served by the
Worker Assets binding; `/api/*` is handled by the existing Hono application inside a SQLite-backed
Durable Object. This keeps the application's synchronous store contracts intact while replacing
Fly's local volume with durable Cloudflare state.

Production is published at `https://corpuskit.org`. The Worker also keeps its generated
`workers.dev` route for recovery.

## Delivery

`.github/workflows/deploy.yml` is the only code deployment path:

1. Build the SPA and Worker bundle.
2. Run type checking, lint, formatting and tests.
3. Validate the exact package with Wrangler's dry-run deploy.
4. Deploy that preserved package with `cloudflare/wrangler-action@v3` and Wrangler 4.127.1.
5. Verify health, then verify anonymous auth state and the live persona journey once runtime
   secrets have been attached.

GitHub needs `CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped `CLOUDFLARE_API_TOKEN` with Workers
Scripts edit permission for the target account. Set `CORPUSKIT_BASE_URL` to
`https://corpuskit.org` as a repository Actions variable. Leave the
`CORPUSKIT_RUNTIME_CONFIGURED` repository variable unset for the first deployment. After uploading
runtime secrets, set it to `true` and rerun the deployment workflow to enable the identity and ARAG
production checks.

## Runtime secrets

ARAG and identity credentials belong to the Worker, not the repository or CI logs. After the
first deploy creates the Worker, upload the existing local values with Wrangler:

```sh
deno task secrets:cloudflare
```

The task filters `.env` through an allowlist before calling Wrangler, uses a mode-0600 temporary
file and removes it immediately. It deliberately refuses to upload the ARAG account provisioning
credentials.

Only Worker-relevant values are read at runtime:

- `ARAG_ZONE`
- `ARAG_KB_<SLUG>` and `ARAG_KB_<SLUG>_TOKEN`
- `ADMIN_PASSCODE` as an emergency/local fallback
- `ENTRA_CLIENT_SECRET`
- `ENTRA_ADMIN_EMAILS` as an optional break-glass allowlist
- `SESSION_SECRET`, a random value of at least 32 bytes
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_DOMAINS_TOKEN`, optional credentials for
  automatically attaching a safe `<slug>.corpuskit.org` custom domain when an administrator
  creates a portal

Do not upload account provisioning credentials (`ARAG_ACCOUNT`, `ARAG_NUA_KEY`) to the Worker.

## Portal custom domains

The two seeded showcase portals and OPAX have explicit custom domains in `wrangler.jsonc`. Other portals are always
created with a working relative `/t/<slug>` route first. If the optional Cloudflare domain
credentials are configured, the admin create route then:

1. validates the generated slug as a public DNS label and rejects reserved infrastructure names;
2. looks up the exact hostname with
   [`GET /accounts/{account_id}/workers/domains`](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/);
3. attaches it to the `corpuskit` Worker with
   [`PUT /accounts/{account_id}/workers/domains`](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
   when it is absent; and
4. stores the hostname on the tenant only after Cloudflare confirms it.

Cloudflare creates the DNS record and TLS certificate for a Worker Custom Domain. Repeating create
is a no-op when the hostname is already attached to the `corpuskit` Worker. Removing a custom
portal looks up the domain and calls
[`DELETE /accounts/{account_id}/workers/domains/{domain_id}`](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/delete/)
before deleting the tenant. If create
provisioning is unavailable or fails, portal creation still succeeds and the API reports a
`skipped` or `failed` domain status. If removal fails, the tenant is preserved so the operation can
be retried without leaving an attached orphan domain.

Create a dedicated API token named for portal-domain provisioning. Do not reuse the CI deployment
token or a Global API Key. Restrict it to the CorpusKit Cloudflare account and the
`corpuskit.org` zone with exactly:

- Account - Workers Scripts - Edit (`Workers Scripts Write` in the API reference).
- Zone - DNS - Edit, limited to the single `corpuskit.org` zone.

Put the token in `.env` as `CLOUDFLARE_DOMAINS_TOKEN` and the target account identifier as
`CLOUDFLARE_ACCOUNT_ID`, then rerun `deno task secrets:cloudflare`. Both are uploaded through the
allowlisted, mode-0600 bulk-secret flow and are never committed or logged. Leaving either value
unset disables automatic domains without disabling portal creation.

## Microsoft 365 sign-in

The Entra application is single-tenant and uses the OAuth 2.0 authorisation-code flow with PKCE.
The Worker validates the ID-token signature, issuer, audience, tenant, lifetime and nonce before
creating an encrypted, `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. Tokens are not stored.

`infra/entra-app-roles.json` is the source of truth for the `CorpusKit.Admin` application role.
Assign that role to people or groups that need `/admin` and per-portal management access. Signed-in
users without the role can use the public portal but cannot call an admin API.

The production app registration is `CorpusKit Production`, client ID
`147a13c9-2a9e-4e32-aa01-3f020d2a18cd`, in tenant
`15c1eb19-1f38-4a09-bb25-7ff9892387b8`. Those non-secret identifiers and the exact redirect URI
are versioned in `wrangler.jsonc`; only its client credential is a Worker secret.

Rotate the Entra client credential before expiry, update `ENTRA_CLIENT_SECRET` with Wrangler, then
revoke the old credential. Rotating `SESSION_SECRET` signs every current session out.

## State and rollback

Tenant configuration, bindings, sessions, investigations, watches, sources, insights,
suggestions, enrichments and branding assets live in the `PortalDurableObject` SQLite database.
The first Worker migration is tagged `v1`; future schema changes must add a new migration tag.

Cloudflare keeps Worker versions and deployments. Roll code back with a Cloudflare deployment
rollback; never delete the Durable Object namespace during rollback, because it owns production
state.
