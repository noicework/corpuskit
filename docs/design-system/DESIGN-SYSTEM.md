# CorpusKit design system

Status: target specification, 17 October 2026. It extends the appearance-system rules in
`apps/web/CLAUDE.md` (which still apply in full) and is what the work packages in
`WORK-PACKAGES.md` implement. `REVIEW.md` explains why each change is here.

Words used precisely below: **must** is a rule a reviewer will reject a change for breaking;
**should** is the default unless there is a stated reason.

## 1. Inventory: what exists today

| Layer | Where | State | Target |
| --- | --- | --- | --- |
| Colour roles (12) and grey suite | `packages/core/src/palettes.ts`, `lib/theme.ts`, `styles.css` | Contract-tested per palette | Keep; add the derived roles in section 3.1 |
| Status colours (ok, warn, bad) | `styles.css`, `DARK_STATUS_VARS` | Correct in both schemes | Keep |
| Categorical colours (6) | `styles.css` `--rp-cat-*` | Ink aliases resolve at `:root`; one hue fails on dark | Re-declare on `.rp-tenant`; add a dark set |
| Typography | `--rp-font-*` hooks, `.rp-display`, `.rp-eyebrow`, `.rp-prose` | Sound, but 41 fixed-px sizes | Add `text-2xs`; rem only |
| Spacing | Tailwind `--spacing` riding `--rp-density` | Sound | Keep; standard rhythm in section 3.4 |
| Radius | four dials | Sound | Keep; nested-radius rule |
| Shadow | four tiers | Sound | Keep; dark-scheme rule |
| Motion | `--rp-ease`, entrance keyframes, reduced-motion blocks | Sound | Keep; duration scale in section 3.7 |
| Focus | `--rp-ring`, `.rp-focus`, forced-colours outline | Sound | Keep; no accent outlines |
| Buttons | `.rp-btn` + primary, outline, ghost, danger | One height; 43 call sites force others | Size scale, icon button, control role, coarse floor |
| Segmented controls | ad hoc in library, search, graph, Manage | Selected state is fill only | `.rp-seg` |
| Chips, tags, badges | `.rp-chip`, `span.rp-chip`, `.rp-badge` | Static and interactive share a class | `.rp-chip` (interactive), `.rp-tag` (static), `.rp-badge` (status) |
| Inputs | `.rp-input`, `.rp-select`, `.rp-field` | `.rp-input` uses the hairline | Field edge on all three |
| Native checks | browser default | Unthemed, 13 px in places | `accent-color`, 1.125rem, `.rp-check` |
| Cards and sections | `.rp-card`, `pages/admin/Section.tsx` | Mixed grounds and header layouts | `SectionHeader`, one card ground |
| Dialogs and scrims | native `dialog`, four overlays | Five scrim recipes | `--rp-scrim`, `.rp-dialog` |
| Icons | 74 inline SVGs, two idioms | No module | `components/icons.tsx` |
| Logos | header `img` | No dark fallback | Logo plate |
| Header, nav band, phone sheet | `TenantLayout.tsx` | Sound | Token and target fixes |
| Footer | `PortalFooter.tsx` | Alpha tiers; credits crowd | Section 4.12 |
| Graph | `GraphPage.tsx`, `KnowledgeMap*.tsx`, `map3d-engine.ts` | Phone fit and dark captions broken | Section 4.13 |
| Ask and citations | `AskPage.tsx`, `AnswerStream.tsx`, `QualityGauge.tsx` | Sound; clipped title, mixed actions | Section 4.14 |
| Library, search, document | `LibraryPage.tsx`, `SearchPage.tsx`, `PdfReader.tsx` | Measure and toolbar issues | Section 4.15 |
| Manage and platform admin | `ManagePage.tsx`, `pages/admin/*` | Inconsistent section anatomy | Section 4.16 |

## 2. Principles

1. **Tenants are data.** Nothing tenant-specific in a component. Every colour, radius, face,
   size and control height comes from a token that the appearance system writes.
