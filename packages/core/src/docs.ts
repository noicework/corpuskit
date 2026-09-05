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
          'for answers you do not choose to dig into.) **Show the pipeline** reveals the retrieve, ' +
          'write and check stages behind it.\n\n' +
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
          'trail: questions, answers, sources and the quality scores.',
      },
      {
        heading: 'Deep research',
        body: 'Turn on **Deep research** to have the portal first map your question into focused ' +
          'sub-questions, research each of them, and then answer with full-document grounding. ' +
          'It is slower but more thorough for broad or multi-part questions. Questions about ' +
          'risk, safety, effects or comparisons are broken down automatically so decisive ' +
          'passages are not missed.',
      },
      {
        heading: 'Feedback and watches',
        body:
          'Mark an answer **Helpful** or **Not helpful** to signal how well it landed. **Watch ' +
          'this question** to keep an eye on it - the portal flags it when new results turn up ' +
          'for it later.',
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
          "application from the platform's own source attribution, so the number you click always " +
          'resolves to the passage that grounds that claim.',
      },
      {
        heading: 'The confidence signal',
        body:
          'Every answer is scored for quality across three dimensions - how well it answers your ' +
          'question (relevance), how firmly it is grounded in the sources (groundedness), and how ' +
          'relevant the retrieved context was. Each is shown as a short, plain score you can read ' +
          'at a glance, not just a coloured meter.\n\n' +
          'When the sources only partly support an answer, a banner says so in plain language - ' +
          'for example "Moderate confidence. The retrieved sources only partly support this ' +
          'answer, check the citations before relying on it." A weakly supported answer is never ' +
          'presented as authoritative; the banner is your cue to read the sources before you use ' +
          'it.\n\n' +
          'When confidence is low, Ask also offers to **re-answer the question deeply**, ' +
          'against the full text of the matching documents, so a thinly grounded first answer has ' +
          'a direct path to a firmer one rather than leaving you at a dead end.',
      },
      {
        heading: 'Honest refusals',
        body:
          'If the corpus does not hold enough relevant material to answer confidently, the portal ' +
          'says so and shows you the closest passages it found and what to try next, rather than ' +
          'bluffing an answer. An honest "no direct evidence found" is a feature, not a failure.',
      },
      {
        heading: 'The evidence behind an answer',
        body:
          'Beneath an answer the evidence list shows every source it drew on. Each one carries ' +
          'its matched passage and a relevance score as a percentage, so you can weigh the ' +
          'sources at a glance.\n\n' +
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
          'is. A citation you clicked through takes you to the matching passage. Use **Save to ' +
          'investigation** to keep the document with an active line of research.',
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
          'many sources sit behind it).\n' +
          '2. **Set the shape** - choose how many questions (3, 5 or 10) and how deep to go ' +
          '(Foundational, Intermediate or Advanced).\n' +
          '3. **Generate the assessment** - the portal writes the questions from the sources in ' +
          'that area.',
      },
      {
        heading: 'Taking it',
        body: 'Answer the questions and see how you did, with the relevant sources to read up on ' +
          'anything you missed. Use **Change area** to build another check on a different topic.',
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
          '- grounded strictly on the evidence you have kept, not the whole corpus. From there ' +
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
