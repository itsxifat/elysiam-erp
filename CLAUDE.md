# Elysium Mother ERP

One ERP for five sister fashion brands in Bangladesh (Elysiam Lifestyle BD, Oura Lifestyle, Orvo, Wear X Clothing, Beownz). It covers:

- COD e-commerce order operations and courier sync
- showroom accounting and POS
- a reseller platform (Beownz)
- HR and payroll
- investors

Each brand is an isolated org. Super Admin sees everything.

## Where things are

- `docs/architecture.md` is the engineering spec and source of truth. Read only the sections your milestone cites.
- `docs/milestones.md` is the build plan: one milestone per session, each with acceptance checks.
- `docs/decisions.md` holds resolved decisions, assumed defaults and open client questions. It overrides architecture.md.
- `docs/progress.md` is the session log. Read the last entry when you start; append yours when you finish.
- `docs/client-spec/` holds the client's original Bangla spec (PDF). Use it to double-check intent.
- `docs/plans/` holds one plan file per milestone.
- Start every milestone with `/milestone <ID>`.

## Stack

- Language and repo: TypeScript everywhere, pnpm + Turborepo.
- Server: NestJS (Fastify) with separate API and worker processes.
- Data: PostgreSQL 17 with row-level security, Drizzle ORM, pg-boss for jobs.
- Realtime, auth, permissions: Socket.IO + Valkey, Better Auth, CASL.
- Staff and partner UIs: React + Vite, TanStack Router/Query/Table, shadcn/ui + Tailwind, lucide-react, React Hook Form + Zod.
- Landing pages (Next.js + Puck, `apps/sites`, `packages/landing-blocks`) and the Chatwoot inbox are removed from scope (D-290); the scaffolds stay unused.
- Documents and files: Gotenberg for PDFs, Cloudflare R2 for storage.
- Tests: Vitest, fast-check, Testcontainers, Playwright.

## Layout

```
apps/      server (api + worker entrypoints, src/modules/*), console, portal, pos, sites, extension
packages/  db, domain, contracts, api-client, ui, i18n, integrations, landing-blocks, config
infra/     docker compose, Dockerfiles, deploy config
scripts/   verify helpers
docs/      spec, milestones, decisions, progress, plans, runbooks
```

## Commands (keep this list true)

