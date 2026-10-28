# Duplicate review and collection overlap

Curators and portal administrators open **Manage > Duplicates and versions**. Each candidate
pair shows its metadata, reasons and heuristic score. The score is not a probability or proof of
identical files. Nothing selects a preferred version or removes content automatically.

- **Not a duplicate** remembers that judgement for the pair.
- **Keep both** remembers the choice to retain both resources.
- **Retire one** opens the existing document deletion confirmation for the chosen document.
  This permanently deletes that resource through the existing content management route. Cancelling
  preserves it. Saved research keeps its passages. Retirement is audited as `resource.delete`;
  the remembered decisions are audited as `duplicate.review` and `local.mutation`.

The pending list excludes remembered decisions. **Show reviewed pairs** includes them again and
allows a different judgement. Refreshing preserves the judgements. Decisions are keyed by the
portal and resource ids, so another portal cannot inherit them.

Platform administrators open **Knowledge boxes > Collection overlap** at `/admin`. Each pair of
portals shows counts of matching resource pairs, with examples and links to their source records.
Shared titles, shared URLs and high similarity are overlapping categories, not additive totals.
The CSV contains the current page of collection pairs. Use the page controls to reach and download
the remaining pairs.

## Computation and limits

Only `RetrievalProvider.listResources` is used. There are no generation, embedding, per-resource
retrieval or file download calls. The metadata currently lists no file byte sizes or hashes, so
neither is claimed as evidence. Source file names are compared when present.

Titles are lowercased, accent-folded and stripped of punctuation. Origin URLs retain meaningful
query parameters, sort them and discard fragments and known tracking parameters. File names use
the title normalisation. Adjacent word shingles compare titles and title plus summary text, using
at most 150 words. A similarity candidate needs title Jaccard similarity of at least 0.6 and
combined Jaccard similarity of at least 0.7. Different publication dates are flagged as possible
versions. Scores and reasons describe evidence only.

An inverted title-shingle index avoids a complete Cartesian scan. A computation covers up to
5,000 resources, 50,000 distinct comparisons and 5,000 candidate pairs. Large cross-collection
comparisons sample both sides. A limit reached is explicitly reported; those counts are lower
bounds. Pages contain up to 50 review pairs or collection pairs. Displayed metadata is shortened
to keep responses within the audited response size limit; matching uses the listed metadata.

Each portal's metadata and matching results are cached in memory for one day. Collection overlap
results are reused while those snapshots remain current. **Refresh candidates** recomputes the
portal; **Refresh overlap** recomputes the current page. Only portals on that overlap page are
listed. A runtime restart discards derived caches. There is no new daily maintenance job or
environment setting.

## Routes and persistence

| Route | Minimum authority |
|---|---|
| `GET /api/admin/t/:slug/duplicates` | Curator on that portal |
| `POST /api/admin/t/:slug/duplicates/refresh` | Curator on that portal |
| `POST /api/admin/t/:slug/duplicates/review` | Curator on that portal |
| `GET /api/admin/overlap` | Platform administrator |
| `POST /api/admin/overlap/refresh` | Platform administrator |
| `GET /api/admin/overlap/export` | Platform administrator |

Reports and exports accept `page`, starting at 1. Portal reports also accept `reviewed=false` to
exclude remembered judgements. The review body is `{ "pair": "<pair id>", "decision":
"not-duplicate" }` or `keep-both`. The server verifies the pair belongs to that portal's candidate
report. No review body can delete a resource.

The route catalogue declares portal `content.write` and platform `portal.create`, respectively.
Existing session, key refusal, alias isolation, lifecycle and audit guards apply. Read-only portals
refuse review writes; suspended portals refuse non-platform callers.

Both runtimes persist decisions in the `duplicate_reviews` SQLite table. The managed runtime uses
the Durable Object database; the local server uses `DATA_DIR/rbac.sqlite` (or the existing
`RBAC_PATH` override). Each decision and its required mutation and named audit completion share
a synchronous transaction. Portal erasure removes the decisions and derived caches. Decisions
otherwise remain until portal erasure so a refresh or restart does not lose a human judgement.
