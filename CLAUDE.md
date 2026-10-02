# Elysium Mother ERP

One ERP for five sister fashion brands in Bangladesh (Elysium Lifestyle BD, Oura Lifestyle, Orvo, Wear X Clothing, Beownz). It covers:

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
- `pnpm db:generate` creates a migration from schema changes. `pnpm db:migrate` applies them as `erp_owner`, `pnpm db:seed` loads geography, the five orgs and each org's chart of accounts (with a hand-cash wallet per branch). The seed is idempotent.
- `pnpm db:dev-users` creates local sign-in users (hr, warehouse, branch_manager, sales — the roles with no 2FA wall) through the real invite flow. Local databases only; the password is random per run and written only to the gitignored `packages/db/.dev-users.local.json`.
- `pnpm migration <command> --org <slug>` runs a brand's data migration (M14a): `dry-run` and `commit` (`--kind <skus|customers|opening_stock|supplier_balances|wallet_balances|courier_cod> --file <csv>`), `discard --batch <id>`, `status`, `post --as-of <date> --approved-by "<accountant>"`, `reconcile [--out <csv>]` and `sign-off --by "<accountant>"`. Build the server first. Sample files are in `apps/server/migration-sample/`.
- `pnpm demo:org` seeds the training org and imports the anonymised sample files through the real importers (needs `DATABASE_OWNER_URL`, like `db:seed`). Idempotent.
- `pnpm test` runs unit + integration tests. `pnpm e2e` runs the console's Playwright specs against a stubbed API.
- `pnpm --filter @elysium/console e2e:stack` runs the console's `*.stack.ts` specs against the real stack: a throwaway database, the built API and worker, and the console. Build the server first. It covers M11 checks 1 and 4, M05's quality checks, M08 checks 2 and 6 (`money.stack.ts`, with the wallet setup screen), M16 check 5 (`order-desk.stack.ts`) and M16's buyer and campaign screens (`crm.stack.ts`), and writes review screenshots to `docs/review/M05/`, `docs/review/M08/` and `docs/review/M16/`.
- `pnpm --filter @elysium/pos e2e` runs the till's offline Playwright spec (M23 checks 1 and 4) against its stub API.
- `pnpm verify` runs format check, lint, typecheck, tests, build, the console bundle budget, the migration-immutability check, the schema-drift check, the route-matrix gate, the i18n check and the api-client drift check. It is the gate for every commit to main.
- `pnpm check:bundle` is the console's initial-route budget on its own: 250 KB gzipped, fonts excluded. Needs a console build first.
- `pnpm check:routes` is the route-matrix gate on its own: every route declares an ability (or `@AuthenticatedOnly` / `@Public`), and every non-public route is in `apps/server/src/platform/auth/route-matrix.manifest.ts` with a fixture in the generated route-matrix suite. Needs a build first.
- `pnpm api:client` regenerates the typed OpenAPI client. Live from M04.
- `pnpm bench` is the shared benchmark harness; every latency acceptance check measures through it. `pnpm bench --list` names the module benches; `pnpm bench catalog` (M06 check 2) runs under tsx against the dev stack's Postgres. With no argument it runs the harness's self-test.
- `pnpm fonts:fetch` re-vendors Inter and Hind Siliguri and recomputes the Bangla `size-adjust`.

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
  - every string goes through i18n (bn + en); the console defaults to en and customer-facing output is bn
  - money is always shown with `<Money>`, in tabular numerals
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
