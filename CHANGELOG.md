# Changelog

All notable changes to CorpusKit are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases use calendar versions, `YYYY.M.D` without zero padding and tagged `v2026.9.27`, with a `.N` suffix for a second release on the same day. Release dates are in Australian Eastern time. How a release is cut is in [docs/RELEASING.md](https://github.com/noicework/corpuskit/blob/main/docs/RELEASING.md).

Each release groups its changes under Added, Changed, Fixed and Security, then closes with Upgrade notes for people who run a deployment: new or changed settings and their defaults, behaviour that changes on upgrade, changes to stored data, and whether rolling back is safe.

## [Unreleased]

### Added

- Search engines can find the public site. `/robots.txt` names a sitemap on the platform domain, and `/sitemap.xml` lists the home page, About and every documentation page, including new ones as they are added. ([#74](https://github.com/noicework/corpuskit/pull/74))
- About answers common questions: what CorpusKit is, where answers come from and how they are checked, what a portal takes in, access for AI assistants over MCP, what a deployment needs, the demo, and how to contribute. ([#74](https://github.com/noicework/corpuskit/pull/74))
- `PORTAL_INDEXING=deny` keeps a deployment's portals out of search: portal hosts answer `robots.txt` with `Disallow: /` and portal pages carry `X-Robots-Tag: noindex`, while the platform domain's home page, About and documentation stay indexable. The default, `allow`, changes nothing. See [Search engines](https://github.com/noicework/corpuskit/blob/main/docs/HOSTING.md#search-engines). ([#74](https://github.com/noicework/corpuskit/pull/74))
- The home page, About and every documentation page describe themselves to search engines in structured data, and each documentation page carries its breadcrumb trail. About and the documentation have share cards of their own. ([#74](https://github.com/noicework/corpuskit/pull/74))
- Release notes for every release, with upgrade notes for anyone running a deployment, on the documentation site at `/docs/release-notes` and in `CHANGELOG.md`. ([#73](https://github.com/noicework/corpuskit/pull/73))
- For maintainers: `deno task release:notes <version>` prints one release's notes for its GitHub release, and `docs/RELEASING.md` describes how a release is cut. ([#73](https://github.com/noicework/corpuskit/pull/73))

### Changed

- The documentation overview is titled "CorpusKit documentation", and the home page's description names the licence and the checked answers. ([#74](https://github.com/noicework/corpuskit/pull/74))
- `/api/health` reports `release`, the newest release the build contains. On Cloudflare it now also reports `buildSha` and `builtAt`, the commit and time the build was made, as the local server already did. ([#73](https://github.com/noicework/corpuskit/pull/73))

### Fixed

- Link previews of a portal on its own subdomain or hostname show the CorpusKit share image, which the page now names on the host that served it rather than on the platform domain. ([#74](https://github.com/noicework/corpuskit/pull/74))

### Upgrade notes

- `PORTAL_INDEXING` is new and defaults to `allow`, so portals stay as indexable as before. Set it to `deny` to keep them out of search; any value other than `allow` counts as `deny`. ([#74](https://github.com/noicework/corpuskit/pull/74))
- `/robots.txt` is now answered by the Worker and the local server, and `apps/web/public/robots.txt` is gone. A deployment that changed that file should carry its rules into `apps/api/src/search-files.ts`. `/sitemap.xml` answers on the platform domain only. ([#74](https://github.com/noicework/corpuskit/pull/74))
- `/api/health` gains `release`, and on the Worker also `buildSha` and `builtAt`. `version` is unchanged: on the Worker it is still the Cloudflare version id that release verification matches. Automation that reads health can show the commit or release instead. ([#73](https://github.com/noicework/corpuskit/pull/73))
- The container build copies `CHANGELOG.md`, which the documentation build and the build stamp now read. ([#73](https://github.com/noicework/corpuskit/pull/73))
- **Rollback to 2026.9.27.1 is safe.** Nothing stored changes, and health drops the new fields. ([#73](https://github.com/noicework/corpuskit/pull/73))
- **Rollback is safe** after the search changes too: nothing stored changes, and the static `robots.txt` returns with the older build. ([#74](https://github.com/noicework/corpuskit/pull/74))

## [2026.9.27.1] - 2026-09-27

Nightly maintenance keeps going past one portal's failure, anonymous rate limits key on the real address, break-glass needs its flag in every environment, Search and Ask no longer wait on a slow catalogue, and the built-in showcase portals are opt-in.

### Changed

- Nightly maintenance keeps going when one portal fails. Each source sync, watch, enrichment run and suggested-question run is its own unit, a failure is recorded against its portal, and the pass moves on. Only strain on the shared platform account halts the whole pass, and a backlog in one knowledge box holds back only that portal's syncs. ([#72](https://github.com/noicework/corpuskit/pull/72))
- The nightly pass skips portals with no knowledge box and empty catalogues, starts at a different portal each day, and stops starting new work 75 seconds in, so it finishes inside its deadline. ([#72](https://github.com/noicework/corpuskit/pull/72))
- Search, Ask, typeahead and the Library no longer wait on a slow knowledge box catalogue. Requests share one read per portal, each page gives up after 10 seconds, readers wait at most 10 seconds before going on with the cached or partial listing, and a plain search no longer reads the catalogue at all. ([#72](https://github.com/noicework/corpuskit/pull/72))
- The built-in showcase portals, `marine` and `grains`, are served only on deployments that name them in `SHOWCASE_PORTALS`. See the Upgrade notes. ([#72](https://github.com/noicework/corpuskit/pull/72))
- A deployment with no portals, or none the visitor may see, lists an empty portal list instead of showing an error. ([#72](https://github.com/noicework/corpuskit/pull/72))

### Fixed

- A strained or rate-limited maintenance pass no longer stores empty suggested questions, and a source page that met a rate limit or a server error stays unsynced for the next run. ([#72](https://github.com/noicework/corpuskit/pull/72))
- A document hidden, deleted or added while the catalogue was being read no longer reappears in the Library, typeahead, or identifier and author lookups for another minute. ([#72](https://github.com/noicework/corpuskit/pull/72))
- A stray record stored under a showcase slug is never served as a portal of its own. ([#72](https://github.com/noicework/corpuskit/pull/72))

### Security

- Anonymous rate limits key on the address the runtime reports, `cf-connecting-ip` on Cloudflare and the connecting peer on the local server, with IPv6 addresses grouped by /64. ([#72](https://github.com/noicework/corpuskit/pull/72))
- Each public portal has a ceiling on anonymous asks per minute from every address together, with a per-address share, and a refused ask gives its turn back. A cross-portal ask counts against every portal it reaches. ([#72](https://github.com/noicework/corpuskit/pull/72))
- Break-glass passcode sign-in works only with `ADMIN_BREAK_GLASS=true`, in every environment. ([#72](https://github.com/noicework/corpuskit/pull/72))

### Upgrade notes

- **`ADMIN_BREAK_GLASS=true` is now required for passcode sign-in, in every environment.** Before, a passcode was enough wherever `ENVIRONMENT` was not exactly `production`. A deployment that relied on that loses passcode sign-in until it sets the flag. Both servers warn at start-up when a passcode is set without the flag, and never log the value. A deployment that follows the documented procedure, setting both together and removing both afterwards, is unaffected. ([#72](https://github.com/noicework/corpuskit/pull/72))
- **`SHOWCASE_PORTALS` is off by default.** Set `SHOWCASE_PORTALS=marine,grains` to keep serving the showcase portals; the reference configurations for corpuskit.org and its demo set it. Unset, their slugs answer like any unknown slug everywhere. What they stored is kept, and returns when they are named again, and a showcase slug is never given to a new portal. Entries that are not showcase portals are ignored with a start-up warning. ([#72](https://github.com/noicework/corpuskit/pull/72))
- **`TRUST_PROXY_HOPS`** (local server only, unset by default): how many reverse proxies in front of the server append to `x-forwarded-for`. Unset or 0 keys every client on its connecting address, so behind a proxy every caller shares the proxy's limits. Set it to the number of proxies you run, never more. The Worker always uses `cf-connecting-ip`, and `fly-client-ip` is no longer read. ([#72](https://github.com/noicework/corpuskit/pull/72))
- **`RATE_LIMIT_ANON_PORTAL_ASK_PER_MIN`** (default 30, 0 disables): anonymous asks per minute on each portal, from every address together, including anonymous MCP `answer_question` calls. Signed-in people and portal keys are exempt. ([#72](https://github.com/noicework/corpuskit/pull/72))
- **`RATE_LIMIT_ANON_ADDRESS_ASK_PER_MIN`** (default 10, 0 disables): one address's share of those asks on each portal. Keep it below the portal ceiling. ([#72](https://github.com/noicework/corpuskit/pull/72))
- The Worker now reads `RATE_LIMIT_ASK_PER_MIN_IP`, the per-address limit, which defaults to five times `RATE_LIMIT_ASK_PER_MIN`. ([#72](https://github.com/noicework/corpuskit/pull/72))
- **Rollback to 2026.9.27 is safe, with effects.** Nothing stored changes, and rate-limit counts live in memory. While 2026.9.27 runs: ([#72](https://github.com/noicework/corpuskit/pull/72))
  - a passcode works as break-glass wherever `ENVIRONMENT` is not exactly `production`, so remove the passcode or set `ENVIRONMENT=production` before rolling back;
  - anonymous rate limits key on headers a caller can set;
  - the showcase portals are served on every deployment, and the nightly pass reaches them;
  - one portal's failure stops the nightly pass for the portals after it.

## [2026.9.27] - 2026-09-27

Adding documents is obvious and safe, managers can delete a document, and hidden drafts stay out of readers' view. Search shows the same trust signals as Ask, and curators see why a job failed and which answers readers marked unhelpful.

### Added

- **Delete a document.** Managers with `content.write` can delete a document, published or a hidden draft, from Recent additions, Corpus health or the document page. One confirmation names the document and says what the delete removes, and the outcome is announced. ([#69](https://github.com/noicework/corpuskit/pull/69))
  - The delete removes the document's stored bytes and counts, its enrichments and cached suggested questions, and its entries in the catalogue, search, summary, facet and entity caches.
  - Investigation evidence, sessions and watches are kept. Evidence from a deleted document shows "No longer in the Library" with its passage and notes.
  - A source sync does not bring a deleted page back, because a source skips the URLs it has already ingested. `docs/HOSTING.md` lists the cases that do re-add one.
  - If a delete fails part-way, deleting again finishes it without counting anything twice.
  - The API is `DELETE /api/admin/t/:slug/resources/:id`, audited as `resource.delete`. There is no MCP delete tool.
- **"Add documents" wherever you need it.** The Library header, empty states, the Manage overview and the portal home all lead to adding documents. The Content tab's add panel is open by default, with a drop zone and multi-file select. ([#68](https://github.com/noicework/corpuskit/pull/68))
- Each file being added gets a status row: real upload progress, then processing, ready, or failed with the exact reason. Counts refresh without a reload. ([#68](https://github.com/noicework/corpuskit/pull/68))
- Recent additions always lists stuck links, so a curator can delete them and free their space. ([#69](https://github.com/noicework/corpuskit/pull/69))
- Curators see the answers readers marked unhelpful: Insights gains "Answers marked unhelpful", with the reader's comment and an "Ask again" link, for people with `content.write`. A rating is still forwarded to the knowledge box unchanged. ([#71](https://github.com/noicework/corpuskit/pull/71))

### Changed

- Search shows the same trust signals as Ask: confidence, citation markers, marks on unverified figures, the audit badge and the truncation notice. The same answer now reaches the same confidence on both pages. ([#71](https://github.com/noicework/corpuskit/pull/71))
- Curators see the real reason a source sync, enrichment or knowledge graph job failed, with the server's own message and code, instead of a generic error. ([#71](https://github.com/noicework/corpuskit/pull/71))
- On a portal's own colours, accent text is deepened to at least 4.5:1 contrast, text on the accent is chosen by contrast, and focus indicators reach at least 3:1. The Ask, Search and "Ask this document" fields gain a visible focus ring, and focus stays visible in forced-colours mode. New portals start on the `corpuskit` palette. ([#71](https://github.com/noicework/corpuskit/pull/71))
- On portals with a byte limit, a crawled link whose size cannot be read up front is admitted against a provisional reservation and measured once it is processed. An add that does not fit is refused with a distinct reason: `413 limit_exceeded` for a real overflow, `503 links_pending` when it would fit once waiting links are measured, and `413 links_stuck` when a link could not be processed. ([#68](https://github.com/noicework/corpuskit/pull/68))
- An upload, link or text add stays in flight through an access check, and its result is shown only if the same person still has the same access to the same portal. If someone else signs in, unfinished uploads end as "Upload interrupted, choose the file again." ([#68](https://github.com/noicework/corpuskit/pull/68))
- Unpublishing a cited document no longer blocks judging, removing or referencing its evidence in an investigation, and synthesis skips evidence it cannot read. ([#68](https://github.com/noicework/corpuskit/pull/68))
- The audit viewer shows an action it does not recognise by its name instead of failing the whole log, and it knows the alias, erasure, suspended-delete, lifecycle and external sign-in actions. ([#69](https://github.com/noicework/corpuskit/pull/69))

### Fixed

- Reingesting a draft keeps it hidden. ([#68](https://github.com/noicework/corpuskit/pull/68))
- On phones, the Knowledge map title sits clear of the header. ([#70](https://github.com/noicework/corpuskit/pull/70))

### Security

- Readers can no longer see hidden drafts. Catalogue listings and index facets ask the knowledge box for published resources only and drop any hidden row, and every reader route and the MCP `get_document` tool answer 404 for a draft. ([#68](https://github.com/noicework/corpuskit/pull/68))
- A draft is created hidden and confirmed hidden, or rolled back: `409 draft_unavailable`, or `502 draft_not_hidden` if the rollback also fails. ([#68](https://github.com/noicework/corpuskit/pull/68))
- Reader feedback is rate-limited per address and portal, bounded in size, and covered by portal erasure. ([#71](https://github.com/noicework/corpuskit/pull/71))

### Upgrade notes

- **New setting `LINK_PROVISIONAL_BYTES`** (default 10485760, which is 10 MiB): the bytes a crawled link holds against a portal's byte limit until it is measured. It matters only for portals with a byte limit. Stuck and unmeasured links keep counting, so the limit fails closed; delete a stuck link to free its space. ([#68](https://github.com/noicework/corpuskit/pull/68))
- `GET /api/admin/t/:slug/usage` now reports `bytes` as measured, stored bytes only. Its keys are unchanged. ([#68](https://github.com/noicework/corpuskit/pull/68))
- If a knowledge box refuses hidden resources, the first draft created there turns them on for that box, recorded as the audited sub-action `tenant.hidden_resources.enable`, or answers 409. A draft is never added as a published resource. ([#68](https://github.com/noicework/corpuskit/pull/68))
- The recent-additions route takes a bounded `?limit`. ([#68](https://github.com/noicework/corpuskit/pull/68))
- Portals on their own colours may see link and accent text darken slightly. Nothing stored changes. ([#71](https://github.com/noicework/corpuskit/pull/71))
- Reader ratings are stored as one row per answer, at most 500 per portal, kept for 90 days and purged by daily maintenance. ([#71](https://github.com/noicework/corpuskit/pull/71))
- **Rollback to 2026.9.26 is safe, with effects.** Deleted documents stay deleted. While 2026.9.26 runs: ([#68](https://github.com/noicework/corpuskit/pull/68), [#69](https://github.com/noicework/corpuskit/pull/69), [#71](https://github.com/noicework/corpuskit/pull/71))
  - A portal with a byte limit whose capacity ledger holds a crawled link in flight, being measured or stuck refuses every add and usage read, because 2026.9.26 cannot read that ledger. Before rolling back, let such links finish measuring and delete stuck ones, or stay on 2026.9.27.
  - Readers can see hidden drafts again, because 2026.9.26 has no hidden-draft filter.
  - The audit viewer cannot show a log page that includes an action it does not know, such as `resource.delete`.
  - Reader ratings stay in their new `answer_feedback` table, which 2026.9.26 never reads, so they are not purged after 90 days and portal erasure does not remove them. Upgrading again resumes both.

## [2026.9.26] - 2026-09-26

Portals can be served on their own hostnames, and a hosting operator can retire and erase finished portals.

### Added

- **Portal host aliases.** A hosting operator can serve a portal on hostnames outside the platform domain, such as `research.example.org`. On an alias host a request reaches that portal only: other portals, platform routes and platform pages answer 404. A primary alias becomes the portal's canonical hostname. `GET`, `PUT` and `DELETE /api/admin/t/:slug/aliases` list, register and remove aliases, with the operator credential or a platform role. ([#64](https://github.com/noicework/corpuskit/pull/64))
- **Erase a deleted portal's records.** `POST /api/admin/tenants/:slug/erase` permanently deletes everything stored under a retired slug, including research sessions, investigations, the ask log, audit events with member identities, branding and enrichments. It keeps only the retired slug and the erasure's own audit line, refuses a live portal with `409 portal_active`, and is safe to repeat. ([#67](https://github.com/noicework/corpuskit/pull/67))
- **Operator delete of long-suspended portals.** `POST /api/admin/tenants/:slug/delete-suspended` deletes a portal that has been suspended without a break for `OPERATOR_DELETE_AFTER_DAYS`, and `?erase=true` erases it in the same call. The lifecycle routes report `suspendedSince`. ([#67](https://github.com/noicework/corpuskit/pull/67))
- `docs/HOSTING.md` gains "Portal host aliases" and "Deleting and erasing portals", including what erasure cannot reach and a retention recipe. ([#64](https://github.com/noicework/corpuskit/pull/64), [#67](https://github.com/noicework/corpuskit/pull/67))

### Changed

- Explore shows the regional discovery band only on portals that set `regionalDiscovery: true`. The showcase portals set it in their seeds. ([#63](https://github.com/noicework/corpuskit/pull/63))
- The palette made for the branded demonstration portal is offered only to a portal already using it. ([#63](https://github.com/noicework/corpuskit/pull/63))
- A failed administration request says what happened instead of showing a machine code or "Request failed", and an account without the permission is told so. ([#66](https://github.com/noicework/corpuskit/pull/66))
- Deleting a portal detaches only its own hostname, never an alias. ([#64](https://github.com/noicework/corpuskit/pull/64))

### Fixed

- Document, logo, hero and font uploads work again when a file is chosen from the file picker. The focus the picker hands back had withdrawn access between choosing the file and uploading it. ([#66](https://github.com/noicework/corpuskit/pull/66))
- Automatic portal hostnames work on Cloudflare Workers. ([#62](https://github.com/noicework/corpuskit/pull/62))
- Deleting a portal no longer reports `domain_removal_failed` when Cloudflare confirms the hostname removal with an empty body. ([#65](https://github.com/noicework/corpuskit/pull/65))

### Security

- A session issued on an alias or any other host outside the platform domain is sealed to that host and read nowhere else, and platform sessions are not read there. ([#64](https://github.com/noicework/corpuskit/pull/64))
- Platform roles carry no authority on an alias host. Only the person's own grants in that portal count, and the break-glass passcode is ignored there. ([#64](https://github.com/noicework/corpuskit/pull/64))
- External sign-in assertions can carry a `host` claim binding them to one hostname. Alias and other candidate hosts require it. ([#64](https://github.com/noicework/corpuskit/pull/64))
- A host lookup that fails or times out answers `503 host_lookup_failed` rather than serving the host as unregistered. ([#64](https://github.com/noicework/corpuskit/pull/64))
- `UNKNOWN_HOSTS=deny` answers 404 on any host that is not the platform domain, a platform subdomain, a registered alias or a reserved hostname. ([#64](https://github.com/noicework/corpuskit/pull/64))
- A session refused because it is sealed to another host is audited as `request.denied` with `session_host_mismatch`. ([#64](https://github.com/noicework/corpuskit/pull/64))

### Upgrade notes

- **Before upgrading, list every custom domain outside the platform domain in `RESERVED_HOSTNAMES`.** An unlisted one becomes a candidate host: the Worker looks it up, answering 503 when the lookup fails, seals its sessions to it so people sign in once more, requires a `host` claim for external sign-in there, and drops `includeSubDomains` from its HSTS. The hosts of `ENTRA_REDIRECT_URI` and `EXTERNAL_LOGIN_START_URL` are reserved automatically. ([#64](https://github.com/noicework/corpuskit/pull/64))
- **Self-hosting on a hostname outside `PLATFORM_DOMAIN`** (default `corpuskit.org`): set `PLATFORM_DOMAIN` to your own domain, or list your hostname in `RESERVED_HOSTNAMES`. ([#64](https://github.com/noicework/corpuskit/pull/64))
- New settings, each safe to leave unset: `MAX_PORTAL_ALIASES` (default 5, 0 refuses new aliases), `ALIAS_CACHE_SECONDS` (default 30, 0 turns the cache off), `UNKNOWN_HOSTS` (`serve` by default, or `deny`), `RESERVED_HOSTNAMES` (empty), `EXTERNAL_LOGIN_REQUIRE_HOST` (off) and `OPERATOR_DELETE_AFTER_DAYS` (unset, which turns operator delete off). ([#64](https://github.com/noicework/corpuskit/pull/64), [#67](https://github.com/noicework/corpuskit/pull/67))
- A deployment that routes hostnames it does not control must run with `UNKNOWN_HOSTS=deny`, `EXTERNAL_LOGIN_REQUIRE_HOST=true` and `RESERVED_HOSTNAMES`. Start-up warnings name each missing setting. A deployment that uses no aliases can set `MAX_PORTAL_ALIASES=0`. ([#64](https://github.com/noicework/corpuskit/pull/64))
- Sessions issued on hosts outside the platform domain before this release carry no host, so those people sign in once more. ([#64](https://github.com/noicework/corpuskit/pull/64))
- A reserved hostname that still carries an alias record refuses sign-in with `409 host_conflict`. Remove the alias first. ([#64](https://github.com/noicework/corpuskit/pull/64))
- A portal other than the showcase portals that relied on the regional discovery band must now set `regionalDiscovery: true` through `PATCH /api/admin/tenants/:slug`, which needs `behaviour.write`. Assigning the unlisted palette to another portal answers `400 palette_not_available`. ([#63](https://github.com/noicework/corpuskit/pull/63))
- Aliases are stored with the portal registry. When a suspension began is kept in a companion record, so the lifecycle record stays readable by 2026.9.25; suspensions from before this release count from the lifecycle's last change. ([#64](https://github.com/noicework/corpuskit/pull/64), [#67](https://github.com/noicework/corpuskit/pull/67))
- **Rollback to 2026.9.25 is safe, with effects.** That release ignores aliases, so it serves alias hosts as ordinary hosts, and its next portal registry write drops the stored aliases. It also reads a session sealed to a host on every host, so a cookie taken from an alias host would work on the platform hosts. Stop routing alias hostnames before rolling back, rotate `SESSION_SECRET` if anyone else controlled one (this signs everyone out), and register the aliases again after upgrading. Erasure is permanent, and no rollback restores what it removed. ([#64](https://github.com/noicework/corpuskit/pull/64), [#67](https://github.com/noicework/corpuskit/pull/67))

## [2026.9.25] - 2026-09-25

Optional hosting hooks for deployments that serve portals for several organisations. Each hook is off unless configured, and a deployment that uses none of them behaves as before. `docs/HOSTING.md` documents all of them.

### Added

- **Knowledge box credential encryption.** With `BINDING_KEY` set, stored knowledge box tokens are sealed with AES-256-GCM and bound to their portal. ([#61](https://github.com/noicework/corpuskit/pull/61))
- **Configurable platform domain.** `PLATFORM_DOMAIN` drives redirects, cookie scope, sign-in return URLs and hostname automation, and one web bundle serves any domain. ([#61](https://github.com/noicework/corpuskit/pull/61))
- **Operator credential.** Hosting automation sends `Authorization: Operator` with `OPERATOR_API_KEY` to call an explicit list of admin routes as a `platform-admin`, never as `owner`. Every call is audited. ([#61](https://github.com/noicework/corpuskit/pull/61))
- **Portal lifecycle, limits and usage.** A portal can be `active`, `read_only` or `suspended`, with optional limits on documents, bytes, asks per day and agents, and a usage endpoint. Long enrichment and question runs stop part-way when a portal is suspended. ([#61](https://github.com/noicework/corpuskit/pull/61))
- **External sign-in.** A deployment can trust an outside identity issuer, alongside Microsoft Entra or instead of it, through short-lived, single-use Ed25519 assertions at `/auth/external`. ([#61](https://github.com/noicework/corpuskit/pull/61))
- A second branded demonstration portal on the demo deployment, built on the documentation knowledge base with a source notice on every page, its own navigation, hero and footer, and light and dark modes. ([#58](https://github.com/noicework/corpuskit/pull/58), [#59](https://github.com/noicework/corpuskit/pull/59))

### Security

- SVG branding uploads are refused, and branding assets, thumbnails and knowledge box files other than PDFs are served sandboxed. ([#61](https://github.com/noicework/corpuskit/pull/61))
- Deleting a portal retires its slug and revokes its members and keys. ([#61](https://github.com/noicework/corpuskit/pull/61))
- Audit writes from failed external sign-ins are capped. ([#61](https://github.com/noicework/corpuskit/pull/61))

### Upgrade notes

- **On Cloudflare, set `BINDING_KEY` before upgrading**: the standard base64 encoding of 32 random bytes. Without it, connecting or replacing a knowledge box answers `503 binding_key_missing`, while existing bindings keep working. The local server stores new tokens as plaintext without a key, and warns at start-up. A malformed key answers `503 binding_key_invalid` on every API request until it is corrected. ([#61](https://github.com/noicework/corpuskit/pull/61))
- **Seal existing tokens as a separate step.** Once this release has deployed and passed verification, set `BINDING_KEY_MIGRATE=true`, then check that `bindingEncryption.plaintext` and `unavailable` are both 0 in the admin overview. Sealing waits for a verified release so that an automatic rollback never meets tokens it cannot read. ([#61](https://github.com/noicework/corpuskit/pull/61))
- `/api/health` gains a coarse `bindingsReady` flag, always present on Cloudflare and elsewhere only when false. ([#61](https://github.com/noicework/corpuskit/pull/61))
- New optional settings, all off unless set: `PLATFORM_DOMAIN` (default `corpuskit.org`), `OPERATOR_API_KEY` and `OPERATOR_ID` (default `operator`), and `EXTERNAL_LOGIN_ISSUER`, `EXTERNAL_LOGIN_JWK`, `EXTERNAL_LOGIN_NAME` and `EXTERNAL_LOGIN_START_URL`. Changing `PLATFORM_DOMAIN` does not move DNS routes or carry sessions across. ([#61](https://github.com/noicework/corpuskit/pull/61))
- Email assignments are now bound to their identity source. An atomic migration marks existing assignments as Entra. ([#61](https://github.com/noicework/corpuskit/pull/61))
- **Rollback to 2026.9.17 is not safe once any token is sealed:** that release would send the sealed token as the credential. Once external sign-in has created assignments, do not roll back to a release that ignores their identity source, even with external sign-in turned off; prefer a forward fix. Before either, rolling back has effects: 2026.9.17 ignores portal status and limits, so suspended and read-only portals serve and accept changes again, and its next portal registry write forgets retired slugs, so a new portal could take a deleted portal's slug and the records still stored under it. ([#61](https://github.com/noicework/corpuskit/pull/61))

## [2026.9.17] - 2026-09-17

Research sessions load again on Cloudflare, and the edge refuses probes.

### Added

- The About page gains an At a glance section and detail points under every feature. ([#50](https://github.com/noicework/corpuskit/pull/50))
- A real `robots.txt` keeps crawlers off `/api/`, `/auth/` and `/admin`. ([#56](https://github.com/noicework/corpuskit/pull/56))
- Tooling to apply and verify WAF custom rules that block the same probes before they reach the Worker. ([#56](https://github.com/noicework/corpuskit/pull/56))

### Changed

- A path the app does not know answers 404 with the app's not-found page, and a write to a page or asset answers 405. ([#56](https://github.com/noicework/corpuskit/pull/56))
- For contributors: the browser screenshot matrix is opt-in (`deno task test:e2e:visual`, or the Visual matrix workflow), and the CI gate runs on pull requests only, since the deploy workflow gates every push to `main`. ([#51](https://github.com/noicework/corpuskit/pull/51), [#55](https://github.com/noicework/corpuskit/pull/55))

### Fixed

- Ask sessions and investigations load again on Cloudflare. Listing them failed with a SQLite pattern error once a portal had stored any. ([#53](https://github.com/noicework/corpuskit/pull/53))
- Search and Library facet rails show counts on portals that do not define every rail's label set. ([#52](https://github.com/noicework/corpuskit/pull/52))

### Security

- Requests for secrets, server scripts and archives, such as `/.env` or `/wp-admin/install.php`, get a plain 404 before any asset lookup. ([#56](https://github.com/noicework/corpuskit/pull/56))
- Every response carries HSTS and `frame-ancestors 'none'`, pages and assets included. ([#56](https://github.com/noicework/corpuskit/pull/56))

### Upgrade notes

- An unknown path now answers 404. Monitors should check `/api/health` rather than an arbitrary page. ([#56](https://github.com/noicework/corpuskit/pull/56))
- No settings or stored data change, so rolling back to 2026.9.13 is safe.

## [2026.9.13] - 2026-09-13

Role-based access control reaches every route and screen, and the documentation goes public.

### Added

- **Portal access modes.** `public`, `authenticated` (anyone signed in to the configured Microsoft Entra tenant can read) or `restricted` (people with an explicit role only), changed through an audited `PATCH /api/admin/t/:slug/access`. Visitors without access see only the portal's name, logo and colours. ([#43](https://github.com/noicework/corpuskit/pull/43))
- **Scoped keys.** `ck_` keys for MCP and portal data routes, bound to one portal and a role no higher than their creator's, hashed at rest, shown once, with optional expiry and revocation. ([#43](https://github.com/noicework/corpuskit/pull/43))
- **Access panel** under Manage for members, group mappings, the access mode and scoped keys, a platform **People** page for owners and platform administrators, and an **audit viewer** with filters and CSV or JSON export. ([#48](https://github.com/noicework/corpuskit/pull/48))
- Role-aware screens: controls a person cannot use are not shown, the account menu shows their role in each portal, and a visitor to a portal they cannot read is asked to sign in or told they have no access. ([#48](https://github.com/noicework/corpuskit/pull/48))
- **Public documentation at corpuskit.org/docs**, generated from the same content as the in-app Help. ([#47](https://github.com/noicework/corpuskit/pull/47))
- An About page with the feature catalogue. ([#46](https://github.com/noicework/corpuskit/pull/46))

### Fixed

- Public portals work on deployments without Microsoft Entra configuration. ([#45](https://github.com/noicework/corpuskit/pull/45))

### Security

- Every API route and MCP tool declares its permission and scope and is authorised before its handler runs. An undeclared route fails the test suite instead of defaulting to allow. ([#43](https://github.com/noicework/corpuskit/pull/43))
- Responses that depend on who is asking are sent `private, no-store`. ([#43](https://github.com/noicework/corpuskit/pull/43))

### Upgrade notes

- Existing portals stay `public`, so anonymous browsing, search and Ask are unchanged. ([#43](https://github.com/noicework/corpuskit/pull/43))
- Existing MCP keys migrate additively to viewer keys, and a key whose creator cannot be verified stays inert. ([#43](https://github.com/noicework/corpuskit/pull/43))
- Signed-in people own their sessions, investigations and watches by account, and anonymous browsers by client id on public portals only. Nothing is adopted at sign-in. ([#43](https://github.com/noicework/corpuskit/pull/43))
- Group mappings stay disabled in the Access panel until a deployment verifies that its identity provider sends group claims. ([#48](https://github.com/noicework/corpuskit/pull/48))

## [2026.9.12] - 2026-09-12

The foundations of role-based access control: signed identity, role assignments, an audit log and an audited break-glass.

### Added

- **Roles.** Platform roles `owner` and `platform-admin`, and portal roles `viewer`, `analyst`, `curator` and `portal-admin`, over 22 permissions, evaluated deny-by-default. ([#41](https://github.com/noicework/corpuskit/pull/41))
- **Role assignments** from Microsoft Entra app roles, group mappings and local assignments. The highest role wins in each scope, with where it came from kept. An email assignment binds when that person first signs in, and `/auth/me` reports effective roles per portal. ([#42](https://github.com/noicework/corpuskit/pull/42))
- **Audit log.** Every privileged action and every refusal is recorded, redacted before it is written. ([#42](https://github.com/noicework/corpuskit/pull/42))

### Security

- Identity passes from the Worker to the Durable Object in a signed, short-lived envelope, and caller-supplied identity headers are stripped. ([#42](https://github.com/noicework/corpuskit/pull/42))
- The admin passcode becomes an audited break-glass that grants owner, locks for ten minutes after five failures from one address, and is no longer stored in the browser. ([#42](https://github.com/noicework/corpuskit/pull/42))
- A request whose mandatory audit write fails is answered with an error. ([#42](https://github.com/noicework/corpuskit/pull/42))

### Upgrade notes

- In production, break-glass works only with `ADMIN_BREAK_GLASS=true` beside `ADMIN_PASSCODE`. ([#42](https://github.com/noicework/corpuskit/pull/42))
- `WORKER_NAME` is the signing audience between the Worker and the Durable Object, and the reference configurations set it. The envelope key is derived from `SESSION_SECRET`. ([#42](https://github.com/noicework/corpuskit/pull/42))
- `AUDIT_RETENTION_DAYS` (default 400) sets how long audit events are kept. ([#42](https://github.com/noicework/corpuskit/pull/42))
- `ENTRA_ADMIN_EMAILS` is migrated once, additively, into owner assignments, and the `CorpusKit.Admin` app role maps to `platform-admin`. ([#42](https://github.com/noicework/corpuskit/pull/42))

## [2026.9.11] - 2026-09-11

Answers you can check: sentence-level citations, a figure audit, intent routing and model-written footnotes.

### Added

- **Answer trust layer.** Ask binds each sentence to its citations, audits and gates figures, flags second-hand claims, answers with the authors in mind, grounds entities and streams the first verified sentence early. See `docs/TRUST-LAYER.md`. ([#20](https://github.com/noicework/corpuskit/pull/20))
- **Footnote citations.** Answers carry footnotes written by the model and checked against the passages it was given, failing closed when a footnote cannot be verified. Short paragraphs with the same support share one footnote group. ([#35](https://github.com/noicework/corpuskit/pull/35), [#38](https://github.com/noicework/corpuskit/pull/38), [#39](https://github.com/noicework/corpuskit/pull/39))
- **Intent routing**, opt-in per portal: rules and a classifier choose a stored search configuration for each kind of question, with a routing log and a Behaviour panel under Manage. See `docs/INTENT-ROUTING.md`. ([#20](https://github.com/noicework/corpuskit/pull/20))
- Library and Search: exact identifier and author lookups, bibliographic bylines, format facets, a published-date sort, and honest untagged and passage-level counts. ([#20](https://github.com/noicework/corpuskit/pull/20))
- Briefings and assessments grounded section by section, with an audit and a reference list, a synthesis check on investigations, and Word export. ([#20](https://github.com/noicework/corpuskit/pull/20))
- The Extraction Lab, a How this works page, a header help menu and dark mode in the document viewer. ([#20](https://github.com/noicework/corpuskit/pull/20))
- A documentation demonstration portal at demo.corpuskit.org, deployed as its own Worker with its own state, with a `corpuskit` palette and type pairing that match the project site. ([#23](https://github.com/noicework/corpuskit/pull/23), [#24](https://github.com/noicework/corpuskit/pull/24), [#25](https://github.com/noicework/corpuskit/pull/25), [#26](https://github.com/noicework/corpuskit/pull/26))
- Share cards, a favicon and social metadata for corpuskit.org. ([#22](https://github.com/noicework/corpuskit/pull/22))

### Changed

- The navigation follows dark mode, and the grid density slider uses a contrasting accent. ([#27](https://github.com/noicework/corpuskit/pull/27), [#29](https://github.com/noicework/corpuskit/pull/29))
- Inline citations in Ask and Search sit compactly in the text, with accessible source names and visible keyboard focus. ([#40](https://github.com/noicework/corpuskit/pull/40))
- Production deploys wait for a live search, cited answer and refusal on the demo portal, and a failed post-deploy check restores the exact previous Worker version without touching stored data. ([#34](https://github.com/noicework/corpuskit/pull/34), [#37](https://github.com/noicework/corpuskit/pull/37))

### Fixed

- Search no longer fails when a resource carries a summary that is not text. ([#21](https://github.com/noicework/corpuskit/pull/21))
- A facet for a label set the knowledge box does not have is refused cleanly. ([#30](https://github.com/noicework/corpuskit/pull/30))
- The knowledge graph includes imported relationships. ([#31](https://github.com/noicework/corpuskit/pull/31))
- Documents keep the spacing between their Markdown blocks. ([#32](https://github.com/noicework/corpuskit/pull/32))
- A "not enough context" reply from the rephrase step no longer appears as the interpreted question. ([#24](https://github.com/noicework/corpuskit/pull/24))

### Upgrade notes

- Intent routing is off unless a portal configures it. On Cloudflare the routing log has its own Durable Object table, capped at 5,000 decisions per portal. ([#20](https://github.com/noicework/corpuskit/pull/20))
- Model-written footnotes are the citation mode for every prose answer on a deployment, with a 4,096-token default budget for the trailing definitions. ([#38](https://github.com/noicework/corpuskit/pull/38))

## [2026.9.5] - 2026-09-05

The first public release of CorpusKit, an open source research portal you point at an empty Progress Agentic RAG knowledge box.

### Added

- The portal: Explore, Search, Ask, Library, the knowledge graph, Investigations, Tools and Manage, provisioned with a taxonomy, knowledge graph, labels, agents and suggested questions designed around the corpus, and two fictional showcase portals seeded from `content/seed`.
- Cards on Search, the Library and topic rows show the platform's page summary when a resource has no generated enrichment yet, instead of a bare project code. ([#12](https://github.com/noicework/corpuskit/pull/12))
- A label-set editor under Manage, Taxonomy: a title, one value or several, and a definition for each label. Saving a set restarts the labellers that carry it, for new resources only. ([#13](https://github.com/noicework/corpuskit/pull/13))
- Create a label set, with its definitions, from the Taxonomy panel, including as an administrator signed in with Microsoft. ([#15](https://github.com/noicework/corpuskit/pull/15))

### Changed

- The Taxonomy tab is one container with flat sections and less help text. The explanation moved to the in-app Help. ([#17](https://github.com/noicework/corpuskit/pull/17))

### Fixed

- A passage that is one long unbreakable token, such as a bare URL, wraps inside its quote at large text sizes instead of widening the page on a phone. ([#12](https://github.com/noicework/corpuskit/pull/12))
- The post-deploy domain check reads its hostnames from `wrangler.jsonc`, so it checks exactly the domains the deploy attaches. ([#16](https://github.com/noicework/corpuskit/pull/16))

### Upgrade notes

- `POST /api/admin/t/:slug/labelsets` also accepts labels as `{ title, text }` objects, and plain strings still work. The new `PUT /api/admin/t/:slug/labelsets/:id` replaces a set and restarts its labellers. If a replacement labeller cannot start, the route answers 502 with the removed labeller's configuration so it can be restored by hand. ([#13](https://github.com/noicework/corpuskit/pull/13), [#15](https://github.com/noicework/corpuskit/pull/15))

[Unreleased]: https://github.com/noicework/corpuskit/compare/v2026.9.27.1...HEAD
[2026.9.27.1]: https://github.com/noicework/corpuskit/compare/v2026.9.27...v2026.9.27.1
[2026.9.27]: https://github.com/noicework/corpuskit/compare/v2026.9.26...v2026.9.27
[2026.9.26]: https://github.com/noicework/corpuskit/compare/v2026.9.25...v2026.9.26
[2026.9.25]: https://github.com/noicework/corpuskit/compare/v2026.9.17...v2026.9.25
[2026.9.17]: https://github.com/noicework/corpuskit/compare/v2026.9.13...v2026.9.17
[2026.9.13]: https://github.com/noicework/corpuskit/compare/v2026.9.12...v2026.9.13
[2026.9.12]: https://github.com/noicework/corpuskit/compare/v2026.9.11...v2026.9.12
[2026.9.11]: https://github.com/noicework/corpuskit/compare/v2026.9.5...v2026.9.11
[2026.9.5]: https://github.com/noicework/corpuskit/releases/tag/v2026.9.5
