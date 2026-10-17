# CorpusKit design system review (October 2026)

Status: review complete 17 October 2026, against `noicework/main` at `cae8238`. Companion documents:
`DESIGN-SYSTEM.md` (the target spec) and `WORK-PACKAGES.md` (the implementation plan).

## How this review was done

Two evidence sets, both captured in light and dark at 1440 px and 390 px.

1. **Hosted portals.** Ten public demo portals on the hosted service were inventoried and six were
   captured in full: a near-black brand, a deep purple brand, a bright mid-tone green brand, a serif
   heading face, a mid-green brand with a yellow accent, and a Japanese portal (164 page views:
   home, library, document, graph, empty Ask, a replayed answer, help, how it works and not found).
   The visits were read-only. Every non-GET request and every GET that could reach a model or a
   semantic search was blocked in the browser, and the one answer shown was a recorded stream
   replayed locally, so nothing reached the retrieval platform or a model. These captures show
   other organisations' branding, so they stay out of the repository. Where a finding below cites
   them it names the portal only by its brand traits.
2. **The design harness** (`deno task shots`, added with this review). The real app and API,
   with a fictional "Southern Waters" corpus in place of the retrieval platform, captured under
   four contrasting profiles: `deep` (dark aubergine brand, lime accent, a dark-ink logo with no
   dark variant), `bright` (bright mid-tone green brand, amber accent), `serif` (the Kiln
   palette, a self-hosted serif heading face, soft shape, spacious density) and `observatory`
   (the dark library palette, square, compact). 29 routes, including every Manage tab and the
   owner-only states, for 444 captures. These are reproducible offline and are the before-set for
   every work package.

axe-core 4.11 ran on every capture (WCAG 2.0 to 2.2 A and AA rules). Interactive targets were
measured on every capture.

Evidence images referenced below are in `docs/design-system/shots/before/`. The full sets are
regenerated with `AXE_PATH=<axe.min.js> deno task shots --out .shots/<name>`.

## What is already strong

The bones are good, and most of this review is about finishing the system rather than replacing it.

- **The theming contract is real.** Twelve colour roles, a grey suite per palette, a WCAG contract
  test on every library palette, derived roles for a portal's own colours, and shape, density,
  typography and text-size dials that actually flow through the components.
- **No horizontal overflow** on any of the 608 captures at 390 px or 1440 px.
- **Focus** is consistent (a halo ring that survives forced-colours mode), and
  `prefers-reduced-motion` is honoured in every animation block.
- **Japanese** renders cleanly through the whole reading surface, including the graph and the
  phone menu.
- **axe is mostly quiet**: the only failures are the contrast tiers, two unlabelled control
  types and one unnamed progress bar described below.

## Findings, ranked by user impact

Severity: **High** blocks or misleads a reader on some portals, **Medium** is a visible defect or
an accessibility gap, **Low** is polish or maintainability. Each finding says where it lives and
which work package fixes it.

### F1. The logo disappears in dark mode when a portal has no dark logo (High)

Evidence: `shots/before/f01-dark-logo.jpg` (harness `deep`, light then dark). One hosted portal
also stores its light logo as its dark logo.

A dark-ink logo is drawn straight onto the dark header, so in dark mode the portal loses its name
and its home link's only visible label. `TenantLayout.tsx` falls back from `logoDarkUrl` to
`logoUrl` with no treatment. Most organisations' primary logo is dark ink on white, so this is the
common case, not the edge case. Manage > Appearance says the light logo "is used" without showing
what that looks like.

