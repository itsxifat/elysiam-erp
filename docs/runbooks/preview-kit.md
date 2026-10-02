# Preview kit: demo data and sign-ins

How to fill a preview of the ERP with a few weeks of believable work and one sign-in per
role, so a person can try every built part by hand. It runs in two places: this PC
(`pnpm preview:local`) and the preview server (`preview:seed` in the `worker` container).
What to try once signed in is in `docs/testing-guide.md`. Decisions D-380 to D-389.

Never run this against a brand's real data. The seed writes only to a database marked as a
preview (see Guards below).

## What `preview:seed` does

It is one command, and safe to run again. In order:

1. The normal seed (geography, the five brands, their charts of accounts) and the training
   brand's import (`pnpm demo:org`).
2. Nine sign-ins, one per role, with **new random passwords on every run**, made through
   the real invite and password-reset flow. Nobody has two-step login set up yet: the roles
   that need it (super admin, org admin, accounts, investor) set it up at first sign-in.
3. A few weeks of work in **Elysium Lifestyle BD**, through the real API routes: wallets,
   products, purchases, 15 orders in every state, parcels on the fake "Demo Courier" with a
   COD settlement, payroll, a target, till sales, investors, a company loan and the
   dashboards.
4. Some items are left waiting on purpose, so there is something to approve: September's
   payroll, a stock write-off, a supplier payment, an advance claim and an investor's
   withdrawal.
5. It checks the books, and **fails on any disagreement**:
   - the trial balance;
   - the stock value against account 1300 Inventory;
   - each courier's uncollected COD against its receivable.

   A failure here is a bug, not a preview.

6. The sign-ins go to a file. Passwords are never printed.

Steps that need two-step login are done by "seed robot" staff, named "… (preview seed)".
At the end of every run they are switched off, along with their brand memberships.

A second run adds nothing twice. Only the passwords change, and any two-step login someone
has already set up stays. Orders are made only once.

## On this PC

```sh
pnpm preview:local            # fresh: new database, new demo data, new passwords
pnpm preview:local --keep     # start again on the existing preview data
pnpm preview:local --no-start # make the database and stop
```

You need Docker Desktop running and `pnpm i` done once. The command:

