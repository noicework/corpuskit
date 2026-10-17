# CorpusKit brand identity

## What CorpusKit is

CorpusKit is an open source research portal. It gives people several ways to work with a research collection: browse it, search it, ask questions, check the evidence and explore relationships.

The answers are designed to be checked. Citations open the source material, search results show the passages that matched, and confidence is stated in plain language. When the collection does not support an answer, the portal can say so.

The full project is published under the Apache 2.0 licence. An organisation can inspect the code, run it on its own infrastructure, change it and contribute improvements.

### Explore

Explore is a portal's home page. It shows a question box, questions drawn from the collection, topic rows, regional entry points and recently added resources, so a person can start with a question or browse.

### Search

Every page has a search field in the header. Results show ranked resources and the passages that matched, with topic and document-kind filters, relevance scores, weak-match labels and hybrid, semantic and keyword modes.

A search produces a short cited answer by default. The reader can hide that answer and use the results alone, switch between all retrieved resources and the ones cited, summarise a set of results, or watch the search for changes.

### Ask

Ask is a continuing conversation with the research collection. Answers stream as they are produced and include numbered citations, sources, follow-up questions and quality signals for relevance, groundedness and context.

Confidence is shown as high, moderate, low or unscored. Low-confidence answers tell the reader to use them as a lead and check the sources. Deep research breaks a broad question into smaller questions before answering. Sessions can be saved, renamed, deleted and exported.

### Library

The Library is the full catalogue. People can search it, sort it, filter it and switch between grid and list views.

Resources are presented as research items rather than filenames. A resource can have a clear title, summary, key takeaways, notable quotes and key facts. Its page can show the original file or webpage, extracted text, a transcript where one exists, related resources and a cited conversation limited to that document.

### Knowledge map

The knowledge map shows the shape of the collection. The entity view shows things in the research and the relationships between them. The concept view shows topics and document kinds that occur together.

People can search the map, filter it, inspect a connection and open the resources behind it. The map reflects the entities, relationships and categories configured for that portal.

### Tools

Tools gives approved external research tools read-only access through MCP. A portal-scoped key can search the collection, request a cited answer, retrieve a document and browse the catalogue. Administrators create and revoke these keys without exposing the credential used by the underlying content service.

### Manage

Manage is where an administrator looks after one portal. It covers content, website sources, collection health, resource summaries, taxonomy, knowledge-map strategy, behaviour, appearance, usage and knowledge gaps.

Administrators can add files, text and webpages, schedule website synchronisation, hold resources as drafts, find failed or poor-quality ingests and analyse the collection to update its topics, document kinds, suggested questions and map structure.

## Who it serves

### People using a portal

Researchers come for different reasons: to get a cited answer to a question, to find a specific report, to browse what a collection holds, or to see what work already exists on a topic and how it connects.

### People looking after a collection

Content stewards and portal administrators add and update material, check whether it was processed properly, manage drafts, maintain the taxonomy and knowledge map, review common questions and keep the portal’s identity current.

### People running CorpusKit

An organisation’s technical team can inspect the repository, run CorpusKit, connect its own research collection, configure authentication and domains, and maintain the deployment. The application code is open under Apache 2.0 and the project includes its build, test and deployment configuration. Content storage and retrieval run on a connected knowledge service, which the deployment needs an account with.

### People contributing

Developers, designers, researchers and documentation writers can study the same code that runs the portals, report problems and contribute changes. Contributors should be able to tell what exists now, what remains unfinished and how a change will be checked.

## Positioning

CorpusKit is an open source research portal for finding, questioning and working with a research collection while keeping every answer connected to evidence.

Connect a collection and CorpusKit provides a branded portal with search, cited answers, a browsable Library and a knowledge map. Each organisation can shape the portal around its own domain and run the project itself. The code is available under Apache 2.0.

## Values

### Openness

The code is published under Apache 2.0, and the evidence behind an answer is available for inspection.

### Rigour

CorpusKit keeps claims tied to citations, matched passages and visible quality signals.

### Candour

It shows weak matches, low confidence and missing evidence instead of smoothing them over.

### Autonomy

Organisations can run the project themselves and shape each portal around their own collection.

### Stewardship

CorpusKit treats a research portal as maintained organisational infrastructure, not a one-off search tool.

## Personality

- **Open, not guarded**  
  CorpusKit shows sources, confidence, current limits and code. It does not hide important workings behind brand language

