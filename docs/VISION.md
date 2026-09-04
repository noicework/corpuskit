# Vision - Research Portal


## The one-line vision
A world-class, multi-tenant research portal that you point at a blank Progress Agentic RAG
knowledge box: the application provisions and configures everything for the domain you describe
(knowledge graph, agents, labels, suggested questions, branding), then gives that organisation's
researchers a fast, credible, beautifully designed way to explore and question their entire
research estate.

## 1. Domain / corpus
**Domain-agnostic by design.** The portal is not built for one corpus - it is built to be pointed
at a *blank* knowledge box and configure itself from a domain brief. Everything the domain shapes
(topic taxonomy, labels, knowledge graph entity and relation types, running agents, suggested
questions, terminology, theming) is set up *by the application* when a knowledge box is initiated,
then exposed in-app for administrators to manage.

First two tenants - fictional showcase organisations running the synthetic seed corpus in
`content/seed`:
- **Dryland Cropping Research Alliance** - grains R&D.
- **Southern Waters Research Institute** - fisheries and aquaculture R&D.

## 2. Primary user & their job-to-be-done
The **typical research person at a research funder or institute**: arrives with a question or
a topic, needs fast, cited, trustworthy answers, and then explores the underlying reports,
projects and relationships. A secondary persona is the **knowledge administrator** who provisions
and manages a tenant (corpus, labels, graph config, agents) from inside the application.

## 3. Hero experience (the "wow")
The bar is a portal a researcher would choose over the search box they have today: feature
complete, and then whatever it takes to be world-class.

Two heroes, one per persona:
- **For the researcher:** ask a question anywhere and watch a beautifully streamed, cited answer
  build, with per-source confidence, matched passages, key takeaways and one click from any
  citation to the exact source passage.
- **For the buyer/administrator:** the provisioning moment - hand the app a blank knowledge box
  and a domain brief, and watch it configure a complete, branded research portal (corpus, graph,
  labels, agents, questions) in front of you. No other demo does this.

## 4. Stack
**React + TypeScript + Vite front end, thin typed Fastify API server** (confirmed 2026-08-21).
The AI/retrieval layer lives behind a clean `RetrievalProvider` interface on the server; the
Progress Agentic RAG wiring is configuration, not code spread through the UI. No LLM or vector
store is hardcoded into components.

## 5. Sample corpus for the build
**A small synthetic seed corpus for each of the two showcase tenants** - AI-generated documents in
the style of grains and fisheries research (final reports, reviews, briefings), seeded by the
provisioning engine so the product can be seen working end to end. Real content for an actual
organisation goes in through the in-app admin surface, not by hand.

---

## Principles

These are the standing rules the codebase is built to, not aspirations. They are referenced
from the code and from `CONTRIBUTING.md`.

- **Nothing faked, ever.** No mock provider, no mock mode. The portal points at a real Progress
  Agentic RAG knowledge box through the platform API from day one; sample content is real
  documents uploaded into those knowledge boxes. Test doubles live only inside test files. If a
  feature cannot be shown working against a real box, it is not done.
- **Never a bare unattributed answer.** Every answer carries its sources. Content credibility is
  the product, so an answer that cannot be grounded is refused rather than guessed.
- **Merchandised, not raw.** Resources display through generated fields - title, hook, summary,
  key takeaways, year, authors, tags - never a raw filename.
- **Retrieval stays behind an interface.** The AI and retrieval layer sits behind
  `RetrievalProvider` so the portal is not welded to one platform, one model or one vector store.
- **Evidence, not assertion.** Changes that claim an improvement carry a before/after
  measurement. UI work is verified visually in a real browser, in both themes and at mobile
  width, not on typecheck and tests alone.
- **Registry-free toolchain.** Deno 2 + Hono (JSR) + esbuild and standalone Tailwind, with
  React and Zod via import maps. No npm install step.
