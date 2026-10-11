# Milestones: one per Claude Code session

## How to use this file

- Run each milestone with `/milestone <ID>`.
- A milestone is done only when every acceptance check passes and appears in the session's Verification Report.
- **Effort:**
  - **MAX** means launch the session with `--effort max`. Use it where money, stock, tenancy or security are at stake.
  - **XHIGH** means `--effort xhigh`.
- **Gate** means something the human must supply first. The gates are listed in START-HERE.md.
- If a milestone runs out of context, resume it in a new session. Don't split it yourself.
- **Parallel tracks:** after M14b, Track A (M15→M17) and Track B (M18→M20) can run at the same time in separate git worktrees.

| ID   | Title                                            | Phase  | Effort | Depends on         |
| ---- | ------------------------------------------------ | ------ | ------ | ------------------ |
| M00  | Repo bootstrap and toolchain                     | 0      | XHIGH  | —                  |
| M01  | Database core and multi-org isolation            | 0      | MAX    | M00                |
| M02a | Identity, auth and request context               | 0      | MAX    | M01                |
| M02b | Permissions, audit and approvals                 | 0      | MAX    | M02a               |
| M03  | Ledger core                                      | 0      | MAX    | M02b               |
| M04  | Platform services                                | 0      | XHIGH  | M02b               |
| M05  | Console shell and UI kit                         | 0      | XHIGH  | M02b, M04          |
| M06  | Catalog                                          | 1      | XHIGH  | M05                |
| M07  | Stock ledger, locations and costing              | 1      | MAX    | M03, M06           |
| M08  | Accounts and wallets                             | 1      | MAX    | M03, M05           |
| M09  | Suppliers and purchasing                         | 1      | MAX    | M07, M08           |
| M10  | Order core                                       | 1      | MAX    | M07, M08           |
| M11  | Order desk UI, buyer list, public order intake   | 1      | XHIGH  | M10                |
| M12  | Courier v1 and COD reconciliation                | 1      | MAX    | M11                |
| M13  | ~~Fraud check v1~~ removed, code deleted (D-291) | 1      | XHIGH  | M10                |
| M14a | Data migration and opening balances              | 1      | MAX    | M06–M12            |
| M14b | Deployment, observability, go-live kit           | 1      | XHIGH  | M14a               |
| M15  | Multi-courier, webhooks, tracking                | 2 (A)  | XHIGH  | M12                |
| M16  | Buyer profiles, notifications, basic promo codes | 2 (A)  | XHIGH  | M11                |
| M17  | Advance payments and return reasons (D-291)      | 2 (A)  | XHIGH  | M16                |
| M18  | Marketing                                        | 3 (B)  | XHIGH  | M11                |
| M19  | HR core, attendance, payroll                     | 3 (B)  | MAX    | M08                |
| M20  | Targets, bonus rules, productivity               | 3 (B)  | XHIGH  | M19, M11           |
| M21  | Reseller engine                                  | 4      | MAX    | M10, M12           |
| M22  | Partner portal (reseller)                        | 4      | XHIGH  | M21, M16           |
| M23  | Branches and showroom POS                        | 4      | MAX    | M08, M10           |
| M24  | Analytics, dashboards, leaderboard               | 4      | XHIGH  | M12, M18, M20, M23 |
| M25  | Investors                                        | 5      | MAX    | M08                |
| M26  | Company loans                                    | 5      | XHIGH  | M08, M16           |
| M27  | ~~Message Hub (Chatwoot)~~ removed (D-290)       | 5      | XHIGH  | M11, M13, M16      |
| M28  | ~~Agent activity extension~~ removed (D-292)     | 5      | XHIGH  | M20                |
| M29  | ~~Landing page builder~~ removed (D-290)         | 5      | XHIGH  | M11, M16           |
| M30  | Hardening and launch readiness                   | Launch | MAX    | all                |
| M31  | One ERP per brand (brand edition)                | 6      | MAX    | M30 part 1         |
| M32  | The mother ERP                                   | 6      | MAX    | M31                |
| M33  | Website catalog and content from the ERP         | 6      | XHIGH  | M31                |
| M34  | Website buying: checkout, accounts, payment      | 6      | MAX    | M33                |
| M35  | Website offers, tracking, ncom                   | 6      | MAX    | M33, M34           |
| M36  | Elysium website on the ERP, old data moved       | 6      | MAX    | M34, M35           |
| M37  | Go live: brand servers, mother, switch-over      | 6      | XHIGH  | M31–M36            |
| M38  | Barcode stickers, strict stock, scan-to-pack     | 6      | MAX    | M33                |
| M39  | Catalog management: delete, variant prices       | 6      | MAX    | M38a, M34          |

---

## M00: Repo bootstrap and toolchain

Phase 0 · Effort XHIGH · Depends on: — · Gate: G0 · Architecture: §3, §4, §27, §28

**Goal:** a clean monorepo where `pnpm verify` is the single gate for every later milestone.

**Build**

- pnpm workspace + Turborepo containing every app and package from architecture §4, each as a minimal skeleton that compiles:
  - `server`, with `main.api.ts` serving `/health/live` and `main.worker.ts` logging "ready"
  - Vite placeholders for `console`, `portal` and `pos`
  - a Next.js placeholder for `sites`
  - a WXT placeholder for `extension`
- Shared configuration in `packages/config`:
  - strict TypeScript, including `noUncheckedIndexedAccess`
  - ESLint and Prettier presets
  - path aliases
- Vitest workspace, and Playwright set up for the console with one smoke test.
- `infra/docker-compose.dev.yml` running Postgres 17, Valkey and Gotenberg, each with a healthcheck.
- Per-app config validated with Zod that fails fast on missing variables, plus `.env.example` files.
- `scripts/check-migrations.mjs`: fails if any migration file that exists on `main` has been modified or deleted.
- `pnpm verify`: format check, lint, typecheck, test, build, check-migrations.
- GitHub Actions CI that runs `pnpm verify` against service containers.
- A lint check that forbids emoji characters in UI source and `style={{` in apps.
- `.gitattributes` normalizing the tree to LF (`* text=auto eol=lf`), so Windows checkouts don't fight Prettier.
- The design token foundation in `packages/ui` (D-033, architecture §24): `src/styles/tokens.css` with an OKLCH value for every semantic role in both light and dark, the Tailwind preset that exposes them, the Inter + Hind Siliguri `@font-face` block with `size-adjust`, and a tabular-numeral utility. Tokens only; M05 builds the components on top.
- `scripts/bench.mjs`: a benchmark harness with one fixed method (warmup, fixed sample count, p50/p95/p99, machine and commit recorded), so every later latency acceptance check is measured the same way and comparable across sessions.
- A "Local setup" section in the README. Replace CLAUDE.md's Commands section with the real commands.
- Pin exact versions and use the latest stable releases.

**Acceptance checks**

1. A fresh clone passes this sequence with exit code 0: `pnpm i`, `pnpm setup:env`, compose up, then `pnpm verify`. (`setup:env` belongs in the sequence: config is Zod-validated and fails fast, so the app builds have nothing to read without it.)
2. `pnpm dev` starts everything:
   - the API answers `GET /health/live` with 200
   - the worker logs "ready"
   - the console, portal, pos and sites dev servers respond