2. **Guarantees, not hopes.** Where a tenant's colours could break legibility, a derived role
   computes a safe value (as `paletteFromColours` already does). Components use the role and do
   not do their own maths.
3. **One way to do each thing.** One button, one icon set, one scrim, one section header. A
   second way needs a written reason.
4. **The reader's settings win.** Text sizes are in rem, motion yields to
   `prefers-reduced-motion`, focus survives forced colours, and dark mode is a real theme.
5. **Content first.** Prose at a readable measure, wide screens used for grids, rails and
   viewers, phones given the full width.

## 3. Foundations (tokens)

### 3.1 Colour roles

The twelve roles and the grey suite in `apps/web/CLAUDE.md` stay as they are. The following are
added. Each is written by `lib/theme.ts` for every palette and both schemes, so a component can
always rely on it.

| Token | Meaning | Guarantee | Light value | Dark scheme value |
| --- | --- | --- | --- | --- |
| `--rp-on-primary-2` | Secondary text on `--rp-primary` (taglines, captions, eyebrows) | 4.5:1 on `--rp-primary` | `--rp-on-primary` mixed toward the brand, as dim as 4.5:1 allows | same rule on the dark-scheme primary |
| `--rp-on-hero-2` | Secondary text on the hero | 4.5:1 on both hero endpoints | as above against `--rp-hero-from` and `--rp-hero-to` | as light |
| `--rp-control` | Fill of a primary button and of a selected segment | 3:1 against `--rp-surface` and `--rp-paper` | `--rp-primary` when it reaches 3:1; otherwise `--rp-accent` when it and `--rp-on-accent` qualify; otherwise `--rp-brand-fg` | `--rp-primary` lightened in steps until it reaches 3:1 on the dark surface |
| `--rp-on-control` | Text and icons on `--rp-control` | 4.5:1 | `textOn` of the control | `textOn` of the control |
| `--rp-scrim` | Ground behind every modal overlay | always darkens | `rgba(10, 10, 12, 0.5)` | `rgba(0, 0, 0, 0.62)` |
| `--rp-logo-plate` | Ground for a light-only logo in the dark scheme | the logo's own design ground | the palette's light paper (`#ffffff` on the house suite) | unchanged (it is always light) |
| `--rp-cat-1` to `--rp-cat-6` | Categorical marks (graph, strategy editor) | 3:1 against `--rp-surface` | current values | a lifted set, each 3:1 or better on the dark surface |
| `--rp-cat-N-ink` | Categorical text | 4.5:1 against `--rp-surface` | 55% hue into `--rp-ink` | the same mix, **declared on `.rp-tenant`** so it sees the scheme's ink |

Rules:

- **Alpha is never a text tier.** `color-mix` or `/N` on `--rp-on-primary`, `--rp-on-hero` or
  `--rp-ink` is allowed for borders, dividers, hover fills and disabled states only. Secondary
  text uses `--rp-ink-2`, `--rp-ink-3`, `--rp-on-primary-2` or `--rp-on-hero-2`.
- **Hero content uses hero roles.** Anything drawn over the hero gradient or photograph uses
  `--rp-on-hero` and `--rp-on-hero-2`, never `--rp-on-primary`.
- **`.rp-btn-primary` fills with `--rp-control`**, not `--rp-primary`. The nav band, footer and
  brand mastheads keep `--rp-primary`: they are identity surfaces, not controls.
- The accent stays decorative (`apps/web/CLAUDE.md`): no accent text, no accent focus outlines,
  no thin accent borders on white. Hover and focus treatments that use the raw accent today move
  to `--rp-accent-fg` (text), `--rp-wash` (fills) or `--rp-ring` (focus).
- Any alias that mixes another role must be declared on `.rp-tenant` as well as `:root`.

### 3.2 Typography

Faces, weights, tracking and leading stay on the existing hooks. The size scale is Tailwind's,
plus one step:

