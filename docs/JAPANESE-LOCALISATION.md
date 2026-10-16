# Japanese application interface

The application supports `ja` and `en`. The Japanese catalog covers public research, Manage,
platform/account/access screens and the application's published help. English retains Australian
number/date conventions. This is interface localisation, independent of research answer acceptance.
Source documents, evidence, generated answers, authors, original titles, tenant-authored copy and
technical identities retain their original values.

## Shared contract

`usePortalLocale()` from `apps/web/src/lib/portal-locale.tsx` exposes `language`,
`setLanguage(language)`, `ui(english, values?)`, `number(value, options?)`, `date(value, options?)`
and `error(error, englishFallback)`.

- `ui` takes an exact application-owned English key and optional `{name}` parameters. Values are
  inserted once, unchanged, including braces, markup-like text and values equal to catalog keys.
- `error` displays known static application messages/codes or a translated fallback in Japanese.
  It does not translate arbitrary server payloads. API helpers keep canonical errors and contracts.
- `AppLanguageSwitch` and `PortalLanguageSwitch` reuse the existing JA/EN controls. The app choice
  persists under `corpuskit-ui-language-v1`; existing per-portal choices and configured defaults
  remain supported. A portal without a saved choice or Japanese policy still defaults to English.
- The whole tenant subtree, account/help dialogs and standalone platform screens receive locale.
  Source-language and inference policy are unchanged.

Feature catalogs live in `apps/web/src/lib/messages/`: `common-ja.ts`, `manage-ja.ts`,
`research-ja.ts`, and `platform-ja.ts`. Catalog tests reject conflicting Japanese translations for
one English key, empty translations and mismatched placeholders. Contexts needing different wording
use distinct English keys. The literal-call audit fails on missing `ui('…')` entries; the screen
inventories below additionally cover dynamic labels and unwrapped copy.

## Scope and dispositions

| Area | Reviewed application surfaces | Disposition |
| --- | --- | --- |
| Foundation | App/error boundary, locale persistence, number/date/error formatters, tenant provider, shared primitives and language controls | Application display copy localised; source values passed only as parameters or rendered verbatim |
| Manage navigation | Overview, Insights, Content, Enrichments, Taxonomy, Knowledge graph, Appearance, Behaviour, Extraction, Details, Connections, Access and Audit | All 13 tabs audited in Japanese; empty/loading/error/success states and accessible names localised |
| Manage content/jobs | AddContent, UploadFiles, RecentList, SourcesPanel, CorpusHealthPanel, AnalysePanel, InsightsPanel, InterrogatePanel, StatTiles and shared streamed/upload state | Labels, validation, progress, counts, announcements and finite stage names localised; source item names and provider evidence remain original |
| Manage configuration | AddPortal, CreateKbBox, RenamePortal, PortalRow, PortalConnections, MigratePanel, AppearancePanel, BehaviourPanel, KgPanel, KgStrategyEditor, LabelsetsPanel and Section | Controls, prompts, help, validation and status localised; editable configuration values, topic/intent names and descriptions, schema IDs/keys and technical values remain original |
| Manage access/audit | AccessPanel, KeysPanel, AuditPanel and MessagePanel | App controls, filter labels and app-created fallbacks localised; people, group/key names, event actions/outcomes/actors, UTC records and detail JSON remain provenance |
| Enrichments | Schema list/editor, built-in descriptions, run controls, export and PR94 import review/confirmation/status | Display projection only for unchanged known default schemas; custom schemas remain authored. Normal-session import retains skip-only transport, stale/authority guards and explicit confirmation |
| Public research | PortalHome, Search, Library, ResourceDetail, Ask, Explore, Generate, Assessment, Graph, Entity, Taxonomy, Investigations/Detail and Tools | Page/navigation copy, counts, relative dates, errors, empty/loading states, menus, forms and accessibility names localised |
| Research controls | AnswerInline/Journey/Stream, AssessmentQuiz, Byline, ChatFab, CommandPalette, CompareConfigurations, CurrencyNote, EvidenceTable, KnowledgeMap/3D, PdfReader, PipelinePanel, QualityGauge, RegionMap, ResourceThumb, RouteChip, SaveEvidence, SearchAnswer, StageTimeline, Typeahead and ViewControls | App controls and display labels localised; original answer/source text, citations, audit facts, authors and custom topic labels preserved |
| Research formatters | answer-export, answer-marks, tenant-copy and generate-suggestions, plus confidence labels at UI boundaries | Optional localiser preserves existing English defaults; only application-owned fallbacks/templates change, with authored overrides retained |
| Platform | Admin, People, Audit, TenantPicker and NotFound | Navigation, controls, forms, errors/status and accessible names localised; role values and identity contracts preserved |
| Account/access | AccountMenu, AssignmentEditor/Section, ConfirmActionDialog, DeleteDocument, EmergencyAccess, PortalAccessGate, RootRedirect, SignInDialog and KbSwitcher | Account/access/sign-in and confirmation copy localised; original names, assignments and permission boundaries preserved |
| Help/chrome | AcmdChrome, HelpMenu, LayoutLink, PortalFooter, DocsPage and HowItWorks | All 17 published app help pages / 66 sections translated, including guide prose and SVG flow labels; live counts, links, intents and configuration table remain present |