3. check-migrations fails when a committed migration is edited. Demonstrate this on a scratch branch, then delete the branch.
4. The CI workflow passes `actionlint`.
5. `packages/ui` defines a token for every semantic role in architecture §24 in both light and dark. A unit test fails if a role exists in one theme and not the other, and the Tailwind preset resolves every one of them.
6. `.gitattributes` normalizes line endings: a file staged with CRLF is stored as LF, and `pnpm format:check` passes on a fresh clone on Windows.
7. `scripts/bench.mjs` runs a trivial workload and prints p50/p95/p99 with its sample count, the commit and the machine.

**Out of scope:** domain tables and authentication.

---

## M01: Database core and multi-org isolation

Phase 0 · Effort MAX · Depends on: M00 · Architecture: §3, §5

**Goal:** prove with tests that one org can never see another org's data.

**Build**

- `packages/db`:
  - Drizzle config with one folder per module schema
  - the generate, migrate and seed scripts
- A bootstrap migration or init script that creates the roles `erp_owner`, `erp_app` and `erp_analytics`, with default privileges.
- `org` schema tables: `organizations`, `branches`, `locations` (basic), `settings`, `feature_flags`.
- Global reference data: Bangladesh divisions, districts and thanas.
- A standard RLS helper, used by every tenant table.
- `withOrg`, `withAnalytics` and `withSystem`.
- A Testcontainers harness: Postgres 17, migrations, a fast reset between tests.
- Seed data: the five orgs, each with an HQ branch and a warehouse location. The seed is idempotent.

**Acceptance checks**

1. In an org A context, both Drizzle and raw SQL select/insert/update/delete on org B rows affect 0 rows or raise an error.
2. With no org context, tenant tables return 0 rows.
3. `erp_app` cannot SET ROLE, disable RLS or bypass policies. The test asserts each of these errors.
4. `erp_analytics` can read all orgs and cannot write.
5. A guard test enumerates every table in tenant schemas and fails on any table without `org_id`, RLS enabled and FORCE RLS. This test stays in the suite for good.
6. Running `pnpm db:migrate && pnpm db:seed` twice succeeds with no duplicate rows.

---

## M02a: Identity, auth and request context

Phase 0 · Effort MAX · Depends on: M01 · Architecture: §6, §25

**Goal:** every request knows who the user is, which org they are acting in, and which roles they hold there.

**Build**

- Better Auth:
  - email or phone plus password; cookie sessions scoped to the parent domain
  - TOTP 2FA, enforced for super_admin, org_admin, accounts and investor, with recovery codes
  - phone OTP through a fake SMS provider; the real one arrives in M16
  - rate limits on login and OTP (§25)
- `iam`:
  - memberships linking user, org, role and branch scope
  - the super_admin flag
  - an org-switch endpoint
  - a request context built from the session: user, active org, roles, branch scope, request id
- Branded login (D-035): the login route or hostname resolves an org, which is then preselected and themed. A user with one membership never sees a switcher.
- A user admin API: org_admin creates or invites users and assigns roles and branch scope.
- CSRF protection for cookie-authenticated mutations: an Origin check plus a double-submit token.
- The test utility `asUser(user, org)`, which produces a request context for later milestones.

**Acceptance checks**

1. Once 2FA is enrolled, a privileged role cannot complete a login without it. Enrolment and recovery codes are both tested.
2. Switching org changes the visible rows (RLS) and the effective roles in the request context.
3. A login at an org-scoped route or hostname preselects that org and carries its branding; an unknown host falls back to the generic login.
4. The session cookie is httpOnly, Secure and SameSite=Lax, and is scoped to the parent domain so the console works inside an iframe.
5. Login and OTP rate limits return 429 past the configured threshold, per IP and per identifier.
6. A cookie-authenticated mutation without a valid CSRF token is rejected.

**Out of scope:** the permission matrix, audit and approvals (M02b).

---

## M02b: Permissions, audit and approvals

Phase 0 · Effort MAX · Depends on: M02a · Architecture: §6, §25

**Goal:** cost fields cannot leak, every mutation is recorded, and money-moving actions need a second person.

**Build**

- The CASL matrix in `packages/contracts/src/permissions/`, taken from architecture §6, plus:
  - a NestJS guard and decorators
  - `serializeFor()`
  - the lists `COST_FIELDS` and `RESELLER_VISIBLE_FIELDS`
- Test utilities: `asRole(role, org)` and `assertNoCostFields(json)`.
- A route-coverage gate, `scripts/check-route-matrix.mjs`: it enumerates every registered route and fails if one lacks a declared ability or a matrix test. It joins `pnpm verify`, so coverage is continuous from here instead of being discovered at M30.
- An audit module and interceptor that redacts sensitive fields.
- An approvals module:
  - request and decide APIs
  - a database constraint that the requester ≠ approver
  - per-org thresholds
  - events on request and on decision
- A demo resource carrying cost fields, for the matrix suite to exercise.

**Acceptance checks**

1. A role-matrix suite, generated from the matrix, asserts allowed or forbidden for every role × capability on the demo resource.
2. The demo resource returns cost fields to accounts, and `assertNoCostFields` passes for sales, marketing, warehouse and reseller.
3. Every mutation in the tests writes an audit row, with sensitive fields redacted.
4. A requester approving their own request fails at the database level, not only in the service.
5. Requests below and above an org's threshold behave differently, and both emit their events.
6. `check-route-matrix` fails on a route added without an ability declaration. Demonstrate it, then revert.
7. `/security-review` has been run on the diff, and every high-severity finding is resolved.

---

## M03: Ledger core

Phase 0 · Effort MAX · Depends on: M02b · Architecture: §7, §27

**Goal:** a double-entry ledger that the database itself refuses to corrupt.

**Build**

- `packages/domain/src/money`:
  - the `Poisha` type
  - `add`, `sub`, `sum`, `mulQty`, `percentOf` (basis points, half away from zero)
  - `allocate`
  - parse helpers
- `packages/i18n`: `formatMoney` with ৳ and lakh/crore grouping.
- `ledger` schema:
  - accounts (with subtypes), journals, journal_lines, periods
  - the deferred balance trigger
  - immutability (REVOKE plus trigger)
  - the period-lock trigger
  - the idempotency unique index
- The chart-of-accounts template, seeded per org, with a hand-cash wallet per branch.
- `ledger.post(tx, draft)`, idempotent.
- `reverse(journalId, reason)`.
- Period close, and reopen through approval.
- Queries:
  - account ledger, trial balance, party balance
  - cash book per wallet, day book (by business date)
- `JournalDraft` validation, plus one example posting rule (cash in) to prove the whole pipeline works.

**Acceptance checks**

1. fast-check: random sequences of valid drafts always leave the trial balance at zero, and every journal balances.
2. An unbalanced journal inserted with raw SQL fails at commit.
3. UPDATE and DELETE on journals and lines fail for `erp_app`.
4. Posting into a closed period fails. Reopening goes through approval.
5. Posting the same idempotency key twice returns the same journal and leaves one row.
6. `allocate` parts always sum exactly to the total. The rounding helpers are tested at .5 boundaries.
7. An event at 23:30 UTC on the 1st has a business date of the 2nd (Dhaka).
8. `formatMoney(12345678)` returns `৳1,23,456.78`.
9. `/security-review` has been run on the diff, and every high-severity finding is resolved.

---

## M04: Platform services

