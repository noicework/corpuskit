/**
 * In-app user documentation for the research portal.
 *
 * The documentation is authored here as a typed content module (rather than
 * loose Markdown files) so a single source of truth is importable by BOTH the
 * web front end (which renders the help section) and the API (which ingests the
 * pages into the knowledge box as retrievable resources). Registry-free Deno +
 * esbuild bundles a TypeScript module cleanly into the web app with no file-
 * system reads at runtime, which a Markdown-directory approach could not do.
 *
 * ISOLATION CONTRACT (see packages/retrieval/CLAUDE.md): every documentation
 * resource is labelled with `DOCUMENTATION_LABEL` under `DOCUMENTATION_LABELSET`
 * and carries an origin URL of `docResourceOrigin(page.id)`. The research search
 * configurations exclude that label; the documentation-scoped configurations
 * include only it. The server-side cross-check that guarantees isolation even if
 * the platform's stored `filter_expression` misbehaves keys off BOTH the label
 * and this origin prefix - so keep them in lockstep with the provider.
 */

/** Reserved labelset + label that isolate documentation from research content. */
export const DOCUMENTATION_LABELSET = 'content-type'
export const DOCUMENTATION_LABEL = 'documentation'

/**
 * Origin-URL scheme stamped on every ingested documentation resource. A stable,
 * app-controlled marker the retrieval cross-check can trust even when the box's
 * classification labels are not returned on a retrieval payload (the label is
 * the primary signal; this is the deterministic belt-and-braces one).
 */
export const DOC_ORIGIN_PREFIX = 'portal-doc:'

/** The stable resource slug for a documentation page in the knowledge box. */
export function docResourceSlug(pageId: string): string {
  return `doc-${pageId}`
}

/** The origin URL stamped on a documentation resource (see DOC_ORIGIN_PREFIX). */
export function docResourceOrigin(pageId: string): string {
  return `${DOC_ORIGIN_PREFIX}${pageId}`
}

/** Whether an origin URL identifies a portal documentation resource. */
export function isDocOrigin(url: string | undefined | null): boolean {
  return typeof url === 'string' && url.startsWith(DOC_ORIGIN_PREFIX)
}

/** One heading-plus-body block within a documentation page. */
export interface DocSection {
  /** Section heading, rendered as an anchored sub-heading. */
  heading: string
  /**
   * Markdown-ish body. Supports paragraphs (blank-line separated), `### `
   * sub-headings, `- ` bullet lists, `1. ` numbered lists and `**bold**`.
   */
  body: string
}

/** A single documentation page - a stable id, a title and ordered sections. */
export interface DocPage {
  /** Stable slug used in the URL, the resource slug and cross-references. Never change it. */
  id: string
  /** Category the page files under in the table of contents. */
  category: string
  /** Page title. */
  title: string
  /** One-line summary shown under the title and in search results. */
  summary: string
  /** Ordered content sections. */
  sections: DocSection[]
}

/** Ordered categories - the top-level grouping in the documentation sidebar. */
export const DOC_CATEGORIES = [
  'Getting started',
  'Finding answers',
  'Exploring the corpus',
  'Working with the portal',
  'Administration',
] as const

export type DocCategory = (typeof DOC_CATEGORIES)[number]

// ---------------------------------------------------------------------------
// The documentation content. Kept accurate to the features that exist - each
// page maps to a real route/surface in apps/web/src/pages.
// ---------------------------------------------------------------------------

