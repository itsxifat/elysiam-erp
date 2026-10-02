# Go-live checklist

The owner signs this page before the first brand trades on the ERP (M30, acceptance check 5).
It is the sign-off, not the procedure: the steps for the day are in
[runbooks/go-live.md](runbooks/go-live.md), and setting up the servers is in
[runbooks/deploy.md](runbooks/deploy.md).

Every row is ticked, or written under "Accepted exceptions" with a reason, before the
signature. Tick a row only when its evidence exists, and write the date beside it.

**Who is responsible**

- **Owner**: the group owner, who signs this page.
- **Operator**: the developer who runs the servers and holds the secret manager.
- **Accountant**: the client's accountant.
- **Org admin**: each brand's administrator.
- **Super admin**: the first super admin, or whoever the owner names.

Rows marked **(M30 part 2)** need M14b's monitoring and a staging server, and cannot be ticked
before those exist.

## 1. Decisions and integrations

### Open decisions

Each one is answered and its row in [decisions.md](decisions.md) changed to RESOLVED, or the
assumed default is accepted here in writing.

- [ ] **D-006 couriers.** Each brand's couriers and rough monthly volumes confirmed (the
      default is Steadfast first, Pathao and RedX later). Who: Owner.
- [ ] **D-009 delivery charges.** The real charge per zone confirmed for each brand and entered
      in Settings → Delivery zones. The seeded ৳60, ৳100 and ৳120 are placeholders. Who:
      Owner, then each org admin.
