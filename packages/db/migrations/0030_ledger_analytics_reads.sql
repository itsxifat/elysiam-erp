-- The super-admin consolidated view's read path (M08 check 3; §5 exception 3).
--
-- Super Admin sees one number across all five brands: total cash held, and a
-- consolidated P&L. §5 names that as the third and only other cross-org
-- exception, and it names the mechanism too — `erp_analytics`, read-only,
-- through its own pool, with **every write still scoped to exactly one org**.
--
-- The alternative is what makes this worth a migration. A consolidated total can
-- be assembled by calling `withOrg()` once per organization and adding up the
-- answers. It works, it needs no grant, and it is the wrong shape: the loop is
-- ordinary application code holding an ordinary read-write transaction per org,
-- so the day somebody adds a write inside it — a cached total, a "mark as
-- reviewed" — there is nothing in the database saying that cross-org code may
-- not write. Reading through a role that has no INSERT, UPDATE or DELETE on
-- anything makes that a permission error rather than a code review.
--
-- Only three tables, and only SELECT. A consolidated wallet total is
-- `Σ debit − Σ credit` over the lines of every `wallet_*` account; a
-- consolidated P&L is the same sum grouped by class over income and expense
-- accounts. Both need `accounts` (for the subtype and class), `journal_lines`
-- (the amounts) and `journals` (the business date to filter on). Nothing else in
-- the ledger is opened, and nothing in `wallets.*` is: the paperwork rows carry
-- who counted which till and which receipt they photographed, and a read-only
-- role is still a role that can read (D-049).
--
-- Emitted by the `analyticsReadsAllOrgs` half of `tenantTableSql()` and pasted
-- verbatim; the guard test checks this policy against the generated shape and
-- fails if the table is not listed in `ANALYTICS_READABLE` in
-- `packages/db/src/rls.ts`.
grant select on "ledger"."accounts" to "erp_analytics";--> statement-breakpoint
drop policy if exists "accounts_analytics_all_orgs" on "ledger"."accounts";--> statement-breakpoint
create policy "accounts_analytics_all_orgs" on "ledger"."accounts"
  for select to "erp_analytics"
  using (true);--> statement-breakpoint
grant select on "ledger"."journals" to "erp_analytics";--> statement-breakpoint
drop policy if exists "journals_analytics_all_orgs" on "ledger"."journals";--> statement-breakpoint
create policy "journals_analytics_all_orgs" on "ledger"."journals"
  for select to "erp_analytics"
  using (true);--> statement-breakpoint
grant select on "ledger"."journal_lines" to "erp_analytics";--> statement-breakpoint
drop policy if exists "journal_lines_analytics_all_orgs" on "ledger"."journal_lines";--> statement-breakpoint
create policy "journal_lines_analytics_all_orgs" on "ledger"."journal_lines"
  for select to "erp_analytics"
  using (true);
