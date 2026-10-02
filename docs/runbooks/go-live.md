# Go-live (the pilot brand)

The order of things on the day a brand moves onto the ERP (M14a, M14b; START-HERE.md G3
and G4). Staging must have passed its three drills first: health (`deploy.md` A.6), restore
(`restore.md`) and rollback (`rollback.md`). The pilot runs 2–3 weeks on one brand before
the next one moves.

## A week before

- [ ] Production provisioned (`deploy.md` A), its health verified, Sentry and the uptime
      monitor live (`monitoring.md`), the nightly dump arriving at the second provider.
- [ ] The client's accountant has reviewed the chart of accounts.
- [ ] The brand's data exports are in hand: products, counted stock with unit costs,
      supplier dues, wallet balances, customer order history (G3).
- [ ] A dry run of every importer against staging, with the brand's real files, showing a
      balanced opening trial balance (`pnpm migration`, M14a, D-214).
- [ ] The brand's courier account(s) configured and one real booking made on staging.
- [ ] Staff accounts invited; org admins and accounts users have enrolled 2FA.
- [ ] The queue policies are current on production's database: the worker's boot log says
      no `queue policy drift` (`queue-policy.md`; M16 found the shared dev database still
      `standard`).

## On the day, in order

1. **Re-run the seed** on production, so every brand has `3350 Opening balance equity` and
   the rest of the current chart (M14a follow-up):
   `kamal app exec $K --roles worker "node node_modules/@elysium/db/dist/cli/seed.js"`.
2. **Freeze the old system** for the brand: no new orders, sales or payments there from
   this point. Take its final exports now.
3. **Import** the six files for the brand and commit them: `pnpm migration dry-run`, then
   `commit`, per kind in order (skus, customers, opening_stock, supplier_balances,
   wallet_balances, courier_cod; M14a, D-214). Run it from the implementation machine
   allowed to reach the production database, with production's `DATABASE_URL` exported in
   the shell only for the session. A bad row anywhere leaves nothing behind; fix the file
   and run it again.
4. **Post the opening**: `pnpm migration post --org <slug> --as-of <yesterday> --approved-by "<accountant>"`
   (one journal, dated the evening before go-live, D-221).
5. **Run the reconciliation and have the accountant sign it before the brand trades**
   (`pnpm migration reconcile --org <slug> --out reconciliation.csv`, then
   `pnpm migration sign-off --org <slug> --by "<accountant>"`, D-222). Stock is valued at the moment the report runs, so
   it moves after the first sale: sign first, trade second. A line that does not agree
   blocks the sign-off; find out why before going on.
6. **Open for business:** the desks take orders, the first parcel is booked with the
   courier, and the first showroom sale goes through the till.
7. **Watch** for the first hours: Sentry, `/health/ready`, the failed-jobs view
   (`GET /v1/jobs/failed`), and the first courier status updates arriving.

## During the pilot

- Daily: the morning checks in `monitoring.md`.
- Every issue goes to the follow-up list with a date and an owner; fix sessions run before
  the next brand moves (G4).
- The first month-end close for the brand follows `month-end-close.md`, with the accountant.

## Record

| Brand | Go-live date | Opening posted | Reconciliation signed by | First order | First sale | By  |
| ----- | ------------ | -------------- | ------------------------ | ----------- | ---------- | --- |
|       |              |                |                          |             |            |     |
