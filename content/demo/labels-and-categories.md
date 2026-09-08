# How labels and categories improve search and discovery

Labels and categories improve search and discovery by turning an unstructured collection into an organised set of resources. In CorpusKit, a topic label places a guide in an Explore row and makes it available through topic filters in the Library and Search. A document-type label distinguishes a user guide from a technical reference. These are different dimensions: one resource can be both a guide about finding answers and a user guide.

## Labels describe different aspects of a resource

A label is a value within a label set. In this demo, the Topic label set describes the subject: Getting started, Finding answers, Exploring the collection, Working with the portal, or Administration and ARAG. The Document type label set describes the form of the content: User guide, Technical reference or Walkthrough. The Audience label set identifies Readers, Administrators or Developers.

Keeping these dimensions separate makes categories useful. A reader can browse a broad topic, then narrow the results to a particular document type. Administrators can review how much content exists in each category and identify gaps. Multiple labels can apply to the same resource when the label set allows it.

## Automatic labelling uses definitions

Progress Agentic RAG provides labeler agents that classify resources or individual text blocks using descriptions of the labels. A useful label definition says what qualifies and what does not. For example, the Classification capability covers labels, taxonomy, categories and automatic labelling. The Quality evaluation capability covers relevance, groundedness and context quality.

An administrator defines the vocabulary; the agent applies that vocabulary to content. This is different from manually tagging each document. Automatic classification is useful as a collection grows, but its results should still be reviewed. A label is a classification decision, not proof that every statement in a resource is correct.

## Categories support discovery beyond a keyword search

Topic rows offer a way into a collection without knowing the exact words to search for. Facet counts indicate which categories have matching content. In the concept map, categories that share resources are connected, making overlaps visible. An entity knowledge graph is different: it connects named entities through relationships extracted from the source material.

Labels can also be used in stored search configurations. These configurations keep retrieval rules in the knowledge box so the same rules can be reused. A configuration can include or exclude labelled content. CorpusKit uses this separation to keep its in-app Help copies apart from the collection being explored. This demo's public product guides are collection content; the separate Help copies serve the Help assistant.

## Try the workflow

1. Browse the Finding answers topic from the demo home page.
2. Open a guide and read the source material.
3. Open the taxonomy view to compare Topic, Document type and Audience counts.
4. Ask how automatic labelling differs from manual categories, then open the answer's numbered citation.
5. Compare the concept map with the entity graph to see the difference between category overlap and extracted relationships.

## Sources

- CorpusKit: Taxonomy and enrichments - https://corpuskit.org/docs/admin-taxonomy-enrichments
- CorpusKit: The knowledge map - https://corpuskit.org/docs/knowledge-graph
- Progress Agentic RAG: Data Augmentation Agents - https://docs.rag.progress.cloud/docs/ingestion/data-augmentation
- Progress Agentic RAG: Search filters - https://docs.rag.progress.cloud/docs/rag/advanced/search-filters
