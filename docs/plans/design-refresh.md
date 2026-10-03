# Design refresh: the console, the portal and the till

Not a milestone. The owner's words, verbatim: "the ui and design is shit as ai slope design. fix
the damn design and ui also, it must be premium and clean, sophisticated not hazard, and easy to
handle easy to point. not complex as a erp should be but with advance tech and design sense."

Branch `design-refresh` from `integration-wave2` at `8556f42`. Decisions D-440 to D-449 and D-451 to D-463 (D-450 is an unrelated hotfix's).

## Direction (D-440)

Quiet, confident, premium, in the class of Linear, Stripe, Vercel, Mercury and Attio.

- **One accent.** A deep ink, indigo-slate (`#394776` in light), for the primary action, focus
  and selection only. Not a saturated blue. An org's brand colour still sets the hue, but its
  chroma is capped near the ink (D-441), so no brand paints every button orange.
- **Warm neutrals.** The stone family (hue 75, chroma under 0.006) for chrome, text and
  surfaces. Dark is a true neutral charcoal (`#181716`), never navy, never black.
- **Surfaces step rather than outline.** The chrome sits on `--canvas`; the page is a sheet one
  step lighter, inset by a hairline with a 14px corner. Cards are a hairline on the sheet. Shadows
  only on floating layers (menus, popovers, dialogs, sheets).
- **Status is a word with a dot on a soft tint** (D-444), never a loud filled pill.
- **Type** (D-442): Inter with Hind Siliguri for Bangla, 14px body with a hair of negative
  tracking (none for Bangla), 22px page titles, 15px section titles, 12px labels, 28px KPI
  figures, tabular numerals for every number.
- **Motion:** 120 to 180ms, ease-out, a 4px rise for floating layers; nothing when the OS asks
  for reduced motion.
- **Easy to point:** one obvious primary action per page, secondary actions in a menu, filters
  that show which are on, every screen and action one Ctrl K away.

## Tokens (`packages/ui/src/styles/tokens.css`)

| Role                                       | Light                    | Dark            | Use                                   |
| ------------------------------------------ | ------------------------ | --------------- | ------------------------------------- |
| `--canvas`                                 | stone 0.975              | 0.185           | sidebar, the ground around the sheet  |
| `--background`                             | white                    | 0.21            | the page sheet                        |
| `--card` / `--popover`                     | white                    | 0.23 / 0.24     | cards, menus, dialogs                 |
| `--muted` / `--accent`                     | 0.968 / 0.955            | 0.255 / 0.27    | fills, hover                          |
| `--selected`                               | 0.93                     | 0.29            | the active nav entry, a chosen filter |
| `--primary`                                | ink L0.41 C0.08 H270     | L0.53 C0.10     | primary action, focus, selection      |
| `--primary-subtle`                         | the accent at 20% chroma |                 | a selected range, a set filter        |
| `--border` / `--input`                     | 0.905 / 0.86             | 0.305 / 0.36    | hairline / a field's edge             |
| `--overlay`                                | ink at 32%               | charcoal at 60% | scrim                                 |
| `--chart-1` / `--chart-2` / `--chart-grid` | accent / stone           |                 | charts                                |
| status `-subtle` pairs                     | chroma ≤ 0.03 fills      |                 | badges                                |

Static: radius 10px (controls 8, cards 10, dialogs 14), 40px rows, 36px controls, sidebar 15rem
(rail 3.75rem), topbar 3.25rem, form measure 48rem, page measure 90rem, two shadows, three
durations. The token test now also holds AA for text on the canvas, the selected fill, the
accent tint and a hovered row, and 1.5:1 for a field's edge.

## Components (packages/ui)

Changed: Button (variants re-tuned; `icon-sm`, `link`), StatusBadge (dot and tint), states
(icon tile, one sentence, one action), Input (`controlClassName`: accent edge and a soft halo on
focus; width left to the caller), Dialog (14px corners, scrim token, enter motion), Popover,
DataTable (D-448), fields (`SelectField` on the kit Select), Money (`compact`, D-455), DateTime
(`compact`, D-456), `cn` (knows the preset's sizes, D-461).

New: `Select` (D-443), `SearchInput`, `FilterChips`, `PageHeader`, `TabList` with
`tabClassName`, `Section`, `Card`, `Toolbar`, `DescriptionList`, `Hint` (a CSS tooltip, D-445),
`Kbd`, `Monogram`, `StatCard`, `Delta`, `Sparkline`, `MetricList` (D-446), `Sheet` (D-447),
`Menu` (Radix dropdown), `Checkbox` (D-457), `DatePicker`, `MonthPicker`, `DateRangePicker`
(D-459).

## The console

- **Shell** (D-449): the sidebar groups the work (Home, Sell, Products and stock, Money, People,
  Admin), folds groups (remembered), folds to an icon rail under 1280px or on request, and is a
  drawer on a phone. The brand switcher heads it; Settings and the fold button sit in a solid
  footer. The topbar has a breadcrumb, a search field that opens the palette, the inbox, the theme
  switch, বাংলা/English and the account menu (Sign out moved there).
- **Command palette** (D-463): actions named as what people do, with the words they type as
  keywords; every screen and section tab with its section; recent places; theme and language.
  CASL-filtered like the sidebar. Lazy, with the shortcut owned by the shell (D-451).
- **Overview** (D-453): a greeting; four KPIs for the last seven days with their trend and the
  change against the week before; "Needs your attention" (approvals waiting, orders to confirm,
  stuck parcels); more figures; the fortnight's revenue; quick actions; the workspace facts. Only
  existing endpoints, each asked of the caller's ability.
- **Pages**: Orders (progressive filters with chips, D-452; the table fits 1280px, D-458), order
  detail (timeline), the order desk (sections), Analytics (KPIs then statements, the operator's
  corner in a Data menu, D-460), Accounts, Approvals, Customers, Staff, People and Payroll (create
  forms in sheets), Settings (a left-hand section nav, D-454). Every native `<select>` and date
  input outside catalog, stock and supply is the kit's.
- Catalog, stock and supply were rebuilt in parallel by another builder and were not edited here;
  they inherit the tokens, the type scale (their `text-lg` titles moved with everyone's) and the
  kit components.

## Portal and till (D-462)

- Portal: a slim top bar with the brand's monogram, the position as two cards, card-framed
  tables, documents as a quiet list, a centred sign-in. Position figures stay full precision,
  because the portal's spec asserts them.
- Tracking page: a narrow card and a vertical status timeline; Bangla by default.
- Till: the canvas ground, one segmented screen switch, targets of 44px or more, a 56px ink Pay
  and the total at 30px. The offline queue, the service worker and printing are untouched.

## Bundle

The console's initial route went from 245.1 KB to about 238 KB gzipped: the palette, the account
menu and the phone drawer are their own chunks, fetched after the first paint.

## Status on 2026-10-03

- Built and committed in four commits on `design-refresh` (`9617c5e`, `63facca`, `fd97522`, and
  the pickers commit); the first three were deployed to the owner's test site by the coordinator.
- Before and after screenshots: `docs/review/design/before/` and `docs/review/design/after/`.
- Verification: see the progress entry.
- Left for later: catalog, stock and supply screens (the other builder's), the investor,
  branch and loan detail pages' inner tables (tokens only), a second pass on Bangla line lengths
  in narrow tables, and a per-user theme setting stored server side.