- **Clear, not salesy**  
  It says what a feature does, what it needs and what happened. It speaks to people as users, operators or contributors

- **Assured, not showy**  
  It lets the product behaviour demonstrate the capability

- **Exact, not absolute**  
  It names the source, passage, score and current state without pretending that research always gives one final answer

- **Helpful, not controlling**  
  It gives people several ways to work, and gives organisations room to run, adapt and contribute to the project

## Voice and tone

CorpusKit speaks like a well-maintained open source project and a careful research tool. It explains what works, shows how to check it and gives the reader a useful next step.

### Voice rules

- Start with what the product can do
- Use working features as examples
- State that CorpusKit is open source plainly, with the Apache 2.0 licence when the detail matters
- Say inspect, run, change, self-host and contribute when those are the actions available
- Do not use open source as a claim of moral superiority
- Do not suggest that open source means every connected service or every piece of research is free of separate terms
- Use plain verbs such as find, ask, compare, open, save, check, run and contribute
- Keep the source, passage or confidence close to the claim it qualifies
- Name gaps, failures and unfinished work directly
- Use product language in the portal and precise technical language in developer documentation
- Refer to CorpusKit or the portal as the system doing the work, not a model or retrieval engine
- Invite contribution where it is useful, with enough detail for someone to act

### Tone by situation

- **The project home** says what CorpusKit does, links to the repository and gives a short route to running it
- **The portal** helps people explore without assuming that every question has an answer
- **Answers** are specific and conditional, with citations and confidence close by
- **Warnings** are calm and clear about what needs checking
- **Administration** names the action, scope, progress and consequence
- **Developer documentation** states prerequisites, commands, boundaries and known problems directly
- **Contribution guidance** is welcoming, specific and honest about the standard changes need to meet
- **Errors** say which action failed, what remains available and what the person can try next

### Do and do not examples

| Context | Do | Do not |
|---|---|---|
| Project headline | An open source research portal | Research intelligence for enterprise leaders |
| Project introduction | Search the collection, ask cited questions and open the passages behind each answer. | CorpusKit provides advanced knowledge infrastructure for modern organisations. |
| Running the project | The code is available under Apache 2.0. Clone it, connect a collection and run the portal yourself. | Contact us to learn how CorpusKit can transform your organisation. |
| Answer copy | The retrieved sources only partly support this answer - check the citations before relying on it. | The answer is ready for use. |
| Interface label | Cited answer | AI answer |
| Empty state | No direct evidence found | No results |

## Vocabulary

### The project

- **CorpusKit** is the open source project and the product that runs the portals
- **Open source** means the application code is published under a licence that allows people to inspect, run, change and redistribute it
- **Apache 2.0** is the project’s software licence. Name it when someone needs the exact terms
- **Self-host** means running the CorpusKit application on infrastructure chosen and managed by the organisation; the connected knowledge service is separate
- **Repository** is the source code, documentation, tests and project configuration
- **Maintainer** is someone responsible for reviewing and caring for the project
- **Contributor** is anyone who improves the code, design, documentation, testing or other project material
- **Fork** is a copy of the repository that someone can develop or run independently. Use the term in developer contexts, not as a general product benefit

Do not use **free** as a substitute for open source. The licence covers the CorpusKit code; infrastructure, connected services and the research material can have their own costs and terms.

### Portals and organisations

- **Organisation** is the group responsible for a portal and its research
- **Portal** is one organisation-specific research experience, with its own identity, collection, configuration and domain
- **Tenant** is an internal architecture term. Use organisation or portal in public and user-facing writing
- **Manage** is the administration area for one portal

### Content

- **Research collection** is the complete body of content connected to a portal
- **Collection** is the shorter form once research collection has been established
- **Corpus** is used only where it adds precision in research, administration or technical documentation
- **Library** is the browsable catalogue of resources
- **Resource** is one item in the Library, such as a report, webpage, video or other document
- **Research source** is a resource used to support an answer or finding. Use the full term where source could be confused with source code
- **Passage** is the specific part of a research source matched to a search or citation
- **Topic** is a subject category used to organise and filter the collection
- **Document kind** distinguishes forms such as report, plan, submission or framework

Collection is not the name of a saved object or current product feature. Do not use **Collections** as a navigation label until that feature exists.

### Answers and quality

