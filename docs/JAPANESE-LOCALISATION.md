# Japanese application interface

This inventory tracks application copy, independently of research answer acceptance. The locale is
`ja`; English remains `en` with Australian date/number conventions. Source titles, quotations,
document bodies, generated answers, user-authored portal copy, identities and technical IDs retain
their original values. Existing tenant dictionaries may translate only the established visible-copy
allowlist; they cannot change URLs, identity, access or inference policy.

## Shared contract

`usePortalLocale()` from `apps/web/src/lib/portal-locale.tsx` exposes:

- `language`, `setLanguage(language)` and `ui(english, values?)`.
- `number(value, options?)`, `date(value, options?)` and `error(error, englishFallback)`.
- `ui` uses exact application-owned English keys and `{name}` parameters. Parameter values are
  inserted once, unchanged. Do not pass arbitrary source prose through interface translation.
- `error` uses known static application messages/codes or a translated fallback in Japanese. It
  never machine-translates an arbitrary server payload.
- `AppLanguageSwitch` reuses the existing JA/EN control on platform/access screens.

An explicit choice persists under `corpuskit-ui-language-v1` across app surfaces. Existing
per-portal choices and configured defaults remain supported. The complete portal shell, including
account/help dialogs, receives its resolved locale. No inference or source-language policy changes.

Feature catalogs live in `apps/web/src/lib/messages/`: `common-ja.ts`, `manage-ja.ts`,
`research-ja.ts`, and `platform-ja.ts`. Conflicting translations for the same English key, empty
translations and mismatched placeholders fail the catalog tests. Contexts needing different wording
must use distinct English keys. The source audit reports missing literal `ui(...)` keys; it does not
replace the inventory and browser audit of unwrapped copy or dynamic labels.

## Scope inventory

| Area | Screens and shared controls | Owner | Status |
| --- | --- | --- | --- |
| Foundation | App root/error boundary, locale persistence, tenant shell provider, catalog contracts and locale formatters | Foundation | Implemented; broader screen wiring and visual audit remain |
| Manage shell | Overview, Insights, Content, Enrichments, Taxonomy, Knowledge graph, Appearance, Behaviour, Extraction, Details, Connections, Access, Audit | Manage | Pending |
| Manage panels | Every file under `pages/admin`: Access, AddContent, AddPortal, Analyse, Appearance, Audit, Behaviour, CorpusHealth, CreateKbBox, Enrichments, Extraction, Insights, Interrogate, Keys, Kg, KgStrategyEditor, Labelsets, Message, Migrate, PortalConnections, PortalRow, RecentList, RenamePortal, Section, Sources, StatTiles, UploadFiles and shared/upload job states | Manage | Pending; Enrichments import strings follow PR94 merge |
| Public research | Home, Search, Library, ResourceDetail, Ask, Explore, Generate, Assessment, Graph, Entity, Taxonomy, Investigations/Detail, Agentic and Tools | Research | Pending |
| Research controls | Answer rendering/journey/stream, chat, command palette, comparisons, sources/evidence, confidence/currency, PDF, maps, pipeline stages, search/typeahead/views, exports and assessment | Research | Pending |
| Platform | Connections/Admin, People, Audit, tenant picker and not-found states | Platform | Pending |
| Account/access | Account menu, assignments, confirmation/delete dialogs, emergency access, sign-in/profile, access/paused/denied states and portal switcher | Platform | Pending |
| Help/chrome | Help menu, footer, ACMD chrome, Docs navigation/controls and app-owned help bodies, HowItWorks prose and diagrams | Platform | Pending; research source documents and repository-only developer documentation remain authored |
| Shared primitives | Empty/error/loading states, resource type labels, document-add links, built-in schema display names/descriptions | Manage | Pending |

## Completion evidence required

- Inventory app-owned text, labels, buttons, dialogs, placeholders, validation, status, error, empty,
  loading and accessibility names across every area above.
- Keep default built-in schema display translation separate from the stored schema ID, agent prompt,
  field key and authored custom schema name/description.
- Exercise dates, counts and templates in both languages. Audit catalog collisions and missing keys.
- Audit visible hardcoded English in Japanese, explicitly excluding source content, technical IDs,
  recognised product/protocol names, language options and the browser-owned file-picker dialog. App file-selection controls are localised.
- Verify Japanese and English in light/dark, desktop and a measured 390px viewport, including 22px
  root text. Include dialogs, errors, empty/loading states, keyboard flow and surrounding chrome.
- Pass the full required gate and web build on the exact reviewed head. Implementation, merge,
  deployment and live verification remain separate events.

The foundation alone is not a claim of complete Japanese localisation.
