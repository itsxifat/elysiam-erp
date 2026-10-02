# M30 follow-ups: console gaps, medium findings and two races

Branch: `m30-followups` (from `integration-wave2` at `ad0a737`) · Effort MAX · Architecture
§6, §7, §12, §15, §22, §25 · Builds on M30 part 1

> Planned on 2026-10-03 under continuous build mode (no approval pause; the plan is still
> written first). The owner wants it fast and right. These are the items M30 part 1 left open
> that need no staging server: the console gaps its training guides found, its still-open
> medium security findings, and the two narrow races it named.

## Scope

### 1. Console gaps a tester hits

- **"Add an employee" has no branch field.** A branch manager's add answers 404, because the
  server checks the new row against their branch scope and the form sends no branch. The form
  gains a branch picker, filled from a new narrow route (below); a branch manager's own branch
  is chosen for them when they have only one.
- **No screen edits an employee after adding.** A row's Edit panel changes name, designation,
  department, branch, status and leaving date for everyone who may update the record, and the
  payout method and account, the phone and national ID, and the linked sign-in for holders of
  `update Payroll` across the brand (D-363's line, unchanged). The panel sends only the fields
  that changed, so a branch manager's edit never trips the payroll rule.
- **No screen links an investor's portal sign-in.** The investors list gains a "Portal
  sign-in" action per investor (behind `update Investor`): a picker of the brand's people who
  hold the `investor` role, saved through the existing `PATCH /v1/investors/:id`.
- **Warehouse's supplier dropdown on `/supply/entries` is empty.** It loaded
  `GET /v1/supply/suppliers` (`read Supply`, which warehouse does not hold). Fixed the way
  D-396 fixed HR's wallet picker:

| Route                             | Gate              | Returns                                                                                  |
| --------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `GET /v1/supply/supplier-options` | `create Supply`   | the brand's active suppliers: `id`, `code`, `name`                                       |
| `GET /v1/hr/branch-options`       | `create Employee` | the active branches inside the caller's scope: `id`, `code`, `name`                      |
| `GET /v1/hr/login-options`        | `update Payroll`  | people with an active role in the brand: `userId`, `name`, masked email, roles, link     |
| `GET /v1/investors/login-options` | `update Investor` | people with an active `investor` role in the brand: `userId`, `name`, masked email, link |

None returns a balance, a cost or anything else the picker does not show (invariant 5).

### 2. The open medium security findings

| ID  | Finding                                                              | Plan                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A3  | `/phone-number/verify` mints a session with no second factor         | Fix (D-411). A Better Auth `before` hook refuses `/phone-number/verify` unless it is a signed-in person confirming a new number (`updatePhoneNumber: true`, which needs a session already). Phone and password sign-in stays behind the two-factor hook, which already covers it.                                                                                    |
| A5  | One brand's admin can pre-claim an identity another brand later adds | Fix (D-412, ASSUMED). `POST /v1/users` on an address that has ever held a role in another brand is a super admin's, as D-405 made such a person's resets. Read through the person's own lens (`withUser`).                                                                                                                                                           |
| B2  | The file purpose check ignores own and branch scope                  | Fix (D-413). The generic download serves a private file someone else uploaded only to a holder of the purpose's ability across the brand. A narrower holder (a branch manager's `read Wallet`, everyone's own `read Employee`, an investor's own `read Investor`) reads such files only through the owning module's route, which checks the row.                     |
| C6  | Supply entries skip the posting window                               | Fix (D-414, ASSUMED). Receiving, a supplier payment and a supplier return take a date only inside §7's window (today or yesterday), as orders, loans and payroll already do; outside it the answer is `APPROVAL_REQUIRED`. A late bill is entered on the day it is entered, with its invoice number; back-dating waits for a `back_dated_entry` executor.            |
| C7  | Payments can be split under the threshold                            | Fix (D-415, ASSUMED). The threshold is compared with the person's running total for the business day: a supplier payment adds what the same person paid out to any supplier on the day they enter it, without a checker; petty cash (and a branch manager's cash out) adds what the same person spent under the same rule that day. Counted under a per-person lock. |
| D3  | The tracking page can be guessed across order numbers                | Fix the server half (D-416, ASSUMED): a per-brand miss budget. Once a brand's misses in the window are spent, its tracking answers 429 for everyone, found or not, so the budget is no oracle. Turnstile on the page needs the brand's site key and the widget on the portal: recorded, not built.                                                                   |
| B3  | One bucket for private and public files                              | Left as it is: a deployment item on the go-live checklist.                                                                                                                                                                                                                                                                                                           |

