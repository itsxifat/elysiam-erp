# Elysium Mother ERP: Architecture and Engineering Spec

This file is the source of truth for how the system is built. Read the sections your milestone cites; you don't need the whole file every session.

When sources conflict, this is the order of precedence:

1. A RESOLVED row in `docs/decisions.md`
2. This file
3. The client's original spec in `docs/client-spec/`
4. Your own assumptions

When you assume something, add a row to `docs/decisions.md`.

## Contents

1. Product scope (client spec in English)
2. Glossary
3. System architecture
4. Repository layout
5. Multi-org tenancy and data access
6. Identity, roles and permissions
7. Money and the ledger
8. Inventory and costing
9. Orders, delivery and couriers
10. Customers, fraud, notifications and promotions
11. Marketing
12. HR, payroll, targets and productivity
13. Reseller engine (Beownz)
14. Branches and showroom POS
15. Investors and company loans
16. Message Hub and agent activity
17. Landing pages
18. Analytics and leaderboard
19. Realtime event catalog
20. Background jobs
21. Integrations
22. Files and documents
23. API conventions
24. Frontend conventions
25. Security
26. Observability and operations
27. Testing strategy
28. Environments and deployment
29. Performance targets

---

## 1. Product scope (client spec in English)

The client runs five fashion brands in Bangladesh, called sister orgs: Elysium Lifestyle BD, Oura Lifestyle, Orvo, Wear X Clothing and Beownz. They want one "mother ERP" that runs three things together:

- full e-commerce operations (mostly COD orders from Facebook, WhatsApp and landing pages)
- showroom accounting
- a reseller platform for Beownz

Each sister org operates as its own unit.

The client's release approach puts every module in the development scope but releases them in phases, so Phase 1 can run live while later phases are developed in parallel.

### Role matrix (client)

| Role             | Access                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| Super Admin      | Every module in every org; full overview                                  |
| Sales            | Own orders, own performance, targets, to-dos                              |
| Accounts         | All accounts, wallets, payments, tasks                                    |
| Marketing        | Own campaign performance, leads, to-dos                                   |
| HR               | Employees, salary, attendance, loans, targets                             |
| Branch Manager   | Own showroom's income, expenses and performance                           |
| Sister Org Admin | Own org's full dashboard, plus a leaderboard comparing it with other orgs |
| Reseller         | Products and stock quantity only; enters own orders                       |
| Investor         | Own investment, profit share, documents                                   |

We add a `warehouse` role for packing, dispatch, returns receiving and stock counts (decision D-004).

### Modules by client phase

**Phase 1: Core operations (MVP)**

1. Products / Catalog
   - Add a product with name, description, selling price and images. The purchase price is **not** entered here.
   - Manage categories and attributes (size, colour, variants).
   - Generate SKUs automatically.
2. Supplier
   - Supply entries record product, quantity and unit purchase price. This is the **only** place purchase price enters the system, and it updates stock automatically.
   - Supplier profile with contacts and history.
   - Supplier accounts track payments, dues and advances.
   - Supplier returns, with the account adjusted to match.
3. Sales / Order
   - Create orders tagged by channel (Landing Page, Facebook, WhatsApp).
   - Status pipeline: Pending → Confirmed → Shipped → Delivered / Returned / Cancelled.
   - Buyer list that can be filtered and exported by product and size.
4. Accounts
   - Daily cash in/out.
   - Wallets for bKash, bank and hand cash, kept separately per showroom and per org, with a consolidated view.
   - Petty cash, with a photo of the invoice uploaded.
   - Payables and receivables.

The client notes that these four modules are the data foundation for everything else. Correct tracking of inventory movement, order flow and cash flow matters most.

**Phase 2: Buyer intelligence and delivery** 5. Delivery

- A confirmed order is entered with the courier automatically.
- Status updates automatically when payment is received (via courier API or webhook where possible).
- Stock updates automatically when a return is received.
- Live tracking view.

6. Buyer profile
   - Purchase history: what, when, how much, how often.
   - Automatic birthday and anniversary reminders that trigger discount offers.
   - Re-engagement suggestions: buyers who haven't purchased within a set time.
7. Fraud check
   - Return and cancel history by phone number and address.
   - Later: integration with the couriers' shared blacklist database.

**Phase 3: Marketing and HR** 8. Marketing

- Record ad cost per campaign.
- Analytics: cost vs sales vs order count, cost per order, ROAS.
- Leads: segment reports by product, size, age and profession.

9. HR
   - Employees, salary, employees' personal loans, attendance.
   - Targets: a monthly target splits automatically into weekly targets; bonus rules can be configured.
   - Productivity: order pickup time (from notification to action) and orders handled per hour or minute.

**Phase 4: Scale** 10. Beownz reseller engine - Resellers see only products and stock quantity. - Pricing: reseller price = product price + wholesale margin, calculated automatically. - Charge slab per order by number of pieces (1, 2, 3). - Resellers enter their own orders, and the invoice is issued in the reseller's own name. - Payout: selling price − reseller price − charge = reseller income, calculated automatically. - Reseller performance report: pieces and taka ordered by each reseller. 11. Branch / showroom - Each showroom is a separate unit with its own income and expenses, stock and staff performance. 12. Sister-org multi-login - Each org (Oura, Orvo, Wear X, …) has its own login and performance dashboard. - Cross-org leaderboard showing who is ahead, with suggestions for how to improve.

**Phase 5: Investors, loans, communication and growth** 13. Investors - Investment records and uploaded legal documents. - Profit-share payment history. - Withdrawal requests and their processing. 14. Company loans - Personal and bank loans, instalment schedules, payment reminders. 15. Message Hub - Unified inbox for Facebook, WhatsApp, Instagram, Telegram, TikTok and Google. - Agent activity tracking: time spent on the assigned platform, with visits to other sites logged in reports. 16. Promotion and landing page builder - Drag-and-drop landing page builder. - Promo codes and offers managed per campaign.

### Binding data rules from the client

- **Product → Supplier → Inventory:** purchase price comes only from supply entries. It is never visible in the product master and is hidden from Sales.
- **Order → Delivery → Accounts:** these three modules stay in tight sync.
  - Confirming an order reduces inventory and creates the courier entry.
  - Received payment appears in accounts automatically.
- **Reseller order → Beownz inventory:** reseller orders reduce Beownz's main stock. Resellers own no stock.
- **Multi-org isolation:** each org's data is isolated. Only Super Admin and the leaderboard aggregation read across orgs.

### Deliberate deviations from the client's suggestions

Explain these to the client. Each is logged in decisions.md.

- We build a custom system rather than on ERPNext or Odoo (D-001).
- Org isolation uses PostgreSQL row-level security in one schema per module, not a schema per org (D-002).
- Revenue is recognized on delivery (D-003).
- Some features arrive earlier than the client planned:
  - courier v1 and a basic fraud check move into Phase 1
  - minimal promo codes move into Phase 2
  - multi-org and branches exist in the data model from day one

---

## 2. Glossary

- **Org:** a sister company (tenant).
- **Branch:** a showroom or warehouse unit of an org.
- **Location:** a place that holds stock, usually one per branch, plus `damaged` and `in_transit` locations.
- **Poisha:** 1/100 taka. All money is stored as integer poisha.
- **COD:** cash on delivery. The courier collects the cash and later settles with the merchant, minus its charges.
- **Consignment / parcel:** one courier booking for an order.
- **Settlement:** a courier payout batch covering many delivered consignments.
- **Wallet:** a cash-like asset account (hand cash, bank, bKash) held at org or branch level.
- **WAC:** weighted average cost per SKU per org.
- **Business date:** the calendar date in Asia/Dhaka (UTC+6, no daylight saving).
- **Party:** the counterparty on a ledger line: supplier, courier, reseller, investor, employee or lender.
- **Maker-checker:** an action one user requests and a _different_ user approves.
- **Trust score:** 0–100, where higher means a safer customer.

---

## 3. System architecture

### Shape

The system is a TypeScript modular monolith: one codebase and one PostgreSQL database, deployed as separate processes.

- **`api`** (NestJS on Fastify): REST + OpenAPI, authentication, and the Socket.IO realtime gateway.
- **`worker`** (same codebase, different entrypoint): pg-boss consumers and cron schedules. It owns **all** outbound integration calls.
- **Frontends:**
  - `console` (staff SPA)
  - `portal` (reseller and investor PWA)
  - `pos` (showroom PWA)
  - `sites` (Next.js public landing pages)
  - `extension` (Chrome MV3 agent tracker)
- **Supporting services:**
  - Valkey: cache, rate limits, Socket.IO adapter
  - Gotenberg: HTML → PDF
  - Chatwoot: Message Hub, from Phase 5

### Why this shape

- **ERPNext would cover only the simplest modules well.** It handles the standard ERP modules, but for this client those are the simplest ones. The differentiating modules would all be custom anyway, built inside Frappe's conventions and permission model.
- **Tight sync needs one database.** The Order → Delivery → Accounts requirement is about transactional consistency, and one database with atomic transactions is the cheapest way to guarantee it.

See D-001 and D-002.

### Module rules

- Each domain module lives in `apps/server/src/modules/<module>/` and owns exactly one Postgres schema.
- Modules call each other only through the other module's exported interface, `<module>.api.ts`. Never import another module's repository or tables.
- When changes must be atomic, the calling service passes its transaction to the callee's transactional API (`fn(tx, …)`). Examples:
  - confirming an order and reserving its stock
  - receiving a supply, recording the stock movement and posting the journal
- External calls never happen inside a DB transaction. Enqueue a pg-boss job inside the transaction and let the worker call out.
- **Events:**
  - Events are written to `events.outbox` inside the transaction.
  - A dispatcher publishes them after commit to in-process handlers, the realtime gateway and the analytics rollups.
  - Every event carries `id, org_id, type, occurred_at, actor_user_id, payload`.
  - The outbox doubles as the domain event log that productivity metrics are computed from.

### Module → schema map