| Step | Size | Use |
| --- | --- | --- |
| `text-2xs` | 0.6875rem | Eyebrows, badges, key hints. Uppercase eyebrows only at 600 weight. Nothing smaller exists. |
| `text-xs` | 0.75rem | Metadata, captions, helper text |
| `text-sm` | 0.875rem | UI labels, buttons, dense lists, secondary body |
| `text-base` | 1rem | Body copy, inputs, answer prose on a phone |
| `text-lg` | 1.125rem | Card titles, section titles in reading pages |
| `text-xl` to `text-4xl` | 1.25rem to 2.25rem | Page and hero titles, always with `.rp-display` |

- Every size is in rem. `text-[10px]`, `text-[11px]` and any `px` font size in a component are
  bugs. Canvas and SVG labels inside the graph are the one exception, because they are scaled
  with the map.
- Page title: `rp-display text-2xl sm:text-3xl`. Section title: `text-base font-semibold`
  (Manage) or `rp-display text-xl` (reading pages). Card title: `text-base font-semibold` or
  `text-sm font-semibold` in dense grids.
- Long prose (answers, summaries, extracted text) sits in `.rp-measure` with `.rp-prose`.
- Nothing may clip at a 22 px root font. Use `min-height`, never `height`, on boxes that hold
  text.

### 3.3 Iconography

One module, `apps/web/src/components/icons.tsx`, exports every icon as a named React component.

- Grid 24 by 24, `fill='none'`, `stroke='currentColor'`, `strokeWidth={1.75}`, round caps and
  joins. Filled shapes only for tiny dots and for the selected state of a toggle (a filled
  bookmark when saved).
- Sizes by prop: `sm` 1rem, `md` 1.25rem (default), `lg` 1.5rem. In rem so icons scale with
  text.
- Decorative by default (`aria-hidden`). An icon-only control gets its name from `aria-label`
  on the control and a matching `title`.
- No text characters as icons: no typed "+", "x", "?", "→", "←" or "↗" inside controls. Arrows
  after link text may stay as text only inside running prose.
- Paths are original or taken from Lucide (ISC); if any Lucide paths are used, its licence
  notice goes into `NOTICE`.

Action-to-glyph rule (buttons that do these things must carry these icons):

| Action | Icon | Action | Icon |
| --- | --- | --- | --- |
| Save, saved | `Bookmark`, `BookmarkFilled` | Delete, remove | `Trash` |
| Hide, show | `EyeOff`, `Eye` | Publish | `Upload` or `Send` |
| Add, new | `Plus` | Edit | `Pencil` |
| Copy | `Copy` | Export, download | `Download` |
| Refresh, retry | `RotateCw`, `RotateCcw` | Open in new tab | `ExternalLink` |
| Search | `Search` | Filter | `SlidersHorizontal` |
| Close | `X` | Menu | `Menu` |
| Helpful, not helpful | `ThumbsUp`, `ThumbsDown` | Confidence, checked | `ShieldCheck` |
| Sessions, history | `History` | Back, forward | `ArrowLeft`, `ArrowRight` |

### 3.4 Spacing and layout rhythm

Spacing utilities ride `--rp-density`; no work is needed for density. The standard rhythm:

- Page: `rp-shell`, `py-8 lg:py-10`. Page title block to content: `mt-6`.
- Between sections: `space-y-6 lg:space-y-8`. Inside a card: `p-5 lg:p-6`, stack `space-y-4`.
- Between controls in a row: `gap-2`. Between groups of controls: `gap-3` or a divider.
- Detail pages (document, entity, investigation) use a two-column grid from `lg`: main column
  plus a rail of 20 to 24rem. A single centred narrow column on a desktop is a bug.
- Readable measure: prose at `rp-measure` (72ch). Tables, figures and viewers may use the full
  column.

### 3.5 Radius

