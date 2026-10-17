# Design system work packages (October 2026)

Implements `DESIGN-SYSTEM.md`; the findings (F1 to F22) are in `REVIEW.md`.

## Order and branches

```
noicework/main
  └─ design/review-2026-10        review docs + the shot harness (this branch)
       ├─ design/p0a-tokens       ┐ wave 1, in parallel
       ├─ design/p0b-icons        ┘ merged together into design/foundation
       └─ design/foundation
            ├─ design/p1-chrome     ┐
            ├─ design/p2-graph      │ wave 2, five in parallel
            ├─ design/p3-ask        │
            ├─ design/p4-library    │
            ├─ design/p5-manage     ┘
            ├─ design/p6-settings   ┐ wave 3, as slots free
            └─ design/p7-pages      ┘
  design-system/2026-10            integration: foundation + every accepted package
  P8 (footer, document actions)    after the in-flight footer and delete work lands on main
```

## Rules for every package

- **File ownership is exclusive.** Edit only the files your package lists. If a fix needs a file
  you do not own, write it down in your final report instead of editing it.
- After wave 1, `apps/web/src/styles.css` is frozen. Package CSS goes in your own partial under
  `apps/web/src/styles/` (created empty by P0a and imported at the top of `styles.css`), and holds
  only new `rp-<area>-*` classes. Prefer Tailwind utilities over tokens in the TSX.
- Never edit `deno.json`, `packages/`, `apps/api/`, `e2e/` (except where P4 says so), another
  package's partial, or `AnswerMarkdown.tsx`, `AnswerInline.tsx`, `lib/answer-*.ts`,
  `PortalFooter.tsx`, `ResourceDetailPage.tsx`, `DeleteDocument.tsx` (in flight elsewhere).
- New literal UI strings need a Japanese entry. Append it to the catalogue your package lists;
  the integration step resolves the append conflicts.
- `deno task check` must be green before you finish. Run `deno task build:web` before shots.
- Capture after-shots into `.shots/<package>/` with the harness (section 8 of
  `DESIGN-SYSTEM.md`), look at every image, and compare against `.shots/baseline-harness/`.
- Commit locally with clear messages. Do not push, open pull requests or deploy.
- No em dashes, plain Australian English, in code comments and copy alike.

---

## P0a: Tokens and the stylesheet (foundation)

**Goal.** Every token, class and rule in `DESIGN-SYSTEM.md` sections 3 and 4.1 to 4.10 that lives
in CSS or `theme.ts`, so later packages only consume it. Fixes F3 (tokens), F4 and F6 (roles), F8,
F9 (token), F14 (native checks), F19 (stylesheet slips), F20, and the coarse-pointer floor of F7.

**Files owned.**
- `apps/web/src/styles.css`
- `apps/web/src/styles/` (new): `chrome.css`, `graph.css`, `answer.css`, `library.css`,
  `manage.css`, `admin.css`, `pages.css`, each created with a one-line header comment and
  imported at the top of `styles.css` after `@import 'tailwindcss';`
- `apps/web/src/lib/theme.ts`, `apps/web/src/lib/theme.test.ts`
- `packages/core/src/palettes.ts`, `packages/core/src/palettes.test.ts` (only for pure contrast
  helpers the new roles need)

**Work.**
1. `theme.ts` writes `--rp-on-primary-2`, `--rp-on-hero-2`, `--rp-control`, `--rp-on-control`,
   `--rp-logo-plate`, `--rp-scrim` and the dark categorical set, for library palettes, derived
   palettes, the non-hex fallback, the viewer's dark scheme and dark palettes, by the rules in
   section 3.1. The CorpusKit palette (whose brand surface is its paper) must get an accent
   control in light mode.