| Module    | Schema    | Owns                                                                          |
| --------- | --------- | ----------------------------------------------------------------------------- |
| org       | org       | organizations, branches, locations, settings, feature flags, per-org branding |
| iam       | iam       | Better Auth tables, memberships, API keys, devices                            |
| audit     | audit     | audit log                                                                     |
| approvals | approvals | maker-checker requests                                                        |
| events    | events    | outbox and event log                                                          |
| files     | files     | file objects                                                                  |
| catalog   | catalog   | categories, attributes, products, SKUs, prices, images                        |
| inventory | inventory | movements, levels, reservations, costs, counts                                |
| supply    | supply    | suppliers, supply entries, supplier returns, supplier payments                |
| ledger    | ledger    | accounts, journals, lines, periods                                            |
| sales     | sales     | customers (org-scoped), orders, order lines, delivery zones                   |
| delivery  | delivery  | courier accounts, consignments, status events, settlements                    |
| fraud     | fraud     | phone signals, provider checks, rules; **cross-org by design** (§5)           |
| crm       | sales     | buyer stats, segments, occasions — built inside `orders` (D-211)              |
| notify    | notify    | templates, messages, opt-outs                                                 |
| promo     | promo     | promo codes, redemptions                                                      |
| marketing | marketing | campaigns, ad spend, leads                                                    |
| hr        | hr        | employees, attendance, payroll, employee loans, targets, bonus rules          |
| reseller  | reseller  | resellers, margin rules, slabs, earnings, payouts                             |
| pos       | pos       | registers, shifts, POS sync                                                   |
| investor  | investor  | investors, investments, distributions, withdrawals                            |
| loans     | loans     | lenders, company loans, instalments, payments, reminders (M26, D-293, D-302)  |
| messaging | messaging | Chatwoot links, conversation stats, activity heartbeats                       |
| landing   | landing   | pages, versions, domains                                                      |
| analytics | analytics | rollups, leaderboard snapshots, insights                                      |
| migration | migration | imported files and the one opening of a brand's books (M14a, D-215)           |

---

## 4. Repository layout

```
apps/
  server/          NestJS: src/main.api.ts, src/main.worker.ts, src/modules/*, src/platform/*
  console/         React + Vite SPA (staff)
  portal/          React + Vite PWA (resellers, investors)
  pos/             React + Vite PWA (showrooms)
  sites/           Next.js App Router (landing pages)
  extension/       WXT Chrome MV3 extension (agent activity)
packages/
  db/              Drizzle schema per module, migrations, RLS, roles, seed, withOrg()
  domain/          Pure business logic: money, posting rules, state machines, pricing,
                   payouts, costing, schedules, scoring, target splits
  contracts/       Zod schemas and DTO types, permission matrix (CASL), error codes, event types
  api-client/      Generated typed client from OpenAPI, plus TanStack Query hooks
  ui/              shadcn/ui components, Tailwind preset, Bangla fonts, formatting components
  i18n/            bn + en messages, money/date/number formatters
  integrations/    Adapters behind interfaces: couriers, fraud providers, SMS, Meta, Chatwoot,
                   payment
  landing-blocks/  Puck components shared by the console editor and the sites renderer
  config/          tsconfig, eslint, prettier presets
infra/             docker-compose.dev.yml, Dockerfiles, deploy config, Chatwoot compose (Phase 5)
scripts/           check-migrations and other verify helpers
docs/              this spec, milestones, decisions, progress, plans, runbooks
```

Rule: anything with arithmetic, rules or state lives in `packages/domain` as a pure function with exhaustive tests. NestJS services only orchestrate I/O around those functions.

---

## 5. Multi-org tenancy and data access

### Tenant tables

- Every tenant table has `org_id uuid not null` (FK to `org.organizations`, indexed). Many also have `branch_id uuid null`.
- Every tenant table gets RLS:

```sql
alter table <schema>.<table> enable row level security;
alter table <schema>.<table> force row level security;
create policy org_isolation on <schema>.<table>
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
```

- The `nullif` is load-bearing (D-043). `set_config(..., true)` is transaction-local, so once a connection has set `app.org_id` and the transaction has ended, the setting reverts to the **empty string**, not to unset. A bare `current_setting(...)::uuid` then raises `invalid input syntax for type uuid: ""` on every reused pooled connection — which is every connection in production after its first request. `nullif` makes both the never-set and the reset case resolve to NULL.
- With the setting absent or empty the policy returns **zero rows**. Never write a policy that returns all rows when the setting is missing.
- Policies are generated by `tenantTableSql()` in `packages/db/src/rls.ts`, never hand-written. A policy that differs by one character fails silently: it returns rows rather than throwing, and the wrong rows look like the right ones.

### Database roles

| Role            | Used by                                                                               | Rights                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `erp_owner`     | Migrations and seeds only; the app never connects as it                               | Owns all objects. **NOSUPERUSER and NOBYPASSRLS** (D-042): a superuser bypasses FORCE RLS, which would make every policy above a no-op for the role that owns the tables. |
| `erp_app`       | The running app                                                                       | No BYPASSRLS. INSERT/SELECT only on append-only tables (ledger, stock movements, audit, outbox).                                                                          |
| `erp_analytics` | Only the analytics module and super-admin consolidated reads, through a separate pool | SELECT only, with policies that allow all orgs                                                                                                                            |

### Access helpers

- `withOrg(ctx, fn)`:
  - opens a transaction on the `erp_app` pool
  - runs `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.request_id', $3, true)`
  - then calls `fn(tx)`
  - every tenant query goes through it
- `withAnalytics(fn)`: read-only cross-org access.
- `withSystem(fn)`: owner access, for migrations and seeds only.

### Cross-org by design (the only exceptions)

1. `fraud.phone_signals` and `fraud.provider_checks`: aggregated counts keyed by an HMAC of the normalized phone number. Every org can read them. They contain no order details, names or addresses.
2. The `analytics.daily_org` rollup, read through `erp_analytics` (D-329); the other rollups are single-brand.
3. Super Admin consolidated views (wallet totals, P&L across orgs) through `erp_analytics`. These are read-only; **every write is scoped to exactly one org**.
4. `iam` users and memberships: one user can belong to several orgs with different roles.
5. The org list and reference data (districts and thanas) are global.

### Required tests (M01, extended by every later milestone)

- A guard test lists every table in the tenant schemas and fails if any lacks `org_id`, RLS enabled or FORCE RLS.
- In an org A context, neither the ORM nor raw SQL can read or write org B rows.
- With no context set, tenant tables return 0 rows.
- `erp_app` cannot SET ROLE, disable RLS or bypass policies.
- `erp_analytics` cannot write.

---

## 6. Identity, roles and permissions

### Authentication

Authentication uses Better Auth:

- email or phone plus password
- TOTP two-factor authentication
- phone OTP through the SMS adapter, for resellers

Sessions:

- live in httpOnly, Secure, SameSite=Lax cookies
- are scoped to the parent domain, so the console works inside the Chatwoot iframe

2FA is **required** for `super_admin`, `org_admin`, `accounts` and `investor`.

It is enforced as an **enrolment wall on the request path**, not by refusing the session (D-051). A privileged user who has not enrolled receives a session, but `mustEnrolTwoFactor()` refuses every route outside `/api/auth` with `403 TWO_FACTOR_ENROLMENT_REQUIRED`, and no request context is built, so a route that forgot its own guard still sees no org. The reason is mechanical: enrolling TOTP runs behind Better Auth's session middleware, so refusing the session would leave an org_admin created by another org_admin with no way in at all. The check reads live rather than caching on the session, so granting a privileged role walls that user on their next request rather than at their next sign-in, and it fails closed on an unknown user id.

Once enrolled, the second factor is enforced by the plugin itself: sign-in returns `twoFactorRedirect` and **no session**, and the session is created only by `verify-totp` or `verify-backup-code`. Ten recovery codes are issued at enrolment, shown exactly once, and each is single use.

**Registration is closed (D-057).** There is no self-service sign-up: this is a staff ERP, and an open sign-up was also the enabling half of an account pre-hijacking attack. An `org_admin` — and only an `org_admin` (D-058) — creates a user through `POST /v1/users`, which returns a one-time invite token. The recipient redeems it to set their own password. An existing identity is reused when a colleague joins a second brand, but never when the row holds credentials and belongs to no org.

**Rate limits are per identifier as well as per IP (D-056).** Both buckets are counted on the credential endpoints and either can reject. Per-IP alone is close to useless against a botnet — credential stuffing gets the full allowance per address — and actively harmful in Bangladesh, where most mobile traffic shares a handful of carrier NAT addresses, so one attacker would lock out a whole network. The per-identifier bucket makes attacking one account expensive however many addresses the attacker has; the per-IP bucket stops one address walking a list of accounts. The store is in memory per process until M04 moves it to Valkey.

**Browser origins (D-053, D-054).** The console, portal and POS are served from their own origins and talk to this API cross-origin with cookies. Two consequences are load-bearing rather than incidental:

- Every browser app must sit on the **same registrable domain** as the API. The CSRF double-submit token is a cookie the client reads with script and echoes as a header; cookies are scoped by host and ignore ports, so an app on another registrable domain cannot read it.
- CORS echoes the origin exactly, with `credentials: true`. `*` is rejected by the browser once credentials are involved, and without credentials the session cookie is never sent and every request looks anonymous. The same list serves CORS, CSRF and Better Auth, so "which origins are ours" has one answer.
- That list is **enumerated, never patterned** (D-054): `TRUSTED_ORIGINS` plus one origin per active brand hostname, resolved at boot. A `*.<domain>` wildcard is not equivalent and was rejected — the parent-domain CSRF cookie already lets a sibling host read the token, and CORS is the control that stops it using the token. The hosts under this domain are not all ours: landing sites on Vercel (D-026) and Chatwoot (§16) both live there.

**Branded login (D-035).** The client asked for a separate login per sister org. One identity with several memberships is the right model underneath, so we meet the intent at the surface: when the login route or hostname identifies an org, that org is preselected and the screen carries its branding (§24). Users with one membership never see a switcher; multi-org users still get one after login.

The hostname comes from the **caller**, not from the API's own `Host` header (D-052): the console is served from `<org>.<domain>` while the API answers on `api.<domain>`, so reading our own header would resolve every branded login to an org named "api". The endpoint is unauthenticated by necessity — it runs before anyone has signed in — and returns only what a login page may show: display name, accent, logo. An unknown host falls back to the generic login rather than failing, because a misconfigured DNS record must not mean nobody can sign in.

### Request context

- After login the user picks an active org with the org switcher, unless the login route already identified one (D-035). The choice is stored **on the session row**, not in a client-readable cookie: a client-controlled org id would make every RLS policy in the system advisory. The switch endpoint re-checks membership rather than trusting the request, and answers the same error whether the org does not exist or the user simply has no membership in it, so it cannot be used as a membership oracle.
- Nothing on the request path connects as `erp_owner` (D-059). The global `iam` tables are reached with `withGlobal()`, which is `erp_app` with no org chosen; `withSystem()` is for migrations, seeds and the guard.
- The context is rebuilt from the session on **every** request rather than cached. A session outlives a membership change, and this is the only place that notices: a revoked membership stops being honoured on the next request.
- Every request resolves `membership(user, org)` into roles plus branch scope. Empty branch scope means the whole org, not "no branches".
- Listing the orgs a user may enter happens **before** any org is chosen, which is why `iam.memberships` carries a second, SELECT-only policy scoped to `app.user_id` (D-050). It is the §5 exception 4 identity carve-out and nothing wider: a user reads their own memberships across orgs and nobody else's.
- Membership roles: `super_admin` (global), `org_admin`, `sales`, `accounts`, `marketing`, `hr`, `branch_manager`, `warehouse`, `reseller`, `investor`.