Phase 0 · Effort XHIGH · Depends on: M02b · Architecture: §3, §19, §20, §22, §23

**Goal:** the shared plumbing every module reuses: jobs, events, realtime, files, PDFs, i18n and the typed client.

**Build**

- pg-boss:
  - queue registration per module
  - `enqueue(tx, queue, payload, opts)` inside an existing transaction
  - default retry, backoff and dead-letter settings
  - cron in Asia/Dhaka
  - wiring in the worker entrypoint
  - a failed-jobs admin API
- Events:
  - an outbox table and a post-commit dispatcher
  - in-process subscribers
  - a bridge to the realtime gateway
  - event Zod schemas in `packages/contracts/src/events.ts`
- Realtime gateway at `/rt`:
  - cookie authentication
  - server-assigned rooms (§19)
  - the Valkey adapter
  - an emit helper that validates payloads against the event schemas
- Files:
  - a storage driver interface (`local`, `r2`)
  - presigned upload and download endpoints with authorization
  - an image job (sharp variants, EXIF stripped)
- PDF:
  - a Gotenberg client and an HTML template renderer with embedded Bangla fonts
  - a sample invoice template that includes Bangla text
- i18n: bn/en scaffolding, a missing-key checker, and Asia/Dhaka date helpers.
- API layer:
  - OpenAPI generated from the contracts
  - `packages/api-client` generation with a CI drift check
  - problem+json errors
  - Idempotency-Key middleware
  - Valkey rate limiting
- Feature flags: `org.feature_flags` plus a helper (D-031).

**Acceptance checks**

1. A job enqueued inside a transaction that rolls back never runs. After a commit it runs exactly once.
2. A job that keeps failing retries with backoff, lands in the dead-letter queue and emits `job.failed`.
3. Realtime rooms are enforced:
   - a test client receives events for its own org and role only
   - a client from another org receives nothing
   - clients cannot join arbitrary rooms
4. Downloading a private file without permission returns 403. With permission, the endpoint returns a signed URL that has expired by the end of the test.
5. The sample invoice PDF renders, and page 1 is rasterized to `docs/review/M04-bangla-invoice.png` for the human to check Bangla shaping.
6. The api-client regenerates with no diff, and the i18n missing-key check passes.

---

## M05: Console shell and UI kit

Phase 0 · Effort XHIGH · Depends on: M02b, M04 · Architecture: §24

**Goal:** the staff app frame that every module's screens plug into.

**Build**

- Console:
  - Vite + React + TanStack Router (file routes) + TanStack Query
  - login and 2FA screens
  - org switcher
  - navigation driven by CASL
  - layout with sidebar, topbar and command palette
  - bn/en toggle, light/dark theme
- `packages/ui`:
  - shadcn/ui, a Tailwind preset and Bangla font setup
  - DataTable: server pagination, filters kept in the URL, column visibility, export hook
  - form kit (React Hook Form + Zod) with fields for phone, money, date, select and async combobox
  - Money, DateTime, StatusBadge, FileUpload (presigned), EmptyState, ErrorState, PermissionGate, ConfirmDialog
- A realtime client hook, the notifications inbox shell, and an approvals inbox page.
- The design system from architecture §24 realized on the M00 tokens: type scale, density, motion, focus treatment, and designed loading / empty / error / permission-denied states. shadcn components are re-tuned to the tokens, not left at library defaults.
- Per-org theming (D-034): the accent, logo and login branding follow the active org, read from `org.organizations.brand`.
- `scripts/screenshot-review.mjs`, which renders the review screenshot set into `docs/review/M05/`.

**Acceptance checks**

1. Navigation follows role and org (Playwright):
   - a sales user sees Orders and Customers but not Accounts
   - accounts sees Accounts
   - switching org updates the navigation and the data
2. In a DataTable demo, filters persist in the URL across a reload.
3. Every UI string key exists in both bn and en (CI check).
4. The lint check passes: no inline styles and no emoji characters in UI source.
5. The initial route bundle size is reported in the progress entry, against a target of ≤ 250 KB gzipped.
6. Contrast: an automated pass over the token set asserts WCAG AA for every foreground/background pair in both themes, and an axe scan of the shell, login, a DataTable page and a form reports zero serious or critical violations.
7. Keyboard: a Playwright run reaches every primary action on the shell, login and a DataTable page using the keyboard alone, with a visible focus ring at each stop. The command palette opens by shortcut and navigates.
8. Theme parity: a test asserts that no component resolves a colour outside the token set, so light and dark stay in step by construction.
9. Typography: a mixed bn/en string renders on one optical baseline (`size-adjust` applied), and every money value uses tabular numerals.
10. The review screenshot set — shell, login, DataTable, form, empty, error and command palette, in both themes — is written to `docs/review/M05/` for the human to judge by eye.

---

## M06: Catalog

Phase 1 · Effort XHIGH · Depends on: M05 · Architecture: §6, §8, §22

**Goal:** a catalog anyone can search in seconds, with no purchase cost anywhere in it.

**Build**

- `catalog` schema:
  - a category tree
  - attributes and their values (size, colour, custom)
  - products
  - SKUs as a variant matrix
  - barcodes (Code128)
  - a selling price per SKU, with price history
  - images (public files)
- A SKU generator in the domain layer, with a per-org pattern such as `{ORG}-{CAT}-{SEQ4}-{COLOR}-{SIZE}` and uniqueness per org.
- API and console screens:
  - categories and attributes
  - product create/edit with a variant matrix generator
  - bulk price edit
  - image upload and ordering
  - barcode label sheet PDF
  - product list with pg_trgm search and filters
- CSV import in two steps: a dry-run report, then an atomic commit.

**Acceptance checks**

1. A 3-colour × 5-size matrix creates 15 unique SKUs. Adding a size later creates only the new SKUs.
2. SKU search stays under 200 ms p95 on 20k seeded SKUs, measured by `scripts/bench.mjs` so the method matches every other latency check. The sample count and numbers go in the progress entry.
3. No catalog table or endpoint has any cost column, and `assertNoCostFields` passes for every role.
4. The CSV dry-run reports row-level errors, and the commit is all-or-nothing.
5. E2E: a product created with variants and images appears in the list and in search.

---

## M07: Stock ledger, locations and costing

Phase 1 · Effort MAX · Depends on: M03, M06 · Architecture: §5, §7, §8

**Goal:** every unit is traceable and stock can never go negative, even under concurrent orders.

**Build**

- Locations management, including the `damaged` and `in_transit` kinds.
- Movements, levels, reservations and WAC, exactly as in §8. Movements and levels are append-only where specified.
- An internal reservation API for later modules.
- Adjustments with approval, posted through posting rules for write-offs and gains.
- Two-step transfers.
- Count sessions with variance approval.
- A nightly reconciliation job with a drift alert, and the `stock.low` event.
- Stock views:
  - available quantity for all roles
  - cost and stock value only for cost roles

**Acceptance checks**

1. 50 parallel reservations for the last 10 units, run against real Postgres, produce exactly 10 successes.
2. Property test: random sequences of movements never leave `on_hand` negative, and levels always equal Σ movements.
3. The worked WAC example in §8 reproduces to the exact poisha, including the purchase price variance on the supplier return.
4. An adjustment above the threshold creates an approval request. It applies and posts only after approval.
5. Drift injected by the owner role in a test is detected by the reconciliation job, which raises an alert.
6. Sales sees available quantity with no cost or value fields.

