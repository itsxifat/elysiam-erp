-- Tenant isolation for the wallets schema (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim,
-- the way every tenant policy in this repo is: a policy that differs by one
-- character fails silently, returning rows rather than throwing, and the wrong
-- rows look like the right ones (D-048).
--
-- The grants are where the thinking is:
--
-- * `wallets.transfers` is **append-only**. A transfer is a record of money that
--   moved, and its journal cannot change (invariant 2), so a row that could be
--   edited afterwards would let the paperwork and the ledger disagree about what
--   happened. Correcting a transfer means reversing its journal and posting a new
--   one.
-- * `wallets.cash_entries` and `wallets.closings` get UPDATE but never DELETE.
--   Both have exactly one legitimate transition — waiting for a checker, then
--   posted or rejected — and a trigger in 0029 is what confines UPDATE to it.
--   DELETE would make "what did we spend last Tuesday" answerable differently on
--   two different days.
-- * `wallets.wallets` gets UPDATE (a wallet is renamed and deactivated) but no
--   DELETE: deleting one would orphan every entry, transfer and closing that
--   names it, and a wallet that once held money is part of the record.
--
-- No analytics read on any of them. The super-admin consolidated view (§5
-- exception 3) is a sum of ledger balances, so it reads `ledger.*` through
-- `erp_analytics` (migration 0030) and needs nothing here. A read-only role is
-- still a role that can read (D-049), and these rows carry who counted which
-- till and which receipt they photographed.

alter table "wallets"."wallets" enable row level security;--> statement-breakpoint
alter table "wallets"."wallets" force row level security;--> statement-breakpoint
drop policy if exists "wallets_org_isolation" on "wallets"."wallets";--> statement-breakpoint
create policy "wallets_org_isolation" on "wallets"."wallets"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "wallets" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "wallets"."wallets" to "erp_app";--> statement-breakpoint
alter table "wallets"."cash_entries" enable row level security;--> statement-breakpoint
alter table "wallets"."cash_entries" force row level security;--> statement-breakpoint
drop policy if exists "cash_entries_org_isolation" on "wallets"."cash_entries";--> statement-breakpoint
create policy "cash_entries_org_isolation" on "wallets"."cash_entries"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "wallets" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "wallets"."cash_entries" to "erp_app";--> statement-breakpoint
alter table "wallets"."transfers" enable row level security;--> statement-breakpoint
alter table "wallets"."transfers" force row level security;--> statement-breakpoint
drop policy if exists "transfers_org_isolation" on "wallets"."transfers";--> statement-breakpoint
create policy "transfers_org_isolation" on "wallets"."transfers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "wallets" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "wallets"."transfers" to "erp_app";--> statement-breakpoint
alter table "wallets"."closings" enable row level security;--> statement-breakpoint
alter table "wallets"."closings" force row level security;--> statement-breakpoint
drop policy if exists "closings_org_isolation" on "wallets"."closings";--> statement-breakpoint
create policy "closings_org_isolation" on "wallets"."closings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "wallets" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "wallets"."closings" to "erp_app";