The four dials stay. Nested surfaces subtract their inset:
`rounded-[max(0px,calc(var(--rp-radius)-0.25rem))]` for a panel 0.25rem inside a card. Circles
(`rounded-full`) are fine for avatars, dots, the switch knob and the graph's round controls.

### 3.6 Elevation

`rp-shadow-sm` for cards, `md` for hover lift and popovers, `lg` for menus and dropdowns, `xl` for
dialogs and the hero figure. In the dark scheme a card's edge comes from `--rp-line` and the step
between `--rp-paper` and `--rp-surface`; shadows add little and must not be relied on.

### 3.7 Motion

Durations: 150 ms for state (hover, press, colour), 180 to 260 ms for entrances and menus, 320 to
420 ms for page and answer transitions. Easing `--rp-ease`. Entrances rise 4 to 8 px and fade.
Under `prefers-reduced-motion: reduce` nothing translates, scales or loops; fades finish in
1 ms. Every new animation class gets its reduced-motion rule in the same commit.

### 3.8 Layering

| Layer | z-index |
| --- | --- |
| Sticky header | 40 |
| Popovers, menus, typeahead | 50 |
| Phone navigation sheet | 60 |
| Dialogs, command palette | 80 |
| Toasts and live notices | 90 |

## 4. Components

### 4.1 Buttons

```
.rp-btn                     base: inline-flex, gap 0.5rem, text-sm, weight 500
  .rp-btn-sm                min-height calc(2rem * ctl), padding-inline 0.625rem, text-xs
  (default md)              min-height calc(2.25rem * ctl)
  .rp-btn-lg                min-height calc(2.75rem * ctl), text-base
  .rp-icon-btn              square: width = min-height, padding 0
variants
  .rp-btn-primary           --rp-control / --rp-on-control
  .rp-btn-outline           --rp-surface, border --rp-line, ink
  .rp-btn-ghost             transparent, ink-2, hover surface-2
  .rp-btn-danger            transparent, bad-ink, hover bad-bg
  .rp-btn-danger-outline    surface, border bad-line, bad-ink (destructive action in a toolbar)
```

- Below `lg` and on any coarse pointer, every `.rp-btn` (any size, including icon buttons) has
  `min-height: max(2.75rem, ...)`. Icon buttons are 2.75rem square there.
- Heights come from the size class. `h-6` to `h-9` on a `.rp-btn` is a bug.
- Icon in a button: leading, `sm` in `sm` and `md` buttons, `md` in `lg` buttons.
- One primary button per view region. Destructive buttons come last in a group.
- A React `Button` and `IconButton` in `components/ui.tsx` wrap these classes; new code should
  use them.

### 4.2 Segmented control

`.rp-seg` (track: `--rp-surface-2`, border `--rp-line`, radius `--rp-radius-btn`, padding 2px) with
`.rp-seg-item` children. The selected item (`aria-pressed='true'`, `aria-selected='true'` or
`aria-current`) fills with `--rp-control` and `--rp-on-control`, which guarantees the 3:1 state
contrast in both schemes. Items share the button size scale and the coarse floor. Use it for
Grid/List, search modes, graph view and layout, and Manage's add-content modes.

### 4.3 Chips, tags and badges

- `.rp-chip`: interactive only (filters, suggestions, related entities). Selected:
  `.rp-chip-active`. `min-height: calc(2rem * ctl)`; below `lg` 2.25rem with at least a
  0.5rem gap, so target plus spacing reaches 44 px.
- `.rp-tag`: static labels (resource kind, topic on a card). No hover, no pointer, `text-xs`,
  `--rp-surface-2` ground, `--rp-ink-2` text, `min-height: 1.5rem`, radius chip dial. Replaces
  `span.rp-chip`.
- `.rp-badge`: status only (`ok`, `warn`, `bad`, `quiet`). Not for categories.

### 4.4 Inputs and form controls

- `.rp-input` and `.rp-select` draw their edge in `--rp-field`. `.rp-field` (composite box)
  already does. `--rp-line` is for dividers only.
