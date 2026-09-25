-- The outbox's isolation policy and grants (invariant 4, §19).
--
-- Emitted by tenantTableSql({schema:'events', table:'outbox',
-- appPrivileges:['select','insert','update']}) and pasted verbatim, the way
-- every tenant policy in this repo is: a policy that differs by one character
-- fails silently, returning rows rather than throwing, and the wrong rows look
-- like the right ones (D-048).
--
-- select, insert, update and NO delete. The outbox is append-then-mark: the
-- dispatcher needs UPDATE to stamp dispatched_at, bump attempts and record
-- last_error, and must never remove a row. Deleting on dispatch would make
-- "did this event ever fire" unanswerable — the question asked exactly when
-- something has gone wrong, by the customer who got no SMS. It is listed in
-- NO_DELETE_TABLES so the tenancy guard enforces that structurally.
alter table "events"."outbox" enable row level security;--> statement-breakpoint
alter table "events"."outbox" force row level security;--> statement-breakpoint
drop policy if exists "outbox_org_isolation" on "events"."outbox";--> statement-breakpoint
create policy "outbox_org_isolation" on "events"."outbox"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "events" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "events"."outbox" to "erp_app";