- Setup: `pnpm i`, `pnpm setup:env`, `docker compose -f infra/docker-compose.dev.yml up -d --wait`, then `pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed`
- `pnpm db:bootstrap` creates the three database roles. Once per database, and the only step needing a superuser.
- `pnpm dev` runs every app. Filter with `pnpm --filter @elysium/<app> dev`.
- `pnpm --filter @elysium/server start:camera` (build the server first) runs the camera process (M38c, `dist/main.camera.js`): it records the packing tables' IP cameras entered in Orders → Pack → Settings → IP cameras with ffmpeg (`FFMPEG_PATH`, else `ffmpeg` on the path) into `CAMERA_BUFFER_DIR` and cuts each packing's video. `pnpm dev` does not start it; on a brand server it is the compose file's `camera` service.
- `pnpm db:generate` creates a migration from schema changes. `pnpm db:migrate` applies them as `erp_owner`, `pnpm db:seed` loads geography, the five orgs and each org's chart of accounts (with a hand-cash wallet per branch). `pnpm db:seed --brand <slug>` (or `SEED_BRANDS=<slug>`) seeds that one brand, for a brand's own database (M31). The seed is idempotent.
- `pnpm db:dev-users` creates local sign-in users (hr, warehouse, branch_manager, sales — the roles with no 2FA wall) through the real invite flow. Local databases only; the password is random per run and written only to the gitignored `packages/db/.dev-users.local.json`.
- `pnpm migration <command> --org <slug>` runs a brand's data migration (M14a): `dry-run` and `commit` (`--kind <skus|customers|opening_stock|supplier_balances|wallet_balances|courier_cod> --file <csv>`), `discard --batch <id>`, `status`, `post --as-of <date> --approved-by "<accountant>"`, `reconcile [--out <csv>]` and `sign-off --by "<accountant>"`. Build the server first. Sample files are in `apps/server/migration-sample/`. `pnpm migration legacy-customers --org <slug> dry-run|commit --file <users.json>` (M34) imports the old website's shoppers from a `mongoexport --jsonArray` of its `users` collection: accounts with their bcrypt hashes, buyers by phone, all or nothing, idempotent (`docs/runbooks/website-buying.md`).
- `pnpm demo:org` seeds the training org and imports the anonymised sample files through the real importers. Build the server first; it needs `DATABASE_URL` for the importers and `DATABASE_OWNER_URL` for the seed, like `db:seed`. Idempotent.
- `pnpm preview:local` makes the whole ERP previewable on this PC: a fresh `elysium_preview` database on the dev stack's Postgres (never `elysium_dev`), migrated and filled by `preview:seed`, then the API, worker, console, portal and till on 3000 and 5173-5175. `--keep` restarts on the existing data, `--no-start` stops after seeding, `--brand <slug>` previews one brand's own ERP (only that brand seeded and demoed, the API and worker run with `ERP_BRAND_SLUG`). Sign-ins go to the gitignored `preview-credentials.local.md`; logs to `.preview/logs/`. See `docs/runbooks/preview-kit.md` and, for what to try, `docs/testing-guide.md`.
- `pnpm preview:seed` (build the server first) runs the normal seed and the training brand's import, creates one sign-in per role with new random passwords, then a few weeks of demo work in Elysiam Lifestyle BD through the real routes, and fails if the books disagree (trial balance, stock against 1300 Inventory, COD against courier receivables). Idempotent. It writes only to a database marked as a preview (comment `elysium-preview`, which `preview:local` sets), reached by the same database through `DATABASE_URL` and `DATABASE_OWNER_URL`, where nobody outside the preview can sign in. `--out -` writes the sign-ins to stdout (the preview server's way, in the `worker` container). `--brand <slug>` (or `ERP_BRAND_SLUG`) seeds and demos that one brand.
- `pnpm test` runs unit + integration tests. `pnpm e2e` runs the console's Playwright specs against a stubbed API.
- `pnpm --filter @elysium/console e2e:stack` runs the console's `*.stack.ts` specs against the real stack: a throwaway database, the built API and worker, and the console. Build the server first. It covers M11 checks 1 and 4, M05's quality checks, M08 checks 2 and 6 (`money.stack.ts`, with the wallet setup screen), M16 check 5 (`order-desk.stack.ts`), M16's buyer and campaign screens (`crm.stack.ts`), M17's advance claim, verification and returns-by-reason screens (`advances.stack.ts`), M35a's discount and flash-sale screens (`offers.stack.ts`), the order lifecycle buttons, bulk pack and settings screens (`order-lifecycle.stack.ts`), the Staff screen's invite, password reset, second-factor reset and deactivation journeys (`users.stack.ts`), the catalog and stock journeys (`catalog-stock.stack.ts`: setup, new product with sizes, colours and opening stock, adjust, transfer, receive, the Stock page) and M33 check 4 (`website.stack.ts`: Website settings, hero slides, menu, size charts, the website key and a product's Website card, read back through the signed storefront API) and M38a checks 1 to 3 (`barcodes.stack.ts`: a product with stock in hand at a cost, its 38 × 25 mm sticker PDF checked page by page, a scan opening the variant), M34's Website → Payments, Email and Customers screens (`website-buying.stack.ts`), M35b's campaign links, tracking, marketplace, Scan page and label sheet (`web-marketing.stack.ts`), M39a's delete and archive journeys (`delete-archive.stack.ts`: a category emptied into another and deleted, a size archived with its variants, a list reordered, a location, a size chart, a discount, a branch, an expense head), M39 checks 3 to 6 (`variant-pricing.stack.ts`: prices by size, a buying price per variant, average cost and margin, a bulk +10 %, a standard buying price prefilling a receipt, duplicate, a role without cost), M38b checks 1 and 2 (`packing.stack.ts`: a packer scans an order's pieces, a wrong piece refused, the order packed, the video recorded from a fake camera, uploaded and played), M40's My account (`account.stack.ts`: renaming, setting up two-step sign-in from the QR code's key, signing another device out, turning two-step off, changing the password with the other devices signed out), M41 checks 1 to 5 (`order-workflow.stack.ts`: two agents racing to take an order, an admin acting on an agent's order only after "go ahead" while the agent's dock hears it, an auto-assign offer accepted from the dock's card, verification calls, the hub printing, packing and handing over at its location, the team board), M42's inbox (`inbox.stack.ts`: Settings → Inbox, signed fake Meta webhooks for each channel with a bad signature refused, an agent taking a conversation, saving the phone found in it and seeing that customer's orders, replying through the job, a note, a product of interest, Create order, a second agent acknowledging the owner who is told live, the 24-hour window's refusal, Fraud on the desk), and writes review screenshots to `docs/review/M05/`, `docs/review/M08/`, `docs/review/M16/`, `docs/review/M17/`, `docs/review/M35a/`, `docs/review/gaps/`, `docs/review/gaps-users-auth/`, `docs/review/catalog-stock/`, `docs/review/M33/`, `docs/review/M34/`, `docs/review/M35b/`, `docs/review/M38a/`, `docs/review/M38b/`, `docs/review/M39/`, `docs/review/M40/`, `docs/review/M41/` and `docs/review/M42/` (`a-*.png` and `b-*.png`). `E2E_API_PORT` and `E2E_CONSOLE_PORT` move it off 3110 and 5183 when another worktree holds them. One spec alone: `pnpm --filter @elysium/console exec playwright test -c e2e/stack.config.ts users.stack.ts`.
- `node scripts/ncom-check.mjs --url <ERP>/ncom/<org id>/v1 --key <id> --secret <secret>` and `node scripts/ncom-order-check.mjs --url <ERP>/ncom/<org id>/orders --key <id> --secret <secret> --product <id> --variant <id>` are the old website's ncom.bd checkers, ported (M35b check 4; `docs/ncom-connector.md`). The order checker files test orders: staging brands only.
- `pnpm --filter @elysium/pos e2e` runs the till's offline Playwright spec (M23 checks 1 and 4) against its stub API, and pictures the English receipt in `docs/review/M43/`. With Gotenberg up, `pnpm test` renders every printed document (`files/pdf/documents-review.test.ts`: page sizes, no Bangla) and rewrites the other `docs/review/M43/` pictures. It also rasters a lot's label and slip for a 203 dpi thermal printer, reads the lot barcode back off the dots and writes the bitmaps to `docs/review/M46/` (`packing/printers/render.gotenberg.test.ts`, M46).
- `pnpm --filter @elysium/portal e2e:stack` runs the portal's `investor.stack.ts` against the real stack (a throwaway database seeded through the real API, the built API and worker, and the portal). Build the server first. It covers M25 check 1's browser half and writes review screenshots to `docs/review/M25/`.
- `pnpm --filter @elysium/console e2e:preview` builds a throwaway preview the way `preview:local` does (database `elysium_preview_e2e`, API 3130, apps 5193-5195), signs in as every role from the credentials file, enrolling two-step login where required, opens each area's main screen, runs axe on each (WCAG 2.1 AA, serious and critical, light and dark, M30's accessibility pass) and writes screenshots to `docs/review/preview/`. Build every package first (`pnpm turbo run build`): the apps read the workspace packages' `dist`.
- `pnpm verify` runs format check, lint, typecheck, tests, build, the console bundle budget, the white-label check, the migration-immutability check, the schema-drift check, the route-matrix gate, the i18n check and the api-client drift check. It is the gate for every commit to main.
- `pnpm check:white-label` (build first) scans the built console, till and portal (`dist`: scripts, styles, pages, manifests, file names) and the shared locale files for the product's old name and the brands' names, and fails on a hit or on a published source map (M31, D-472): a brand's ERP names no other brand.
- `pnpm check:bundle` is the console's initial-route budget on its own: 250 KB gzipped, fonts excluded. Needs a console build first.
- `pnpm check:routes` is the route-matrix gate on its own: every route declares an ability (or `@AuthenticatedOnly` / `@Public`), and every non-public route is in `apps/server/src/platform/auth/route-matrix.manifest.ts` with a fixture in the generated route-matrix suite. Needs a build first.
- `pnpm report:routes` (build first) writes `docs/review/M30/route-report.md`: every route with its declared ability, its route-matrix fixture and the test files that call it (M30 check 3).
- `pnpm load:test [desk|intake]` (build the server first; Docker and the dev stack up; run under the heavy lock) runs the k6 load test (M30 check 1, D-361) on a throwaway local database at §29's sizes, with the built API and worker on port 3120 and k6 in the `grafana/k6` image, and writes the p95s to `docs/review/M30/`. Local only: never point it at the preview or any shared server.
- `pnpm admin:bootstrap --email <address> --name "<name>" [--console-url <url>]` (build the server first) creates the first super admin on a new database and prints a one-time `/accept-invite` link (M30). It refuses once a super admin other than an owner exists (D-477). See `docs/runbooks/deploy.md`.
- `pnpm admin:website-key --label "<label>"` and `pnpm admin:website-site-url --url https://<website>` (build the server first; in the server image `node dist/main.admin.js website-key …`) connect the brand's website from the server (D-582): the first issues a storefront site key for `ERP_BRAND_SLUG` (else the database's one brand) and prints only `ERP_SITE_KEY_ID=…` and `ERP_SITE_SECRET=…` on stdout, for piping into the website's env file (needs `INTAKE_KEY_SECRET`); the second saves Website → Settings' Site URL. Both are audited as `system:admin-cli`. See `docs/runbooks/brand-deploy.md` §5.
- One ERP per brand (M31): `ERP_BRAND_SLUG=<slug>` makes the API and worker serve that brand alone and refuse a database holding any other real brand. On the brands server, `sh infra/brand/new-brand.sh <slug> <admin-host>` writes a brand's `.env.brand` with fresh secrets, and `sh infra/brand/deploy.sh <user@server> <slug|all> [commit]` deploys one brand or all (`docs/runbooks/brand-deploy.md`). `OWNER_LINK_PUBLIC_KEY` turns on the owner sign-in link (`POST /v1/auth/owner-link`, the console's `/owner-link#token=…`).
- The mother ERP (M32, `apps/mother-server`, `apps/mother-console`, architecture §30): `pnpm mother:db:bootstrap` (its roles, once per database), `pnpm mother:db:migrate`, `pnpm mother:db:generate`, `pnpm mother:bootstrap --email <address> --name "<name>"` (the first owner's one-time link), `pnpm mother:people reset-two-factor --email <address>` (break-glass, audited), `pnpm mother:brands list|add|set-connection|rotate-key|test` (the brand registry, changed only here, never in the console, D-700; a read connection comes from `MOTHER_BRAND_READ_URL` and is printed only as its fingerprint) and `pnpm mother:dev`. `pnpm --filter @elysium/mother-console e2e:stack` runs its stack spec: two brand databases filled by `preview:seed --brand`, each brand's own API, the mother's API, worker and console (build the brand server, the mother server and the console first; `TEST_DATABASE_URL` is the dev Postgres's admin URL); screenshots to `docs/review/M32/`. On servers: `sh infra/mother/new-env.sh <domain> <brands host> ~/mother/.env.mother` once, then `sh infra/mother/deploy.sh <user@server> [commit]`, from the brands' commit (`docs/runbooks/mother-deploy.md`). A brand opts into being read by setting `BRAND_REPORTING_DB_PORT` in its `.env.brand`.
- `pnpm api:client` regenerates the typed OpenAPI client. Live from M04.
- `pnpm bench` is the shared benchmark harness; every latency acceptance check measures through it. `pnpm bench --list` names the module benches; `pnpm bench catalog` (M06 check 2) runs under tsx against the dev stack's Postgres. With no argument it runs the harness's self-test.
- `pnpm fonts:fetch` re-vendors Inter and Hind Siliguri and recomputes the Bangla `size-adjust` (documents use Inter alone; Hind Siliguri only draws Bangla a person typed, D-753).

