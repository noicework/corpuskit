# LLM footnotes

Footnote-style citations come from the Progress Agentic RAG integration and are bound to the retrieved passages on the server.

## Switching modes

The server-only code flag is `CITATION_MODE` in
`packages/retrieval/src/providers/arag/citation-mode.ts`. It defaults to
`llm_footnotes`; change it to `standard` and rebuild to roll back. There is no
browser selector, request parameter or environment override. The provider's
constructor accepts a mode for testing both protocols without changing the flag.

Every prose call through `AragProvider.ask` uses the same mode, including research,
search answers, document questions, Help, intent-based answers and the Extraction
Lab. Structured JSON calls deliberately send neither citation mode, because
Progress does not support citations with `answer_json_schema`.

## Binding and streaming

- Request `citations: 'llm_footnotes'` instead of standard `citations: true`.
- Parse the model's inline references and trailing block definitions, then resolve
  each block using the streamed `footnote_citations.footnote_to_context` mapping.
- Stream clean provisional prose without raw footnote syntax or block identifiers.
  The canonical `done.text` adds verified markers after adjacent punctuation.
- Prefer one citation group at the end of a short coherent paragraph or bullet of 2–4 sentences when
  the same supporting passages cover every sentence. A shared document alone is not
  enough. Quotes, statistics and specific findings keep immediate citations, and a
  change in evidence or a separate paragraph/bullet needs its own group. This is
  generation guidance, not UI deduplication or permission to weaken evidence checks.
- Footnote completions opt into provider-neutral `citationPresentation: 'authored_blocks'`.
  The sentence audit still binds and checks every sentence. After all rewrites, a
  shared authored tail group is restored only if its unchanged sentences retain
  identical support and each source has a bounded passage supporting the entire
  group. Quotes, figures, explicit inline anchors, changed/removed/rebound members,
  long blocks and ambiguous locations retain sentence-level display. Standard mode
  does not opt in. The final answer and exports consume the same corrected text.
- Keep CorpusKit's existing resource-level numbering and evidence-card contract.
  Different passages in one resource share its number. There is no separate
  passage-numbering UI or PDF locator component.
- Preserve the existing post-generation evidence audit. It can still remove or
  rebind claims that fail its checks; LLM footnotes are attribution, not proof that
  every claim is correct.
- Reject malformed, missing, conflicting, generated-field and out-of-scope
  references. Server-created `sourceContext` entries keep original text and its
  resource ID together; their exact ordered `USER_CONTEXT_n` aliases bind at
  resource level, without inventing paragraph IDs or pages. Browser-supplied
  previous excerpts must match a fresh, permitted original before becoming
  source context. Prior generated answers remain conversation history, not
  citable source material. Unknown anonymous aliases still fail. Capability retries retain
  the selected mode; they never downgrade footnotes to standard attribution.

Footnote mode does not change stored retrieval filters or expansion strategies,
and carries no tenant-specific source restrictions. It also does not change
CorpusKit's existing fallback passage selection for resource-level citations.

Footnote prose requests default explicitly to a 4,096-token generation budget:
the trailing definitions need room after the answer. Explicit caller limits are
respected; standard and structured-JSON requests keep their existing defaults.
A live probe against a production knowledge box at 1,200 tokens truncated the
definition table, whereas the
same question without that artificial cap completed. This establishes a token
budget failure mode, not the cause of the earlier OPAX deployment failure.
Incomplete definitions still fail validation; there is no automatic retry or
silent downgrade to standard citations.

Read-only live probes against a production knowledge box on 9 September 2026 passed
for corpus-wide and document-scoped questions. A lean reformatting probe supplied
an original-source excerpt using `sourceContext`; Progress returned
`USER_CONTEXT_0` alongside five native paragraph mappings, all six definitions
completed, and the provider returned one resource citation with no error. The
previous binder would have rejected that alias. These checks verify provider
integration, not an OPAX deployment or its tenant-specific configuration.

## Demo-scoped restoration

The September 2026 restoration retains the demo-only functional release gates.
The code flag remains server-wide; it is not a per-tenant switch. No tenant
configuration is changed or tested as part of this restoration.

The subsequent OPAX release failure was diagnosed as `generated_context`: Progress
returned a citation to a data-augmentation field and the binder rejected it.
That tenant's source-only generation/configuration issue remains unresolved.
The safeguard stays enabled, so a corpus that supplies generated fields can still
fail citation validation. Demo validation must not be described as proving OPAX
or every connected corpus works.

## Verification and release

Parser tests cover every stream split, Unicode, repeated/adjacent references,
punctuation, code, Markdown links and invalid mappings. Provider tests cover the
shared surfaces, prompt overrides, retries, isolation, rollback and structured
JSON exclusion. Existing standard-attribution regressions remain explicitly on
standard mode.

Run `deno task check` and `deno task build:cloudflare`. Before production release,
also run live corpus/document/Help questions against a configured knowledge box,
including a follow-up using extra context, and inspect citation click-throughs.
The original port was checked with test doubles only; the subsequent read-only
provider probes are recorded above. Live portal smoke tests and browser checks
remain release gates, rather than being replaced by those provider probes.
