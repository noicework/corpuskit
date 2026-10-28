# Portal backup and restore

The local Deno server and the managed Worker's Durable Object share the portal export and
restore routes. `GET /api/admin/t/:slug/export` downloads a bounded ZIP; `POST
/api/admin/t/:slug/import` restores its portal-owned records into an existing, empty portal.
Neither route requires a new runtime setting or external export service.

## Authority

Export retains portal `audit.export` permission and also accepts the hosting operator
credential. Import requires platform `portal.create` authority (platform administrators and
owners), or the operator credential. Portal administrators and MCP keys cannot import.
Present the operator credential in `Authorization: Operator <credential>` using the existing
`OPERATOR_API_KEY` and `OPERATOR_ID` settings. Actor identity is recorded in both the normal
privileged request audit and `portal.export.bundle` or `portal.import.bundle`.

## What is restored

| Record kind | Behaviour |
|---|---|
| Configuration and branding | Validated tenant appearance, layout, portal topics and labels, language, retrieval/extraction settings, prompts and disabled flag. Uploaded logos, images and fonts are embedded as base64 and restored. The destination keeps its hostname and aliases. |
| Hosting lifecycle | Status and configured limits. In-flight reservations, ask admissions, pending deletions, activity and capacity ledgers are not replayed. |
| Enrichments | Generated resource enrichments and cached suggested questions, with schema/resource identities. |
| Research artefacts | Sessions, investigations and watches, retaining their signed or anonymous owner namespace. Proven legacy anonymous records are converted to the current owned format. Signing in does not adopt anonymous records. |
| Evaluations | Definitions and retained results. An interrupted running evaluation becomes failed. Scheduling definitions remain in the bundle for review, but delegations are not activated: re-authorise schedules after recovery. |
| Duplicate decisions | Review decisions and original review times. |
| Answer records | Retained evidence records and their retention setting, including questions, citations and quality/timing metadata. Existing expiry rules still apply. |
| Insights and routing | The retained usage/event log and routing decisions, rather than only the management summary. |
| Other portal records | Source registry and cursors, link-review decisions, setup suggestions and the last knowledge-graph proposal. Restoring a source does not run its synchronisation during import. |
| Reader feedback | Ratings, comments and portal-team messages only when export explicitly selected `?includeFeedback=true`. Existing retention applies. |
| Audit history | Appended to destination history, never substituted for it. Copied events carry `restored: true`, `bundleId`, `originalEventId` and `restoredFromPortal`. Original actor, action, time and redacted details remain available. |

The JSON response supplies `counts` per record kind, `alreadyImported`, and
`knowledgeBoxRestored: false`. Collections count their contained records; enrichments count
schema/resource pairs, not containing files. Audit counts exclude the new import receipt and
normal request audit. Scheduling delegations count zero because they are not activated.

## What is not restored

**Knowledge-box content is never restored.** Documents, document bytes, extracted text,
provider-managed labelsets/resource labels, indexes, agents and stored search configurations
remain with the retrieval provider. `resources.json` and `labelsets.json` are inventories for
reconciliation, not instructions that import sends to a provider. Portal-owned topics and
labels in configuration and suggestions are restored. Import makes no provider write.

Bindings, sealed credentials, environment settings, cookies, authentication sessions, MCP key
material, member assignments, group mappings, hostname/domain attachments and deployment files
are not restored. `mcp-keys.json` contains administrative inventory metadata only, never usable
keys. Provision/reconnect bindings and grant access separately; verify the destination provider
against the document inventory. Browser owners and directory user identifiers must still exist
for restored private artefacts to be reachable. This does not grant their owners a portal role.

This is the first portal-state restore slice. It does not rebuild an empty knowledge box or
replay provider-managed taxonomy. Bundles created before `restoreVersion: 1` lack the research
records and integrity inventory needed for recovery and are refused; create a fresh backup
with this release before relying on restore.

## Daily backup procedure and RPO

1. Schedule a backup at least daily from the platform origin with the operator credential.
   Request `/api/admin/t/<slug>/export?includeFeedback=true` if the recovery policy includes
   reader messages. Without that selection feedback is deliberately omitted.
2. Require HTTP 200, a complete ZIP, `schemaVersion: 1`, `restoreVersion: 1`, and the expected
   portal slug. Keep only successful complete bundles. A failed or rate-limited download is
   not that day's backup; alert and retry it. Export admits two attempts per portal per minute.
3. Store each completed ZIP in operator-controlled backup storage, restrict access and apply
   the agreed retention period. It contains research questions and personal data. The portal
   retains no downloaded copy and does not schedule or upload backups itself.
4. Separately back up the retrieval provider and maintain a deployment/binding recovery
   procedure. Periodically run the drill below and compare the retained records.

With successful backups no more than 24 hours apart, the portal-record **RPO is at most 24
hours**, measured from `manifest.startedAt` in the last successful complete bundle.
Schedule and alert against that capture time; a missed backup extends the window. Stores and
provider inventories are read during export rather than as a single
cross-system snapshot; the bundle does not promise a transactionally consistent provider
snapshot. Provider RPO must be specified separately.