---

## M08: Accounts and wallets

Phase 1 · Effort MAX · Depends on: M03, M05 · Architecture: §6, §7

**Goal:** the client's daily cash picture is correct per wallet, per branch and per org.

**Build**

- Wallet setup per org and branch: hand cash, bank, bKash, and optional other mobile wallets.
- Cash in/out entries by category.
- Wallet transfers, with optional bank charges.
- Petty cash with a required receipt photo (private file) and approval above the threshold.
- Payables and receivables by party, with aging buckets.
- Reports: day book, cash book, trial balance, P&L (org and branch), balance sheet.
- Super-admin consolidated wallets and P&L through the analytics role.
- Daily closing:
  - counted cash per wallet
  - variance → approval → cash over/short posting
- Period-close UI.
- Console screens for all of the above.

**Acceptance checks**

1. A scripted day of entries leaves every cash book closing balance equal to its ledger balance, and the trial balance at zero.
2. Petty cash without a receipt is rejected. The receipt is private and needs permission to view.
3. The super-admin consolidated wallet total equals the sum of the orgs' totals (3-org test).
4. A closing variance needs approval and posts to cash over/short.
5. Role-matrix tests:
   - accounts can use everything in this milestone
   - sales gets 403 on every accounts route
   - a branch manager sees only their own branch's wallets
6. E2E: a cash out with a receipt appears in the day book and the P&L.

---

## M09: Suppliers and purchasing

Phase 1 · Effort MAX · Depends on: M07, M08 · Gate: — · Architecture: §7, §8

**Goal:** purchase cost enters the system in exactly one place, and supplier balances tie to the ledger.

**Build**

- Suppliers: profile, contacts, notes, documents.
- Supply entries: a header (supplier, date, location, invoice number, attachment) and lines (SKU, qty, unit cost). One transaction:
  - creates the movements
  - updates WAC
  - posts Dr Inventory / Cr Supplier payable
- Qty-only receipt drafts from warehouse, completed with prices by accounts (D-005).
- Supplier advances and payments, and applying an advance to a supply.
- Supplier returns: stock leaves at WAC, the supplier is credited at the original cost, and the variance is posted.
- Supplier statement and list with due and advance balances.

**Acceptance checks**

1. Fault injection: making the journal step fail leaves no stock, cost or supplier change behind.
2. Supplier statement closing balances equal ledger party balances (scenario test).
3. The supplier return in the §8 example posts the variance correctly.
4. Cost visibility:
   - warehouse and sales never receive unit cost from any endpoint
   - warehouse can create qty-only drafts
5. The scenario advance → supply → apply advance → payment leaves the correct due and advance.
6. E2E: accounts enters a 3-line supply, and stock and supplier due update.

---

## M10: Order core

Phase 1 · Effort MAX · Depends on: M07, M08 · Architecture: §7, §9

**Goal:** orders move through a proven state machine, and every step keeps stock and books in sync.

**Build**

- Customers:
  - phone normalization, including Bangla digits
  - addresses using district/thana reference data
- Delivery zones and charges (D-009 placeholders).
- Orders and lines:
  - per-org order numbering
  - totals computed in the domain layer
- The state machine as an exhaustive table (§9), with guards.
- Order operations:
  - reservation on confirm; hold and cancel
  - assign and claim
  - events to the outbox
- Invoice and packing slip PDFs in Bangla.
- An availability read API for order entry.
- Manual transitions to shipped, delivered, partially delivered and returned (with reason), each making the correct movements and postings. These are the fallback until M12.
- Exchange orders: `delivered → exchange` creates a linked order, returns the original units to stock at their dispatch cost and dispatches the replacement, posting any price difference.

**Acceptance checks**

1. Every (from, to) pair in the transition table is asserted allowed or forbidden.
2. Concurrent confirms on scarce stock never oversell.
3. Property test: COD = items − discount + delivery − advance, and a negative result is rejected.
4. Golden books: supply → 3 orders → ship all → 2 delivered, 1 returned. The trial balance, stock and P&L (revenue, delivery income, COGS, gross profit) all match hand-computed numbers.
5. Partial delivery posts only the delivered lines, and a collection difference posts to Sales discounts.
6. 10 phone formats normalize correctly, including `+8801…`, `01…`, spaced and dashed forms and Bangla digits. Invalid numbers are rejected.
7. Exchange: a delivered order exchanged for a different SKU returns the original units at dispatch cost, dispatches the replacement, posts the price difference and leaves the trial balance at zero.

---

## M11: Order desk UI, buyer list, public order intake

Phase 1 · Effort XHIGH · Depends on: M10 · Architecture: §9, §19, §23, §24

**Goal:** an agent can take an order from a Facebook or WhatsApp chat in under 30 seconds, and landing pages can post orders safely.

**Build**

- Order desk, keyboard-first:
  - phone → customer and history
  - address autocomplete
  - SKU search with live availability
  - automatic zone and charge
  - totals; save as pending or confirm
  - shortcuts help overlay
- Queue of unassigned orders, with claim.
- Order list with filters: status, channel, date, agent, zone.
- Order detail with a timeline (status history plus audit).
- Bulk confirm and bulk print of invoices and labels.
- Duplicate warning for the same phone and SKU within 24 hours.
- A fraud badge slot in the order desk, rendering an "unavailable" state until M13 fills it, so M13 adds a provider rather than reworking the desk.
- Buyer list filtered by product, SKU, size, date and channel, exported as CSV or XLSX.
- Public intake API (§23):
  - site API keys, HMAC, Turnstile, rate limits, idempotency
  - an integration doc for landing-page developers in `docs/public-api.md`
- Realtime updates in the queue and lists.

**Acceptance checks**

1. E2E, keyboard only: phone to confirmed order. The scripted run reports its time as a server-plus-render latency budget and stays under 30 s. It measures the app, not an operator, so a human-timed run happens at the pilot and its number goes in the progress log.
2. Buyer list export counts match a direct SQL count for the same filters.
3. Public API behaviour:
   - a signed request creates a pending `landing_page` order with UTMs
   - a bad signature returns 401
   - a replayed idempotency key returns the same order
   - exceeding the limit returns 429
4. A new order appears in a second sales session's queue without a refresh (two browser contexts).
5. Sales sees only their own orders plus the unassigned queue (matrix test).

---

## M12: Courier v1 and COD reconciliation

Phase 1 · Effort MAX · Depends on: M11 · Gate: G1 · Architecture: §7, §9, §20, §21

**Goal:** cash held by the courier is tracked from booking through settlement into the right wallet.

**Build**

- Courier accounts per org, with encrypted credentials.
- The `CourierAdapter` interface, a fake adapter, and the primary courier's adapter (D-006), built from the courier's official docs.
- A booking job (on_confirm or on_pack) with retries, a dead-letter queue and the `delivery.booking_failed` alert.
- Status sync by webhook if the courier supports it, otherwise polling, with a normalized mapping table.
- Tracking timeline on the order detail.
- Handover confirmation.
- A returns receiving screen with inspection (sellable or damaged) and the postings.
- Settlement file import for the primary courier:
  - matching
  - exceptions report
  - approval
  - postings for charges and the net amount to the wallet
  - business dates per D-037: a settlement posts on its own date, and if that period is closed it posts to the earliest open period while keeping the original date as a reference field
