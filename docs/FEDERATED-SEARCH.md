# Shared search across collections

A portal with `agentAsk: true`, at least one configured federation peer and participation
enabled offers **Include partner collections** on Search. Participation defaults to enabled.
This uses the same peer configuration, sealed keys, shared `searchPeer` retrieval entry point
and exclusion policy as [agent ask](AGENT-ASK.md). It adds no storage, audit events or erased
record kinds. Both the managed Worker and local server register the same handler.

## Request and response

`GET /api/t/:slug/search?q=soil+moisture&federated=1` searches the host and each configured peer
in parallel. Without `federated=1`, the existing one-portal search is unchanged. An unavailable
shared-search opt-in returns `404`. Existing `portal.read`, access-mode and suspension guards
run before any source is reached. Read-only portals may still search.

The existing search response adds:

- `sources`: every attempted source, in configuration order, host first.
- `resources[].source`: `{id, label, kind, transport}`. The host has its slug as `id`,
  `kind: "hosted"` and `transport: "hosted"`. A partner has `id: "peer:<peerId>"`,
  `kind: "peer"` and its transport (`kb`, `mcp` or `hosted`).
- `resources[].peerUrl`: a partner's origin URL only when the peer permits origin links.
- `failedSources`: source metadata plus `reason: "timeout" | "unauthorised" | "error"`.
  Missing keys are `unauthorised`; upstream details and credentials never appear.

One source receives the same time limit as agent ask: 20 seconds by default, overridden by
the shared `agentSourceTimeoutMs` application option. Timed-out peer requests are aborted.
Other sources still return, including when the host fails. An all-failed search returns an
empty list and all its failures. Closing the request aborts outstanding peer requests.

## Ranking and bounds

The merge is deterministic round-robin: take one result from the host, then one from each peer
in configured order, then repeat, skipping empty sources. Keep each source's internal ranking.
At most eight results or passages per source are returned. A short collection is represented
in the first round even when another has many matches. Scores from different retrieval engines
are not compared. Peer passages have no comparable relevance score and display no relevance meter.

Shared search performs retrieval for a topic query across every source. Portal-specific author
and identifier catalogue lookups, taxonomy, retrieval-mode and strength controls remain on the
one-portal search. Shared search instead offers a **Source** facet over the returned list;
changing it does not call any source again. Saved Watches remain one-portal searches and their
controls are hidden while partner collections are included.

Every attempted source consumes one turn in the existing caller and address rate-limit buckets,
including failed sources. All sources are admitted together before retrieval begins. Retrieval
does not consume daily generated-answer allowances or write the agent ask's peer-call audit.

## Participation, links and the reader

A portal with `federation.participates: false` does not offer shared search or reach its peers.
The shared peer client drops `federation/exclude` resources. The host's own excluded resources
remain visible in its own portal, as in one-portal agent ask.

The switch is held in the page URL (`federated=1`), and the optional selected facet is held as
`source=<source id>`. Each card shows its source. A polite live status announces loading,
the displayed result count and the name of each failed source. Partner passages can be read
in place; when `linkOrigins` permits an origin link, the title opens that origin instead of
the host's document reader. A partner passage is never submitted as a host resource for saving
or summarising.

`answer=0` still makes no answer or generation request. The existing inline search answer uses
the host collection, labelled explicitly when partner results are included. Composed grounded
answers across the host and partners continue through `POST /api/t/:slug/ask-agent`; its UI is
maintained separately.

## Local verification

Run `deno task dev:stub --speed=0 --port=9851` and open
`/t/marine/search?q=warming%20%23peer-unauthorised&answer=0&federated=1` on the printed local
origin. The host and Soil partner collection return passages; the Water partner collection is
named as unavailable. Turn the switch off to return to one-portal search, or open Filters and
select a source. Removing `#peer-unauthorised` from the query restores both synthetic partners.

`e2e/federated-search.test.ts` uses the agent stub's two synthetic partner collections. It
covers allowed origin links, a failing partner, a timed-out partner, every source failing, keyboard operation,
accessibility-tree roles, polite announcements and real 320px layout viewports. Set
`FEDERATED_SEARCH_SHOTS=.review/federated-search` to save desktop/mobile, light/dark and
200% text review images using the repository's Astral browser harness. Unit tests exercise the
merge, bounded parallel failures, cancellation, both storage adapters, permissions,
participation, link and resource exclusion policies, and per-source rate accounting.
