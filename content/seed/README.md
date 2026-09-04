# Seed content

The 20 documents in this directory (`marine/` and `grains/`, 10 each, indexed by `manifest.json`)
are **AI-generated synthetic content**, written in the style of Australian fisheries and grains
research, for the two fictional showcase tenants: Southern Waters Research Institute (`marine`)
and Dryland Cropping Research Alliance (`grains`).

These are **not** real publications from any actual research organisation. No statistic, figure,
date, survey result or finding in any of these documents is real - do not cite, quote, rely on or
present any of it as genuine research. They exist purely so `deno task provision` has something
concrete to upload into a fresh knowledge box while you evaluate the portal, and so the portal has
real-looking content to demonstrate search, citation and the knowledge graph against.

Replace this seed content with your own organisation's actual, cleared documents before treating
any answer the portal gives as trustworthy.

## Manifest

`manifest.json` lists all 20 entries with the metadata `apps/api/scripts/provision.ts` uploads
alongside each document (title, topic, publication date, type, summary, key facts). It carries no
explicit synthetic-content flag in its schema; this README is the authoritative disclaimer for
everything in this directory.