export const DOC_PAGES: DocPage[] = [
  {
    id: 'getting-started',
    category: 'Getting started',
    title: 'Getting started',
    summary: 'What the research portal is, how to choose a portal and find your way around.',
    sections: [
      {
        heading: 'What this is',
        body: 'The research portal is a fast, credible way to explore and question a body of ' +
          'research. You ask a question in plain language and get an answer that is grounded in ' +
          'real documents and cited back to them, then explore the underlying reports, projects ' +
          'and the relationships between them.\n\n' +
          'Every portal runs on its own knowledge box - the connected content estate for one ' +
          'organisation. What you can search, ask and browse is exactly the content in that box, ' +
          'nothing more and nothing invented.',
      },
      {
        heading: 'Choosing a portal',
        body:
          'You can run more than one portal, each on its own body of research. Switch between ' +
          'them from the **Knowledge boxes** menu at the top left of the header - open it from the ' +
          'name and logo in the corner. Each entry shows the organisation it belongs to, and the ' +
          'one you are in is ticked.\n\n' +
          'The same menu has **Add a portal** and **Manage portals** for administrators. A portal ' +
          'with no knowledge box connected yet needs an administrator to connect one before ' +
          'search and answers will work.',
      },
      {
        heading: 'Finding your way around',
        body: 'The header navigation is the same on every portal:\n\n' +
          '- **Explore** - the home surface: a question box, suggested questions and topic rows.\n' +
          '- **Search** - find documents fast, or ask for a short cited answer over them.\n' +
          '- **Library** - browse, sort and filter the whole corpus.\n' +
          '- **Ask** - a full, grounded conversation with saved sessions.\n' +
          '- **Graph** - a visual map of the corpus (titled the Knowledge map in the app).\n' +
          "- **Tools** - connect MCP clients and other research tools to the portal's knowledge.\n" +
          '- **Help** - this documentation, with its own scoped search.\n' +
          '- **Manage** - administration (connecting content, taxonomy, enrichments and health).\n\n' +
          'Press **Cmd/Ctrl+K** anywhere to open the command palette and jump straight to a ' +
          'search or a question. Use the theme toggle in the header to switch between light and ' +
          'dark.',
      },
      {
        heading: 'Exporting your work',
        body: 'Everything you produce can leave the portal as a file, and each export confirms ' +
          'itself with a short status line naming the file it saved:\n\n' +
          '- **Ask** - **Export** on a session saves the whole research trail (questions, ' +
          'answers, sources and quality scores) as a Word document.\n' +
          '- **Investigations** - **Export to Word** saves the case with its evidence and ' +
          'synthesis as a Word document.\n' +
          '- **Generate** - **Export to Word** saves a briefing, comparison, timeline, FAQ or ' +
          'pros and cons with its references, and **Export to PDF** opens a print-ready copy in ' +
          "a new tab so you can save it as a PDF from your browser's print dialog.\n\n" +
          'Answers and investigations export to Word only; there is no PDF button on Ask. For a ' +
          'PDF of an answer, make a briefing on the same question in Generate and use Export to ' +
          'PDF, or print the Ask page from your browser and choose Save as PDF.',
      },
    ],
  },
  {
    id: 'how-this-works',
    category: 'Getting started',
    title: 'How this works',
    summary: 'Where the content comes from, what happens to each document, how a question is ' +
      'answered and what the portal checks before it shows you an answer.',
    sections: [
      {
        heading: 'Where the content comes from',
        body: 'The portal reads one collection: research papers, their supplementary files and ' +
          "video material, loaded into the portal's knowledge index by the people who run it. " +
          'Nothing else is read. What you can search, ask and browse is exactly what is in that ' +
          'collection, and the Library shows the current count.\n\n' +
          'The illustrated version of this page, **How this works** under Help, shows the ' +
          'live figures for the collection and a diagram of the flow described here.',
      },
      {
        heading: 'What happens when a document is added',
        body: 'Every document goes through the same steps before it can be found:\n\n' +
          '1. **Text and tables are extracted** from the file page by page, so a passage can ' +
          'later be traced back to where it sits in the paper. Video material is transcribed.\n' +
          '2. **Enrichment agents read the extracted text** and write a plain-language summary ' +
          'and key takeaways, assign topic and study-design labels, label individual passages, ' +
          'and record the relations between the entities the paper mentions (conditions, genes, ' +
          'medications, researchers and institutions) for the knowledge graph.\n' +
          '3. **The document, its passages and its labels are indexed** for retrieval by meaning ' +
          'and by exact term.\n\n' +
          'The original file is never altered. The generated fields sit beside it and are shown ' +
          "on the document page as generated fields, never as the paper's own words.",
      },
      {
        heading: 'How a question is answered',
        body: 'Four things happen between the question and the answer:\n\n' +
          '1. **The question is routed.** The portal reads the question and chooses the retrieval ' +
          'configuration that suits it: an identifier or a bare term is an exact lookup that ' +
          'lists the documents; a question about choosing or dosing a treatment is a clinical ' +
          'decision that always checks contraindications and monitoring; a broad question is an ' +
          'evidence review grounded on full text; a question about what is newest is answered ' +
          'newest first with the year stated; a question that names a table, a data sheet or a ' +
          'protocol document reads the supplementary files beside the papers; everything else ' +
          'runs on the default configuration. The choice is shown beside the answer as a chip, ' +
          'and you can change it and ask again.\n' +
          '2. **The index returns the passages.** Before anything is retrieved, the portal ' +
          'resolves the things the question names against the collection: an antibody or ' +
          'antigen, a named consortium, registry or network, a trial acronym, a quoted title, a ' +
          'cohort you describe, and the medications and syndromes it knows. Where a name ' +
          'identifies a small enough set of papers, **retrieval is restricted to those papers**, ' +
          'the way asking a question of a single document is restricted to that document, so a ' +
          "question about one antibody cannot be answered with a neighbouring cohort's figures: " +
          "that cohort's paper is never in front of the answer at all. A name that titles " +
          'many papers is a topic rather than a name and restricts nothing, and a medication on ' +
          'its own never restricts retrieval, because a drug name titles a laboratory study and ' +
          'a clinical trial alike. Where a part of your question is not answered by the papers ' +
          'the names resolved to, the paper that does answer it joins them. When the collection ' +
          'does not hold a study the question names, the answer says so rather than answering ' +
          'from a paper that only cites it.\n' +
          '3. **A question that asks for a number is answered one paper at a time.** A question ' +
          'that asks for a rate, a proportion, an age or a comparison is first broken into its ' +
          'clauses - "compare brivaracetam and perampanel" is two questions, "how old were the ' +
          'participants and how many were female" is two clauses about one study - and each ' +
          'clause is resolved to the one paper that answers it, using the names it uses and the ' +
          'medications and conditions it mentions. Each clause is then answered from that paper ' +
          'alone, the way a question about a single document is answered, and the answers are ' +
          'put together so that **every sentence carries exactly one citation**: no sentence ' +
          'draws on two papers, because no part of the answer was written with two papers in ' +
          'front of it. Where a clause has no paper, the answer says so for that clause and ' +
          'answers the rest. Questions that ask what the evidence is for something, rather than ' +
          'for a number, are still answered across papers. A question that names no medication ' +
          'is never split by medication: "which medications are contraindicated in this ' +
          'syndrome" is one question, and where the collection holds a consensus statement or ' +
          'guideline for the condition you name, that is the paper it is answered from.\n' +
          '4. **The answer is written only from those passages.** Nothing is drawn from general ' +
          'knowledge or from the internet. Every sentence that states a finding carries a ' +
          'citation to the passage it came from (an item in a list takes the citation of the ' +
          'paragraph it belongs to), and opening the citation shows that passage in the paper. ' +
          'A sentence carries a marker only for a paper that shares a distinctive phrase of ' +
          'it, not merely its vocabulary, so a phrase every paper in the field uses lends no ' +
          'marker; where a sentence is left with none, the answer names that sentence under ' +
          'itself rather than leaving you to count markers.',
      },
      {
        heading: 'How the answer is checked before you see it',
        body: 'Before an answer is shown, the portal checks it against the cited text, sentence ' +
          'by sentence:\n\n' +
          '- **Figures.** Every number, percentage, dose and range in a sentence is first ' +
          'located in the cited paper, and the sentence or table row that carries it there ' +
          "must share the claim's own quantity - its outcome, the noun the figure measures or " +
          'the name the question asked about - about the same outcome, at the same follow-up, ' +
          'with the same responder threshold and the same denominator. The denominator is read ' +
          "from the figure's own sentence or table row, never from elsewhere in the paragraph: " +
          'a number the paper writes as the count behind a share ("19 patients (28%)") agrees ' +
          'with a cohort size the answer pairs with it when the two make that share, and an ' +
          'analysis set the answer names beside a figure the paper pairs no size with must be ' +
          "the paper's own words. Where one sentence reports two arms, each figure belongs to " +
          "the arm its own phrase names, so a placebo arm's rate is never served as the drug " +
          "arm's. The outcome must match " +
          'exactly wherever the paper itself is exact: where a paper reports both "seizure ' +
          'freedom" and "continuous seizure freedom", one does not stand for the other. A ' +
          'figure the cited ' +
          'passage does not carry is looked for in the full text of the retrieved papers: where ' +
          'one of them carries it beside the same claim, the sentence is cited to that paper ' +
          'instead; where the figure is there but cannot be tied to the claim as the answer ' +
          "stated it, the sentence is removed and that paper's own sentence on the outcome you " +
          'asked about is quoted in its place. A figure found nowhere means the sentence is ' +
          'removed, and the answer says that it was. Removal is applied to the answer, not ' +
          'only recorded under it: a figure the note names has left the page, and a figure ' +
          'that still stands somewhere in the answer, verified where it stands, is not named ' +
          'as removed. Where the check empties an answer altogether, the paper the removed ' +
          'figure was found in is read before anything is declined, and the sentence that ' +
          'carries the figure there - from its own results, not its introduction, discussion ' +
          'or tables - is quoted and cited in place of the refusal.\n' +
          '- **Populations.** A figure is bound to the group the paper reports it for. Where ' +
          'the passage a figure was found in names a group of its own, the group your question ' +
          'asked about must be that group or narrower: a rate the paper reports for "patients ' +
          'with psychiatric comorbidity" is not the rate for "patients who switched from ' +
          'levetiracetam to brivaracetam", and a sentence that points back ("of these ' +
          'patients") is checked against the group the sentence before it named. When the ' +
          'question names a cohort, trial or study, the papers that cohort names are the only ' +
          "papers retrieval reads, so no sentence can carry another cohort's figure, and a " +
          'figure the cited paper only quotes from other studies is removed rather than ' +
          'annotated. Where the question names no cohort, such a ' +
          "figure is kept but marked as second-hand, with the paper's own finding beside it - " +
          'and the marked sentence never leads the answer. What counts as second-hand is ' +
          'judged by the words, not the section: a figure a paper states in its own voice ' +
          '("our cohort", "this trial", "we found"), reports in its own abstract, or prints ' +
          'beside the group it counted ("physicians: n = 19, 100%"), is that ' +
          "paper's finding wherever the extraction placed it, and a paper with no results " +
          'section of its own - a review, a consensus statement - is judged on those words ' +
          'alone. A finding the answer credits by ' +
          'name to authors who did not write the paper cited beside it ("Rajna and Veres ' +
          'showed ...") is that paper\'s account of earlier work, and is named as such under ' +
          'the answer whether or not it carries a figure.\n' +
          '- **Named studies.** A sentence cited to the wrong paper is replaced by the named ' +
          "paper's own sentence only when that sentence carries the same figure at the same " +
          'time point, quoted verbatim and cited; otherwise the sentence is removed, and a named ' +
          'paper the answer never cited is read directly before anything is declined. A ' +
          'denominator the answer pairs with a figure is checked as part of the figure: a ' +
          'pairing the paper contradicts is removed and said so, never rewritten, and a ' +
          "denominator is only ever added from the figure's own bracket or table cell. When " +
          'the papers that answer one question describe different populations, each sentence ' +
          "says which paper it comes from; a protocol's planned recruitment is named as such " +
          "beside the results paper's enrolment. A study the answer names that this collection " +
          'holds no paper for, and that no cited paper mentions, has nothing behind it: that ' +
          'sentence is removed and the answer says so. Reference lists are cut out of every ' +
          'paper before the check reads it, so a title in a bibliography can never stand in for ' +
          'a finding.\n' +
          '- **Years and safety verbs.** A year must come from a cited resource. A ' +
          'medication the answer calls contraindicated must be called that, by name, in a cited ' +
          'passage: the verb is read with the medication nearest it, so a passage calling a ' +
          'different drug contraindicated is not support, and a passage that only calls the drug ' +
          '"not recommended", or says it may aggravate seizures, does not carry the stronger ' +
          'word. Where the sources say something weaker, the answer says so and quotes what they ' +
          'do say. The same holds for "should be avoided", a boxed warning and "first-line", ' +
          'and a medication the cited sources flag is never dropped silently.\n' +
          '- **What rested on a removed sentence goes with it.** When a sentence is removed, the ' +
          'conclusion drawn from it goes too, and so does the opening answer when nothing else ' +
          'left in the answer stands behind it. An answer left with nothing but the notes the ' +
          'check wrote is declined, with the closest matches, rather than shown.\n\n' +
          'While the answer is still streaming, its text is shown as unchecked (muted, with a ' +
          '"still streaming, the check follows" mark), its first complete sentence is checked ' +
          'against the papers retrieval found and, when it passes, the paper that carries it is ' +
          'named under the answer; the checked answer then replaces the streamed text. A ' +
          "follow-up in the same conversation carries the earlier answers' cited papers with " +
          'it: a question about "that study" is answered from those papers, with their own ' +
          'paragraphs and tables in front of the generator, and a request to put the earlier ' +
          'answers in a table keeps every row: each cell is checked under the column heading ' +
          'above it, so a figure filed under the wrong outcome is caught, and any cell the ' +
          "check could not verify - a figure it could not tie to that row's source, or an " +
          'analysis set name where the column asked for a figure - is marked "not verified" ' +
          'rather than the row dropped. Chat ' +
          'with a document runs the same check ' +
          "against that document's own text and shows the same badge.\n\n" +
          'These checks are plain text comparisons against the extracted text of the papers, ' +
          'with no language model in the loop, so the check cannot invent support. The ' +
          'confidence label under the answer is led by that check: an unverified figure, year ' +
          'or contraindication marks it low, removed sentences cap it at moderate, and high is ' +
          "earned only when every figure was found. The platform's own quality scoring of how " +
          'well the answer addresses the question, how firmly it is grounded and how relevant ' +
          'the retrieved passages were can lower the label but never raise it, and is shown as ' +
          "the platform's self-assessment. The check decides: a fluent answer whose figures the " +
          'cited papers do not carry is not shown as high confidence.',
      },
      {
        heading: 'What you can do with it',
        body: '- **Search** finds documents fast, with a short cited answer over them or the ' +
          'results alone.\n' +
          '- **Ask** is the full conversation: a grounded, cited answer, follow-ups that keep ' +
          'the context, saved sessions and deep research for broad questions.\n' +
          '- **Library and the reader** browse the whole collection and open any paper at the ' +
          'cited passage.\n' +
          '- **Chat with a document** asks questions of one paper alone; its answers are checked ' +
          "against that document's own text and badged the same way.\n" +
          '- **Investigations** gather evidence around a research question over time and ' +
          'synthesise it.\n' +
          '- **Generate** writes a briefing, comparison, timeline or set of questions and ' +
          'answers from the collection, with references.\n' +
          '- **Assessment** builds a knowledge check on any area of the collection.\n' +
          '- **The knowledge map** shows the conditions, genes, medications, researchers and ' +
          'institutions in the collection and how they connect.\n' +
          '- **Watches** re-run a search or a question daily and flag it when the collection ' +
          'has something new.\n' +
          '- **Exports** take an answer trail, an investigation or a generated artefact out as ' +
          'a Word document, and a briefing as a print-ready copy for saving as a PDF ' +
          '(portable document format) file.',
      },
      {
        heading: 'What it deliberately does not do',
        body:
          '- It never answers without a source. An answer with nothing to cite is not shown.\n' +
          '- It says plainly when the collection does not hold something, and shows the closest ' +
          'passages it found, rather than filling the gap.\n' +
          '- It does not browse the internet. Every answer comes from the collection alone.\n' +
          '- It does not change the papers. Extraction and enrichment sit beside the original, ' +
          'which stays exactly as published.',
      },
      {
        heading: 'Under the hood',
        body: 'For technical readers. The knowledge index, retrieval, answer generation, ' +
          'citations, the answer quality signal, the enrichment agents and the entity relations ' +
          'graph are provided by Progress Agentic RAG (retrieval-augmented generation), the ' +
          'knowledge platform the portal runs on. The portal adds the intent routing, the ' +
          'verification layer described above, and the reading tools: the reader, document ' +
          'chat, investigations, generation, assessment, watches and exports. The platform sits ' +
          'behind one retrieval interface in the portal, and the credentials for it never ' +
          'reach the browser.',
      },
    ],
  },
  {
    id: 'search',
    category: 'Finding answers',
    title: 'Search: a cited answer, or just the results',
    summary: 'Search answers by default - a short cited answer over the matching documents. ' +
      'Results only turns the answer off.',
    sections: [
      {
        heading: 'Answered by default',
        body: 'Type your query and the portal reads the top results and writes a short, cited ' +
          'answer over them, with the sources it drew on listed underneath. Every claim carries ' +
          'a citation you can follow back to the passage it came from.\n\n' +
          'The ranked documents are always there below the answer, each with the passage that ' +
          'matched, so you can judge a source and open it yourself.\n\n' +
          '**Results only** turns the answer off when you just want the document list - it is ' +
          'instant and answer-free. Press it again to bring the answer back. From an answer you ' +
          'can **Continue in Ask** to keep asking follow-ups.',
      },
      {
        heading: 'Retrieved and cited - the difference',
        body: 'An answer is built in two steps, and the portal shows you both:\n\n' +
          '- **Retrieved** is what search found for your question. It is the whole pool the ' +
          'answer was written from, including passages that turned out not to be useful.\n' +
          '- **Cited** is the smaller set the answer actually drew on - the numbered [1] markers ' +
          'in the text. Each one links to the exact passage it came from.\n\n' +
          'So every cited source was retrieved, but not every retrieved source is cited. Seeing ' +
          'both is deliberate: the cited set tells you what the answer rests on, and the wider ' +
          'retrieved set lets you check whether anything relevant was found but passed over.',
      },
      {
        heading: 'How matching works',
        body: 'Three retrieval modes sit under the box:\n\n' +
          '- **Hybrid** (the default) combines keyword and semantic matching - the best all-round ' +
          'choice.\n' +
          '- **Semantic** matches on meaning, for when the right words are hard to pin down.\n' +
          '- **Keyword** matches on the exact terms, for a known phrase, code or name.\n\n' +
          'Open **Filters** to narrow by topic or by document kind (for example Report or ' +
          'Submission). The **Match strength** control switches between **All** results and ' +
          '**Strong** ones only - a strong match scores 60% or higher on the calibrated relevance ' +
          'scale.',
      },
      {
        heading: 'Reading results honestly',
        body:
          'Each result carries a relevance score on a calibrated 0 to 100 scale, so a weak match ' +
          'looks weak rather than being inflated to the top. Results below the noise floor are ' +
          'dropped, and a query the corpus cannot answer honestly returns nothing rather than ' +
          'surfacing irrelevant hits.\n\n' +
          'Reference lists and bibliographies stay findable but never outrank real body text, and ' +
          'near-duplicate pages are collapsed so you do not see the same content twice.',
      },
      {
        heading: 'More you can do',
        body:
          '- **Summarise these results** writes a quick synthesis across the current result set.\n' +
          '- **Watch this search** keeps the query and re-checks it daily - a dot appears next to ' +
          'the saved search when new results turn up.\n' +
          '- **People also ask** suggests related questions when the corpus has ones that ' +
          'genuinely overlap with your search.\n' +
          '- **Save** on any result adds it as evidence to your current investigation.',
      },
    ],
  },
  {
    id: 'assistant',
    category: 'Finding answers',
    title: 'Ask',
    summary: 'Ask questions conversationally, keep sessions, and run deep research.',
    sections: [
      {
        heading: 'A grounded, cited conversation',
        body: 'Ask answers questions in plain language and grounds every answer in the ' +
          'corpus. As an answer streams in you see the stages it moves through - interpreting the ' +
          'question, retrieving sources, writing and checking - then the finished answer with ' +
          'numbered citations you can click straight through to the source passage. It also shows ' +
          'how it read your question, as an "Interpreted as..." line above the answer.\n\n' +
          'Follow-up questions keep the context of the conversation, so you can drill in without ' +
          'restating everything each time.',
      },
      {
        heading: 'Reading the answer',
        body: 'Under each answer you get the full picture of what it stands on:\n\n' +
          '- The **sources** it used, and a note of the years they span (for example "Cited ' +
          'sources: 2016-2019"), so you can see how current the material is.\n' +
          '- An **evidence** list - each source with its matched passage and a relevance score.\n' +
          '- **Also retrieved** - relevant passages the answer did not lean on, kept visible so ' +
          'nothing is hidden.\n\n' +
          'Want to see the working? **Journey through the context** walks you through the ' +
          'passages the answer was built from, and adds a short AI verdict on each source - ' +
          'whether it **Supports**, is **Partial** or is **Not relevant** to your question. ' +
          '(That judgement is only worked out when you open the journey, so it is never generated ' +
          'for answers you do not choose to dig into.) Administrators additionally see **Show ' +
          'the pipeline**, a developer view of the retrieve, write and check stages behind it.\n\n' +
          'When an answer comes back thinly grounded, Ask offers to **re-answer it ' +
          'deeply** - re-running your question against the full text of the matching documents ' +
          'rather than the retrieved passages alone - so a weak first pass has a one-tap path to a ' +
          'stronger one.',
      },
      {
        heading: 'Sessions and your research trail',
        body: 'Each conversation is saved as a session in the sidebar. Start a **new session**, ' +
          '**rename** one, **reopen** an earlier one, or **delete** one you no longer need. You ' +
          'can **Export** a session as a Word-compatible document to keep the whole research ' +
          'trail: questions, answers, sources and the quality scores. Ask exports to Word only; ' +
          'for a PDF, see Exporting your work under Getting started.',
      },
      {
        heading: 'Deep research',
        body: 'Turn on **Deep research** to have the portal first map your question into focused ' +
          'sub-questions, research each of them, and then answer with full-document grounding. ' +
          'It is slower but more thorough for broad or multi-part questions. Questions about ' +
          'risk, safety, effects or comparisons are broken down automatically so decisive ' +
          'passages are not missed.\n\n' +
          'The list of sub-questions shown above a deep answer is the multi-step view of that ' +
          'research: each one was retrieved and answered on its way into the final answer, so ' +
          'you can see how the question was broken down and which parts the corpus covered. ' +
          'There is no separate "agentic" surface - the old /agentic address simply opens Ask.',
      },
      {
        heading: 'Feedback and watches',
        body:
          'Mark an answer **Helpful** or **Not helpful** to signal how well it landed. **Watch ' +
          'this question** to keep an eye on it - the portal re-checks it daily and flags it in ' +
          'Search when new results turn up. See **Watch a search** for how watches work.',
      },
    ],
  },
  {
    id: 'trust-and-citations',
    category: 'Finding answers',
    title: 'Trust, citations and confidence',
    summary: 'How to read the confidence signals, citations and the evidence table.',
    sections: [
      {
        heading: 'Every answer is cited',
        body: 'The portal never gives a bare, unattributed answer. Each factual claim carries a ' +
          'bracketed citation marker like [1] that links to the exact source passage, and the ' +
          'sources are listed beneath the answer. Citation numbers are assigned by the ' +
          "application, sentence by sentence, from the platform's own source attribution and " +
          "the cited papers' text: a sentence keeps a marker only when the cited paper carries " +
          'its words, its figures and the names it hangs on, so the number you click resolves to ' +
          'a passage that grounds that claim. Markers never sit on headings, and an item in a ' +
          'list takes the citation of the paragraph it belongs to.',
      },
      {
        heading: 'Every figure is checked before you see it',
        body:
          'Where an answer quotes figures, Ask checks them against the cited passages before the ' +
          'answer is complete. Every number, percentage, dose and range is located in the cited ' +
          "paper, and the sentence or table row that carries it must share the claim's own " +
          'quantity, about the same outcome, at the same follow-up, with the same responder ' +
          'threshold and the same denominator. A figure the cited passage does not carry is ' +
          'looked for in the full text ' +
          'of the papers retrieval found, and if one carries it the sentence is cited to that ' +
          'paper instead - and, under a restricted retrieval, only ever to one of the ' +
          'papers the question named. A citation marker is only ever left on a paper whose ' +
          "passage was where the sentence's figures were found: a marker on a paper that does " +
          'not carry the figure is dropped, and a sentence left with no marker is removed. A ' +
          'figure the cited paper only quotes from other studies is removed rather than ' +
          'footnoted when the question names a cohort.\n\n' +
          'A sentence whose figures cannot be verified anywhere is removed, and the answer says ' +
          'so in a note beneath it, naming the figures. A sentence cited to the wrong paper is ' +
          "replaced by the named paper's own sentence only when that sentence carries the same " +
          'figure at the same time point, quoted verbatim and cited; a decline is never replaced. ' +
          'A denominator the answer paired with a figure is part of the figure: a pairing the ' +
          'paper contradicts is removed and said so, never rewritten, and a denominator is only ' +
          "ever added from the figure's own bracket or table cell. A year must come from a " +
          'cited resource, and a medication called contraindicated must be called that, by name, ' +
          'in a cited passage: the verb is read with the medication nearest it, and a passage ' +
          'that only calls the drug "not recommended" does not carry the stronger word. When a ' +
          'sentence is removed, the conclusion that rested on it goes with it, and an answer ' +
          'with nothing left to cite is declined rather than shown.\n\n' +
          'While the answer streams, its text is shown as unchecked, in muted ink with an ' +
          '"Unchecked - still streaming, the check follows" mark, so nothing on screen reads as ' +
          'the answer before it has been checked. Its first complete sentence is checked against ' +
          'the papers retrieval found and, when it passes, "First sentence verified against" the ' +
          'paper appears under that sentence; "Checking N figures" shows until the checked answer ' +
          'replaces the streamed text in full ink. Document chat answers carry the same check and ' +
          "badge, against the open document's text. The badge beneath the finished answer then " +
          'reads what happened: ' +
          '"N figures checked", with any sentence removed or replaced counted beside it and the ' +
          'figures named on hover. If nothing verifiable is left, the answer is withheld and the ' +
          'portal says which figures could not be verified rather than showing them.',
      },
      {
        heading: 'The confidence signal',
        body:
          'Every finished answer carries a confidence control on its actions row, at the right ' +
          'beneath the answer. It reads **High confidence**, **Moderate confidence**, **Low ' +
          'confidence** or **Confidence not scored**, and it stays loud and labelled while the ' +
          'news is bad: a low-confidence answer shows a warning you cannot miss, a high-confidence ' +
          'one a quiet tick.\n\n' +
          "The label is led by the portal's own check of the answer against the cited papers. " +
          'An unverified figure, year or contraindication makes it low; removed sentences cap it ' +
          'at moderate; every figure found beside its claim, with most sentences carrying a ' +
          'citation, makes it high. High confidence is earned only by that check, never by a ' +
          'score alone.\n\n' +
          "Open the control to see what sits behind it, including the platform's self-assessment " +
          'of the answer across three dimensions - how well it answers your question (answer ' +
          'relevance), how firmly it is grounded in the sources (groundedness), and how relevant ' +
          'the retrieved context was (context relevance) - each shown as a plain score out of ' +
          'five with a one-line reading. Those scores can lower the label one step when ' +
          'groundedness is weak, and never raise it. When the check had nothing to judge and the ' +
          'scorer did not run, the control says so rather than guessing.\n\n' +
          'When confidence is low, the same panel offers to **re-answer the question deeply**, ' +
          'against the full text of the matching documents, so a thinly grounded first answer has ' +
          'a direct path to a firmer one rather than leaving you at a dead end.',
      },
      {
        heading: 'Honest refusals',
        body:
          'If the corpus does not hold enough relevant material to answer confidently, the portal ' +
          'says so before generating anything, names the closest matches it found in the text ' +
          'and lists them beneath the answer as closest matches, not used, rather than bluffing ' +
          'an answer. A question about a relationship no held paper studies is declined as a ' +
          'boundary, and a paper the question names is read directly before anything is declined. ' +
          'An honest "no direct evidence found" is a feature, not a failure.',
      },
      {
        heading: 'The evidence behind an answer',
        body:
          'Beneath an answer the evidence list shows every source it drew on. Each one quotes ' +
          'the paragraph that carries the claims cited to it, with the page it sits on, and a ' +
          'relevance score as a percentage, so you can weigh the sources at a glance; a weak ' +
          'match is labelled as one, and a bibliography paragraph is never shown as evidence.\n\n' +
          "When you want the AI's read on each source, open **Journey through the context**. It " +
          'adds a short verdict to every source - for example **Supports**, **Partial** or **Not ' +
          'relevant** - which then appears alongside the evidence. Working this out costs a little ' +
          'time, so it runs only when you ask for it, never automatically on every answer. The ' +
          'verdicts are advisory, a quick steer rather than the last word, so open a source to ' +
          'judge it for yourself.\n\n' +
          'Passages the answer did not rely on are still listed under **Also retrieved**, and you ' +
          'can open any source in place. Together this lets you audit an answer rather than take ' +
          'it on trust.',
      },
    ],
  },
  {
    id: 'watches',
    category: 'Finding answers',
    title: 'Watch a search',
    summary: 'Save a search or a question and be told when the corpus has something new for it.',
    sections: [
      {
        heading: 'What a watch is',
        body: 'A watch is a saved search the portal keeps re-running for you. Use **Watch this ' +
          'search** on Search, or **Watch this question** beneath an Ask answer, and the query ' +
          'is saved as a watch. The button changes to **Watching** so you can see the search is ' +
          'already covered; watching the same query twice keeps one watch, not two.',
      },
      {
        heading: 'The daily re-check and the dot',
        body: 'Once a day the portal re-runs every watch against the knowledge box and compares ' +
          'the top results with those from the last run. The first run only sets the baseline. ' +
          'When a later run finds that the results have changed - new documents have been ' +
          'ingested, or the ranking has moved - the watch is flagged.\n\n' +
          "The flag is a small accent-coloured **dot** on the watch's chip in the **Saved** " +
          'strip at the top of Search (screen readers hear "has new results"). Open the watch to ' +
          'see the current results; that clears the dot until the next change. There is no ' +
          'email or push notification - the portal tells you the next time you look.',
      },
      {
        heading: 'Where the list lives',
        body: 'Your watches appear as chips in the **Saved** strip above the results on ' +
          'Search. Choose a chip to run that search again, or its cross to remove the watch. A ' +
          'watch saved from an Ask answer appears in the same strip, since it is the question ' +
          'text that is watched.',
      },
      {
        heading: 'Per browser, not per account',
        body: 'Watches belong to the browser you created them in, not to a sign-in, so the same ' +
          'portal opened on another device or in a private window starts with an empty strip. ' +
          'Clearing site data for the portal forgets your watches. Each browser can hold up to ' +
          'fifty watches per portal; the oldest is dropped when a new one would exceed that.',
      },
    ],
  },
  {
    id: 'explore',
    category: 'Exploring the corpus',
    title: 'Explore',
    summary: 'The home surface - suggested questions, topic rows and a way in.',
    sections: [
      {
        heading: 'Your way in',
        body:
          'Explore is the portal home. A prominent question box lets you ask straight away, and ' +
          'suggested questions - drawn from the corpus itself - give you a starting point when you ' +
          'are not sure what to ask. Selecting a suggested question hands it to Ask.\n\n' +
          'A row of figures underneath gives you a quick sense of the corpus behind the portal - ' +
          'how many resources it holds, and its scale in paragraphs, sentences and index size.',
      },
      {
        heading: 'Topic rows',
        body:
          'Below the question box, topic rows show what the corpus covers, each with a selection ' +
          'of representative documents. The topics come from the box classification index, so ' +
          'they reflect how the content has actually been labelled, not a fixed menu. **See all** ' +
          'on a row takes you to everything filed under that topic in the Library.',
      },
    ],
  },
  {
    id: 'library',
    category: 'Exploring the corpus',
    title: 'Library',
    summary: 'Browse, filter and page through the whole corpus.',
    sections: [
      {
        heading: 'Browsing the corpus',
        body: 'The Library is the full catalogue of the connected content. Sort it by **Newest ' +
          'added**, **Oldest added** or **Title A-Z**, and page through large corpora without ' +
          'waiting on the whole set to load. The count at the top right tells you how many ' +
          'resources the portal is holding.',
      },
      {
        heading: 'Filtering and searching within',
        body:
          'Use the **Topics** list on the left to narrow the catalogue to one area of research. ' +
          '(To filter by document kind, such as Report or Submission, use **Search** instead.) ' +
          'Type a query into **Search within the library** to look inside it - this uses real ' +
          'retrieval, the same engine as Search, rather than a weak title match, so it finds ' +
          'documents a plain title filter would miss.',
      },
      {
        heading: 'What you see - and do not',
        body:
          'Documents are meant to read as real research, not raw filenames: once the corpus has ' +
          'been enriched, each one shows a proper title and summary in place of a code like ' +
          '`1981-071-DLD.pdf`. Until that enrichment has run, some cards fall back to the project ' +
          'code and file name.\n\n' +
          'Failed ingests and junk entries (bot-challenge pages, system files) are hidden from ' +
          'the Library automatically, so what you browse is genuine content. Administrators still ' +
          'see everything, including the entries that need fixing, in the management views.',
      },
    ],
  },
  {
    id: 'reading-a-document',
    category: 'Exploring the corpus',
    title: 'Reading a document and chatting with it',
    summary: 'The document view, its viewer, and asking questions of a single document.',
    sections: [
      {
        heading: 'The document view',
        body:
          'Opening a document shows its title, a summary and key takeaways where they have been ' +
          'generated, and the source itself in the viewer - a PDF reader, a web page, a video or ' +
          'audio player with transcript, or the extracted text, depending on what the document ' +
          'is. Use **Save to investigation** to keep the document with an active line of ' +
          'research.',
      },
      {
        heading: 'Arriving from a citation',
        body:
          'A citation you clicked through opens the document itself, not a transcription of it. ' +
          'For a PDF the reader opens at the cited page with the passage highlighted and scrolled ' +
          'into view, and the passage is quoted above the viewer as well.\n\n' +
          'Every document also carries an **extracted text**: a machine reading of the file that ' +
          'the portal searches and that you can copy from. It is folded away under the viewer ' +
          'behind a **Show extracted text** switch, so the document stays the thing you read. ' +
          'Turn the switch on to open it, and off to put it away again; jumping to a match from ' +
          'the **Matches in this document** list opens it for you. If the PDF itself cannot be ' +
          'displayed, the extracted text is shown straight away, since it is then the only ' +
          'reading available.',
      },
      {
        heading: 'Chatting with one document',
        body: 'The **Chat with this document** panel lets you ask questions of a single ' +
          "document. The answer is grounded only on that document's content, so it is a focused " +
          'way to interrogate one report without the rest of the corpus getting in the way. ' +
          'Suggested questions such as "Summarise the key findings" give you a quick start, and ' +
          'the same citations and confidence signals apply.',
      },
      {
        heading: 'Related work',
        body: 'A **You might also want** rail surfaces related documents from the corpus so you ' +
          'can follow a thread of connected research rather than returning to search each time.',
      },
    ],
  },
  {
    id: 'knowledge-graph',
    category: 'Exploring the corpus',
    title: 'The knowledge map',
    summary: 'A visual map of the corpus - an entity graph of what it is about, and a concept ' +
      'map of how its themes overlap.',
    sections: [
      {
        heading: 'Two views of the corpus',
        body:
          'The **Graph** in the header opens the **Knowledge map**, a visual picture of how the ' +
          'corpus hangs together. It has two tabs:\n\n' +
          '- **Entity graph** (the default) - the things the research is actually about.\n' +
          '- **Concept map** - how the broad themes of the corpus overlap.\n\n' +
          'Both are drawn from the content itself rather than a hand-made diagram, so they ' +
          'reflect the real structure of the research.',
      },
      {
        heading: 'The entity graph',
        body:
          'The entity graph shows real entities pulled from the documents - species, regions, ' +
          'programs, habitats, technologies and more - joined by the relationships found between ' +
          'them. The legend lets you show or hide each type, a **Most connected** list ranks the ' +
          'entities that appear most, and **Find in the map** jumps to one by name. Click a node ' +
          'to see the evidence behind it or trace how two entities connect.\n\n' +
          'By default the map shows the curated entities and relations. Turn on **Include ' +
          "built-in entities** to add the platform's raw extraction of people, dates and places " +
          'as well - more complete, but noisier.',
      },
      {
        heading: 'The concept map',
        body:
          'The concept map steps back to the level of themes. Each node is a category - a topic ' +
          'or a document kind - and categories that share more resources sit closer together. ' +
          'Pick one to see what it pairs with, so you can spot where areas of research meet.',
      },
      {
        heading: 'Getting around',
        body:
          'Drag to pan, scroll to zoom, and click a node to explore it. The zoom controls and a ' +
          'full-screen button sit in the bottom corner if you want to give the map more room.',
      },
    ],
  },
  {
    id: 'generate',
    category: 'Working with the portal',
    title: 'Tools',
    summary: "Connect MCP clients to the portal's research through the knowledge box connector.",
    sections: [
      {
        heading: 'The knowledge box MCP connector',
        body: "Tools hosts the portal's MCP connector. It gives any MCP-capable client - an " +
          'agent framework, an IDE assistant, a desktop research tool - read-only access to ' +
          "this portal's knowledge. A connected client can:\n\n" +
          '- **Search the corpus** - the same retrieval the portal itself uses.\n' +
          '- **Ask for cited answers** - grounded answers that carry their sources.\n' +
          "- **Fetch a document** - pull a specific resource's content.\n" +
          '- **Browse the catalogue** - list what the portal holds.\n\n' +
          'Access stays inside the portal boundary: a key reaches only this portal, never the ' +
          'knowledge box behind it.',
      },
      {
        heading: 'Connect a client',
        body: '1. On **Tools**, enter a label naming the client or workflow that will use the ' +
          'key (for example, analyst desktop) and choose **Create key**. Creating and revoking ' +
          'keys needs a signed-in administrator.\n' +
          '2. The new key appears once, inside a ready-to-paste client configuration. **Copy ' +
          'the configuration straight away** - the key is not shown again after you leave or ' +
          'refresh the page.\n' +
          '3. Paste the configuration into any client that accepts JSON MCP server ' +
          "configuration. The portal's tools then appear in that client.",
      },
      {
        heading: 'Connecting manually',
        body: 'For a client configured field by field rather than by pasting JSON, use ' +
          "Streamable HTTP against the portal's MCP endpoint and send the key as a bearer " +
          'token on every request:\n\n' +
          '```\n' +
          'Endpoint URL   https://<portal domain>/api/t/<portal>/mcp\n' +
          'Header         Authorization: Bearer <your key>\n' +
          '```\n\n' +
          'The same connection in JSON form:\n\n' +
          '```\n' +
          '{\n' +
          '  "mcpServers": {\n' +
          '    "<portal>-knowledge": {\n' +
          '      "type": "streamable-http",\n' +
          '      "url": "https://<portal domain>/api/t/<portal>/mcp",\n' +
          '      "headers": { "Authorization": "Bearer <your key>" }\n' +
          '    }\n' +
          '  }\n' +
          '}\n' +
          '```',
      },
      {
        heading: 'Keys and security',
        body: '- The connector is **read-only** - no client can change the corpus through it.\n' +
          '- Each key is limited to this portal and can be **revoked** at any time from Tools; ' +
          'clients using it stop working immediately, and nothing else changes.\n' +
          '- The knowledge box credential stays private: the connector issues its own separate, ' +
          'revocable CorpusKit keys and never reveals the service credential CorpusKit uses to ' +
          'reach the knowledge box.',
      },
    ],
  },
  {
    id: 'generate-artefacts',
    category: 'Working with the portal',
    title: 'Generate',
    summary:
      'Turn a topic into a briefing, comparison, timeline, FAQ or pros and cons, with sources.',
    sections: [
      {
        heading: 'What Generate makes',
        body:
          'Generate writes a structured artefact from the corpus rather than a conversational ' +
          'answer. Choose the shape, describe the topic, and the portal retrieves the relevant ' +
          'sources and writes from them:\n\n' +
          '- **Briefing** - an overview, structured sections and key takeaways. Every section ' +
          'carries numbered references, and a section nothing in the corpus supports is left out ' +
          'and listed as omitted rather than written from general knowledge.\n' +
          '- **Comparison** - items scored across dimensions, each cell naming the source it ' +
          'came from when one could be traced.\n' +
          '- **Timeline**, **FAQ** and **Pros and cons** - the same grounding, in those shapes.\n' +
          '- **Assessment** - the same knowledge check the Assessment page builds.\n\n' +
          'If the corpus holds too little on a topic, Generate says so instead of producing a ' +
          'plausible artefact with invented citations.',
      },
      {
        heading: 'References and sources',
        body: 'A briefing cites with numbered markers, for example [1], that map to the ' +
          '**References** list under it; each reference is a document in the Library, with its ' +
          'journal and year taken from the record rather than written by the model. The ' +
          '**Grounded in** row lists every source the artefact was retrieved from.',
      },
      {
        heading: 'Saving and exporting',
        body: '**Save to an investigation** files the artefact with its sources. **Export to ' +
          'Word** downloads a Word-compatible document, references included, and confirms the ' +
          'file name once it has saved. **Export to PDF** opens a print-ready copy in a new tab ' +
          "and starts your browser's print dialog, from which you can save as PDF; if your " +
          'browser blocks the new tab, allow pop-ups for the portal and try again.',
      },
    ],
  },
  {
    id: 'assessment',
    category: 'Working with the portal',
    title: 'Assessment',
    summary: 'Build a knowledge check on any area of the corpus and test yourself.',
    sections: [
      {
        heading: 'Build a knowledge check',
        body: "The Assessment lets you generate a short knowledge check grounded in the portal's " +
          'content - a quick way to test your grasp of the material or to bring someone new up to ' +
          'speed. It builds in three steps:\n\n' +
          '1. **Choose a knowledge area** - pick one of the corpus topics (each card shows how ' +
          'many sources sit behind it), or type your own topic - a syndrome, a drug, a method - ' +
          'into the topic box and choose **Build on this topic**.\n' +
          '2. **Set the shape** - choose how many questions (3, 5 or 10) and how deep to go ' +
          '(Foundational, Intermediate or Advanced).\n' +
          '3. **Generate the assessment** - the portal writes the questions from the sources in ' +
          'that area.',
      },
      {
        heading: 'Taking it',
        body: 'Answer the questions and submit to see how you did. Each question then shows its ' +
          'explanation and the **source** it was written from, linked to that document in the ' +
          'Library, so you can read up on anything you missed. Intermediate and advanced checks ' +
          'ask for the figures and comparisons in the sources rather than definitions. Use ' +
          '**Change area** to build another check on a different topic.',
      },
    ],
  },
  {
    id: 'investigations',
    category: 'Working with the portal',
    title: 'Investigations',
    summary: 'Accumulate evidence around a research question over time.',
    sections: [
      {
        heading: 'A first-class research question',
        body:
          'An Investigation is a persistent research question that accumulates evidence as you ' +
          'work, rather than a search you run once and lose. Give it a **name** and, if you like, ' +
          'the **research question** it is trying to answer, then **Start investigation**. Mark ' +
          'one as your **current** investigation with **Make current**, and **Close** or ' +
          '**Delete** it when you are done. **Ask this question** hands the research question ' +
          'straight to Ask.',
      },
      {
        heading: 'Gathering evidence',
        body: 'As you find passages that bear on the question - from Search, Ask or a ' +
          'document - **Save** them into the investigation. Each piece keeps its provenance: the ' +
          'source it came from and the query it was retrieved for. The evidence is persistent, so ' +
          'the case you are building does not vanish when you move on.',
      },
      {
        heading: 'Sorting what you find',
        body:
          'Weigh each piece of evidence by marking it **Supports**, **Partial**, **Contradicts** ' +
          'or **Not relevant** - the tabs across the top then let you see just the supporting or ' +
          'just the contradicting evidence at a glance. You can **add a note** to any item, ' +
          '**Ask about this** to dig into it, or **Remove** it. **Tags** let you group evidence ' +
          'under the claims or themes you are testing, and the **Notebook** holds your working ' +
          'notes, hunches and things still to check.',
      },
      {
        heading: 'Synthesis and output',
        body:
          'When you have gathered enough, **Synthesise the evidence** draws the threads together ' +
          '- grounded strictly on the evidence you have kept, not the whole corpus. Your verdicts, ' +
          'tags and notes travel with each passage: evidence marked **Not relevant** is left out, ' +
          'evidence marked **Contradicts** is reported as opposing evidence rather than support, ' +
          'and a note that corrects a passage overrides what the passage appears to say. If some ' +
          'evidence is still unjudged or contradicted, the portal says so before it synthesises ' +
          'and lets you judge first. The finished synthesis lists what it excluded. From there ' +
          'you can **Export to Word** to take the whole case with you.',
      },
    ],
  },
  {
    id: 'admin-knowledge-box',
    category: 'Administration',
    title: 'Connecting a knowledge box and adding content',
    summary: 'Connect a knowledge box, then add, ingest and sync content into it.',
    sections: [
      {
        heading: 'Connecting a knowledge box',
        body: 'Administration lives under **Manage** and is passcode-protected. A portal needs a ' +
          'knowledge box connected before search and answers work. Connect an existing box by ' +
          'binding it, or create and provision a new one from within the app - the portal ' +
          'configures the box (its taxonomy, graph, agents and suggested questions) for the ' +
          'domain you describe.\n\n' +
          'Bindings are held server-side; the credentials never reach the browser. Every call to ' +
          'the content platform is made from the server.',
      },
      {
        heading: 'Adding content',
        body: 'Add content into the connected box several ways:\n\n' +
          '- **Upload** documents (PDFs and other files) directly.\n' +
          '- **Add a link** to a web page for the box to crawl and ingest.\n' +
          '- **Add text** as a resource.\n\n' +
          'Ingestion is asynchronous. When the box is busy processing recent changes it applies ' +
          'back-pressure; the portal waits and retries within bounds, and tells you honestly when ' +
          'the box is too busy to accept more right now rather than failing silently.',
      },
      {
        heading: 'Ingesting and syncing web sources',
        body: 'Point the portal at a source site and it discovers the linkable pages so you can ' +
          'ingest them as a set. Sources can be re-synced on a schedule so the corpus keeps up ' +
          'with a site that changes, without anyone re-adding pages by hand.',
      },
      {
        heading: 'Corpus health',
        body: 'The corpus-health view scans the connected content for problems - failed ingests, ' +
          'documents whose text extracted thin or empty, bot-challenge pages that slipped in, and ' +
          'raw untitled entries. From here you can re-ingest what needs fixing and permanently ' +
          'purge the genuinely broken entries (a narrowly-scoped, confirmed delete), keeping the ' +
          'corpus that users see genuinely clean.',
      },
    ],
  },
  {
    id: 'admin-taxonomy-enrichments',
    category: 'Administration',
    title: 'Taxonomy and enrichments',
    summary: 'Shape the topic taxonomy, the knowledge graph and per-document enrichments.',
    sections: [
      {
        heading: 'Taxonomy',
        body:
          'The taxonomy is the set of topics and document kinds the corpus is classified against. ' +
          'It drives the topic rows on Explore, the filters in Search and the Library, and the ' +
          'knowledge graph. Review it, adjust the labels, and have the classification agents ' +
          'apply them across the corpus so the structure users navigate reflects the real ' +
          'content.\n\n' +
          'Each label can carry a definition - a sentence or two saying what the label means and ' +
          'when it applies. Definitions show on the Taxonomy page as the vocabulary reference and ' +
          'are what the labelling agents classify against. Edit a label set under Manage > ' +
          'Taxonomy: saving it restarts every labeller that carries the set so it picks up the new ' +
          'labels and definitions, and the restarted labeller applies to new resources only - ' +
          'nothing already in the corpus is reprocessed or relabelled.\n\n' +
          'Create a set under Manage > Taxonomy (or from the Taxonomy page): give it a name - ' +
          'its id is derived from the name, so "Marine Region" becomes marine-region - choose ' +
          'whether a resource may carry one value or several, and add its labels with their ' +
          'definitions. Nothing carries a brand-new set, so creating one neither creates nor ' +
          'restarts any agent; a labeller for it comes from running analysis or the knowledge ' +
          'graph tools. Editing a set later restarts only the labellers that carry it.',
      },
      {
        heading: 'Enrichments',
        body:
          'Enrichments are the structured fields generated onto each document - a real title, a ' +
          'summary, key takeaways and quotes of interest - designed to replace raw filenames and ' +
          'give every document a scannable, credible presentation on cards, in the Library and on ' +
          'the document page. Until the enrichment has been run over a corpus, documents fall ' +
          'back to their project code and file name.\n\n' +
          'The default research enrichment ships as the first enrichment. Each enrichment is a ' +
          'generation agent plus a schema; the portal renders whatever fields the schema defines, ' +
          'so adding a new lens on the corpus is a configuration change, displayed automatically.',
      },
      {
        heading: 'The knowledge graph strategy',
        body:
          'The knowledge graph is built by an extraction agent configured with the entity types ' +
          'and relation examples that matter for the domain. Review and refine that strategy in ' +
          'management, and the graph the portal draws follows from it.',
      },
    ],
  },
  {
    id: 'help-and-this-documentation',
    category: 'Administration',
    title: 'About this documentation',
    summary: 'How the Help section works and how it stays separate from research.',
    sections: [
      {
        heading: 'A dedicated, scoped help search',
        body: 'This Help section has its own search and its own AI assistant that answer "how do ' +
          'I..." questions about using the portal. It retrieves only from this documentation.\n\n' +
          'Crucially, the documentation is kept entirely separate from research content: normal ' +
          'Search and Ask never retrieve or cite these help pages, and the ' +
          'Help search never reaches into the research corpus. The two are isolated by dedicated, ' +
          'centrally-managed search configurations on the knowledge box, with a server-side ' +
          'cross-check as a safety net, so a question about the portal and a question about the ' +
          'research never bleed into each other.',
      },
      {
        heading: 'Keeping it current',
        body: 'The documentation is authored as part of the application and ingested into the ' +
          'knowledge box by an administrator. When the pages change, an administrator re-runs the ' +
          'ingestion; it is idempotent, so re-running it updates the existing pages in place ' +
          'rather than duplicating them.',
      },
    ],
  },
]

/** A documentation page by its stable id. */
export function docPageById(id: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.id === id)
}

/** Documentation pages grouped by category, in category and authored order. */
export function docPagesByCategory(): { category: DocCategory; pages: DocPage[] }[] {
  return DOC_CATEGORIES.map((category) => ({
    category,
    pages: DOC_PAGES.filter((page) => page.category === category),
  })).filter((group) => group.pages.length > 0)
}

/**
 * A documentation page rendered as the Markdown body that is ingested into the
 * knowledge box. The title leads as an H1 and each section becomes an H2 so the
 * platform extracts clean, retrievable paragraphs.
 */
export function docPageToMarkdown(page: DocPage): string {
  const parts = [`# ${page.title}`, page.summary]
  for (const section of page.sections) {
    parts.push(`## ${section.heading}`, section.body)
  }
  return parts.join('\n\n')
}

/**
 * Plain-text rendering of a page - the ingested body with Markdown markers
 * stripped - for previews and for tests that assert on content without markup.
 */
export function docPageToPlainText(page: DocPage): string {
  return docPageToMarkdown(page)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
