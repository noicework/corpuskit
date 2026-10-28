# Portal answer instructions and guardrails

Manage > Behaviour lets a portal administrator tune additional answer instructions and an answer
policy for that portal. The shared API code runs on the managed Worker and local Deno server.

## Instructions and the evidence boundary

Additional instructions are plain text, limited to 2,000 characters on save. The server resolves
them from the answering portal. Ask, search answers (which use Ask), document chat, portal/estate
MCP answers and composed agent answers receive them. A composed answer uses the host portal's
instructions; searching a peer does not transfer that peer's instructions to the host. Native
retrieval agents have their own upstream prompts; portal instructions apply to the composer.

`appendAnswerInstructions` always builds the built-in grounding/citation prompt first, then adds
portal text as a JSON-quoted preferences section explicitly subordinate to those rules. The legacy
`systemPrompt` option is also additive. Administrators cannot replace or remove the built-in
prompt. Language, footnote and source-context instructions are still applied. Retrieval gates,
citation binding and evidence checks still run independently of the preference text. No preference
can turn those checks off or turn an uncited source into a verified citation. Prompt ordering does
not promise perfect model obedience; deterministic server checks remain the enforcement boundary.

Reset answer instructions clears the draft. Save answer settings applies it to subsequent
questions. Guardrails have their own draft reset. Neither reset changes another portal.

## Guardrails and streaming

- **Out-of-scope topics:** up to 50 literal phrases of up to 120 characters each. Matching
  questions receive the configured refusal and contact line before answer generation or agent work.
- **Blocked terms in answers:** the same phrase rules. Matching answers are withheld whole and
  replaced by the configured message and contact line. Matches spanning streamed chunks are
  detected. Preliminary wording removed by Ask's evidence checks is also checked.
- **Maximum answer length:** optional, 100 to 20,000 Unicode characters, including spaces and
  citation markers. Longer answers are withheld whole, preserving claims and their citations.
  Policy messages are exempt. This is an output cap, not a generation token/cost budget.

Matching normalises Unicode width (NFKC), case, repeated whitespace and invisible format
characters. Phrases containing only Latin ASCII letters, digits and spaces match whole words;
other phrases, including Japanese, match literal substrings. There are no regular expressions,
stemming, translation or semantic topic classification. Include the phrases and languages needed.
These controls govern answers; they do not restrict access to source documents.

With blocked terms or a length cap enabled, answer text, citations and generated explanatory
events wait until the complete answer passes. Only progress stages are sent early. Ask releases
the final verified text rather than replaying preliminary deltas. The agent path holds reasoning
and answer events too. Broken streams release no partial answer. The buffer is bounded at one
million UTF-16 code units of encoded events; overflow withholds the answer as a length action.
This trades time to first answer text for preventing rejected text from flashing on screen.
With those checks disabled, normal streaming is retained.

The same policy guards direct portal/estate MCP answers and separately streamed estate answers.
For composed answers, the host policy governs the resulting answer; sources are searched under
their existing access and federation rules. Help documentation answers are outside the portal
research-topic policy.

## Routes, storage and accountability

Existing routes are extended. There is no new permission or deployment setting.

| Route | Permission | Behaviour |
|---|---|---|
| `GET /api/admin/t/:slug/prompts` | `behaviour.write` | Read private answer settings |
| `PUT /api/admin/t/:slug/prompts` | `behaviour.write` | Save settings; omitted guardrails and image/citation choices are retained; omitted/empty `ask` clears instructions |
| `GET /api/admin/t/:slug/insights` | `content.write` | Includes `guardrails.questionsRefused`, `answersWithheld` and `lengthWithheld` |

Example settings:

```json
{
  "ask": "Explain specialist terms and finish with a short practical summary.",
  "guardrails": {
    "outOfScope": ["party politics"],
    "blockedTerms": ["restricted phrase"],
    "refusalMessage": "Please ask about this research collection.",
    "withheldMessage": "The portal team has withheld this answer.",
    "contactLine": "Contact: help@example.test",
    "maxAnswerLength": 4000
  }
}
```

Settings are in the portal's private `prompts` configuration, excluded from public tenant config
and operator presentation export. File-backed `TENANTS_PATH` storage and Durable Object overrides
use the same schema. Legacy prompts up to 4,000 characters remain readable and become additive;
they must be shortened to 2,000 characters before a new save.

Changes emit `tenant.behaviour.update` with bounded JSON-string snapshots in `previousPrompts`
and `prompts`, plus actor, scope, time and request correlation. This explicit configuration history
makes authored instructions, phrases and contact lines visible to audit readers. It includes no
question, generated answer, provider token or binding. A failed completion audit rolls back the
configuration change.

Actions reuse the portal's Insights log: the existing shortened question and a fixed action name,
never the withheld answer. Counts use the same 90-day window as Insights, subject to its existing
runtime retention bounds. Correlation joins a late refusal to the Ask row so it counts once and
is reported as unanswered. Settings erase with `configuration`; action rows erase with `insights`;
configuration history follows existing audit retention and portal erasure. There is no new erased
record kind, store, secret or background job.

## Upgrade and rollback

No environment variable, dependency, database migration or new provider capability is required.
Previously stored custom prompts become additional instructions; they no longer replace the
built-in prompt. Older releases do not enforce the new guardrails, even if their configuration
remains in storage, and an older settings editor can discard them on save. Keep the enforcing
release available when planning a rollback. A native agent's upstream prompt remains outside the
portal preferences editor.

## Local review

`e2e/prompts-guardrails.test.ts` runs the real app against the DoubleProvider. It edits settings
through Manage, verifies a refused question makes no generation call, checks a withheld answer and
another portal's unaffected answer, then checks Insights and reset. Screenshots are written to
`.review/prompts-guardrails/` for desktop/mobile light/dark, 200% text and 320px reflow. Unit tests
cover prompt order, matching, split chunks, length limits, private storage, isolation, permissions,
lifecycle restrictions and configuration-audit rollback.
