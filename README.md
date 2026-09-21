# Elysium Mother ERP

One ERP for five sister fashion brands in Bangladesh — Elysium Lifestyle BD, Oura Lifestyle, Orvo, Wear X Clothing and Beownz. It covers COD e-commerce operations and courier sync, showroom accounting and POS, the Beownz reseller platform, HR and payroll, investors, and a unified inbox.

Each brand is an isolated org. Super Admin sees everything.

- `docs/architecture.md` — the engineering spec and source of truth
- `docs/milestones.md` — the build plan, one milestone per session
- `docs/decisions.md` — resolved decisions, assumed defaults, open client questions
- `docs/progress.md` — the session log
- `CLAUDE.md` — the invariants nothing may break

## Local setup

**You need:** Node 24 LTS (see `.nvmrc`), pnpm 12+, Docker with Compose, and git.

```bash
# 1. Dependencies
pnpm install

# 2. Local .env files, copied from each app's .env.example
pnpm setup:env

# 3. Postgres 17, Valkey and Gotenberg
docker compose -f infra/docker-compose.dev.yml up -d --wait

# 4. Database roles, schema and seed data
pnpm db:bootstrap   # once per database; the only step needing a superuser
pnpm db:migrate
pnpm db:seed

# 5. Everything at once
pnpm dev
```

The database uses four roles, one per privilege level (architecture §5). `erp_owner` owns the objects but is deliberately **not** a superuser, because a superuser bypasses `FORCE ROW LEVEL SECURITY` and with it every tenant isolation policy. The app connects as `erp_app` and is subject to all of them.

> Upgrading a checkout from before M01: `POSTGRES_USER` changed, and that only takes effect at `initdb`. Run `docker compose -f infra/docker-compose.dev.yml down -v` to recreate the volume — which destroys local data.

Database tests need a real PostgreSQL, because row-level security is a database behaviour a mock cannot have. Set `TEST_DATABASE_URL` to use the compose server (fast), or leave it unset and the harness starts a throwaway container.

`pnpm dev` starts:

| App             | URL                   | What it is                               |
| --------------- | --------------------- | ---------------------------------------- |
| server (api)    | http://localhost:3000 | NestJS on Fastify; `GET /health/live`    |
| server (worker) | —                     | pg-boss consumers and cron, logs `ready` |
| console         | http://localhost:5173 | Staff SPA                                |
| portal          | http://localhost:5174 | Reseller and investor PWA                |
| pos             | http://localhost:5175 | Showroom PWA                             |
| sites           | http://localhost:3001 | Public landing pages (Next.js)           |
| extension       | http://localhost:3010 | WXT dev server for the Chrome extension  |

Filter to one app with `pnpm --filter @elysium/console dev`.

## The gate

`pnpm verify` is the only thing standing between a change and `main`. It runs, in order: format check, lint, typecheck, tests, build, and the migration-immutability check. CI runs exactly this command, so a green local run means a green CI run.

```bash
pnpm verify
```

| Command                                       | What it does                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm verify`                                 | The full gate. Run before every commit to main.                        |
| `pnpm dev`                                    | Every app in watch mode                                                |
| `pnpm test` / `pnpm test:watch`               | Vitest, split into `node` and `dom` projects                           |
| `pnpm e2e`                                    | Playwright against the console                                         |
| `pnpm lint` / `pnpm format`                   | ESLint / Prettier                                                      |
| `pnpm typecheck`                              | `tsc` across every package and app                                     |
| `pnpm build`                                  | Production build of everything                                         |
| `pnpm db:generate` / `db:migrate` / `db:seed` | Drizzle migrations and seed (from M01)                                 |
| `pnpm api:client`                             | Regenerate the typed OpenAPI client (from M04)                         |
| `pnpm bench`                                  | Benchmark harness self-test; the shared method for every latency check |
| `pnpm fonts:fetch`                            | Re-vendor Inter and Hind Siliguri and recompute `size-adjust`          |
| `pnpm setup:env`                              | Copy every `.env.example` to `.env`                                    |

Playwright needs its browser once: `pnpm --filter @elysium/console exec playwright install chromium`.

## Layout

```
apps/
  server/      NestJS: main.api.ts, main.worker.ts, modules/*, platform/*
  console/     React + Vite SPA (staff)
  portal/      React + Vite PWA (resellers, investors)
  pos/         React + Vite PWA (showrooms)
  sites/       Next.js App Router (landing pages)
  extension/   WXT Chrome MV3 extension (agent activity)
packages/
  config/      tsconfig, ESLint and Prettier presets, the custom lint rules
  ui/          design tokens, Tailwind preset, fonts; the component kit from M05
  domain/      pure business logic: money, posting rules, state machines
  contracts/   Zod schemas, the permission matrix, error codes, event types
  db/          Drizzle schema per module, migrations, RLS, seed
  api-client/  generated OpenAPI client plus TanStack Query hooks
  i18n/        bn + en messages and formatters
  integrations/ courier, fraud, SMS, Meta and Chatwoot adapters
  landing-blocks/ Puck components
infra/         docker-compose.dev.yml, deploy config
scripts/       verify helpers: check-migrations, bench, fetch-fonts, setup-env
docs/          spec, milestones, decisions, progress, plans
```

## Conventions worth knowing before you write code

- **Money is integer poisha.** `bigint` columns named `*_poisha`, `Poisha` in TypeScript. No floats; round only through `packages/domain/src/money`.
- **Design tokens, not colours.** Every colour, radius, shadow and duration comes from `packages/ui/src/styles/tokens.css`. A raw Tailwind palette class (`bg-blue-500`) fails lint, because it breaks dark mode and per-org branding at once.
- **No emoji as UI.** Icons come from lucide-react. A lint rule enforces it, and it leaves Bangla text and the taka sign alone.
- **Inline styles are refused**, except CSS custom properties — that exception is what lets an org's brand accent be applied at runtime.
- **Committed migrations are immutable.** Fix a migration with a new migration; `check-migrations` fails the build otherwise.

The full set is in `CLAUDE.md` and `docs/architecture.md`.

## TypeScript is pinned to 6.x on purpose

TypeScript 7 is the native port and has removed the classic JS compiler API, which `typescript-eslint` needs for type-aware linting. Moving to 7 would cost us `no-floating-promises`, `no-misused-promises` and `restrict-plus-operands` — the rules that catch an un-awaited ledger post or a string/number mix-up on money. See decision **D-039**; revisit when typescript-eslint supports 7.x.
