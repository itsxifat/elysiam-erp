-- Tenant isolation for files.objects (invariant 4, §22).
--
-- Emitted by tenantTableSql({ schema: 'files', table: 'objects' }) and pasted
-- verbatim, the way every tenant policy in this repo is: a policy that differs
-- by one character fails silently, returning rows rather than throwing, and the
-- wrong rows look like the right ones (D-048).
--
-- Here the isolation is doing visible work rather than satisfying a rule. A
-- file id appears in a URL. Without FORCE row security a uuid copied out of one
-- brand's console would resolve in another's, and the row is what the download
-- path authorizes against — so the policy is the first half of the answer to
-- "may this caller have a signed URL for this object".
--
-- Full read/write for erp_app: a file is created pending, updated once when its
-- bytes land, updated again when the image job finishes, and deleted when its
-- owner removes it. Not append-only, unlike the ledger and the outbox, because
-- none of those transitions is a record of something that happened — they are
-- the object's own state.
--
-- No analytics read. A row carries `original_name` and `owner_user_id`, and a
-- KYC scan named after the person in it is personal data; the analytics role
-- reads across every org (§5 exception 2). Nothing in §18's metrics needs a
-- filename, and a read-only role is still a role that can read (D-049).
alter table "files"."objects" enable row level security;--> statement-breakpoint
alter table "files"."objects" force row level security;--> statement-breakpoint
drop policy if exists "objects_org_isolation" on "files"."objects";--> statement-breakpoint
create policy "objects_org_isolation" on "files"."objects"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "files" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "files"."objects" to "erp_app";