- [ ] **D-012 SMS gateway.** The gateway chosen (BulkSMSBD or the client's existing one) and a
      branded sender ID applied for, or SMS accepted as off at go-live. Who: Owner.
- [ ] **D-013 advance payments.** Manual checking accepted (the agent records the transaction
      ID, accounts verifies it), or a payment gateway requested as new work. Who: Owner.
- [ ] **D-019 investor profit share.** Manual declaration per period (an amount typed, then
      approved) accepted, or a formula supplied. Who: Owner.
- [ ] **D-024 existing brand websites.** Decided which websites send orders into the ERP; each
      one has its own key in Settings → Website order keys. Who: Owner, Org admin.
- [ ] **D-025 VAT (Mushak) invoices at showrooms.** Confirmed out of scope, or requested as new
      work. Who: Owner, Accountant.
- [ ] **D-027 chart of accounts.** The client's accountant has reviewed the seeded chart and
      signed it off. Who: Accountant.
- [ ] **D-029 payroll components.** The decisions table row changed to RESOLVED, to match the
      log entry of 2026-09-26. Who: Operator.
- [ ] **D-030 leave management.** Confirmed out of scope: attendance records paid and unpaid
      leave days, with no leave balances or leave requests. Who: Owner.
- [ ] **D-152 courier choice.** Accepted that a parcel books with the order's courier, and a
      zone's default courier is only a suggestion. Who: Owner.
- [ ] **D-161 who uses the till.** Answered who rings up showroom sales. Today only org admins,
      accounts and branch managers can use the till; showroom sales staff cannot. If they
      must, that is new work before go-live. Who: Owner.
- [ ] **D-200 RedX.** Decided whether any brand ships with RedX at go-live. If yes, a RedX
      merchant account is obtained for the check below. Who: Owner.

### Unverified integrations

Each is listed under "Unverified integrations" in [decisions.md](decisions.md). It stays
switched off until it has been checked against the real provider, with real credentials, on
staging.

- [ ] **Steadfast.** A real booking, a status update and a settlement fetch made on staging
      with the brand's own key and the right base URL; then `COURIER_STEADFAST_ENABLED=true`.
      Or the adapter is left off. Who: Operator, with the brand's courier login.
- [ ] **Pathao.** The same checks on staging, then `COURIER_PATHAO_ENABLED=true`. Or left off.
      Who: Operator.
- [ ] **RedX.** Verified against a merchant account (D-200), or left off
      (`COURIER_REDX_ENABLED` unset). Who: Operator.
- [ ] **BulkSMSBD.** A real Bangla message sent and received on staging with the brand's key
      and sender ID. Or the fake gateway stays, and no SMS is sent. Who: Operator.
- [ ] **Meta (D-257).** The spend import and the Conversions API tested with a brand's
      system-user token, pixel and a test event code. Or left off (`MARKETING_META_ENABLED`
      unset). Who: Operator, with the brand's marketing lead.
- [ ] **Cloudflare Turnstile.** A real order from each website that sends orders passes with
      the production `TURNSTILE_SECRET_KEY`, and a form without a token is refused. Who:
      Operator.
- [ ] **Cloudflare R2 storage.** An upload, a download through a signed link and a generated
      PDF work against the real bucket on staging. The driver's comment, which cites D-113 by
      mistake, cites the right decision. Who: Operator.
- [ ] **The demo courier.** No real brand has an active courier account on the fake adapter
      ("Demo Courier"). Since M30 it refuses every webhook without a secret (finding D1), but
      it still marks parcels delivered on request, which only the preview should do. Who:
      Operator, Org admin.

## 2. Secrets

Every value comes from the secret manager. None is copied from `apps/server/.env.example`:
its values are for development and are public, including its `AUTH_SECRET` and
`COURIER_CREDENTIALS_KEY`.

- [ ] **`AUTH_SECRET`** generated fresh (`openssl rand -base64 48`) and set from the secret
      manager. Who: Operator.
- [ ] **`INTAKE_KEY_SECRET`** generated fresh (`openssl rand -base64 48`) and set from the
      secret manager. Who: Operator.
- [ ] **`HR_FIELD_KEY`, `COURIER_CREDENTIALS_KEY` and `MARKETING_CREDENTIALS_KEY`** generated
      fresh, three different values (`openssl rand -base64 32` each), and set **before any
      real employee record, courier key or Meta token is saved**. Changing one later makes
      what it encrypted unreadable. Who: Operator.
- [ ] A second copy of `AUTH_SECRET` and the three encryption keys kept in a second safe
      place, as [deploy.md](runbooks/deploy.md) step A.4 asks. Who: Operator, Owner.
- [ ] `TURNSTILE_SECRET_KEY`, the R2 keys, the database passwords and `VALKEY_PASSWORD` are
      in the secret manager only: not in the repository, a chat or a shared drive. Who:
      Operator.
- [ ] The operator has read [secret-rotation.md](runbooks/secret-rotation.md): these keys are
      not rotated on a schedule, and rotating `AUTH_SECRET` disables every two-step sign-in.
      Who: Operator.

## 3. People and access

- [ ] **The first super admin** created on production with
      `pnpm admin:bootstrap --email <e> --name <n>`, run by the operator on the server. The
      one-time `/accept-invite` link it prints goes to that person alone. They set a password
      and enrol two-step sign-in. Who: Operator, Super admin.
- [ ] **No preview data on production.** `pnpm preview:seed` and `pnpm db:dev-users` were never
      run there, nobody `@preview.elysium.test` can sign in, and the database is not marked
      `elysium-preview`. Who: Operator.
- [ ] **Each brand has at least two org admins**, or one plus the super admin. Raising a
      threshold and resetting a privileged person's sign-in both need a second admin. Who:
      Owner.
- [ ] **Everyone else invited from the Staff screen** by an org admin, with roles and branches
      that match the job. Branch managers are limited to their branch. Who: Org admin.
- [ ] **Two-step sign-in on.** On the Staff screen, every org admin and accounts user shows
      Two-step verification **On**. Who: Org admin.
- [ ] **Two accounts users** in each brand that pays investor withdrawals. A withdrawal takes
      three people: one records it, a second accounts user reviews it, and a third (an org
      admin or another accounts user) approves it. Who: Owner.
- [ ] **Approval thresholds set for each brand** in Settings → Approval thresholds, for every
      type, with each first threshold approved by a second org admin. With no threshold,
      every request waits for a checker. Who: Org admin, Owner.
- [ ] **Employees linked to their sign-ins.** Everyone with a sign-in is linked to their
      employee record. The checks that stop someone paying a staff loan to themselves or
      changing their own payout account rely on it, and so do the agents' targets. HR links
      them in **People** → **Edit** → **Linked sign-in**. Who: HR.
- [ ] **Employees placed in their branch.** Showroom staff have their branch set, so their
      branch manager sees them. HR sets it in **People** (**Branch** on the add form, or
      **Edit**). Who: HR.
- [ ] **Investors linked to their portal sign-ins** in **Investors** → **Portal sign-in**.
      Who: Accounts.

## 4. Infrastructure

- [ ] **`TRUSTED_PROXY_COUNT`** equals the real number of proxies in front of the API (2 for
      Cloudflare then kamal-proxy, D-343), and ports 80 and 443 admit Cloudflare's address
      ranges only. If the hops differ, the count is changed to match. Who: Operator.
- [ ] **Private files never in a publicly served bucket.** Receipts, payslips, ID scans and
      agreements are in a bucket with no public access. Public files, if any, are in a
      separate bucket (finding B3). Who: Operator.
- [ ] **Backups.** Point-in-time recovery is on at the database provider, and last night's
      logical dump is at the second provider ([restore.md](runbooks/restore.md)). Who:
      Operator.
- [ ] **Retention** set for the audit log, outbox, delivery log, idempotency rows, job archives,
      uploaded files and backups. **(M30 part 2)** Who: Operator, Owner.
- [ ] **Restore drill** run on staging, timed, and logged in
      [restore.md](runbooks/restore.md)'s drill log (check 4). **(M30 part 2)** Who: Operator.
- [ ] **Rollback drill and health check** logged on staging
      ([rollback.md](runbooks/rollback.md), [deploy.md](runbooks/deploy.md) step A.6). Who:
      Operator.
- [ ] **Alerts** live for every signal in [monitoring.md](runbooks/monitoring.md)'s alert
      rules, each tested once and reaching the named person, including a Sentry test event if
      Sentry is used. **(M30 part 2)** Who: Operator.

## 5. Readiness evidence

- [ ] **Load test.** [review/M30/load-test.md](review/M30/load-test.md) reviewed: each §29
      target is met, or its gap has a plan the owner accepts. Who: Owner, Operator.
- [ ] **Route report.** [review/M30/route-report.md](review/M30/route-report.md) is current,
      and `pnpm check:routes` passes on the commit being deployed. Who: Operator.
- [ ] **Security.** No open high-severity finding in the findings table of
      [plans/M30.md](plans/M30.md). Every medium is fixed or listed as a follow-up with an
      owner, and the session cookie's scope (A4) is decided. Who: Operator, Owner.
- [ ] **Build.** `pnpm verify` exits 0 on the commit being deployed. Who: Operator.
- [ ] **Training delivered**, from [training/](training/README.md), with each trainee's name
      and the date recorded. Who: Org admin.
  - [ ] Sales agents ([sales-agent.md](training/sales-agent.md))
  - [ ] Accounts ([accounts.md](training/accounts.md))
  - [ ] Warehouse ([warehouse.md](training/warehouse.md))
  - [ ] Branch managers ([branch-manager.md](training/branch-manager.md))
  - [ ] HR ([hr.md](training/hr.md))
  - [ ] Org admins ([org-admin.md](training/org-admin.md))

## 6. The day itself

- [ ] **Follow [runbooks/go-live.md](runbooks/go-live.md)** for the pilot brand: its "A week
      before" list ticked, the accountant's reconciliation signed before the first sale, and
      its Record table filled in. Who: Operator, Accountant, Org admin.

## Accepted exceptions

| Row | Why it is accepted | Until when | Accepted by |
| --- | ------------------ | ---------- | ----------- |
|     |                    |            |             |

## Sign-off

I have read this checklist. Every row above is ticked or listed as an accepted exception, and
the ERP may go live for the pilot brand.

| Name | Role  | Date | Signature |
| ---- | ----- | ---- | --------- |
|      | Owner |      |           |

The build does not sign this page. No development session, script or agent fills in the
sign-off or ticks a row on the owner's behalf. Only the owner signs.