Manage's original candidate inventory covered 30 files / 893 occurrences before the PR94 import
addition and semantic filtering. Research's inventory covered 43 files / 24,683 lines; platform's
inventory covered 24 owned files / approximately 5,370 lines. These are inventory sizes, not proof
that every string literal should be translated: routes, enum values, CSS, authored values and
protocol identifiers are deliberately excluded. The final visible-copy review and browser suites
exercise the rendered application rather than treating catalog substring presence as acceptance.

## Deliberate original-language values

- Research titles, document bodies, quotations, evidence/citation text, generated answers,
  bibliographic authors/journals, user questions and saved research contents.
- Tenant-authored product/tagline/placeholder copy, topic labels, intent labels/descriptions,
  custom schemas, custom labelsets, names and configuration overrides. Known built-in schema and
  taxonomy names are translated only through guarded display adapters; stored definitions do not
  change. Existing configured tenant translations remain subject to the visible-copy allowlist.
- Technical IDs, role/option/request values, route/API paths, source URLs, raw audit facts and JSON,
  method/model/provider names, extraction measurements, service item logs and original diagnostics
  used as evidence. Unknown UI failures use Japanese static fallbacks rather than exposing raw
  service error text.
- Product/font/protocol/file-format names (for example CorpusKit, WOFF2, Inter and PDF), language
  names and browser chrome. The application file-selection trigger is localised; the native
  browser/OS file-picker dialog belongs to the user's browser/OS.
- Research/source documents and repository-only developer documentation. The app-owned published
  help bodies are included in localisation.

## Retained messages and switching

Manage messages use a language-neutral message factory and resolve against the current locale at
render time. Enrichment import preflight errors, completion counts, upload status/announcements,
configuration save messages and recent/health deletion notices can update without repeating the
operation. The browser test switches an invalid archive error and one successful ordinary-owner
import JA → EN → JA, checks the authored filename, and asserts exactly one request to the fixed
`collision=skip` route. Pure retained-message/upload tests cover uploaded rows and completion counts.

The one-shot ResourceDetail deletion notice passed through router navigation is rendered in the
language of the deletion action; it is consumed as a single navigation announcement. It does not
persist or rerun a mutation when the language changes. Research exported files likewise use the
language selected when export is invoked; source content and citation identities remain unchanged.

## Regression and browser evidence

The committed suites provide reproducible local checks with synthetic fixtures and no inference:

| Suite | Coverage |
| --- | --- |
| `lib/locale-messages.test.ts`, `lib/locale-catalog-audit.test.ts` | Catalog collisions, missing keys, placeholder integrity, error fallback and source-value substitution |
| `components/ui-locale.test.tsx`, `pages/admin/manage-locale.test.tsx`, `lib/labelset-display.test.ts`, `lib/extraction-copy.test.ts` | Shared copy, guarded built-ins, known-key/braces preservation, finite method/stage explanations and current-language retained status |
| `lib/research-locale.test.tsx` and existing source/audit/export tests | Authored topic overrides, exact source/citation/audit values, optional English defaults, errors and templates |
| `lib/help-pages-ja.test.tsx`, `components/platform-locale.test.tsx` | 17-page / 66-section help coverage hashes and stable anchors, live guide content and platform/access copy |
| `e2e/portal-locale.test.ts` | Global/per-portal language persistence, ordinary English default and original known-key/braces titles |
| `e2e/japanese-manage.test.ts` | All 13 Japanese Manage tabs, classified visible English audit, import review/result switching, 40 theme/viewport scenes, real button/text bounds and density sizing |
| `e2e/japanese-research.test.ts` | 80 research route/theme/language/viewport scenes with source preservation and no provider generation |
| `e2e/japanese-platform.test.ts` | 72 platform/access/help scenes plus all 17 help pages, dialogs, keyboard flow and actual computed theme |

The browser matrices use English/Japanese, light/dark, 1440px desktop and measured 390px layout
viewports with a 22px root font. They assert document overflow, actual font/language and computed
theme; Manage also checks that translated button text fits and short/icon controls keep the existing
density-aware minimum height. Screenshots include the changed controls and surrounding shell.

Reproduce after `deno task build:web`:

```sh
deno task check
deno test --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys \
  e2e/portal-locale.test.ts e2e/japanese-manage.test.ts \
  e2e/japanese-research.test.ts e2e/japanese-platform.test.ts
```

Screenshots, measured metrics and the classified Manage English-candidate list are written under
`.planning/logs/japanese-{locale-foundation,manage,research-ui,platform}/`. Peer inventories and
independent review reports are retained with the local handoff evidence. Exact-head gate/build/CI
results are recorded in PR95. Local implementation and QA do not assert deployment or live acceptance.