Fix: when the dark scheme is active and there is no distinct dark logo, the logo sits on a logo
plate (`--rp-logo-plate`, the palette's light paper) shaped by the button radius dial. Appearance
previews both versions. Package P1 (header) and P6 (Appearance preview).

### F2. The graph on a phone opens on a tiny overview with a blank band above it (High)

Evidence: `shots/before/f02-graph-phone.jpg`; reproduced on every hosted portal with a graph.

At 390 px the category overview is fitted into a full `100dvh` map box that starts below the
masthead, so it renders small and low on the screen with roughly 300 px of empty canvas above
it. Territory captions overlap the marks and each other ("Program or project" sits over its own
hub). A "Back to top" button shows on the first screen, where there is nothing to go back to.

Fix: size the phone map to the visible area (viewport minus header and masthead), fit the
overview to it with caption-aware padding, resolve caption collisions, and show "Back to top"
only after the reader has scrolled. Package P2.

### F3. Graph category captions are illegible in dark mode (High)

Evidence: `shots/before/f03-graph-captions-dark.jpg`; the "Organisation" and "Method or technology"
captions on a hosted portal are near invisible.

Root cause: `--rp-cat-N-ink` mixes the category hue with `var(--rp-ink)`, but it is declared on
`:root`, so the mix resolves against the light-mode ink before any tenant or dark scheme applies.
In dark mode every caption is 55% hue over near-black. This is the exact alias trap that
`apps/web/CLAUDE.md` documents for fonts and the focus ring. Separately, category 6 (`#4a3aa7`)
measures about 2:1 as a mark on the dark surface, under the 3:1 that WCAG 1.4.11 asks of a
graphical object.

Fix: re-declare the six ink aliases on `.rp-tenant`, give the categorical hues a dark-scheme set
that clears 3:1 as marks and 4.5:1 as ink, and add a test. Package P0a (tokens); P2 verifies the
map.

### F4. Secondary text on brand surfaces fails AA on mid-tone and bright brands (High)

Evidence: `shots/before/f04-on-brand-tiers.jpg`; axe `color-contrast` on every page of the
`bright` profile (94 captures) and on every page of a hosted mid-green portal.

The footer tagline and closing row, the graph masthead subtitle and its small-caps "View" and
"Layout" labels, and the hero eyebrows dim `--rp-on-primary` with alpha (`/50` to `/80`). That
only holds when the brand surface reaches about 7:1 with its text. A mid-tone brand that reaches
5.5:1 at full strength drops to about 3.6:1 at 75%, and on a bright brand whose text is black the
dimmed text sits on the photo at well under 3:1.

Fix: a computed secondary tier, `--rp-on-primary-2` (and `--rp-on-hero-2`), stepped toward the
brand until it clears 4.5:1, and a rule that alpha is for borders and hover fills only, never
text. Token in P0a; the call sites move in P1, P2, P7 and the footer follow-up.

### F5. Text on the hero is drawn in the brand-surface ink (High on bright brands)

Evidence: `shots/before/f05-hero-recent.jpg`.

The "Recently added" list on Explore's hero uses `--rp-on-primary` (black, for a bright brand)
on the hero gradient and photograph, where `--rp-on-hero` is the role that was computed for that
ground. The result is black text on a dark green photograph.

Fix: every element on the hero uses the hero roles. Package P7.

### F6. Filled controls and selected states vanish in dark mode on dark brands (High)

Evidence: `shots/before/f06-dark-selected.jpg`; hosted near-black brand library, Grid/List.

Primary buttons, the selected segment of Grid/List and Hybrid/Semantic/Keyword, Manage's
"Add documents" and "Choose files" all fill with the brand primary. For a near-black or deep
brand that fill sits at about 1.1 to 1.3:1 against the dark surface, so the selected segment is
indistinguishable from the unselected one (WCAG 1.4.11 asks 3:1 for a state indicator), and
primary buttons read as dim blocks.

Fix: a control role, `--rp-control` and `--rp-on-control`, equal to the brand in light mode and
lifted in the dark scheme until it clears 3:1 against the surface, plus a segmented-control
component whose selected state does not depend on fill alone. P0a defines both; P3, P4, P5 and
P6 adopt the segmented control.

### F7. Touch targets are below 44 px across the phone experience (High, accessibility)

Evidence: target measurements in both manifests. At 390 px, `.rp-btn` and native selects render
36 to 38 px tall, chips 29 to 32 px, the PDF toolbar's buttons 38 px, the graph's zoom controls
38 px, and every Manage tab carries about 20 controls under 44 px. Standalone text links
("Back to the portal", "Platform connections", "Open taxonomy") are 20 px tall, Manage's
checkboxes 13 px, and "Remove", "Show raw schema" and the audit "Event details" toggles 16 to
21 px. Inputs were already floored at 44 px below `lg`; buttons were not.

Fix: a size scale for buttons (`sm`, `md`, `lg`, icon), a coarse-pointer floor of 2.75rem for
every control, padded hit areas for links and checkboxes, and no per-call-site heights. P0a and
P0b define it; every package applies it to its own screens.

### F8. Text fields are drawn with the divider hairline (Medium)

`.rp-input` borders use `--rp-line` (about 1.2:1 on white), although the system defines
`--rp-field` precisely for WCAG 1.4.11 and documents it. Affected: the header search, the library
search, Manage's URL and text fields, the document chat field. The composite `.rp-field` boxes
(the Ask composer, hero search) are correct.

Fix: `.rp-input` and `.rp-select` take `--rp-field`. P0a.

### F9. Dialog scrims: five recipes, and dark mode gets a light one (Medium)

Evidence: `shots/before/f09-dialog-scrim.jpg`.

The confirm dialog's backdrop mixes `var(--rp-ink)` at 45%, which is near white in dark mode, so
the page brightens behind a delete confirmation. The phone menu, the sign-in dialog, the command
palette and the Ask session drawer each use a different black tint (30% to 60%, with and without
blur).

Fix: one `--rp-scrim` token, dark in both schemes, used by every overlay. P0a and P0b.

### F10. Icons: two idioms, no shared module, and text glyphs standing in for icons (Medium)

Evidence: `shots/before/f10-actions.jpg` (Delete without an icon beside Save with a bookmark;
the answer actions).

There are 74 inline SVGs across 39 files: 41 are solid 20 px glyphs and 33 are 24 px strokes at
five different stroke widths (1.4 to 2). Icons are redeclared per file (`CloseIcon` exists three
times). Text characters stand in for icons in several controls ("+ New session", "?" bullets in
the command palette, "→" and "←" in links). Destructive actions have no glyph (Manage's row
"Delete", the confirm dialog) while their neighbours do.

Fix: one icon module in a single stroke idiom, with a rule for which actions carry which glyph.
P0b creates it; every package migrates its own files.

### F11. Reading measure: too wide on Search, too narrow on Entity (Medium)

Evidence: `shots/before/f11-measure.jpg` and `shots/before/f11-entity-width.jpg`.

Search's embedded AI answer runs the full content width at 1440 px, about 200 characters a line.
The entity page is the opposite failure: a centred column of roughly 500 px that strands most of
a desktop screen, against the repository's own "use the full screen" rule.

Fix: prose takes `rp-measure`; tables and figures may run wider. The entity page uses a two-column
layout from `lg`. P4 and P2.

### F12. The PDF toolbar wraps to three rows on a phone (Medium)

Evidence: hosted document pages at 390 px (all PDF portals).

Ten controls (page step, page field, zoom, fit, fullscreen, print, download, open) wrap into
three rows of 38 px buttons above the page.

Fix: one row on a phone (page step, page field, zoom in and out) with the rest in an overflow
menu. P4.

### F13. Manage sections have no consistent anatomy (Medium)

Evidence: `shots/before/f13-manage-sections.jpg`.

Sibling sections alternate between the surface and the grey ground. Section titles are 14 px with
descriptions at 12 px in some sections and 14 px in others. "Refresh metrics" and "Refresh recent
additions" are full outline buttons placed between a title and its content, or with no title at
all. Row actions are bare text ("Hide", "Delete", "Publish") with no hover state or destructive
colour, and at 390 px "Delete" wraps onto a line of its own. The phone tab strip scrolls with no
cue that more tabs exist.

Fix: one section header (title, description, actions slot), one card ground, icon-and-label row
actions with danger styling for Delete, and a scroll cue on the tab strip. P0b builds the
primitive; P5 and P6 apply it.

### F14. Form controls outside the system (Medium; two axe criticals)

Manage's daily-sync checkbox is the browser's default blue; Access and Behaviour checkboxes are
13 px. The Knowledge graph strategy editor has five selects with no accessible name (axe
`select-name`, critical, 16 captures). The enrichment run's progress bar has no name (axe
`aria-progressbar-name`, serious, 16 captures).