- Courier receivable aging and the COD reconciliation report.

**Acceptance checks**

1. Adapter contract tests pass against recorded fixtures. A live sandbox smoke test runs if credentials exist; otherwise it is skipped and noted in the report.
2. Every provider status is covered by a mapping test.
3. Duplicate webhooks or polls never double-transition or double-post.
4. Importing a sample settlement file gives matched totals equal to the file totals and lists every mismatch. Posting happens only after approval. A settlement dated inside a closed period posts to the earliest open period and keeps its original date (D-037).
5. E2E scenario: book → deliver → settle leaves that consignment's courier receivable at zero, and the P&L shows the courier charges.
6. A booking that fails after all retries raises `delivery.booking_failed` and flags the order.

---

## M13: Fraud check v1

**Removed from scope by the owner on 2026-10-02 (D-291). The code built for it was deleted on branch `remove-fraud`. Do not build.**

Phase 1 · Effort XHIGH · Depends on: M10 · Gate: G2 · Architecture: §5, §10

**Goal:** an agent sees how trustworthy a phone number is, across all five brands, before confirming.

**Build**

- Phone hashing with HMAC.
- Cross-org `phone_signals`, maintained from order events.
- The `FraudSignalProvider` interface and a Steadfast provider (wrapping `fraudjs` if the user provides it, D-010), with a TTL cache and throttling.
- The trust score function and per-org rule bands (D-011).
- The badge and its reasons in the order desk.
- A confirm guard: a block needs an org_admin override with a reason, which is audited.
- The `order.fraud_flagged` event.

**Acceptance checks**

1. Table-driven score tests: a new customer, 10/10 delivered, 3/5 returned, a provider-only result, a manual flag.
2. Returns in org A lower the trust score in org B, and org B sees counts only: no org A order data (API test).
3. When the provider times out, the badge falls back to an internal-only score marked "provider unavailable", and the order desk keeps working.
4. A cached lookup stays under 300 ms p95, measured by `scripts/bench.mjs` with its sample count recorded.
5. A block override needs org_admin and records the reason in the audit log.

---

## M14a: Data migration and opening balances

Phase 1 · Effort MAX · Depends on: M06–M12 · Gate: G3 · Architecture: §7, §8, §25

**Goal:** the pilot brand starts with books and stock its accountant will sign.

**Build**

- Importers, each with a dry run and an atomic commit:
  - SKUs
  - opening stock per location with unit cost
  - supplier dues and advances
  - wallet balances
  - courier COD still in transit
  - customers, with their historical order outcomes
- An opening-balance journal dated the evening before go-live.
- A reconciliation report for the accountant to sign off.
- A demo org for training, seeded from anonymized data.

**Acceptance checks**

1. A dry-run import of the sample data shows a balanced opening trial balance, and stock value = Σ(qty × cost).
2. A bad row anywhere in an importer leaves no partial state: the commit is all-or-nothing.
3. Re-running an importer with the same file is idempotent and creates no duplicates.
4. The opening-balance journal's trial balance is zero, and its inventory total equals the inventory module's stock valuation to the poisha.
5. The reconciliation report is generated and reviewed. **Human:** the client's accountant signs it off before go-live.

---

## M14b: Deployment, observability, go-live kit

Phase 1 · Effort XHIGH · Depends on: M14a · Gate: G3 · Architecture: §25, §26, §28

**Goal:** Phase 1 can run in production, and there is a way back that someone has actually walked.

**Build**

- Deployment:
  - production Dockerfiles
  - Kamal config for api, worker, Valkey and Gotenberg
  - Cloudflare Pages config for the SPAs
  - separate database roles on managed Postgres
  - migrations run as a release step
- Observability: Sentry, OpenTelemetry, pino redaction, health checks, uptime checks.
- Backup and restore runbook, with a drill executed on staging.
- Runbooks in `docs/runbooks/`.

**Acceptance checks**

1. The staging deploy has green health endpoints. The human confirms the URL.
2. The restore drill has been executed on staging and documented with timings.
3. A rollback to the previous release has been executed on staging and documented.
4. `/security-review` has been run with no open high-severity findings.
5. The runbooks exist: deploy, rollback, restore, secret rotation, courier outage, month-end close.

**After M14b (human):** pilot one brand for 2–3 weeks. Log issues as follow-ups and run fix sessions before moving on.

---

## M15: Multi-courier, webhooks, tracking (Track A)

Phase 2 · Effort XHIGH · Depends on: M12 · Gate: G5 · Architecture: §9, §21

**Build**

- Adapters for the remaining couriers (D-006).
- Zone → courier rules.
- Bulk booking and label printing.
- A public tracking page in the portal app: order number plus the last 4 digits of the phone.
- Automatic settlement fetch where the courier's API supports it.
- Courier performance report: delivery rate, average days and return rate, by zone.
- A stuck-parcel queue: active consignments with no status change in N days, with bulk re-poll, an escalation note and a courier-ready export. This is where COD cash actually goes missing.

**Acceptance checks**

1. Contract tests and complete mapping tables for each adapter.
2. Courier selection rule tests.
3. The tracking page leaks nothing without the correct phone digits.
4. Settlement fetch is idempotent.
5. Seeded consignments past the staleness threshold appear in the stuck-parcel queue, and fresh ones do not.

---

## M16: Buyer profiles, notifications, basic promo codes (Track A)

Phase 2 · Effort XHIGH · Depends on: M11 · Gate: G5 · Architecture: §10

**Build**

- Buyer stats and a profile page.
- The RFM job.
- Birthday and anniversary capture, and the daily occasions job.
- The `notify` module:
  - a real SMS adapter plus a fake
  - bn/en templates
  - opt-outs, quiet hours, delivery log
- Minimal promo codes: percent, flat and free delivery, with limits, validity and personal codes. Validated in the domain layer and applied in the order desk.
- A re-engagement list builder with export.

**Acceptance checks**

1. RFM segment tests.
2. The occasions job is idempotent: one code and one message per customer per occasion per year.
3. Table-driven promo validation tests: expired, limit reached, minimum order not met, wrong channel.
4. Quiet hours are respected.
5. E2E: a promo code applied in the order desk.

---

## M17: Advance payments and return reasons (Track A)

Phase 2 · Effort XHIGH · Depends on: M16 · Architecture: §7, §10

The fraud half of this milestone (more providers, address signals, the rule engine and
`require_advance`) was removed with the fraud check (D-291). What remains is accounting.

**Build**

- Advance recording: the agent captures the bKash transaction id and accounts verifies it (a gateway is optional, D-013).
- The advance posts to customer advance and is applied on delivery.
- Return-reason capture and analytics.

**Acceptance checks**

1. Advance scenario (golden books): the advance is applied on delivery and refunded on cancel, per policy.
2. An unverified advance never reaches the books.
3. Return reasons are captured on every return and reported by reason.

---

## M18: Marketing (Track B)

Phase 3 · Effort XHIGH · Depends on: M11 · Gate: G6 · Architecture: §11

**Build**

- Campaigns and manual spend entry.
- A Meta spend import job, with a token per org.
- Attribution resolution (priority order in §11).
- A marketing dashboard using the exact metric definitions: CPO, CPDO, delivered ROAS, return rate.
- Leads, with segment reports by product, size, age band and profession.
- The CAPI delivered-purchase sender.
- Hashed custom-audience export.