### Authorization

- CASL abilities come from one declarative matrix in `packages/contracts/src/permissions/`.
- The server enforces them with a guard plus `serializeFor(ability, subject, data)`, which removes any field the ability can't read.
- The UI uses the same definitions only to hide controls.
- Scope qualifiers:
  - `own`: `created_by` or `assigned_to` is the user
  - `branch`: `branch_id` is within the user's branch scope
  - `org`: the whole active org
- **Row scope is mandatory (D-061).** The guard can only answer "may this caller act on _some_ row of this subject". It therefore hands the caller's scope filter (`scopeFilterFor`, unioned across roles) to the handler, which applies it with `scopeWhere(request, columns)` for a query or `assertInScope(request, row)` for one row. `ScopeInterceptor` refuses to send a scoped caller's response if the handler applied neither — including for a `create`, whose handler asserts the row it inserts. Branch scope is per membership role, never merged across roles (D-075). Every module maps its table's `created_by` / `assigned_to` / `branch_id` columns once and passes them in.
- **Route coverage (D-070).** Every route declares `@RequireAbility`, `@AuthenticatedOnly` or `@Public` (never two that contradict), and every non-public route is listed in `route-matrix.manifest.ts` with a fixture in the generated route-matrix suite. `check-route-matrix` fails the build otherwise.

### Protected fields

- **COST fields** are readable only with `read:cost` (super_admin, org_admin, accounts):
  - `unit_cost_poisha`, `wac_poisha`, `cogs_poisha`, `gross_profit_poisha`, `stock_value_poisha`
  - supply line prices
  - supplier balances
- **Reseller-visible catalog fields** (nothing else): SKU id, SKU code, product name, images, attributes, `reseller_price_poisha`, `available_qty`.
- **Investors** only ever see rows where `investor_id` is their own.

### Permission matrix

This summary is authoritative until M02b writes the code matrix. After that, the code is authoritative and any change needs a decision row.

| Capability                         | super_admin        | org_admin                          | sales                   | accounts                    | marketing    | hr      | branch_manager                 | warehouse           | reseller            | investor |
| ---------------------------------- | ------------------ | ---------------------------------- | ----------------------- | --------------------------- | ------------ | ------- | ------------------------------ | ------------------- | ------------------- | -------- |
| Catalog read (no cost)             | all                | org                                | org                     | org                         | org          | —       | org                            | org                 | limited fields      | —        |
| Catalog write, prices              | all                | org                                | —                       | —                           | —            | —       | —                              | —                   | —                   | —        |
| Cost, WAC, stock value, margins    | all                | org                                | —                       | org                         | —            | —       | —                              | —                   | —                   | —        |
| Stock availability                 | all                | org                                | org                     | org                         | org          | —       | org                            | org                 | Beownz only         | —        |
| Stock adjust / transfer / count    | all                | org + approve                      | —                       | read                        | —            | —       | request (branch)               | request             | —                   | —        |
| Supply entries, suppliers          | all                | org                                | —                       | org                         | —            | —       | —                              | qty-only drafts     | —                   | —        |
| Orders                             | all                | org                                | own + unassigned queue  | read                        | read         | —       | branch                         | pack, ship, returns | own (portal)        | —        |
| Customers, buyer history           | all                | org                                | customers of own orders | read                        | org          | —       | branch                         | —                   | own end customers   | —        |
| Buyer list export                  | all                | org                                | —                       | —                           | org          | —       | —                              | —                   | —                   | —        |
| Fraud trust badge and reasons      | all                | org                                | yes                     | read                        | —            | —       | branch                         | —                   | badge on own orders | —        |
| Fraud block override               | all                | org                                | —                       | —                           | —            | —       | —                              | —                   | —                   | —        |
| Wallets, cash entries, petty cash  | all                | org                                | —                       | org                         | —            | —       | own branch wallets             | —                   | —                   | —        |
| Ledger reports, P&L, balance sheet | all + consolidated | org                                | —                       | org                         | —            | —       | branch P&L without cost detail | —                   | —                   | —        |
| Period close, reopen request       | all                | org                                | —                       | org                         | —            | —       | —                              | —                   | —                   | —        |
| Courier settlements                | all                | org                                | —                       | org                         | —            | —       | —                              | —                   | —                   | —        |
| Campaigns, ad spend, leads         | all                | org                                | —                       | spend entry                 | org          | —       | —                              | —                   | —                   | —        |
| Landing pages, promo codes         | all                | org                                | apply codes             | —                           | org          | —       | apply at POS                   | —                   | —                   | —        |
| Employees, attendance, payroll     | all                | org                                | own                     | payroll posting and payment | own          | org     | branch staff                   | own                 | —                   | —        |
| Targets and bonus rules            | all                | org                                | own progress            | —                           | own progress | org     | branch progress                | —                   | —                   | —        |
| Reseller admin, payouts            | all                | Beownz org                         | —                       | Beownz org                  | —            | —       | —                              | —                   | own                 | —        |
| Investors                          | all                | org (read)                         | —                       | org                         | —            | —       | —                              | —                   | —                   | own      |
| Company loans                      | all                | org                                | —                       | org                         | —            | —       | —                              | —                   | —                   | —        |
| Approvals (as checker)             | all                | org                                | —                       | payments                    | —            | payroll | branch items under threshold   | —                   | —                   | —        |
| Leaderboard                        | all                | all orgs (normalized metrics only) | —                       | —                           | —            | —       | —                              | —                   | —                   | —        |
| Org dashboard (analytics)          | all + consolidated | org                                | —                       | —                           | —            | —       | —                              | —                   | —                   | —        |
| Users, roles, settings             | all                | org                                | —                       | —                           | —            | —       | —                              | —                   | —                   | —        |

### Maker-checker actions

Each org configures its own thresholds. These actions go through approvals:

- wallet adjustments
- stock write-offs and gains
- supplier payments above the threshold
- courier settlement posting
- daily closing variances
- back-dated entries
- payroll runs and bonuses
- reseller payout batches
- investor withdrawals and distributions
- company loan repayments above the threshold (M26, D-298)
- fraud block overrides
- reopening a closed period (super_admin only)

The database enforces that the requester can never approve their own request, and a trigger freezes a decided request's terms and decision.

How thresholds behave (D-062, D-065, D-068):

- Only `org_admin` sets a threshold (`PUT /v1/approvals/thresholds`, subject `ApprovalThreshold`). Lowering one applies at once; raising one, or setting the first, is a `threshold_change` request another org admin must approve (D-073). Each request records the threshold in force when it was raised.
- **Under** the threshold, a request is recorded `auto_approved`: audited, both events emitted, no checker. **At or above** it, with no threshold configured, it is `pending`. Amounts are compared by magnitude.
- Never auto-approved, whatever the threshold (D-071): reopening a period, bonus rules, threshold changes and back-dated entries. The database refuses a threshold for them and an auto-approved row of them. A request's terms are fixed from the moment it is raised.
- Who may raise is per type (`REQUESTER_TYPES`, D-072). A type whose amount the owning module derives (stock write-offs and gains, settlements, closing variances, payroll, payout batches) is always held when its amount was typed by a person.
- Who may check is per type (`CHECKER_TYPES`): accounts decides payments, hr decides payroll and bonuses, branch_manager decides branch items (stock write-offs and gains, closing variances), org_admin decides everything except reopening a period, which only super_admin decides.
- A branch manager is a branch-tier checker: only branch items (never auto-approved, D-076) whose amount the owning module derived, carrying a `branch_id` in the branch manager membership's own scope (D-075), and only under both the captured and the current threshold for the type.
- A requester's type rights and branch scope come from the same role: a type may be raised only for the branches of the roles allowed to raise it.
- Nobody decides a request raised by whoever granted them their role, directly or down the grant chain (D-077).
- An executor acts on `amount_poisha` and nothing else; a payload may not carry its own amount (D-078).
- A WAC-valued amount (stock write-off or gain) is withheld from roles without `read:cost` (D-074).

---

## 7. Money and the ledger

### Money

- Columns are `bigint`, named `*_poisha`. TypeScript uses `Poisha`, a branded `bigint` built only through `poisha()`, which refuses fractions and anything beyond ±9e15 (D-079).
- `packages/domain/src/money` provides:
  - `add`, `sub`, `sum`
  - `mulQty`
  - `percentOf(amount, basisPoints)`, rounding half away from zero to whole poisha
  - `allocate(total, weights)`, largest-remainder, so the parts always sum exactly
  - `parseTaka` (lakh/crore grouping, ৳, Bangla digits; at most two decimals) and `parsePoisha`
- `toFixed` and `parseFloat` are lint errors outside this module (`elysium/no-float-money`, D-090).
- Formatting lives in `packages/i18n`: ৳ with lakh/crore grouping, e.g. `৳1,23,456.78`.
- Currency is BDT only (D-028).

### Chart of accounts

Each org gets a chart seeded from a template in `packages/db/src/seed/coa-template.ts` (D-084): 41 system accounts (M14a added `3350 Opening balance equity`, D-213) with stable codes (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx expenses) plus hand cash `1010-<branch code>` for every branch. Accounts have stable `code`s and `subtype`s. Orgs can add accounts but can't delete any (`erp_app` holds no DELETE), and an account can be renamed or deactivated but never change its class, subtype, branch or party type. Subtypes marked as party subtypes below require a party of that type on every line, and a branch-level account requires its branch on every line.

System subtypes:

| Class       | Subtypes                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assets      | `wallet_cash` (per branch)<br>`wallet_bank`<br>`wallet_bkash`<br>`wallet_mfs_other` (optional, e.g. Nagad)<br>`courier_receivable` (party: courier)<br>`inventory`<br>`goods_in_transit`<br>`supplier_advance` (party: supplier)<br>`employee_loan_receivable` (party: employee)<br>`other_receivable`                                                                             |
| Liabilities | `supplier_payable` (party: supplier)<br>`reseller_payable` (party: reseller)<br>`salary_payable`<br>`investor_payable` (party: investor)<br>`loan_payable` (party: lender)<br>`customer_advance`<br>`other_payable`                                                                                                                                                                |
| Equity      | `owner_capital`<br>`investor_capital` (party: investor)<br>`retained_earnings`<br>`opening_equity` (M14a, D-213)<br>`profit_distribution`                                                                                                                                                                                                                                          |
| Income      | `sales_revenue`<br>`sales_discounts` (contra-revenue)<br>`delivery_charge_income`<br>`other_income`<br>`inventory_adjustment_gain`                                                                                                                                                                                                                                                 |
| Expenses    | `cogs`<br>`courier_charges`<br>`return_charges`<br>`ad_spend`<br>`salary_expense`<br>`bonus_expense`<br>`interest_expense`<br>`inventory_writeoff`<br>`purchase_price_variance`<br>`cash_over_short`<br>`bank_charges`<br>`operating_expense`: the operating categories (rent, utilities, packaging, transport, misc) as one account each, used by petty cash and cash out (D-084) |