## Invariants: never break these

1. Money is integer poisha: `bigint` columns named `*_poisha`, `Poisha` in TypeScript. No floats. Round only through `packages/domain/src/money`.
2. Journals always balance and never change after posting.
   - Post only via `ledger.post()`, using a posting-rule function and a deterministic idempotency key.
   - Fix mistakes with reversal journals.
3. Stock changes only through inventory movements.
   - `stock_levels` never goes negative.
   - Reserve with the atomic conditional UPDATE, never read-then-write.
4. Every tenant table has `org_id` plus RLS (ENABLE and FORCE).
   - Tenant queries run inside `withOrg()`.
   - Only the analytics module uses the cross-org read-only role.
5. Purchase cost lives only in supply, inventory and ledger.
   - Responses go through `serializeFor()`.
   - Roles without `read:cost` never receive cost fields.
6. No external call (courier, SMS, Meta) runs inside a DB transaction. Enqueue a pg-boss job in the same transaction instead.
7. Order status changes only through the domain state machine in `packages/domain`.
8. Business dates are Asia/Dhaka calendar dates. Store timestamps as `timestamptz`.
9. Never edit a committed migration. Add a new one.
10. Secrets and personal data never go into code, logs, fixtures or LLM prompts. Mask phone numbers in logs.
11. Business logic with arithmetic or state lives in `packages/domain` as pure, tested functions.
12. Modules talk only through each other's `*.api.ts` service interfaces or events, never directly through each other's tables.

