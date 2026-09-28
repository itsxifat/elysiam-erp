-- Isolation and grants for the fraud schema (M13; invariant 4, §5).
--
-- This file is where M13's central tension is resolved, so it is worth stating
-- plainly before the SQL.
--
-- ## The two tables with no policy at all
--
-- `fraud.phone_signals` and `fraud.provider_checks` get **no RLS**. Every org may
-- read and write them, which is §5's first cross-org exception and the reason the
-- milestone exists: a buyer who refuses an Oura parcel and then orders from Orvo
-- should not be a stranger to Orvo. They are listed in `GLOBAL_TABLES` in
-- `packages/db/src/rls.ts` with that reasoning, which is what stops M01's tenancy
-- guard reporting them as two tables somebody forgot to protect.
--
-- What makes that safe is not this file. It is 0045's column list: neither table
-- has anywhere to store an order number, a customer name, an address, an amount, a
-- brand or a user id. The strongest policy in the world on a table with a
-- `customer_name` column would still be one migration away from leaking it; a
-- column that does not exist is not. M13 check 2 asserts the API side of the same
-- property from the outside.
--
-- Both are `select, insert, update` for `erp_app` and **no DELETE**. There is no
-- legitimate delete: a counter is the accumulated record of what a phone number
-- has done across five brands, and the one thing a fraudster would want is for it
-- to go away. A provider row that has gone stale is overwritten by the next
-- lookup, not removed. Correcting a wrong count means writing the right one, which
-- leaves `updated_at` moved and is visible.
--
-- ## The four tenant tables
--
-- `rules`, `phone_flags`, `overrides` and `order_phones` are ordinary tenant
-- tables: `org_id`, RLS ENABLE and FORCE, and the generated policy pasted verbatim
-- from `tenantTableSql()` (D-048 — a policy that differs by one character returns
-- rows instead of throwing, and the wrong rows look like the right ones).
--
-- Their grants say what each one is:
--
-- * `rules` — `select, insert, update`. Configuration. No DELETE: an org with no
--   row gets D-011's defaults, so deleting one is a silent reset of the brand's
--   fraud policy, which is precisely the change that should be a visible edit.
-- * `phone_flags` — `select, insert, update`. A flag that was wrong is *cleared*,
--   with a reason and an author (0047 confines UPDATE to those three columns). It
--   is part of why a buyer was refused for a fortnight, so it cannot be tidied away.
-- * `overrides` — `select, insert`. Append-only, and 0047 has the trigger as well.
--   This row is the evidence that somebody with the authority decided to sell to a
--   buyer the system refused; a row that could be edited afterwards is worth nothing.
-- * `order_phones` — `select, insert`. The map from one of this org's orders to the
--   hash it was assessed against. It cannot change, because it is what the outbox
--   subscriber trusts when it moves a counter that four other brands can see.
--
-- No analytics read on anything in this schema. §18's rollups and §5's exception 3
-- consolidated views are about money and volume; they have no use for a fraud
-- score, and a read-only role is still a role that can read (D-049).

-- The cross-org pair. Grants only, deliberately: see the note above.
grant usage on schema "fraud" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "fraud"."phone_signals" to "erp_app";--> statement-breakpoint
grant select, insert, update on "fraud"."provider_checks" to "erp_app";--> statement-breakpoint

alter table "fraud"."rules" enable row level security;--> statement-breakpoint
alter table "fraud"."rules" force row level security;--> statement-breakpoint
drop policy if exists "rules_org_isolation" on "fraud"."rules";--> statement-breakpoint
create policy "rules_org_isolation" on "fraud"."rules"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "fraud" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "fraud"."rules" to "erp_app";--> statement-breakpoint

alter table "fraud"."phone_flags" enable row level security;--> statement-breakpoint
alter table "fraud"."phone_flags" force row level security;--> statement-breakpoint
drop policy if exists "phone_flags_org_isolation" on "fraud"."phone_flags";--> statement-breakpoint
create policy "phone_flags_org_isolation" on "fraud"."phone_flags"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "fraud" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "fraud"."phone_flags" to "erp_app";--> statement-breakpoint

alter table "fraud"."overrides" enable row level security;--> statement-breakpoint
alter table "fraud"."overrides" force row level security;--> statement-breakpoint
drop policy if exists "overrides_org_isolation" on "fraud"."overrides";--> statement-breakpoint
create policy "overrides_org_isolation" on "fraud"."overrides"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "fraud" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "fraud"."overrides" to "erp_app";--> statement-breakpoint

alter table "fraud"."order_phones" enable row level security;--> statement-breakpoint
alter table "fraud"."order_phones" force row level security;--> statement-breakpoint
drop policy if exists "order_phones_org_isolation" on "fraud"."order_phones";--> statement-breakpoint
create policy "order_phones_org_isolation" on "fraud"."order_phones"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "fraud" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "fraud"."order_phones" to "erp_app";