### Journal model

- `ledger.journals`:
  - `id, org_id, business_date, source_type, source_id, idempotency_key`
  - `memo, reverses_journal_id, content_hash, created_by, created_txid, created_at`
  - unique `(org_id, idempotency_key)`; unique `(org_id, reverses_journal_id)` so a journal is reversed at most once
- `ledger.journal_lines`:
  - `id, journal_id, org_id, line_no, account_id, branch_id`
  - `party_type, party_id`
  - `debit_poisha >= 0, credit_poisha >= 0`, with a CHECK that exactly one of them is > 0
  - `memo`
- The database enforces (migration 0014, D-080):
  - A deferred constraint trigger: each journal has ≥ 2 lines and total debits equal total credits.
  - No UPDATE or DELETE for `erp_app`, via REVOKE plus a trigger that raises for every role.
  - Lines are added only by the transaction that created their journal (`created_txid`), so a posted journal cannot grow a balanced pair of lines later; each line must match its account's party type, branch and active flag.
  - A period-lock trigger: a journal dated in or before any closed month is rejected (D-093), under a per-org advisory lock that posts take shared and closes and reopens take exclusively. Posting requires READ COMMITTED.
  - Approval rows are born pending with database-stamped times, and a reopen rests only on an approval decided by an acting platform super admin (migration 0015, D-094).
- `ledger.post(tx, draft)` is the only writer.
  - Drafts come from pure posting-rule functions in `packages/domain/src/posting/`, one file per business event.
  - Posting an existing idempotency key returns the existing journal and writes nothing. The same key with different content is refused with `IDEMPOTENCY_CONFLICT` (`content_hash`, D-082).
  - Other modules post through `LedgerApi` (`apps/server/src/modules/ledger/ledger.api.ts`). No HTTP route posts or reverses an arbitrary journal (D-088).
  - Key format: `<source_type>:<source_id>:<event>`, e.g. `order:<uuid>:delivered`.
- Reversals create a new journal with `reverses_journal_id` set.

### Posting rules (canonical)

W = the wallet account used.

| Business event                        | Journal                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supply received (qty × unit cost)     | Dr Inventory / Cr Supplier payable (supplier)                                                                                                                                                                                      |
| Supplier advance paid                 | Dr Supplier advance / Cr W                                                                                                                                                                                                         |
| Advance applied to a supply           | Dr Supplier payable / Cr Supplier advance                                                                                                                                                                                          |
| Supplier paid                         | Dr Supplier payable / Cr W                                                                                                                                                                                                         |
| Supplier return                       | Dr Supplier payable (qty × original unit cost)<br>Cr Inventory (qty × current WAC)<br>Dr or Cr Purchase price variance (the difference)                                                                                            |
| Order handed to courier               | Dr Goods in transit / Cr Inventory (qty × WAC at handover; this value is recorded on the movement)                                                                                                                                 |
| Delivered (full)                      | Dr Courier receivable (COD collected) + Dr Customer advance (if an advance was taken)<br>Cr Sales revenue (net item value) + Cr Delivery charge income<br>and Dr COGS / Cr Goods in transit                                        |
| Partially delivered                   | Delivered lines post as above. Any difference between the courier-reported collection and the computed value posts to Sales discounts, with a reason. Undelivered lines follow the return path.                                    |
| Return received (sellable or damaged) | Dr Inventory / Cr Goods in transit (at dispatch value). Damaged units go to the `damaged` location; writing them off is a separate step that needs approval.                                                                       |
| Courier charges (from settlement)     | Dr Courier charges and Dr Return charges / Cr Courier receivable                                                                                                                                                                   |
| COD settlement received               | Dr W (bank or bKash) / Cr Courier receivable (net)                                                                                                                                                                                 |
| Advance received before delivery      | Dr W / Cr Customer advance, when accounts **verifies** the claim an agent recorded; a claim alone posts nothing (D-230)                                                                                                            |
| Advance at the order's ending         | Kept (per org policy, at most the delivery charge): Dr Customer advance / Cr Other income. Owed back: stays in Customer advance until the refund is paid, then Dr Customer advance / Cr W (D-232)                                  |
| Advance verification undone           | The reversal of its received journal, and the COD restored; only before the parcel moves (D-236)                                                                                                                                   |
| POS sale                              | Dr W (branch) / Cr Sales revenue, and Dr COGS / Cr Inventory                                                                                                                                                                       |
| POS return (D-169)                    | Dr Sales revenue / Cr W (the tender refunded), and Dr Inventory / Cr COGS at the unit cost the sale recorded. An exchange is a return and a new sale, two journals. Taken only at the branch that made the sale.                   |
| Cash in (category)                    | Dr W / Cr income account                                                                                                                                                                                                           |
| Cash out / petty cash (category)      | Dr expense account / Cr W (receipt required)                                                                                                                                                                                       |
| Wallet transfer                       | Dr W2 (+ Dr Bank charges) / Cr W1                                                                                                                                                                                                  |
| Daily closing variance                | Dr or Cr Cash over/short against W (approval required)                                                                                                                                                                             |
| Ad spend recorded                     | Dr Ad spend / Cr W or Cr Other payable                                                                                                                                                                                             |
| Payroll posted                        | Dr Salary expense + Dr Bonus expense<br>Cr Salary payable + Cr Employee loan receivable (deductions)                                                                                                                               |
| Salary paid                           | Dr Salary payable / Cr W                                                                                                                                                                                                           |
| Employee loan disbursed               | Dr Employee loan receivable / Cr W                                                                                                                                                                                                 |
| Reseller order delivered              | Dr Courier receivable (Σ customer selling price + delivery charge)<br>Cr Sales revenue (Σ reseller price + slab charge)<br>Cr Delivery charge income<br>Cr Reseller payable (reseller income)<br>and Dr COGS / Cr Goods in transit |
| Reseller order returned               | No income accrues. Any return fee is charged to the reseller per policy (D-016): Dr Reseller payable / Cr Other income.                                                                                                            |
| Reseller payout                       | Dr Reseller payable / Cr W                                                                                                                                                                                                         |
| Investor capital received             | Dr W / Cr Investor capital (investor)                                                                                                                                                                                              |
| Profit distribution declared          | Dr Profit distribution / Cr Investor payable                                                                                                                                                                                       |
| Distribution or withdrawal paid       | Dr Investor payable (or Investor capital) / Cr W                                                                                                                                                                                   |
| Company loan received                 | Dr W / Cr Loan payable (lender)                                                                                                                                                                                                    |
| Loan instalment paid                  | Dr Loan payable (principal) + Dr Interest expense / Cr W, one whole instalment, keyed per instalment; interest expensed when paid (D-295, D-297)                                                                                   |
| Stock write-off / count loss          | Dr Inventory write-off / Cr Inventory (approval required)                                                                                                                                                                          |
| Stock gain                            | Dr Inventory / Cr Inventory adjustment gain (approval required)                                                                                                                                                                    |

Accounting policies:

- Revenue is recognized **on delivery** (D-003).
- Sales are recorded net of discounts. The discount amount is kept on the order for reporting.

### Reports

All reports filter by org, branch and a range of business dates. They apply the caller's row scope to each line's `branch_id`, and a caller without `read:cost` gets no rows for cost-bearing subtypes (inventory, goods in transit, supplier advance and payable, COGS, write-off, price variance, adjustment gain) and no supplier balances, with `costWithheld: true` (D-085). M03 serves the account ledger, trial balance, party balances, day book, wallet balances and cash book per wallet (`/v1/ledger/*`):

- day book
- cash book per wallet
- wallet balances, plus a consolidated view for super_admin
- account ledger
- party statements: supplier, courier, reseller, investor, employee, lender
- receivable and payable aging (0–7, 8–30, 31–60, 60+ days), by open item: a settlement clears the oldest amount still open, and money paid ahead is shown apart, never aged (D-193)
- trial balance
- P&L by org, by branch, and consolidated
- balance sheet
- stock valuation (cost roles only)
- COD reconciliation: delivered vs settled vs outstanding, by courier

### Opening balances (M14a)

A brand that has traded for years opens its books here once, before go-live (D-213 to D-223):

- Six importers, each a dry run and an all-or-nothing commit: SKUs and customers apply on commit; opening stock, supplier dues and advances, wallet balances and courier COD in transit are **staged** in `migration.batches` (D-215).
- One posting writes every staged file's `opening_balance` movements and **one** journal dated the evening before go-live (today or yesterday, D-221): assets debited, liabilities credited, the difference to `3350 Opening balance equity` (D-213). Its key is the org's, so a brand opens once; balance files close afterwards.
- A SKU opens at one cost (D-216), so the journal's inventory line equals the inventory module's valuation to the poisha.
- The reconciliation puts imported, journal and module figures side by side per line (D-222); the accountant's sign-off is recorded once, only when every line agrees.
- Run by the implementation team through `pnpm migration` and `pnpm demo:org` (D-214), not a screen. The training org (`is_training`) is seeded from anonymised files through the same importers and is left out of consolidated reads (D-223).

### Periods and dates

- Periods close monthly. `org_admin` or `accounts` closes them (`update LedgerPeriod`, D-083), once the month has ended in Asia/Dhaka; reopening needs super_admin approval.
  - A `ledger.periods` row appears when a month is first closed; a month without one is open.
  - Closing a month locks every date before it; reopening is latest-first, one month at a time (D-093).
  - Reopening is a `period_reopen` approval request, raised only through `POST /v1/ledger/periods/reopen`. Its approval reopens the period in the same transaction, through the executor the ledger registers with the approvals module. The database refuses closed → open unless an approved `period_reopen` for that period, raised and decided after the close, is named (D-081).
- `business_date = (occurred_at at time zone 'Asia/Dhaka')::date`, computed in the domain layer.
- Back-dating is allowed only into open periods. Anything earlier than yesterday needs approval (configurable).

---

## 8. Inventory and costing

### Tables

- `org.locations`: `org_id, branch_id, kind` (`warehouse | showroom | damaged | in_transit`), name. Lives in the `org` schema, not `inventory`: a location is a fact about an org's physical footprint that inventory then uses (D-046).
- `inventory.stock_levels`:
  - `(org_id, sku_id, location_id)` is the primary key
  - columns `on_hand, reserved`
  - CHECKs: `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`