- **Cited answer** is an answer with numbered references to supporting research sources
- **Citation** is the numbered link between a claim and its research source
- **Confidence** is the plain-language statement of how well the retrieved sources support an answer
- **Answer quality** covers the three checks used today: relevance, groundedness and context
- **Matched passage** is the excerpt that made a resource relevant to a search
- **Weak match** is a search result below the stated relevance threshold
- **No direct evidence found** is the response when the collection cannot support an answer
- **Deep research** is the Ask mode that maps a question into focused sub-questions before answering

### Research work

- **Session** is a saved Ask conversation
- **Watched search** is a saved search that is checked for changed results

### Structure and access

- **Knowledge map** is the user-facing view of entities, relationships, topics and overlaps
- **Knowledge graph** is used in technical and management contexts
- **MCP connector** is the technical access point for approved external research tools
- **Access key** is a portal-scoped, revocable credential for the MCP connector
- **Knowledge box** is a technical connection shown to administrators. It is not how CorpusKit explains its value to portal users
- **Enrichment** is an administrator term for generated resource information. User-facing writing should name the title, summary, key takeaways or notable quotes instead
- **Merchandising** is an internal implementation term, not a description for portal users

### Words and phrases to avoid

Do not use:

- AI demo
- AI answer
- chatbot
- copilot
- RAG
- Agentic RAG
- vector search
- vector database
- model-powered
- intelligent platform
- enterprise solution
- knowledge revolution
- reimagined
- unlock
- supercharge
- seamless
- magic
- definitive answer
- authoritative answer
- single source of truth
- hallucination
- content dump
- actionable insights
- vendor lock-in
- free forever
- community edition

Technical documentation can name the underlying technologies when needed. They do not lead the project description or portal copy.

## Proof points

These claims are supported by the code in the repository:

- CorpusKit is published under the Apache 2.0 licence
- The repository contains the application, shared types, retrieval integration, tests, build tasks and deployment configuration
- The project can be run outside the hosted service, with documented local setup and container configuration
- One deployment serves multiple organisation-specific portals from configuration rather than separate application branches
- A portal can have its own name, organisation, tagline, logo, images, typography, text size, density, shape and appearance settings
- Each portal can have its own topics, suggested questions, entity types and relationship types
- Administrators can analyse a connected collection to derive topics, document kinds, suggested questions and knowledge-map dimensions
- Search supports hybrid, semantic and keyword modes, topic and document-kind filters, calibrated relevance scores, matched passages and weak-match labels
- Search provides a streamed cited answer by default and can switch to results only
- People can switch between all retrieved resources and those cited in the answer
- People can summarise a set of results and watch a search for daily changes
- Ask streams answers and provides numbered citations, cited sources and follow-up questions
- Answer quality reports relevance, groundedness and context, with high, moderate, low or unscored confidence
- Low-confidence answers tell the reader to treat the result as a lead and check the cited sources
- Ask can refuse when the collection provides no direct evidence
- Deep research maps a question into focused sub-questions before answering
- Ask sessions can be saved, renamed, deleted and exported
- Library resources can be searched, sorted and filtered, with grid and list views
- Resource pages support PDFs, webpages, videos, audio, images, office documents and extracted text when the connected material provides them
- A resource can have a generated title, summary, key takeaways and notable quotes
- The current enrichment schema does not contain a separate hook field, so a generated hook is not a current product claim
- People can ask a cited question against one document instead of the whole collection
- The knowledge map provides an entity graph and a concept map, with relationships, topic overlaps, search, filters and linked resources
- Administrators can add files, text and webpages, register website sources and run or schedule source synchronisation
- Collection-health checks identify failed resources, bot-challenge pages and resources with very little extracted text
- Resources can be held as drafts and excluded from public retrieval until published
- Manage includes resource summaries, taxonomy, knowledge-map strategy, portal behaviour, appearance, usage insights and knowledge-gap reporting
- The MCP connector is read-only and limited to one portal
- MCP access keys are issued separately, shown once, revocable and managed by an administrator
- MCP clients can search the collection, request a cited answer, retrieve one document and browse the catalogue
- Production administration supports Microsoft sign-in and an administrator role
- Production application state is stored in SQLite-backed durable storage
- Retrieval and generation sit behind a typed product interface, while the portal uses CorpusKit’s own vocabulary

## The brand idea

### Put your organisation's research to work

CorpusKit lets a person move through a research collection in several useful ways: find a report, ask a question, follow a connection, compare sources and keep exploring. Citations, matched passages and plain-language confidence make that work trustworthy because the reader can check what they find. The project follows the same approach by keeping its code open to inspection and change.