Fix: `accent-color` and a 1.125rem size for native checkboxes, radios and ranges inside a
portal, labelled selects and progress bars. P0a, P5, P6.

### F15. Fixed pixel type ignores the reader's text size (Medium)

41 call sites use `text-[10px]` or `text-[11px]`. They do not scale with the portal's text-size
dial or the reader's own setting, and several are uppercase labels on brand surfaces at 60% alpha.

Fix: a `text-2xs` step (0.6875rem) for the eyebrow and badge tier, nothing smaller, everything in
rem. Each package converts its own files.

### F16. Ask: the question is clipped and the phone composer has no label (Medium)

Evidence: `shots/before/f16-composer.jpg`.

The session heading clamps the reader's own question to two lines with an ellipsis, directly
above the full question in its bubble. On a phone the composer drops its placeholder (it used to
clip) and shows only a pencil glyph. "+ New session" uses a typed plus. The answer action row
splits across two rows with different alignment on a phone.

Fix: show the question in full (clamp at four lines with a toggle), a short phone placeholder, an
icon for New session, one action toolbar. P3.

### F17. Hero question chips and the hero Ask button are small on desktop (Low)

On every hosted home page at 1440 px the starter questions are 12 to 13 px text in translucent
boxes, and the hero's Ask button is about 32 px tall inside a 56 px field.

