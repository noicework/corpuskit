# Fisheries user taxonomy - who uses a fisheries research portal

The people the marine tenant is tested as. `docs/PERSONAS.md` holds the two headline personas
that gate deploys (P1 fisheries scientist, P2 grains researcher); this document expands the
fisheries side into the full stakeholder set, because the tenant's funder is a co-funded fisheries
research funder whose audience is wider than research scientists.

Modelled on a typical co-funded fisheries research funder's stakeholder base: government and the
fishing and aquaculture industry jointly fund it, and its remit spans commercial wild-catch,
aquaculture, recreational fishing, Indigenous fishing, the post-harvest supply chain, and the
management agencies that regulate all of the above.

Each persona below has a **question signature** - the shape of retrieval it stresses. The signature
is the reason the persona is in the test set. Two personas with the same signature would be one
persona.

---

## F1 - Stock assessment scientist
**Who:** Dr Sarah, stock assessment scientist at a state fisheries agency or CSIRO; a research
provider funded by the institute.
**Job:** check what work already exists on a species or method before scoping new work; pull
evidence for a stock status brief; reuse a method someone has already validated.
**Question signature:** technical and method-named. Expects precise, passage-level citations and
is unforgiving about a method being described loosely. Stresses **deep single-document retrieval**
and method vocabulary.

## F2 - Fisheries manager / regulator
**Who:** a manager at a state fisheries department or AFMA.
**Job:** assemble the evidence base behind a management decision - a size limit, a spatial closure,
an effort control - and be able to defend it.
**Question signature:** "what is the evidence for X control", plus **currency-sensitive** questions
about present-day status. Stresses the portal's honesty about the age of its evidence base: the
corpus is a historical report archive, and a current stock status question must not be answered as
though it were current.

## F3 - Aquaculture production manager
**Who:** a farm or hatchery manager - oysters, prawns, barramundi, salmon, abalone.
**Job:** solve an operational problem on the farm this week.
**Question signature:** practical and operational - disease, husbandry, feed, water quality,
stocking density. Wants "what worked and at what scale", not a literature review. Stresses
**applied/quantitative extraction** and is the persona most likely to be failed by a hedged,
abstract answer.

## F4 - Biosecurity and aquatic animal health officer
**Who:** a state biosecurity officer or DAFF aquatic animal health staffer.
**Job:** assess an incursion risk, or respond to a disease event, using what is already known.
**Question signature:** pathogens, marine pests, translocation, surveillance. Frequently asks
"has this happened before, and what did we do". Stresses **synthesis across many documents** and,
critically, **premise checking** - a biosecurity officer working from a wrong recollection of an
event must be corrected, not agreed with.

## F5 - Research portfolio / investment manager
**Who:** the funder's own staff, managing the research portfolio.
**Job:** find what has already been funded on a topic, what a given project delivered, and where
the gaps are - including whether a new proposal duplicates existing work.
**Question signature:** **questions about the collection itself** rather than about fisheries -
"which projects cover X", "what did project 2016-170 conclude", "how has investment in Y changed".
This is a fundamentally different retrieval shape (metadata and aggregation, not passage synthesis)
and is where a passage-retrieval portal is structurally weakest. Included precisely for that
reason.

## F6 - Industry body and extension officer
**Who:** Seafood Industry Australia, a state peak body, or an extension officer.
**Job:** turn research into something a fisher, a processor or a board will read.
**Question signature:** applied and economic - gear technology, bycatch mitigation practicalities,
post-harvest quality, market and cost. Often **underspecified** ("tell me about oysters"), because
they are orienting rather than searching. Stresses graceful handling of broad, vague entry points.

## F7 - Recreational, Indigenous and community sector representative
**Who:** a recreational fishing peak body, an Indigenous fisheries body, or a community researcher.
**Job:** represent a sector's interests with evidence - participation, catch share, customary
rights, regional economic contribution.
**Question signature:** the **human dimensions** of fisheries - social, economic, cultural. Stresses
a part of the corpus that keyword-tuned fisheries retrieval tends to under-serve, and surfaces
whether the portal treats non-biological research as first-class.

## F8 - Sceptical evaluator
**Who:** not a funder-side user at all - a technical buyer, an external reviewer, a journalist, or
a solutions engineer demoing the portal to a room that wants to catch it out.
**Job:** break it.
**Question signature:** deliberately adversarial - out-of-domain questions, plausible-but-absent
questions, questions with a false premise baked in, enumeration traps, and prompt injection. This
persona exists because **the demo will be played by this person whether or not we cast them**, and
a fabricated answer in front of a prospect is the single worst outcome the portal can produce.

---

## What each persona contributes to the test set

| Persona | Stresses | Failure that would matter most |
|---|---|---|
| F1 | Method vocabulary, passage-level citation | A method described loosely or mis-attributed |
| F2 | Evidence-for-decision, evidence currency | Presenting a 1998 stock status as current |
| F3 | Applied specifics, numbers | Hedged abstraction where a number exists |
| F4 | Multi-document synthesis, premise checking | Agreeing with a wrong recollection |
| F5 | Corpus-meta and aggregation | Inventing a project or its findings |
| F6 | Broad entry points, economics | Refusing a vague-but-answerable question |
| F7 | Human-dimensions coverage | Treating social research as out of scope |
| F8 | Refusal, premise challenge, injection | Any fabrication at all |
