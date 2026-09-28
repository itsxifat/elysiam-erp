-- Tenant isolation for the supply schema (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, the
-- way every tenant policy in this repo is: a policy that differs by one character
-- fails silently, returning rows rather than throwing, and the wrong rows look like
-- the right ones (D-048).
--
-- The grants are where the thinking is:
--
-- * `supply.supplier_notes`, `supply.returns`, `supply.return_lines` and
--   `supply.advance_applications` are **append-only**. A note is somebody's account of
--   what a supplier said about a late shipment, and an editable one is a note that can
--   be made to agree with whatever happened next. A return and an advance application
--   each own a journal, and a journal cannot change (invariant 2), so a row that could
--   be edited afterwards would let the paperwork and the ledger disagree about what
--   happened. Correcting either means a reversal and a new entry.
-- * `supply.supplies` and `supply.supply_lines` get UPDATE **and DELETE**, which no
--   other posted-money table in this repo does. Both are for the draft flow only: a
--   warehouse clerk records a delivery, accounts prices it (UPDATE), and a draft that
--   was entered twice is thrown away (DELETE). Migration 0037's triggers are what
--   confine both to a draft — a received entry cannot be repriced, relined or deleted,
--   because it has already moved stock and posted a journal.
-- * `supply.supplier_payments` gets UPDATE but never DELETE. It has exactly one
--   legitimate transition — waiting for a checker, then posted or rejected — and
--   DELETE would make "who paid this supplier last month" answerable differently on
--   two different days.
-- * `supply.suppliers` gets UPDATE (a supplier is renamed and deactivated) but no
--   DELETE: deleting one would orphan every entry, return and payment that names it,
--   and a supplier the brand once bought from is part of the record. `supplier_contacts`
--   and `supplier_documents` do get DELETE, because a merchandiser who left and a
--   licence attached to the wrong supplier are corrections with no accounting weight.
--
-- No analytics read on any of them, and here that is invariant 5 rather than only
-- D-049: `supply_lines.unit_cost_poisha` is the one place a purchase price is typed
-- in, and a read-only role is still a role that can read.

alter table "supply"."suppliers" enable row level security;--> statement-breakpoint
alter table "supply"."suppliers" force row level security;--> statement-breakpoint
drop policy if exists "suppliers_org_isolation" on "supply"."suppliers";--> statement-breakpoint
create policy "suppliers_org_isolation" on "supply"."suppliers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "supply"."suppliers" to "erp_app";--> statement-breakpoint
alter table "supply"."supplier_contacts" enable row level security;--> statement-breakpoint
alter table "supply"."supplier_contacts" force row level security;--> statement-breakpoint
drop policy if exists "supplier_contacts_org_isolation" on "supply"."supplier_contacts";--> statement-breakpoint
create policy "supplier_contacts_org_isolation" on "supply"."supplier_contacts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "supply"."supplier_contacts" to "erp_app";--> statement-breakpoint
alter table "supply"."supplier_notes" enable row level security;--> statement-breakpoint
alter table "supply"."supplier_notes" force row level security;--> statement-breakpoint
drop policy if exists "supplier_notes_org_isolation" on "supply"."supplier_notes";--> statement-breakpoint
create policy "supplier_notes_org_isolation" on "supply"."supplier_notes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "supply"."supplier_notes" to "erp_app";--> statement-breakpoint
alter table "supply"."supplier_documents" enable row level security;--> statement-breakpoint
alter table "supply"."supplier_documents" force row level security;--> statement-breakpoint
drop policy if exists "supplier_documents_org_isolation" on "supply"."supplier_documents";--> statement-breakpoint
create policy "supplier_documents_org_isolation" on "supply"."supplier_documents"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, delete on "supply"."supplier_documents" to "erp_app";--> statement-breakpoint
alter table "supply"."supplies" enable row level security;--> statement-breakpoint
alter table "supply"."supplies" force row level security;--> statement-breakpoint
drop policy if exists "supplies_org_isolation" on "supply"."supplies";--> statement-breakpoint
create policy "supplies_org_isolation" on "supply"."supplies"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "supply"."supplies" to "erp_app";--> statement-breakpoint
alter table "supply"."supply_lines" enable row level security;--> statement-breakpoint
alter table "supply"."supply_lines" force row level security;--> statement-breakpoint
drop policy if exists "supply_lines_org_isolation" on "supply"."supply_lines";--> statement-breakpoint
create policy "supply_lines_org_isolation" on "supply"."supply_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "supply"."supply_lines" to "erp_app";--> statement-breakpoint
alter table "supply"."returns" enable row level security;--> statement-breakpoint
alter table "supply"."returns" force row level security;--> statement-breakpoint
drop policy if exists "returns_org_isolation" on "supply"."returns";--> statement-breakpoint
create policy "returns_org_isolation" on "supply"."returns"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "supply"."returns" to "erp_app";--> statement-breakpoint
alter table "supply"."return_lines" enable row level security;--> statement-breakpoint
alter table "supply"."return_lines" force row level security;--> statement-breakpoint
drop policy if exists "return_lines_org_isolation" on "supply"."return_lines";--> statement-breakpoint
create policy "return_lines_org_isolation" on "supply"."return_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "supply"."return_lines" to "erp_app";--> statement-breakpoint
alter table "supply"."supplier_payments" enable row level security;--> statement-breakpoint
alter table "supply"."supplier_payments" force row level security;--> statement-breakpoint
drop policy if exists "supplier_payments_org_isolation" on "supply"."supplier_payments";--> statement-breakpoint
create policy "supplier_payments_org_isolation" on "supply"."supplier_payments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "supply"."supplier_payments" to "erp_app";--> statement-breakpoint
alter table "supply"."advance_applications" enable row level security;--> statement-breakpoint
alter table "supply"."advance_applications" force row level security;--> statement-breakpoint
drop policy if exists "advance_applications_org_isolation" on "supply"."advance_applications";--> statement-breakpoint
create policy "advance_applications_org_isolation" on "supply"."advance_applications"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "supply"."advance_applications" to "erp_app";