**Acceptance checks**

1. The metric functions reproduce hand-computed values on a fixture dataset.
2. Spend import is idempotent per (campaign, date).
3. A snapshot test of the CAPI payload shows no plaintext PII and a stable event_id.
4. Attribution priority tests.

---

## M19: HR core, attendance, payroll (Track B)

Phase 3 · Effort MAX · Depends on: M08 · Gate: G7 · Architecture: §7, §12

**Build**

- Employees, with encrypted fields.
- Attendance: manual entry plus CSV import mapping.
- A working-day calendar.
- Salary structures (D-029).
- The payroll run: draft → approve → post → pay, with loan deductions and bonus inputs.
- Payslip PDF in Bangla.
- Employee loans and their schedules.
- All postings.

**Acceptance checks**

1. Scenario: 3 employees, 1 loan and some absences produce exact net pay and journals.
2. A payroll run cannot be posted twice.
3. Encrypted fields are unreadable in a raw database query.
4. HR and accounts permissions follow the matrix.

---

## M20: Targets, bonus rules, productivity (Track B)

Phase 3 · Effort XHIGH · Depends on: M19, M11 · Architecture: §12, §19

**Build**

- Targets.
- The weekly split, weighted by working days using largest remainder.
- A progress rollup and the `target.progress` event.
- The bonus rule DSL: evaluator, preview and approval, feeding payroll.
- Productivity metrics from events: pickup time and orders per active hour.
- An agent dashboard and HR reports.

**Acceptance checks**

1. Property test: the weekly split sums exactly for random months and targets.
2. Table-driven bonus evaluator tests.
3. Pickup time is correct on seeded event streams, including reassignment.
4. An agent sees only their own stats.

---

## M21: Reseller engine

Phase 4 · Effort MAX · Depends on: M10, M12 · Gate: G8 · Architecture: §7, §13

**Build**

- Reseller accounts and onboarding approval.
- Margin rules resolved by specificity.
- Charge slabs.
- The reseller order service: validation, fraud check, reservation from the Beownz location.
- A white-label invoice PDF.
- The earnings lifecycle with postings: accrue, make available, reverse, return fee (D-015–D-018).
- Payout requests, approval and batches.
- Beownz admin screens.
- The performance report.

**Acceptance checks**

1. Pricing resolution tests: specificity order, and rounding for percent vs fixed margins.
2. Property test: income = Σ(selling − reseller price) − slab − policy charges.
3. Scenario: a delivered, a returned and a partially delivered reseller order leave the reseller balance equal to the ledger's reseller payable.
4. A reseller can never see cost or another reseller's data (API tests).

---

## M22: Partner portal (reseller)

Phase 4 · Effort XHIGH · Depends on: M21, M16 · Architecture: §13, §19, §24

**Build**

- The `portal` PWA:
  - phone OTP login, using the real SMS adapter
  - catalog with reseller-visible fields only and live availability
  - mobile-first order entry
  - orders and tracking
  - earnings and payout requests
  - performance
- Installable, with web push.

**Acceptance checks**

1. Mobile-viewport E2E: log in → place an order → receive the pushed status update.
2. A Playwright network assertion shows no cost or foreign fields in any response.
3. The PWA meets installability criteria: an audit confirms the manifest, icons, start URL, display mode and a registered service worker, with the tool and version recorded.

---

## M23: Branches and showroom POS

Phase 4 · Effort MAX · Depends on: M08, M10 · Architecture: §7, §14

**Build**

- Branch dashboards (D-014).
- The `pos` PWA:
  - shifts
  - barcode scanning and cart
  - permission-bound discounts and promo codes
  - split payment
  - 80 mm receipts
  - returns and exchanges
- An offline queue with idempotent sync and conflict review.
- POS postings.
- Branch daily closing.

**Acceptance checks**

1. Offline E2E:
   - three sales made offline sync exactly once after reconnecting
   - stock and wallets are correct afterwards
2. Re-sync attempts never double-post.
3. A stock shortfall at sync creates a review item.
4. A receipt prints through the print CSS.

---

## M24: Analytics, dashboards, leaderboard

Phase 4 · Effort XHIGH · Depends on: M12, M18, M20, M23 · Architecture: §18, §19

**Build**

- Rollups and their jobs.
- The org admin dashboard and the super-admin consolidated dashboard.
- The leaderboard: normalized metrics, a composite score with configurable weights, visibility per D-023.
- Insight rules.
- An optional LLM narrative behind a feature flag.
- Exports.

**Acceptance checks**

1. Rollups equal direct queries on seeded data.
2. Leaderboard visibility follows D-023.
3. Unit tests for the insight rules.
4. A test proves the LLM payload contains no PII.

---

## M25: Investors

Phase 5 · Effort MAX · Depends on: M08 · Gate: G9 · Architecture: §7, §15

**Build**

- Investors, investments per org, documents.
- Distributions (D-019).
- Withdrawals with maker-checker.
- Postings.
- Investor pages in the portal, with 2FA mandatory.
- Statements.

**Acceptance checks**

1. An investor sees only their own data (API and E2E).
2. The withdrawal flow posts correctly through approval.
3. Documents are available only through signed URLs.

---

## M26: Company loans

Phase 5 · Effort XHIGH · Depends on: M08, M16 · Architecture: §7, §15

**Build**

- Loans.
- Flat and reducing-balance schedules.
- The reminders job.
- Payment postings split into principal and interest.
- Statements.

**Acceptance checks**

1. Property test: Σ principal = the loan amount.
2. A reducing-balance example matches a hand-computed table.
3. Each reminder fires once per instalment.
4. Postings are correct.

---

## M27: Message Hub (Chatwoot)

**Removed from scope by the owner on 2026-10-02 (D-290). Do not build.**

Phase 5 · Effort XHIGH · Depends on: M11, M13, M16 · Gate: G10 · Architecture: §16

**Build**

- Chatwoot compose file, and a runbook for per-org inbox setup.
- The ERP side panel at `/embed/chatwoot`: customer profile and history, fraud badge, recent orders, prefilled create-order form.
- A webhook receiver that links conversations to customers and computes response-time stats.
- Conversation ids stored on orders created from the panel.
- Build against Chatwoot's current docs.

**Acceptance checks**

1. Inside the Chatwoot iframe on the same parent domain, the panel loads with the ERP session and creates an order linked to the conversation.
2. Webhook verification and idempotency tests.
3. Response-time metrics match a fixture.

---

## M28: Agent activity extension

**Removed from scope by the owner on 2026-10-02 (D-292). Do not build.**

Phase 5 · Effort XHIGH · Depends on: M20 · Gate: G11 · Architecture: §16

**Build**

- The WXT extension:
  - enrolment with a one-time code
  - domain-only heartbeats with idle/active state and focus
  - batching and an offline buffer
- API endpoints.
- A per-role allowlist.
- Daily reports.
- A guide for force-installing through Chrome policy.

**Acceptance checks**

1. Domain extraction strips paths and queries (unit tests).
2. Unenrolled devices are rejected.
3. Reports match seeded heartbeats.
4. A database assertion proves no URL paths are stored.

---

## M29: Landing page builder and promotions

