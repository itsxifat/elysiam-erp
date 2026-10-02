# Preview kit

Not a milestone: a kit so the owner (non-technical) can sign in and try every built part of
the ERP by hand, on this PC now and on a preview server later. Asked for on 2026-10-02 ("make
all working, previewable and testable by human"). Decisions D-380 to D-389.

## Scope

1. `pnpm preview:seed`: a built server CLI (`apps/server/dist/main.preview.js`) that makes a
   database previewable. Needs only the usual `DATABASE_URL` / `DATABASE_OWNER_URL` (and the
   server's normal env), so it can also run inside the server container. Idempotent.
   - the normal seed (geography, five brands, charts) and the training brand (`demo:org`);
   - one login per role through the real invite flow; passwords random per run, written
     only to the gitignored `preview-credentials.local.md`;
   - demo activity through the real routes (never inserts into a module's tables): stock in a
     warehouse and a showroom, orders in every state with buyers, courier parcels on the fake
     adapter and a COD settlement, a promo code and a campaign with ad spend, an advance
     waiting for accounts, a supplier with purchases, wallets with cash movements, employees,
     attendance, payroll, a target with progress, a till with sales and a day closing, an
     investor with capital and a document, a company loan, the dashboard rollups;
   - checks the trial balance at the end and fails loudly if it is not zero.
2. `pnpm preview:local`: a fresh `elysium_preview` database on the dev Postgres (never
   `elysium_dev`), migrate, seed, then the API, worker, console, portal and till, with the
   URLs printed. `--keep` restarts on the existing preview data.
3. `docs/testing-guide.md`: plain-language steps per business area for the owner.
4. A Playwright smoke run (`pnpm --filter @elysium/console e2e:preview`) that builds a
   throwaway preview the same way, signs in as every role (enrolling two-step login where §6
   requires it) and opens each area's main screen, with screenshots in `docs/review/preview/`.

Out of scope: console screens other builders are adding in parallel (order hold/pack/ship
buttons, settings screens, user admin, accept-invite). The guide marks those steps "(arriving
with the next update)".

## Approach

- **In-process application** (`apps/server/src/preview/runtime.ts`): `AppModule` with the
  global pipeline and the auth plugin, reached with `server.inject()`, plus the worker's job
  handlers and outbox loop (`worker-jobs.ts`, extracted from `main.worker.ts` so both share one
  registration list). Work a request queues (a parcel booking, target progress, rollups) is
  finished by the worker's own code before the seed checks the books.
- **People** (`people.ts`): the owner's logins are invited through `POST /v1/users` and redeem
  through Better Auth's reset endpoint. Roles with a second factor are not enrolled; their
  work in the seed is done by "robot" staff who enrol a key nobody keeps. The super admin is a
  column only `erp_owner` may set (D-094), so it is set that way, as in a real deployment.
- **Scenario** (`scenario.ts`): one function per business area, each guarded by a check that
  it has already run, acting as the role that would do it in a brand.
- **Set-up rows with no route** (a showroom branch, a demo courier): written as set-up data the
  way `seedDemoSetUp` writes the training brand's, and recorded as decisions.

## Status on 2026-10-02

Done. `pnpm verify` exits 0 on 2ad6070. The ledger re-audit found 0 critical and 3
warnings: W1 and W2 are fixed, and W3 is narrowed in D-389 with a follow-up (see the progress
entry). The preview server runs a snapshot of this work (`preview-deploy`), seeded once on
2026-10-02. Do not re-seed it, or the owner's passwords change.

- `preview:seed` runs end to end on a fresh database and again on top of itself with
  identical books. It also runs with `NODE_ENV=production`, with `--out -` (credentials on
  stdout, progress and logs on stderr) and without `migration-sample/`. Every run fails on a
  trial-balance difference, stock disagreeing with 1300 Inventory, or any courier COD
  variance.
- `preview:local --no-start` makes, marks and seeds the database.
- The smoke run (`e2e:preview`) signs in as every role, with two-step enrolments spaced
  11 s apart for Better Auth's per-address limit. Screenshots are in `docs/review/preview/`.
- `docs/testing-guide.md` is the owner's guide, written for https://elyerp.enfinito.cloud.
  `docs/runbooks/preview-kit.md` has the steps for this PC and for the server.

The ledger audit (1 critical, 7 warnings) is fixed. The guard now needs a database marked as
a preview and both connections on the same database. The gateways are forced to fakes. Logs
stay out of the credentials file. Expense accounts are chosen by code and the arithmetic
uses the domain money helpers. Robot memberships are retired. Audit exemptions are declared
per route. A stored file's bytes can no longer be replaced. The attendance import's times
are tested. See D-381 and D-389.

Bugs the seed found in shipped code, fixed with tests: attendance times (manual and
import), the local upload logged as unaudited, and a stored upload's bytes that could be
replaced (D-389).
