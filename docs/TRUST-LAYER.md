# The answer trust layer

Status: **ported upstream on 7 September 2026** from a downstream fork, after six clinician-persona
test-fix review loops there. Written for an engineer joining the project. Companion to
`docs/INTENT-ROUTING.md` (the router and the stored search configurations) and
`docs/ARAG-DEV.md` (platform facts and known bugs). The review-loop findings are cited below by
loop and id (`D2-07` is finding 7 of loop 2).

## What it is, in one paragraph

Progress Agentic RAG retrieves passages, writes an answer and binds citations to it at paragraph
level. Ten personas and four loops of one persona found the same defect shape in that output:
a figure, drug, year or cohort attributed to a cited paper that does not carry it, under a
marker the reader trusts. The trust layer is everything the application does around the
platform's `/ask` so that no sentence reaches the reader carrying a claim its cited text does not
support. It is deterministic wherever it decides anything: the only model calls are the
platform's own (the classifier, the answer generation, the optional decomposition and the REMi
quality judge), and none of them can add support to a claim. The layer runs in
`apps/api/src/app.ts`'s `/api/t/:slug/ask` route and the modules it calls; the platform sits
behind `RetrievalProvider` (`packages/retrieval/src/provider.ts`), and the browser only renders
what the events say.

Direction fixed in review loop 4 (section 6): **simple and honest over clever.** A
sentence the layer cannot verify is removed and the removal is stated. A substitute stands in
only when it passes the same figure, time-point, population and outcome checks the removed
sentence failed. A decline is never replaced with a quotation. An emptied answer is withheld with
the failing figures named.

## Vocabulary

| Term | Meaning |
|---|---|
| Intent, configuration | One of the tenant's routed jobs (`general`, `clinical`, `review`, `latest`, `data`, `lookup`) and the stored search configuration behind it (`portal-intent-<id>` for `/ask`, `-find` for `/find`). See `docs/INTENT-ROUTING.md`. |
| Probe | The pre-flight `/find` on the routed configuration, before generation. |
| Pinned paper | A resource the study guard identified from the question (a study acronym, a quoted title, an eponym, a described cohort, the top paper per named entity). Pinned into retrieval with its own prequery and led in the sources. |
| Cohort pin, designated cohort | A pin made because the question designates a cohort ("the LGI1 encephalitis cohort", "the video-EEG monitoring mortality cohort"). Under a designated cohort only its papers may carry a result figure. |
| Grounding set | The resources and paragraphs the platform generated from (its retrieval item), plus the pinned papers the application adds. |
| Cited text | A cited resource's full extracted text, fetched from the platform's extraction endpoint and cached per process; reference lists stripped before use. |
| Binding | Re-deriving, sentence by sentence, which cited texts carry a sentence. |
| Located sentence | The sentence, or the table row with its label and column headings, that carries a figure in a cited text. Every figure check is a check of the claim against this sentence (loop 5, "locate first"). |
| Population clause | The group a claim states a figure for ("in patients with psychiatric comorbidity who switched from LEV to BRV"): the frame that opens the figure's clause, or the qualifier that follows the figure. A claim that only points back ("of these patients") takes the population of the sentence before it. |
| Quantity | What a figure measures in the claim: the noun phrase before its verb ("the adverse-event discontinuation rate was 33.6%"), the words after it ("80% of EDs"), or the label of the bracket it sits in ("(n = 4201, retention population)"), with the outcome families that phrase names, its responder threshold and the n it pairs. |
| Audit | The figure, cohort, second-hand, year, contraindication, denominator and attribution checks over the bound sentences. |
| Gate | The decision the audit's result becomes: remove, rescue, replace, qualify or keep each sentence. |
| Addenda | The italic lines under the answer that state what the layer did and what the papers add (removed sentences, the paper's own figure for the question's outcome after a removal, a protocol's planned recruitment beside the results paper's enrolment, effect sizes, study designs, second-hand figures, denominators the located passage gives, the corpus boundary). |
| Decline | The portal's own refusal text, with the closest matches named and shown "not used". |

## 1. The event sequence of one ask

The client sends `POST /api/t/:slug/ask` with `{ query, route: 'auto', context?, resourceId? }`
and reads Server-Sent Events. Every decision the layer makes is visible as an event, so the UI
never has to infer. Times in brackets are what the loop 4 runs measured on the live box.

