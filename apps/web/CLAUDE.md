# Frontend rules (apps/web)

These apply to every change under `apps/web`. See root `CLAUDE.md` for the full rule set.

## Visual QA is mandatory - "done" means SEEN, not just compiled

A UI change is not finished until it has been VISUALLY verified in a real browser on the deployed
page (or a local run). Gates (`deno task check`, `build:web`) do not catch visual, layout, theme or
UX bugs. Before calling any UI work done, check with your own eyes:

- **Light mode AND dark mode** - theme-specific bugs are common (translucency bleed, contrast, seams
  where a translucent surface straddles two backgrounds).
- **Wide desktop AND ~390px mobile** - no horizontal body scroll; rails stack sensibly on mobile.
- The changed element PLUS the surrounding chrome (sticky header/menu, rails, scroll behaviour).

## Design bar

- World-class, never "vibe coded". Considered typography, spacing, hierarchy, motion; real
  empty/loading/error states. Use the `rp-*` design tokens and component classes, never raw one-off
  colours.
- **Use the full screen on large displays.** Layouts scale UP on 2xl+ (27-inch, maximised windows),
  not only down to mobile. Avoid fixed centred `max-w-6xl` columns that strand half a large monitor;
  keep prose columns at a readable measure (~65-75ch) while using the extra width for grids, rails
  and viewers.
- Translucent surfaces (`rp-glass`) must not let page content bleed through when content scrolls
  under them - use an opaque or near-opaque fill for the sticky header and any floating tiles that
  overlap a two-tone background. Verify in light mode specifically.
- Australian English, no em dashes (spaced hyphen) in any user-facing copy.
- Accessibility: keyboard reachable, visible focus, logical heading order, `prefers-reduced-motion`.

## The appearance system - EVERY new feature must plug into it

Tenants configure colours, typography, text size, shape and density from Manage > Appearance. All of
it flows through CSS custom properties written by `apps/web/src/lib/theme.ts` (`tenantThemeVars`)
onto the `.rp-tenant` wrapper and mirrored onto `<body>` (so overlays that portal to `document.body`
follow too). **A new component that hardcodes a colour, radius, font or control height that these
tokens cover is a bug**, even if it looks right on the default portal - it will break on another
palette, shape, or density. When in doubt, reach for the `rp-*` component classes (`rp-card`,
`rp-btn`, `rp-chip`, `rp-badge`, `rp-input`, `rp-tile`, `rp-display`, `rp-suggest-card`) which are
already fully wired.

### Colour roles (twelve + greys)

Defined per palette in `packages/core/src/palettes.ts` (with a WCAG contract test - a new or edited
palette that fails `validatePalette` fails CI). Portals without a library palette derive these from
their seeded four-colour identity, so the tokens are ALWAYS present:

- `--rp-primary` - the dark brand ground: nav band, footer, primary buttons, active tab fills.
- `--rp-on-primary` - text/icons ON primary. **Never `text-white` on a brand surface** - a palette
  may not pair white with its brand. Alpha tiers via
  `color-mix(in srgb, var(--rp-on-primary) N%, transparent)` or `/N` utility modifiers.
- `--rp-brand-fg` - brand-coloured ink on light surfaces (icon strokes, tile labels).
- `--rp-accent` - the decorative accent ONLY: nav underline, dots, bars, solid selection fills.
  **Never as text and never as a thin selected border on white** - several palettes' accents fail
  text contrast by design.
- `--rp-on-accent` - text/ticks on solid accent (citation pills, checkmarks). Not white.
- `--rp-accent-fg` - accent as TEXT: links, citation superscripts, chip labels, "show more".
- `--rp-focus` - focus indicator; use `.rp-focus` / `--rp-ring` rather than outlining in accent.
- `--rp-wash` / `--rp-wash-strong` - tinted selection grounds (selected chips, bubbles, tiles,
  sidebar actives). Use these instead of `color-mix` with the accent - washes are authored per
  palette and are not always accent-tinted.
- `--rp-hero-from` / `--rp-hero-to` / `--rp-on-hero` - the hero duotone and its text.
- Greys: `--rp-paper`, `--rp-app`, `--rp-surface`, `--rp-surface-2`, `--rp-surface-3`, `--rp-line`,
  `--rp-line-2`, `--rp-ink`, `--rp-ink-2`, `--rp-ink-3`. Library palettes replace the whole suite
  (temperature-tinted, and INVERTED for dark palettes) - never hardcode a grey, white or black for
  UI chrome.
- Statuses `--rp-ok/warn/bad-{bg,ink,line}` are global semantics, not brand - but they flip with
  dark palettes, so always pair bg+ink from the same set (e.g. a tick on `--rp-ok-ink` is
  `text-[var(--rp-ok-bg)]`, not white).
- **Dark palettes exist** (Observatory). Any "light-only" assumption - a white glow, a hardcoded
  pale ground, `color-scheme: light` styling - is a bug. Verify new UI on the Observatory palette
  before calling it done.

### Shape dials

- `--rp-radius` - surfaces: cards, panels, dropdowns, sheets, empty states, thumbnails.
- `--rp-radius-btn` - buttons, menu items, segmented groups, link focus shapes.
- `--rp-radius-chip` - chips, tags, labels, progress tracks.
- `--rp-radius-input` - inputs, selects, checkboxes, search composites.
- `--rp-btn-px` - button horizontal padding (larger under the soft shape).

`rounded-none` or a hardcoded `rounded-[Npx]` on portal UI is a bug unless the element is
deliberately shape-independent (gauge tick marks, avatar/status circles - `rounded-full` circles are
fine). Square shape sets every dial to 0, so following the dials costs nothing.

### Density and sizing

- Tailwind spacing utilities (`p-*`, `gap-*`, `space-y-*`, `h-*`...) automatically ride the rhythm
  dial (`--spacing` is derived from `--rp-density` on `.rp-tenant`) - no work needed.
- Fixed control heights must ride the damped dial instead:
  `h-[calc(2.25rem*var(--rp-density-ctl,1))]` (buttons/inputs share 2.25rem; header chrome 3rem).
  Controls in one row must share one height - do not mix `rp-chip h-7` with inputs.
- `rp-density-fixed` pins a canvas/pixel-tuned subtree to canonical spacing.
- Text sizes never ride density; the text-size setting scales the ROOT font, so size in rem.

### Typography

- Headlines use `.rp-display` (face, weight, tracking and leading are per-pairing dials). Body
  inherits `--rp-font-body`. Never hardcode `font-family`; avoid raw `font-light` on UI labels
  (weights are tenant-facing).
- Gotcha: custom properties substitute nested `var()`s where they are DEFINED - a var alias declared
  at `:root` will not see tenant overrides. Aliases must be re-declared on `.rp-tenant` (see
  `--font-sans`, `--rp-ring` in `styles.css`).

### Verifying a new feature against the system

Flip your dev portal in Manage > Appearance and eyeball the feature under: shape `soft`, density
`comfortable` or `spacious`, the `observatory` (dark) palette, and a non-default typography pairing.
Computed-style checks beat screenshots - assert the rendered element's `border-radius`/`color`
resolves to the token value, not a stale fallback.

## Vendor deps

Loaded from esm.sh via the import map in `index.html` and `--external` in `deno.json`'s build:js.
The npm registry is blocked; do not add npm/node_modules. The entry HTML is served no-cache with
`?v=<build sha>` on `/app.js` and `/styles.css` (see `apps/api/src/server.ts`) so deploys are not
masked by a stale browser bundle - keep that intact.