**Removed from scope by the owner on 2026-10-02 (D-290). Do not build.**

Phase 5 · Effort XHIGH · Depends on: M11, M16 · Gate: G12 · Architecture: §17, §10

**Build**

- `packages/landing-blocks`.
- The Puck editor in the console, with preview.
- Page versions and publishing.
- The `sites` app: multi-domain rendering with ISR and on-demand revalidation.
- The order form, posting to the intake API with Turnstile.
- Pixel and CAPI deduplication.
- The full promo engine: campaign offers and auto-apply.
- Landing analytics.

**Acceptance checks**

1. E2E:
   - build a page in the editor and publish it
   - the page is served on a test domain
   - an order submitted from it appears with the `landing_page` channel and its campaign
2. Drafts are never publicly accessible.
3. A sample page scores Lighthouse mobile performance ≥ 90, with the Lighthouse version and throttling preset pinned in the script and recorded in the report.

---

## M30: Hardening and launch readiness

Launch · Effort MAX · Depends on: all · Architecture: §25–§29

**Build**

- `/security-review`, plus `/code-review` on high-risk modules, with fixes.
- k6 load tests for the order desk APIs and public intake.
- A confirmation run of the `check-route-matrix` gate from M02b, plus a report listing every route with its ability and test.
- A production-like restore drill.
- Alert rules and retention policies.
- An accessibility pass.
- Training guides and a go-live checklist.

**Acceptance checks**

1. The §29 targets are met, or each gap is documented with a plan.
2. No open high-severity findings.
3. The `check-route-matrix` gate, in `pnpm verify` since M02b, is green, and the route report is attached.
4. The restore drill's timing is documented.
5. The go-live checklist is signed off by the human.

---

# Wave 3: one ERP per brand, the mother ERP, the website (D-469)

Added on 2026-10-05 from the owner's instruction (D-469). Overview in `docs/plans/wave3.md`;
each milestone's plan in `docs/plans/M31.md` to `M37.md` holds the detail.

## M31: One ERP per brand (brand edition)

Phase 6 · Effort MAX · Depends on: M30 part 1 · Architecture: §30

**Build**

- A deployment names its brand (`ERP_BRAND_SLUG`) and refuses to start beside another real brand; `db:seed --brand`.
- The all-brands routes and screens leave the brand ERP (consolidated wallets and P&L, group dashboard, leaderboard).
- White label: nothing a brand's staff, shoppers or website developer can see names Elysium (unless the brand is Elysium) or another brand.
- Owner sign-in link: a short-lived Ed25519-signed assertion, checked with a public key in the brand's env, single use.
- `infra/brand/`: one compose project per brand with its own Postgres.

**Acceptance checks**

1. A brand deployment beside a second real brand refuses to start.
2. The cross-brand routes answer 404 and have no screens.
3. A brand build of the console, till and portal contains no `elysium` and no other brand's name.
4. A valid owner link signs in once; expired, replayed, wrong-audience, wrong-key or tampered links are refused alike; owners are not listed as staff.
5. `pnpm verify` green; ledger-auditor on the tenancy and auth diff.

## M32: The mother ERP

Phase 6 · Effort MAX · Depends on: M31 · Architecture: §30

**Build**

- `apps/mother-server` and `apps/mother-console`, with their own database, sign-in (TOTP for everyone) and owners.
- Brand registry with encrypted read-only connections and owner-link keys; a worker pulls each brand's rollups and snapshots.
- Overview, leaderboard, brand pages with live lists, accounts across brands, "Open brand ERP".
- `infra/mother/`.

**Acceptance checks**

1. Overview totals equal the sum of each brand's own dashboard for the same range.
2. "Open brand ERP" signs the owner in, once.
3. The mother's read role cannot write to a brand database.
4. An unreachable brand shows its last figures with their age; the others still load.
5. No brand process or page calls the mother.
6. `pnpm verify` green; ledger-auditor on the consolidated money reads.

## M33: Website catalog and content from the ERP

Phase 6 · Effort XHIGH · Depends on: M31 · Architecture: §31

**Build**

- Web fields on products and categories, size charts, website settings, hero slides, menu, old-id map.
- The signed, server-to-server storefront read API; public images.
- The console's Website section and the product page's Website card.

**Acceptance checks**

1. Hidden products never reach the storefront; shown ones carry live available quantity at the web locations only.
2. An old slug redirects.
3. Bad signatures, stale timestamps and revoked keys are 401; no storefront response carries a cost field.
4. Settings, hero, menu and size charts round-trip through the console (stack spec, screenshots).
5. `pnpm verify` green; ledger-auditor on the tenancy diff.

## M34: Website buying: checkout, accounts, payment

Phase 6 · Effort MAX · Depends on: M33 · Architecture: §31

**Build**

- Cart quote and checkout priced by the ERP; stock held at placement; shopper order view.
- Website customer accounts (email code, Google link, password reset), linked to buyers.
- SSLCommerz with server validation and IPN, posted as a verified advance; SMTP emails.

**Acceptance checks**

1. A quote and its order agree to the poisha; a price change in between is `409 CART_REPRICED`.
2. Racing for the last unit: one order, one `409 OUT_OF_STOCK`, stock never negative.
3. A payment whose validated amount differs from the order is refused; a correct one posts and lowers the COD amount.
4. Account flows work end to end; codes and tokens are stored hashed.
5. `pnpm verify` green; ledger-auditor on the money and stock diff.

## M35: Website offers, tracking, ncom

Phase 6 · Effort MAX · Depends on: M33, M34 · Architecture: §31

Built in two parts (plan `docs/plans/M35.md`): M35a, flash sales and discounts (checks 1, 2
and 6 for them); M35b, the rest.

**Build**

- Flash sales, the old site's discount engine in integer poisha, campaign links. (Landing pages: none; they are ncom.bd's, D-550.)
- Meta pixel/CAPI and GA4 settings and server events; the ncom.bd connector; the packing scanner routes and Scan page; order labels.

**Acceptance checks**

1. A 5-unit flash sale sells exactly 5 under 20 concurrent checkouts; a cancel gives the unit back.
2. The ported discount engine matches the old one on recorded carts.
3. Withdrawn: the owner dropped the landing pages (D-550).
4. The old site's `ncom-check.mjs` passes against the ERP.
5. Scanner sign-in and lookup work; a revoked token is refused.
6. `pnpm verify` green; ledger-auditor on pricing, stock and promo.

## M36: The new Elysium website on the ERP

Phase 6 · Effort MAX · Depends on: M34, M35 · Amended on 2026-10-05 (D-561: start fresh; D-550: no landing pages)

**Build**