- Native checkboxes, radios and ranges inside `.rp-tenant` take
  `accent-color: var(--rp-accent-fg)` and a 1.125rem box.
- `.rp-check`: the label wrapping a checkbox or radio. `inline-flex`, gap 0.625rem, min-height
  2rem, 2.75rem below `lg`. The whole label is the target.
- Every control has a visible label or an `aria-label`; selects in tables and editors included.
- Helper text `text-xs text-ink-3` below the control; errors `text-xs` in `--rp-bad-ink` with an
  `AlertCircle` icon, linked by `aria-describedby`.
- `.rp-switch` stays the toggle.

### 4.5 Links

- Inline links in prose: `--rp-accent-fg`, underline offset 0.2em, thicker underline on hover.
- `.rp-link-standalone`: a link on its own line ("Back to the portal", "Open taxonomy").
  `inline-flex`, icon plus text, min-height 1.5rem on a fine pointer and 2.75rem below `lg`.
  Back links lead with `ArrowLeft`; onward links trail with `ArrowRight`; external links trail
  with `ExternalLink` (decorative) and say "opens in a new tab" to screen readers.

### 4.6 Cards and sections

- `.rp-card` is the one card: `--rp-surface`, border `--rp-line`, radius dial, `rp-shadow-sm`.
  Sibling sections share one ground; `--rp-surface-2` is for insets inside a card (an upload
  drop zone, a code block), not for alternating sections.
- `SectionHeader` (`components/ui.tsx`): `title`, optional `description`, optional `actions`,
  heading level. Title left, description under it (`text-sm text-ink-2`, prose measure), actions
  right-aligned on the title's line and wrapping under it on a phone. Refresh, export and similar
  utilities live in `actions` as small ghost buttons with icons, never between the title and the
  content.
- Empty, loading and error states use `EmptyState`, `Skeleton` and `ErrorCard` from `ui.tsx`.

### 4.7 Lists and tables

- Row actions are icon-and-label ghost buttons (`rp-btn-sm`), with `Trash` and
  `rp-btn-danger` for Delete. On a phone a row stacks: title, then meta and status, then the
  actions as one line.
- Tables: header row `text-xs font-semibold text-ink-2`, cells `text-sm`, numbers right-aligned
  and tabular, a horizontal scroll region (`role='region'`, labelled, focusable) on narrow
  screens rather than squeezed columns.

### 4.8 Dialogs, sheets and menus

- Native `dialog` with `.rp-dialog`: `rp-card`, `rp-shadow-xl`, `max-w-xl`, padding `p-6`,
  `::backdrop` filled with `var(--rp-scrim)` (and a literal fallback first, for browsers where
  the backdrop does not inherit custom properties).
- Title (`text-lg font-semibold`), body, then actions right-aligned: cancel or keep first,
  confirming action last. A destructive confirmation uses `rp-btn-danger-outline` or a solid
  danger, with the `Trash` icon. Initial focus on the safe action.
- Every overlay (phone sheet, command palette, Ask session drawer, sign-in) uses
  `--rp-scrim`. Blur is optional and the same everywhere (`backdrop-blur-sm`).
- Menus: `rp-card rp-shadow-lg`, items `min-height 2.25rem` (2.75rem below `lg`), icon plus
  label, focus moves with the arrow keys.

### 4.9 Navigation

- Header strip on `--rp-surface`: logo, portal switcher, search, scheme toggle, help, account,
  phone menu. Icon buttons are `rp-icon-btn` (2.75rem). The header search is an `.rp-field`
  composite, edge at 3:1.
- Nav band on `--rp-primary`, links in `--rp-on-primary`, weight 400 (300 is too thin on bright
  brands), active link weight 600 with the accent underline.
- Phone sheet: on `--rp-primary`, rows 2.75rem or more, secondary actions as outline rows.

### 4.10 Logos