- `inventory.stock_movements` (append-only):
  - `qty_delta`, `unit_cost_poisha` (cost role only), `ref_type`, `ref_id`, `created_by`
  - `kind` is one of: `opening_balance, supply_receipt, supplier_return, dispatch, customer_return, pos_sale, pos_return, transfer_out, transfer_in, adjustment_gain, adjustment_loss, count_correction`
- `inventory.sku_costs`: `(org_id, sku_id)`, `wac_poisha`, `qty_basis`.
- `inventory.reservations`:
  - `org_id, sku_id, location_id, qty`
  - `ref_type, ref_id`
  - `status`: `active | consumed | released`

### Rules

- Every movement updates `stock_levels` in the same transaction. A nightly job recomputes levels from movements and alerts on any drift.
- Reserve with one conditional statement. Zero rows updated means `STOCK_INSUFFICIENT`. Never SELECT and then UPDATE.

```sql
update inventory.stock_levels set reserved = reserved + $qty
where org_id = $org and sku_id = $sku and location_id = $loc and on_hand - reserved >= $qty;
```

- Fulfilment location:
  - orders use the org's default fulfilment location, which can be overridden per order
  - POS uses its branch location
  - reseller orders use the Beownz location
- **WAC:**
  - On a supply receipt: `new_wac = round((qty_basis × wac + q × unit_cost) / (qty_basis + q))`, where `qty_basis` is the org-wide on-hand before the receipt (treat negative as 0).
  - Customer returns re-enter at the cost they were dispatched at and blend into WAC the same way.
  - Transfers don't change WAC.
- **Supplier return:** stock leaves at the current WAC, and the supplier is credited at the original line cost. The difference goes to purchase price variance.
- **Adjustments and counts:**
  - A count session freezes a snapshot and staff enter counted quantities.
  - The variance becomes adjustment movements, which need approval.
- **Transfers** are two steps: `transfer_out` to the `in_transit` location, then `transfer_in` at the destination.
- **Low stock:** each SKU has a reorder level per location. Crossing it emits `stock.low`.
- **Worked WAC example (use it in tests):**
  - Starting position: on-hand 10 @ ৳500.00 (50,000 poisha).
  - Receive 30 @ ৳540.00.
  - New WAC = (10×50000 + 30×54000) / 40 = 53,000 poisha (৳530.00).
  - Dispatch 5 at 53,000.
  - A supplier return of 3 from the second lot credits the supplier 3×54,000 and removes inventory at 3×53,000. The 3,000-poisha difference goes to purchase price variance (credit).

---

## 9. Orders, delivery and couriers

### Customers (`sales.customers`)

- Org-scoped buyer records, keyed by phone normalized to E.164 with libphonenumber-js.
- Validation accepts Bangla digits (০-৯), spaces, dashes and the prefixes +880, 880 and 0.
- Fields:
  - name
  - addresses, each with district, thana/upazila, area and full text
  - optional: birthday, anniversary, gender, age band, profession
  - tags
- The same person appears as separate rows in different orgs. The only cross-org link is the fraud phone hash (D-032).

### Orders (`sales.orders`)

| Group                | Fields                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Identity             | `org_id, branch_id`, `order_no` (per-org sequence, e.g. `OUR-2609-00042`)                            |
| Channel              | `channel` (`facebook, whatsapp, instagram, tiktok, landing_page, website, phone, walk_in, reseller`) |
| Source               | `source` jsonb: page id, campaign id, ad id, UTMs, landing page id, Chatwoot conversation id         |
| Customer and address | `customer_id`, shipping address snapshot, `delivery_zone_id`                                         |
| Amounts              | `delivery_charge_poisha, discount_poisha, promo_code_id, advance_paid_poisha, cod_amount_poisha`     |
| Status               | `status, hold_reason`                                                                                |
| Fraud                | `trust_score, fraud_decision`                                                                        |
| People               | `assigned_to, created_by`                                                                            |
| Timestamps           | `confirmed_by/at, packed_at, handed_over_at, delivered_at, returned_at, cancelled_at, cancel_reason` |
| Reseller             | `reseller_id`                                                                                        |
| Links                | `exchange_of_order_id`                                                                               |
| Other                | `notes`                                                                                              |

