-- Tenant isolation for the investors schema (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim,
-- the way every tenant policy in this repo is: a policy that differs by one
-- character fails silently, returning rows rather than throwing, and the wrong
-- rows look like the right ones (D-048).
--
-- The grants are where the thinking is:
--
-- * `investors.investments` and `investors.distribution_lines` are
--   **append-only**. A contribution exists because money arrived and a journal
--   posted it; a distribution line is one investor's share of a total a checker
--   approved. Neither can be corrected in place, because the journal behind it
--   cannot (invariant 2) — a correction is a reversal and a new row. An editable
--   line is also the exact hole in the split: change one line's amount after the
--   fact and the shares no longer sum to the declared total, with nothing left to
--   notice.
-- * `investors.distributions` and `investors.withdrawals` get UPDATE but never
--   DELETE. Each has one legitimate path — a distribution waiting for a checker
--   becomes declared or rejected; a withdrawal goes requested → reviewed →
--   approved → paid — and the triggers in 0060 are what confine UPDATE to it.
--   DELETE would make "what did this investor take out last year" answerable
--   differently on two different days.
-- * `investors.investors` gets UPDATE (renamed, share changed, marked exited) and
--   no DELETE: an investor who ever put money in is part of the record, and
--   deleting one would orphan every contribution, line and withdrawal naming them.
-- * `investors.documents` the same: the title is editable, the row is not
--   removable. The bytes are a `files.objects` row with its own lifecycle (§22),
--   and a dangling document row is how a signed URL outlives its paperwork.
--
-- **No analytics read on any of them**, and this is the schema where that matters
-- most. `erp_analytics` bypasses org isolation by design (§5 exception 3), and
-- these rows are one investor's capital, one investor's profit share and one
-- investor's KYC. §6 is explicit that an investor sees only their own rows; a
-- cross-org read-only role over this schema would be a way around that for anyone
-- who could reach the analytics pool. A read-only role is still a role that can
-- read (D-049). The consolidated views a super admin has are sums of ledger
-- balances and need nothing here.

alter table "investors"."investors" enable row level security;--> statement-breakpoint
alter table "investors"."investors" force row level security;--> statement-breakpoint
drop policy if exists "investors_org_isolation" on "investors"."investors";--> statement-breakpoint
create policy "investors_org_isolation" on "investors"."investors"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "investors" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "investors"."investors" to "erp_app";--> statement-breakpoint
alter table "investors"."investments" enable row level security;--> statement-breakpoint
alter table "investors"."investments" force row level security;--> statement-breakpoint
drop policy if exists "investments_org_isolation" on "investors"."investments";--> statement-breakpoint
create policy "investments_org_isolation" on "investors"."investments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "investors" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "investors"."investments" to "erp_app";--> statement-breakpoint
alter table "investors"."distributions" enable row level security;--> statement-breakpoint
alter table "investors"."distributions" force row level security;--> statement-breakpoint
drop policy if exists "distributions_org_isolation" on "investors"."distributions";--> statement-breakpoint
create policy "distributions_org_isolation" on "investors"."distributions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "investors" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "investors"."distributions" to "erp_app";--> statement-breakpoint
alter table "investors"."distribution_lines" enable row level security;--> statement-breakpoint
alter table "investors"."distribution_lines" force row level security;--> statement-breakpoint
drop policy if exists "distribution_lines_org_isolation" on "investors"."distribution_lines";--> statement-breakpoint
create policy "distribution_lines_org_isolation" on "investors"."distribution_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "investors" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "investors"."distribution_lines" to "erp_app";--> statement-breakpoint
alter table "investors"."withdrawals" enable row level security;--> statement-breakpoint
alter table "investors"."withdrawals" force row level security;--> statement-breakpoint
drop policy if exists "withdrawals_org_isolation" on "investors"."withdrawals";--> statement-breakpoint
create policy "withdrawals_org_isolation" on "investors"."withdrawals"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "investors" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "investors"."withdrawals" to "erp_app";--> statement-breakpoint
alter table "investors"."documents" enable row level security;--> statement-breakpoint
alter table "investors"."documents" force row level security;--> statement-breakpoint
drop policy if exists "documents_org_isolation" on "investors"."documents";--> statement-breakpoint
create policy "documents_org_isolation" on "investors"."documents"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "investors" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "investors"."documents" to "erp_app";