### 3. The two narrow races

- **B1's size check** (D-417). The finalize and the local driver's bytes PUT both lock the
  file row (`FOR UPDATE`), so a PUT cannot land between the finalize's size check and its read,
  and a PUT after the finalize sees `stored` and is refused. The read itself is also capped at
  the type's ceiling in both drivers (a byte-limited read), which closes the same gap for R2,
  where the PUT never passes through the API.
- **A held cash out when a threshold changes mid-request** (W-2, D-418). A request the owning
  module has decided to hold is raised as pending whatever the thresholds say by then
  (`holdForChecker`), so a threshold relaxed between the check and the request can no longer
  auto-approve it before the entry exists, which left the entry waiting for ever. The same
  flag carries C7's running-total holds.

Each race fix is a small change with a real-Postgres test; neither needs a design.

## Out of scope

Pro-rating discounts, per-brand limit settings, anything needing a staging server, deploying,
connecting to any server, merging to main. B3 (deployment). A4 (owner's decision). The low
findings.

## Approach

- Server first, each fix with its regression test against real Postgres (Testcontainers):
  `identity.test.ts` (A3), `users.e2e.test.ts` (A5), `files.e2e.test.ts` (B2, B1),
  `supply.e2e.test.ts` (C6, C7), `wallets.e2e.test.ts` (C7, W-2),
  `courier.m15.db.test.ts` (D3), and the new pickers' suites. Pure rules go in
  `packages/domain` with unit tests (invariant 11): the running-total threshold decision.
- New routes join `route-matrix.manifest.ts` with fixtures; the api client and the route
  report are regenerated.
- Console: the four screens above, every string in en and bn.
- `pnpm verify` once at the end; the `ledger-auditor` on the diff (permissions and money);
  fixes; docs; commit.

## Decisions to record (D-411 onward)

- D-411 (A3), D-412 (A5, ASSUMED), D-413 (B2), D-414 (C6, ASSUMED), D-415 (C7, ASSUMED),
  D-416 (D3, ASSUMED), D-417 (B1), D-418 (W-2), D-419 (the four picker routes).

## Risks

- **A tighter rule refusing an honest flow.** C6 refuses old dates the console never sends;
  C7 holds a day's later payments for a checker rather than refusing them; B2 narrows a route
  no screen uses for others' files. Each is stated in its decision row and the guides.
- **Tests that relied on the old looseness** (supply suites dated in January and March) are
  moved to dates inside the window, or drive the service with a fixed clock.

## Tasks

1. Plan (this file).
2. Server: A3, A5, B2, B1, C6, W-2 with C7, D3, each with its test.
3. Server: the four picker routes, manifest, fixtures, tests.
4. Console: employee branch field and edit panel, investor sign-in link, supplier picker; i18n.
5. api client and route report regenerated; `pnpm verify`; ledger-auditor; fixes.
6. Decisions, progress, this plan's status, the plans index, M30's plan, the guides.

## Status on 2026-10-03: built and verified

Everything in scope is built, with tests against real Postgres.

### What each item came to

| Item                          | State                              | Where                                                                             |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| Branch on "Add an employee"   | Done                               | `GET /v1/hr/branch-options`; `hr/people.tsx`                                      |
| Edit an employee              | Done                               | `hr/people.tsx`, `hr/employee-patch.ts` (sends only what changed)                 |
| Investor portal sign-in       | Done                               | `GET /v1/investors/login-options`; `investors-page.tsx`                           |
| Warehouse supplier dropdown   | Done                               | `GET /v1/supply/supplier-options`; `supply/entries.tsx`                           |
| A3 SMS code mints a session   | Fixed (D-411)                      | `packages/db/src/auth/index.ts`; `identity.test.ts`                               |
| A5 cross-brand pre-claim      | Fixed, ASSUMED (D-412)             | `iam.service.ts`, migration `0102`; `users.e2e.test.ts`                           |
| B2 purpose gate ignores scope | Fixed (D-413)                      | `files.service.ts`; `files.e2e.test.ts`                                           |
| C6 supply posting window      | Fixed, ASSUMED (D-414)             | `supply/posting-date.ts`; `supply.e2e.test.ts`                                    |
| C7 split payments             | Fixed, ASSUMED (D-415)             | `requiresApprovalForDay`; supply and wallets services; both e2e suites            |
| D3 tracking enumeration       | Server half fixed, ASSUMED (D-416) | `tracking.service.ts`, `RateLimitStore.peek`; `courier.m15.db.test.ts`            |
| B1's race                     | Fixed (D-417)                      | capped `get` in both drivers; row lock for the local PUT and finalize             |
| W-2's race                    | Fixed (D-418)                      | `holdForChecker` in `ApprovalsService.request`; cash and supplier payments use it |
| B3 one bucket                 | Left as is                         | deployment item on the go-live checklist                                          |

### Where the plan's body changed

- People come from a new `IamApi` (`iam/iam.api.ts`, `IamDirectoryModule`): HR reading
  `iam.*` directly would have been new coupling the module-boundaries ratchet refuses.
- C7's supplier day is the person's whole day of supplier payments, to any supplier, by the
  day they enter them, not per supplier and business date (the ledger audit's W1, W2).
- B1's lock covers the local driver only. R2's PUT never passes through the API, and a
  transaction held across a network read would break invariant 6; the capped read is the R2
  fix.
- The phone and national ID on the Edit panel are any editor's, as on the add form and on the
  server; only payout details and the linked sign-in are payroll's.
- A pre-existing flaky test (`promo.db.test.ts`'s race) failed one full run under load; it
  now holds both orders at a barrier after pricing, so the race is always the redeem's.

### Verification

- `pnpm verify` run 4 (before the audit's fixes): format, lint, typecheck pass; tests 184 of
  185 files, 2,916 passed, 1 failed (the promo flake above, since fixed), 1 skipped. Runs 1
  to 3 stopped at lint and format and were fixed.
- `pnpm verify` run 5 (after the audit's fixes) passed format, lint and typecheck and was
  then **stopped by Claude Code because the PC ran low on memory**, before the tests. It was
  not restarted, as the memory guard asks.
- Instead, after the last change: `pnpm build`, `check:bundle` (245.1 KB of 250),
  `check:migrations`, `check:schema`, `check:routes` (323 routes, 315 matrix-tested, 8
  public), `check:i18n` and `check:api-client` all PASS; lint and format check pass; and
  every suite the fixes touch, one worker at a time: supply, wallets, hr, iam users,
  identity, investors, files, courier m15, promo, platform auth and http, approvals,
  module boundaries, domain and console (1,553 tests in 83 files, all passing).
- `pnpm verify` (under `heavy.mjs`) exits 0 at `a1a1c43`: 185 test files, 2,922 tests (1
  skipped); every check passes.

### Auditors

- ledger-auditor: 0 critical, 4 warnings, 10 notes. Fixed: W1 and W2 (a supplier payment's
  day keyed on a date the person chooses, and per supplier while the same role adds
  suppliers), W3 (HR's sign-in picker listed investors), W4 (missing tests), and notes 1, 2,
  5, 7 and 8. Re-check: 0 critical, 0 warnings; its notes on one clock for the day, a
  revoked role exempting a second role, a role denylist and the test barrier are fixed; the
  roles-path re-grant is a follow-up beside D-412.
- acceptance-auditor: not run; this batch is not a milestone with acceptance checks.

### Follow-ups (owner: claude unless marked)

- Turnstile on the tracking page once the brands' site keys exist (D-416). (owner: human for
  the keys)
- `PUT /v1/users/:id/roles` re-granting a revoked role to someone now active elsewhere
  (D-412).
- Offer a reset link when a super admin adds someone held elsewhere (D-412).
- Copy an R2 upload to a final key at finalize, so a PUT after it cannot replace the bytes
  (D-417).
- A module-owned download for receipts and KYC scans when a screen needs a branch manager to
  open their branch's (D-413).
- A menu link to `/supply/entries` for warehouse.
- An index on `supply.supplier_payments (org_id, created_by, created_at)` if the day's sum
  ever shows in a query plan.
- `back_dated_entry` for supply if the accountant wants late bills on their own date (D-414).
- Owner questions: D-412, D-414, D-415 and D-416's defaults. (owner: human)
