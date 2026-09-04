# The persona expectation test framework

How we find out whether the portal answers the way the person asking would expect - not whether it
answers at all, and not whether it merely scores well on average.

## Why this exists alongside the harnesses we already had

| Harness | Question it answers | When it runs |
|---|---|---|
| `apps/api/scripts/persona-smoke.ts` | Is the deployed portal alive and grounded? (search works, one ask streams and cites, one out-of-corpus ask refuses) | After every deploy. Gates the deploy. |
| `apps/api/scripts/accuracy-eval.ts` | What is the portal's *average* answer quality? (REMi scores, citation integrity, latency, over a flat question list) | Before/after a retrieval config change, to compare. |
| **`apps/api/scripts/persona-eval.ts`** | **Does each answer match what the specific person asking expected?** | Before a client handover or demo; whenever the corpus, prompts or retrieval config change. |

The first two can both be fully green while the portal still confidently invents an answer to a
question with a false premise, or presents a 1999 trial result as current commercial guidance. An
average hides exactly the failures that lose a room. This framework exists to find those.

## The three parts

### 1. Personas - who is asking
Eight fisheries personas in `docs/FISHERIES-PERSONAS.md`, chosen so each one stresses a different
retrieval shape. Results are reported per persona, so a weakness reads as *"the portal is poor for
the funder persona"* rather than as an anonymous percentage.

### 2. Question classes - what kind of question
Every question is tagged with the behaviour it stresses, and results are reported on this axis too.
The classes that matter most are the ones the other harnesses do not test at all:

- `false-premise` - the question asserts something the corpus does not support. The portal must
  correct it. Playing along produces a fluent, confident, well-cited fabrication, which is the
  worst thing the portal can do.
- `adjacent-absent` - a real fisheries question the corpus genuinely cannot answer (a species,
  season, jurisdiction or programme none of its documents mention). Harder than obvious
  out-of-domain trivia, because lexical search still returns high-scoring near-misses; it tests
  grounding rather than search.
- `temporal` - the corpus spans decades of research reports. A currency-sensitive question must be
  answered with its limits stated.
- `corpus-meta` - questions about the collection rather than about fisheries. A passage-retrieval
  portal is structurally weakest here.
- `injection` - a prompt injection typed into the demo's search box in front of a prospect.

The rest (`lookup`, `method`, `synthesis`, `comparison`, `quantitative`, `ambiguous`,
`out-of-corpus`) cover the everyday load.

### 3. Expectations - what a right answer looks like
Each question carries an explicit contract rather than a vague hope:

```ts
{
  id: 'F2-03',
  persona: 'F2',
  klass: 'temporal',
  query: 'What are the current recreational fishing participation rates in Australia?',
  probes: 'THE currency test ...',
  expect: {
    behaviour: 'caveat',              // answer | caveat | challenge | refuse
    concepts: [['recreational'],      // AND of OR-groups
               ['participation', 'household']],
    citationsRequired: true,
  },
}
```

- **`behaviour`** - the response shape required. `answer` (substantive and cited), `caveat`
  (answerable but must state a limit on its own authority), `challenge` (must push back on the
  premise), `refuse` (must decline, cite nothing, invent nothing).
- **`concepts`** - an AND of OR-groups. Every group must be hit by at least one of its surface
  forms. Groups are written generously: we are testing whether the concept is present, not whether
  the model chose our wording.
- **`absent`** - phrases whose presence *proves* a specific failure (naming a treatment on a
  medical question, asserting an event that never happened). These are written narrowly enough to
  be an unconditional fail.
- **`minSources` / `minDistinctCitations`** - retrieval breadth, and whether an answer that claims
  to synthesise actually drew on more than one document.

Every in-corpus question in the shipped bank was verified against the `marine` seed corpus - the ten
documents in `content/seed/marine/` and the metadata in `content/seed/manifest.json` - before it was
written, so an unanswered in-corpus question is a portal finding, not a bad question. The
`adjacent-absent` questions were verified the same way in reverse, by confirming the corpus mentions
the species, season or programme nowhere at all.

A bank written for a real corpus should be verified against that corpus's own search endpoint first
(`/api/t/<tenant>/search?q=...`), for the same reason: a question the corpus never held measures the
question, not the portal.

## Two-tier grading, and why

**Tier 1 (automated, in the script).** Behaviour, source counts, citation integrity, concept
coverage, forbidden phrases. Cheap, repeatable, diffable, CI-able.

Tier 1 is deliberately conservative. It returns three verdicts:

- **PASS** - met every expectation.
- **FAIL** - something it can *prove* wrong: a refusal on a question the corpus covers, an answer
  to a question that had to be refused, a citation marker resolving to nothing, a forbidden phrase,
  a false premise accepted without pushback.
- **REVIEW** - it cannot decide. Thin retrieval, partial concept coverage, or a pushback whose
  adequacy keyword matching has no business judging.

**Tier 2 (a reviewing agent or a human).** Reads the answer text in the JSON transcript for every
REVIEW row and confirms or overturns it.

The split is the point. Keyword matching cannot tell an adequate caveat from a token hedge, or a
properly corrected premise from an evasion. A scorecard that pretended otherwise would be a liar,
and the numbers in it would be quoted. So the script reports two rates: a `strict_pass_rate_pct`
counting only Tier 1 passes (the honest floor) and a `pass_or_review_rate_pct` counting rows not yet
proven wrong (the ceiling). The truth is in between, and Tier 2 is how you find it.

## Running it

```bash
# Full sweep against the marine demo portal
BASE_URL=https://your-portal.example.com TENANT=marine \
  deno run --allow-net --allow-env --allow-read --allow-write \
  apps/api/scripts/persona-eval.ts

# One persona, or one question class - for iterating on a specific weakness
... --persona F4          # biosecurity officer only
... --class false-premise,adjacent-absent
... --limit 5 --out run.json
```

Runtime is roughly 22 s per question (answer time plus the 3.5 s spacing that keeps the run under
the ask route's 20/min/IP limit), so a full 40-question sweep takes about 15 minutes. It is
read-only: every question is a plain `/ask` call, exactly what the UI does.

Output is a per-question scorecard, a summary block of stable `key: value` lines that two runs can
be diffed on directly, per-persona and per-class tallies, and a JSON transcript containing every
answer in full - which is the Tier 2 review input.

## Adding a question

1. Verify the topic against the corpus first - the seed documents for a seeded tenant, or
   `/api/t/<tenant>/search?q=...` against a live one. For an `adjacent-absent` question, verify it
   is genuinely absent.
2. Add it to `QUESTIONS` in `apps/api/scripts/persona-eval.ts` with a `probes` line saying what a
   failure there would mean. The bank's own unit tests enforce that every question has one.
3. Write the expectation to the *weakest* contract that still catches the failure you care about.
   An over-specified `concepts` list produces REVIEW noise and trains people to ignore the report.
4. `deno task check` - the bank has unit tests asserting unique ids, persona coverage, that
   substantive answers require citations, and that refusals do not assert concepts.

## Portability to other tenants

Nothing in the harness is fisheries-specific except `QUESTIONS` and `PERSONA_NAMES`. A grains bank
(personas: agronomist, grower advisor, research portfolio manager, sceptical evaluator) drops into
the same runner and grader, and `TENANT=grains` points it at the other corpus.