## Recovery drill

1. Provision an empty destination portal, or reset its portal-owned research records through
   a controlled maintenance procedure. Configuration, lifecycle settings, assignments, bindings
   and destination audit history may already exist. Import refuses other occupied targets with
   409 `portal_not_empty`; it is not a merge or overwrite tool. Deleting a portal retires its
   slug, so provision a new destination rather than assuming a retired slug can be reused.
2. Keep the destination isolated from users and source schedulers until verification completes.
   Establish its binding to the retained/recovered provider separately.
3. Send the ZIP bytes with `Content-Type: application/zip` to `POST
   /api/admin/t/<slug>/import`. Do not wrap the ZIP in JSON or multipart data.
4. If restoring another slug, append `?targetSlug=<destination-slug>` to explicitly acknowledge
   the change. It must equal the route slug. Structured portal scope and portal-relative asset
   links are rewritten; arbitrary research prose is not rewritten. Provider resource ids stay
   unchanged.
5. Require 200, `alreadyImported: false`, and compare the returned per-kind counts against
   `manifest.json`'s `counts.restore`. Inspect configuration, branding, private artefacts,
   evidence, evaluation definitions and restored audit markers. Repeating the exact same bundle
   to that destination returns `alreadyImported: true` with zero changed counts.
6. Check provider resource ids and inventory, restore access assignments, re-authorise evaluation
   schedules and run an ordinary search/answer acceptance check before opening to readers.

The importer checks the uncompressed UTF-8 ZIP dialect, central directory, CRC-32, manifest
file inventory, byte lengths, SHA-256 hashes, supported versions, portal scope and record
shapes before writes. Unknown record kinds, duplicate identities, malformed bundles and slug
mismatches are refused. The same 8 MiB export/import limit applies; compression and encrypted
ZIPs are refused. Hashes detect corruption, not the identity of the ZIP's author: import still
requires administrator/operator authority and a trusted backup source.

## Atomicity, idempotency and retained state

The Durable Object commits records, appended audit history, its import receipt and the local
mutation audit in one synchronous SQLite transaction. An audit or storage failure rolls back
that transaction. The Deno adapter uses one SQL transaction and synchronous atomic file
replacements with a flushed write-ahead journal. An exception rolls back SQL and restores the
original file bytes. After process interruption, startup checks the SQL receipt: committed
files stay; uncommitted replacements are restored before requests are served. The temporary
`DATA_DIR/portal-restore-journal.json` is removed after completion/recovery. Do not remove a
pending journal or serve the data directory while recovery is incomplete.

The destination-specific bundle digest is recorded in the existing audit log, with no separate
receipt store or erased record kind. Idempotent acknowledgement lasts while that receipt is
retained under `AUDIT_RETENTION_DAYS`; once it expires an occupied target is still refused.
Normal request auditing occurs even for a repeated import. Restored data follows the existing
retention and portal-erasure inventory. Downloaded backups follow the recipient's policy and
remain outside deployment erasure. Keep disk snapshots consistent with the SQL database and
any pending recovery journal.

## Measured restore time and RTO

Local fixture measurement on 29 October 2026, Deno 2.9.7, a shared development machine:

| Runtime path | Fixture | ZIP bytes | Measured HTTP import |
|---|---|---:|---:|
| Deno DATA_DIR and SQLite | 100 sessions, 100 investigations, 100 answer records, 1,000 enrichments, 500 usage rows, 500 routing rows, 20 duplicate decisions, one evaluation set, configuration/lifecycle and seven audit events | 677,362 | 5.844 seconds |
| Worker ingress and Durable Object SQLite adapter, locally doubled provider | 100 sessions, 100 investigations, 1,000 enrichments, 500 usage rows and configuration/lifecycle | 318,522 | 0.022 seconds |

These samples were rechecked after integrating main `75af3d3e`. The local sample ran alongside
repository test suites; earlier contended runs recorded 17.206 seconds.
These are measured **portal-state restore operation times**, from the import request through
its parsed response. They include validation and persistence. They are not a production
Cloudflare latency measurement or an end-to-end outage RTO. The Worker drill uses a local
DurableObject base-class shim and SQLite backing; it does not execute a hosted deployment.
Recovery-time planning must add
provisioning, provider recovery/reconnection, access setup and acceptance checks; those steps
were not timed. Re-run the drill on the intended hosting platform and record its operational
RTO before making an availability commitment.

`e2e/portal-restore.test.ts` exports, resets and imports the realistic local fixture, compares
records, checks operator audit identity, repeats import, and imports the same local ZIP into
the Durable Object adapter under another slug, then returns a managed bundle to local storage.
The same e2e file also starts the actual Deno server process with loopback-only networking,
imports a doubled-provider bundle and verifies persisted records and idempotency.
`apps/cloudflare/src/operator-integration.test.ts`
exercises export/restore through the real Worker ingress with a doubled retrieval provider.
Unit tests cover malformed ZIPs and manifests, hashes, counts, permission boundaries,
idempotency, required-audit rollback on both adapters and journal recovery after interruption.
No drill calls a real retrieval, hosting or email service.