- The website (`D:\Projects\elysium`, branch `erp-storefront`) reads and writes only through the brand ERP's signed storefront API; its admin panel, database, demo kit and landing pages go; `/admin` redirects to the ERP.
- Nothing old is imported except, optionally, the customers (M34's `pnpm migration legacy-customers`).
- A deploy kit for `demo.elysium-lifestyle.bd` on the brands server.

**Acceptance checks**

1. A Playwright pass of the shopper journeys against a brand ERP: browse, search, product, cart, checkout (COD), sign up with the emailed code, sign in, reset password, account orders, an old address redirecting, `/admin` going to the ERP.
2. No database connection and no admin route left in the website (a check in its CI).
3. The website builds and lints; the ERP's `pnpm verify` stays green.

## M37: Go live: brand servers, mother, switch-over

Phase 6 · Effort XHIGH · Depends on: M31–M36 · Gate: owner's servers, domains, credentials, switch-over date

**Build**

- The brands server and the mother server installed; the Elysium switch-over runbook rehearsed, then run with the owner.

**Acceptance checks**

1. Each brand deployment passes its health checks and the bundle scan.
2. The mother shows Elysium's figures and opens its ERP.
3. The switch-over is rehearsed on staging with timings.

## M38: Barcode stickers, strict stock, scan-to-pack and packing video

Phase 6 · Effort MAX · Depends on: M33, catalog-stock-ux · Decisions D-600 to D-619

**Build**

- M38a: the complete new-product form; stock in hand at a cost per piece while the opening stock window is open; an EAN-13 for every SKU; stickers for thermal rolls (38 × 25, 40 × 30, 50 × 25 mm) and A4 sheets; the scanner anywhere in the console and on stock screens.
- M38b: the packing station (scan each piece against the order), the packing video kept until seven days after delivery.

**Acceptance checks**

1. Stock in hand posts one balanced journal per entry and offers one sticker per piece.
2. Every SKU has a valid, unique EAN-13; scanning it opens the variant.
3. Sticker PDFs have the exact page size per medium.
4. Stock in hand is refused once the window is closed.
5. A wrong or extra scan at packing is refused; a complete order becomes packed.
6. The packing video is deleted seven days after delivery.
7. `pnpm verify` green; ledger-auditor on the posting, the window and the packing transition.

## M39: Catalog management the way a fashion brand works

Phase 6 · Effort MAX · Depends on: M38a, M34 · Decisions D-620 to D-649

**Build**

- M39a: delete when unused, archive when used, everywhere a brand keeps a list; "empty and delete" for categories and size charts; a reference port so the catalog asks other modules.
- M39b: prices by size or colour and in bulk; buying price per variant on every receipt; a standard buying price in supply; regular (compare-at) price; duplicate product; product list row and bulk actions; per-colour photos; variant barcode, weight, default size chart.

**Acceptance checks**

1. Unused rows delete; used rows archive with the reason; nothing referenced by stock, orders, POS, supply or journals can be deleted.
2. A category in use is emptied into another and deleted in one transaction.
3. Prices by size in one step; a bulk +10% previewed and saved, with history.
4. Per-variant buying prices on a receipt give the right WAC; cost and margin only for read:cost.
5. A standard buying price pre-fills the next receipt and never appears in a catalog response.
6. Duplicate product copies variants and prices, not stock.
7. The website shows regular-price and flash-sale strike-throughs; "On sale" works.
8. `pnpm verify` green; ledger-auditor; stack specs with screenshots; acceptance-auditor.

## M41: Order workflow, ownership and auto-assignment

Phase 7 · Effort MAX · Depends on: M16, M38b · Decisions D-710 to D-729

The owner's brief of 2026-10-11. The sales desk (orders, customers, messages) and the fulfilment hub (slips, packing, labels, courier handover) work about 2 km apart, so an order moves from one team to the other once it is confirmed. One person handles each order at a time.

**Build**

- Two desks: the sales desk (each person's work types: orders, messages or both) and the fulfilment hub (at its stock location). Stage queues: New, Verifying, Confirmed, then at the hub To print, Packing, Packed, Handed to courier.
- Ownership: the first person to open an unassigned order takes it. Everyone else sees who has it. Every action they try asks them to acknowledge the owner first; the server refuses it without that, audits it with it, and tells the owner. The owner can release or hand over the order, and a supervisor can reassign it.
- Verification calls: each call attempt logged (reached, no answer, busy, wrong number, call back at a time), with the attempt count and the call-back time shown in the queue.
- Presence: the console reports whether each person is active, idle or away in the ERP (only the ERP tab, never other websites).
- Auto-assign (a brand setting): a new order is offered to the active person with the fewest open orders. They accept or decline within a countdown; on a decline or a timeout it goes to the next person; with nobody active it waits in the queue.
- Team board for supervisors: who is active, idle or away, their open orders, today's confirmed orders, outstanding offers, and reassignment.
- Hub handoff: confirmed orders appear in the hub's queue at its location; bulk slip printing; the packing station; handover to the courier.

**Acceptance checks**

1. Two people taking the same new order at once: exactly one succeeds, and the other sees who has it.
2. A non-owner's action without the acknowledgement is refused; with it, it succeeds, is audited and the owner is told in real time.
3. Auto-assign offers to the least-loaded active person and never to an idle or away one; a decline or an expiry moves the offer on; an accept is atomic.
4. Call attempts are recorded and shown, and call-back times order the queue.
5. The hub sees confirmed orders at its location, and the sales desk sees the hub's progress.
6. `pnpm verify` green; ledger-auditor (permissions, tenancy); a stack spec with screenshots; acceptance-auditor.

## M42: Unified inbox and customer panel

Phase 7 · Effort MAX · Depends on: M41 (for auto-offer), M16 · Decisions D-730 to D-749

**Build**

- Facebook Messenger, Instagram and WhatsApp through Meta's official APIs: one signed webhook in, replies sent by a job after commit, and the 24-hour messaging window respected. Channel credentials are entered in Settings and sealed. The adapters stay marked unverified until real credentials are tested.
- One inbox for every channel, filtered by mine, unassigned, channel, stage and unread. Conversations are assigned like orders: take it, ownership warnings, and (after M41) auto-offer to people whose work types include messages.
- Contact stages: Visitor, Lead, Customer (automatic once they have ordered), Not qualified, Fraud.
- Right panel: phones and addresses found in the messages, saved in one click; the matched customer with every order, delivery and return record and spend; dated notes with who wrote them; the products they are interested in (live price, sizes in stock, photo); tags; an order created from the chat, prefilled.

**Acceptance checks**

1. A signed webhook for each channel opens or threads a conversation; a bad signature is refused; a repeated delivery is ignored.
2. A reply is sent by a job after commit; free text outside the 24-hour window is refused with the reason.
3. A phone number in a message matches an existing customer and shows their orders; the contact becomes Customer when an order is placed from the chat.
4. Notes and product interests are saved and shown with live catalog data.
5. RLS on every new table; `pnpm verify` green; ledger-auditor (tenancy, permissions); a stack spec with screenshots; acceptance-auditor.

## M43: Premium order documents, English only

Phase 7 · Effort HIGH · Depends on: M38b · Decisions D-750 to D-759

The owner's decision of 2026-10-11: the brands never wanted Bangla. Everything, invoices above all, is in formal English with a clean, premium design.

**Build**

- A redesigned order slip, invoice and parcel label: order number, cash to collect, and the customer's name, phone and address large and bold; the order barcode; the courier and consignment; a clean items table and totals; the brand's name.
- English everywhere: documents, SMS, emails, till receipts, website account messages and district names. The console's language switch and the Bangla locale are removed.

**Acceptance checks**

1. Slip PDFs show the order number, cash to collect, name, phone and address in large bold type; the barcode scans at the packing station; page sizes are exact.
2. No Bangla characters (U+0980 to U+09FF) in any rendered document, SMS or email.
3. The console has no language switch, and the i18n check passes with English only.
4. `pnpm verify` green; screenshots of each document; acceptance-auditor.
