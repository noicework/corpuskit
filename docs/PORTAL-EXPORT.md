# Portal export bundle, schema version 1

An administrator can download one portal's inventory and operational context from
`GET /api/admin/t/:slug/export`. The response is an uncompressed UTF-8 ZIP named
`portal-<slug>-export.zip`, with `Cache-Control: private, no-store`.

Sign in as that portal's administrator, then open the URL on the same deployment to download
it. Use the local server's origin for a local drill. The same route and assembly code run
inside the managed Worker's Durable Object. No external export service, job queue, email or
new runtime setting is required. Automated drills use `DoubleProvider` and temporary stores,
with no requests to a live knowledge box.

## Authority and audit

The declaration requires portal-scoped `audit.export`, whose minimum role is `portal-admin`.
Platform administrators and owners also qualify. Reader, analyst and curator roles do not.
MCP keys cannot use this management route, even with a stored `portal-admin` role.
The portal is resolved exclusively from the URL. Existing suspension rules apply: a suspended
portal requires platform authority; a read-only portal remains exportable.

The normal `request.privileged` boundary records intent and completion. Preparation also
records `portal.export.bundle`, with `includeFeedback: false` or `true`, before reading export
data, and again at completion. Neither event records exported text. Required audit writes
must succeed before any ZIP bytes are released. An audit failure produces an error response.

Reader feedback is excluded by default, including ratings. The only option is
`?includeFeedback=true`, which adds `feedback.csv`. It explicitly includes readers' messages
and records that selection in the audit event. `includeFeedback=false` is also accepted.
Duplicate parameters, unknown options and other boolean spellings return 400
`invalid_export_options`. Audit and usage sections may already include actor identities and
questions, so handle downloaded bundles as administrative data.

## Files

| File | Contents |
|---|---|
| `manifest.json` | `schemaVersion: 1`, portal slug, start/end UTC timestamps, `complete: true`, counts, feedback selection, opaque audit snapshot id and expiry, file inventory, limits and scope notes. Byte sizes describe each other file's UTF-8 payload, before ZIP headers. |
| `configuration.json` | `tenant`: validated configuration including branding and branding asset links, layout, terminology/domain terms, topics, suggested questions, access mode, discovery, language, retrieval and extraction settings. `settings`: additional answer instructions, answer guardrails, image grounding, uncited-answer behaviour, disabled flag and hosting lifecycle/limits. Only fields supported by current schemas are exported. |
| `resources.json` | Array of `{resource, metadata, labels, created?, modified?, status?, portalUrl, files}`. `resource` is the typed summary with local merchandising applied; `metadata` is extra metadata after redaction; labels include user and computed resource classifications. Files have `fieldId`, optional `contentType`, and the portal's authenticated proxy `url`. |
| `labelsets.json` | Labelset definitions, labels, cardinality and descriptions. |
| `mcp-keys.json` | Only `id`, `label`, `role`, `createdAt`, `expiresAt`, `revokedAt` and `legacy`. Includes revoked/expired records. No usable key, hash, prefix, issuer or creator claims. |
| `audit.csv` | Retained portal-scoped audit events at the watermark, newest first. Columns: `id,at,request_id,actor_kind,actor_id,actor_label,action,scope_kind,scope_slug,target_kind,target_id,outcome,detail_json`. Platform-scoped events are excluded. |
| `insights.json` | Management's 90-day usage summary, excluding feedback: totals, quality averages, top ten questions, latest 30 gaps and latest 25 asks. This is a summary, not the whole raw ask log. |
| `routing.json` | Retained routing decisions, newest first. Operational tuning records include question hashes and configuration choices; they are distinct from curated evaluation sets. |
| `evaluations.json` | `{status: "unavailable", sets: [], results: [], note: ...}`. This version has no persisted curated evaluation-set or evaluation-result store. Both manifest counts are zero, with an explicit note. |
| `feedback.csv` | Only with the explicit option. Columns: `learningId,good,at,message`. Retained ratings and their comments, subject to the existing 90-day, 500-rating retention. |

Resources are read fresh through `RetrievalProvider.exportResources`, page by page, including
drafts, failed ingests and documentation resources hidden from the reader catalogue.
Missing export support returns 501 `provider_export_unavailable`; there is no incomplete
catalogue fallback. Malformed or repeated provider pages fail the export.

File and branding links served by the portal are deployment-relative and require normal
access. Original document bytes, extracted full text, uploaded branding bytes, research
sessions, investigations, watches, membership assignments and source scheduler state are
outside this format. This is an inventory and review artefact, not an offline replica or
restore/import format. Source names and origin URLs are in each resource summary; additional
source URLs remain in redacted metadata when present.

CSV fields are quoted, quotes escaped, and cells that could be spreadsheet formulas prefixed
with an apostrophe. JSON metadata retains arrays, types and nested objects. UTF-8 byte sizes
and ZIP CRC-32 values describe the redacted file contents.

## Credentials and consistency

The exporter never reads bindings, environment variables, authentication cookies or session
storage. Configuration uses the public tenant schema; key rows use an explicit projection;
provider file pointers become portal links. Credential-named metadata fields are removed
recursively. Recognisable MCP keys, Bearer/Operator credentials, sealed binding values, JWTs
and labelled credentials in text are redacted. URL user information, fragments and credential
or signature query parameters are removed, including storage-signed URL parameters.
Sanitisation can change credential-bearing links; external signed origin URLs may become
unusable.

The audit watermark is fixed before resource retrieval with the existing audit snapshot
mechanism. Completion events are appended after preparation and are available in the normal
audit viewer, correlated by `X-Request-Id`. Provider pages and separate stores are read during
the export, not as one atomic cross-system snapshot. Counts describe included records.
Source errors, cancellation and exceeded bounds produce errors, never a partial ZIP marked
complete.

The manifest exposes only the snapshot's opaque id and expiry. Its internal sequence position
is shared across portals and is deliberately withheld.

## Bounds and retention

- At most two admitted attempts per portal per minute, shared by administrators. Excess
  attempts return 429 `rate_limited` with `Retry-After`.
- One preparation per portal at a time. Another returns 409 `export_in_progress` with
  `Retry-After: 5`.
- At most two preparations across the process or Durable Object at once, bounding memory
  across tenants. Further attempts return 429 `rate_limited` with `Retry-After: 5`.
- Maximum ZIP size: 8 MiB including headers/manifest. Maximum resources: 10,000; audit events:
  20,000; retained routing decisions: 5,000. Exceeding a bound returns 413
  `portal_export_too_large`, without an attachment or silent truncation.
- Existing privileged-operation deadline: 120 seconds. Cancellation reaches provider reads
  and is checked while encoding records.
- Resource input is paged; audit input uses pages of 500; arrays and CSV rows are encoded
  incrementally. A bounded in-memory ZIP spool precedes the required completion audit.
  The resulting Blob supplies the download body. No ZIP is stored in `DATA_DIR`, SQLite or
  object storage. Existing insights/routing adapters still read their own retained logs.

There is no new export store or retention/erasure inventory entry. Audit query snapshots keep
their normal expiry and erasure behaviour. Export audit events follow `AUDIT_RETENTION_DAYS`
and portal erasure. Downloaded copies are outside deployment erasure, as described in the
hosting retention inventory; their recipients control retention.
