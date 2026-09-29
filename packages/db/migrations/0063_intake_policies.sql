-- Tenant isolation for the intake schema (M11; invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, the way
-- every tenant policy in this repo is: a policy that differs by one character fails
-- silently, returning rows rather than throwing, and the wrong rows look like the right
-- ones (D-048).
--
-- The grants are where the decisions are:
--
-- * `site_keys` gets UPDATE and no DELETE. A key is revoked, never removed: the
--   submissions that name it are the record of which site sent which order, and a key
--   that could be deleted would take that attribution with it — or fail on the foreign
--   key and teach someone to drop the constraint.
-- * `submissions` gets DELETE, and only for one reason: a claim whose Turnstile check or
--   order creation failed is released so the client can retry with the same key and a
--   fresh token. A completed row is never deleted by the application, and the CHECK in
--   0062 means a released claim never had an order to lose.
--
-- No analytics read on either. §5's cross-org exceptions do not include intake data, and
-- a read-only role is still a role that can read (D-049).
--
-- The public request that reads these tables runs as `erp_app` inside `withOrg()` for the
-- org its key id names, like every other tenant read — there is no bypass here and no
-- cross-org lookup, which is why the key id carries its org.

alter table "intake"."site_keys" enable row level security;
--> statement-breakpoint
alter table "intake"."site_keys" force row level security;
--> statement-breakpoint
drop policy if exists "site_keys_org_isolation" on "intake"."site_keys";
--> statement-breakpoint
create policy "site_keys_org_isolation" on "intake"."site_keys"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "intake" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "intake"."site_keys" to "erp_app";
--> statement-breakpoint
alter table "intake"."submissions" enable row level security;
--> statement-breakpoint
alter table "intake"."submissions" force row level security;
--> statement-breakpoint
drop policy if exists "submissions_org_isolation" on "intake"."submissions";
--> statement-breakpoint
create policy "submissions_org_isolation" on "intake"."submissions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "intake" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "intake"."submissions" to "erp_app";