## Conventions

- Naming:
  - files are kebab-case
  - types are PascalCase
  - database identifiers are snake_case
  - API paths are `/v1/kebab-case`
- Errors: throw typed domain errors with codes from `packages/contracts/src/errors.ts`. The API returns problem+json.
- Validate at the edge with the shared Zod schemas in `packages/contracts`.
- UI rules (architecture §24, D-033):
  - modern, premium and restrained: neutral chrome, one accent, 1px hairlines, designed light and dark themes
  - every colour, radius, shadow and duration comes from the tokens in `packages/ui`; never hard-code one
  - use shadcn/ui + Tailwind, and lucide-react icons only
  - never use emojis as UI elements
  - every string goes through i18n, English only (D-750): no Bangla anywhere, documents, SMS, emails and receipts included, and no language switch
  - money on screens is shown with `<Money>`, in tabular numerals; on paper and in messages it is `Tk 1,250.00` through `takaText` (D-751)
  - WCAG AA contrast in both themes; every interactive element is keyboard-reachable with a visible focus ring
- Integrations:
  - build only against official docs and real credentials; never invent endpoints or fields
  - mark unverified adapters in decisions.md
- Prefer plain, explicit code. Every new dependency gets a one-line justification in your progress entry.

## Workflow

- One milestone per session: plan, wait for approval, then build. Stay inside the milestone's scope and log extra ideas as follow-ups.
- Blocked by a missing credential or an OPEN decision:
  - implement the ASSUMED default behind configuration
  - record it in decisions.md, then continue
  - ask only when no safe default exists
- Write tests alongside the code. Changes to money, stock, tenancy or permissions need property-based or integration tests against real Postgres.
- Before finishing:
  - run `pnpm verify` and every acceptance check
  - print a Verification Report
  - update docs/progress.md, then commit
- Use the `ledger-auditor` subagent on any diff touching ledger, inventory, tenancy, permissions, payouts or payroll.
- Run the `acceptance-auditor` subagent before declaring a milestone done.
- Git:
  - Conventional Commits (`feat(m07): ...`)
  - one branch per milestone (`m07-stock-ledger`)
  - merge to main only when verify is green

## Definition of done (every milestone)

- Every acceptance check in docs/milestones.md passes and appears in the Verification Report with evidence.
- `pnpm verify` exits 0, and e2e tests pass for any flows touched.
- No TODO without a follow-up entry, and no skipped test without a stated reason.
- Docs are current:
  - progress.md has an entry for this milestone
  - decisions.md has rows for any new assumptions
  - architecture.md reflects any design change, backed by a decision row
  - this file's Commands section matches reality