| # | Stage | What happens | Kind | Platform feature | Events | Code |
|---|---|---|---|---|---|---|
| 1 | **Route** | Stage 0 (an identifier or an author-year citation), then the deterministic rules, in order; a results question and a terse "drug outcome - measure?" question route to the default configuration by rule. When no rule fires the classifier runs, memoised per tenant, surface and normalised question for ten minutes, in parallel with steps 2 to 4 rather than ahead of them. | Rules: deterministic. Classifier: one platform generation. | The classifier is a `/ask` with `answer_json_schema`, `citations: false`, `top_k: 1`. | `route` (0 ms by rule, 5 to 8 s by classifier) | `intent-router.ts`, `catalog-lookup.ts`, provider `classifyIntent` |
| 2 | **Probe** (the grounding gate before generation) | A `/find` on the routed configuration, 8 results. A supplements-only intent whose probe finds nothing or nothing above the floor falls back to the default configuration (`fallback` event). A best match under the floor (0.3) is declined outright, before any word is generated. A question whose exposure and outcome no retrieved record pairs is declined as a boundary. The probe's shortlist is sent as `sources` so the reader sees retrieval progress, and the texts of those papers are fetched now, while the platform works. | Deterministic. | Stored `-find` configuration; `mode: semantic` find for the closest matches of a decline. | `sources` (0.8 to 2.6 s), or `fallback`, or `done { refused }` | `app.ts` `probe`, `sendDecline`, `findClosestMatches`; `ask-grounding.ts` `exposureOutcomePair`, `pairCarried` |
| 3 | **Pinning** | The study guard matches the question against the merchandised catalogue: an upper-case token that titles at most three articles, a quoted title, an eponym or lexicon term that titles a few, a cohort the question describes (matched on titles and generated summaries). A comparison naming two or more drugs or studies runs the routed configuration once per entity and pins the top paper of each. Each pinned paper gets its own targeted find beside the probe so its passage and score are known before generation. | Deterministic (the per-entity finds are `/find` calls, not generations). | `resource_filters` on `/find`; the data-augmentation summaries. | (feeds `sources`) | `study-guard.ts`, `ask-entities.ts` |
| 4 | **Prequeries** | The intent's mandatory sub-questions that fit (a drug-safety probe only for a medication entity on a treatment-decision question), the caller's sub-questions, and for an evidence-seeking question of eight words or more a model decomposition into three sub-questions (7 s cap, skipped for a results question; at most three sub-questions are searched - loop 8 D8-18 measured five of them costing about three seconds in front of the first word, and the wait itself another five). A question naming an author the catalogue knows scopes retrieval to that author's articles with a larger paragraph budget and a topic-only scoped query. | Decomposition: one platform generation. The rest deterministic. | `askStructured` for the decomposition; the prequeries strategy on `/ask`. | `searched` | `ask-prequeries.ts`, `ask-author.ts`, `app.ts` |
| 5 | **Platform ask** | One `/ask` on the routed stored configuration with the variant preamble on the system prompt, the pinned addendum, the prequeries strategy (a pass per pinned paper with `resource_filters`, `top_k` 20 and weight 2; a pass per question clause against the first pinned papers; a lighter pass per prior-turn paper; one pass restricted to the intent's preferred labels; then the sub-questions, ten at most), `extra_context` (document tables, prior turns' passages and their papers' own paragraphs, publication years for a recency question, a pinned paper's own sections on a retry), chat `context` for follow-ups, `citations: true`, the intent's `rag_strategies` (`full_resource` or `neighbouring_paragraphs`, `graph_beta`; one neighbour each side and no graph walk for a terse question of seven words or fewer, with `top_k` 12), the cross-encoder reranker and, for a reformatting turn, retrieval on the earlier papers alone with no expansion, no reranker and a `max_tokens` sized to the number of earlier answers (1800 to 4096). The provider's own refusal retry is switched off (`noRefusalRetry`); the application manages the one retry. | One platform generation. | Stored configuration, `prequeries` with `resource_filters`, `extra_context`, `context`, `citations`, `rag_strategies`, `top_k`, `max_tokens`, `reranker`. | `stage` events from the provider (`retrieval`, `generating`), `sources` (the platform's grounding set, pinned papers first), `delta`, `citation`, `done` | provider `ask` and `groundingPrequeries` in `packages/retrieval/src/providers/arag/index.ts`; `prompts.ts` |
| 6 | **Stream shaping and the first verified sentence** | Each delta passes through the reference-list stop (a model-authored "References:" block or a trailing run of `[n] Title.` lines is never forwarded) and the sentinel rewriter (`SentinelStream`: "the context does not provide" becomes "the cited sources do not provide", the platform's guardrail sentence is dropped, a sentence is released the moment its stop arrives). The provider holds the platform's fixed decline copy and a `[n` split across chunks; a code-fence line is never forwarded. The first complete sentence is checked against the texts fetched in step 2: every figure beside the claim's own terms in one of those papers, which must also carry the question's cohort name; the surface is told which paper. The surface renders everything that streams in the checking style (muted ink, a dashed rule, the badge "Unchecked - still streaming, the check follows") and shows the verified line only under visible text; the gated text replaces everything at `done` in full ink (D5-08). | Deterministic. | (none) | `delta`, `verified` (at the platform's first token, 7 to 11 s) | `answer-shape.ts`, `ask-stream-verify.ts`, provider `splitPartialMarker` |
| 7 | **Finish the text** | At the platform's `done`: the model's reference lines are stripped (a heading block, a trailing author-year entry, a cited title written out), the sentinels rewritten in the final text and the "(inference)" token removed, code fences stripped, header-only tables and empty headings dropped (D5-05, D5-16), a generation that stopped mid-sentence is cut back to its last complete sentence (`done.truncated`; a table row that closes its pipe is complete, one cut before it is dropped alone). Citation chips take the bibliographic title with the generated headline as subtitle. | Deterministic. | (none) | `stage auditing started { figures }` | `answer-shape.ts` `stripModelReferences`, `rewriteSentinels`, `trimTruncatedTail` |
| 8 | **Binding** | The cited texts (eight at most) are fetched and their reference sections cut. Each sentence keeps only the markers whose cited text carries its named entities (both of two, 60 percent of many), a name the question also uses (the cohort, drug or study), the study design it states, every figure beside the claim's own terms, and enough of its content words and word pairs, including at least one of its rare words. A marker to a source under the display floor is dropped unless the source is pinned; a sentence whose figures all pass keeps only the markers whose located passage carries them (D6-12). Headings carry no markers; a list item inherits the nearest marked line's citation when the text carries it; a table row's markers sit inside its last cell. | Deterministic. | The platform's extraction endpoint (`extractionText`). | (none yet) | `citation-binding.ts` `bindSentences`, `supportScore`, `rareWords`; `ask-grounding.ts` `bindAndAudit` |
| 9 | **Audit** | Over the bound sentences: (a) `verifyFigures`, every figure located first in the texts its sentence is bound to: each occurrence brings the sentence or table row that carries it (a cell with its row label and column headings, and, for a Markdown table in the answer, the column heading above the cell), and the claim is placed when that sentence shares one of its names, two of its specific words, the noun the figure qualifies, a word of the quantity the figure measures, every outcome that quantity names, or the name the question routes on; the located sentence must then not give the figure a different outcome (including a modifier the paper uses to tell two figures apart, "continuous seizure freedom" against "seizure freedom"), population, follow-up, statistic, responder threshold or denominator pairing; (b) the cohort guard, under a designated cohort every result-figure sentence must cite a cohort paper unless it names another study; (c) the rescue, a failing sentence's figures looked up in the full text and DA fields of the cohort papers, the pinned papers, the prior turns' papers and the retrieved resources, and the first paper carrying every figure beside the claim lends its marker (a citation the platform never made); (d) second-hand figures, a figure the cited paper carries only where it cites other studies is looked for first-hand elsewhere, and on a named-cohort or planning question a sentence left with one is removed; (e) the replacement, a still-failing sentence about the cohort or a pinned paper is replaced by that paper's own results sentence, verbatim and cited, only when it carries the same figure at the same time point beside the claim, at most one quote per sentence and three per answer, never over a decline; (f) the population qualifier the supporting passage frames ("In patients with psychiatric comorbidity, ...") carried into the sentence. | Deterministic. | Extraction endpoint; DA summary and key takeaways as texts of their own. | (none yet) | `answer-audit.ts`, `figure-rescue.ts`, `secondhand.ts` |
| 10 | **Gate** | `gateFigures`: a sentence whose figures failed is removed, except a table row, which keeps its place with each failing cell marked "not verified" and the rest of the row intact (D5-05); a figure sentence with no marker inherits the one cited text that carries every figure it states or is removed; a conclusion whose supporting sentences went goes with them; a dangling connective is stripped; a kept sentence that repeats a removed figure without a passing check of its own goes too (the sweep, loop 8 D8-02); a heading or bold label left with no sentence under it goes with them; the survivors are renumbered by first appearance. A denominator the answer paired differently from the located figure's own bracket is a failed figure (removed, or replaced by the paper's own sentence when it carries the same figure at the same time point), never a rewrite. Under a designated cohort or a planning question, result sentences from more than one paper each open with the paper they come from. A contraindication no cited passage states is removed (safety variant or a treatment-decision question). "X and colleagues" over a paper X did not write is rewritten to the paper's first author. Years are post-checked against every retrieved source's metadata and the cited texts. | Deterministic. | Resource metadata (`year`, `published`). | (none yet) | `answer-gate.ts`, `answer-audit.ts` `denominatorCorrections`, `stripUnsupportedContraindications`, `yearsUnsupported`; `ask-author.ts` |
| 11 | **Addenda** | Appended in italics: the removal note (figures named, and where they were found if a paper carries them beside other words), the paper's own figure for the question's outcome after a removal ("For the outcome asked about, [n] itself reports: ..."), a protocol's planned recruitment named as such beside the results paper's enrolment, the effect size a cited passage carries when a risk question got none, the study-design line that leads an answer grounded on a modelling or preclinical paper, the study designs in the sources' own words (clinical variant), the second-hand note, the attribution note for a finding the answer credits to authors who did not write the paper cited beside it (loop 8), the line naming a sentence the binding could tie to no passage (loop 8 D8-04), the corpus-boundary note for a study the question names that no held title carries, the author-scope note, denominators the passage gives for a bare proportion, and the drugs the sources flag that a which-drug answer left out; the denominators line only ever names an n the located passage gives in the figure's own bracket or cell. Evidence cards are re-pointed at the paragraph that carries the claims bound to each source (page kept when retrieval supplied it). | Deterministic. | Retrieval paragraphs with pages (`ScoredResource.passages`). | `sources` (re-chosen passages, weak uncited matches dropped), `citation` (renumbered), `audit`, `done { text, truncated? }` | `answer-gate.ts` `removalNote`, `effectSizeNote`, `designLead`; `evidence-passages.ts`; `ask-grounding.ts` `auditAddendum` |
| 12 | **Done, confidence and the quality tail** | `done` carries the gated text and goes out before the REMi judge answers; the page replaces the streamed text, releases the composer and saves the session. The judge started before `done` in the provider, capped at 8 s, and its `quality` event trails on the same stream. Confidence is audit-led: an unsupported figure, year or contraindication is Low; every figure found and at least half the sentences cited is High; removed sentences cap it at Moderate; the platform's groundedness may lower an audited verdict one step and never raise it, and never reaches High on its own. | REMi: one platform call, advisory. | The platform's REMi scoring. | `done` (9 to 30 s), `stage validating`, `quality` | provider `ask` tail; `apps/web/src/lib/confidence.ts` `assessConfidence`; `answer-marks.ts` for the badge |

**The retry policy (step 5 repeated, at most once).** A refusal, an answer the binding stripped
of every marker, or an answer the gate emptied buys one more platform ask, chosen for the reason
the pass failed (`ask-retry.ts` `nextRetry`): the general configuration when a supplements-only
intent's data sheets held no answer (`supplements`); the named paper alone, document-scoped with
its own Abstract, Results, Methods and Conclusion paragraphs as `extra_context`, when the question
names one the first pass never cited (`pinned`); the default configuration without the safety
prequeries when a 90 percent match was retrieved and the generator still declined
(`prequeries`); the follow-up without the earlier turns' papers when a turn scoped to them
refused, or when they crowded out the paper it asks about (`unpinned`); and for a terse question
of ten words or fewer that pinned nothing, the retrieved paper whose own text carries every name
the question uses and the most of its outcome words, read alone with its own paragraphs
(`ask-terse.ts` `topicPin`, D5-09: "ICV valproate seizure reduction - number?" refused with the
first-in-man paper fifth on the shortlist). The retry carries a firmer directive. Nothing has streamed by
then except the discarded attempt's `fallback` event, so the surface sees one answer. When no
retry applies, the decline stands, its closest-matches search already running.

**Follow-up turns** carry the earlier answers' cited resource ids and passages, and every
follow-up pins those papers (a prequery per paper on its `resource_filters`) and sends the
turns as chat `context` (D5-06, D4-07). A turn that stays within the earlier papers, referring
back ("that study", "back to the JME cohort", "each group") and naming no acronym or lexicon term
the session has not already discussed, is retrieved from those papers alone on the platform's
resource filter, with the papers' own paragraphs that carry the question's words (tables
included) as `extra_context`, so a figure in Table 1 is in front of the generator before it can
decline; if that scoped ask refuses, the one retry asks the whole collection. A turn that only
reshapes ("put the three drugs in a table") reads only those papers, leanly (no expansion, no
reranker, the earlier questions as scoped prequeries) with a budget sized for one row per earlier
answer; a turn naming a new drug is pinned to the old papers but not confined to them
(`ask-session.ts` `staysWithinPriorTurns`, `reformatBudget`). The study guard pins on
follow-ups too.

**Document chat** (`resourceId` set) skips routing, pinning and prequeries, sends the document's
pipe tables and key-resources block as `extra_context` and a document-chat prompt addendum, runs
the same binding and audit against the open document (badge "N figures checked · Checked against
this document's text") and never retries; its decline is document-scoped.

**An uncited figure answer on a question that names a paper** (loop 5 HC, D4-09): when the
platform attaches no citation at all to an answer that states figures, and the study guard pinned
a paper, the pinned paper is bound as the answer's source and the gate binds each figure sentence
to it when it carries every figure; what it does not carry is removed as usual, and an answer
nothing binds is still withheld.

## 2. The rules, and the findings that motivated each

Every rule below exists because a reviewer found the defect it prevents. The ids (P-findings,
R-items, D-findings) point into the review loops' own records.

### The retrieval pin: what the question names decides what retrieval sees

This is the architecture change of review loop 7 (section 6), and it replaced rules
rather than adding them. Loops 5, 6 and 7 all scored 7 on the same defect class: the answer was
generated and checked over a bag of paragraphs drawn from several cohorts, and every rule added to
the checker - the outcome noun, then the exact outcome, then the population clause - was a filter
on a set that should never have contained the wrong cohort's paper. The proof that the fix belongs
upstream is that document chat, scoped to one paper, answered all three loop 7 P0 cases correctly
in six to seven seconds while Ask, seeing eight papers, got them wrong under a High confidence
badge.

- **The names a question uses are resolved to resources before retrieval** (`name-pin.ts`).
  Resolved against the catalogue, in the order a pin prefers them: antibodies and antigens, named
  consortia, registries and networks, trial acronyms, quoted titles, described cohorts, then the
  tenant lexicon's drugs and syndromes.
  - **An antigen is read where the gene-symbol reader refuses it.** "LGI1" is a gene, and the
    router rightly rejects it as a study acronym; in "anti-LGI1 antibody encephalitis" it names an
    antibody, a cohort and exactly one paper (D7-01). Three shapes are read - the "anti-" prefix,
    the word before "antibody"/"antibodies", the word before "encephalitis" - and the token is
    tested in the case the question wrote it, so "autoimmune encephalitis" names no antigen.
    NMDAR, GABA and AMPA are deliberately not filtered through the router's generic-acronym list:
    they are generic as topics and are exactly names here.
  - **A title match beats a generated summary.** The Australian Autoimmune Encephalitis
    Consortium titles four papers; an LGI1 sub-study names it only in its DA summary. Preferring
    the title is what stops a named cohort's twelve-month outcome being answered from a member
    study (D7-02). A described cohort keeps every word it contains, geography included: "the
    Australian autoimmune encephalitis cohort" is not the German one, and the study guard's
    designator reader drops exactly the word that tells them apart.
  - **An acronym is matched in the case the question wrote it.** "EXPERIENCE" titles two articles;
    "experience" the English word titles seven more.
  - **A name that titles too many papers is a topic and pins nothing**, and **a drug or syndrome
    alone never makes a pin** - it titles a rat pharmacokinetics study and a real-world pooled
    analysis alike. A drug joins a pin a stronger name has already made.
- **Whether the pin holds is retrieval's judgement, not a string rule.** The question and each of
  its clauses are found *inside* the pin on `/find` with `resource_filters`. A pin whose papers
  carry nothing for the question is dropped and retrieval is exactly what it was before. A clause
  the pinned papers cannot answer widens the pin with the paper that does answer it, so a two-part
  question keeps both halves; a clause that merely continues the subject ("and at what median time
  to first relapse") scores inside the pin already and widens nothing.
- **Retrieval is then constrained to the pin** on the platform's own `resource_filters`, exactly
  as document chat is constrained. The wrong cohort's paper is not filtered out of the answer: it
  is never in the grounding set.
- **A question whose names resolved is covered by definition**, so the relevance floor no longer
  declines it. A two-part question naming a trial the catalogue holds was declined with "no source
  in the corpus comes close" at a 22% best match while `/search?q=BREATHS` returned that trial
  first (D7-09).
- **The pin is enforced on the way back too.** `/ask` honours `resource_filters` weakly
  (`docs/ARAG-DEV.md`), so a citation to a paper outside the pin is dropped before anything is
  checked; its sentence then has no marker and is judged, and removed, like any other unsupported
  sentence. The rescue read's pool is the pinned papers alone, so it may rebind a figure inside
  the pin and can never import one from a neighbouring cohort.
- **The pinned retry reads the paper whole.** Under a pin the one extra ask is
  `rag_strategies: full_resource` on the pinned resource, because the first pass has already seen
  the top passages and reading them again returns the figures the gate just rejected.
- **A marker may only name a paper whose located passage carries the sentence's figures.** The
  per-sentence check already knows which of a sentence's papers each figure was located in; every
  other marker is dropped, and a sentence left with none falls to the gate. "28% of patients
  experienced a relapsing course.[1]" named a paper whose text does not contain 28% (D7-01).
- **Rules the pin replaced, and deleted.** The question-level cohort guard and its
  `reason: 'cohort'`; `cohortPapers` and `cohortPhrases`, the catalogue matching it needed; the
  restricted rescue and second-hand pools; `alwaysNamed`, the escape hatch from the name test; the
  name test on a cited text while a pin is in force (under a pin it is a tautology); and the dead
  `numbersMissing`. The layer is smaller after loop 7 than before it.
- **What the pin does not do.** It fires only on a first turn (a follow-up is already scoped by
  the earlier turns' papers, an author question by that author's articles) and only when a name
  resolves. A question that names no study, cohort or antibody keeps the ordinary retrieval - but
  since loop 8 it is usually decomposed into clauses first, below.

### Clause pinning: the pin applied one level down

This is the architecture change of review loop 8 (section 6). The name pin works, and
it works only where the question names something the catalogue resolves: 20 of 25 pinned asks were
clean, and about **one clinician question in six** names such a thing. In the other five sixths the
answer was still generated over a bag of ten papers, and that is where loop 8's defects clustered -
12 of 26 unpinned asks carried one, including both P0s and five of the seven P1s.

So a question is now decomposed into clauses **before** retrieval, each clause is resolved to one
paper, each is answered as a **one-paper ask** and the answers are composed with **exactly one
resource id per sentence** (`clause-pin.ts`).

- **Decompose before retrieving.** A comparison is one clause per drug ("compare brivaracetam and
  perampanel" is two questions whose answers live in two papers); a two-part question is one clause
  per part; anything else is a single clause over the whole question. A comparison needs a
  comparison cue - "compare", "versus", "which of", "better" - so "switched from levetiracetam to
  brivaracetam" stays one question about one cohort, and a question that also names a study,
  antibody or consortium is that study's question and is not split per drug (PA1a).
- **Clause pinning applies where per-paper attribution is the right shape**: a comparison, a
  question that asks for a quantity (`asksForQuantity`: the router's results rule plus "what share",
  "how common", "how old"), or a treatment question naming a drug and a condition. It does **not**
  apply to "what is the evidence for X" or "does X work", which are genuine multi-paper syntheses
  and which this build already answers well.
- **A question that names no treatment is never decomposed by treatment**
  (`isOpenTreatmentQuestion`). An open "which medications" question - "Which anti-seizure
  medications are contraindicated in SCN1A Dravet syndrome?" - has no clause structure at all, so
  the only clauses available are the drugs `medicationsInResults` read off whatever retrieval
  returned. That produced a **phenytoin** heading arguing phenytoin may be *beneficial* in Dravet
  syndrome, then clause declines for cannabidiol and fenfluramine, neither of which the reader
  had asked about: an inverted answer to the portal's most-tested question. A category comparison
  now needs a **ranking cue** ("best", "highest", "safest", "better", "rank"), which is what
  separates "which ASM has the best real-world retention" (decomposed, D8-13) from "which ASMs are
  contraindicated" (one question).
- **An open treatment question naming a syndrome pins that syndrome's guidance** (`guidancePin`).
  A syndrome is a topic, not a cohort, so the loop 7 pin resolves nothing and retrieval hands the
  generator every paper that mentions a drug and the syndrome - on this collection a single-centre
  phenytoin case series at 1.00 above the international consensus statement at 0.97. The
  collection's consensus statements, guidelines and management recommendations for the condition
  the question names (by phrase, "SCN1A Dravet syndrome", or by tenant entity term, "Dravet") are
  pinned instead, and the pinned ask is asked in the words guidance uses as well as the reader's
  (`guidanceProbe`, a prequery) and told to name the medications and expand the reader's
  abbreviations (`GUIDANCE_ADDENDUM`). The ordinary rule still holds: a pin whose papers the
  question itself cannot find above the grounding floor is dropped, and retrieval is unchanged.
- **Every clause resolves to one paper**, in this order: the names the clause itself uses (the
  loop 7 pin, run per clause), then the **medications and conditions that scope it**
  (`conditionNames`, `medicationNames`, `scopeResources` in `name-pin.ts` - a scope is deliberately
  wider than a pin, up to 60 papers, because *a drug scopes a clause and never pins an answer*),
  then retrieval over the collection.
  - **A condition scopes, so a different disease cannot answer.** "Is carbamazepine
    contraindicated in juvenile myoclonic epilepsy" scopes to the JME papers, which is what keeps a
    CLN2 disease guideline's "carbamazepine ... should be avoided" out of the answer (D8-08).
  - **A clause with no subject of its own stays with the clause before it.** "... and how many
    were female" is found both over the collection and inside the previous clause's paper, and it
    leaves that paper only for a match 0.15 better. Answering it from whichever cohort paper ranks
    next is exactly D8-03 (a neonatal channelopathy cohort's sex split offered as the sub-scalp
    trial's).
  - **The paper is chosen by shared phrase, not by score alone.** Semantic scores at the top of a
    find sit within a point or two of each other and their order is not stable: "what placebo
    responder rate should I assume" put a paediatric lacosamide trial at 0.94 and the pooled
    placebo analysis the question is about at 0.93. Within a 0.15 band of the top score, the paper
    sharing most adjacent content-word pairs with the clause wins - "placebo responder rate"
    against "placebo response rate" (D8-01).
  - **The framing a question carries for the portal is not part of what the paper is asked.** "For
    a registrar teaching session: what does the collection say about ..." scored 0.19 against the
    paper that answers it and 0.43 without the framing (D8-06).
- **Each clause is answered as a document chat.** One `resource_filters` entry, the document-chat
  prompt addendum plus a clause addendum naming the paper and the clause's drug, and the paper's
  own tables and key-resources blocks as `extra_context` - the same shape `/ask` runs in for the
  document chat that got right every figure Ask got wrong in loop 8. Measured on this build,
  `rag_strategies: full_resource` here was both slower (117 s against 9 s on the same question) and
  less accurate - it answered the UMPIRE cohort's age from the eligibility criteria rather than the
  reported mean - so the one-paper ask uses document chat's own strategies, not the whole text.
- **Composition carries hard attribution.** Every marker the generator wrote is stripped (it was
  numbering a single-source context and means nothing), and each sentence of a clause's answer is
  given the one marker of the paper that produced it. **No sentence can draw on two papers, because
  no generation ever saw two.** That is what closes the marker defects of D8-04 for these questions
  and makes D8-02 structurally impossible on this path: there is no shared pool from which a
  removed figure can reappear.
- **A block never remarks on the drug the block beside it answers for.** Asked only about
  brivaracetam, a paper's answer closes "the paper does not provide data on perampanel, so no
  comparison can be made" - true of that paper and false of the answer, whose next block is the
  perampanel answer. Those sentences are dropped, and a block that is *only* a decline becomes a
  named clause decline instead.
- **A clause that resolves to nothing, or whose paper answers nothing, is declined by name** -
  "*This collection holds no paper answering this question for perampanel.*" - and the rest of the
  answer stands. The whole answer is refused only when no clause was answered at all, and then the
  ordinary retrieval runs instead: clause pinning never turns a question the collection can answer
  into a refusal.
- **A question that names a study the catalogue does not hold never goes down this path**, so the
  coverage decline of D7-08 still fires for RANSOM and ESETT.
- **The composed answer is audited like any other.** It goes through the same binding, figure
  check, gate, denominator and second-hand passes; the clause path changes what the generator sees,
  not what the checker does.
- **The rule clause pinning replaced, and deleted.** The **entity pin** of D2-03 - one extra
  retrieval pass per named drug, whose top paper joined the grounding set so that "one drug's
  figure is never read off the other drug's paper" - is gone (`entityPins`, `MAX_ENTITY_PINS` in
  `ask-entities.ts`, and its call in the ask route). Loop 8 shows it did not achieve that: with
  both entity papers in one grounding pool, U7 still printed the perampanel extension's 74.6% under
  a heading that said Brivaracetam. Clause pinning makes the same guarantee structural, so the
  extra passes bought nothing but latency. `comparisonEntities`, `entityQuery` and `pickEntityPaper`
  stay: the decomposition and the briefing path use them.

### Routing and grounding before generation
- **The grounding gate runs before generation, not after.** The platform reports its retrieval
  after the answer tokens, so a floor on that event appended a decline under an answer that had
  already streamed (R1; P6-01, P7-01, P8-01). The probe on the routed `-find` configuration
  costs under a second and lets the portal decline, or change configuration, before a word is
  generated. PR #6.
- **A supplements-only intent falls back to the default configuration** when its probe finds
  nothing strong (R6; P4-01, P4-02, P2-01). The `data` intent itself now reads the papers and
  their attachments (`not documentation, not media` plus a `prefer` pass on `format:supplement`),
  is offered to the classifier only for questions that name a table, supplement, data sheet,
  appendix, protocol document, peer review or raw data, and a results question routes to the
  papers by rule (D1-01, D1-02, D1-03, D1-11; PR #7).
- **A study named in the question is pinned** so retrieval cannot crowd it out (loop 1 section 5,
  D1-01, D1-02; PR #7), a pinned paper is read in depth with a pass per question clause
  (D2-05, D2-08; PR #11), a comparison retrieves once per named entity (D2-03; PR #11), a cohort
  the question describes is pinned from titles and summaries (D4-01; PR #17), and a pin survives
  to follow-up turns (D4-22; PR #17).
- **A relationship the collection holds no study of is declined as a boundary** rather than
  stitched from papers about other things (D3-12; PR #14).
- **Terse questions route by rule, decomposition needs eight words**: a five-word clinic question
  took 24 s through the classifier and five sub-questions (D4-08; PR #16).
- **One extra ask at most.** A refusal used to walk a chain of up to four platform asks and 37 s
  (D3-05; PR #13). The budget per question is one probe (the pre-flight finds, in parallel), one
  platform ask and one retry; a terse question reads a light context (twelve paragraphs, one
  neighbour each side, no graph walk) so its first word is not behind thirty thousand tokens of
  expansion (D5-08, loop 5).
- **A surname scopes retrieval only in an author construction** ("X's papers", "papers by X",
  "X et al.", "X and colleagues", "what did X find"): "Grant background: ..." was scoped to the
  one paper with an author called Grant and half the question declared uncovered (D5-07).
- **An exact lookup needs one entity that is the whole query**: "lamotrigine SUDEP" is a
  two-entity question for retrieval, "Dravet syndrome" and "SCN8A epilepsy" are lookups (D5-17).
- **A terse question that pinned nothing reads the paper that carries its names** before it is
  declined or withheld: the retrieved paper whose own text carries every acronym, lexicon term and
  capitalised name of the question and the most mentions of its outcome words, never a
  preclinical paper for a question about people (D5-09).
- **Every follow-up carries the earlier papers**, and one that stays within them is answered from
  them alone with their own paragraphs in front of the generator (D5-06, D4-07, D4-22).

### Streaming
- **The model's own reference block is never forwarded**, and the sentinel phrases ("the context
  does not provide", "Not enough data to answer this", "(inference)") are rewritten or removed on
  the stream and in the final text (R2, R19; P3-12, P2-05, P8-08, P9-17, P10-11; PR #6). A
  newline releases nothing past itself so a sentinel opening a new line is caught whole (PR #12,
  from PR #10's note).
- **A sentence is released the moment its stop arrives** rather than when the next sentence
  starts, so a one-sentence answer is not held until the badge (D3-05; PR #13).
- **The first complete sentence is verified while streaming** against the probe's papers, whose
  texts were fetched during generation; the audit's own fetches are then cache hits and the
  auditing stage takes milliseconds (D4-08; PR #16).
- **A truncated generation is cut back to its last complete sentence** and the surface told; a
  closed table row and a list item ending on a figure are complete (D1-04, D4-06; PRs #8, #16).
- **Nothing on screen reads as the answer before it is checked.** Streamed text renders in the
  checking style with an "Unchecked - still streaming" badge from the first token, the "First
  sentence verified" line appears only under visible text, and the gated text lands in full ink
  (D5-08, D4-08).
- **Format leaks are removed**: code fences, empty headings, header-only tables and the
  "(inference)" token (D5-16, D5-05).

### Binding
- **Sentence-level binding replaces the platform's paragraph-level markers** (R2; P2-02, P2-03,
  P2-04, P7-02, P7-03, P7-04, P10-03, and twenty more; PR #6). Markers beyond the citation count,
  markers on headings and markers that move on `done` were all the same defect.
- **The names a claim hangs on must be in the text**: both of two, 60 percent of many, because a
  drug list cited to a paper naming one drug of four was the commonest misbinding (PR #6).
- **A supporter must carry one of the sentence's rare words** (words at most a third of the cited
  texts carry): a levetiracetam paper covers "levetiracetam ... efficacy ... criteria" and still
  says nothing about non-inferiority (D1-16; PR #8).
- **A name the question uses must be in the cited text**: a fenfluramine trial never mentions the
  Melbourne cohort (D2-01, D2-04, D2-13; PR #12). A study the question names by acronym must be
  in every cited text or its title (D1-16 residual; PR #12).
- **A design sentence binds only to a text that states the design**: the LGS criteria paper was
  cited for "a retrospective, nested case-control design" (D4-07; PR #16).
- **A claim without a figure is placed by its key phrase**, not by words scattered over forty
  pages (D3-09; PR #14). **A short list item is carried when the text has every one of its
  words**, and a list item inherits the nearest marked line's marker (D4-20; PR #17).
- **A pinned paper keeps its markers below the display floor**: the BREATHS protocol scored 10
  percent and lost all fifteen (D4-20; PR #17).
- **A decline sentence carries no marker** and a wholly declining answer stands as the decline
  state (D3-15; PR #14).

### The figure check
- **A figure must sit beside the claim's own terms**, not merely somewhere in the paper: "21 to
  45%" bound to a paper carrying only the 45 percent, RFTC figures lent to LITT, register bands
  attributed to EURAP (R3; P1-01, P3-01, P9-01, P10-01; PR #6). The window is the figure's
  sentence and the ones before it, never the one after.
- **The matcher must not cry wolf.** Loop 2 found it flagging BREATHS's own 220 and 110,
  "Thirteen", "11 p.m." and "1.66 h" (D2-07; PR #12), and loop 4 found "2,709" removed because of
  a comma (D4-01; PR #17). Normalisation now covers ranges and leading-zero decimals (R5, P9-14),
  number words, PDF hyphenation, "N (P)" table cells, abbreviated units and clock times (D2-07),
  space and comma thousands groups, thin spaces, PDF glyphs ("1¢66 § 0¢52 h", "8·29"), decimal
  proportions ("F2 is 0.37" carries 37 percent), a time unit after its interval (D4-10, D4-19;
  PR #17), and the abbreviations a paper defines ("perampanel (PER)") (D1-12; PR #8). Fifty
  figure-and-passage rows from the four reports are the regression set
  (`figure-normalisation.test.ts`).
- **The outcome and the follow-up must match**: "DRE occurred in 31%" cannot vouch for a relapse
  claim, and "after a median follow-up of 700 days" is not "at 12 months" (D2-02, D2-07; PR #12).
  "All p < x" is checked per listed outcome (D4-13), an "adjusted" ratio or a "median" is placed
  only by a passage that says so (D4-18), and a sample size is placed by its noun (D3-02; PRs
  #14, #17).
- **The denominator comes from the figure's own sentence** (loop 8 D8-01). An n anywhere in the
  paragraph used to satisfy the pairing, which is how a mixture-model class's "22%" was served as
  "22% (n = 1,674, full analysis set)" with the pooled denominator of a different sentence, under
  a High confidence badge. The pairing now reads the figure's own sentence or table row, plus two
  rules that make it right rather than merely strict: a count the paper writes as the numerator
  of the share ("19 patients (28%)") agrees with a cohort size the claim pairs with it when the
  two make the share (19/67 is 28%, which is what the gate was cutting out of the anti-NMDAR
  Results sentence - D8-05); and an analysis set the claim names beside a figure the paper pairs
  no n with must be named in the figure's own sentence or row label.
- **A figure belongs to the arm its own phrase names** (loop 8 D8-02). "39.7% and 22.1% of
  patients who received perampanel ... and 35.7% and 17.1% of patients who received placebo" is
  one sentence with two arms, and every word of a claim about the placebo arm sits somewhere in
  it. Where the claim allocates an arm and the located sentence allocates one for that figure -
  received, randomised to, allocated to, assigned to, treated with, switched to, converted to -
  they must be the same arm.
- **The figure audit is a gate, not a footnote** (loop 2 section 6; D2-02, D2-03, D2-12; PR #12).
  A figure the cited passages do not carry beside the claim used to stay in the prose with an
  italic line under it listing bare numbers.
- **A table row is never dropped for one cell.** The failing cell reads "not verified", the
  verified cells stand, the row keeps its marker (or inherits the text that carries its passing
  figures), and the addendum names the figures; the table turn used to come back with one row of
  three (D5-05, D4-06). A cell that states an analysis set ("FAS") or "not reported" in a column
  whose heading asks for a quantity is marked the same way: the check can neither pass nor fail
  it, and How this works promises that mark for every cell it could not verify
  (`markUnverifiableCells`, loop 6 D6-16a). One addendum line covers both kinds.
- **A located figure is bound to its population clause** (loop 6 section 6; D6-01). Loop 5 made
  recall excellent and left precision resting on the outcome noun, so a figure passed when it
  merely sat near the right words: the EXPERIENCE subgroup paper's 16.0% seizure freedom "in
  patients with and without psychiatric comorbidity" was sold as the rate for the LEV-to-BRV
  switchers, whose 13.9% the very next paragraph gives. Now, when the located paragraph frames a
  population of its own (`statesPopulation`), the claim's population must be covered by that
  paragraph: every distinctive word of the claim's qualifier (`claimPopulation`,
  `populationWords`) must be in the located sentence, its window or its paragraph. A paragraph
  that frames no population contradicts none, and a sample size or a follow-up is judged by its
  noun as before. A sentence that only points back ("continuous seizure freedom in 13.7% of these
  patients") inherits the population the sentence before it named, so the second bullet of an
  answer cannot escape the check the first one failed.
- **The outcome test is exact where the paper itself is exact** (loop 6 D6-03). "Continuous
  seizure freedom" is not "seizure freedom" and "all-cause discontinuation" is not
  "discontinuation for adverse events". A curated set of discriminating modifiers (continuous,
  sustained, complete, all-cause, drug- or treatment-related, serious, definite, probable) is read
  from the claim's clause and from the clause of the located occurrence (`clauseAround`, splitting
  on semicolons outside brackets); a difference fails the figure only when the paper itself uses
  that modifier to tell two figures of the same outcome family apart (`distinguishesModifier`),
  so a paper that only ever writes "all-cause mortality" contradicts nothing when the answer says
  "mortality".
- **A table cell is checked under its column heading** (loop 6 D6-03). A cell states no outcome of
  its own - "11.7% (FAS)" - so the heading above it is read as part of the claim
  (`tableCellHeadings`, aligning header and body cells by pipe position and tolerating the markers
  the generator writes after the closing pipe). The brivaracetam row's 12-month seizure freedom
  cell verifies at 14.9% (n = 1111, FAS); the continuous rate of 11.7% does not.
- **A range's upper bound takes the quantity of its lower bound** (loop 6 D6-05, D6-06). Nothing
  sits between the two numbers of "(95% CI: 1.07- 4.68)" or "a range of 23 to 71 years", so the
  quantity phrase is read from the lower bound (`rangeLowerBound`), and a range the claim states
  is placed by the same two numbers written as a range in the located sentence
  (`rangeInSentence`). A statistic's own qualifier ("median", "adjusted") is read from the
  figure's own clause, not from anywhere in the sentence, so "the median age was not stated, but
  the mean age was 45 (range 23-71)" is no longer removed for the word "median".
- **An analysis set named beside a figure pairs its size** (loop 6 D6-06). When the claim and the
  located sentence name the same analysis set (`analysisSetIn`: FAS, mFAS, safety, retention, ITT,
  per-protocol) and the paper writes that set's n as a count of people ("Analyses included 1644
  adults"), an n the located bracket does not repeat still agrees: "71.1% (n = 1644, full analysis
  set)" is the paper's own retention figure.
- **A marker is emitted only for a paper that carries the figures** (loop 6 D6-12): a sentence
  whose figures all pass keeps only the markers whose located passage carries them, when at least
  one does; a marker whose text could not be read stays, because unverifiable is not unsupported.
- **Locate first** (loop 5 section 6; D5-01 to D5-04; PR #20). Loop 5 found fourteen sentences
  the cited paper carried word for word removed ("80% of EDs in Group 1 were clustered during the
  sleep period", the "937 (52%)" and "Number deceased 60 87" cells, "The remaining 24 participants
  completed", "odds ratio = 10.00, 95% CI (1.68, 59.31)" inside a bracket with a semicolon, an
  "0⋅70" the extraction wrote with the dot operator) and seven wrong quantities under a clean badge
  (a "50% responder rate" read as a rate of 50%, an all-cause discontinuation as an adverse-event
  one, a worsening-frequency rate as seizure freedom, a share paired with another population's n).
  Both were the same defect: a window of nearby words was tested instead of the sentence the figure
  lives in. Now every occurrence of a figure is located and judged as its own sentence or table
  row (`locateFigure`); the claim is placed when that sentence shares the claim's quantity words,
  every outcome family the quantity names, or the question's routing entity, and a table cell by
  its row label and column headings or by a "13 (50%)" pair the claim states together
  (`quantityPhrase`, `countWithShare`); and the located sentence must agree on the responder
  threshold (`isThresholdAt`: a round "50% reduction" is a definition, "45.7% reduction" a result)
  and on the n the claim pairs in its own bracket (`pairedNsAt`: the located bracket, or an n in
  the located paragraph when it has none). A name the figure's own subject gives it must still be
  in the window unless the paper is about that name (it abbreviates it or names it throughout:
  `isSubjectOf`), so an RFTC review's 76% is still not LITT's. A figure's clause, not its
  sentence, decides which question names and follow-up apply to it (a comparison sentence gives
  each study its own figure). Number normalisation now covers the dot operator, British and
  American spellings ("enrolment", "generalised", "favourable"), "IQR" for "interquartile", a
  lower-cased interval label ("(iqr 256, 967) days"), a bracket-aware sentence end ("(FAS; n =
  1111)") and a duration found as the bare number of a table row whose label names the unit
  ("Follow-up duration, y").

### The cohort, the rescue and the replacement
- **The cohort is the pin.** Loop 3 found the anti-NMDAR hazard ratio under a question about the
  LGI1 cohort with a clean badge (D3-01), and loop 4 a Dravet series' "25 of 205" under the
  video-EEG mortality cohort riding through four turns under High confidence (D4-01, D4-02).
  Both were fixed by a question-level guard that forced every result sentence to cite a paper
  "about that cohort", matched from titles and summaries; loop 7 found the same defect across
  antibodies, where the guard did not reach. **That guard is gone.** Retrieval no longer sees a
  neighbouring cohort's paper (see the retrieval pin above), so there is nothing to guard against
  after the fact, and the one case the pin cannot prevent - the platform citing outside its own
  `resource_filters` - is handled by dropping the citation, not by matching strings.
- **Two populations under one question are named** (loop 5 D5-12, TDE; PR #20): under a
  designated cohort, a planning question, or a pin holding several of one cohort's papers, each
  result sentence that names no study of its own opens with the paper it comes from ("In *Infradian rhythms ... in healthy adults*, 70% (369/525) ..." beside "In
  *Multiday cycles of heart rate ...*, participants with epilepsy documented 3,619 seizures"), by
  the study acronym its title carries or the title itself (`studyLabel`).
- **The rescue looks a figure up before withholding it.** Loop 3 found the gate withholding
  correct figures from retrieved but uncited papers (C1, R1, TD1, E2: 71.1 percent and 1644
  "could not be verified" a minute after the portal cited them) because the audit only saw the
  paragraphs the platform happened to cite (D3-02; PR #14). The pool is the cohort papers, the
  pinned papers, the prior turns' papers, then the retrieved resources by relevance, with each
  paper's DA summary and key takeaways as a text of its own. **Under a pin the pool is the pinned
  papers and nothing else** (D7-01): the rescue may rebind a figure to a paper the question named,
  never import one from a neighbouring cohort. A second-hand figure is looked for first-hand
  before it is judged (D4-15; PR #17).
- **The replacement is restricted.** Loop 4 found the "paper itself reports" step swapping a
  correct 12-month "64.2% (n = 4201)" for a ">12 months, 29.5%" sentence, replacing an honest
  decline with an exposure quote from another paper, and stitching an irrelevant SUDEP sentence
  into a comparison (D4-03, D4-04, D4-14; PR #17). Now: same figure, same time point, beside the
  claim, from a cohort paper under a designated cohort, at most one quote per sentence, never
  over a decline, and the "paper's own finding" after a second-hand figure must share the
  question's outcome and add a figure the answer does not already state.
- **An emptied answer is retried on the pinned paper before it is declined**, whole
  (`rag_strategies: full_resource`) when a pin is in force, and a decline about who was in a named
  study is asked on that paper's resource filter first (D4-09, D3-01; PR #17, D7-04).
- **The paper's own figure for the question's outcome is offered after a removal** when the
  model's figure differs from it (loop 5 D5-14; PR #20): the consortium paper's "At 12 months, a
  favourable mRS (≤ 2) occurred in 154 (67%) patients" after an "80% (n = 231)" no paper carries,
  as an italic line naming the paper, cited, never as a substitute for the removed sentence, at
  most two per answer. **It never restates a figure the gate just removed** (loop 7 D7-10; PR
  this loop): loop 7 printed "its figures (3.6, 2.9, 4.4) could not be verified" and, two lines
  below, the same three quoted from the same paper. An offer that carries any removed figure is
  now skipped - where the cited paper does carry the sentence, the answer is to rebind and keep
  it, never to contradict the notice. The offering paper must also carry one of the question's
  cohort terms, so a lacosamide retention rate is not offered under a question about implanted
  devices.

### Reference lists and studies the collection does not hold
- **A bibliography can never ground a sentence** (loop 6 D6-02). The reference cut was line-based,
  and a PDF extraction wraps one entry over three or four lines, so no single line read as an
  entry and the bibliography was never cut at all: "the RANSOM Study found that nonadherence to
  antiepileptic drugs is associated with increased mortality" was a reference **title** in two
  cited papers, restated as a result. `stripReferenceSection` now joins the blank-line blocks
  after a References heading before testing them, and removes a wrapped bibliography entry
  anywhere else in the text.
- **The corpus boundary covers a study the answer introduces**, not only one the question names
  (loop 6 D6-02). `namedStudies` reads every study acronym in the gated answer; one that neither a
  cited title, the catalogue nor any cited text carries has nothing behind it, and the sentence
  naming it is replaced by "*A sentence naming X was removed: this collection holds no paper
  reporting that study, and no cited source states the finding.*" (`stripUnheldStudyClaims`). A
  study the question names keeps the softer banner, because the statements do come from sources
  that cite it.
- **A removal takes its dependants with it** (loop 7 D7-07; PR this loop). The figure gate
  already dropped a conclusion that rested on a sentence it removed, but a study-claim removal
  runs after the gate, so loop 7 J9 removed the fabricated RANSOM finding and kept both "Yes,
  medication adherence is associated with mortality in people with epilepsy" and "This suggests
  that adherence to medication regimens is crucial" - neither of which any source stated.
  `removeDependants` now runs after `stripUnheldStudyClaims`: a conclusion anywhere after a
  removal goes, a connective that tied the next sentence to it is stripped, and the opening
  assertion goes too when no sentence left in the answer shares two content words with it. A
  citation whose only sentence went with the removal leaves the answer with it, so the chips and
  the "n cited" count describe the text on screen. If the removals leave nothing but the notes,
  the answer is declined with the closest matches instead of shown as a page of notices.
- **The lead claim is a dependant too** (loop 8 D8-09; PR this loop). The opening assertion rule
  above only fired when the *removed* sentence shared two content words with the lead, which loop 8
  U9 did not: the fabricated RANSOM sentence was worded nothing like "non-adherence to
  antiepileptic drugs is linked to increased mortality", so that lead stood on after every sentence
  carrying evidence for it had gone, cited to a paper whose only use of the word is a Discussion
  sentence about drug response in adherent patients. Whether the removed sentence happened to share
  the lead's wording is not the test - what stands behind the lead *now* is. The rule is now: after
  any removal, a lead that asserts a finding (`assertsFinding`), states no figure of its own and
  shares two content words with no sentence left in the answer goes with the removals, and the
  answer is declined with the closest matches. A lead that carries its own figure stands on that
  figure; a framing line, a list lead-in or the portal's own note about what the sources do not say
  asserts no finding and is left alone. The same change fixed the support scan itself: it split the
  remaining text with `splitSentences`, which does not read a note's closing "...finding.*" as a
  sentence end, so a note swallowed the sentence after it and the support that sentence carried was
  invisible. It now splits with the notes cut out, like the pass above it.

### Second-hand figures and sections
- **"Second-hand" is defined against a Results section, so a paper without one is not judged on
  its sections** (`reportsOwnResults`). A review article's headings are "Newly Approved Drugs",
  "Investigational Drugs": the splitter reads its whole body as one long introduction, and every
  figure in it looked second-hand. That is why "What fenfluramine dose is recommended in Dravet
  syndrome, with and without stiripentol?" returned its four correct figures (0.7 mg/kg/day,
  26 mg/day, 0.4, 17) and then called all four second-hand, from the review's own dosing
  paragraph. With no Results section the provenance decision falls back to the paper's own
  attribution cues alone ("as reported by", "et al.", a trailing reference marker).
- **A proportion printed beside the group the paper counted is the paper's own count**
  (`carriesOwnDenominator`): "(PHYSICIANS: n = 19, 100%)", "(n = 1,674, 23.6%)". Earlier work is
  quoted as a claim, not as a denominator. This is what a consensus statement's recommendations
  look like, and the extraction places them after the Discussion heading, so the Dravet
  consensus's own panel vote read as second-hand and the whole lamotrigine recommendation was cut
  out of the answer. The cue does not apply to a sentence that cites earlier work or ends on a
  reference marker.
- **The located passage is judged at the figure, not at the passage's first words**, and only
  within that passage: an occurrence past its end, or in another section, is a different
  occurrence and is not read as this one.
- **A figure the cited paper carries only in its Introduction or Discussion is that paper citing
  other studies** (D2-06, D2-14, D3-08; PRs #11, #14). Table rows, figure legends and a line of
  bare statistics under its label are first-hand wherever the extraction placed them; a figure
  the paper's own sentence attributes to earlier work is second-hand wherever it sits; "Methods
  and analysis" reads as Methods (the BREATHS protocol's 110 was a false flag). On a named-cohort
  or "what should I assume" question a sentence left with a second-hand figure is removed, not
  annotated (D4-02, D4-12; PR #17). **The judgement reads the located passage**, not every
  occurrence of the number in the paper (loop 5 D5-15; PR #20): the placebo-response paper's own
  "22% in the lower group" in its results no longer clears the introduction's "over 22% after
  2020" the answer repeated; Markdown headings ("## Introduction:") section a text the platform
  extracted from HTML; and a block of short lines is figure or graphical-abstract text, the
  paper's own data ("312 saliva samples collected" was a false flag).
- **Section is not provenance** (loop 6 D6-04, D6-07). A Discussion sentence whose subject is the
  paper itself ("our cohort", "we found", "this trial", "the present study") is first-hand
  wherever the extraction placed it, and the subject is read across the wrapped lines of a PDF
  extraction but never across a section heading (`speaksOfOwnWork`). The abstract is checked
  before anything is declared second-hand: the lacosamide trial's own placebo 50% responder rate
  of 46.3% sits in its abstract as well as its Discussion, and is its finding. Only the abstract
  counts for that check - a number a Results sentence happens to share with an Introduction figure
  is a different quantity (D5-15).
- **A flagged sentence never leads an answer** (loop 6 D6-07). When the paper's own finding is
  quoted after a sentence the answer itself flags as second-hand, and that sentence is the
  answer's lead (`leadSentence`), the quote takes its place at the front and the flagged sentence
  follows it.
- **An assessment's answer key and a briefing's key takeaway are never a second-hand figure**
  (loop 5 D5-10; PR #20): a quiz question whose correct answer or explanation states a figure its
  source paper carries only where it cites other studies is dropped and counted
  (`omitted_secondhand`, said on the page), and a takeaway whose figure every referenced paper
  carries only second-hand is dropped and counted (`takeawaysSecondhand`).
- **A quiz question is bound to the paper that carries its quote** (loop 6 D6-09; PR this loop).
  The model writes the title from memory and the quote from the passage in front of it, so where
  the two disagree the quote wins: `attributeQuiz` resolves `source_quote` against the retrieved
  passages first and only falls back to the model's title, and the route then locates the quote in
  the bound paper's own extracted text, rebinding to whichever retrieved paper carries it. A
  question whose quote no retrieved paper carries is dropped and counted (`omitted_unsourced`,
  said on the page). The brief asks for more questions than the reader wanted and the route
  trims what survives back to the requested `count`, so the checks cost the reader nothing.
- **A quiz quote is the paper's own words, checked as a run, not as a bag of words** (loop 7
  D7-11; PR this loop). Overlap of content words resolves a quote to a paper; only a verbatim run
  proves it, because a generated page summary reuses the paper's own vocabulary - loop 7 was
  shown "anti-LGI1 antibody-mediated encephalitis was associated with better recovery" in
  quotation marks as a paper's own words when that sentence appears only in a `da-pagesummary`
  field. `textCarriesQuote` now also requires a run of at least eight consecutive words (or the
  whole quote when it is shorter) in the paper's extracted text (`carriesVerbatimRun`). The
  model's own `source_label` is kept only when it names the same paper the quote resolved to;
  otherwise it is dropped, so one question never carries two attributions. The over-ask is now
  `count + max(3, count / 2)`, the server adds it for an API caller that sends a `count` and no
  brief of its own, and when fewer than `count` survive the object carries `requested` and both
  quiz surfaces say "N questions of the M asked for survived the source check".

### Denominators, effect sizes, designs, years, drugs, authors
- **Every proportion carries its n and analysis set** by prompt rule, and the audit lists the
  ones that do not with the n the passage gives (D1-14; PR #8). A denominator pairs only within
  the figure's own bracket or table cell, never the nearest n, never for a threshold, an SMR, an
  HR or a CI (D2-07, D3-13, D4-05, D4-11; PRs #12, #14, #17). The 95 of a confidence interval and
  an effect size are not proportions. **The body is never rewritten** (loop 5 D5-03, D5-13; PR
  #20): loop 5 found the corrector replacing a correct "11% (3/28)" with a frontal-lobe row's "4
  of 36" and a correct "(n = 121)" with a nested "(56 (46.3%))". The n a sentence pairs with a
  share in its own bracket is now part of the figure check (`pairedNsAt`), so a pairing the
  located passage contradicts fails the figure and the sentence is removed or replaced by the
  paper's own sentence; the denominators line reads only the passage the audit located the
  figure in, adds an n only from that passage's own bracket or cell, and says nothing for a quoted
  sentence, a share the paper gives as a decimal proportion ("F1 = 0.8"), a confidence interval
  or an effect size.
- **The addendum only asks where a denominator exists to be asked for** (loop 6 D6-08 and the
  carried-over D5-13; PR this loop). It says nothing inside a table, whose n column is the
  denominator; nothing for a share the located passage states as a fitted statistic (an F score,
  an AUC, an R squared, a kappa: "We found F1 = 0.8, suggesting that 80% of EDs ..."); and
  nothing for a share the paper qualifies with a range or an interquartile range instead of an n
  ("17.1% (range 13-28%)"), whose bounds are not proportions either. Where the paper writes the
  count one clause further on - "(n = 583), the most common reasons were lack of effectiveness
  (232 [39.8%])" - the line gives "232 of 583" rather than complaining: the "count [percent]"
  shape is read in square brackets as well as round ones, and a single "n =" in the same sentence
  supplies the whole.
- **A protocol's sample size is planned recruitment, not enrolment** (loop 5 D5-11; PR #20): a
  kept sentence that states a planned sample from a paper that is a protocol (its masthead, its
  title, or methods in the future tense) gets the note "[n] is the study protocol: the numbers it
  gives are the planned recruitment, not the enrolment", with the results paper's own enrolment
  sentence quoted when the answer also cites one.
- **The effect size a passage carries is stated** when a risk question got none, named for what
  it is for, covariate lists skipped (D2-09, D3-10; PRs #12, #14). It must be an effect of what
  the answer is about (loop 6 D6-05): the effect sentence has to share one of the answer's own
  distinctive words, beyond the terms the question already names, so a lamotrigine aHR is not
  offered under an answer about tonic-clonic seizure frequency. No effect size is better than the
  wrong one.
- **Study design first**: a modelling, simulation or preclinical source that the first citing
  sentence did not name as such leads the answer with a design line, on every intent (D2-11,
  D1-15; PR #12); the clinical variant names each source's design in the source's own words
  (D1-15; PR #8).
- **Years come from resource metadata** and every four-digit year is post-checked; the recency
  prompt receives the retrieved resources' publication years (R3; P10-12, P8-10; PR #6).
- **A drug called contraindicated must be called that by a cited passage**, and a drug the
  sources flag is never dropped from a which-drug answer (R3, R5; P1-01, P3-13; PR #6). A
  drug-safety prequery fires only for a medication entity on a treatment-decision question, so
  "NMDAR", "LGI1" and "JAMA" are not drugs (P9-14, P9-15; PR #6).
- **A safety verb binds to its medication, and to its own strength** (loop 7 D7-03; PR this
  loop). The check used to pass on the word being somewhere within 150 characters of the drug,
  which let "carbamazepine is contraindicated in JME" stand on a paper whose only occurrence of
  the word is "Valproate is now contraindicated in women of childbearing potential", and let a
  paper that says only "Carbamazepine, which is not recommended for treatment of JME" carry the
  much stronger claim. Now (`answer-audit.ts` `verbBindings`, `safetyClaims`, `safetySupport`,
  `stripUnsupportedSafetyClaims`):
  - Every safety verb in a passage is **bound to the medication nearest it**, subject before
    object, within 120 characters; a verb with no medication near it binds to nothing.
  - Verbs carry a **strength**: `prohibited` (contraindicated, a black box or boxed warning,
    must not be used) outranks `discouraged` (should be avoided, not recommended, avoid X). A
    claim is supported only by a binding at its own strength or higher, on the same drug.
  - `aggravates` (worsens, exacerbates, precipitates) and `firstline` (first-line, drug of
    choice) are **families of their own**, not weaker prohibitions: "not recommended" does not
    say a drug worsens seizures, and neither says anything about first-line use.
  - Only **prose** binds: a table row ("Generally avoided | Eslicarbazepine | Good") has a verb
    in a cell and no subject, so nothing is bound in it and it is never quoted back.
  - A claim with no drug of its own ("Therefore, these medications are effectively
    contraindicated") takes the medications named earlier **in the same paragraph**.
  - The note now says what the sources do say: "*The cited sources do not state that
    carbamazepine is contraindicated here. What the cited sources do say: "Carbamazepine, which
    is not recommended for treatment of JME" [1].*" The check reads the whole cited resource,
    not a retrieved snippet.
- **"X and colleagues" over a paper X did not write is rewritten** to the paper's first author,
  and a named author scopes retrieval to that author's articles (D1-05, D2-23; PRs #8, #11).
- **An author review lists one item per paper** (loop 6 D6-10; PR this loop): every author-scoped
  paper the answer cited, then every other scoped source on the topic, each with its title, year,
  journal and study design from the catalogue and a marker of its own, so a paper the answer cited
  but never named cannot go unlisted. When the question asks each paper for its enrolment ("... and
  what sample size did they enrol?"), that clause is stripped from the retrieval text and answered
  per paper from the paper's own words: the enrolment sentence quoted verbatim, and a protocol's
  future-tense sentence quoted as planned recruitment. The protocol note now also fires on a
  past-tense enrolment claim over a citation to a protocol ("The study enrolled approximately 450
  participants"), not only on planning wording.
- **A study the question names that no held title carries gets a boundary sentence** ("This
  collection does not hold SANAD II itself ...") (D1-16; PR #8). The banner fires only on
  something that can be a study name (loop 7 D7-12; PR this loop): at least four characters, and
  never a condition abbreviation with a reference marker glued to it by the extraction - "SUDEP1"
  and "JME1 2" told the reader the collection held no SUDEP or JME paper while citing one
  (`isStudyAcronym`). Its wording is conditional too: "the statements above come from sources
  that cite it second-hand" is only written when there are cited sources and one of them refers
  to the study; otherwise it reads "and no source cited above refers to it" (D7-08).

### Removal is real
- **A figure the notice names has left the page** (loop 8 D8-02). The gate removes sentences, but
  the audit reported figures for the whole answer, so an answer could print 22.1% and 14.9% under
  a footnote saying both had been removed - and the 22.1% it printed was the wrong trial arm's -
  while a briefing printed 90.5% and 79.8% under the same contradiction. Two rules settle it,
  and `figuresStillPrinted` states the invariant that a test asserts end to end:
  - the gate **sweeps**: a kept sentence that repeats a removed figure without a passing check of
    its own is removed too, and a table row keeps its place with the cell blanked;
  - the notice is **reconciled** against the emitted body (`reconcileRemovals`, read before the
    addendum is appended, since the notice itself names the figures): a figure still standing,
    verified where it stands, was not removed from the answer, so the notice stops naming it and
    the audit's `figuresRemoved` reports only what left. A removal whose every figure survives
    elsewhere says so in words instead of naming none.
- **The same holds for a briefing**: figures are checked once per section against that section's
  own sources and once per takeaway against every source, so one claim can fail while another
  carrying the same number passes. A section that was never checked and repeats a failed figure
  loses that sentence; the audit then names only what no section or takeaway prints, and the
  statements list follows the sections.
- **A marker needs a distinctive phrase, not a shared vocabulary** (loop 8 D8-04). A figureless
  sentence is placed by its words, and "antiseizure medications" is a phrase every paper in this
  corpus carries: "This proportion has remained stable despite the introduction of new
  antiseizure medications" took markers to a rat sodium selenate study and a GWAS. A text must
  now carry one of the sentence's **rare bigrams** - a pair at most a third of the cited texts
  carry - to lend it a marker, the rule `rareWords` already applied to words.
- **What the answer states with nothing behind it is named** (loop 8 D8-04). A sentence the
  binding could tie to no passage stays - it is often the answer's own framing - and one italic
  line names it, so the reader is not left counting markers. A sentence about what the sources do
  **not** say is the portal's own account of the collection and is not named.
- **A finding credited to other authors is second-hand** (loop 8, the sleep-deprivation answer).
  "Rajna and Veres showed that sleep deprivation ... increased seizure risk by 6-fold" carries no
  figure token, so the second-hand check never saw it. A reporting verb after a surname the cited
  paper's author list does not contain is now named in a line of its own
  (`attributedElsewhere`).

### The decline
- **A refusal always shows the closest matches, labelled not used**, named in the text, from a
  semantic find re-ranked by overlap with the question's outcome noun, with conference
  proceedings, attachments and (for a question about people) preclinical papers dropped, or "no
  close match" when nothing clears the floor (R8; P8-02, P9-20; D2-10, D3-19, D4-23; PRs #6,
  #11, #13, #16).
- **An answer that states figures with every marker stripped, or that the gate emptied, is
  withheld** with the figures named, never shown as bare prose (D1-02, D2-12; PRs #7, #12).
- **An answer with no citation at all is withheld, whether or not it states a figure** (loop 7
  D7-08; PR this loop). Loop 7 Z2 asserted "The RANSOM study found that nonadherence ... is
  associated with increased mortality" with no citation event, no source and no figure, and a
  figure in the text was the only trigger for the uncited refusal, so prose sailed through. The
  test is now whether the answer asserts anything at all: `leadSentence` skips the check's own
  italic notes, so an answer that is only "*The cited sources do not state ...*" still stands -
  that is a finding, not an unsourced claim - while an assertion with nothing behind it is
  replaced by the decline.
- **A decline names a study the question named that the collection does not hold** (loop 7
  D7-08): "This collection holds no paper reporting RANSOM." (`corpusDecline` `missingStudy`).
- **The paper the decline would name is read before the refusal** (loop 8 D8-11, and the D3-02
  regression it reopened). Loop 8 refused "what is the standardised mortality ratio in people
  with epilepsy and a psychiatric comorbidity" and "what proportion of patients with juvenile
  myoclonic epilepsy relapse after withdrawing antiseizure medication" while naming, in the
  refusal itself, the paper that answers each. Where the gate empties an answer, each removed
  figure distinctive enough to identify a finding (a share, a decimal or a count of three digits
  or more, never a confidence level) is looked up in the retrieved papers the pin allows, and the
  sentence carrying it is quoted and cited in place of the refusal - from the paper's own
  results, not a table row or legend, not its introduction or discussion, not a sentence
  reporting earlier work, not a bound inside somebody's interval, and about the outcome the
  question asked for (`rescueQuote`).

### Confidence
- **Confidence is led by the check, not the platform score.** Loop 1 found groundedness 1 on a
  correct answer and 5 on a wrong "not in corpus" one (D1-13; PR #8); loop 2 asked that the
  platform score never raise the verdict (D2-15; PR #12). The REMi scores are shown as the
  platform's self-assessment (D3-16; PR #14). "High confidence" is earned only by the check.
- **The reader sees "Checking N figures" until the gated text lands**, and the badge then reads
  what happened: "N figures checked", "· 1 sentence removed", "· 2 sentences replaced", with the
  figures and where they were found in the tooltip (R5, D2-17, D3-16; PRs #6, #12, #14).

## 3. Platform features the layer leverages

| Feature | Where |
|---|---|
| Stored search configurations (`portal-intent-<id>` `-ask` and `-find`, `portal-search`, `portal-ask`, `portal-doc-*`) with label filters, features and reranker centrally managed | Route, probe, platform ask. `docs/INTENT-ROUTING.md` section 4. Re-ensured through `POST /api/admin/t/:slug/search-configs/ensure`. |
| `prequeries` strategy: each entry is a full find request with its own `resource_filters`, `top_k`, `filters` and `weight` (ten at most) | Pinned papers, question clauses, prior-turn papers, preferred labels, sub-questions. `groundingPrequeries`. |
| `resource_filters` on `/ask` and `/find` | **The retrieval pin**: an ask whose names resolved runs over those resources alone. Also document chat, the pinned retry, author scope, reformatting turns, the per-entity finds, the pinned targeted finds, and the finds that decide whether a pin holds. |
| `extra_context` (twelve blocks at most) | Document tables and key-resources blocks, prior turns' passages and answers, publication years for a recency question, a pinned paper's own sections on the pinned retry. |
| Chat `context` | Follow-up turns (USER and AGENT text). |
| `citations: true` and the platform's paragraph-level attribution | The starting point of the binding; a citation's page and paragraph for the reader; the paper a marker names, which the marker rule then requires to carry the sentence's figures. Never combined with `answer_json_schema` (platform 500). |
| `rag_strategies`: `full_resource`, `neighbouring_paragraphs`, `graph_beta`, `prequeries` | Per intent (`answer.strategy`, `answer.graph`), and `full_resource` for the rescue read inside a pin - the one extra ask reads the pinned paper whole rather than through the paragraph budget the first pass already used. `full_resource` is never sent beside a wide paragraph budget. |
| Request-level `top_k` (wins over the configuration's) and `max_tokens` | Author scope (60), reformatting turns (40 paragraphs, 1800 tokens). |
| The extraction endpoint (a resource's extracted text, page by page) | Every cited text, the pool texts, the evidence-card passages, the document-chat tables. Cached per process. |
| Data-augmentation fields (summary, key takeaways, curated title, headline) | Cohort matching on summaries, the rescue pool, merchandised citation chips, closest-match ranking. |
| `mode: semantic` find | The closest matches a decline names. |
| `answer_json_schema` | The classifier, the decomposition and briefings. The structured-statement path was trialled for answers in loop 4 and not adopted (section 5). |
| REMi quality scoring | The trailing `quality` event; advisory only. |
| Resource metadata (`year`, `published`, `authors`, `doi`, `pmcid`, `pmid`) | Year checks, author scope and attribution, identifier lookups. |

## 4. What is deterministic and what is a model call

Deterministic, string matching over the platform's extracted texts and fields, no model in the
loop: routing rules and identifier resolution; the study guard; the name resolution behind the
retrieval pin; prequery selection; the stream shaping; the first-sentence verifier; binding; every
audit check; the rescue, replacement and qualifier; the gate; the addenda; evidence-card passage choice; closest-match
ranking; the confidence verdict. These are all unit-tested without the platform.

Model calls, all the platform's own: the intent classifier (only when no rule fires; memoised);
the decomposition into sub-questions (evidence-seeking questions of eight words or more); the
answer generation itself (once, plus at most one retry); the "interpreted as" rephrase (best
effort, first turn only); the REMi quality judge (capped at 8 s, advisory). None of them can add
support to a sentence: a marker is kept, inherited or lent only where a cited or retrieved text
verifiably carries the claim.

## 5. Known limits

The lessons of review loop 4 (sections 2, 3 and 6), and what remains open after
PRs #16 and #17:

- **Substitution can be wrong even when each check passes.** The loop 4 replacement step
  produced errors of its own (D4-03, D4-04, D4-14). It is now restricted to the same figure at
  the same time point from a cohort paper, but a quote chosen by outcome and figure can still be
  beside the point of a comparison sentence (T2 in loop 3, one bullet). The safer path is
  removal with the reason stated, which is what the layer now prefers.
- **Over-removal is the price of the gate.** A correct figure the platform did not cite and the
  rescue pool does not carry is removed. N06's own "154 (67%)" is offered under the removal as the
  paper's own figure for the outcome, never as a substitute; the honest removal stands. The pool
  is bounded (eight cited texts, eight further texts) for latency.
- **A figure the paper's own abstract states loosely passes.** Loop 5 PD read "In 10 years, 82723
  Australian adults had incident epilepsy, whereas 125223 formed the prevalent cohort" as a
  ten-year projection of 125,223; the located sentence carries the figure beside "10 years" and
  "Australian adults", and only the results section says the 125,223 is the 2024 base. A
  deterministic check that reads one sentence cannot overrule the abstract's own wording.
- **The population qualifier applies only when every occurrence of the figure in the bound text
  opens with the same frame**, so a figure a paper gives twice (whole cohort and subgroup) is
  left unqualified (D3-07 for N02, partly open).
- **A generator label the paper does not use** ("overall" for a stratum the paper never reports
  as overall, EB in loop 4) is not corrected: deciding that would need a rule about strata the
  paper does not report.
- **Stray extra markers on multi-claim sentences** ("[1][2]" where one paper carries the claim)
  remain where the sentence states no figure: the marker rule keys on the papers a figure was
  located in, and a sentence with no figure gives it nothing to key on (D3-09, partly).
- **A question that names nothing gets no pin, and the wording sensitivity with it.** "What
  placebo responder rate should I assume" and "what is the adjusted hazard ratio for SUDEP" name
  no cohort, trial or antibody the catalogue can resolve - SUDEP titles five papers, so it is a
  topic - and retrieval still decides which paragraph leads. Those are the families that still
  answer differently under different wordings (D7-04, D7-05).
- **A pin of several papers is several studies.** The Australian consortium's name resolves to
  four papers, and which of them retrieval ranks first still varies with the wording. Every result
  sentence is labelled with the paper it came from so a sub-study's figure is never read as the
  cohort's headline, but the leading figure can still be a sub-study's (D7-02, partly).
- **The platform's retrieval stage (6 to 10 s on a pinned question) is the latency floor.** The
  route chip is on screen at 0 s and the sources shortlist at 0.8 to 2.6 s; a sub-6 s first
  sentence is not reachable from the application (D3-05, D1-09).
- **The REMi judge often hits its cap** on long contexts and returns no scores; the answer is
  complete and checked before it, and the confidence label does not need it.
- **Structured statements (`answer_json_schema` with `{claim, figure, time_point, population,
  study}`) were trialled on twelve questions and not adopted**: 16 of 24 statements verified, but
  the path fabricated a Melbourne incidence the prose path declined, mis-assigned a study, and
  cannot carry paragraph citations (`citations` cannot be combined with `answer_json_schema`).
  Kept as a candidate for a per-statement "figures table" view (PR #17).
- **Two of an author's papers reach the grounding set only through reference-list paragraphs**
  (his papers cite each other), so they are neither shown nor cited; a paragraph-level content
  filter the platform does not offer, or a body-only re-retrieval per paper, would be needed
  (D1-05 residual; PR #11).
- **The layer only ever verifies what the extraction holds.** A figure in an image-only table,
  or a paper with a garbled extraction, cannot be found; the Extraction Lab is the tool for that.

## 6. Tests

All deterministic modules are unit-tested next to the code (`deno task check` runs them; 417 at
PR #17). The ones that cover the trust layer:

| Test file | Covers |
|---|---|
| `apps/api/src/intent-router.test.ts` (24), `catalog-lookup.test.ts` (14) | Rules, gene shapes, identifiers, author-year, results and terse rules, rules-only classifier, identifier and author resolution |
| `apps/api/src/study-guard.test.ts` (11), `ask-entities.test.ts` (17), `ask-author.test.ts` (14), `ask-prequeries.test.ts` (7), `ask-session.test.ts` (12), `ask-retry.test.ts` (9), `ask-terse.test.ts` (4) | Pinning and cohort designators, per-entity pins and question clauses, author scope, author constructions and attribution, prequery gating, follow-up context, follow-ups that stay within the earlier papers, reformatting and its budget, the single-retry policy, the terse topic pin |
| `apps/api/src/answer-shape.test.ts` (32), `ask-stream-verify.test.ts` (8) | Reference-block stripping, sentinels on stream and text, truncation, table rows; the first verified sentence |
| `apps/api/src/citation-binding.test.ts` (26) | Sentence binding, entity and rare-word rules, design terms, list items, table-row markers, renumbering |
| `apps/api/src/answer-audit.test.ts` (32), `figure-normalisation.test.ts` (13, fifty figure rows from the four reports), `figure-rescue.test.ts` (18), `secondhand.test.ts` (12), `answer-gate.test.ts` (15), `loop4-guards.test.ts` (17), `loop5-locate.test.ts` (28, the loop 5 figures: located sentences and table rows, quantity phrases, thresholds, pairings, the cohort and stitch rules, offered findings and the protocol note), `ask-grounding.test.ts` (10), `loop8-removal.test.ts` (7, the removal invariant end to end, the arm rule, the denominator's own sentence, the rescue before a decline, the attribution and uncited notes) | Figure matching and normalisation, outcome and follow-up conflicts, denominators, contraindications, years; the rescue, cohort guard and replacement; section classification and second-hand figures; the gate, removal note, effect sizes and design lead; the loop 4 guards; locate first; `bindAndAudit` end to end with stubbed texts |
| `apps/api/src/clause-pin.test.ts` (35), `loop8-clause-pin.test.ts` (4) | Decomposition, condition and medication scopes, clause resolution and inheritance, the phrase tie-break, framing strip, composition with one marker per sentence, clause declines; and the whole path end to end through `/ask` |
| `apps/api/src/evidence-passages.test.ts` (6) | The card passage that carries the bound claims |
| `apps/api/src/app.test.ts` (87) | The `/ask` route with a stub provider and management: routing, the grounding gate, fallback, pinned retry, withheld decline, the contraindication strip, document chat, author lookup, prequery expectations, the audit event |
| `packages/retrieval/src/providers/arag/intents.test.ts` (12), `ask-structured.test.ts`, `display.test.ts` | Configuration names and filters, prequery construction, structured asks, refusal detection |
| `apps/web/src/lib/confidence.test.ts`, `answer-marks.test.ts`, `answer-text.test.ts` | Audit-led confidence, the badge and inline marks, marker rendering |
| `packages/core/src/docs.test.ts`, `apps/web/src/pages/HowItWorksPage.test.ts` | The in-app description of the check stays in step with the page |

Live verification is part of every PR: the persona's own questions re-run against the live box
with each figure checked against `/resources/:id/content`, pasted into the PR body (PRs #6 to
#17), plus headless screenshots at 1440 px and a true 390 px viewport, light and dark, and a
22 px root font.

## 7. Files

```
apps/api/src/app.ts                     the /api/t/:slug/ask route (steps 1 to 12, the retry loop)
apps/api/src/intent-router.ts           routing rules, classifier threshold, decision shape
apps/api/src/catalog-lookup.ts          identifier, author and person-name resolution against the catalogue
apps/api/src/study-guard.ts             study names, eponyms, described cohorts -> pinned papers
apps/api/src/name-pin.ts                the retrieval pin: antibodies, consortia, acronyms, cohorts, drugs -> resource_filters;
                                        medication and condition scopes for a clause
apps/api/src/clause-pin.ts              clause pinning: decompose -> resolve each clause to one paper -> one-paper ask -> compose
apps/api/src/ask-entities.ts            question clauses, comparison entities, closest-match ranking
apps/api/src/ask-author.ts              author scope, attribution correction, paper listings
apps/api/src/ask-prequeries.ts          which mandatory prequeries fit; medication and treatment-decision tests
apps/api/src/ask-session.ts             follow-up context: prior ids, passages, reformatting turns
apps/api/src/ask-retry.ts               the one extra ask and its reason
apps/api/src/ask-terse.ts               the topic pin for a terse question that pinned nothing
apps/api/src/answer-shape.ts            reference-block stop, sentinel rewriting, truncation, forwardable slices
apps/api/src/ask-stream-verify.ts       the first verified sentence while streaming
apps/api/src/ask-grounding.ts           bindAndAudit: the orchestration of steps 8 to 11; cited texts; context blocks
apps/api/src/citation-binding.ts        sentence splitting, supportScore, binding and rendering
apps/api/src/answer-audit.ts            figure normalisation and matching, denominators, contraindications, years, designs
apps/api/src/figure-rescue.ts           the rescue pool, quotes and replacement cues
apps/api/src/secondhand.ts              section-aware reading, second-hand figures and the note
apps/api/src/answer-gate.ts             gateFigures, removal note, effect sizes, design lead
apps/api/src/evidence-passages.ts       the passage each evidence card shows
apps/api/src/docs-answer.ts             the Help assistant's sentinel rewriting (docs scope)
packages/retrieval/src/prompts.ts       variant preambles, the denominator and design rules
packages/retrieval/src/providers/arag/index.ts   ask(): the platform request, groundingPrequeries, stream events, REMi
packages/core/src/index.ts              AskEventSchema (route, sources, searched, fallback, delta, verified,
                                        stage, citation, audit, quality, done), Citation, ScoredResource
apps/web/src/pages/AskPage.tsx          event handling, the checking state, the verified line, done replacing the text
apps/web/src/lib/confidence.ts          audit-led confidence
apps/web/src/lib/answer-marks.ts        the badge and inline marks
apps/web/src/components/AnswerStream.tsx, QualityGauge.tsx, StageTimeline.tsx, EvidenceTable.tsx
```

## 8. The `AskEvent` stream, in order

`route` (or two `route`s when the classifier follows a rule-less start), `searched?`,
`fallback?`, `sources` (probe shortlist), provider `stage`s, `sources` (grounding set),
`interpreted?`, `delta`s with `verified?` among them, `stage auditing started { figures }`,
`stage auditing completed`, `sources` (re-chosen passages), `citation`s (renumbered), `audit`,
`done { text, refused, truncated? }`, `stage validating`, `quality?`. A decline is `sources`,
`delta`, `done { refused: true, text }`, with `audit` before it when the gate emptied an answer.
