# Gaps: orders, settings and HR pay

Not a milestone. A pass that closes the console usability gaps M30's research found (see
`docs/plans/M30.md` on `m30-hardening`, "Found while researching the training guides"), so a
human tester can drive the ERP end to end before it is hosted. Branch
`gaps-orders-settings`, from `integration-wave2` at `09c36d1`. Decision ids D-390 to D-399.

> Planned on 2026-10-02 under continuous build mode (no approval pause; the plan is still
> written first).

## Scope

1. **Order lifecycle buttons.** Hold, Release, Pack, Ship (handover to the courier) and the
   §9 manual fallbacks that follow it (Mark delivered, Partial delivery, Start return,
   Receive return) on the order detail; Book parcel and Confirm handover for the order's
   parcel (on the order detail and on the parcel's tracking page); bulk Pack and bulk Ship
   on the order list, beside bulk Confirm.
   - What may be offered comes from the domain machine, not from a list in the console: the
     order detail response gains `transitions` (`triggersFrom`'s rows: trigger, destination,
     `requiresReason`, whether a return reason code is needed). A button is shown only when
     its trigger is in that list **and** the caller holds `update Order`; the server
     re-checks both. Reason dialogs where the machine says `requiresReason` (hold, cancel,
     receive return) and wherever the route takes a figure (deliver, partial delivery).
   - Bulk: `POST /v1/orders/bulk-transition` (`update Order`, `{ ids, trigger: pack|ship }`),
     a loop over the single-order path with one result per id, exactly as bulk confirm is.
   - Fixes on the way: Cancel was offered on `on_hold`, which §9 does not allow.
2. **Courier statuses and Shipped.** `orderTriggerFor` never produced `ship`, so an order
   stayed `confirmed`/`packed` until someone pressed a button the console did not have —
   and a `delivered` webhook for such an order was recorded and ignored for ever. Fix in
   the domain: a courier status that proves the parcel left us (`picked_up`, `in_transit`,
   `out_for_delivery`, `delivered`, `partial_delivered`, `return_in_transit`,
   `returned_to_merchant`) moves a `confirmed`/`packed` order through `ship` first, then,
   in the same transaction, the trigger the status justifies from `shipped`. Through
   `OrdersApi.applyTrigger` → `TransitionsService` → the machine, never by writing a status.
   `hold`, `cancelled`, `booked`, `pickup_pending` and `unknown` still move nothing from
   before shipment (Steadfast's `in_review` is a `hold` before pickup). Real-Postgres tests.
3. **Settings screens.** `/settings` stops being a placeholder: tabs for approval
   thresholds, delivery zones, courier accounts, website order keys (intake site keys) and
   till registers, each gated by the ability its routes already declare. The Settings link
   shows for anyone who can open at least one tab. Secrets (courier credentials, webhook
   secrets, site secrets) are write-only: typed into password inputs, never shown back; a
   new site key's secret is shown once, as the API returns it once.
   - New read routes where only a write existed: `GET /v1/approvals/thresholds`
     (`read ApprovalThreshold`), `GET /v1/courier/providers` (`read CourierSettlement`: the
     adapters, whether each is verified and enabled, and the credential field names it
     needs — names, never values).
4. **HR's Pay button.** `GET /v1/hr/payroll/wallets` (`update Payroll`): the brand's active
   wallets as id and name only, through a new `LedgerApi.activeWallets`. HR's pay and loan
   disbursement pickers use it instead of `GET /v1/ledger/wallets` (`read Wallet`, which hr
   does not hold, and which carries balances). No new grant.
5. **A real-stack spec** (`apps/console/e2e/order-lifecycle.stack.ts`): an order from
   pending to delivered through the new buttons, every settings tab opened, axe in both
   themes, screenshots in `docs/review/gaps/`.

## Out of scope

- Users, invites, password and two-step resets (another branch, `gaps-users-auth`).
- Exchange from the order detail (it is a new order with its own form), courier settlement
  statement upload, and a courier party ("Steadfast" as a `sales.couriers` row) create
  screen. Follow-ups.
- Changing who may do what. Every screen uses the abilities its routes already declare.

## Approach and order of work

1. Domain: `orderTriggerFor` + `courierTriggersFor`, unit tests. Sync service applies the
   sequence; real-Postgres test file `courier.ship-sync.db.test.ts`.
2. Server: `transitions` on the order detail; bulk-transition route; thresholds read;
   courier providers read; HR wallets read and `LedgerApi.activeWallets`. Route-matrix
   manifest + fixtures, `pnpm api:client`.
3. Console: order detail actions and parcel panel, bulk pack/ship, handover on the parcel
   page, the settings section, HR pickers. i18n bn + en.
4. Stack spec, `pnpm verify`, ledger-auditor, docs (decisions, progress, this status).

## Status on 2026-10-02

Planned. Nothing built yet.
