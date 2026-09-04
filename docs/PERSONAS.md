# Research personas - the users the portal is tested as

These personas drive testing: pre-release simulation passes and the automated persona gates both
run their journeys. The portal is tested as these people, early and continuously, and is shown to
anyone outside the team only when their journeys hold up.

> P1 and P2 below are the two headline personas whose journeys gate a deploy
> (`apps/api/scripts/persona-smoke.ts`). The fisheries side is expanded into its full eight-persona
> stakeholder set in `docs/FISHERIES-PERSONAS.md`, which drives the persona expectation harness
> (`apps/api/scripts/persona-eval.ts`) described in `docs/TEST-FRAMEWORK.md`.

## P1 - Fisheries research scientist (marine tenant)
Dr Sarah, stock assessment scientist at a state fisheries agency, funded by Southern Waters
Research Institute.
**Jobs:** check what the institute's funded work exists on a species or threat before scoping new
work; pull evidence for a stock status brief; trace which projects informed a management decision.
**Representative journeys:**
1. Ask "What does the institute's research say about abalone stock management?" - expects a cited
   answer, clicks a citation through to the exact passage, saves evidence to an investigation.
2. Search "white spot disease prawns", filter to reports, open a PDF, read the matched page.
3. Ask a question the corpus cannot answer ("orange roughy quotas in Iceland") - expects an
   honest refusal, never a fabricated answer.
4. Build a 5-question Intermediate assessment on a biosecurity topic.
5. Explore the knowledge map around a species entity and follow a related project.

## P2 - Grains agronomy researcher (grains tenant)
Dr Priya, cropping systems agronomist, funded by Dryland Cropping Research Alliance.
**Jobs:** find prior investment on an agronomic problem; compare findings across regions; assemble
a briefing for growers.
**Representative journeys:**
1. Ask "What research covers stripe rust management in wheat?" - cited answer, citation
   click-through, evidence table inspection.
2. Search "soil acidity liming", toggle Resources/Citations, open a cited report.
3. Generate a briefing artefact on a topic and export it.
4. Ask a cross-topic comparison question and check multiple sources are synthesised.
5. Watch a saved search and expect change tracking.

## What the persona gates assert
- No refusal on questions the corpus demonstrably covers (search finds sources for the same
  terms); always a refusal, never invention, on out-of-corpus questions.
- Every inline citation marker resolves to a real source in the citations list.
- Sources retrieved > 0 on in-corpus asks; first answer token inside 15 s.
- Journey pages render: explore, search with answer panel, resource detail with reader,
  assessment, graph.
- Mobile viewport (390 px) keeps the primary journey usable.