2. `styles.css`: re-declare `--rp-cat-N-ink` on `.rp-tenant`; `--text-2xs`; `.rp-input` and
   `.rp-select` edges on `--rp-field`; native check theming and `.rp-check`; the button size
   scale, `.rp-icon-btn`, `.rp-btn-danger-outline`, `.rp-btn-primary` on the control role and the
   2.75rem floor under `(max-width: 1023.98px), (pointer: coarse)`; `.rp-seg`, `.rp-seg-item`,
   `.rp-seg-on-brand`; `.rp-tag`; the chip floor; `.rp-link-standalone`; `.rp-section-head`;
   `.rp-dialog` and its `::backdrop`; `.rp-scrim`; `.rp-logo-plate`; dark thumbnail dimming;
   nav link weight 400.
3. Fix the stylesheet's own slips: the stage timeline done and active marks, the suggestion card
   hover and focus, the rail handle hover and focus, so none draw the raw accent as text, a thin
   border or a focus outline.
4. Keep every existing class name working.

**Acceptance.**
- Unit tests: for every library palette and for at least six portal-colour sets (dark, bright,
  mid-tone, near-black, pale and the CorpusKit paper brand), in light and the viewer's dark
  scheme, `--rp-on-primary-2` reaches 4.5:1 on the primary, `--rp-on-hero-2` 4.5:1 on both hero
  endpoints, `--rp-control` 3:1 on the surface and paper, `--rp-on-control` 4.5:1 on the
  control, every dark categorical hue 3:1 on the dark surface and its ink 4.5:1.
- Shots: profiles `deep,bright,serif,observatory,corpuskit`, routes
  `home,library,search,graph,answer,manage-content,manage-access,delete-dialog`, both schemes,
  both widths; plus `--font 22` for `library,manage-content` at 390.
- Visible in the shots: selected Grid/List and search-mode states distinct in dark on `deep`;
  CorpusKit primary buttons readable as buttons; field edges visible; checkboxes themed; graph
  captions legible in dark; the confirm dialog's scrim darkens in both schemes.
- No new axe violations; no overflow; report every page whose layout the 44 px floor now
  strains, for the owning package.

## P0b: Icons and shared primitives (foundation)

**Goal.** The icon module (section 3.3) and the React primitives that wrap the new classes. F10
(foundation), F9 and F22-adjacent dialog work.

**Files owned.**
- `apps/web/src/components/icons.tsx` (new), `apps/web/src/components/icons.test.tsx` (new)
- `apps/web/src/components/ui.tsx` and its tests
- `apps/web/src/components/ConfirmActionDialog.tsx`
- `e2e/icon-sheet.ts` (new): renders every icon at every size, in light and dark, to an HTML
  page and screenshots it to `.shots/p0b/icons-<scheme>.png`
- `NOTICE` (only if Lucide paths are used)

**Work.**
1. `icons.tsx`: at least these, in the one idiom: `Search, X, Menu, ChevronDown, ChevronUp,
   ChevronLeft, ChevronRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, ExternalLink, Plus,
   Minus, Check, CheckCircle, Info, AlertTriangle, AlertCircle, HelpCircle, User, Users, Sun,
   Moon, Trash, Bookmark, BookmarkFilled, Pin, Copy, RotateCw, RotateCcw, ThumbsUp, ThumbsDown,
   ShieldCheck, Eye, EyeOff, Pencil, Upload, Download, Printer, ZoomIn, ZoomOut, Maximize,
   FitWidth, SlidersHorizontal, LayoutGrid, LayoutList, FileText, File, Globe, Image, Table,
   MessageSquare, History, Sparkles, Share (graph), Network, Grid2x2, Scatter, Workflow, Library,
   Compass, Link, Key, Lock, LogOut, Calendar, Clock, Tag, Database, Settings, Send, Filter,
   Wand`. Each takes `size` (`sm`, `md`, `lg`), `className` and optional `title`.
2. `ui.tsx`: `Button` (variant, size, leading or trailing icon), `IconButton` (required `label`,
   sets `aria-label` and `title`), `SectionHeader` (section 4.6), and keep every existing export.
   Replace the inline SVGs already in `ui.tsx`.