- **Order lines:** `sku_id, qty, unit_price_poisha` (the selling price, or the reseller's customer price), `discount_poisha, delivered_qty, returned_qty`. Reseller lines also carry `reseller_price_poisha`.
- **Totals** are computed in the domain layer: `COD = items − discount + delivery − advance`. The domain rejects a negative COD.

### State machine (`packages/domain/src/orders/state.ts`)

Implement this as an exhaustive, tested transition table:

| From                                   | To                  | Trigger                                                                                  | Effects                                                                      |
| -------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| pending                                | confirmed           | Agent confirms. The fraud decision must allow it, or an override with a reason is given. | Reserve stock. If the org setting is `on_confirm`, enqueue courier booking.  |
| pending                                | cancelled           | Agent                                                                                    | None                                                                         |
| confirmed                              | on_hold             | Agent or fraud rule                                                                      | Keep the reservation                                                         |
| on_hold                                | confirmed           | Agent                                                                                    | None                                                                         |
| confirmed                              | packed              | Warehouse                                                                                | If the setting is `on_pack`, enqueue booking                                 |
| confirmed, packed                      | cancelled           | Agent or admin                                                                           | Release the reservation. Enqueue a courier cancel if the order was booked.   |
| confirmed, packed                      | shipped             | Handover to courier                                                                      | Consume the reservation, create the dispatch movement, post goods in transit |
| shipped                                | delivered           | Courier status                                                                           | Post revenue, delivery income and COGS; update customer stats                |
| shipped                                | partially_delivered | Courier status plus delivered lines                                                      | Post the delivered part; the rest follows the return path                    |
| shipped                                | return_in_transit   | Courier status                                                                           | None                                                                         |
| return_in_transit, partially_delivered | returned            | Warehouse receives and inspects                                                          | Stock back to sellable or damaged; post the return                           |
| delivered                              | exchange            | Agent creates a linked order                                                             | A new order with `exchange_of_order_id` set                                  |

Notes:

- Once an order is shipped it can't be cancelled; it becomes a return.
- Every transition writes an outbox event and an audit row.
- Until courier sync covers a status, staff can set `delivered`, `partially_delivered` and `returned` manually, with a reason. The postings are the same.
- M17 adds three effects to the table (D-232 to D-234): `apply_advances` after the delivery postings (each verified advance records its share of what the delivery applied, oldest first, after any exchange credit), `settle_advances` on every cancel and every received return (what is left is kept or owed back, per the brand's policy), and `record_return_reason` on `receive_return` and `exchange`, which the machine refuses without a reason code from the fixed list.

### Advances and return reasons (M17)

- `sales.order_advances`: one row per payment a buyer sent ahead. An agent records the claim (method, transaction id, amount); accounts verifies it into a wallet or rejects it; the recorder never verifies. Statuses `pending → verified | rejected`, `verified → applied | refund_due | forfeited | voided`, `refund_due → refunded`, kept by a trigger. Only verification posts and lowers the COD, and only before the parcel moves with no live booking (D-230, D-231, D-236).
- `sales.order_returns`: one row per returned or exchanged order, with a reason code from a fixed list of eleven and the free-text note; a deferred trigger refuses a status update into `returned` or `exchange` without one. `GET /v1/orders/return-reasons` reports by reason (D-234).

### Delivery zones and charges

- Each org defines its own zones, each with a charge and a default courier.
- Example zones: Inside Dhaka, Dhaka suburbs, Outside Dhaka (seed placeholders, D-009).
- District/thana → zone mapping is seeded and editable.

### Couriers (`packages/integrations/couriers`)

```ts
interface CourierAdapter {
  code: string; // 'steadfast' | 'pathao' | 'redx' | …
  createParcel(input: ParcelInput): Promise<ParcelResult>; // idempotent on our order id
  cancelParcel?(ref: ParcelRef): Promise<void>;
  getStatus(ref: ParcelRef): Promise<NormalizedStatus>;
  parseWebhook?(req: RawRequest): Promise<NormalizedEvent[]>; // must verify authenticity
  fetchSettlements?(since: Date): Promise<SettlementBatch[]>;
  parseSettlementFile?(file: Buffer, name: string): Promise<SettlementBatch>;
}
```

- Normalized statuses: `booked, pickup_pending, picked_up, in_transit, out_for_delivery, hold, delivered, partial_delivered, return_in_transit, returned_to_merchant, cancelled, unknown`. For `unknown`, keep the raw status.
- Build every adapter from the courier's **official docs**, using credentials the user provides. If the docs are missing, work from recorded fixtures and mark the adapter UNVERIFIED in decisions.md.
- **Webhooks:**
  - verify authenticity the way that courier specifies
  - store the raw payload
  - dedupe on `(courier, consignment, status, occurred_at)`
  - process in a job with idempotent transitions
- **Polling fallback:** parcels with no update for N hours get polled.
- **Settlement import:** parse the file or API data → match consignments → produce an exceptions report (unmatched, amount mismatch) → approval → posting.

---

## 10. Customers, fraud, notifications and promotions

> The fraud check (M13, and the fraud half of M17) is removed from scope and its code deleted (D-291). The Fraud subsection below is kept for reference only.

### Fraud

- `fraud.phone_signals` (cross-org):
  - key: `phone_hash`, where `phone_hash = HMAC-SHA256(server_secret, e164)`
  - columns: `orders_total, delivered, returned, cancelled, last_incident_at, manual_flags jsonb, updated_at`
  - maintained from order events
- `fraud.provider_checks`:
  - `(phone_hash, provider)`, `total, delivered, returned_or_cancelled, ratio, fetched_at, raw jsonb`
  - 72-hour TTL by default
  - providers implement `FraudSignalProvider`
  - The first provider is Steadfast, wrapping the user's `fraudjs` package if they provide it (D-010).
- `fraud.address_signals` (Phase 2, v2): trigram similarity on normalized addresses to catch repeat-return addresses.
- **Trust score:** a pure function that returns 0–100 plus `reasons[]`. It combines:
  - internal delivery ratio, weighted by volume
  - provider ratios
  - recent returns
  - manual flags
  - first-order status
- **Org rules** map score bands to a decision: `allow`, `warn`, `require_advance` (collect the delivery charge in advance) or `block`. A block can only be overridden by org_admin, with a reason. Defaults are in D-011.
- **UX:** the order desk shows the badge within 300 ms from cache and refreshes stale data in the background.

### CRM (Phase 2)

- Buyer stats: orders, delivered, LTV, AOV, first and last order, favourite categories and sizes.
- RFM segments recomputed nightly.
- Occasions (birthday, anniversary):
  - a daily job at 09:00 Asia/Dhaka issues a personal promo code and sends a notification
  - it runs at most once per customer per occasion per year
- Re-engagement lists (no purchase in N days, plus filters) export to CSV, and from Phase 3 to a Meta custom audience using hashed phones.

### Notifications (`notify`)

- Channels: `sms` (BD gateway adapter), `whatsapp_template` (Phase 5), `in_app`.
- Templates in bn and en with variables.
- Opt-out list.
- Delivery log that keeps the provider message id.
- Rate limits.
- Quiet hours 21:00–09:00 Asia/Dhaka for everything except OTPs.

### Promotions (`promo`)

- Codes are `percent | flat | free_delivery` and support:
  - minimum order and maximum discount
  - usage limits, total and per customer
  - a validity window
  - scope to SKUs or categories and to channels
  - a campaign link
  - personal single-use codes
- A redemption ledger records each use.
- Validation is a pure function.
- Codes are applied in the order desk (Phase 2), at the POS (Phase 4) and on landing pages (Phase 5).

---

## 11. Marketing

- Entities:
  - campaigns: platform, external ids, products, dates
  - daily ad spend: manual entry or Meta Marketing API import
  - leads: source, phone, product and size interest, age band, profession, status
- **Attribution priority:**
  1. a campaign set explicitly on the order, by an agent or from a landing page
  2. the ad referral from a click-to-message ad, when the channel exposes it
  3. `utm_campaign` mapping
  4. none
- **Metric definitions (exact):**
  - `spend` = Σ ad spend in the period
  - `confirmed_orders` = orders that reached confirmed
  - `delivered_orders`, and `delivered_revenue` = Σ delivered net item value (excluding delivery charges)
  - `CPO` = spend / confirmed_orders
  - `CPDO` = spend / delivered_orders
  - `ROAS` = delivered_revenue / spend. This is the primary ROAS. Placed-order ROAS is shown second, labelled as optimistic.
  - `return_rate` = returned / (delivered + returned)
- **Meta Conversions API:** when an order is delivered, send a purchase conversion.
  - `event_id` = order id
  - identifiers are hashed (phone, plus name and city where consented)
  - `value` = delivered revenue, currency BDT
  - confirm Meta's current event-time rules in its docs
  - log responses and never send PII in clear text
  - credentials are per org
- **As built (M18):**
  - attribution is resolved when read, from the order's recorded source, its promo code's campaign and the brand's current mappings (D-250, D-251); an id that names nothing falls through
  - spend is one figure per (campaign, Dhaka day); a person's figure is never overwritten by the import (D-252), and nothing posts to the ledger (D-253)
  - each event counts in the period it happened in; ratios are null only on a zero denominator (D-255)
  - the CAPI event and its identifiers are D-256; the delivery hook is D-262; the hashed audience export is D-259

---

## 12. HR, payroll, targets and productivity

- **Employees:**
  - org, branch, user link, designation, join date, salary structure
  - payout details (bank or bKash) encrypted at application level
- **Attendance:**
  - manual entry
  - CSV import from the biometric device software
  - optional device push later
- **Working-day calendar** per org.
- Leave management is out of scope (D-030).
- **Payroll:**
  - salary structures made of components and deductions (D-029)
  - payroll runs go `draft → approved (maker-checker) → posted → paid`
  - payslip PDF in Bangla
  - employee loans with schedules and automatic deduction
  - bonuses come from the rules below
- **Targets:**
  - monthly, per employee or team, on one metric: `confirmed_orders`, `delivered_orders` or `delivered_revenue`
  - split into weeks by the working days in each week, using largest remainder so the weeks sum exactly
  - progress comes from rollups of the orders each member confirmed and delivered, credited to the agent who confirmed (D-272)
  - built in the HR module and the `hr` schema (D-270); team targets track progress and pay no bonus yet (D-273)
- **Bonus rules:** versioned JSON, evaluated by a pure function, with a preview and an approval before they feed payroll. Example:

```json
{
  "metric": "delivered_orders",
  "tiers": [
    { "gte_pct": 100, "amount_poisha": 200000 },
    { "gte_pct": 120, "per_unit_above_target_poisha": 5000 }
  ]
}
```

- **Productivity:**
  - pickup time = first agent action (claim, confirm or cancel) − the time the order was created or assigned
  - for each agent: median and p90 pickup time, and orders handled per active hour
  - computed from outbox events; reassignments reset the clock for the new assignee
  - an active hour is an Asia/Dhaka clock hour with at least one desk action (D-276); the outbox records each event's actor (D-277)

---

## 13. Reseller engine (Beownz)

- **Reseller** (org = Beownz):
  - business name (printed on invoices), contact, phone (used for login)
  - payout method, encrypted: bKash or bank
  - status: `pending, active, suspended`
  - tier
- **Pricing:** `reseller_price = product_price + wholesale_margin`.
  - The margin rule is resolved by specificity: SKU > product > category > tier default.
  - A margin is either fixed poisha or a percentage, rounded with the money helpers.
  - The reseller sees only the resolved reseller price.
- **Charge slabs** per order by piece count (1 pc, 2 pcs, 3+ pcs), configurable (D-018).
- **Reseller order:**
  - end-customer details, items, a selling price per item (must be ≥ reseller price), delivery zone
  - the fraud check applies
  - stock is reserved from the Beownz location
  - the invoice PDF carries the reseller's business name
  - booked with the courier under Beownz's account
- **Earnings:**
  - `income = Σ(selling − reseller price) − slab charge`, then less the delivery charge if the policy says the reseller bears it (D-015)
  - lifecycle: `accrued` (on delivery) → `available` (after the courier settles that consignment, D-017) → `requested` → `paid`
  - returns reverse the accrual and apply the return-fee policy (D-016)
- **Payouts:**
  - the reseller requests a payout from the available balance, above a minimum
  - the org approves it (maker-checker)
  - approved payouts go into a payout batch and are posted
- **Performance report:** pieces, taka, delivery rate and return rate per reseller.

---

## 14. Branches and showroom POS

- A branch is a showroom unit with its own location, wallets (hand cash, bKash), staff and P&L. Branch managers don't see cost detail (D-014).
- **POS PWA:**
  - open a register or shift with opening cash; close with a cash count
  - barcode scanning (keyboard wedge), cart
  - discounts within the user's permission, promo codes
  - split payment across cash, bKash and card (posted as bank)
  - 80 mm receipts via print CSS
  - returns and exchanges by receipt lookup
- **Offline:**
  - sales queue in IndexedDB with a client UUID and an idempotency key
  - the server is authoritative
  - if stock is short at sync, the conflict becomes a manager review item; it is never silently dropped

---

## 15. Investors and company loans

### Investors

- Investor profile with KYC documents.
- Investments per org: amount, date, terms (D-019), lock-in, private documents.
- Distributions are declared per period per org, approved, then paid.
- Withdrawal requests go `requested → reviewed → approved (maker-checker) → paid`, or are rejected. Only `paid` posts to the ledger (D-117): an approval is a decision, not a payment. Nobody raises, reviews, approves or pays a withdrawal paid to themselves (D-314).
- The investor portal (inside the `portal` app, at `/investor`) shows the investor their own position, investments with their lock-in, documents (via signed URLs), the distributions declared to them and their withdrawal requests, one brand at a time (D-310, D-311). Investors read; the brand's accounts team raises a withdrawal request for them (D-312).
- 2FA is mandatory.

### Company loans

- A loan has a lender (bank, person or other, D-293), principal, annual rate in basis points, method (`flat | reducing`, D-020), tenure in months, the wallet it arrived in and a first due date. Recording it posts the receipt at once and writes the schedule in the same transaction (D-296).
- A pure function generates the schedule (`packages/domain/src/loans`, D-294): monthly, flat or reducing balance, integer poisha, largest remainder (flat) or last-instalment rounding (reducing). Principal sums exactly to the loan amount, which a deferred trigger checks again at commit (D-302).
- Reminders go out N days before each due date (default 3), in-app (`loan.instalment_due`) and via SMS through the notify module, exactly once per instalment (D-300).
- Payment postings split principal and interest (D-295). One whole instalment at a time, in order (D-297), through a `loan_repayment` approval when the brand's threshold requires it (D-298, D-299).
- Statements: schedule, repayments and totals, with the ledger's balance for the lender beside the schedules' (D-301).
- A loan recorded by mistake is voided once, by reversing its receipt journal, while nothing is repaid or waiting (D-304).

---

## 16. Message Hub and agent activity

> The Message Hub (Chatwoot, M27) and the agent activity extension (M28) are removed from scope (D-290, D-292).

### Message Hub

Message Hub is a self-hosted **Chatwoot** instance plus an ERP integration.

- **Inboxes per org:** Facebook, Instagram, WhatsApp (Cloud API), Telegram, website chat and TikTok.
  - TikTok conversations must be started by the customer, replies are allowed only within 48 hours, and only text, images and post shares are supported.
  - The "Google" channel is pending decision D-021: Google Business Messages was discontinued in 2024.
- **ERP side panel:** a Chatwoot Dashboard App (an iframe), served by the console at `/embed/chatwoot`.
  - It shows the customer's profile and history, fraud badge and recent orders.
  - It includes a create-order form prefilled from the conversation.
  - Host Chatwoot and the console under the same parent domain so session cookies work.
- **Webhooks from Chatwoot:**
  - link conversations to customers by phone
  - compute response-time stats per agent
  - store the conversation id on orders created from the panel
- Check Chatwoot's current API and webhook docs before building.

### Agent activity

- A Chrome MV3 extension (built with WXT), force-installed by Chrome policy on office PCs. Each device is enrolled to one employee with a one-time code.
- Heartbeats record the active tab's **domain only**, idle/active state and window focus. They are taken every 30 s and sent in batches every 2 min, with an offline buffer.
- The server aggregates time on assigned platforms (an allowlist per role: Chatwoot, the ERP console, Meta Business Suite, courier portals, …) against other domains, and reports per agent per day.
- Never capture URL paths, page content, keystrokes or screenshots.
- A signed staff policy is required before rollout (D-022).

---

## 17. Landing pages

> Removed from scope (D-290). Kept for reference only; do not build.

- **Editor:** Puck in the console.
- **Blocks** (`packages/landing-blocks`): Hero, ProductShowcase (live price and stock), VariantPicker + OrderForm, Countdown, Benefits, Testimonials, FAQ, TrustBadges, VideoEmbed, StickyOrderBar.
- **Storage:**
  - `landing.pages`: `org_id, slug, domain_id, status draft|published, current_version_id, seo, tracking config`
  - `landing.page_versions`: `puck_json, created_by`
  - `landing.domains`: hostname → org
- **Rendering:** `apps/sites` (Next.js App Router) resolves the org from the hostname and renders the published version statically. Publishing triggers on-demand revalidation through a signed webhook.
- **Order form:** posts to the public intake API with a Turnstile token. Pixel and CAPI events are deduplicated by `event_id`.

---

## 18. Analytics and leaderboard

- **Rollups:** `analytics.daily_org`, `daily_branch`, `daily_channel`, `daily_campaign`, `daily_agent`, one row per org per Asia/Dhaka day (and per branch, channel, campaign or agent). The `analytics.rollup` job rebuilds an org's days from the owning modules' `*.api.ts` — delete and insert in one `withOrg()` transaction — on order events (per org per ten-second bucket), nightly for the last seven days, and on request for up to 92 days (D-320). Each figure counts on the day its event happened (D-321).
- **Org dashboard** (`read Dashboard`, org_admin; D-325):
  - orders: placed, confirmed, delivered, returned, cancelled after confirming
  - delivered revenue, and gross profit (cost roles only)
  - AOV, return rate and delivery success
  - CPO, CPDO, ROAS
  - cash position, and stock value (cost roles only), read live (D-330)
  - by channel, showroom and campaign; best sellers; agent performance
- **Consolidated dashboard:** Super Admin only, every brand's totals and the group total from `daily_org` through `erp_analytics` (§5 exception 3).
- **Leaderboard (cross-org):**
  - compares normalized metrics: month-over-month revenue growth %, delivery success rate, return rate, ROAS, CPDO, AOV growth, pickup time (D-322). Response time left with the Message Hub (D-290).
  - ranks each metric, plus a composite score with configurable weights (D-323)
  - org admins see other orgs' **normalized metrics and ranks only**, never their raw financials (D-023, built as D-324)
  - computed on read from the rollups through `erp_analytics`; the only cross-org reads are the analytics module's (D-329)
- **Insights:**
  - rule-based suggestions, pure functions in `packages/domain/src/analytics/insights.ts` (D-326), e.g. "return rate outside Dhaka is 9 pp above the group median → require an advance delivery charge for outside-Dhaka COD"
  - an optional LLM narrative behind the flag `analytics.llm_narrative`, generated only from an allow-listed metrics payload (no PII) and cached daily; only a fake provider exists (D-327)
- **Export:** the brand's daily rollup as CSV or XLSX (D-328).

---

## 19. Realtime event catalog

### Transport and authorization

- Socket.IO namespace `/rt` on the API, with the Valkey adapter so it works across multiple instances.
- The handshake authenticates with the session cookie. The **server** puts the socket in rooms based on the user's memberships; clients never choose rooms.

### Rooms

- `user:{userId}`
- `org:{orgId}:role:{role}`
- `org:{orgId}:branch:{branchId}`
- `reseller:{resellerId}`
- `super`

### Rules

- Emit only after commit, from the outbox dispatcher.
- Payloads contain ids plus only those display fields every recipient role is allowed to see: never cost, never full addresses.
- Clients refetch details over REST, where authorization is enforced.
- Throttle high-frequency events to at most one per second per key.
- Every event type has a Zod schema in `packages/contracts/src/events.ts`.

### Catalog

| Event                                   | Rooms                                                                                                                                                             | Payload                                    | Purpose                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `order.created`                         | `org:role:sales`, `org:role:org_admin`                                                                                                                            | id, order_no, channel, total, created_at   | New-order alert; starts the pickup timer |
| `order.assigned` / `order.claimed`      | `org:role:sales`, `user:{assignee}`                                                                                                                               | id, assignee                               | Queue ownership                          |
| `order.status_changed`                  | `org:role:sales`, `org:role:warehouse`<br>`org:role:accounts` (delivered and returned only)<br>`reseller:{id}` (reseller orders)<br>`org:branch:{b}` (POS orders) | id, from, to, at                           | Live lists and dashboards                |
| `order.fraud_flagged`                   | `org:role:sales`, `org:role:org_admin`                                                                                                                            | id, trust_score, decision                  | Review queue                             |
| `delivery.updated`                      | `org:role:sales`, `reseller:{id}`                                                                                                                                 | order id, normalized status, at            | Tracking view                            |
| `delivery.booking_failed`               | `org:role:sales`, `org:role:org_admin`                                                                                                                            | order id, courier, error code              | Fix and retry                            |
| `settlement.imported`                   | `org:role:accounts`                                                                                                                                               | batch id, totals, exception count          | Reconciliation                           |
| `stock.available_changed`               | `org:role:sales`, `org:role:warehouse`; Beownz resellers for Beownz SKUs (throttled)                                                                              | sku id, location id, available             | Live availability                        |
| `stock.low`                             | `org:role:org_admin`, `org:role:warehouse`                                                                                                                        | sku id, location, available, reorder level | Replenishment                            |
| `wallet.balance_changed`                | `org:role:accounts`, `org:branch:{b}` (branch wallets)                                                                                                            | account id, balance                        | Cash position                            |
| `approval.requested`                    | `user:{each eligible checker}`                                                                                                                                    | request id, type, amount                   | Approvals inbox                          |
| `approval.decided`                      | `user:{requester}`                                                                                                                                                | request id, decision                       | Status                                   |
| `target.progress`                       | `user:{employee}`, `org:role:hr`                                                                                                                                  | target id, achieved, pct                   | Progress widgets                         |
| `leaderboard.updated`                   | `org:role:org_admin` (all orgs), `super`                                                                                                                          | snapshot id                                | Not emitted: computed on read (D-324)    |
| `payout.updated`                        | `reseller:{id}`, `org:role:accounts`                                                                                                                              | payout id, status                          | Reseller portal                          |
| `investor.withdrawal.updated`           | `user:{investor user}`                                                                                                                                            | request id, status                         | Investor portal                          |
| `pos.sale_synced` / `pos.sync_conflict` | `org:branch:{b}`                                                                                                                                                  | sale id / conflict id                      | POS status                               |
| `loan.instalment_due`                   | `org:role:accounts`, `org:role:org_admin`                                                                                                                         | loan id, instalment id, seq, due, amount   | Loan reminder in the inbox (D-300)       |
| `notification.created`                  | `user:{id}`                                                                                                                                                       | notification id, title key                 | In-app inbox                             |
| `job.failed`                            | `org:role:org_admin`, `super`                                                                                                                                     | job type, ref, error code                  | Operations                               |

---

## 20. Background jobs

Jobs run on pg-boss, with queues named `module.action`.

- Every job is idempotent, retries with exponential backoff and has a dead-letter queue.
- A job that lands in the dead-letter queue emits `job.failed`.
- Cron schedules run in Asia/Dhaka time.

| Queue / cron                      | When                                                     | Notes                                           |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `delivery.book_parcel`            | On event                                                 | 5 retries, then dead-letter → booking_failed    |
| `delivery.process_webhook`        | On receipt                                               | Raw payload is stored before processing         |
| `delivery.poll_status`            | Every 30 min for stale active parcels                    | Respects courier rate limits                    |
| `delivery.import_settlement`      | On upload or API fetch                                   | Needs approval before posting                   |
| `inventory.reconcile_levels`      | Nightly 02:00                                            | Drift alert                                     |
| `crm.schedule_segments`           | Nightly 02:30, one `crm.score_segments` per brand        | Segments replaced, never accumulated (D-211)    |
| `crm.schedule_greetings`          | Daily 09:00, one `crm.greet_occasions` per brand         | One greeting per buyer per occasion per year    |
| `marketing.schedule_spend_import` | Daily 06:00, one `marketing.import_meta_spend` per brand | The last three days, re-imported (D-254)        |
| `marketing.import_meta_spend`     | From the schedule, or on request                         | Idempotent per (campaign, day) (D-252)          |
| `marketing.capi_delivered`        | Enqueued in the delivering transaction                   | One Purchase per order, sent once (D-262)       |
| `analytics.rollup`                | On order events, per org per 10 s bucket                 | Rebuilds the org's days, idempotent (D-320)     |
| `analytics.schedule_rollup`       | Nightly 03:00, one `analytics.rollup` per brand          | The last 7 days (D-320)                         |
| `hr.refresh_target_progress`      | On an order status change, per brand per 10 s bucket     | Recomputes; `target.progress` on change (D-279) |
| `loans.schedule_reminders`        | Daily 10:00, one `loans.remind_instalments` per brand    | Once per instalment, in-app and SMS (D-300)     |
| `notify.send`                     | On demand                                                | Respects quiet hours                            |
| `files.process_image`             | On upload                                                | sharp variants, EXIF stripped                   |
| `ops.backup_verify`               | Weekly (staging)                                         | Restore to a scratch database and verify        |

---

## 21. Integrations

| Integration                                      | Phase       | Interface                       | Notes                                                      |
| ------------------------------------------------ | ----------- | ------------------------------- | ---------------------------------------------------------- |
| Couriers (Steadfast, Pathao, RedX; others later) | 1–2         | CourierAdapter                  | Official docs and user credentials only                    |
| Fraud providers (Steadfast via fraudjs; others)  | 1–2         | FraudSignalProvider             | Cached, throttled                                          |
| Cloudflare Turnstile, R2                         | 1           | —                               |                                                            |
| BD SMS gateway                                   | 2           | SmsProvider                     | Branded sender IDs need approval, so apply early (D-012)   |
| Advance payment gateway (bKash or aggregator)    | 2, optional | PaymentProvider                 | Only if the client wants online collection (D-013)         |
| Meta Marketing API, Conversions API              | 3           | MetaGateway (unverified, D-257) | System-user tokens per org, sealed                         |
| Biometric attendance                             | 3           | AttendanceImporter              | CSV first                                                  |
| LLM for insight narratives                       | 4, optional | InsightNarrator                 | Metrics only, feature-flagged                              |
| Chatwoot                                         | 5           | ChatwootClient                  | Webhooks plus the Dashboard App                            |
| WhatsApp Cloud API templates                     | 5           | WhatsAppProvider                | For templated notifications if Chatwoot doesn't cover them |

Rules for every integration:

- Every adapter has a fake implementation for tests and local development.
- Secrets come from config.
- Outbound calls run only in workers. The exceptions are synchronous fraud cache reads and Turnstile verification.
- Log request ids. Never log secrets or full PII.

---

## 22. Files and documents

- **Storage driver:** an interface with a `local` driver (development and tests) and an `r2` driver (staging and production).
  - Private bucket (receipts, invoices, legal documents, KYC, payslips): served only through short-lived signed URLs after an authorization check.
  - Public bucket (product images, landing page assets): served through the CDN.
- **Uploads:**
  - presigned PUT, with size and MIME limits
  - each upload creates a `files.objects` row with sha256, owner and visibility
  - images are re-encoded with sharp into thumb, card and full sizes, with EXIF stripped
- **PDFs:**
  - HTML templates are rendered on the server and converted by **Gotenberg** (headless Chromium), so Bangla conjuncts shape correctly
  - embed Noto Sans Bengali or Hind Siliguri
  - templates: invoice, packing slip, courier label, reseller invoice, payslip, statements
  - every template takes the active org's `brand` block (§24) for logo, legal name, address, VAT number and footer. The reseller invoice substitutes the reseller's business name (§13).

---

## 23. API conventions

- **Resources:** REST under `/v1` with plural kebab-case resources.
- **Lists:**
  - cursor pagination: `?cursor=&limit=50`, maximum 200
  - Zod-validated filters
  - a whitelist of sortable fields
- **Errors:** RFC 9457 problem+json, with stable `code`s from `packages/contracts/src/errors.ts`, e.g. `STOCK_INSUFFICIENT`, `ORDER_TRANSITION_INVALID`, `PERIOD_CLOSED`, `APPROVAL_REQUIRED`. Until M04, error bodies carry `{ code, message }` (D-087).
- **Idempotency:** mutations accept an `Idempotency-Key` header, stored for 24 hours per user and route.
- **Typed client:** OpenAPI is generated from the contracts, and `packages/api-client` is regenerated from it. CI fails on drift. Frontends use only the generated client.
- **Public API** (`/public/v1/*`):
  - a per-site API key
  - an HMAC signature over body + timestamp, with a 5-minute window
  - a Turnstile token for browser forms
  - rate limits per IP and per phone
  - an idempotency key is required
- **Webhooks** (`/hooks/v1/<provider>`): verify per provider, keep the raw body, return 2xx fast, and process in a worker.

---

## 24. Frontend conventions

### Core stack

- React + TypeScript on Vite
- TanStack Router: typed routes, with filters kept in URL search params
- TanStack Query for server state
- React Hook Form with the shared Zod schemas
- TanStack Table for grids

### Design principles (D-033)

Staff operate this product for eight hours a day, so "premium" here means confidence and calm, not decoration. Five rules settle every visual question:

1. **Restraint.** Neutral chrome, one accent. Colour carries meaning -- status, money direction, destructive -- and is never decoration. A rainbow ERP reads cheap and makes status colours meaningless.
2. **Density that respects the operator.** Table rows are 36 px, not 64. Compactness comes from a tight type scale and line height, never from removing breathing room around the content region. More rows on screen is a feature, not a compromise.
3. **Depth by hairline, not shadow.** 1 px low-contrast borders separate regions. Shadows appear only on floating layers: popover, dialog, command palette, toast.
4. **The keyboard is the premium feature.** A command palette, visible shortcut hints and a focus ring you can actually see. The order desk's 30-second target depends on this, not on decoration.
5. **Every state is designed.** Loading, empty, error and permission-denied are screens, not afterthoughts. Skeletons are shaped like the content they replace; a bare spinner is a last resort.

### Design tokens

Tokens live in `packages/ui/src/styles/tokens.css` and reach components through the Tailwind preset. No component hard-codes a colour, radius, shadow or duration.

- **Colour is OKLCH**, as CSS custom properties. Every semantic role (`--background`, `--foreground`, `--muted`, `--border`, `--ring`, `--primary`, `--destructive`, `--success`, `--warning`) has a light and a dark value. Accent shades are _derived_ from one hue and chroma pair, so changing an org's brand hue re-derives hover, active, subtle background, ring and foreground-on-accent with their contrast intact. This is what makes five brands cost one design system instead of five.
- **Type:** Inter for Latin and all numerals, Hind Siliguri for Bangla. Both self-hosted as subset woff2 with `font-display: swap`. The `@font-face` rules carry `size-adjust` so a mixed bn/en string sits on one optical baseline. Without it, mixed text looks ragged, which is the fastest way for a Bangla product to look unfinished.
- **Numerals:** `font-variant-numeric: tabular-nums` on every money value, quantity, metric tile and numeric table column. Money columns are right-aligned.
- **Radius:** one `--radius` (8 px) with derived `sm`/`md`/`lg`. **Spacing:** a 4 px base scale.
- **Motion:** 120-200 ms, ease-out, on enter, exit and state change only. Everything honours `prefers-reduced-motion`.
- **Themes:** light and dark are both first-class and maintained together. Dark is a designed theme, not an inversion. Theme follows the OS by default and is overridable per user.

### Accessibility floor

Enforced in CI wherever it is testable.

- Text meets WCAG AA contrast (4.5:1 body, 3:1 large text and UI boundaries) in both themes.
- Every interactive element is reachable and operable by keyboard, with a visible focus ring.
- Dialogs trap focus and restore it on close. Icon-only buttons carry accessible names.
- Hit targets are at least 40 px in the POS and portal (touch) and at least 28 px in the console (pointer).
- Colour is never the only signal: a status badge pairs its colour with a label.

### UI rules

- shadcn/ui and Tailwind only: no CSS modules, no inline style objects. shadcn components are re-tuned to these tokens when adopted, never left at library defaults.
- Icons from lucide-react only, at a consistent stroke width and size scale.
- Never use emojis as UI elements.

### Per-org branding (D-034)

`org.organizations.brand` (jsonb) holds `logo_file_id`, `logo_dark_file_id`, `accent` (OKLCH hue and chroma), `legal_name`, `address`, `vat_no` and `invoice_footer`. It drives:

- the console, portal and POS accent and logo for the active org
- the login screen when the org is known from the route or hostname (§6)
- every document template in §22: invoice, packing slip, label, reseller invoice, payslip, statements

Chrome stays neutral in every org. The brand shows in the accent, the logo and the documents. Brand values are data, so adding a sixth brand is a row, not a release.

### Language (D-036)

- Every string goes through `packages/i18n` (bn, en). A key missing in either language fails CI.
- **The staff console defaults to English. Everything customer-facing is Bangla:** invoices, labels, payslips, SMS, notifications, the reseller portal and landing pages. Any user can switch their own console language.
- Latin digits by default, with a per-user option for Bangla digits.

### Formatting

- Money always renders through `<Money>` / `formatMoney`
- Dates display in Asia/Dhaka

### Permissions

The UI uses the shared CASL definitions to hide or disable controls. Security never depends on the UI.

### Order desk

- Keyboard-first, with shortcuts shown in the app
- Target: a trained agent enters an order in under 30 seconds

### Every screen

Handles loading, empty, error and permission-denied states. Routes are code-split.

### PWAs (portal, pos)

Installable, with an offline shell and web push (Android first).

---

## 25. Security

- **Authentication and sessions:**
  - as in §6
  - CSRF protection for cookie-authenticated mutations (Origin checks plus a double-submit token)
  - strict CORS and security headers
  - rate limits on login, OTP and the public API
- **Application-level encryption** (AES-256-GCM, key from the secret manager, key id stored for rotation) applies to:
  - national ID numbers
  - bank account and bKash payout numbers
  - investor KYC fields
- **Secrets** are never committed. `.env.example` lists names only.
- **Audit log:** every mutation records actor, org, action, entity, before/after (with sensitive fields redacted), IP and user agent.
  - Services write their entry inside the mutation's transaction (`AuditService.record(tx, …)`); the interceptor is a net for routes that do not, and strips cost fields before writing (D-064).
  - Redaction removes credential-named fields and masks phone numbers both under phone-named keys and anywhere in free text.
  - Switching org is audited into the org being entered. Better Auth's credential events (sign-in, second factor, 2FA changes, password set or changed, sign-out) are audited into every org the user belongs to, without the request body (D-066).
- **Controls:** maker-checker (§6) and period locks (§7).
- **Reviews:**
  - CI scans dependencies
  - Claude Code's `/security-review` runs at M02a, M02b, M03, M14b and M30
- **Backups:**
  - managed point-in-time recovery, plus a nightly logical dump to a second provider
  - the restore drill must be documented and actually performed before go-live
- **Privacy:**
  - mask phones in logs (017******89)
  - analytics exports and LLM inputs carry no PII
  - agent tracking is domain-only (§16)

---

## 26. Observability and operations

- **Logging:** pino structured logs carrying request id, org id and user id, with redaction.
- **Errors:** Sentry on the server and all apps.
- **Tracing:** OpenTelemetry traces and metrics.
- **Health endpoints:**
  - `/health/live`
  - `/health/ready`, which checks the database, Valkey and pg-boss
- **Failed jobs:** a view in the console for super_admin, with retry.
- **Uptime and alerts:**
  - uptime monitoring
  - alert rules for job failures, stock drift, settlement exceptions, error-rate spikes and slow queries

---

## 27. Testing strategy

| Layer        | Tooling                                                | What it covers                                                                                                       |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Unit         | Vitest                                                 | Everything in `packages/domain`                                                                                      |
| Property     | fast-check                                             | Money allocation, posting balance, WAC, reservations, schedules, target splits                                       |
| Integration  | Vitest + Testcontainers Postgres                       | RLS, grants, triggers, repositories and services with real transactions and concurrency                              |
| API          | Role-matrix tests generated from the permission matrix | `assertNoCostFields` on every catalog, order and stock response for non-cost roles                                   |
| E2E          | Playwright                                             | Each milestone's critical flows; the PWAs are also tested offline                                                    |
| Adapters     | Contract tests with recorded fixtures                  | Live sandbox tests run behind env flags and are skipped (with a note) when credentials are missing                   |
| Golden books | Scripted business days                                 | Supply → orders → deliveries → returns → settlements → payroll, asserting exact trial-balance, stock and P&L numbers |

`pnpm verify` runs format check, lint, typecheck, unit and integration tests, build, the migration-immutability check, the schema-drift check and the route-matrix gate. It must pass before anything merges to main.

---

## 28. Environments and deployment

- **Local:**
  - Docker Compose runs Postgres 17, Valkey and Gotenberg (Chatwoot optional from Phase 5)
  - `pnpm dev` starts every app
- **Staging and production** (Singapore region):
  - managed PostgreSQL with point-in-time recovery
  - two or more VMs running Docker (api, worker, Valkey, Gotenberg; Chatwoot later), deployed with Kamal
  - console, portal and pos (static builds) on Cloudflare Pages
  - `sites` on Vercel (D-026)
  - Cloudflare in front: DNS, WAF, Turnstile, R2
  - keep production off shared agency servers
- **Migrations** run as a release step using the owner role. The app runs as `erp_app`.
- **Feature flags:** an `org.feature_flags` table (D-031), so unfinished modules can ship dark.
- **Runbooks** in `docs/runbooks/`: deploy, rollback, restore, rotate secrets, courier outage, month-end close, Chatwoot setup.

---

## 29. Performance targets

| Operation                                            | Target                                               |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Order desk customer lookup + fraud badge (cache hit) | p95 < 300 ms                                         |
| SKU search                                           | p95 < 200 ms on 20k SKUs                             |
| Order save                                           | p95 < 400 ms                                         |
| Public intake API                                    | p95 < 500 ms at 20 req/s sustained                   |
| Reports over 12 months of one org                    | p95 < 3 s (use rollups)                              |
| Console first load                                   | < 2.5 s on 4G; initial route bundle ≤ 250 KB gzipped |
