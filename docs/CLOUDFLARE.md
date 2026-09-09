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
4. Record the documentation demo's exact active deployment and Worker version, then deploy the
   preserved package with `cloudflare/wrangler-action@v3` and Wrangler 4.127.1.
5. Verify the demo's health and its real documentation corpus: search, a cited answer and an
   out-of-corpus refusal. This is a real ARAG check, not the browser E2E test double. Production
   waits for this job to pass. The demo has its own existing tenant, binding and Durable Object
   state; no production tenants or credentials are copied into it.
6. Record production's exact active deployment and version, deploy the same preserved package,
   then verify actual production health/version, custom domains and anonymous auth state once runtime
   secrets have been attached. These are production deployment checks, not corpus queries.
7. If post-deploy verification fails, restore that Worker's recorded previous version and verify
   its active version. Demo recovery also reruns its real functional journey; production recovery
   rechecks production sign-in and domain health, without querying a customer corpus. The failed
   release stays red even when recovery succeeds.

All automated functional testing targets **`https://demo.corpuskit.org`, tenant `demo`**. This
includes the release's search/cited-answer/refusal gate, demo rollback verification, and the
three-hourly or manually dispatched `acceptance.yml` sweep. There is no production/OPAX persona
smoke and no arbitrary tenant override in these workflows. The old `PERSONA_SMOKE_TENANTS` and
`ACCEPTANCE_TENANTS` repository variables are ignored; they do not redirect either workflow.
The persona runner also rejects non-demo remote targets before making a request. Localhost
test-double journeys remain available for development.

The demo gate proves the preserved package works with the demo's real ARAG corpus. It does **not**
prove any production customer's corpus or ARAG configuration works. Production health, version,
authentication and configured-domain checks remain separate and run against production itself.

GitHub needs `CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped `CLOUDFLARE_API_TOKEN` with Workers
Scripts edit permission for the target account. Deployment checks use the explicit production
and demo hostnames; `CORPUSKIT_BASE_URL` does not redirect the deployment workflow. Leave the
`CORPUSKIT_RUNTIME_CONFIGURED` repository variable unset for the first deployment. After uploading
runtime secrets, set it to `true` and rerun the deployment workflow to enable the production identity
check. The real ARAG functional gate always runs against the existing demo corpus.

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

The deployment workflow uses `apps/cloudflare/scripts/release-safety.ts` with pinned Wrangler
4.127.1. Before publishing, `deployments list --json` must identify one current version serving
100% of traffic. Empty, malformed, ambiguous or split deployments stop the release **before code
is published**. This intentionally requires a separately reviewed bootstrap procedure for a new
Worker; it does not silently deploy without a recovery target.

After a successful publish the workflow obtains `Current Version ID` from that Wrangler action's
`command-output`, passed via an environment variable rather than interpolated into shell code.
Missing, malformed or multiple IDs fail closed. The active deployment must match this explicit
published version before its deployment and version IDs are recorded as the candidate; an external
release between publishing and snapshotting is not treated as this workflow's release. If a
verification step fails, recovery first checks that the candidate is still active, then calls
`wrangler rollback <recorded-previous-version> --config <exact-config> --name <exact-worker> --yes`.
It never uses an implicit "previous" target, guesses from uploaded versions, or deletes a namespace.
Worker/account checks prevent cross-target snapshots; a later deployment causes recovery to stop
instead of overwriting someone else's release. The workflow concurrency group serialises pipeline
releases, but operators should not make dashboard releases during a pipeline deployment (Cloudflare
does not offer an atomic compare-and-swap between checking and rolling back).

Recovery remains a visible failure if Cloudflare rejects rollback, the previous version does not
become active, or the restored Worker's applicable verification checks fail. A publish that errors partway through, or a failed
candidate snapshot, requires manual inspection: the workflow cannot safely identify its candidate
and will not guess. Cancelling a runner can also prevent recovery steps from running. Do not cancel
a published release that is running verification; let it verify or recover.

Code rollback preserves current Durable Object state, not a historical database snapshot. Cloudflare
[does not permit rollback across a Durable Object class lifecycle change](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
and old code may not understand newly written data. Releases that change class migrations, storage
schemas or resource bindings need an explicitly reviewed compatibility/recovery plan. This safety
mechanism is for compatible code releases, including the citation-provider fix; it is not a database
backup or schema reversal mechanism.