3. `ConfirmActionDialog.tsx`: `.rp-dialog`, the scrim class, a `Trash` icon on a destructive
   confirm, initial focus on the safe action. Props must stay backward compatible (another
   session's `DeleteDocument.tsx` uses it): additive changes only.

**Acceptance.**
- Tests: every icon has `viewBox='0 0 24 24'`, `stroke-width='1.75'`, `aria-hidden` unless
  titled; `IconButton` always has an accessible name; `SectionHeader` renders its heading level.
- `.shots/p0b/icons-light.png` and `icons-dark.png` show a consistent set at three sizes.
- Shots: `delete-dialog` on all four profiles, both schemes and widths (taken after P0a is
  merged in, or noted as pending).

## P1: Header, navigation, logos and overlays

**Goal.** F1, F8 (header), F9 (overlays), F10 and F15 in these files, F18, and section 4.9 and
4.10.

**Files owned.** `apps/web/src/pages/TenantLayout.tsx`, `components/KbSwitcher.tsx`,
`components/HelpMenu.tsx`, `components/help-menu-items.ts`, `components/AccountMenu.tsx`,
`components/account-menu-behaviour.ts`, `components/CommandPalette.tsx`,
`components/SignInDialog.tsx`, `components/ChatFab.tsx`, `components/PortalAccessGate.tsx`,
`components/RootRedirect.tsx`, `lib/portal-locale.tsx`, the tests beside them,
`apps/web/src/styles/chrome.css`, appends to `lib/messages/platform-ja.ts`.

**Work.** Logo plate in the header and phone sheet when there is no distinct dark logo; header
search as an `.rp-field` composite; header controls as `IconButton`s; nav band and phone sheet
per section 4.9; the CorpusKit wordmark slash on a token instead of two literal blues; command
palette (icons for the question bullets, no Esc hint on touch, a placeholder that fits at 390 px,
`--rp-scrim`); sign-in dialog and phone sheet on `--rp-scrim`; menus per section 4.8; every icon
from `icons.tsx`; no px text; 44 px targets below `lg`.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes
`home,library,navsheet,palette`, both schemes and widths, and `--font 22` at 390 for
`home,navsheet`. The `deep` logo is legible in dark (on the plate); `bright` shows its own dark
logo without a plate; no control in the header or sheet under 44 px at 390 px.

## P2: Knowledge graph and entity page

**Goal.** F2, F3 (verification and the engine), F11 (entity), section 4.13.

**Files owned.** `apps/web/src/pages/GraphPage.tsx`, `components/KnowledgeMap.tsx`,
`components/KnowledgeMap3D.tsx`, `components/map3d-engine.ts`, `lib/force3d.ts`,
`lib/graph-display-copy.ts`, `pages/EntityPage.tsx`, the tests beside them,
`apps/web/src/styles/graph.css`, appends to `lib/messages/research-ja.ts`.

**Work.** Size the phone map to the visible area and fit the overview into it; caption collision;
"Back to top" only after scrolling; the engine reads the categorical tokens for the active scheme
and re-reads them when the scheme changes; masthead text on `--rp-on-primary-2`, its toggles as
`.rp-seg-on-brand`, all 44 px below `lg`; icons; rem text outside the canvas; the entity page's
two-column layout and readable relation labels.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes `graph,entity`, both
schemes and widths, and `--font 22` at 390 for `graph`. At 390 px the overview's bounding box
sits inside the visible map area with no blank band over 15% of its height; captions do not
overlap; dark captions legible on every profile; the entity page uses the width at 1440 px.

## P3: Ask and answers

**Goal.** F16, section 4.14, F10 and F15 in these files.

**Files owned.** `apps/web/src/pages/AskPage.tsx`, `pages/AgenticPage.tsx`,
`components/AnswerStream.tsx`, `components/QualityGauge.tsx`, `components/StageTimeline.tsx`,
`components/SaveEvidence.tsx`, `components/EvidenceTable.tsx`, `components/RouteChip.tsx`,
`components/AnswerJourney.tsx`, `components/CurrencyNote.tsx`, `components/Byline.tsx`,
`components/PipelinePanel.tsx`, the tests beside them, `apps/web/src/styles/answer.css`, appends to
`lib/messages/research-ja.ts`. Not the footnote files listed in the rules.

**Work.** The full question heading (clamp at four lines with a toggle, no repetition); one
answer toolbar on one line at 390 px; the phone composer's label; `Plus` on New session; sources
rail per section 4.14; the empty Ask state's hierarchy; icons; rem text; 44 px targets.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes `ask,answer`, both
schemes and widths, and `--font 22` at 390 for `answer`. No control under 44 px at 390 px; the
question is readable in full; no new axe violations.

## P4: Library, search and the document viewer

**Goal.** F6 (segments), F11 (search measure), F12, F14 (filters), section 4.15.

**Files owned.** `apps/web/src/pages/LibraryPage.tsx`, `pages/SearchPage.tsx`,
`components/SearchAnswer.tsx`, `components/SearchField.tsx`, `components/Typeahead.tsx`,
`components/ResourceThumb.tsx`, `components/PdfReader.tsx`, `components/ViewControls.tsx`,
`components/useViewMode.ts`, the tests beside them (including `pages/library-*.test.ts` and
`pages/search-field-min-width.test.ts`), `apps/web/src/styles/library.css`, appends to
`lib/messages/research-ja.ts`, and in `e2e/support/design-fixture.ts` only: give one resource a
small generated multi-page PDF so the viewer renders in the harness.

**Work.** Grid/List and search modes as `.rp-seg`; filters as `.rp-check`; the density slider's
label and target; card anatomy and the meta line; the search answer at `rp-measure` with the
answer toolbar; the phone PDF toolbar (one row plus an overflow menu); icons; rem text; 44 px
targets.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes
`library,search,document`, both schemes and widths, and `--font 22` at 390 for
`library,document`. The PDF toolbar is one row at 390 px; the search answer's lines stay under
about 80 characters at 1440 px; selected states pass in dark.

## P5: Manage, content and knowledge tabs

**Goal.** F13, F14 (`select-name`, progress bar), section 4.16 for Overview, Insights, Content,
Enrichments, Taxonomy and Knowledge graph, and the Manage shell.

**Files owned.** `apps/web/src/pages/ManagePage.tsx`, `pages/TaxonomyPage.tsx`, and in
`pages/admin/`: `Section.tsx`, `StatTiles.tsx`, `RecentList.tsx`, `AddContent.tsx`,
`UploadFiles.tsx`, `upload-queue.ts`, `upload-store.ts`, `streamed-job.ts`, `SourcesPanel.tsx`,
`CorpusHealthPanel.tsx`, `InsightsPanel.tsx`, `InterrogatePanel.tsx`, `AnalysePanel.tsx`,
`EnrichmentsPanel.tsx`, `LabelsetsPanel.tsx`, `KgPanel.tsx`, `KgStrategyEditor.tsx`,
`MessagePanel.tsx`; `components/AddDocumentsLink.tsx`, `components/CompareConfigurations.tsx`; the
tests beside them; `apps/web/src/styles/manage.css`; appends to `lib/messages/manage-ja.ts`.

**Work.** `SectionHeader` everywhere in these tabs, one card ground, utilities in the actions
slot; row actions with icons and danger styling, stacking on a phone; the tab strip's scroll cue
and 44 px tabs; named selects in the strategy editor; a named progress bar; `.rp-check`
checkboxes; disclosure toggles as buttons; icons; rem text.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes
`manage-overview,manage-content,manage-taxonomy,manage-graph,manage-enrichments,delete-dialog`,
both schemes and widths, and `--font 22` at 390 for `manage-content`. axe `select-name` and
`aria-progressbar-name` gone; no control under 44 px at 390 px on these tabs.

## P6: Manage settings, access and audit; platform administration

**Goal.** Section 4.16 for Appearance, Behaviour, Extraction, Details, Connections, Access and
Audit, the platform estate, audit and people pages, and the logo preview of F1.

**Files owned.** In `apps/web/src/pages/admin/`: `AppearancePanel.tsx`, `BehaviourPanel.tsx`,
`ExtractionPanel.tsx`, `PortalConnections.tsx`, `RenamePortal.tsx`, `AccessPanel.tsx`,
`KeysPanel.tsx`, `AuditPanel.tsx`, `MigratePanel.tsx`, `AddPortal.tsx`, `CreateKbBox.tsx`,
`PortalRow.tsx`, `shared.ts`; `components/AssignmentEditor.tsx`,
`components/AssignmentSection.tsx`, `components/EmergencyAccess.tsx`; `pages/AdminPage.tsx`,
`pages/AuditPage.tsx`, `pages/PeoplePage.tsx`; the tests beside them;
`apps/web/src/styles/admin.css`; appends to `lib/messages/manage-ja.ts`.

**Work.** Same anatomy as P5 (it consumes `SectionHeader` from `ui.tsx`, not P5's files);
Appearance previews the logo on the header ground in both schemes and says when the plate is
used; the keys dialog on `.rp-dialog`; `.rp-check` checkboxes (the 13 px ones); disclosure
toggles; audit filters and tables per section 4.7; icons; rem text; 44 px targets.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes
`manage-appearance,manage-behaviour,manage-extraction,manage-details,manage-connections,manage-access,manage-audit,admin`,
both schemes and widths, and `--font 22` at 390 for `manage-access`. No control under 24 px
anywhere and none under 44 px at 390 px on these screens.

## P7: Home, help and the other reading pages

**Goal.** F5, F17, section 4.11, and the system rules on Help, How it works, Tools, Not found,
Investigations, Generate and Assessment.

**Files owned.** `apps/web/src/pages/ExplorePage.tsx`, `pages/PortalHome.tsx`,
`components/LayoutLink.tsx`, `components/RegionMap.tsx`, `components/australia-paths.ts`,
`pages/DocsPage.tsx`, `pages/HowItWorksPage.tsx`, `pages/ToolsPage.tsx`, `pages/NotFoundPage.tsx`,
`pages/InvestigationsPage.tsx`, `pages/InvestigationDetailPage.tsx`, `pages/GeneratePage.tsx`,
`pages/AssessmentPage.tsx`, `components/AssessmentQuiz.tsx`, `pages/TenantPicker.tsx`, the tests
beside them, `apps/web/src/styles/pages.css`, appends to `lib/messages/research-ja.ts`.

**Work.** Hero roles for everything on the hero (the "Recently added" list included); starter
chips and the hero submit; tiles; eyebrows on `--rp-on-hero-2`; icons; rem text; 44 px targets;
the detail-page layout rule for the investigation page.

**Acceptance.** Shots: profiles `deep,bright,serif,observatory`, routes
`home,help,how,tools,investigations,notfound`, both schemes and widths, and `--font 22` at 390 for
`home`. The `bright` hero list readable; axe colour contrast clean on these routes for every
profile.

## P8 (deferred): footer credits and document actions

Starts after the other session's footer-credit and document-delete work is merged to `main`.

**Files owned.** `apps/web/src/components/PortalFooter.tsx` and its test,
`apps/web/src/pages/ResourceDetailPage.tsx`, `apps/web/src/components/DeleteDocument.tsx`.

**Work.** Section 4.12 (credits group, `--rp-on-primary-2`), section 4.15's document action
toolbar, icons, rem text, 44 px targets.

**Acceptance.** Shots: every profile, `home,document`, both schemes and widths, `--font 22` at
390. axe colour contrast clean in the footer on `bright`.

## Integration

1. Merge `design/foundation`, then each accepted package, into `design-system/2026-10`; resolve
   the catalogue append conflicts.
2. `deno task check`, `deno task test:e2e`, and the full shot matrix (`--profiles
   deep,bright,serif,observatory,corpuskit,ja`, both schemes, both widths, and a `--font 22`
   pass at 390).
3. `docs/design-system/GALLERY.html`: before and after across profiles, schemes and widths.
4. One pull request to `main`. It is not merged and nothing is deployed until it is approved.