Fix: chips at `text-sm`, the submit button sized to the field. P7.

### F18. Command palette details (Low)

"?" characters as bullets, an "Esc" key hint shown on touch devices, a placeholder truncated at
390 px, and a pale scrim in light mode.

Fix: P1.

### F19. Token contract slips (Low)

Hard-coded colours where roles exist: the stage timeline's done mark is `#ffffff` on the accent
(should be `--rp-on-accent`); the active stage mark draws the accent as text; the CorpusKit
wordmark slash is two literal blues; the select chevron is a literal grey; the suggestion card
and document rail draw focus and hover in the raw accent. 43 call sites override button heights
with `h-6` to `h-9`, which the component's `min-height` silently beats.

Fix: P0a for the stylesheet; packages for their call sites.

### F20. Dark mode thumbnails glare (Low)

White PDF page thumbnails sit at full brightness on the dark library and document pages.

Fix: a slight dim and a hairline edge in the dark scheme. P0a.

### Deferred: work another session has in flight

- **F21. Footer layout.** The closing row puts copyright, the portal's note and "Powered by
  CorpusKit" on one baseline. A second credit ("Powered by Progress Agentic RAG") is being added
  in `PortalFooter.tsx`, and the row will crowd. `DESIGN-SYSTEM.md` specifies a credits group.
  It is applied after that pull request lands (package P8).
- **F22. Document header actions.** Delete had no icon beside Save's bookmark. The trash icon is
  being added in `ResourceDetailPage.tsx` and `DeleteDocument.tsx`; P8 aligns that toolbar to the
  action rule once it lands.

### Decisions for the maintainer (not in any package)

- **D1. Tenant-specific chrome in the shared stylesheet.** About 600 lines of one portal's
  public-site chrome and hard-coded colours live in `styles.css` and `AcmdChrome.tsx`. They work,
  but they break "tenants are data, not code". Moving them behind the portal layout system is a
  separate project.
- **D2. The light grey ramp.** `--rp-n-100` and `--rp-n-200` are cool slate values inside a ramp
  described as warm. Changing them changes every portal on its own colours, and
  `HOUSE_LIGHT_SUITE` mirrors them in a test, so it is left as is unless you want the warmer
  greys.

## Accessibility summary (before)

| Check | Hosted (164) | Harness (444) |
| --- | --- | --- |
| Horizontal overflow at 390 px | 0 | 0 |
| axe `color-contrast` | 14 page views (alpha tiers on brand, hero list) | 97 (94 on `bright`) |
| axe `select-name` (critical) | not reached | 16 (graph strategy editor) |
| axe `aria-progressbar-name` | not reached | 16 (enrichment run) |
| Controls under 24 px | resize rail, checkboxes, range | text links, 13 px checkboxes, toggles |
| Controls under 44 px at 390 px | 4 to 20 per page | up to 20 per Manage tab |
| Console errors | only the blocked requests | 0 |