- Header logo: max height 4rem on desktop, 2.5rem on a phone, width capped by `logoMaxWidth`.
- In the dark scheme the header uses `logoDarkUrl` when it is set and differs from `logoUrl`.
  Otherwise the light logo sits on `.rp-logo-plate`: `--rp-logo-plate` ground, padding
  `0.375rem 0.625rem`, radius `--rp-radius-btn`, a 1 px `--rp-line` ring. The same rule applies
  wherever a logo appears (phone sheet, footer, sign-in, platform estate).
- Manage > Appearance previews the logo on the header ground in both schemes, and says when the
  plate will be used.

### 4.11 Home and hero

- Hero text, question chips, the "Recently added" list and the hero search all use the hero
  roles.
- Starter question chips: `text-sm`, at least 2.75rem tall, left-aligned text in every
  variant.
- The hero submit button matches the field's height minus its inset.

### 4.12 Footer

- Footer on `--rp-primary`. Product name `rp-display text-2xl`, tagline and column headings in
  `--rp-on-primary-2`, links in `--rp-on-primary`.
- Closing row, three zones: copyright (left), the portal's note (middle, `max-w-prose`), and a
  **credits group** (right): an inline list of credit links ("Powered by CorpusKit", "Powered by
  Progress Agentic RAG") separated by a middle dot, kept together as a unit. Below `md` the zones
  stack in that order and the credits group keeps its own line. All closing-row text is `text-xs`
  in `--rp-on-primary-2`; credit links get padding for a 2.75rem target below `lg`.

### 4.13 Knowledge graph

- On a phone the map's box is the visible area below the header and masthead (not `100dvh`), and
  the first view fits the whole overview inside it with room for captions. No blank band above or
  below. "Back to top" appears only after the reader has scrolled past the map.
- Captions never overlap each other or a mark's centre; collision placement moves or abbreviates
  them.
- Captions and legend text use `--rp-cat-N-ink`; marks use `--rp-cat-N`. Both hold in dark mode.
- Masthead text uses `--rp-on-primary-2`; its segmented controls use `.rp-seg` on the brand
  ground (a variant with `--rp-on-primary` borders); every control is 2.75rem below `lg`.
- The entity page uses the two-column detail layout and shows relation labels through
  `graphRelationLabel`, never raw identifiers such as `located-in`.

### 4.14 Ask and citations

- The question heading shows the whole question, clamped at four lines with a "Show full
  question" toggle beyond that. It is not repeated above its own bubble.
- Answer prose at `rp-measure`; tables may run the full column.
- Citation markers `[n]` in `--rp-accent-fg`; source numbers in the rail on `--rp-accent` with
  `--rp-on-accent`.
- One answer toolbar: confidence badge left; helpful, not helpful, copy, ask again (and export)
  as `rp-icon-btn` ghost buttons right. It stays on one line on a phone.
- Composer: a visible label or placeholder at every width ("Ask a question" on a phone),
  the send button is `rp-btn-primary`, "New session" carries `Plus`.
- Stage timeline: done marks use `--rp-on-accent` on `--rp-accent`; the active mark uses
  `--rp-accent-fg` on `--rp-wash`.

### 4.15 Library, search and document viewer

- Grid/List and the search modes are `.rp-seg`. Filter checkboxes are `.rp-check`. The
  grid-density slider has a visible label and a 2.75rem thumb area below `lg`.
- Card: thumbnail, title (clamp 2), meta line (authors and year, kept together so a separator
  never starts a line), summary (clamp 3), up to two `.rp-tag`s plus "+n".
- Search's AI answer follows section 4.14 (measure, toolbar).
- PDF toolbar: one row on a phone (previous, page field, next, zoom out, zoom in) and an overflow
  menu for fit, fullscreen, print, download and open. All controls 2.75rem below `lg`.
- Thumbnails in the dark scheme: `filter: brightness(0.92)` and a 1 px `--rp-line` ring.
- Document header actions (after the in-flight work lands): outline buttons with leading icons,
  equal size, Save (`Bookmark`, filled and `aria-pressed` when saved) then Delete (`Trash`,
  `rp-btn-danger-outline`).

### 4.16 Manage and platform administration

- Every tab is a stack of `.rp-card` sections, each opened by a `SectionHeader`.
- Side navigation from `lg`; below it a horizontal tab strip with an edge fade that shows more
  tabs exist, the active tab scrolled into view, tabs 2.75rem tall.
- Row actions per section 4.7; destructive confirmation per section 4.8.
- Status uses `.rp-badge`; stats use the stat tile (label `text-2xs` eyebrow, value
  `text-2xl font-semibold tabular-nums`).
- Disclosure toggles ("View raw configuration", "Show raw schema", audit "Event details") are
  `rp-btn-ghost rp-btn-sm` with a `ChevronDown` that rotates, never bare 16 px text.

## 5. Dark mode rules

1. Dark is a token swap. Components never branch on the scheme for colour.
2. No hard white, black or grey for UI chrome. Scrims are `--rp-scrim`.
3. Filled controls use `--rp-control`; identity surfaces keep `--rp-primary`.
4. Logos follow section 4.10.
5. Images: thumbnails dimmed (section 4.15); hero photographs keep their duotone.
6. Categorical and status colours have dark sets; check marks at 3:1 and text at 4.5:1 on the
   dark surface.
7. Verify every change on the viewer's dark scheme over a light palette **and** on Observatory.

## 6. Accessibility

Target: WCAG 2.1 AA, plus 2.2's target size and focus-appearance criteria.

- Contrast: text 4.5:1 (3:1 at 18.66 px bold or 24 px), non-text and state indicators 3:1,
  in both schemes, on every palette. Derived roles make this hold for a portal's own colours.
- Targets: 44 by 44 px for every control below `lg` or under a coarse pointer (chips: 36 px plus
  spacing); 24 px minimum anywhere. Inline links in prose are exempt.
- Focus: visible on everything interactive, `--rp-ring` (box shadow) plus a transparent outline
  for forced colours. No `outline: none` without a replacement.
- Keyboard: every action reachable; dialogs trap and restore focus; menus use arrow keys; the
  graph's nodes are tabbable with a visible ring.
- Names: every icon-only control has `aria-label`; every select, progress bar and region is
  named; headings in order; one `h1` per page.
- Motion: section 3.7. Text scaling: no clipping or overflow at a 22 px root font.
- Forced colours: focus outline in `Highlight`; borders survive.
- Language: `lang` on the portal wrapper follows the portal language.

## 7. Tenant theming guarantees

Each is checked by a test or by the shot harness, and must hold for any palette, shape,
density, typography and text size:

1. **Text** pairs reach 4.5:1 and state indicators 3:1, in both schemes (palette contract,
   derived roles, `--rp-control`).
2. **Shape**: every radius comes from a dial; the square shape renders every corner at 0.
3. **Density**: spacing via `--spacing`; control heights via `--rp-density-ctl`; the 2.75rem
   coarse floor holds at compact density.
4. **Type**: every size in rem; faces only through the hooks; nothing clips at a 22 px root.
5. **Logo** legible in both schemes.
6. **Overlays** follow the tenant theme (`useBodyTheme`) and use `--rp-scrim`.
7. **Language**: every new literal UI string has a Japanese entry (the catalogue audit test);
   layouts tolerate labels 30% longer and CJK text.
8. **Layout**: no horizontal overflow at 390 px; desktop layouts use the width (section 3.4).

## 8. Verifying a change

1. `deno task check` green.
2. `deno task build:web`, then
   `AXE_PATH=<axe.min.js> deno task shots --out .shots/<name> --profiles deep,bright,serif,observatory`
   for the routes you touched, light and dark, 1440 and 390, and once at `--font 22`.
3. Look at every image you produced. Compare with `.shots/baseline-harness/`.
4. No new axe violations, no horizontal overflow, no new targets under 24 px, and the 44 px rule
   met on your screens at 390 px.