1. starts Postgres and Valkey if they are down, and builds the server;
2. recreates and marks the database `elysium_preview` (never `elysium_dev`; this
   machine's Postgres only) and migrates it;
3. seeds it;
4. starts the API, the worker, the console (5173), the portal (5174) and the till (5175).

Ctrl+C stops everything. `pnpm dev` must not be running, because it uses the same ports.

The sign-ins go to `preview-credentials.local.md` at the repository root (gitignored), and
the logs to `.preview/logs/`. To use another name or ports, set `PREVIEW_DATABASE` (it must
start with `elysium_preview`), `PREVIEW_API_PORT`, `PREVIEW_CONSOLE_PORT`,
`PREVIEW_PORTAL_PORT` or `PREVIEW_POS_PORT`.

## On the preview server

The server at https://elyerp.enfinito.cloud was marked and seeded on 2026-10-02, and its
sign-ins were given to the owner. **Running the seed again changes every password**, so only
do it when the owner should get a new file.

First deploy a commit that includes the preview kit (`docs/runbooks/preview-server.md`).
Then, on the server, using that runbook's `dcp` alias:

```sh
# Once per database: mark it as a preview (as the Postgres superuser). The seed refuses an
# unmarked database.
dcp exec -T postgres psql -U postgres -d elysium \
  -c "comment on database \"elysium\" is 'elysium-preview';" < /dev/null

# Seed. About 20 seconds; progress in the terminal, sign-ins in the file.
(umask 077; dcp run --rm --no-deps -T worker \
  node dist/main.preview.js --out - < /dev/null > ~/elyerp/preview-credentials.local.md)
```

Then copy the file to your own computer and keep it private:

```sh
scp -i ~/.ssh/<key> <user>@<server>:elyerp/preview-credentials.local.md .
```

Why the seed command is written this way:

- **`worker`**: it is the service with the owner database role and the uploaded-files
  volume, and the seed needs both.
- **`-T` and `--out -`**: the application folder in the image is read-only, so the file
  comes out on stdout and the shell writes it to your home folder. Progress and logs go to
  stderr. Without `-T`, Docker would mix them into the file.
- **`umask 077`**: the file is readable by you only.
- **`< /dev/null`**: `docker compose exec/run -T` reads stdin. Inside a script or a
  heredoc it would swallow the commands that follow. Run each command on its own, or keep
  the redirect.

The addresses in the file are:

| What           | Address                                                         |
| -------------- | --------------------------------------------------------------- |
| Console        | https://elyerp.enfinito.cloud/                                  |
| Portal         | https://elyerp.enfinito.cloud/portal/                           |
| Till           | https://elyerp.enfinito.cloud/pos/                              |
| Order tracking | https://elyerp.enfinito.cloud/portal/track/elysium-lifestyle-bd |

To run it again on the server, use the same seed command. You get new passwords and nothing
is doubled.

## Guards (`apps/server/src/preview/guard.ts`)

- **The database must say it is a preview.** Its comment must be `elysium-preview`.
  `preview:local` and the smoke run set it. The server needs the one `comment on database`
  command above. Production never has it, and no environment variable can stand in for it.
- **Both connections must reach the same database.** The seed writes as the app role and as
  the owner role, and refuses if `DATABASE_URL` and `DATABASE_OWNER_URL` disagree.
- **No real work.** If the audit log of any brand shows a change made by someone outside
  `@preview.elysium.test`, it stops, and nothing overrides that. Start a fresh preview
  instead.
- **No real people.** If anyone outside `@preview.elysium.test` can sign in, it stops. If
  you have invited real testers to the preview on purpose and they have changed nothing,
  add `--allow-existing-users`.
- **No outside messages.** In this process the SMS and Meta gateways are forced to their
  fakes, so demo phone numbers are never texted.
- **Courier key.** `COURIER_CREDENTIALS_KEY` must be set. It is in `.env.example` and in
  the server's `.env.preview`.
- **Sample files.** An image without `apps/server/migration-sample/` skips the training
  brand and says so.

**Before a preview database is used for real work, unmark it**, so the seed can never run on
it again:

```sh
dcp exec -T postgres psql -U postgres -d elysium   -c "comment on database \"elysium\" is null;" < /dev/null
```

## The smoke run

```sh
pnpm --filter @elysium/server build
pnpm --filter @elysium/console e2e:preview
```

This builds a throwaway preview the way `preview:local` does: database
`elysium_preview_e2e`, the API on port 3130, and the apps on 5193 to 5195. It signs in as
every role from the credentials file, sets up two-step login where required, and opens each
area's main screen. Then it drops the database. Screenshots go to `docs/review/preview/`.

Better Auth allows three two-step calls per address in ten seconds, so the run waits eleven
seconds between enrolments. People are limited the same way: several staff setting up
two-step login from one office address at the same moment may see "Too many attempts".
Waiting a minute fixes it.

## If something is wrong

- "is not marked as a preview": the database has no marker. If it really is a preview, mark
  it with the command under "On the preview server". Anywhere else, stop.
- "… change(s) … were made by people outside the preview": the database holds real work.
  Do not seed it; start a fresh preview.
- "DATABASE_URL reaches … but DATABASE_OWNER_URL reaches …": the two addresses name
  different databases. Fix the environment.
- "… person(s) outside the preview can sign in": see Guards.
- "the books disagree": a real bug in a posting. Keep the database, and report the lines
  above the message.
- "Port(s) already in use" from `preview:local`: stop `pnpm dev` or the other preview.
- A step fails with an HTTP status: the message names the route and the API's answer.
  After the fix, run it again and it picks up where it stopped. The exception is orders: a
  re-run never adds orders to a brand that already has some. If it stopped part-way through
  the orders, start over with a fresh database (`pnpm preview:local`, or on the server, the
  server runbook's "start over").
