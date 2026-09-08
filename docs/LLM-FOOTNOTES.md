# LLM footnotes

Ported from the VCCMHW KSP portal's Progress ARAG integration.

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
- Keep CorpusKit's existing resource-level numbering and evidence-card contract.
  Different passages in one resource share its number. This port does not introduce
  the KSP portal's separate passage-numbering UI or PDF locator components.
- Preserve the existing post-generation evidence audit. It can still remove or
  rebind claims that fail its checks; LLM footnotes are attribution, not proof that
  every claim is correct.
- Reject malformed, missing, conflicting, generated-field and out-of-scope
  references. Unknown anonymous extra-context aliases such as `USER_CONTEXT_0`
  cannot be assigned to a paper safely and also fail. Capability retries retain
  the selected mode; they never downgrade footnotes to standard attribution.

The port does not change stored retrieval filters or expansion strategies, and
does not copy tenant-specific KSP source restrictions. It also does not change
CorpusKit's existing fallback passage selection for resource-level citations.

## Verification and release

Parser tests cover every stream split, Unicode, repeated/adjacent references,
punctuation, code, Markdown links and invalid mappings. Provider tests cover the
shared surfaces, prompt overrides, retries, isolation, rollback and structured
JSON exclusion. Existing standard-attribution regressions remain explicitly on
standard mode.

Run `deno task check` and `deno task build:cloudflare`. Before production release,
also run live corpus/document/Help questions against a configured knowledge box,
including a follow-up using extra context, and inspect citation click-throughs.
The implementation worktree had no ARAG credentials or tenant bindings, so live
answer quality and visual checks were not performed locally. No production
deployment is part of this port.
